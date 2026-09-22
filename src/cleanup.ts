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
import { R2_DELETE_BATCH, R2Storage, workingDirName } from './storage';
import { entityToDtoWire } from './serialization';
import { HistoryRecordEntity } from './types';
import { Bindings } from './env';
import { broadcast } from './hub';
import type { ProfileType } from './types';

// ===== 预算与批量 =====

// 单轮 Cron 的子请求预算。Free 计划上限 1,000/Cron，取 800 留 20% 余量：
// 记账模型未覆盖的部分（单个工作目录内超过 1000 个对象时的额外 R2 分页、D1 重试、平台自身开销）。
// 改这一个常量即可整体放宽（Paid 计划 10,000/Cron ⇒ 可取 8,000）。
export const SUBREQUEST_BUDGET = 800;

// 软删（保留期/条数上限）单批条数：**对齐上游**（`HistoryManagerHelper.SetRecordsMaxCount` /
// `RemoveExpiredInBatchesAsync` 的 `BatchSize = 500`）。批上限只有在预算真放得下时才有意义 ——
// 软删每条只花 1 次广播（**不清数据目录**，见下面记账模型），500 条因此落得进 800 的预算。
const SOFT_DELETE_BATCH_LIMIT = 500;
// 硬删单批条数：每条成本为 0（不广播，目录由所在批次一次批量删），单轮能吃下的量由
// MAX_BATCHES_PER_PHASE × 本值决定；单批设上限是为了让「一次 D1 语句 + 一次批量删」的内存有界。
const HARD_DELETE_BATCH_LIMIT = 1000;
// 单阶段批次数上限：防「D1 返回满批却没真正推进」时的死循环。
const MAX_BATCHES_PER_PHASE = 20;
// 已删除记录保留期（上游 RemoveOutOfDateDeletedRecords 固定 30 天）
const DELETED_RETENTION_DAYS = 30;

// ===== 子请求记账模型 =====
// 每个外部调用 = 1 次子请求：D1 语句、R2 调用、DO fetch 各计一次。
//
// **批内目录清扫**（2026-09-15）：硬删与孤儿阶段不做逐条 `deleteHistoryWorkingDir`
//（那是"每条 2 次 R2 调用：列举 + 删除"，见 storage.ts 的 deletePrefix），而是每轮**列举一次**
// history/ 拿到「目录 → key」映射（按实际页数记账），再**每批一次**批量删（R2 delete 单次可带
// 1000 个 key）。逐条删除时 500 条 = 1500 次子请求，会撞上平台单次调用 1000 次的上限。
//   · 保留期/条数上限（软删）：每条 1 次广播（`RemoteHistoryChanged`），**不清数据目录**
//     —— 回收站要能连数据拿回来（ADR D29）；字节留到硬删或用户「彻底删除」时才清。
//   · 硬删：每条 0 次（上游语义也不广播），每批额外 1 次批量删。
const SUBREQUESTS_PER_D1_STATEMENT = 1;
const SUBREQUESTS_PER_BROADCAST = 1;
const SUBREQUESTS_PER_SWEEP_CALL = 1;

// 阶段顺序 = 依赖顺序：软删（保留期 → 条数上限）→ 硬删 → 孤儿回收（吃掉前两者留下的无主目录）。
export const CLEANUP_PHASES = ['retention', 'trim', 'hardDelete', 'orphans'] as const;
export type CleanupPhase = (typeof CLEANUP_PHASES)[number];

// 每阶段的**保底配额**（子请求）：排在后面的阶段至少能拿到这么多，杜绝「前一阶段吃满预算 ⇒
// 后续阶段静默跳过」。取值 ≈ 该阶段最小可推进单元的成本：
//   retention = 1 批查询 + 少量广播；trim 多一条 COUNT；hardDelete = 1 批查询 + 1 次批量删
//   （不广播）；orphans = 1 次活目录查询 + 1 次列举（按实际页数）+ 1 次批量删。
// 前序阶段用不完的额度仍会**动态让给**后面的阶段（roomFor = 总预算 − 已花 − 后续阶段保底之和），
// 所以这些数值是下限而不是上限。前提：SUBREQUEST_BUDGET 必须大于保底之和（当前 72），否则每个阶段
// 都连第一批都跑不动 —— 调预算时同步复核这张表。
const PHASE_RESERVE: Record<CleanupPhase, number> = {
  retention: 16,
  trim: 16,
  hardDelete: 16,
  orphans: 24,
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

// ===== Meta 键（清理任务写 / UI 只读的共享键名）=====

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

// ===== 保留策略（Meta 覆盖 / env 回落，docs/backend-gaps.md §2.5）=====

// 在线可调的覆盖键：存在即覆盖 env。**清除覆盖 = 删键**，不是写空串 ——
// 空串经 `Number('')` 会解析成 0，而 0 的语义是「关闭该阶段」（见 disabledReason），
// 与「回落到 env」正好相反（`HistoryDb.deleteMetaValues` 的注释同此）。
// 键名只在此处定义：src/ui/maintenance.ts（PUT /ui/api/settings）从这里 import，避免两处各写一份字面量。
export const SETTINGS_META_KEYS = {
  retentionMinutes: 'settings:retentionMinutes',
  maxSavedHistoryCount: 'settings:maxSavedHistoryCount',
} as const;

const SETTINGS_META_KEY_LIST: string[] = Object.values(SETTINGS_META_KEYS);

// env 未提供时的内置默认（与 wrangler.toml [vars] 的取值一致：0 = 不限制保留时长 / 1000 条）。
// ⚠️ 保留期这一项 2026-09-22 由 10080（7 天）改成 **0**：对齐上游 3.3.0 的
// `AppSettings.HistoryRetentionMinutes` 默认值（上游 #402/#426 把它改成了「0 = 不限制」，
// 只有条数上限兜底）。改动带出两个连带面，见 `RetentionSource` 与 `DISABLED_KEY` 的注释。
// **不出现在 API 响应里**：接口报的是「配置值」，把引擎默认回填成配置值会让「未设置」这个状态消失。
const DEFAULT_RETENTION_MINUTES = 0;
const DEFAULT_MAX_SAVED_HISTORY_COUNT = 1000;

/** 生效值来自哪里。三档按**实际出处**取，消费者的用途都是"把这个 0 归给谁"（见 `disabledReason`）。 */
export type RetentionSource = 'meta' | 'env' | 'default';

export interface RetentionSettings {
  /** 生效的保留期（分钟）。0 = 关闭该阶段；null = 未配置（Meta 与 env 都没给）。 */
  retentionMinutes: number | null;
  /** 生效的条数上限。0 = 关闭该阶段；null = 未配置。 */
  maxSavedHistoryCount: number | null;
  /** 生效值来自哪里：`meta` = 存在 Meta 覆盖（值非法时视为不存在）、`env` = 否则部署变量给了合法值、
   *  `default` = 两处都没有（含变量存在但值非法）⇒ 生效的是内置默认 */
  retentionSource: RetentionSource;
  maxCountSource: RetentionSource;
}

// 解析单个配置值：合法 = 非负安全整数（**0 合法**），非法/缺失 = null（未配置）。
// 不复用 parseNonNegativeInt：那个函数的返回值是「总是有值」（回落到 fallback），
// 而这里必须能表达「未配置」这一状态，且**不能**把 0 当非法值回落默认 ——
// 那会让「关闭清理」变成「按默认清理」，属于静默改变用户意图。
function parseSettingValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// 纯 env 回落（不含 Meta 覆盖）：Meta 读失败时 runCleanup 用它与正常读取同源判据。
// `parseSettingValue(env.X)` 非法（含未配置）⇒ 生效的是内置默认 ⇒ 来源记 `'default'`。
export function settingsFromEnv(env: Bindings): RetentionSettings {
  const fromEnv = {
    retentionMinutes: parseSettingValue(env.HISTORY_RETENTION_MINUTES),
    maxSavedHistoryCount: parseSettingValue(env.MAX_SAVED_HISTORY_COUNT),
  };
  return {
    retentionMinutes: fromEnv.retentionMinutes,
    maxSavedHistoryCount: fromEnv.maxSavedHistoryCount,
    retentionSource: fromEnv.retentionMinutes === null ? 'default' : 'env',
    maxCountSource: fromEnv.maxSavedHistoryCount === null ? 'default' : 'env',
  };
}

// 保留策略的**唯一**读入口：cleanup（runCleanup）、/ui/api/info、/ui/api/settings 三处共用，
// 杜绝「清理按 Meta、界面显示按 env」的分叉。成本 = 1 次 D1 读（getMetaValues 单条 IN 查询）。
export async function readRetentionSettings(db: HistoryDb, env: Bindings): Promise<RetentionSettings> {
  const meta = await db.getMetaValues(SETTINGS_META_KEY_LIST);
  const fromMeta = {
    retentionMinutes: parseSettingValue(meta.get(SETTINGS_META_KEYS.retentionMinutes)),
    maxSavedHistoryCount: parseSettingValue(meta.get(SETTINGS_META_KEYS.maxSavedHistoryCount)),
  };
  // 来源按**生效值的实际出处**取，三档缺一不可：内置默认自 2026-09-22 起是 0（关闭保留期），
  // 「两处都没设」这一态因此**真的会**关掉一个阶段 —— 只报 `env` 会把维护者指向一个根本没配的变量
  // （见 `disabledReason` 的注释与 `docs/ui.md` 的保留策略小节）。
  const sourceOf = (metaValue: number | null, envValue: number | null): RetentionSource =>
    metaValue !== null ? 'meta' : envValue !== null ? 'env' : 'default';
  const base = settingsFromEnv(env);
  return {
    retentionMinutes: fromMeta.retentionMinutes ?? base.retentionMinutes,
    maxSavedHistoryCount: fromMeta.maxSavedHistoryCount ?? base.maxSavedHistoryCount,
    retentionSource: sourceOf(fromMeta.retentionMinutes, base.retentionMinutes),
    maxCountSource: sourceOf(fromMeta.maxSavedHistoryCount, base.maxSavedHistoryCount),
  };
}

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
  /**
   * history/ 的「工作目录 → 对象 key」映射。每轮**首次需要时列举一次**（按实际页数记账），
   * 之后各阶段/各批次复用并就地摘除已删条目 —— 这是「批内一次清扫」能成立的前提，
   * 也是清理成本从"每条 2 次 R2 调用"降到"每轮一次列举 + 每批一次批量删"的地方。
   */
  sweep: Map<string, string[]> | null;
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

// 名字是「非负」不是「正数」：**0 是合法值**（它表示"关闭该阶段"，见 disabledReason），
// 所以这里判 `n >= 0` 而不是 `n > 0`。
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
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

/** 清理批次里一行记录的最小形状：清扫数据目录只需要 `type`/`hash`（硬删阶段），
 *  软删阶段还要整行来做广播载荷。 */
type CleanupRow = { type: ProfileType; hash: string };

interface BatchPhaseSpec<T extends CleanupRow> {
  phase: CleanupPhase;
  /** 每条记录产生的子请求数 */
  costPerRecord: number;
  /** 每批的查询数（trim 一批要 count + trim 两次） */
  queryCost: number;
  /** 每批的固定开销（子请求）：硬删每批一次批量删目录；软删只在 costPerRecord 里逐条广播 */
  batchedCallCost: number;
  /** 单批条数上限 */
  batchLimit: number;
  /** 取一批候选；hasMore 必须按**实际生效的条数**判定，否则会把"候选已取完"误判成"被截断" */
  fetchBatch(limit: number): Promise<{ rows: T[]; hasMore: boolean }>;
  /** 本批的收尾动作：软删广播变更，硬删清扫数据目录（两侧语义见上面记账模型） */
  applyBatch(rows: T[]): Promise<void>;
}

// 分批推进一个「按记录处理」的阶段：每批先按剩余额度算出可负担的条数，
// 连一条都负担不起就停止并把该阶段标记为 truncated（下一轮从游标续跑，绝不静默跳过）。
async function drainBatches<T extends CleanupRow>(
  run: CleanupRun,
  spec: BatchPhaseSpec<T>,
): Promise<PhaseOutcome> {
  let processed = 0;
  let batches = 0;
  for (let i = 0; i < MAX_BATCHES_PER_PHASE; i++) {
    // 每批的额度里先扣掉本阶段的固定开销（硬删的一次批量删）与查询，再按每条成本折算条数。
    const room = run.budget.roomFor(spec.phase) - spec.queryCost - spec.batchedCallCost;
    // costPerRecord 为 0（硬删：不广播、目录并入批次清扫）时不受"每条成本"约束，只按批上限推进；
    // 它仍要求 room ≥ 0，也就是至少付得起这一批的查询与清扫。
    const limit =
      spec.costPerRecord > 0
        ? Math.min(spec.batchLimit, Math.floor(room / spec.costPerRecord))
        : room >= 0
          ? spec.batchLimit
          : 0;
    if (limit < 1) return { processed, batches, truncated: true };
    run.budget.spend(spec.queryCost);
    batches++;
    const { rows, hasMore } = await spec.fetchBatch(limit);
    await spec.applyBatch(rows);
    run.budget.spend(rows.length * spec.costPerRecord);
    processed += rows.length;
    if (!hasMore) return { processed, batches, truncated: false };
  }
  return { processed, batches, truncated: true };
}

// 取（并按需列举一次）history/ 的目录 → key 映射。列举成本按**实际页数**记账（1 页 = 1 次子请求），
// 不再按猜测的页数保守估算 —— 记账要"不少于实际"，而列举调用数是确定的。
async function historyGroups(run: CleanupRun): Promise<Map<string, string[]>> {
  if (run.sweep !== null) return run.sweep;
  const { groups, pages } = await run.storage.listHistoryObjectsByDir();
  run.budget.spend(Math.max(pages, 1));
  run.sweep = groups;
  return groups;
}

// 批量清扫给定工作目录（`workingDirPrefix()` 的产物）下的对象，返回实际删掉的目录数与是否删完。
// 与旧的"逐条 deleteHistoryWorkingDir"相比：R2 调用从"每条 2 次"变成"每批 1 次"（≤1000 key/次），
// 代价是失败隔离从"每条"变成"每批"—— 兜底不变：漏删的目录会被孤儿阶段回收（它做的是全量差集）。
async function sweepWorkingDirs(
  run: CleanupRun,
  phase: CleanupPhase,
  dirs: string[],
): Promise<{ removedDirs: number; complete: boolean }> {
  const groups = await historyGroups(run);
  let keys: string[] = [];
  let pendingDirs: string[] = [];
  let removedDirs = 0;
  let complete = true;

  // ⚠️ 必须按 R2_DELETE_BATCH **分块**：`keys` 是按**目录**收进来的，而单个目录能装下任意多个
  // 对象（正常写路径是每目录 1 个，异常/历史数据不然）。不分块时 `deleteHistoryKeys` 的断言
  // （>1000 个直接抛）会让**该目录每轮都删不掉**：失败被记成 failure、对象永远留在 R2 里
  // （2026-09-20 实测：一个目录放 1200 个对象，修改前一个都不少）。每块各记一次子请求；
  // 正常数据永远只有一块，与改动前逐位相同。
  const flush = async (): Promise<boolean> => {
    if (keys.length === 0) return true;
    for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
      if (run.budget.roomFor(phase) < SUBREQUESTS_PER_SWEEP_CALL) return false;
      run.budget.spend(SUBREQUESTS_PER_SWEEP_CALL);
      try {
        await run.storage.deleteHistoryKeys(keys.slice(i, i + R2_DELETE_BATCH));
      } catch (err) {
        recordFailure(run.failures, phase, err);
        return false;
      }
    }
    removedDirs += pendingDirs.length;
    keys = [];
    pendingDirs = [];
    return true;
  };

  for (const dir of dirs) {
    const owned = groups.get(dir);
    if (owned === undefined) continue; // 目录下已无对象（被本轮的更早批次删过，或它本来就没有对象）
    keys.push(...owned);
    pendingDirs.push(dir);
    groups.delete(dir);
    if (keys.length >= R2_DELETE_BATCH && !(await flush())) {
      complete = false;
      break;
    }
  }
  if (complete && !(await flush())) complete = false;
  return { removedDirs, complete };
}

// 软删阶段的收尾：逐条广播 `RemoteHistoryChanged`（上游 OnRecordDeletedAsync）。
// **不清数据目录** —— 回收站要能连数据把记录拿回来（ADR D29，与 `historyOps.applyHistoryUpdate`
// 的软删同一语义）；字节留到 30 天硬删或用户「彻底删除」时才清。上游在这里会调
// `DeleteProfileDataIfNeed` 立即删目录，那条偏离登记在 `docs/protocol.md` §10。
// 广播仍逐条隔离失败：一条失败不影响同批其余记录。
async function broadcastRecords(
  run: CleanupRun,
  phase: CleanupPhase,
  rows: HistoryRecordEntity[],
): Promise<void> {
  for (const e of rows) {
    try {
      await broadcast(run.env, 'RemoteHistoryChanged', entityToDtoWire(e));
    } catch (err) {
      recordFailure(run.failures, phase, err);
    }
  }
}

// 硬删阶段的收尾：批量清扫这批记录的数据目录（上游 DeleteProfileData 的等价物）。
// 清扫失败只记账：漏删的目录会被孤儿阶段（全量差集）回收。
async function sweepRecordDirs(
  run: CleanupRun,
  rows: { type: ProfileType; hash: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await sweepWorkingDirs(
      run,
      'hardDelete',
      rows.map((e) => workingDirName(e.type, e.hash)),
    );
  } catch (err) {
    recordFailure(run.failures, 'hardDelete', err);
  }
}

// 1) 保留期：过期且未收藏/未置顶/未删除 → 软删（IsDeleted/Version++/LastModified=now）
function cleanRetention(run: CleanupRun, retentionMinutes: number): Promise<PhaseOutcome> {
  const cutoffMs = run.nowMs - retentionMinutes * 60_000;
  return drainBatches(run, {
    phase: 'retention',
    costPerRecord: SUBREQUESTS_PER_BROADCAST,
    queryCost: SUBREQUESTS_PER_D1_STATEMENT,
    batchedCallCost: 0,
    batchLimit: SOFT_DELETE_BATCH_LIMIT,
    fetchBatch: async (limit) => {
      const rows = await run.db.softDeleteExpiredRecords(cutoffMs, run.nowMs, limit);
      return { rows, hasMore: rows.length === limit };
    },
    applyBatch: (rows) => broadcastRecords(run, 'retention', rows),
  });
}

// 2) 条数上限：超量时软删最旧（非收藏/非置顶）（上游 SetRecordsMaxCount → MarkForDeletion）
function cleanTrim(run: CleanupRun, maxCount: number): Promise<PhaseOutcome> {
  return drainBatches(run, {
    phase: 'trim',
    costPerRecord: SUBREQUESTS_PER_BROADCAST,
    // 一批两次查询：countActiveRecords（算超量）+ trimToMaxCount
    queryCost: 2 * SUBREQUESTS_PER_D1_STATEMENT,
    batchedCallCost: 0,
    batchLimit: SOFT_DELETE_BATCH_LIMIT,
    fetchBatch: async (limit) => {
      const overage = (await run.db.countActiveRecords()) - maxCount;
      if (overage <= 0) return { rows: [], hasMore: false };
      const take = Math.min(overage, limit);
      const rows = await run.db.trimToMaxCount(take, run.nowMs);
      // 实际删到少于请求条数 ⇒ 可裁的（非收藏/非置顶）已耗尽，即使 active 仍超上限也**必须收工**：
      // 否则收藏/置顶占满配额时该阶段会永远"有更多"，每轮空转并把 truncated 永远挂在结果里。
      return { rows, hasMore: rows.length === take && overage > take };
    },
    applyBatch: (rows) => broadcastRecords(run, 'trim', rows),
  });
}

// 3) 已删除记录硬删（>30 天）+ 删数据目录（上游 RemoveOutOfDateDeletedRecords，不广播）
function cleanHardDeleted(run: CleanupRun, cutoffMs: number): Promise<PhaseOutcome> {
  return drainBatches(run, {
    phase: 'hardDelete',
    costPerRecord: 0, // 不广播（上游硬删语义也不广播）；目录并入本批的批量清扫
    queryCost: SUBREQUESTS_PER_D1_STATEMENT,
    batchedCallCost: SUBREQUESTS_PER_SWEEP_CALL,
    batchLimit: HARD_DELETE_BATCH_LIMIT,
    fetchBatch: async (limit) => {
      const rows = await run.db.hardDeleteOldDeletedRecords(cutoffMs, limit);
      return { rows, hasMore: rows.length === limit };
    },
    applyBatch: (rows) => sweepRecordDirs(run, rows),
  });
}

// 4) 孤儿对象清理：history/ 下存在对象、但 DB 无活记录引用的目录。
// 比较双方**必须同为带尾斜杠的目录名**（映射的键从 R2 key 截取得 `Text_ABC/`，
// `db.listReferencedWorkingDirs` 也返回带斜杠形式）。形式不一致会让 `active.has(dir)` 恒为 false，
// 从而把**所有**历史数据目录当成孤儿删除 —— 曾因此每小时清空一次 history/（见 F33）。
//
// 与旧实现的差别只在成本（语义不变）：复用 `sweepWorkingDirs` 的分块清扫（按实际页数记账，
// 1000 个一批删）；删不下的（预算耗尽）本轮收工，下一轮重新求差集继续 —— 不另立游标。
async function cleanOrphans(run: CleanupRun): Promise<PhaseOutcome> {
  // 至少付得起"一次活目录查询 + 一次列举（≥1 页）+ 一次批量删"
  if (run.budget.roomFor('orphans') < SUBREQUESTS_PER_D1_STATEMENT + SUBREQUESTS_PER_SWEEP_CALL + 1) {
    return { processed: 0, batches: 0, truncated: true };
  }
  const groups = await historyGroups(run);
  if (groups.size === 0) return { processed: 0, batches: 0, truncated: false };

  run.budget.spend(SUBREQUESTS_PER_D1_STATEMENT);
  const active = await run.db.listReferencedWorkingDirs();

  const orphanDirs = [...groups.keys()].filter((dir) => !active.has(dir));
  if (orphanDirs.length === 0) return { processed: 0, batches: 0, truncated: false };

  const { removedDirs, complete } = await sweepWorkingDirs(run, 'orphans', orphanDirs);
  return { processed: removedDirs, batches: 0, truncated: !complete };
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

// 关闭成因里那个「旋钮」的键名：按生效值的**实际来源**取 —— Meta 覆盖用 SETTINGS_META_KEYS 里那个键
// （界面 `PUT /ui/api/settings` 写下的正是它），env 回落用部署变量名，内置默认用它自己的常量名。
const DISABLED_KEY = {
  retention: {
    meta: SETTINGS_META_KEYS.retentionMinutes,
    env: 'HISTORY_RETENTION_MINUTES',
    default: 'DEFAULT_RETENTION_MINUTES',
  },
  trim: {
    meta: SETTINGS_META_KEYS.maxSavedHistoryCount,
    env: 'MAX_SAVED_HISTORY_COUNT',
    default: 'DEFAULT_MAX_SAVED_HISTORY_COUNT',
  },
} as const;

/**
 * 该阶段是否被**显式关闭**（生效值 = 0 ⇒ 关闭该阶段，与 parseNonNegativeInt / parseSettingValue 的语义一致）。
 * 关闭时返回写进 `reason=` 的成因串。
 *
 * ⚠️ 成因里的键名必须按**生效值的实际来源**取：生效值来自 `readRetentionSettings`（Meta 覆盖优先、
 * env 只是回落、都没有才是内置默认），所以那个 0 **通常来自界面**（`PUT /ui/api/settings` 写下的 Meta 覆盖）
 * —— 恒写 env 变量名会把维护者指向一个**不是来源**的旋钮（实测：界面把保留期填成 0 之后，日志正是
 * `reason=HISTORY_RETENTION_MINUTES=0`，而那一刻部署变量仍是 10080）。
 * 三种形态：`settings:retentionMinutes=0` / `HISTORY_RETENTION_MINUTES=0` / `DEFAULT_RETENTION_MINUTES=0`。
 * 第三种自 2026-09-22 起**可达**：保留期的内置默认就是 0（对齐上游 3.3.0「默认不限制」），
 * 于是「两处都没配」的部署每轮都会关掉 retention 阶段并如实把它归给内置默认。
 */
function disabledReason(
  phase: CleanupPhase,
  retentionMinutes: number,
  maxCount: number,
  source: Pick<RetentionSettings, 'retentionSource' | 'maxCountSource'>,
): string | null {
  if (phase === 'retention' && retentionMinutes <= 0) return `${DISABLED_KEY.retention[source.retentionSource]}=0`;
  if (phase === 'trim' && maxCount <= 0) return `${DISABLED_KEY.trim[source.maxCountSource]}=0`;
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
      sweep: null,
    };
    // 保留策略：Meta 覆盖优先、env 回落（§2.5 在线可调）。读失败按「未配置」处理并记一条失败 ——
    // 与读游标同一条纪律：诊断面出问题不能把清理整体拖停（此时回落 env/内置默认，等价于改动前的行为）。
    // settings 整份留在外层：除了算生效值，它的**来源**字段还要写进每个阶段的 `reason=`（见 disabledReason）
    let settings: RetentionSettings;
    try {
      run.budget.spend(SUBREQUESTS_PER_D1_STATEMENT);
      settings = await readRetentionSettings(run.db, env);
    } catch (err) {
      recordFailure(run.failures, 'meta', err);
      // 读 Meta 失败 ⇒ 按「没有 Meta 覆盖」处理、整份回落 env/内置默认
      // （与 readRetentionSettings 的「无覆盖」分支同源，见 settingsFromEnv）。
      settings = settingsFromEnv(env);
    }
    const retentionMinutes = settings.retentionMinutes ?? DEFAULT_RETENTION_MINUTES;
    const maxCount = settings.maxSavedHistoryCount ?? DEFAULT_MAX_SAVED_HISTORY_COUNT;
    const startedAt = new Date(run.nowMs).toISOString();

    // 上一轮的游标：读失败不阻断清理（按 0 处理并照常记账/落库）
    try {
      run.budget.spend(SUBREQUESTS_PER_D1_STATEMENT);
      const stored = await run.db.getMetaValues(META_KEYS_ALL);
      for (const phase of CLEANUP_PHASES) {
        run.cursors[phase] = parseNonNegativeInt(stored.get(CLEANUP_META_KEYS.cursors[phase]), 0);
      }
    } catch (err) {
      recordFailure(run.failures, 'meta', err);
    }

    for (const phase of CLEANUP_PHASES) {
      const phaseStartMs = Date.now();
      const off = disabledReason(phase, retentionMinutes, maxCount, settings);
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
