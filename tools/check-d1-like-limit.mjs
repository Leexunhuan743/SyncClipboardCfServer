// 复核「D1 引擎的 LIKE 模式上限」是否仍与 `src/serialization.ts` 的 `MAX_LIKE_PATTERN_BYTES = 50` 一致。
//
// 为什么需要它：那条常量**没有任何机械判据**，它的依据是"量出来的引擎口径"——
// 模式 50 字节通过、51 字节报 `LIKE or GLOB pattern too complex: SQLITE_ERROR`（= SQLite 的编译期开关
// `SQLITE_MAX_LIKE_PATTERN_LENGTH`）。**不同构建取不同值**，已实测：
//
//   | 运行时                                              | 模式 51 | 模式 202 |
//   |-----------------------------------------------------|---------|----------|
//   | `wrangler dev` 的 miniflare 5.20260911.1-alpha       | 报错    | 报错     |
//   | `@cloudflare/vitest-pool-workers` 0.12 的 miniflare 4 | ok      | **ok**   |
//   | `node:sqlite`（Node 24）                             | ok      | ok       |
//
// （读法与结论见 docs/progress.md §105.3；最后一行正是 `test/fix-regressions.test.ts` 里那句
//  「node:sqlite 不管模式长度，故只能在这一层钉」的实测依据。）
//
// **用法**：`node tools/check-d1-like-limit.mjs`（需要仓库根的 `wrangler.toml`；默认 `--local`）。
// 退出码：0 = 与常量一致（50 通过 / 51 报错）；1 = 不一致（换运行时、换 wrangler 后先跑这个再决定）。
//
// **只读**：全部是 `SELECT 1 WHERE 'x' LIKE '<pattern>'`，不建表、不写库（也就与 schema 无关）。
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DB = flag('db', 'syncclipboard');
const WRANGLER = flag('wrangler', 'node_modules/wrangler/bin/wrangler.js');
const LENGTHS = flag('lengths', '50,51,202').split(',').map(Number);
const LIMIT = Number(flag('limit', '50'));

const dir = mkdtempSync(join(tmpdir(), 'like-limit-'));
const readings = [];

try {
  for (const bytes of LENGTHS) {
    const pattern = `%${'a'.repeat(Math.max(bytes - 2, 0))}%`;
    const file = join(dir, `like-${bytes}.sql`);
    writeFileSync(file, `SELECT ${bytes} AS pattern_bytes, 1 AS ok WHERE 'x' LIKE '${pattern}';\n`);
    let outcome;
    try {
      await run(process.execPath, [WRANGLER, 'd1', 'execute', DB, '--local', `--file=${file}`], {
        cwd: ROOT,
        maxBuffer: 8 * 1024 * 1024,
      });
      outcome = 'ok';
    } catch (err) {
      // 引擎拒绝时 wrangler 以非 0 退出。要的是**引擎原文**（如 `LIKE or GLOB pattern too complex:
      // SQLITE_ERROR`），而不是它最后打印的日志路径 ⇒ 先找含 ERROR 的行，找不到再退回最后一行。
      const lines = `${err.stdout ?? ''}${err.stderr ?? ''}`
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const engineLine = lines.find((line) => /ERROR/.test(line)) ?? lines.at(-1) ?? '(无输出)';
      outcome = `rejected: ${engineLine.replace(/^X\s*/, '').slice(0, 120)}`;
    }
    readings.push({ patternBytes: bytes, outcome });
    console.log(`${String(bytes).padStart(4)} 字节 → ${outcome}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const at = (bytes) => readings.find((r) => r.patternBytes === bytes)?.outcome ?? '(未测)';
const pass = at(LIMIT) === 'ok' && at(LIMIT + 1)?.startsWith('rejected');
console.log(
  `\n口径：${LIMIT} 字节通过、${LIMIT + 1} 字节被拒 ⇒ ${pass ? '与 MAX_LIKE_PATTERN_BYTES 一致' : '**与常量不一致**'}`,
);
if (!pass) {
  const wranglerVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules/wrangler/package.json'), 'utf8')).version;
  console.error(
    `\n不一致：wrangler ${wranglerVersion}。若换过运行时/工具链，请同时复核\n` +
      '  · src/serialization.ts 的 MAX_LIKE_PATTERN_BYTES / MAX_SEARCH_BYTES\n' +
      '  · docs/design.md §12 与 docs/progress.md §105.3 的读数表',
  );
}
process.exitCode = pass ? 0 : 1;
