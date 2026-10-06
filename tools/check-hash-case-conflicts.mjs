// 检测 `HistoryRecords.Hash` 的**大小写折叠冲突**：同一 `(UserId, Type)` 下存在只差大小写的多条 hash。
//
// 为什么需要它（见 src/hash.ts 的 normalizeProfileHash 与 docs/protocol.md §10 的「落库 hash 的大小写」）：
// 新写入已统一为大写，但**历史库**可能含小写行，而唯一索引 `ux_h_user_type_hash` 是大小写敏感的
// （SQLite 默认 BINARY 比较），所以 `ABC` 与 `abc` 可以并存。把查询从 `LOWER(Hash) = LOWER(?)`
// 收敛成 `Hash = ?` 之前，必须先确认线上没有这种行 —— 否则收敛会让其中一条查不到（静默 404/丢数据）。
//
// 本脚本**只读**：只 SELECT，不 UPDATE、不 DELETE。存在冲突时退出码非 0 并逐条打印，
// 由人决定如何合并（本仓库不自动删数据）。
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
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((page) => page?.results ?? []);
  return rows;
}

// 纯函数：从行集合里挑出大小写折叠冲突。导出以便单测（GUI 无关，无 I/O）。
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
    const distinct = new Set(list.map((r) => String(r.Hash ?? '')));
    if (distinct.size > 1) conflicts.push(list);
  }
  return conflicts;
}

const args = process.argv.slice(2);
const scope = args.includes('--remote') ? '--remote' : '--local';

async function main() {
  const sql =
    'SELECT ID, UserId, Type, Hash FROM HistoryRecords ORDER BY UserId, Type, Hash';
  const res = await run(
    process.execPath,
    [WRANGLER, 'd1', 'execute', DB, scope, '--json', '--command', sql],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
  const rows = parseRows(res.stdout);
  const conflicts = findCaseConflicts(rows);

  if (conflicts.length === 0) {
    console.log(`hash 大小写折叠冲突：0（扫描 ${rows.length} 行，scope=${scope}）`);
    console.log('⇒ 可安全把 getByTypeAndHash 的 LOWER(Hash)=LOWER(?) 收敛为 Hash=?');
    return;
  }

  console.error(`hash 大小写折叠冲突：${conflicts.length} 组（扫描 ${rows.length} 行，scope=${scope}）`);
  for (const group of conflicts) {
    console.error(`  · (UserId=${group[0].UserId}, Type=${group[0].Type}) ${group[0].Hash}`);
    for (const row of group) console.error(`      ID=${row.ID} Hash=${row.Hash}`);
  }
  console.error('⇒ 先人工合并这些行，再收敛查询；本脚本不自动删除任何数据。');
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
