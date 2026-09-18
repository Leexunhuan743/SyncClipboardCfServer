// `/ui/api/activity` 的按天分桶（真实 SQL + 真实 Hono 路由）
//
// 为什么需要这个套件：这条接口在 2026-09-17 之前**恒返回 14 个 0**。
// 根因是 SQL 里的时间单位：`strftime(..., 'unixepoch')` 要求参数是**秒**，而本库的 `CreateTime`
// 存的是**毫秒** —— 13 位数字喂给 `unixepoch` 会得到 NULL，`readActivity` 又把 day 为 null 的行
// 静静丢掉（那条 `if (!row.day) continue` 本意是防非法时间戳），于是每一天都被"没有活动"填满。
// 后果不是接口报错，而是**图表永远是一条平线**：V2 的概览带趋势图、以及 V1 2026-09-17 借鉴
// 过来的那一小排柱子，画的都是这份数据。没有任何断言覆盖过它。
//
// 判别性：下面每条断言在"毫秒直传"的旧写法下都会失败（旧写法下 day 恒为 NULL → 全部 total=0）。
//
// 不依赖 dev server：node:sqlite + 真 `schema.sql` + 真实 `createUiRoutes`（Basic 鉴权），全程进程内。
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createUiRoutes } from '../src/ui/routes';
import { HistoryDb } from '../src/db';
import { ProfileType } from '../src/types';
import type { HistoryRecordEntity } from '../src/types';
import type { Bindings } from '../src/env';

const nodeRequire = createRequire(import.meta.url);
// node:sqlite 不能走 Vite 的静态解析（会被当成裸包 'sqlite'），故用运行时 require 取（同 fixes.test.ts）。
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof NodeSqlite;

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// `Date.prototype.getTimezoneOffset()` 的符号：UTC+8 ⇒ -480。测试**显式指定**这个值，
// 因此结果与跑测试的机器在哪个时区无关。
const TZ_UTC8 = -480;
const AUTH = 'Basic ' + Buffer.from('admin:admin').toString('base64');

// node:sqlite 上的最小 D1 适配器（本套件只读库，不需要 R2/HUB 桩）
type SqliteDb = InstanceType<typeof NodeSqlite.DatabaseSync>;

class FakeD1 {
  private db: SqliteDb;
  constructor(schemaSql: string) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(schemaSql);
  }
  prepare(sql: string) {
    const db = this.db;
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...(params as never[])) as T[], meta: {} };
      },
      async first<T>() {
        return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
      },
      async run() {
        const info = db.prepare(sql).run(...(params as never[]));
        return {
          meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
        };
      },
    };
    return stmt;
  }
}

function makeEnv(): Bindings {
  return {
    DB: new FakeD1(SCHEMA) as unknown as D1Database,
    R2: {} as unknown as R2Bucket,
    HUB: {} as unknown as DurableObjectNamespace,
    VERSION: 'test',
    MAX_SAVED_HISTORY_COUNT: '1000',
    HISTORY_RETENTION_MINUTES: '10080',
    USERNAME: 'admin',
    PASSWORD: 'admin',
    UI_ENABLED: 'true',
  } as unknown as Bindings;
}

// 时间戳 → 指定 tz 下的本地日（`YYYY-MM-DD`）。**独立**算一遍，不复用实现的 SQL 表达式：
// 平移后取 UTC 日期，与"把本地日界对齐到 UTC 整日边界"是同一件事的两种写法。
function localDay(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** 某个 tz 下"今天 00:00"对应的 UTC 毫秒。 */
function localMidnight(now: number, tzOffsetMinutes: number): number {
  const localNow = now - tzOffsetMinutes * 60_000;
  const localStart = Math.floor(localNow / DAY_MS) * DAY_MS;
  return localStart + tzOffsetMinutes * 60_000;
}

async function seed(db: HistoryDb, rows: { hash: string; createTime: number }[]): Promise<void> {
  for (const row of rows) {
    const entity: HistoryRecordEntity = {
      userId: 'default_user',
      type: ProfileType.Text,
      text: row.hash,
      size: row.hash.length,
      transferDataFile: '',
      filePaths: [],
      hash: row.hash,
      createTime: row.createTime,
      lastAccessed: row.createTime,
      lastModified: row.createTime,
      stared: false,
      pinned: false,
      version: 0,
      isDeleted: false,
    };
    await db.insert(entity);
  }
}

interface ActivityResponse {
  days: { day: string; total: number }[];
  max: number;
}

async function readActivity(env: Bindings, query: string): Promise<ActivityResponse> {
  const app = createUiRoutes();
  const res = await app.fetch(
    new Request(`http://test/ui/api/activity?${query}`, { headers: { authorization: AUTH } }),
    env,
  );
  expect(res.status, `GET /ui/api/activity?${query}`).toBe(200);
  return (await res.json()) as ActivityResponse;
}

describe('/ui/api/activity · 按天分桶（毫秒时间戳必须换算成秒）', () => {
  it('今天与昨天各 1 条：落进正确的两个格子（旧写法会全部落空 → 全 0）', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const now = Date.now();
    const midnight = localMidnight(now, TZ_UTC8);
    const todayEarly = midnight + 2 * HOUR_MS; // 本地 02:00（今天）
    const yesterdayLate = midnight - 2 * HOUR_MS; // 本地 22:00（昨天）
    await seed(db, [
      { hash: 'AAAA0001', createTime: todayEarly },
      { hash: 'AAAA0002', createTime: yesterdayLate },
    ]);

    const body = await readActivity(env, `days=14&tz=${TZ_UTC8}`);

    expect(body.days, '窗口长度必须是请求的天数').toHaveLength(14);
    // 每一天都必须有合法日期串：旧写法下 `strftime` 返回 NULL，这些标签会全被写成空档日
    for (const day of body.days) {
      expect(day.day, 'day 必须是 YYYY-MM-DD').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(body.days.at(-1)!.day, '最后一格是 tz 下的"今天"').toBe(localDay(todayEarly, TZ_UTC8));
    expect(body.days.at(-1)!.total, '今天 02:00 的那条要落在今天').toBe(1);
    expect(body.days.at(-2)!.total, '昨天 22:00 的那条要落在昨天').toBe(1);
    expect(body.days.reduce((sum, d) => sum + d.total, 0), '窗口内合计').toBe(2);
    expect(body.max, '单日峰值').toBe(1);
    // 补全空白日：14 天里只有 2 天有内容，剩下的必须是"存在且为 0"，而不是被抽掉
    expect(body.days.filter((d) => d.total === 0)).toHaveLength(12);
  });

  it('tz 是调用方给的：两个相差 24 小时的时区，最后一格的日期必然差一天', async () => {
    // 这条断言与机器时区无关（两个 tz 都是显式传入的），也不依赖"现在几点"：
    // 两个请求各自的"本地现在"相差整整 24 小时，按天取整后必然差 1。
    const env = makeEnv();
    const west = await readActivity(env, 'days=7&tz=720'); // UTC-12
    const east = await readActivity(env, 'days=7&tz=-720'); // UTC+12
    const westDay = Date.parse(`${west.days.at(-1)!.day}T00:00:00Z`);
    const eastDay = Date.parse(`${east.days.at(-1)!.day}T00:00:00Z`);
    expect(Math.round((eastDay - westDay) / DAY_MS), 'UTC+12 的"今天"比 UTC-12 晚一天').toBe(1);
  });

  it('只统计窗口内的记录，且不区分是否已删除（趋势是"新增了多少"，不是"现存多少"）', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const now = Date.now();
    const midnight = localMidnight(now, TZ_UTC8);
    await seed(db, [
      { hash: 'BBBB0001', createTime: midnight + HOUR_MS }, // 窗口内
      { hash: 'BBBB0002', createTime: midnight - 20 * DAY_MS }, // 窗口外（14 天以前）
    ]);

    const body = await readActivity(env, `days=14&tz=${TZ_UTC8}`);
    expect(body.days.reduce((sum, d) => sum + d.total, 0), '窗口外的记录不计入').toBe(1);
    expect(body.days.at(-1)!.total).toBe(1);
  });
});
