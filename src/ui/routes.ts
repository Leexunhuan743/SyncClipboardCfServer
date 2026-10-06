// UI 的 HTTP 面：`/ui/api/*` 的装配点 —— 公开端点、守卫中间件与兜底路由在这里注册，
// 各端点组各自成模块（shared / history-data / history-mutations / info）。
//
// 命名空间选 `/ui/api/*` 而不是 `/api/*`：后者已被协议（官方客户端依赖）占用，
// 混在一起会让「哪些是客户端依赖的」变得无法机械判定。
import { Hono } from 'hono';
import { Bindings } from '../env';
import { isAuthConfigured, verifyCredentials, drainRequestBody } from '../auth';
import { issueSession, clearSession } from './session';
import { uiAuthMiddleware, authenticateUi } from './guard';
import { maxRequestBodyBytes } from '../requestLimits';
import { notFoundPage } from './notFound';
import { createUiMaintenanceRoutes } from './maintenance';
import { readCredentials } from './routes/shared';
import { createHistoryDataRoutes } from './routes/history-data';
import { createHistoryMutationRoutes } from './routes/history-mutations';
import { createInfoRoutes } from './routes/info';

export function createUiRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // 缓存策略：`/ui/api/*` 的 JSON 响应一律 `no-store`。
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
    const read = await readCredentials(c.req.raw, maxRequestBodyBytes(c.env));
    if (read.kind === 'too_large') {
      // 与协议面一致：超体量上限一律 413（同一端点对 content-length 超限回 413、
      // 对 chunked 超限回 400 会让同类失败给出两种状态码）
      return new Response('Payload Too Large', { status: 413 });
    }
    if (read.kind === 'invalid') {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const credentials = read.credentials;
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
    return Response.json(
      { authenticated: false },
      { headers: { 'set-cookie': clearSession(c.req.raw) } },
    );
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
  // （中间件先于更晚注册的兜底路由命中），于是未认证访问不存在的页面路径会得到 401 JSON
  // 而不是 404 页。收窄后守卫只管 API，页面本身是公开的（与登录页一致）。
  guarded.use('/ui/api/*', uiAuthMiddleware());

  guarded.route('/', createHistoryDataRoutes());
  guarded.route('/', createHistoryMutationRoutes());
  guarded.route('/', createInfoRoutes());

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
  app.all('/ui/*', () => notFoundPage());
  app.get('/ui', (c) => c.redirect('/ui/', 302));

  return app;
}
