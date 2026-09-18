// F11 回归：清理任务的「子请求预算 / 分阶段容错 / 可续跑游标 / 失败可观测」
//
// 驱动方式：**真实的** runCleanup + 真实 HistoryDb（node:sqlite 建真库，真跑 SQL）+ 真实 R2Storage
// （真跑 key 构造与前缀列举），只有三个外部绑定换成计数桩 —— 于是「本轮子请求总数」是**独立测出来**的，
// 而不是复述实现内部记账；两者不吻合会被断言抓住。
//
// 覆盖（对 F11 验收条件逐条）：
//   ① 饱和积压下四个阶段都仍被执行、且被明确记账为"待续跑"（不再被前面的阶段吃光预算后静默跳过）；
//   ② Meta 六个键每轮落库：cleanup:lastRunAt / cleanup:lastError / 四个 cleanup:cursor:<phase>；
//   ③ 注入 D1 语句错误：cleanup:lastError 非空、其余阶段照常执行、runCleanup 不向调用方抛错；
//   ④ 连续触发的有限次运行内收敛（积压被消化），收敛后游标回到 0。
//
// 跑：npx vitest run test/cleanup-budget.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { CLEANUP_META_KEYS, CLEANUP_PHASES, SUBREQUEST_BUDGET, runCleanup } from '../src/cleanup';
import type { CleanupResult } from '../src/cleanup';
import type { Bindings } from '../src/env';

// node:sqlite 不能走 Vite 的静态解析（会当成裸包 'sqlite'），与 test/fixes.test.ts 同法用运行时 require 取。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncCtor };
type SqliteDb = InstanceType<typeof DatabaseSyncCtor>;

const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MINUTES = 60;
const MAX_COUNT = 60;

// ===== 计数桩：每次真实外部调用的执行都记 1 次子请求 =====

// 平台硬上限的模拟：单次 Cron 调用超过 1,000 次子请求就被中断（Workers 的真实行为）。
// 有了它，「预算守卫真的生效」是被**测出来**的：预算失效时后续阶段会直接因中断而消失/抛错。
const PLATFORM_SUBREQUEST_LIMIT = 1000;

class SubrequestMeter {
  total = 0;

  charge(): void {
    this.total++;
    if (this.total > PLATFORM_SUBREQUEST_LIMIT) {
      throw new Error('Too many subrequests by single Worker invocation');
    }
  }
}

// D1：真 SQL（node:sqlite），每次语句执行（all/first/run）算 1 次子请求。
// failWhen 用来注入一个"真实形态"的 D1 语句错误（审计 F11 的注入方式）。
class CountingD1 {
  failWhen: ((sql: string) => boolean) | null = null;

  constructor(
    readonly db: SqliteDb,
    readonly meter: SubrequestMeter,
  ) {}

  private fire(sql: string): void {
    this.meter.charge();
    if (this.failWhen?.(sql)) throw new Error('D1_ERROR: injected statement failure');
  }

  prepare(sql: string) {
    const self = this;
    let params: never[] = [];
    const stmt = {
      bind(...p: never[]) {
        params = p;
        return stmt;
      },
      async all<T>() {
        self.fire(sql);
        return { results: self.db.prepare(sql).all(...params) as T[] };
      },
      async first<T>() {
        self.fire(sql);
        return (self.db.prepare(sql).get(...params) as T | undefined) ?? null;
      },
      async run() {
        self.fire(sql);
        self.db.prepare(sql).run(...params);
      },
    };
    return stmt;
  }
}

// R2：对象表 + list(prefix)/cursor 语义（与真实 R2 的分页行为同构：cursor 是"已返回条数"）
class CountingBucket {
  objects = new Map<string, number>();

  constructor(readonly meter: SubrequestMeter) {}

  async list(opts: { prefix?: string; cursor?: string } = {}) {
    this.meter.charge();
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const page = keys.slice(start, start + 1000);
    const next = start + page.length;
    return {
      objects: page.map((k) => ({ key: k, size: this.objects.get(k) ?? 0 })),
      truncated: next < keys.length,
      cursor: String(next),
    };
  }

  async delete(keyOrKeys: string | string[]): Promise<void> {
    this.meter.charge();
    for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) this.objects.delete(k);
  }
}

// DO：广播（每次 fetch = 1 次子请求）
class CountingHub {
  constructor(readonly meter: SubrequestMeter) {}

  idFromName(): string {
    return 'hub';
  }

  get() {
    const self = this;
    return {
      async fetch() {
        self.meter.charge();
        return new Response('{}');
      },
    };
  }
}

// ===== 数据构造 =====

interface Backlog {
  /** 保留期已过期、未删除、未收藏/置顶（保留期阶段的候选） */
  expired: number;
  /** 时间新、未删除（不会被保留期命中；条数上限靠它们以外的旧记录触发） */
  recent: number;
  /** IsDeleted=1 且 LastModified > 30 天前（硬删阶段的候选） */
  hardDeletable: number;
  /** R2 里存在、但 DB 无任何记录引用的目录（孤儿阶段的候选） */
  orphanDirs: number;
  /** MAX_SAVED_HISTORY_COUNT */
  maxCount: number;
  /** 收藏记录条数（时间与 expired 相同 ⇒ 保留期必须豁免它们），默认 1 */
  starred?: number;
  /** 置顶记录条数（同上），默认 1 */
  pinned?: number;
}

interface Fixture {
  env: Bindings;
  d1: CountingD1;
  bucket: CountingBucket;
  hub: CountingHub;
  meter: SubrequestMeter;
  sqlite: SqliteDb;
}

// 建库（真 schema.sql）、灌积压、给每条记录建 R2 数据目录、再额外放若干真孤儿目录。
// 直接写底层句柄 ⇒ 构造阶段不被计入子请求。
function fixture(backlog: Backlog): Fixture {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  const meter = new SubrequestMeter();
  const d1 = new CountingD1(sqlite, meter);
  const bucket = new CountingBucket(meter);
  const hub = new CountingHub(meter);
  const now = Date.now();
  const expiredAt = now - (RETENTION_MINUTES + 120) * 60_000;

  const insert = sqlite.prepare(
    `INSERT INTO HistoryRecords
       (UserId, Type, Text, Size, TransferDataFile, FilePaths, Hash, CreateTime, LastAccessed, LastModified, Stared, Pinned, Version, IsDeleted)
     VALUES ('default_user', 0, '', 0, '', '[]', ?1, ?2, ?3, ?3, ?4, ?5, 0, ?6)`,
  );
  const add = (hash: string, lastModified: number, stared: number, pinned: number, isDeleted: number) => {
    insert.run(hash, lastModified, lastModified, stared, pinned, isDeleted);
    bucket.objects.set(`history/Text_${hash}/${hash}.bin`, 8);
  };

  for (let i = 0; i < backlog.expired; i++) add(`EXP${i}`, expiredAt, 0, 0, 0);
  for (let i = 0; i < backlog.recent; i++) add(`REC${i}`, now, 0, 0, 0);
  for (let i = 0; i < backlog.hardDeletable; i++) add(`HARD${i}`, now - 31 * DAY_MS, 0, 0, 1);
  // 收藏/置顶对保留期与条数上限都豁免（修复预算逻辑时不得破坏这一点）
  for (let i = 0; i < (backlog.starred ?? 1); i++) add(`STAR${i}`, expiredAt, 1, 0, 0);
  for (let i = 0; i < (backlog.pinned ?? 1); i++) add(`PIN${i}`, expiredAt, 0, 1, 0);
  for (let i = 0; i < backlog.orphanDirs; i++) bucket.objects.set(`history/Text_ORPHAN${i}/f.bin`, 4);

  const env = {
    DB: d1,
    R2: bucket,
    HUB: hub,
    MAX_SAVED_HISTORY_COUNT: String(backlog.maxCount),
    HISTORY_RETENTION_MINUTES: String(RETENTION_MINUTES),
  } as unknown as Bindings;
  return { env, d1, bucket, hub, meter, sqlite };
}

// 触发一次"Cron 调用"：每次真实调用都有独立的子请求额度，故先清零计量器再跑。
async function cronRun(f: Fixture): Promise<CleanupResult> {
  f.meter.total = 0;
  return runCleanup(f.env);
}

function metaRows(db: SqliteDb): Record<string, string> {
  const rows = db.prepare('SELECT Key, Value FROM Meta').all() as { Key: string; Value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.Key] = r.Value;
  return out;
}

function scalar(db: SqliteDb, sql: string): number {
  const row = db.prepare(sql).get() as { c: number };
  return row.c;
}

function captureConsole(): { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  return { lines, errors };
}

// 独立测得的子请求总数（桩计数，不依赖实现里的记账）
function measuredSubrequests(f: Fixture): number {
  return f.meter.total;
}

function activeDirs(bucket: CountingBucket): string[] {
  const dirs = new Set<string>();
  for (const key of bucket.objects.keys()) {
    const rest = key.slice('history/'.length);
    const slash = rest.indexOf('/');
    if (slash > 0) dirs.add(rest.slice(0, slash + 1));
  }
  return [...dirs].sort();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('F11 · 清理任务的子请求预算', () => {
  it('饱和积压：四个阶段都执行、被截断的阶段明确记账为待续跑，总子请求不超预算', async () => {
    const f = fixture({ expired: 1200, recent: 400, hardDeletable: 900, orphanDirs: 60, maxCount: 400 });
    const logs = captureConsole();

    const result = await cronRun(f);

    // ① 阶段不再被静默跳过：饱和积压下四个阶段都被预算截断，但都真实推进了工作
    expect(result.expired).toBeGreaterThan(0);
    expect(result.trimmed).toBeGreaterThan(0);
    expect(result.hardDeleted).toBeGreaterThan(0);
    expect(result.orphans).toBeGreaterThan(0);
    expect(result.truncated).toContain('retention');
    expect(result.truncated).toContain('hardDelete');
    expect(result.truncated).toContain('orphans');
    // 每个阶段一行 [cleanup] 结构化日志（阶段名/处理数/是否被截断）
    for (const phase of CLEANUP_PHASES) {
      expect(logs.lines.some((l) => l.startsWith(`[cleanup] phase=${phase} `)), `缺 ${phase} 的日志行`).toBe(true);
    }
    expect(logs.lines.some((l) => l.includes('phase=hardDelete') && l.includes('processed=0'))).toBe(false);

    // ② 预算：实现自记账与桩独立测得的总数都在预算内，且两者同量级（记账模型没漏算外部调用）
    expect(result.subrequests).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    const measured = measuredSubrequests(f);
    expect(measured).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    // 平台硬上限（1,000/Cron）没有被触碰：桩在第 1001 次调用时抛错，触线会被上面几条断言/失败捕获
    expect(measured).toBeLessThanOrEqual(PLATFORM_SUBREQUEST_LIMIT);
    expect(result.failures.filter((m) => m.includes('Too many subrequests'))).toEqual([]);
    expect(measured).toBeLessThanOrEqual(result.subrequests);
    // 实现自记账**保守**（不会少于实际）：容差来自孤儿扫描按 5 页 R2 列举记账（页数不可知）。
    expect(result.subrequests - measured).toBeLessThanOrEqual(8);
    expect(result.failures).toEqual([]);

    // 被截断阶段在 Meta 里留下非 0 游标（= 待续跑的 sweep 进度），没有失败的键为空串
    const meta = metaRows(f.sqlite);
    expect(Number(meta[CLEANUP_META_KEYS.cursors.retention])).toBeGreaterThan(0);
    expect(Number(meta[CLEANUP_META_KEYS.cursors.hardDelete])).toBeGreaterThan(0);
    expect(meta[CLEANUP_META_KEYS.lastError]).toBe('');
  });

  it('Meta 键集合：六个键每轮都写入，游标跨轮累计，收敛后回到 0', async () => {
    const f = fixture({ expired: 400, recent: 60, hardDeletable: 0, orphanDirs: 0, maxCount: MAX_COUNT });
    captureConsole();

    const first = await cronRun(f);
    const expectedKeys = [
      CLEANUP_META_KEYS.lastRunAt,
      CLEANUP_META_KEYS.lastError,
      ...CLEANUP_PHASES.map((phase) => CLEANUP_META_KEYS.cursors[phase]),
    ].sort();

    const afterFirst = metaRows(f.sqlite);
    expect(Object.keys(afterFirst).sort()).toEqual(expectedKeys);
    expect(first.truncated).toContain('retention');
    const cursor1 = Number(afterFirst[CLEANUP_META_KEYS.cursors.retention]);
    expect(Number.isSafeInteger(cursor1) && cursor1 > 0).toBe(true);
    // lastRunAt 是可解析的 ISO 时间串（UI 直接展示）
    const runAt = afterFirst[CLEANUP_META_KEYS.lastRunAt] ?? '';
    expect(runAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(runAt))).toBe(false);
    expect(afterFirst[CLEANUP_META_KEYS.lastError]).toBe('');

    // 第二轮从上一轮游标继续（累计推进），而不是每轮从头再来
    const second = await cronRun(f);
    const cursor2 = Number(metaRows(f.sqlite)[CLEANUP_META_KEYS.cursors.retention]);
    expect(cursor2).toBeGreaterThan(cursor1);
    expect(second.expired).toBeGreaterThan(0);

    // 跑到该阶段没有剩余候选时，游标归 0（该阶段没有未完成的 sweep）
    let last: CleanupResult = second;
    for (let i = 0; i < 20 && last.truncated.includes('retention'); i++) last = await cronRun(f);
    const finalMeta = metaRows(f.sqlite);
    expect(last.truncated).toEqual([]);
    for (const phase of CLEANUP_PHASES) expect(finalMeta[CLEANUP_META_KEYS.cursors[phase]]).toBe('0');
    expect(finalMeta[CLEANUP_META_KEYS.lastError]).toBe('');
    expect(Object.keys(finalMeta).sort()).toEqual(expectedKeys);
  });

  it('注入 D1 语句错误：cleanup:lastError 非空、其余阶段照常执行、不向调用方抛错', async () => {
    const f = fixture({ expired: 300, recent: 60, hardDeletable: 120, orphanDirs: 10, maxCount: MAX_COUNT });
    const logs = captureConsole();
    // trim 阶段的第一条语句（countActiveRecords）注入失败；其余阶段的 SQL 不受影响
    f.d1.failWhen = (sql) => sql.includes('SELECT COUNT(*) AS c FROM HistoryRecords');

    const result = await cronRun(f); // 不抛即通过：runCleanup 承诺不向调用方抛裸错

    expect(result.trimmed).toBe(0);
    expect(result.failures.some((m) => m.startsWith('trim:'))).toBe(true);
    // 其它阶段未被连带跳过
    expect(result.expired).toBeGreaterThan(0);
    expect(result.hardDeleted).toBeGreaterThan(0);
    expect(result.orphans).toBeGreaterThan(0);
    expect(logs.lines.some((l) => l.startsWith('[cleanup] phase=trim ') && l.includes('status=error'))).toBe(true);
    expect(logs.errors.some((l) => l.startsWith('[cleanup] error stage=trim '))).toBe(true);

    const lastError = metaRows(f.sqlite)[CLEANUP_META_KEYS.lastError] ?? '';
    expect(lastError.length).toBeGreaterThan(0);
    expect(lastError).toContain('trim');
    expect(lastError).toContain('D1_ERROR: injected statement failure');
    expect(lastError).not.toContain('\n'); // 单行（UI 一行展示）
    // 失败信息不进游标：trim 无进度变化
    expect(metaRows(f.sqlite)[CLEANUP_META_KEYS.cursors.trim]).toBe('0');

    // 连 Meta 读写都失败时（D1 整体不可用）也必须返回结果而不是抛错
    const dead = fixture({ expired: 1, recent: 1, hardDeletable: 1, orphanDirs: 1, maxCount: 1 });
    captureConsole();
    dead.d1.failWhen = () => true;
    const deadResult = await cronRun(dead);
    expect(deadResult.failures.length).toBeGreaterThan(0);
    expect(deadResult.subrequests).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
  });

  it('收藏/置顶占满条数上限时 trim 不空转（不把 truncated 永久挂住）', async () => {
    // active = 400 条**全是收藏**（对保留期与条数上限都豁免）且远超 maxCount ⇒ 超量恒 > 单批上限，
    // 若按"超量仍在"判定 hasMore，该阶段会每轮空转 20 批并把 truncated 永久挂在结果里。
    const f = fixture({ expired: 0, recent: 0, hardDeletable: 0, orphanDirs: 0, maxCount: 5, starred: 400, pinned: 0 });
    const logs = captureConsole();

    const result = await cronRun(f);

    expect(result.trimmed).toBe(0);
    expect(result.truncated).toEqual([]); // 关键：可裁记录耗尽即收工，不把该阶段永久标成"待续跑"
    expect(logs.lines.some((l) => l.startsWith('[cleanup] phase=trim ') && l.includes('status=done'))).toBe(true);
    // 空转会被 MAX_BATCHES_PER_PHASE 放大成 20 批 ×2 次查询；这里必须只是"一次探测"
    expect(result.subrequests).toBeLessThan(40);
    expect(metaRows(f.sqlite)[CLEANUP_META_KEYS.cursors.trim]).toBe('0');
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM HistoryRecords').get()).toEqual({ c: 400 });
  });

  it('积压在有限次运行内收敛，且不破坏收藏/置顶豁免与 30 天硬删保留期', async () => {
    const f = fixture({ expired: 300, recent: MAX_COUNT, hardDeletable: 200, orphanDirs: 25, maxCount: MAX_COUNT });
    captureConsole();

    let result = await cronRun(f);
    let runs = 1;
    while (result.truncated.length > 0 && runs < 30) {
      result = await cronRun(f);
      runs++;
    }

    // ① 有限次内收敛：所有阶段都没有未完成的 sweep（游标回 0）
    expect(runs).toBeLessThan(30);
    expect(result.truncated).toEqual([]);
    expect(result.failures).toEqual([]);
    const meta = metaRows(f.sqlite);
    for (const phase of CLEANUP_PHASES) expect(meta[CLEANUP_META_KEYS.cursors[phase]]).toBe('0');
    expect(meta[CLEANUP_META_KEYS.lastError]).toBe('');

    // ② 数据侧收敛：活跃记录不超上限；无 30 天以上待硬删行；无孤儿目录残留
    expect(scalar(f.sqlite, `SELECT COUNT(*) AS c FROM HistoryRecords WHERE IsDeleted = 0`)).toBeLessThanOrEqual(
      MAX_COUNT + 2, // +2 = 收藏/置顶两条豁免记录
    );
    expect(
      scalar(
        f.sqlite,
        `SELECT COUNT(*) AS c FROM HistoryRecords WHERE IsDeleted = 1 AND LastModified < ${Date.now() - 30 * DAY_MS}`,
      ),
    ).toBe(0);
    // 收藏/置顶记录仍在（未被保留期或条数上限清掉）
    for (const hash of ['STAR0', 'PIN0']) {
      const sql = `SELECT COUNT(*) AS c FROM HistoryRecords WHERE Hash = '${hash}' AND IsDeleted = 0`;
      expect(scalar(f.sqlite, sql), `${hash} 被清掉了`).toBe(1);
    }
    // 软删记录按上游语义**保留**（30 天窗口内不硬删），但其数据目录已被清
    expect(scalar(f.sqlite, `SELECT COUNT(*) AS c FROM HistoryRecords WHERE IsDeleted = 1`)).toBeGreaterThan(0);
    const liveDirs = new Set(
      (f.sqlite.prepare(`SELECT Type, Hash FROM HistoryRecords WHERE IsDeleted = 0`).all() as {
        Type: number;
        Hash: string;
      }[]).map((r) => `${r.Type === 0 ? 'Text' : 'Unknown'}_${r.Hash}/`),
    );
    const leftovers = activeDirs(f.bucket).filter((d) => !liveDirs.has(d));
    expect(leftovers).toEqual([]);
    // 活跃记录的数据仍在
    expect(f.bucket.objects.has('history/Text_STAR0/STAR0.bin')).toBe(true);
  });
});
