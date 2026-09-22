// D1 表结构迁移（幂等）—— 本仓库唯一的「已有库加列」出口。
//
// 为什么需要它：`schema.sql` 是 `CREATE TABLE IF NOT EXISTS`，对**已存在的库**不生效 ——
// 在 CREATE 里加一列只会影响新库；老库要靠 `ALTER TABLE … ADD COLUMN`。而本仓库「推送即部署」，
// 新代码的 INSERT/UPDATE 会写这一列，列不存在 ⇒ 每次写库都失败 ⇒ 必须在部署**之前**迁移。
// 本脚本只服务这一列（不为假想将来留扩展点）；`wrangler d1 execute` 没有
// `ADD COLUMN IF NOT EXISTS`，故用 `PRAGMA table_info` 先查、缺了才 ALTER，天然幂等。
//
// **用法**：`node tools/migrate-d1.mjs [--local|--remote]`（缺省 `--local`；数据库名 `syncclipboard`）。
// 退出码：0 = 成功（含"列已存在"）；非 0 = 失败（wrangler 的输出原样透出，CI 靠它拦下部署）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const DB = 'syncclipboard';
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

const args = process.argv.slice(2);
const scope = args.includes('--remote') ? '--remote' : '--local';

async function main() {
  for (const m of MIGRATIONS) {
    // 1) 查列（--json 便于机器读；失败非 0 退出并透出 wrangler 原文）
    const probe = await run(process.execPath, [WRANGLER, 'd1', 'execute', DB, scope, '--json', '--command', `PRAGMA table_info(${m.table})`], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    let columns;
    try {
      const parsed = JSON.parse(probe.stdout);
      const rows = (Array.isArray(parsed) ? parsed : [parsed])
        .flatMap((page) => page?.results ?? []);
      columns = new Set(rows.map((r) => String(r.name)));
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
