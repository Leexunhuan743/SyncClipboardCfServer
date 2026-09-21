// UI 的 HTTP 面：`/ui/api/*`。
//
// 与官方 `/api/history/*` 的关系：官方那套是**协议契约**（官方客户端在读），
// 这里这套只服务本站页面，可以自由演进。两者共用同一张表、同一套行映射与 DTO 序列化，
// 写操作也走同一个实现（historyOps.applyHistoryUpdate），因此不存在「UI 改了但客户端不知道」。
//
// 命名空间选 `/ui/api/*` 而不是 `/api/*`：后者已被协议占用，混在一起会让
// 「哪些是客户端依赖的」变得无法机械判定。
import { Hono } from 'hono';
import { Bindings } from '../env';
import { basename } from '../db';
import { stores } from '../stores';
import { isAuthConfigured, verifyCredentials, drainRequestBody } from '../auth';
import { issueSession, clearSession } from './session';
import { uiAuthMiddleware, authenticateUi } from './guard';
import { parseProfileType, parseHistoryRecordUpdateDto, historySizeMB } from '../serialization';
import { applyHistoryUpdate, clearAllHistory } from '../historyOps';
import {
  UiQueryError,
  listUiHistory,
  countByTypeViews,
  readChangeMarker,
  readActivity,
  readBatchMeta,
  BATCH_META_MAX_ITEMS,
  parseDeletedFlag,
  parseUiHistoryQuery,
  toUiItem,
} from './query';
import type { BatchMetaItem, UiViewCounts } from './query';
import { fileHeaders } from '../contentTypes';
import { AVAILABLE_TRANSPORTS, HUB_PATH, issueConnectionToken } from '../hub';
import { notFoundPage } from './notFound';
import { isValidProfileHash, HistoryRecordUpdateDto } from '../types';
import type { HistoryStatisticsDto } from '../types';
import { CLEANUP_META_KEYS, CLEANUP_PHASES, readRetentionSettings } from '../cleanup';
import { createUiMaintenanceRoutes } from './maintenance';

// 清理的**可观测面**（F11）：清理任务把「本轮开始时间 / 失败信息 / 续跑游标」写进 Meta，
// `/ui/api/info` 只读展示同一批键——「静默未清理」因此可以被看见。
// 键名取自 cleanup.ts 的契约常量，避免两处各写一份字面量、改一处忘一处。
const CLEANUP_META_KEY_LIST: string[] = [
  CLEANUP_META_KEYS.lastRunAt,
  CLEANUP_META_KEYS.lastError,
  ...CLEANUP_PHASES.map((phase) => CLEANUP_META_KEYS.cursors[phase]),
];
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
function readIntParam(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw.trim() === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * 部署信息的**统计层**：一次 R2 全桶扫描（体积）+ 两条 D1 聚合（官方统计、按类型计数）。
 *
 * 为什么单独成层（审计 O-01）：这一层是 `/ui/api/overview` 与 `/ui/api/info` 共同需要的，
 * 而 `overview` 还要在它之上叠元信息。**不能**把它做成 `deploymentInfo` 的必填参数 ——
 * 那样 `/ui/api/info` 那一路也得先自己算一遍，等于没省。
 * 原先 `overview` 是把这一层跑两遍（自己跑一次 + `deploymentInfo` 内部再跑一次），
 * 于是单次首屏 = 2×R2 全桶列举 + 2×statistics + 2×countByTypeViews。
 */
async function deploymentStats(env: Bindings): Promise<{
  bytes: number;
  stats: HistoryStatisticsDto;
  views: UiViewCounts;
}> {
  const { db, storage } = stores({ env });
  const bytes = await storage.totalHistorySize();
  const [stats, views] = await Promise.all([
    db.statistics(historySizeMB(bytes)),
    countByTypeViews(env.DB),
  ]);
  return { bytes, stats, views };
}

/**
 * 部署信息的**元信息层**：清理可观测面、保留策略、版本、Hub 传输。
 *
 * 与统计层同出于一个 `deploymentInfo`（理由不只是少写一遍：两处各写一份时，
 * 「清理状态」「保留策略来源」这类字段迟早只在其中一处更新，于是概览带与部署信息对话框
 * 会显示两个不同的值）。
 */
async function deploymentMeta(
  env: Bindings,
  origin: string,
  ds: Awaited<ReturnType<typeof deploymentStats>>,
) {
  const { db } = stores({ env });
  const meta = await db.getMetaValues(CLEANUP_META_KEY_LIST);
  const retention = await readRetentionSettings(db, env);
  // 清理侧：键在「从未跑过清理」时不存在，故全部容忍缺省（D1 报错与统计层同样向上抛，
  // 不在这里特殊化——诊断面整体失败比"部分字段静默为默认值"更容易被发现）。
  const lastError = meta.get(CLEANUP_META_KEYS.lastError) ?? '';
  return {
    version: env.VERSION,
    // 客户端「服务器地址」填这个（本实现把 WebDAV 兼容端点放在站点根）
    serverUrl: `${origin}/`,
    hubTransports: AVAILABLE_TRANSPORTS,
    // 保留策略：与清理任务读**同一份生效值**（readRetentionSettings：Meta 覆盖优先、env 回落）——
    // 此前这里直接读 env，于是「清理按 Meta 跑、界面显示按 env」会当场分叉（后端能力评估 §2.5）。
    // 连**来源**一起报：界面要用它显示「此处的设置 / 部署环境变量」，而 /ui/api/settings 是另一个
    // 端点、界面并不调用它——来源只报在那边就等于永远显示「部署环境变量」（复核发现的接线缺口）。
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
    // 清理可观测性（F11）：lastRunAt=null 说明从来没跑过；lastError=null 说明上轮无失败
    // （cleanup 正常时写空串，这里归一化）；游标非 0 = 该阶段本轮没跑完、下轮续跑。
    cleanup: {
      lastRunAt: meta.get(CLEANUP_META_KEYS.lastRunAt) ?? null,
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
async function deploymentInfo(env: Bindings, origin: string) {
  return deploymentMeta(env, origin, await deploymentStats(env));
}

/**
 * `deleted` 查询参数的统一解析：非法值 → 400（而不是 500）。
 *
 * 列表、统计、概览三个端点共用同一套映射；任何一处漏掉 try/catch，
 * `?deleted=maybe` 就会在那里变成未处理的 500（审计 §11 #14）。
 */
function readDeletedFlagOr400(
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

interface UiCredentials {
  username: string;
  password: string;
}

async function readCredentials(req: { json(): Promise<unknown> }): Promise<UiCredentials | null> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') return null;
    return { username: body.username, password: body.password };
  } catch {
    return null;
  }
}

// 解析 :type/:hash 两个路径参数；不合法时返回 null（调用方据此 400/404）
function parsePathIds(
  typeRaw: string,
  hash: string,
): { type: ReturnType<typeof parseProfileType>; hash: string } | null {
  const type = parseProfileType(typeRaw);
  if (type === undefined) return null;
  if (!hash || !isValidProfileHash(hash)) return null;
  return { type, hash };
}

// ===== Range（只给下面那个数据端点，见 docs/backend-gaps.md §2.3）=====
// 为什么只在这里加：协议侧 `/file/{name}`（src/routes/webdav.ts）与 `/api/history/{id}/data`
// （src/routes/history.ts）忽略 `Range` 是**对齐上游的有意行为**（上游 `File(bytes, …)` 的
// `EnableRangeProcessing` 默认 false，F29b 记录在案，test/fix-regressions.test.ts 有断言守着），
// 给那边加 206 会变成新的有意偏离。这里是本站自己的面，加 206 后浏览器/播放器能按需取片段。
type RangeSpec = { offset: number; length?: number } | { suffix: number };

// 解析 `Range: bytes=a-b` / `bytes=a-` / `bytes=-n`；无法识别一律返回 null，调用方回退 200 全量。
// 有意不做的两件事：
//   ① 多段（`bytes=a-b,c-d`）：那要 multipart/byteranges 响应体，收益低（浏览器极少发多段），
//      正则整体不匹配即落到「回退全量」；
//   ② `If-Range` 条件：本端点不外发 ETag / Last-Modified，客户端没有可用来发 If-Range 的校验器，
//      真收到也只当普通 Range 处理（不引入校验器状态）。
function parseRangeHeader(raw: string | undefined): RangeSpec | null {
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
function resolveRange(spec: RangeSpec, size: number): { start: number; end: number } | null {
  if ('suffix' in spec) {
    if (spec.suffix <= 0) return null;
    return { start: Math.max(size - spec.suffix, 0), end: size - 1 };
  }
  if (spec.offset >= size) return null;
  const last = spec.length === undefined ? size - 1 : Math.min(spec.offset + spec.length - 1, size - 1);
  return { start: spec.offset, end: last };
}

export function createUiRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // 缓存策略（后端能力评估 §3.2）：`/ui/api/*` 的 JSON 响应一律 `no-store`。
  // 列表/统计/变更信号都是「随时会变」的私有数据，被浏览器缓存住只会让界面显示陈旧内容
  // （返回键回退时尤其明显）。判据是「响应尚未自带 cache-control 才补」而不是路径放行名单：
  // 数据端点自带 `private, max-age=60`（预览/缩略图复用），自动落在例外里；
  // 将来新增自带缓存语义的端点也不需要改这里。
  app.use('/ui/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  });

  // ===== 公开端点 =====

  // POST /ui/api/login —— 表单登录，成功签发会话 Cookie
  app.post('/ui/api/login', async (c) => {
    if (!isAuthConfigured(c.env)) {
      // 与守卫的失败路径同理：响应先于入站体发出会让本 isolate 的后续请求 503
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'server_not_configured' }, { status: 500 });
    }
    const credentials = await readCredentials(c.req);
    if (!credentials) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (!verifyCredentials(c.env, credentials.username, credentials.password)) {
      // 不区分「用户名错」与「密码错」
      return Response.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    return Response.json(
      { authenticated: true, username: credentials.username },
      { headers: { 'set-cookie': await issueSession(c.env, c.req.raw, credentials.username) } },
    );
  });

  // POST /ui/api/logout —— 清 Cookie（无需鉴权：清一个自己浏览器上的 Cookie 不构成越权）。
  // 仍然要先排空请求体：这是公开端点，任何人都能带 body 打过来，
  // 而「响应先于入站体发出」会让本 isolate 的后续请求 503。
  app.post('/ui/api/logout', async (c) => {
    await drainRequestBody(c.req.raw);
    return Response.json({ authenticated: false }, { headers: { 'set-cookie': clearSession(c.req.raw) } });
  });

  // GET /ui/api/session —— 前端用它决定「进列表页还是登录页」。
  // 未登录返回 200 + authenticated:false（不是 401）：这是**探测**而非受保护资源，
  // 用 401 会让前端把正常的未登录状态当成错误处理。
  // 它同时是唯一**未认证可达**的带响应端点，故同样先排空请求体：
  // 任何人发一个带 body 的 GET 就能命中「响应先于入站体发出 → 本 isolate 后续请求 503」。
  // （无 body 时 drainRequestBody 立即返回，零成本。）
  app.get('/ui/api/session', async (c) => {
    await drainRequestBody(c.req.raw);
    const session = await authenticateUi(c.env, c.req.raw);
    return Response.json({
      authenticated: session !== null,
      username: session?.username ?? null,
      version: c.env.VERSION,
    });
  });

  // ===== 受保护端点（会话 Cookie 或 Basic）=====
  const guarded = new Hono<{ Bindings: Bindings }>({ strict: false });
  // 作用域必须收窄到 /ui/api/*：写成 '*' 会匹配到 UI 命名空间下的**所有**路径
  // （中间件先于更晚注册的兜底路由命中），于是未认证访问 `/ui/不存在` 会得到 401 JSON
  // 而不是 404 页——实测发现。
  // ⚠️ 地名按**当时**写：那是 2026-09-19 改名之前的实测（当时 V2 挂在 `/ui/`，
  // `git show 380b5da:src/ui/routes.ts` 可核）。改成 `/ui_v2/不存在` 会变成一件**从未发生过**
  // 的事，而今天那条路径也到不了这里 —— 入口 `src/index.ts` 的 isUiAsset 分支已把它处理掉。
  // 收窄后守卫只管 API，页面本身是公开的（与登录页一致）。
  guarded.use('/ui/api/*', uiAuthMiddleware());

  // GET /ui/api/history —— 列表（筛选/搜索/排序/分页）
  guarded.get('/ui/api/history', async (c) => {
    let query;
    try {
      query = parseUiHistoryQuery(new URL(c.req.url).searchParams);
    } catch (err) {
      if (err instanceof UiQueryError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
    return Response.json(await listUiHistory(c.env.DB, query));
  });

  // GET /ui/api/history/:type/:hash —— 单条元数据
  guarded.get('/ui/api/history/:type/:hash', async (c) => {
    const ids = parsePathIds(c.req.param('type'), c.req.param('hash'));
    if (!ids) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
    }
    const record = await stores(c).db.getByTypeAndHash(ids.type!, ids.hash);
    if (!record) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(toUiItem(record));
  });

  // GET /ui/api/history/:type/:hash/data —— 数据文件（图片预览 / 文件下载）
  guarded.get('/ui/api/history/:type/:hash/data', async (c) => {
    const ids = parsePathIds(c.req.param('type'), c.req.param('hash'));
    if (!ids) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
    }
    const { db, storage } = stores(c);
    const record = await db.getByTypeAndHash(ids.type!, ids.hash);
    if (!record || record.transferDataFile === '') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const fileName = basename(record.transferDataFile);
    // 带合法 Range 时先取元数据（size）：区间是否可满足必须自己判定（理由见 storage.headHistory 注释）。
    // 成本：带 Range 的请求 = 1 次 R2 head + 1 次 R2 区间读（无 Range 仍是 1 次 get），相对
    // src/cleanup.ts 的 SUBREQUEST_BUDGET(800) 可忽略；R2 也只读取命中的那段字节。
    const requested = parseRangeHeader(c.req.header('range'));
    const meta = requested ? await storage.headHistory(record.type, record.hash, fileName) : null;
    // 对象不存在时 size 取 0：下面整段都不会生效，最终由 get 的 null 判定回到 404 data_missing。
    const size = meta?.size ?? 0;
    // 零长度对象按 200 全量处理：RFC 9110 §14.2 允许服务端「对没有内容的表示忽略 Range」——
    // 那种表示按 §14.1.2 只剩「非零后缀区间」一种可满足形态，无论 206 还是 416 都要拼出退化的
    // content-range，不如直接忽略（也避免把零长度区间交给 R2）。
    const slice = requested && size > 0 ? resolveRange(requested, size) : null;
    if (requested && size > 0 && !slice) {
      // 不可满足：不回对象体，只给出总长度（RFC 9110 §14.4 的 `bytes */size`）。
      // 这里**有意不设** cache-control，落到 `/ui/api/*` 中间件的 `no-store`：区间不可满足是
      // 「此刻这个对象的结论」，按数据端点的 60 s 私有缓存留住它，会让客户端在数据变大后仍拿旧结论。
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
      });
    }
    const object = await storage.getHistory(
      record.type,
      record.hash,
      fileName,
      slice ? { offset: slice.start, length: slice.end - slice.start + 1 } : undefined,
    );
    // 记录存在但 R2 对象没了 —— 必须与「记录不存在」区分开：
    // `hasData` 是元数据推导（filePaths.length>0 || transferDataFile!==''），不代表对象真的在。
    // 线上就有这种记录（数据被已修复的孤儿清理事故误删）。前端据此渲染「数据不可用」而不是裂图。
    // Range 判定放在这条之前不会削弱它：head 拿不到对象时 slice 为 null，走的仍是原来的全量 get，
    // 由下面的 null 判定返回同一个 404 data_missing。
    if (!object) return Response.json({ error: 'data_missing' }, { status: 404 });

    const headers = fileHeaders(fileName, object.size);
    // 预览要内联、下载要附件。可渲染类型（html/svg）在 fileHeaders 里已被强制降级为附件，
    // 这里只在**非可渲染**类型上覆盖 disposition，不给那类加固开后门。
    if (!headers.has('content-disposition')) {
      const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
      headers.set(
        'content-disposition',
        `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
    }
    headers.set('cache-control', 'private, max-age=60');
    // 206 与 200 共用上面这条缓存策略：`private` 表示只有浏览器本地缓存（本 Worker 既不写边缘缓存、
    // 也不做 Range 分片缓存），因此加 Range 不会削弱预览/缩略图的复用，只是浏览器按 URL 分开存缓存条目。
    headers.set('accept-ranges', 'bytes');
    if (!slice) return new Response(object.body, { headers });
    // 206：fileHeaders 已按整个对象设过 content-length，这里换成切片长度
    headers.set('content-length', String(slice.end - slice.start + 1));
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  });

  // PATCH /ui/api/history/:type/:hash —— 收藏 / 置顶 / 删除
  guarded.patch('/ui/api/history/:type/:hash', async (c) => {
    const ids = parsePathIds(c.req.param('type'), c.req.param('hash'));
    if (!ids) {
      // 这条路径**带 body**（前端发的就是 JSON）：不排空就返回 400 会触发运行时错误
      // 并让本 isolate 的后续请求 503（与守卫、login、logout 同一处理）
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
    }

    let parsed: HistoryRecordUpdateDto;
    try {
      parsed = parseHistoryRecordUpdateDto(await c.req.text());
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const fields: HistoryRecordUpdateDto = {
      starred: parsed.starred,
      pinned: parsed.pinned,
      isDelete: parsed.isDelete,
    };
    if (fields.starred == null && fields.pinned == null && fields.isDelete == null) {
      return Response.json({ error: 'no_supported_field' }, { status: 400 });
    }

    // 先把版本/时间戳推进到必然通过 shouldUpdate 的值（见函数注释），再走官方同一条写路径
    const { db } = stores(c);
    const existing = await db.getByTypeAndHash(ids.type!, ids.hash);
    if (!existing) return Response.json({ error: 'not_found' }, { status: 404 });
    const result = await applyHistoryUpdate(c.env, ids.type!, ids.hash, {
      ...fields,
      version: existing.version + 1,
      lastModified: new Date(Math.max(Date.now(), existing.lastModified + 1)).toISOString(),
    });
    if (result.kind === 'notFound') return Response.json({ error: 'not_found' }, { status: 404 });
    if (result.kind === 'conflict') return Response.json({ error: 'conflict' }, { status: 409 });
    return Response.json(toUiItem(result.entity));
  });

  // POST /ui/api/history/batch-update —— 批量写（收藏 / 置顶 / 删除 / 恢复）
  //
  // 逐条走 `applyHistoryUpdate`（与单条 PATCH、官方 PATCH **同一条写路径**）：各自广播、
  // 各自做 shouldUpdate 判定、删除时各自清 R2 数据目录。因此这里不做任何「批量捷径」——
  // 捷径会让「界面改的」与「客户端改的」逐渐分叉。
  //
  // 成本（子请求记账）：一条记录 ≈ 1 读 + 1 写 + 1 广播（删除时再 +2 的 R2 目录清理），
  // 100 条封顶 ≈ 500 次，留一倍余量（200 条正好顶到单次调用 1000 次的内部子请求上限、零余量）。
  // 超出的部分由调用方分片（js/api.js 的 batchUpdate），不是拒绝服务。
  guarded.post('/ui/api/history/batch-update', async (c) => {
    // 只接受 application/json（审计残余 G3 的第二条）：跨站**表单**（`enctype=text/plain` 或
    // `multipart/form-data`）能直接发出 POST 且不经过 CORS 预检，而 JSON 必须由脚本构造
    // （那类请求会被来源校验挡下）。它与 F4 的来源校验是纵深的两层，且不改变本页自身的行为——
    // `js/api.js` 的 `request()` 对所有带 body 的调用恒带 `content-type: application/json`。
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const { items, update } = (body ?? {}) as { items?: unknown; update?: unknown };
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items_required' }, { status: 400 });
    }
    // 上限 100 而不是 200：每条记录 ≈5 次子请求（1 读 + 1 写 + 1 次 DO 广播，删除再 +2 次 R2
    // 目录清理），200 条正好等于单次调用的 1000 次内部子请求上限、**零余量** —— 任一条走到冲突回读
    // 或目录多一页 list 就会中途超限。100 条 = 约 500 次，留一倍余量。
    // 调用方（js/api.js 的 batchUpdate）按 100 分片串行发，选 200 条也能一次做完。
    if (items.length > 100) {
      return Response.json({ error: 'too_many_items' }, { status: 400 });
    }
    // 字段白名单与单条 PATCH 一致：只认 starred / pinned / isDelete，且必须是布尔。
    // 非布尔的静默忽略会让「批量收藏」在某个拼错的字段名下变成一次静默成功的空操作。
    const raw = (update ?? {}) as Record<string, unknown>;
    const fields: { starred?: boolean; pinned?: boolean; isDelete?: boolean } = {};
    for (const key of ['starred', 'pinned', 'isDelete'] as const) {
      if (raw[key] === undefined || raw[key] === null) continue;
      if (typeof raw[key] !== 'boolean') {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      fields[key] = raw[key] as boolean;
    }
    if (Object.keys(fields).length === 0) {
      return Response.json({ error: 'no_supported_field' }, { status: 400 });
    }

    const { db } = stores(c);
    let updated = 0;
    const failed: string[] = [];
    for (const rawItem of items) {
      const entry = rawItem as { type?: unknown; hash?: unknown };
      const ids =
        typeof entry?.type === 'string' && typeof entry?.hash === 'string'
          ? parsePathIds(entry.type, entry.hash)
          : null;
      if (!ids) {
        failed.push('invalid');
        continue;
      }
      const existing = await db.getByTypeAndHash(ids.type!, ids.hash);
      if (!existing) {
        failed.push(`${entry.type}-${entry.hash}`);
        continue;
      }
      const result = await applyHistoryUpdate(c.env, ids.type!, ids.hash, {
        ...fields,
        version: existing.version + 1,
        lastModified: new Date(Math.max(Date.now(), existing.lastModified + 1)).toISOString(),
      });
      if (result.kind === 'updated') updated++;
      else failed.push(`${entry.type}-${entry.hash}`);
    }
    return Response.json({ updated, failed: failed.length });
  });

  // POST /ui/api/history/clear —— 清空历史：`scope=trash` 只清回收站，`scope=all` 清全部。
  //
  // 与协议端点 `DELETE /api/history/clear` 同语义，但**不逐条广播**（有意如此，三条理由）：
  //   ① 上游的广播触发点清单里没有 clear（docs/protocol.md §6），逐条补广播会成为新的有意偏离；
  //   ② 1000 条记录逐条广播 = 1000 次 DO 子请求，超过单次调用 1000 次子请求的上限 —— 饱和时必然半途失败；
  //   ③ 本站的其它标签页靠 `/ui/api/poll` 的变更信号收敛（计数变化必然触发），本页自己做完即刷新。
  guarded.post('/ui/api/history/clear', async (c) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let scope: unknown;
    try {
      scope = ((await c.req.json()) as { scope?: unknown })?.scope;
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (scope !== 'trash' && scope !== 'all') {
      return Response.json({ error: 'invalid_scope' }, { status: 400 });
    }
    const { db } = stores(c);
    if (scope === 'trash') {
      // 回收站记录的 R2 目录在软删时就已删除，故只需删行；真残留由清理任务的孤儿阶段兜底。
      // 只取计数、不 RETURNING 整批行：1318 条回收站记录里带 FilePaths 的全会进 isolate 内存，
      // 而这些行唯一的用途是个数字（接口的调用方也不读它）。
      return Response.json({ scope, deleted: await db.purgeDeletedRecords() });
    }
    // 清全部：与协议端点共用同一份实现（含成本与窄竞态的说明）
    return Response.json({ scope, deleted: await clearAllHistory(c.env) });
  });

  // POST /ui/api/hub-ticket —— 换一张短期连接票据，用于建立 WebSocket（替代 10 秒轮询）
  //
  // 为什么需要它：浏览器的 `new WebSocket(url)` **不能设置请求头**，而 Hub 的连接鉴权在 DO 内
  // （`?id=` 或 Basic 头，见 SyncClipboardHub.connectionAuthFailure）。票据由本端点签发——
  // 它走会话 Cookie 鉴权，DO 侧只校验该 token 已登记且未过期（10 分钟，仅约束「登记后多久
  // 内必须发起连接」；连上后由连接本身维持）。
  //
  // 前端两条纪律（写在 public/ui_v1/js/signalr.js 里）：① 60 秒内至少发一条消息，否则 DO 的
  // 静默清理会关掉它；② 保留轮询作为降级路径——推送链路任何一段出问题，界面都还能收敛。
  guarded.post('/ui/api/hub-ticket', async (c) => {
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
  //   · `byTypeActive`  —— **恒为活跃口径**：统计条「存储占用」的明细用它。已删记录的 R2 数据文件
  //                        在软删时就已删除，把那行换成已删计数会与"存储占用"这个标题对不上。
  guarded.get('/ui/api/statistics', async (c) => {
    const { db, storage } = stores(c);
    const flag = readDeletedFlagOr400(new URL(c.req.url).searchParams);
    if (!flag.ok) return flag.response;
    const deleted = flag.value;
    const bytes = await storage.totalHistorySize();
    const [stats, views] = await Promise.all([
      db.statistics(historySizeMB(bytes)),
      countByTypeViews(c.env.DB),
    ]);
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
  guarded.get('/ui/api/info', async (c) => {
    return Response.json(await deploymentInfo(c.env, new URL(c.req.url).origin));
  });

  // GET /ui/api/activity —— 每天有多少条记录（概览带的趋势图 + 抽屉里的明细）
  //
  // 「一天」按**调用方给的时区**切分（`tz` = `Date.prototype.getTimezoneOffset()`，
  // UTC+8 ⇒ `-480`）。服务端只知道 UTC，而直接按 UTC 切会让 UTC+8 的用户在早上 8 点前
  // 看到的"今天"其实是昨天（详见 `src/ui/query.ts` 的 `readActivity`）。
  guarded.get('/ui/api/activity', async (c) => {
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
  // 内部还要跑三条查询（`docs/backend-gaps.md` §3.1）。V2 的概览带需要的是它们**合并后的
  // 一个快照** —— 更重要的是，概览带与列表必须在**同一次往返**里对齐，
  // 否则用户会看到"数字说 1009 条、列表说 1008 条"这种两个瞬间的差异。
  //
  // 只读、无副作用。`activity` 不在这里返回：它是独立的一天粒度查询，
  // 首屏让它阻塞列表可见不值得（前端在列表落地后单独拉，见 boot.js）。
  //
  // 统计层**只算一次**（O-01）：`deploymentStats()` 的结果同时喂给响应的 `stats` 与 `info`。
  // 此前这里先自己跑一遍统计、再由 `deploymentInfo` 内部跑第二遍，单次请求要列举两遍 R2 全桶。
  guarded.get('/ui/api/overview', async (c) => {
    const flag = readDeletedFlagOr400(new URL(c.req.url).searchParams);
    if (!flag.ok) return flag.response;
    const deleted = flag.value;
    const [ds, marker] = await Promise.all([
      deploymentStats(c.env),
      readChangeMarker(c.env.DB),
    ]);
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
  // 顺带回传服务端时间：官方客户端在**时钟差 > 5 分钟**时会中止历史同步（docs/protocol.md），
  // 那是「同步不动」最常见的根因之一，而界面此前没有任何地方能看到这个差。
  // 放在这里是因为它本来就被周期性调用——不必为此新增端点，也不必多一次请求。
  guarded.get('/ui/api/poll', async (c) =>
    Response.json({ ...(await readChangeMarker(c.env.DB)), serverTime: new Date().toISOString() }),
  );

  // POST /ui/api/history/batch-meta —— 按 (type,hash) 批量取记录（含**完整正文**）
  //
  // 用途：列表里的正文被截断到 500 字符，「选中多条 → 一起复制/下载」需要全文，
  // 而逐条走单条端点是 O(N) 次请求（`docs/backend-gaps.md` §2.8 记的口径）。
  guarded.post('/ui/api/history/batch-meta', async (c) => {
    // 只接受 application/json：与 batch-update / clear 同一条理由 ——
    // 跨站**表单**能直接发出 POST 且不经过 CORS 预检，而 JSON 必须由脚本构造（那类请求被来源校验挡下）。
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const raw = (body ?? {}) as { items?: unknown };
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
      return Response.json({ error: 'items_required' }, { status: 400 });
    }
    if (raw.items.length > BATCH_META_MAX_ITEMS) {
      return Response.json({ error: 'too_many_items' }, { status: 400 });
    }

    const items: BatchMetaItem[] = [];
    for (const entry of raw.items) {
      const item = (entry ?? {}) as { type?: unknown; hash?: unknown };
      const type = typeof item.type === 'string' ? parseProfileType(item.type) : undefined;
      if (type === undefined || typeof item.hash !== 'string' || item.hash === '') {
        return Response.json({ error: 'invalid_item' }, { status: 400 });
      }
      items.push({ type, hash: item.hash });
    }

    const entities = await readBatchMeta(c.env.DB, items);
    // 用 `toUiItem`（与列表同一份映射）而不是 `entityToDto`：调用方拿到的东西必须与
    // 列表项**同形**，否则前端要维护两条归一化路径。
    return Response.json({ items: entities.map(toUiItem) });
  });

  app.route('/', guarded);

  // 后台维护端点（完整性自检 / 保留策略）：必须在 `app.route('/', guarded)` **之后**注册，
  // 否则 `/ui/api/*` 的守卫中间件排在它们后面，鉴权静默失效（见 src/ui/maintenance.ts 头部说明）。
  app.route('/', createUiMaintenanceRoutes());

  // `/ui/*` 的兜底 404（只覆盖 UI 命名空间；协议路径的 404 语义不动）。
  // Hono 的路由器让更具体的路由优先，故这一条只在没有其它匹配时命中。
  // API 命名空间返回 JSON（调用方是代码），页面命名空间返回 404 页（调用方是人）。
  //
  // ⚠️ 后两条（页面 404 与 `/ui` 跳转）**今天都到不了**：入口 `src/index.ts` 已按 `UI_ENABLED`
  // 在三个挂载点上决定"404"或"转静态资源"，界面路径根本不会进到本文件。留着是因为它们定义的是
  // "界面命名空间的兜底"这件事本身，不依赖入口那一段的写法（改名／挪动入口顺序时它们是最后一道网）。
  app.all('/ui/api/*', (c) => Response.json({ error: 'not_found' }, { status: 404 }));
  app.all('/ui/*', (c) => notFoundPage(c.env));
  app.get('/ui', (c) => c.redirect('/ui/', 302));

  return app;
}
