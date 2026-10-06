// 诊断 `HistoryRecords.Hash` 的大小写状况：**只读**检测两类问题，为「把 getByTypeAndHash 的
// `LOWER(Hash)=LOWER(?)` 收敛为 `Hash=?`」这件事提供事实依据。
//
// 为什么需要**两**条判据（缺一不可）：`(UserId,Type,Hash)` 唯一索引是大小写敏感的（SQLite 默认
// BINARY），而查询/参数若规范化成大写，`Hash='ABC'` 就查不到存成 `abc` 的历史行。因此：
//   ① case-fold 冲突：同一 `(UserId, Type)` 下同时存在 `ABC` 与 `abc`（唯一索引放行）——
//      收敛后只能命中其中一条，另一条静默消失。
//   ② 非规范行（任何 `Hash != Hash.toUpperCase()`）：即便无冲突，`abc` 也永远匹配不上大写参数。
// 只有**两者都为 0**，收敛查询才是安全的。
//
// 本脚本**只读**：只 SELECT，不 UPDATE/DELETE。发现问题时退出码非 0 并逐条打印，由人决定如何
// 规范化（本仓库不自动改数据）。
//
// 用法：`node tools/check-hash-case-conflicts.mjs [--local|--remote]`（缺省 `--local`）。
// 寻址用 binding 名 `DB`（与 Worker 绑定、CI 的 schema/migrate 步骤同源）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const DB = 'DB';
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';

// `--remote` 会在 JSON 之前打印非 JSON 行（如 "🌀 Executing …"），故从第一个 `[`/`{` 起截取再解析。
// （与 migrate-d1.mjs 的 parseD1Output 同一判据；此处本地再实现一份，避免 import 触发那边的 main()。）
export function parseRows(stdout) {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error('输出里没有 JSON');
  const parsed = JSON.parse(stdout.slice(start));
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((page) => page?.results ?? []);
}

// 纯函数：从行集合里挑出大小写折叠冲突。导出以便单测（无 I/O）。
// 判据：同一 `(UserId, Type)` 下，`Hash.toUpperCase()` 相同但 `Hash` 字符串不同的行 ≥ 2 条。
export function findCaseConflicts(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.UserId ?? ''}\u0000${r.Type ?? ''}\u0000${String(r.Hash ?? '').toUpperCase()}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const conflicts = [];
  for (const list of groups.values()) {
    if (new Set(list.map((r) => String(r.Hash ?? ''))).size > 1) conflicts.push(list);
  }
  return conflicts;
}

// 纯函数：挑出**非规范**行（Hash 与它的大写不同）。导出以便单测。
export function findNonCanonicalRows(rows) {
  return rows.filter((r) => {
    const hash = String(r.Hash ?? '');
    return hash !== hash.toUpperCase();
  });
}

const args = process.argv.slice(2);
const scope = args.includes('--remote') ? '--remote' : '--local';

async function main() {
  const sql = 'SELECT ID, UserId, Type, Hash FROM HistoryRecords ORDER BY UserId, Type, Hash';
  const res = await run(
    process.execPath,
    [WRANGLER, 'd1', 'execute', DB, scope, '--json', '--command', sql],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
  const rows = parseRows(res.stdout);
  const conflicts = findCaseConflicts(rows);
  const nonCanonical = findNonCanonicalRows(rows);

  console.log(`扫描 ${rows.length} 行（scope=${scope}）`);
  console.log(`① case-fold 冲突组：${conflicts.length}`);
  console.log(`② 非规范（非大写）行：${nonCanonical.length}`);

  if (conflicts.length === 0 && nonCanonical.length === 0) {
    console.log('⇒ 两项均为 0，可安全把 getByTypeAndHash 的 LOWER(Hash)=LOWER(?) 收敛为 Hash=?');
    return;
  }

  if (conflicts.length > 0) {
    console.error(`\n✗ case-fold 冲突 ${conflicts.length} 组（收敛查询会让每组只命中一条）：`);
    for (const group of conflicts) {
      console.error(`  · (UserId=${group[0].UserId}, Type=${group[0].Type})`);
      for (const row of group) console.error(`      ID=${row.ID} Hash=${row.Hash}`);
    }
  }
  if (nonCanonical.length > 0) {
    console.error(`\n✗ 非规范行 ${nonCanonical.length} 条（收敛查询后，大写参数永远查不到它们）：`);
    for (const row of nonCanonical.slice(0, 50)) {
      console.error(`  · ID=${row.ID} (${row.UserId}, Type=${row.Type}) Hash=${row.Hash}`);
    }
    if (nonCanonical.length > 50) console.error(`  … 其余 ${nonCanonical.length - 50} 条省略`);
  }
  console.error('\n⇒ 先把这些行规范化为大写（本脚本不自动改数据），再收敛查询。');
  process.exit(1);
}

// 只在作为脚本直接运行时执行（被测试 import 时不触发）。
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((err) => {
    const text = `${err?.stdout ?? ''}${err?.stderr ?? ''}`.trim();
    console.error(`check-hash-case-conflicts: 失败（退出码 ${err?.code ?? '?'}）`);
    if (text) console.error(text.slice(0, 4000));
    else console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
