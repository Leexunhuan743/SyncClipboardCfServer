// `node:sqlite` 上的最小 D1 适配器 —— **唯一一份**。
//
// 此前它被抄了 **5 份**（`test/fixes.test.ts` 的 `FakeD1` 与 `FaultD1`、`test/dto-validation.test.ts`
// 与 `test/ui-activity.test.ts` 的同名 `FakeD1`、`test/cleanup-budget.test.ts` 的 `CountingD1`），
// 差异只有「要不要记账」与「要不要注入故障」两点，其余 prepare/bind/all/first/run 逐字相同。
// 收敛理由与实测依据见 docs/progress.md §105。
//
// ⚠️ **它不是 D1**，而且差异是**实测**出来的（2026-09-21）：
//   同一个 LIKE 模式，真 `wrangler dev` 报 `LIKE or GLOB pattern too complex: SQLITE_ERROR`
//   （模式 51 字节就报），而本适配器（Node 24 的 SQLite）连 50001 字节都通过。
//   ⇒ 「平台引擎口径」类断言**不能**落在用本适配器的用例上 —— 那类只能在 dev server 上钉，
//     见 `test/fix-regressions.test.ts` 里那节「平台级约束」。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';

// node:sqlite 不能走 Vite 的静态解析（会被当成裸包 'sqlite' 找不到），故用运行时 require 取。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncCtor };

export type SqliteDb = InstanceType<typeof DatabaseSyncCtor>;

/** 仓库 schema 的唯一读入口（各套件此前各自 `readFileSync` 了一次） */
export function readSchemaSql(): string {
  return readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
}

/**
 * 语句种类。`run` 与 `all`/`first` 分开是因为故障注入要按种类区分：
 * F5 那条只注入 `INSERT`（走 `run`），不能连带影响同一条用例里的查询。
 */
export type SqliteStatementOp = 'all' | 'first' | 'run' | 'exec';

export interface SqliteD1Options {
  /** 每条语句执行前调用一次；**抛错即模拟该语句失败**（记账与故障注入都挂这里） */
  beforeStatement?: (sql: string, op: SqliteStatementOp) => void;
}

export interface SqliteD1Statement {
  bind(...params: unknown[]): SqliteD1Statement;
  all<T = unknown>(): Promise<{ results: T[]; meta: Record<string, unknown> }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export interface SqliteD1 {
  prepare(sql: string): SqliteD1Statement;
  /**
   * 直写 SQL：建库/灌数据，以及造「带外写入的坏数据」（三条写路径都不接受那种行，只能这样造）。
   */
  exec(sql: string): void;
  /**
   * 底层 `node:sqlite` 句柄。**直接用它不会触发 `beforeStatement`** —— 构造与断言阶段
   * （灌积压、`SELECT COUNT(*)` 读值）正需要"不计入子请求"这一点。
   */
  readonly sqlite: SqliteDb;
}

export function createSqliteD1(schemaSql: string, options: SqliteD1Options = {}): SqliteD1 {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  const fire = (sql: string, op: SqliteStatementOp): void => options.beforeStatement?.(sql, op);

  return {
    sqlite,
    exec(sql) {
      fire(sql, 'exec');
      sqlite.exec(sql);
    },
    prepare(sql) {
      let params: unknown[] = [];
      const statement: SqliteD1Statement = {
        bind(...next) {
          params = next;
          return statement;
        },
        async all<T>() {
          fire(sql, 'all');
          return { results: sqlite.prepare(sql).all(...(params as never[])) as T[], meta: {} };
        },
        async first<T>() {
          fire(sql, 'first');
          return (sqlite.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
        },
        async run() {
          fire(sql, 'run');
          const info = sqlite.prepare(sql).run(...(params as never[]));
          return {
            meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
          };
        },
      };
      return statement;
    },
  };
}
