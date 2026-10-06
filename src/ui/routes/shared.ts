// `/ui/api/*` 各路由模块共用的解析/查询/并发辅助。
//
// 与官方 `/api/history/*` 的关系：官方那套是**协议契约**（官方客户端在读），`/ui/api/*` 只服务本站页面。
// 两者共用同一张表、同一套行映射与 DTO 序列化，写操作也走同一个实现（historyOps.applyHistoryUpdate），
// 因此不存在「UI 改了但客户端不知道」。
import { Bindings } from '../../env';
import { stores } from '../../stores';
import { maxRequestBodyBytes, readBodyCapped } from '../../requestLimits';
import { AVAILABLE_TRANSPORTS } from '../../hub';
import { parseProfileType, historySizeMB } from '../../serialization';
import { isValidProfileHash } from '../../types';
import type { HistoryStatisticsDto, ProfileType } from '../../types';
import {
  UiQueryError,
  countByTypeViews,
  parseDeletedFlag,
} from '../query';
import type { UiViewCounts } from '../query';
import {
  CLEANUP_META_KEYS,
  CLEANUP_PHASES,
  CLEANUP_AND_SETTINGS_META_KEYS,
  retentionSettingsFromMeta,
} from '../../cleanup';

// 清理的**可观测面**：清理任务把「本轮开始时间 / 失败信息 / 续跑游标」写进 Meta，
// `/ui/api/info` 只读展示同一批键——「静默未清理」因此可以被看见。键表（清理六键 + 保留策略两键，
// **一次查询取回**）与解析函数都由 cleanup.ts 提供，这里不再自己拼一份字面量。
// lastError 的展示上限：这是**展示侧**自己的边界（不依赖上游自觉）——产出侧 cleanup.ts 已截到
// 300 且压成单行，这里再夹一道，保证响应体永远不会带出成段的内部错误串（表名/约束/对象键）。
const CLEANUP_ERROR_MAX_CHARS = 300;

// 「编辑文本」保存时的体积上限（UTF-8 字节）。1 MiB 是**编辑器的**上限而不是协议的：
// 协议侧的记录可以有 48 MiB，但把这个量级的正文塞进 `<textarea>` 只会把页面卡死
// （前端同一条判据见 `preview.js` 的 `EDIT_MAX_BYTES` —— 两处必须一致，改一处就要改另一处）。
// 超限时服务端回 400 `text_too_large`（前端在按钮上就拦下，正常走不到这里；这是纵深防御）。
export const UI_TEXT_CREATE_MAX_BYTES = 1024 * 1024;

// 批量写的有界并发（见 history-mutations.ts 里 batch-update 的注释）。
// 10 是保守值：生产实测串行 663ms/条，10 路并行把 100 条从 ~66s 压到 ~5s，同时
// D1/DO/R2 的并发压力可控；总量子请求不变（不影响 1000 上限的记账）。
export const BATCH_UPDATE_CONCURRENCY = 10;

/**
 * 取整数值的查询参数。
 *
 * 与 `parseUiHistoryQuery` 的 `parseIntParam`（它会**钳制**到范围内）不同，这里
 * **越界即非法**（返回 `null`）——因为这两个参数（`days` / `tz`）的单位是"天"与"分钟"，
 * 把一个 `days=100000` 悄悄钳成 90、或把一个离谱的 `tz=99999` 钳成 14 小时，
 * 都会让调用方拿到一份**与请求不符**的数据却看不出问题。宁可 400。
 */
export function readIntParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw.trim() === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

export interface UiDeploymentStats {
  bytes: number;
  stats: HistoryStatisticsDto;
  views: UiViewCounts;
}

/**
 * 部署信息的**统计层**：一次 R2 全桶扫描（体积）+ 两条 D1 聚合（按类型计数 + 全库四个统计计数）。
 *
 * 单独成层：这一层是 `/ui/api/overview` 与 `/ui/api/info` 共同需要的，而 `overview` 还要在它之上
 * 叠元信息。**不能**把它做成 `deploymentInfo` 的必填参数 —— 那样 `/ui/api/info` 那一路也得先自己算
 * 一遍，等于没省（`overview` 曾把这一层跑两遍：自己跑一次 + `deploymentInfo` 内部再跑一次，
 * 单次首屏 = 2×R2 全桶列举 + 2×statistics + 2×countByTypeViews）。
 * 四个计数统一走协议端点那条 `db.statistics()`：同一语义不留两份实现，代价是这条路径多一条全表聚合。
 */
export async function deploymentStats(env: Bindings): Promise<UiDeploymentStats> {
  const { storage, db } = stores({ env });
  // R2 列举与两条 D1 聚合互不依赖 ⇒ 并发（这条路径是首屏必经，别把它们串起来）。
  const [bytes, views, counts] = await Promise.all([
    storage.totalHistorySize(),
    countByTypeViews(env.DB),
    db.statistics(),
  ]);
  return { bytes, stats: { ...counts, totalFileSizeMB: historySizeMB(bytes) }, views };
}

/**
 * 部署信息的**元信息层**：清理可观测面、保留策略、版本、Hub 传输。
 *
 * 与统计层同出于一个 `deploymentInfo`（理由不只是少写一遍：两处各写一份时，
 * 「清理状态」「保留策略来源」这类字段迟早只在其中一处更新，于是概览带与部署信息对话框
 * 会显示两个不同的值）。
 */
export async function deploymentMeta(
  env: Bindings,
  origin: string,
  ds: UiDeploymentStats,
) {
  const { db } = stores({ env });
  // 清理六键 + 保留策略两键**一次取回**（此前是两次 getMetaValues，两条 D1）。
  const meta = await db.getMetaValues(CLEANUP_AND_SETTINGS_META_KEYS);
  const retention = retentionSettingsFromMeta(meta, env);
  // 清理侧：键在「从未跑过清理」时不存在，故全部容忍缺省（D1 报错与统计层同样向上抛，
  // 不在这里特殊化——诊断面整体失败比"部分字段静默为默认值"更容易被发现）。
  const lastError = meta.get(CLEANUP_META_KEYS.lastError) ?? '';
  return {
    version: env.VERSION,
    // 客户端「服务器地址」填这个（本实现把 WebDAV 兼容端点放在站点根）
    serverUrl: `${origin}/`,
    hubTransports: AVAILABLE_TRANSPORTS,
    // 保留策略：与清理任务读**同一份生效值**（同一个解析函数 retentionSettingsFromMeta：
    // Meta 覆盖优先、env 回落；值来自上面那次合并查询）——两处各读一处会让
    // 「清理按 Meta 跑、界面显示按 env」当场分叉。
    // 连**来源**一起报：界面要用它显示「此处的设置 / 部署环境变量」，而 /ui/api/settings 是另一个
    // 端点、界面并不调用它——来源只报在那边就等于永远显示「部署环境变量」。
    retention: {
      maxSavedHistoryCount: retention.maxSavedHistoryCount,
      retentionMinutes: retention.retentionMinutes,
      maxCountSource: retention.maxCountSource,
      retentionSource: retention.retentionSource,
    },
    storage: { totalBytes: ds.bytes, totalFileSizeMB: ds.stats.totalFileSizeMB },
    counts: {
      total: ds.stats.totalCount,
      active: ds.stats.activeCount,
      starred: ds.stats.starredCount,
      deleted: ds.stats.deletedCount,
      byType: ds.views.byActive,
    },
    // 清理可观测性：lastRunAt=null 说明从来没跑过；lastError=null 说明上轮无失败。
    // ⚠️ 「跑完了」的判据是 **lastCompletedAt**（轮尾写），不是 lastError 为空 —— 被平台终止的那一轮
    // 到不了轮尾，lastError 会**停在旧值**（通常是空串），只看它就会把「被终止」显示成「清理正常」。
    // （cleanup 正常时写空串，这里归一化）；游标非 0 = 该阶段本轮没跑完、下轮续跑。
    cleanup: {
      lastRunAt: meta.get(CLEANUP_META_KEYS.lastRunAt) ?? null,
      lastCompletedAt: meta.get(CLEANUP_META_KEYS.lastCompletedAt) ?? null,
      lastError: lastError === '' ? null : lastError.slice(0, CLEANUP_ERROR_MAX_CHARS),
      cursors: Object.fromEntries(
        CLEANUP_PHASES.map((phase) => [
          phase,
          Number.parseInt(meta.get(CLEANUP_META_KEYS.cursors[phase]) ?? '', 10) || 0,
        ]),
      ),
    },
  };
}

// `/ui/api/info` 的入口：统计层 + 元信息层
export async function deploymentInfo(env: Bindings, origin: string) {
  return deploymentMeta(env, origin, await deploymentStats(env));
}

/**
 * `deleted` 查询参数的统一解析：非法值 → 400（而不是 500）。
 *
 * 列表、统计、概览三个端点共用同一套映射；任何一处漏掉 try/catch，
 * `?deleted=maybe` 就会在那里变成未处理的 500。
 */
export function readDeletedFlagOr400(
  params: URLSearchParams,
): { ok: true; value: boolean } | { ok: false; response: Response } {
  try {
    return { ok: true, value: parseDeletedFlag(params) };
  } catch (err) {
    if (err instanceof UiQueryError) {
      return { ok: false, response: Response.json({ error: err.message }, { status: 400 }) };
    }
    throw err;
  }
}

export interface UiCredentials {
  username: string;
  password: string;
}

// 读取结果：`ok` = 解析出的凭据；`too_large` = 超体量上限（**与畸形体区分**，
// 否则同一个端点对超限会给出 400 而协议面给 413）。
export type ReadCredentialsResult =
  | { kind: 'ok'; credentials: UiCredentials }
  | { kind: 'too_large' }
  | { kind: 'invalid' };

export async function readCredentials(raw: Request, limit: number): Promise<ReadCredentialsResult> {
  try {
    // 与入口的 login 解析同纪律：整包读取过体量上限（login 免认证，chunked 大 body 会绕过
    // content-length 预检）
    const body = await readBodyCapped(raw, limit);
    if (body === null) return { kind: 'too_large' };
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    if (typeof parsed?.username !== 'string' || typeof parsed.password !== 'string') {
      return { kind: 'invalid' };
    }
    return { kind: 'ok', credentials: { username: parsed.username, password: parsed.password } };
  } catch {
    return { kind: 'invalid' };
  }
}

// 解析 :type/:hash 两个路径参数；不合法时返回 null（调用方据此 400/404）
export function parsePathIds(
  typeRaw: string,
  hash: string,
): { type: ProfileType; hash: string } | null {
  const type = parseProfileType(typeRaw);
  if (type === undefined) return null;
  if (!hash || !isValidProfileHash(hash)) return null;
  return { type, hash };
}

// ===== Range（只给 `/ui/api/history/:type/:hash/data`）=====
// 为什么只在这里加：协议侧 `/file/{name}`（src/routes/webdav.ts）与 `/api/history/{id}/data`
// （src/routes/history.ts）忽略 `Range` 是**对齐上游的有意行为**（上游 `File(bytes, …)` 的
// `EnableRangeProcessing` 默认 false，test/fix-regressions.test.ts 有断言守着），
// 给那边加 206 会变成新的有意偏离。这里是本站自己的面，加 206 后浏览器/播放器能按需取片段。
export type RangeSpec = { offset: number; length?: number } | { suffix: number };

// 解析 `Range: bytes=a-b` / `bytes=a-` / `bytes=-n`；无法识别一律返回 null，调用方回退 200 全量。
// 有意不做的两件事：
//   ① 多段（`bytes=a-b,c-d`）：那要 multipart/byteranges 响应体，收益低（浏览器极少发多段），
//      正则整体不匹配即落到「回退全量」；
//   ② `If-Range` 条件：本端点不外发 ETag / Last-Modified，客户端没有可用来发 If-Range 的校验器，
//      真收到也只当普通 Range 处理（不引入校验器状态）。
export function parseRangeHeader(raw: string | undefined): RangeSpec | null {
  if (!raw) return null;
  // 单位名大小写不敏感（RFC 9110 §14.1）；只认单段
  const match = /^\s*bytes\s*=\s*(\d*)-(\d*)\s*$/i.exec(raw);
  if (!match) return null;
  const startRaw = match[1]!;
  const endRaw = match[2]!;
  // `bytes=-n`：末尾 n 字节。n=0 语法合法但不可满足（RFC 9110 §14.1.2），留给 resolveRange 判 416
  if (startRaw === '') return endRaw === '' ? null : { suffix: Number(endRaw) };
  if (endRaw === '') return { offset: Number(startRaw) };
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (end < start) return null; // 畸形：last-byte-pos 小于 first-byte-pos
  return { offset: start, length: end - start + 1 };
}

// 按对象实际大小把区间落成可返回的 [start, end]；不可满足（起点越界、末尾 0 字节）返回 null。
// 调用方保证 size > 0：零长度对象在端点里按「忽略 Range」处理（见那里的注释）。
// 超长数字串解析成 Infinity 时走「起点越界」这一支，不会把非法值透给 R2。
export function resolveRange(spec: RangeSpec, size: number): { start: number; end: number } | null {
  if ('suffix' in spec) {
    if (spec.suffix <= 0) return null;
    return { start: Math.max(size - spec.suffix, 0), end: size - 1 };
  }
  if (spec.offset >= size) return null;
  const last =
    spec.length === undefined ? size - 1 : Math.min(spec.offset + spec.length - 1, size - 1);
  return { start: spec.offset, end: last };
}

// 有界并发执行：同时最多 `limit` 个 `fn` 在跑，保序（results 按下标填）。
// 批量循环里每条相互独立，串行等的是网络往返；并行是纯粹地摊销延迟。
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      // index 由 cursor 递增保证 < items.length（取号与越界判定在同一同步段，无竞争）；
      // `noUncheckedIndexedAccess` 收窄不掉这个不变量，显式断言。
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
