// 历史保留与清理（对齐上游 HistoryCleaner.cs + HistoryService 的清理方法）
// 上游三个后台任务：
//   LimitHistoryCountTask  每 10 分钟 → RemoveOutOfRetentionRecords(HistoryRetentionMinutes) + SetRecordsMaxCount(MaxSavedHistoryCount)
//   CleanDeletedHistoryTask 每 12 小时 → RemoveOutOfDateDeletedRecords（硬删 IsDeleted 且 LastModified < now-30d）
//   CleanOrphanedFoldersTask 每 12 小时 → CleanOrphanedFolders（删无活记录的 {Type}_{hash} 目录）
// CF 侧由 Cron Trigger 触发（wrangler.toml [triggers]），一次批量执行全部三类。
//
// F11：Cron 的每个外部调用都算子请求配额（Free 计划 1,000/Cron、Paid 10,000/Cron）。
// 此前四阶段线性串联、没有预算守卫，饱和批实测 12,060 次子请求 —— 平台中断后**排在后面的阶段
// （含 30 天硬删与孤儿回收）整体不执行**，且 scheduled handler 只做 `waitUntil` ⇒ 失败静默。
// 现在：
//   · 每阶段独立 try/catch；子请求先记账再花，耗尽只**截断当前阶段**并落库，不影响其它阶段；
//   · 排在后面的阶段有保底配额（PHASE_RESERVE），不会被前面的阶段吃光预算而跳过；
//   · 阶段进度写进 Meta 游标（CLEANUP_META_KEYS.cursors），本轮没跑完的下轮接着跑；
//   · 每阶段一行 `[cleanup]` 结构化日志 + `cleanup:lastRunAt` / `cleanup:lastError` 落库。
//
// 契约（调用方依赖）：**runCleanup 不向调用方抛裸错**。scheduled handler 只有 ctx.waitUntil，
// 抛出去就是「静默失败」；一切失败都记进返回值、`[cleanup]` 日志与 `cleanup:lastError`。
import { HistoryDb } from './db';
import { R2Storage } from './storage';
import { entityToDtoWire } from './serialization';
import { HistoryRecordEntity } from './types';
import { Bindings } from './env';
import { broadcast } from './hub';

// ===== 预算与批量 =====

// 单轮 Cron 的子请求预算。Free 计划上限 1,000/Cron，取 800 留 20% 余量：
// 记账模型未覆盖的部分（单个工作目录内超过 1000 个对象时的额外 R2 分页、D1 重试、平台自身开销）。
// 改这一个常量即可整体放宽（Paid 计划 10,000/Cron ⇒ 可取 8,000）。
export const SUBREQUEST_BUDGET = 800;

// 软删（保留期/条数上限）单批条数：对齐上游分批语义。
const SOFT_DELETE_BATCH_LIMIT = 200;
// 硬删单批条数：与软删产生速率同阶（此前固定 200/次，低于产生上限 ⇒ 积压只增不减）。
// 实际单批条数再受预算约束：饱和积压下约 199 条/轮（= 旧实现的上限，但**每轮都保证执行**），
// 其它阶段没有积压时可用满全部余量（最多约 399 条/轮）。
const HARD_DELETE_BATCH_LIMIT = 1000;
// 单阶段批次数上限：防「D1 返回满批却没真正推进」时的死循环。
const MAX_BATCHES_PER_PHASE = 20;
// 已删除记录保留期（上游 RemoveOutOfDateDeletedRecords 固定 30 天）
const DELETED_RETENTION_DAYS = 30;

// ===== 子请求记账模型 =====
// 每个外部调用 = 1 次子请求：D1 语句、R2 调用、DO fetch 各计一次。
// R2 删前缀 = list + delete 两次（src/storage.ts 的 deletePrefix）。
const SUBREQUESTS_PER_D1_STATEMENT = 1;
const SUBREQUESTS_PER_R2_WORKDIR = 2;
const SUBREQUESTS_PER_BROADCAST = 1;
const SUBREQUESTS_PER_EXPIRED_RECORD = SUBREQUESTS_PER_R2_WORKDIR + SUBREQUESTS_PER_BROADCAST; // 3
const SUBREQUESTS_PER_TRIMMED_RECORD = SUBREQUESTS_PER_EXPIRED_RECORD; // 3
const SUBREQUESTS_PER_HARD_DELETED_RECORD = SUBREQUESTS_PER_R2_WORKDIR; // 2（硬删不广播）
// 孤儿阶段的前置扫描：1×D1 活目录查询 + R2 列举 history/。
// `R2Storage.listHistoryWorkingDirs()` 内部按 1000 键/页分页，而页数无法从返回值得知 ⇒
// 按 5 页（约 5000 个对象）保守记账：宁可少算可处理的目录数，也不要让实际调用数超过预算。
// （更大的 history/ 由 SUBREQUEST_BUDGET 相对平台 1,000 上限的 20% 余量吸收。）
const HISTORY_SCAN_PAGES_CHARGED = 5;
const SUBREQUESTS_PER_ORPHAN_SCAN = SUBREQUESTS_PER_D1_STATEMENT + HISTORY_SCAN_PAGES_CHARGED;
const SUBREQUESTS_PER_ORPHAN_DIR = SUBREQUESTS_PER_R2_WORKDIR;

// 阶段顺序 = 依赖顺序：软删（保留期 → 条数上限）→ 硬删 → 孤儿回收（吃掉前两者留下的无主目录）。
export const CLEANUP_PHASES = ['retention', 'trim', 'hardDelete', 'orphans'] as const;
export type CleanupPhase = (typeof CLEANUP_PHASES)[number];

// 每阶段的**保底配额**（子请求）：排在后面的阶段至少能拿到这么多，杜绝「前一阶段吃满预算 ⇒
// 后续阶段静默跳过」。取值 ≈ 该阶段最小可推进单元的成本：
//   retention/trim = 1 批查询 + 十几条记录；orphans = 1 次扫描 + 约 20 个目录；
//   hardDelete = 保底最大（约 200 条 ×2）：软删只产生积压、硬删只消费积压，是唯一"只增不减"的阶段，
//   上游对应的 RemoveOutOfDateDeletedRecords 本就是一次清空。
// 前序阶段用不完的额度仍会**动态让给**后面的阶段（roomFor = 总预算 − 已花 − 后续阶段保底之和），
// 所以这些数值是下限而不是上限。前提：SUBREQUEST_BUDGET 必须大于保底之和（当前 512），否则每个阶段
// 都连第一批都跑不动 —— 调预算时同步复核这张表。
const PHASE_RESERVE: Record<CleanupPhase, number> = {
  retention: 32,
  trim: 32,
  hardDelete: 400,
  orphans: 48,
};

// 每个阶段**之后**所有阶段的保底配额之和（模块加载时算一次，避免每轮重复计算）
const RESERVED_AFTER: Record<CleanupPhase, number> = (() => {
  const out: Record<CleanupPhase, number> = { retention: 0, trim: 0, hardDelete: 0, orphans: 0 };
  let acc = 0;
  for (let i = CLEANUP_PHASES.length - 1; i >= 0; i--) {
    const phase = CLEANUP_PHASES[i]!;
    out[phase] = acc;
    acc += PHASE_RESERVE[phase];
  }
  return out;
})();

// ===== Meta 键（D→F 契约）=====

// 清理任务写进 Meta 的键；UI 的 /ui/api/info 只读展示同名键。
// 六个键每轮运行都会写入，因此 UI 侧可以假定它们恒存在。
export interface CleanupMetaKeys {
  lastRunAt: string;
  lastError: string;
  cursors: Record<CleanupPhase, string>;
}

export const CLEANUP_META_KEYS: CleanupMetaKeys = {
  lastRunAt: 'cleanup:lastRunAt',
  lastError: 'cleanup:lastError',
  cursors: {
    retention: 'cleanup:cursor:retention',
    trim: 'cleanup:cursor:trim',
    hardDelete: 'cleanup:cursor:hardDelete',
    orphans: 'cleanup:cursor:orphans',
  },
};

const META_KEYS_ALL: string[] = [
  CLEANUP_META_KEYS.lastRunAt,
  CLEANUP_META_KEYS.lastError,
  ...CLEANUP_PHASES.map((phase) => CLEANUP_META_KEYS.cursors[phase]),
];

// cleanup:lastError 落库长度上限（UI 只展示一行；完整清单在返回值与 [cleanup] 日志里）
const META_LAST_ERROR_MAX = 300;

export interface CleanupResult {
  expired: number;
  trimmed: number;
  hardDeleted: number;
  orphans: number;
  batches: number;
  /** 本轮记账的子请求数（含 Meta 读写），恒 ≤ SUBREQUEST_BUDGET */
  subrequests: number;
  /** 因预算或批次上限被截断、需下一轮续跑的阶段（按阶段顺序） */
  truncated: CleanupPhase[];
  /** 本轮全部失败（阶段级 / 阶段内单条记录 / 收尾写入）；正常为空数组 */
  failures: string[];
}

// 游标语义：**当前未完成的 sweep 里该阶段已处理的记录数（孤儿阶段为目录数）**。
// 候选集是单调消耗的（软删的记录不再匹配 IsDeleted = 0、硬删的行已删除、已删的孤儿目录不再出现在
// R2 列举里），所以下一轮从游标"继续"不需要 SQL OFFSET —— 重新查询天然只看到剩余候选，
// 而 OFFSET 反而会跳过后面的候选（这是不能用批序号当游标的原因）。游标归 0 = 该阶段没有未完成的 sweep。
const ZERO_CURSORS: Record<CleanupPhase, number> = { retention: 0, trim: 0, hardDelete: 0, orphans: 0 };

type CleanupStage = CleanupPhase | 'meta' | 'run';

interface CleanupRun {
  db: HistoryDb;
  storage: R2Storage;
  env: Bindings;
  budget: SubrequestBudget;
  cursors: Record<CleanupPhase, number>;
  failures: string[];
  nowMs: number;
}

interface PhaseOutcome {
  /** 本阶段本轮处理的记录数（孤儿阶段为目录数） */
  processed: number;
  /** 本阶段本轮执行的批量查询次数 */
  batches: number;
  /** 是否因预算/批次上限提前停止（true ⇒ 下一轮从游标续跑） */
  truncated: boolean;
}

// 子请求账本：所有外部调用前先在此扣减。超预算只截断当前阶段，
// 而不是让平台中断整轮清理（那样会让后面的阶段整体不执行）。
class SubrequestBudget {
  spent = 0;

  constructor(private readonly total: number) {}

  // 某阶段本轮还可动用的额度：总预算 − 已花 − 排在它之后的阶段的保底配额。
  // 由此可保证每个阶段开跑时都至少握着 PHASE_RESERVE 的额度。
  roomFor(phase: CleanupPhase): number {
    return Math.max(0, this.total - this.spent - RESERVED_AFTER[phase]);
  }

  spend(n: number): void {
    this.spent += n;
  }
}

const PHASE_COUNTER: Record<CleanupPhase, 'expired' | 'trimmed' | 'hardDeleted' | 'orphans'> = {
  retention: 'expired',
  trim: 'trimmed',
  hardDelete: 'hardDeleted',
  orphans: 'orphans',
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

// 记一次失败：进返回值（⇒ cleanup:lastError）+ 结构化日志。F11 的原始形态就是"没有任何 [cleanup] 行"。
// 消息压成单行且不带堆栈：它会写进 Meta（UI 展示）与日志行，多行/堆栈会把结构化日志打散。
function recordFailure(failures: string[], stage: CleanupStage, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  const message = `${stage}: ${raw.replace(/\s+/g, ' ').trim()}`;
  failures.push(message);
  console.error(`[cleanup] error stage=${stage} message=${message}`);
}

interface BatchPhaseSpec {
  phase: CleanupPhase;
  /** 每条记录产生的子请求数 */
  costPerRecord: number;
  /** 每批的查询数（trim 一批要 count + trim 两次） */
  queryCost: number;
  /** 单批条数上限 */
  batchLimit: number;
  /** 处理后是否广播变更（软删路径广播，硬删不广播） */
  notify: boolean;
  /** 取一批候选；hasMore 必须按**实际生效的条数**判定，否则会把"候选已取完"误判成"被截断" */
  fetchBatch(limit: number): Promise<{ rows: HistoryRecordEntity[]; hasMore: boolean }>;
}

// 分批推进一个「按记录处理」的阶段：每批先按剩余额度算出可负担的条数，
// 连一条都负担不起就停止并把该阶段标记为 truncated（下一轮从游标续跑，绝不静默跳过）。
async function drainBatches(run: CleanupRun, spec: BatchPhaseSpec): Promise<PhaseOutcome> {
  let processed = 0;
  let batches = 0;
  for (let i = 0; i < MAX_BATCHES_PER_PHASE; i++) {
    const room = run.budget.roomFor(spec.phase) - spec.queryCost;
    const limit = Math.min(spec.batchLimit, Math.floor(room / spec.costPerRecord));
    if (limit < 1) return { processed, batches, truncated: true };
    run.budget.spend(spec.queryCost);
    batches++;
    const { rows, hasMore } = await spec.fetchBatch(limit);
    await applyRecordCleanup(run, spec.phase, rows, spec.notify);
    run.budget.spend(rows.length * spec.costPerRecord);
    processed += rows.length;
    if (!hasMore) return { processed, batches, truncated: false };
  }
  return { processed, batches, truncated: true };
}

// 记录被清理后删其数据目录（上游 DeleteProfileData）；软删路径另需广播（上游 OnRecordDeletedAsync，
// 硬删不广播）。逐条隔离失败：单条失败不阻断同批其余记录，且漏删的数据目录会被孤儿阶段回收。
async function applyRecordCleanup(
  run: CleanupRun,
  phase: CleanupPhase,
  rows: HistoryRecordEntity[],
  notify: boolean,
): Promise<void> {
  for (const e of rows) {
    try {
      await run.storage.deleteHistoryWorkingDir(e.type, e.hash);
      if (notify) await broadcast(run.env, 'RemoteHistoryChanged', entityToDtoWire(e));
    } catch (err) {
      recordFailure(run.failures, phase, err);
    }
  }
}

// 1) 保留期：过期且未收藏/未置顶/未删除 → 软删（IsDeleted/Version++/LastModified=now）
function cleanRetention(run: CleanupRun, retentionMinutes: number): Promise<PhaseOutcome> {
  const cutoffMs = run.nowMs - retentionMinutes * 60_000;
  return drainBatches(run, {
    phase: 'retention',
    costPerRecord: SUBREQUESTS_PER_EXPIRED_RECORD,
    queryCost: SUBREQUESTS_PER_D1_STATEMENT,
    batchLimit: SOFT_DELETE_BATCH_LIMIT,
    notify: true,
    fetchBatch: async (limit) => {
      const rows = await run.db.softDeleteExpiredRecords(cutoffMs, run.nowMs, limit);
      return { rows, hasMore: rows.length === limit };
    },
  });
}

// 2) 条数上限：超量时软删最旧（非收藏/非置顶）（上游 SetRecordsMaxCount → MarkForDeletion）
function cleanTrim(run: CleanupRun, maxCount: number): Promise<PhaseOutcome> {
  return drainBatches(run, {
    phase: 'trim',
    costPerRecord: SUBREQUESTS_PER_TRIMMED_RECORD,
    // 一批两次查询：countActiveRecords（算超量）+ trimToMaxCount
    queryCost: 2 * SUBREQUESTS_PER_D1_STATEMENT,
    batchLimit: SOFT_DELETE_BATCH_LIMIT,
    notify: true,
    fetchBatch: async (limit) => {
      const overage = (await run.db.countActiveRecords()) - maxCount;
      if (overage <= 0) return { rows: [], hasMore: false };
      const take = Math.min(overage, limit);
      const rows = await run.db.trimToMaxCount(take, run.nowMs);
      // 实际删到少于请求条数 ⇒ 可裁的（非收藏/非置顶）已耗尽，即使 active 仍超上限也**必须收工**：
      // 否则收藏/置顶占满配额时该阶段会永远"有更多"，每轮空转并把 truncated 永远挂在结果里。
      return { rows, hasMore: rows.length === take && overage > take };
    },
  });
}

// 3) 已删除记录硬删（>30 天）+ 删数据目录（上游 RemoveOutOfDateDeletedRecords，不广播）
function cleanHardDeleted(run: CleanupRun, cutoffMs: number): Promise<PhaseOutcome> {
  return drainBatches(run, {
    phase: 'hardDelete',
    costPerRecord: SUBREQUESTS_PER_HARD_DELETED_RECORD,
    queryCost: SUBREQUESTS_PER_D1_STATEMENT,
    batchLimit: HARD_DELETE_BATCH_LIMIT,
    notify: false,
    fetchBatch: async (limit) => {
      const rows = await run.db.hardDeleteOldDeletedRecords(cutoffMs, limit);
      return { rows, hasMore: rows.length === limit };
    },
  });
}

// 4) 孤儿对象清理：history/ 下存在目录但 DB 无活记录引用。
// 比较双方**必须同为带尾斜杠的目录名**（本函数从 R2 key 截取得 `Text_ABC/`，
// `db.listActiveWorkingDirs` 也返回带斜杠形式）。形式不一致会让 `active.has(dir)` 恒为 false，
// 从而把**所有**历史数据目录当成孤儿删除 —— 曾因此每小时清空一次 history/（见 F33）。
async function cleanOrphans(run: CleanupRun): Promise<PhaseOutcome> {
  if (run.budget.roomFor('orphans') < SUBREQUESTS_PER_ORPHAN_SCAN) {
    return { processed: 0, batches: 0, truncated: true };
  }
  run.budget.spend(SUBREQUESTS_PER_ORPHAN_SCAN);
  const workingDirs = await run.storage.listHistoryWorkingDirs();
  if (workingDirs.length === 0) return { processed: 0, batches: 0, truncated: false };
  const active = await run.db.listActiveWorkingDirs();
  let processed = 0;
  for (const dir of workingDirs) {
    if (active.has(dir)) continue;
    if (run.budget.roomFor('orphans') < SUBREQUESTS_PER_ORPHAN_DIR) {
      return { processed, batches: 0, truncated: true };
    }
    run.budget.spend(SUBREQUESTS_PER_ORPHAN_DIR);
    try {
      await run.storage.deleteHistoryPrefix(dir);
      processed++;
    } catch (err) {
      recordFailure(run.failures, 'orphans', err);
    }
  }
  return { processed, batches: 0, truncated: false };
}

function runPhase(
  run: CleanupRun,
  phase: CleanupPhase,
  retentionMinutes: number,
  maxCount: number,
): Promise<PhaseOutcome> {
  switch (phase) {
    case 'retention':
      return cleanRetention(run, retentionMinutes);
    case 'trim':
      return cleanTrim(run, maxCount);
    case 'hardDelete':
      return cleanHardDeleted(run, run.nowMs - DELETED_RETENTION_DAYS * 24 * 60 * 60_000);
    case 'orphans':
      return cleanOrphans(run);
  }
}

// 阶段被 env 显式关闭（0 = 关闭，与 parsePositiveInt 的语义一致）
function disabledReason(phase: CleanupPhase, retentionMinutes: number, maxCount: number): string | null {
  if (phase === 'retention' && retentionMinutes <= 0) return 'HISTORY_RETENTION_MINUTES=0';
  if (phase === 'trim' && maxCount <= 0) return 'MAX_SAVED_HISTORY_COUNT=0';
  return null;
}

export async function runCleanup(env: Bindings): Promise<CleanupResult> {
  const result: CleanupResult = {
    expired: 0,
    trimmed: 0,
    hardDeleted: 0,
    orphans: 0,
    batches: 0,
    subrequests: 0,
    truncated: [],
    failures: [],
  };

  try {
    const run: CleanupRun = {
      db: new HistoryDb(env.DB),
      storage: new R2Storage(env.R2),
      env,
      budget: new SubrequestBudget(SUBREQUEST_BUDGET),
      cursors: { ...ZERO_CURSORS },
      failures: result.failures,
      nowMs: Date.now(),
    };
    const retentionMinutes = parsePositiveInt(env.HISTORY_RETENTION_MINUTES, 10080);
    const maxCount = parsePositiveInt(env.MAX_SAVED_HISTORY_COUNT, 1000);
    const startedAt = new Date(run.nowMs).toISOString();

    // 上一轮的游标：读失败不阻断清理（按 0 处理并照常记账/落库）
    try {
      run.budget.spend(SUBREQUESTS_PER_D1_STATEMENT);
      const stored = await run.db.getMetaValues(META_KEYS_ALL);
      for (const phase of CLEANUP_PHASES) {
        run.cursors[phase] = parsePositiveInt(stored.get(CLEANUP_META_KEYS.cursors[phase]), 0);
      }
    } catch (err) {
      recordFailure(run.failures, 'meta', err);
    }

    for (const phase of CLEANUP_PHASES) {
      const phaseStartMs = Date.now();
      const off = disabledReason(phase, retentionMinutes, maxCount);
      let processed = 0;
      let batches = 0;
      let status: 'done' | 'truncated' | 'disabled' | 'error';
      if (off) {
        status = 'disabled';
      } else {
        try {
          const outcome = await runPhase(run, phase, retentionMinutes, maxCount);
          processed = outcome.processed;
          batches = outcome.batches;
          status = outcome.truncated ? 'truncated' : 'done';
        } catch (err) {
          // 单阶段失败（如 D1 报错）只记这一阶段：其余阶段照常执行，游标保留入口值待续跑
          status = 'error';
          recordFailure(run.failures, phase, err);
        }
      }

      result[PHASE_COUNTER[phase]] += processed;
      result.batches += batches;
      if (status === 'truncated') {
        result.truncated.push(phase);
        run.cursors[phase] += processed;
      } else if (status !== 'error') {
        run.cursors[phase] = 0;
      }

      console.log(
        `[cleanup] phase=${phase} status=${status} processed=${processed} batches=${batches} truncated=${status === 'truncated'} cursor=${run.cursors[phase]} subrequests=${run.budget.spent} ms=${Date.now() - phaseStartMs}${off ? ` reason=${off}` : ''}`,
      );
    }

    result.subrequests = run.budget.spent;

    // 收尾落库：六个键每轮都写（UI 据此展示进度与失败）。写失败只记日志/返回值 ——
    // 此时已无处落库，且不能把错误抛给调用方。
    try {
      run.budget.spend(SUBREQUESTS_PER_D1_STATEMENT);
      await run.db.setMetaValues({
        [CLEANUP_META_KEYS.lastRunAt]: startedAt,
        [CLEANUP_META_KEYS.lastError]: run.failures.join('; ').slice(0, META_LAST_ERROR_MAX),
        ...Object.fromEntries(
          CLEANUP_PHASES.map((phase) => [CLEANUP_META_KEYS.cursors[phase], String(run.cursors[phase])]),
        ),
      });
    } catch (err) {
      recordFailure(run.failures, 'meta', err);
    }

    result.subrequests = run.budget.spent;
  } catch (err) {
    // 顶层兜底：runCleanup 对调用方承诺不抛裸错（scheduled handler 只有 waitUntil）
    recordFailure(result.failures, 'run', err);
  }

  console.log(
    `[cleanup] run status=${result.failures.length === 0 ? 'ok' : 'partial'} expired=${result.expired} trimmed=${result.trimmed} hardDeleted=${result.hardDeleted} orphans=${result.orphans} batches=${result.batches} truncated=${result.truncated.join(',') || 'none'} subrequests=${result.subrequests}/${SUBREQUEST_BUDGET} failures=${result.failures.length}`,
  );
  return result;
}
