// D1 表结构迁移（幂等）—— 本仓库唯一的「已有库加列」出口。
//
// 为什么需要它：`schema.sql` 是 `CREATE TABLE IF NOT EXISTS`，对**已存在的库**不生效 ——
// 在 CREATE 里加一列只会影响新库；老库要靠 `ALTER TABLE … ADD COLUMN`。而本仓库「推送即部署」，
// 新代码的 INSERT/UPDATE 会写这一列，列不存在 ⇒ 每次写库都失败 ⇒ 必须在部署**之前**迁移。
// 本脚本只服务这一列（不为假想将来留扩展点）；`wrangler d1 execute` 没有
// `ADD COLUMN IF NOT EXISTS`，故用 `PRAGMA table_info` 先查、缺了才 ALTER，天然幂等。
//
// **用法**：`node tools/migrate-d1.mjs [--local|--remote]`（缺省 `--local`）。
// 寻址用 **binding 名 `DB`**（与 Worker 绑定、CI 的 schema 步骤同源）—— 若按库名 `syncclipboard`
// 寻址而 Worker 绑定的是注入/钉住的 `database_id`，迁移可能落在另一个同名库上（见 deploy.yml 注释）。
// 退出码：0 = 成功（含"列已存在"）；非 0 = 失败（wrangler 的输出原样透出，CI 靠它拦下部署）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const DB = 'DB'; // wrangler.toml 的 [[d1_databases]] binding（与 Worker 同一个库）
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';

// 目前唯一的迁移：HistoryRecords.TransferDataHash（上游 3.3.0 的 #413）。
// 注意 DDL 必须与 schema.sql 里该列的写法逐字一致（`NOT NULL DEFAULT ''` 是 SQLite
// 对 `ADD COLUMN` 的要求 —— 非空列必须带默认值，且与全表其余列的风格一致）。
const MIGRATIONS = [
  {
    table: 'HistoryRecords',
    column: 'TransferDataHash',
    ddl:
      "ALTER TABLE HistoryRecords ADD COLUMN TransferDataHash TEXT NOT NULL DEFAULT ''",
  },
];

/** 从 `wrangler d1 execute --json` 的 stdout 里取列名集合。
 *  ⚠️ 不能直接 `JSON.parse(stdout)`：`--remote` 会在 JSON **之前**打印非 JSON 行
 *  （如 `🌀 Executing on remote database …`），直接解析会抛错 ⇒ 脚本退出 1 ⇒
 *  **把部署挡在迁移这一步**（比"没迁移"更糟）。所以从第一个 `[`/`{` 起截取再解析。
 *  导出为纯函数以便单测（test/docs.test.ts 的迁移守卫覆盖横幅前缀/空输出/正常三形态）。 */
export function parseD1Output(stdout) {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error('输出里没有 JSON');
  const parsed = JSON.parse(stdout.slice(start));
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((page) => page?.results ?? []);
  return new Set(rows.map((r) => String(r.name)));
}

const args = process.argv.slice(2);
const scope = args.includes('--remote') ? '--remote' : '--local';

async function main() {
  for (const m of MIGRATIONS) {
    const probe = await run(process.execPath, [WRANGLER, 'd1', 'execute', DB, scope, '--json', '--command', `PRAGMA table_info(${m.table})`], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    let columns;
    try {
      columns = parseD1Output(probe.stdout);
    } catch (err) {
      console.error(`migrate-d1: PRAGMA 结果解析失败：${err instanceof Error ? err.message : err}`);
      console.error(probe.stdout.slice(0, 2000));
      process.exit(1);
    }

    if (columns.has(m.column)) {
      console.log(`${m.table}.${m.column} already present`);
      continue;
    }

    console.log(`applying: ${m.ddl}`);
    await run(process.execPath, [WRANGLER, 'd1', 'execute', DB, scope, '--command', m.ddl], {
      cwd: ROOT,
      maxBuffer: 8 * 1024 * 1024,
    });

    // 迁移后**复查**：ALTER 成功 ≠ 列一定在（幂等脚本的假成功会把缺列部署放绿）。
    // 复查失败（列仍未出现 / PRAGMA 报错）按失败退出，CI 据此拦下部署。
    const verify = await run(process.execPath, [WRANGLER, 'd1', 'execute', DB, scope, '--json', '--command', `PRAGMA table_info(${m.table})`], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    let after;
    try {
      after = parseD1Output(verify.stdout);
    } catch (err) {
      console.error(`migrate-d1: 迁移后复查的 PRAGMA 解析失败：${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    if (!after.has(m.column)) {
      console.error(`migrate-d1: ${m.table}.${m.column} ALTER 后仍不存在 —— 迁移未生效，中止部署`);
      process.exit(1);
    }
    console.log(`added ${m.table}.${m.column}`);
  }
}

main().catch((err) => {
  const text = `${err?.stdout ?? ''}${err?.stderr ?? ''}`.trim();
  console.error(`migrate-d1: 失败（退出码 ${err?.code ?? '?'}）`);
  if (text) console.error(text.slice(0, 4000));
  else console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
