// `/ui/api` 的只读信息面：Hub 票据、统计、部署信息、活动、总览、变更信号。
import { Hono } from 'hono';
import { Bindings } from '../../env';
import { stores } from '../../stores';
import { drainRequestBody } from '../../auth';
import { historySizeMB } from '../../serialization';
import {
  UiQueryError,
  countByTypeViews,
  parseDeletedFlag,
  readActivity,
  readChangeMarker,
  readLastModified,
} from '../query';
import type { UiViewCounts } from '../query';
import { HUB_PATH, AVAILABLE_TRANSPORTS, issueConnectionToken } from '../../hub';
import {
  CLEANUP_META_KEYS,
  CLEANUP_PHASES,
  CLEANUP_AND_SETTINGS_META_KEYS,
  retentionSettingsFromMeta,
} from '../../cleanup';
import type { HistoryStatisticsDto } from '../../types';

// 清理的**可观测面**：清理任务把「本轮开始时间 / 失败信息 / 续跑游标」写进 Meta，
// `/ui/api/info` 只读展示同一批键——「静默未清理」因此可以被看见。键表（清理六键 + 保留策略两键，
// **一次查询取回**）与解析函数都由 cleanup.ts 提供，这里不再自己拼一份字面量。
// lastError 的展示上限：这是**展示侧**自己的边界（不依赖上游自觉）——产出侧 cleanup.ts 已截到
// 300 且压成单行，这里再夹一道，保证响应体永远不会带出成段的内部错误串（表名/约束/对象键）。
const CLEANUP_ERROR_MAX_CHARS = 300;

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

export function createInfoRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // POST /ui/api/hub-ticket —— 换一张短期连接票据，用于建立 WebSocket（替代 10 秒轮询）
  //
  // 为什么需要它：浏览器的 `new WebSocket(url)` **不能设置请求头**，而 Hub 的连接鉴权在 DO 内
  // （`?id=` 或 Basic 头，见 SyncClipboardHub.connectionAuthFailure）。票据由本端点签发——
  // 它走会话 Cookie 鉴权，DO 侧只校验该 token 已登记且未过期（10 分钟，仅约束「登记后多久
  // 内必须发起连接」；连上后由连接本身维持）。
  //
  // 前端两条纪律（写在 public/ui_v1/js/signalr.js 里）：① 60 秒内至少发一条消息，否则 DO 的
  // 静默清理会关掉它；② 保留轮询作为降级路径——推送链路任何一段出问题，界面都还能收敛。
  app.post('/ui/api/hub-ticket', async (c) => {
    await drainRequestBody(c.req.raw);
    try {
      const token = await issueConnectionToken(c.env);
      return Response.json({ token, path: `${HUB_PATH}?id=${token}` });
    } catch {
      // DO 打不通时如实失败（503）：前端据此继续用轮询，而不是拿一张注定连不上的票据去重试
      return Response.json({ error: 'hub_unavailable' }, { status: 503 });
    }
  });

  // GET /ui/api/statistics —— 官方统计 + 按类型计数（官方那套没有类型分布）
  //
  // 两个键是有意分开的，因为**两个消费方的口径不同**：
  //   · `byType`        —— 随 `deleted` 走：工具栏的类型计数必须与当前视图同源，否则回收站里
  //                        会写着活跃记录的数（列表说 1019、控件说 1009）。
  //   · `byTypeActive`  —— **恒为活跃口径**（与请求的 `deleted` 无关）。软删保留数据 ≤30 天，
  //                        而「存储占用」那一格的字节数来自 R2 实列
  //                        （`storage.totalHistorySize()`，已含回收站里的字节）⇒ 总数（全库口径）
  //                        与这个按类型计数（活跃口径）**口径不同**，这是**有意的**。
  //                        它当前**没有前端消费方**：统计条不再列类型明细（明细行只留
  //                        `totalCount` 的「全库 N 条」）。保留它是因为接口契约与 `test/ui.test.ts`
  //                        在钉这条分法 —— 别按"没人用"删掉。
  app.get('/ui/api/statistics', async (c) => {
    const { storage, db } = stores(c);
    const flag = readDeletedFlagOr400(new URL(c.req.url).searchParams);
    if (!flag.ok) return flag.response;
    const deleted = flag.value;
    // 四个计数走 `db.statistics()`（与协议端点 `/api/history/statistics` 同一实现）；
    // byType 来自同一次 GROUP BY。R2 列举与两条 D1 查询互不依赖 ⇒ 并发。
    const [bytes, views, counts] = await Promise.all([
      storage.totalHistorySize(),
      countByTypeViews(c.env.DB),
      db.statistics(),
    ]);
    const stats = { ...counts, totalFileSizeMB: historySizeMB(bytes) };
    // byType 随视图走（工具栏的类型计数必须与列表同源），byTypeActive 恒为活跃口径。
    // 两个 starred 计数**都进响应**（各自是全表聚合，与这次请求的视图无关），由前端按当前
    // 视图取用：统计条「已收藏」那一格与工具栏「收藏」筛选同屏，必须给出同一个数
    // —— 协议 DTO 的 `starredCount` 是**全库**口径（含着回收站里那几条），卡片用它会与筛选项对不上。
    return Response.json({
      ...stats,
      byType: deleted ? views.byDeleted : views.byActive,
      byTypeActive: views.byActive,
      starredCountActive: views.starredActive,
      starredCountDeleted: views.starredDeleted,
    });
  });

  // GET /ui/api/info —— 部署信息（把「服务器地址该填什么」直接给出来）
  app.get('/ui/api/info', async (c) => {
    return Response.json(await deploymentInfo(c.env, new URL(c.req.url).origin));
  });

  // GET /ui/api/activity —— 每天有多少条记录（概览带的趋势图 + 抽屉里的明细）
  //
  // 「一天」按**调用方给的时区**切分（`tz` = `Date.prototype.getTimezoneOffset()`，
  // UTC+8 ⇒ `-480`）。服务端只知道 UTC，而直接按 UTC 切会让 UTC+8 的用户在早上 8 点前
  // 看到的"今天"其实是昨天（详见 `src/ui/query.ts` 的 `readActivity`）。
  app.get('/ui/api/activity', async (c) => {
    const params = new URL(c.req.url).searchParams;
    const days = readIntParam(params.get('days'), 14, 1, 90);
    const tz = readIntParam(params.get('tz'), 0, -14 * 60, 14 * 60);
    if (days === null || tz === null) {
      return Response.json({ error: 'invalid_range' }, { status: 400 });
    }
    const result = await readActivity(c.env.DB, { days, tzOffsetMinutes: tz });
    return Response.json(result);
  });

  // GET /ui/api/overview —— 首屏总览（**合并端点**）
  //
  // 为什么要有它：V1 的首屏打三次请求（`history` + `statistics` + `info`），而 `statistics`
  // 内部还要跑三条查询。V2 的概览带需要的是它们**合并后的一个快照** —— 更重要的是，概览带与列表
  // 必须在**同一次往返**里对齐，否则用户会看到"数字说 1009 条、列表说 1008 条"这种两个瞬间的差异。
  //
  // 只读、无副作用。`activity` 不在这里返回：它是独立的一天粒度查询，
  // 首屏让它阻塞列表可见不值得（前端在列表落地后单独拉，见 boot.js）。
  //
  // 统计层**只算一次**：`deploymentStats()` 的结果同时喂给响应的 `stats` 与 `info`，
  // 否则单次请求要列举两遍 R2 全桶。
  app.get('/ui/api/overview', async (c) => {
    const flag = readDeletedFlagOr400(new URL(c.req.url).searchParams);
    if (!flag.ok) return flag.response;
    const deleted = flag.value;
    // 行数来自统计层那条 GROUP BY 的 `Σc`（= `COUNT(*)`），故这里只再取 `MAX(LastModified)`
    // ——单列、走 idx_h_user_modify，不再为同一个数多扫一遍全表。
    const [ds, lastModified] = await Promise.all([
      deploymentStats(c.env),
      readLastModified(c.env.DB),
    ]);
    const marker = { count: ds.views.total, lastModified };
    const info = await deploymentMeta(c.env, new URL(c.req.url).origin, ds);
    return Response.json({
      stats: ds.stats,
      // 三个计数口径不同（理由与 /ui/api/statistics 一致）：`byType` 随视图走，`byTypeActive` 恒活跃，
      // 两个 `starredCount*` 恒为「按视图各一个」（各是全表聚合，前端按当前视图取用）
      byType: deleted ? ds.views.byDeleted : ds.views.byActive,
      byTypeActive: ds.views.byActive,
      starredCountActive: ds.views.starredActive,
      starredCountDeleted: ds.views.starredDeleted,
      marker,
      info,
      serverTime: new Date().toISOString(),
    });
  });

  // GET /ui/api/poll —— 变更信号（前端据此决定要不要重拉列表）
  //
  // 顺带回传服务端时间：官方客户端在**时钟差 > 5 分钟**时会中止历史同步，
  // 那是「同步不动」最常见的根因之一，而界面此前没有任何地方能看到这个差。
  // 放在这里是因为它本来就被周期性调用——不必为此新增端点，也不必多一次请求。
  app.get('/ui/api/poll', async (c) =>
    Response.json({ ...(await readChangeMarker(c.env.DB)), serverTime: new Date().toISOString() }),
  );

  return app;
}
