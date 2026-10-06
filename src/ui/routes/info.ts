// `/ui/api` 的只读信息面：Hub 票据、统计、部署信息、活动、总览、变更信号。
import { Hono } from 'hono';
import { Bindings } from '../../env';
import { stores } from '../../stores';
import { drainRequestBody } from '../../auth';
import { historySizeMB } from '../../serialization';
import { countByTypeViews, readActivity, readChangeMarker, readLastModified } from '../query';
import { HUB_PATH, issueConnectionToken } from '../../hub';
import {
  deploymentInfo,
  deploymentMeta,
  deploymentStats,
  readDeletedFlagOr400,
  readIntParam,
} from './shared';

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
