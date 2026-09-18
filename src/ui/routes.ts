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
import { HistoryDb, basename } from '../db';
import { R2Storage } from '../storage';
import { isAuthConfigured, verifyCredentials, drainRequestBody } from '../auth';
import { issueSession, clearSession } from './session';
import { uiAuthMiddleware, authenticateUi } from './guard';
import { parseProfileType, parseHistoryRecordUpdateDto, historySizeMB } from '../serialization';
import { applyHistoryUpdate } from '../historyOps';
import {
  UiQueryError,
  listUiHistory,
  countByType,
  readChangeMarker,
  parseUiHistoryQuery,
  toUiItem,
} from './query';
import { fileHeaders } from '../contentTypes';
import { AVAILABLE_TRANSPORTS } from '../hub';
import { notFoundPage } from './notFound';
import { isValidProfileHash, HistoryRecordUpdateDto } from '../types';
import { CLEANUP_META_KEYS, CLEANUP_PHASES } from '../cleanup';

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

export function createUiRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  const stores = (c: { env: Bindings }) => ({
    db: new HistoryDb(c.env.DB),
    storage: new R2Storage(c.env.R2),
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
  // （中间件先于更晚注册的兜底路由命中），于是未认证访问 /ui/不存在 会得到 401 JSON
  // 而不是 404 页——实测发现。收窄后守卫只管 API，页面本身是公开的（与登录页一致）。
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
    const object = await storage.getHistory(record.type, record.hash, fileName);
    // 记录存在但 R2 对象没了 —— 必须与「记录不存在」区分开：
    // `hasData` 是元数据推导（filePaths.length>0 || transferDataFile!==''），不代表对象真的在。
    // 线上就有这种记录（数据被已修复的孤儿清理事故误删）。前端据此渲染「数据不可用」而不是裂图。
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
    return new Response(object.body, { headers });
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

  // POST /ui/api/history/batch-delete —— 批量删除（逐条走同一条写路径：各自广播、各自清数据目录）
  guarded.post('/ui/api/history/batch-delete', async (c) => {
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
    const items = (body as { items?: unknown })?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items_required' }, { status: 400 });
    }
    if (items.length > 200) {
      return Response.json({ error: 'too_many_items' }, { status: 400 });
    }

    const { db } = stores(c);
    let deleted = 0;
    const failed: string[] = [];
    for (const raw of items) {
      const entry = raw as { type?: unknown; hash?: unknown };
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
        isDelete: true,
        version: existing.version + 1,
        lastModified: new Date(Math.max(Date.now(), existing.lastModified + 1)).toISOString(),
      });
      if (result.kind === 'updated') deleted++;
      else failed.push(`${entry.type}-${entry.hash}`);
    }
    return Response.json({ deleted, failed: failed.length });
  });

  // GET /ui/api/statistics —— 官方统计 + 按类型计数（官方那套没有类型分布）
  guarded.get('/ui/api/statistics', async (c) => {
    const { db, storage } = stores(c);
    const bytes = await storage.totalHistorySize();
    const [stats, byType] = await Promise.all([
      db.statistics(historySizeMB(bytes)),
      countByType(c.env.DB),
    ]);
    return Response.json({ ...stats, byType });
  });

  // GET /ui/api/info —— 部署信息（把「服务器地址该填什么」直接给出来）
  guarded.get('/ui/api/info', async (c) => {
    const { db, storage } = stores(c);
    const origin = new URL(c.req.url).origin;
    const bytes = await storage.totalHistorySize();
    const [stats, byType, meta] = await Promise.all([
      db.statistics(historySizeMB(bytes)),
      countByType(c.env.DB),
      db.getMetaValues(CLEANUP_META_KEY_LIST),
    ]);
    // 清理侧：键在「从未跑过清理」时不存在，故全部容忍缺省（D1 报错与上面两个查询同样向上抛，
    // 不在这里特殊化——诊断面整体失败比"部分字段静默为默认值"更容易被发现）。
    const lastError = meta.get(CLEANUP_META_KEYS.lastError) ?? '';
    return Response.json({
      version: c.env.VERSION,
      // 客户端「服务器地址」填这个（本实现把 WebDAV 兼容端点放在站点根）
      serverUrl: `${origin}/`,
      hubTransports: AVAILABLE_TRANSPORTS,
      retention: {
        maxSavedHistoryCount: Number(c.env.MAX_SAVED_HISTORY_COUNT) || null,
        retentionMinutes: Number(c.env.HISTORY_RETENTION_MINUTES) || null,
      },
      storage: { totalBytes: bytes, totalFileSizeMB: stats.totalFileSizeMB },
      counts: {
        total: stats.totalCount,
        active: stats.activeCount,
        starred: stats.starredCount,
        deleted: stats.deletedCount,
        byType,
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
    });
  });

  // GET /ui/api/poll —— 变更信号（前端据此决定要不要重拉列表）
  guarded.get('/ui/api/poll', async (c) => Response.json(await readChangeMarker(c.env.DB)));

  app.route('/', guarded);

  // `/ui/*` 的兜底 404（只覆盖 UI 命名空间；协议路径的 404 语义不动）。
  // Hono 的路由器让更具体的路由优先，故这一条只在没有其它匹配时命中。
  // API 命名空间返回 JSON（调用方是代码），页面命名空间返回 404 页（调用方是人）。
  app.all('/ui/api/*', (c) => Response.json({ error: 'not_found' }, { status: 404 }));
  app.all('/ui/*', (c) => notFoundPage(c.env));
  app.get('/ui', (c) => c.redirect('/ui/', 302));

  return app;
}
