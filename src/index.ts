// Worker 入口：Basic Auth → Hono 路由；SignalR negotiate/WS 升级走独立路径
//
// 注意：本模块是 Worker **入口**，Cloudflare 模块格式要求它的每个具名导出都是函数 /
// ExportedHandler / DO 类。常量一律放别的模块（如 src/requestLimits.ts）并只 import 不 re-export，
// 否则运行时起不来：`Incorrect type for map entry ...: the provided value is not of type
// 'function or ExportedHandler'`（wrangler dev 实测）。
import { Hono } from 'hono';
import { Bindings } from './env';
import { authFailure, drainRequestBody, tooManyRequests, warnWeakCredentials } from './auth';
import { checkAuthRateLimit, noteAuthFailure, noteAuthSuccess } from './rateLimit';
import { createWebdavRoutes } from './routes/webdav';
import { createHistoryRoutes } from './routes/history';
import { createUiRoutes } from './ui/routes';
import { notFoundPage } from './ui/notFound';
import { forwardToHub, negotiateResponse, HUB_PATH } from './hub';
import { SyncClipboardHub } from './durable/SyncClipboardHub';
import { runCleanup } from './cleanup';
import { maxRequestBodyBytes, isLoopbackHost } from './requestLimits';
import { normalizeProtocolPath } from './pathCase';
import { isUiEnabled, uiDisabledResponse } from './uiEnabled';

// F8：明文跳转/HSTS 只对「浏览器可访问的 host」生效；loopback 一律不跳转、不加 HSTS，
// 否则本地开发（wrangler dev 走明文）会被强行升级到不存在的 https。判定与 F7 的限速豁免共用。

// Host 头 / Origin 的 host 可能带默认端口（https://a.example:443），比较前先归一
function stripDefaultPort(host: string, proto: string): string {
  const suffix = proto === 'http' ? ':80' : ':443';
  const lower = host.toLowerCase();
  return lower.endsWith(suffix) ? lower.slice(0, -suffix.length) : lower;
}

// 尾斜杠归一（保留根路径 `/`）。
// 用途：Hono 的 `strict: false` 让 `/ui/api/login/` 与 `/ui/api/login` 落到同一个 handler，
// 于是所有"按路径字面量做判定"的中间件都必须先归一，否则会留下一条绕过该判定的等价路径
// （限速那条就是实例）。此前这段表达式在两个中间件里各写一遍（审计 O-08a）。
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

// Host 头 → 主机名（IPv6 字面量保留方括号）
function hostWithoutPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end < 0 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon < 0 ? host : host.slice(0, colon);
}

// 登录请求体里的用户名（仅用于限速的凭据维度；解析失败只用 IP 维度，不影响登录本身）
function readUsername(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('username' in value)) return null;
  const username = value.username;
  return typeof username === 'string' && username !== '' ? username : null;
}

const app = new Hono<{ Bindings: Bindings }>({ strict: false }) // 尾斜杠容忍：对齐 ASP.NET 路由（客户端 AdjustDirectoryUrl 会加 /）;

// F8：明文（x-forwarded-proto: http）且 host 不是 loopback → 301 升级到同路径 https；
// 经 https（x-forwarded-proto: https 或存在 cf-ray）的响应一律带 HSTS。
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const proto = (c.req.header('x-forwarded-proto') ?? '').toLowerCase();
  if (proto === 'http' && !isLoopbackHost(hostWithoutPort(url.host).toLowerCase())) {
    // 先排空请求体：带 body 的请求若在未读体时返回响应，会让本 isolate 的后续请求 503
    await drainRequestBody(c.req.raw);
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  await next();
  if (proto === 'https' || c.req.header('cf-ray') !== undefined) {
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
});

// F9：这几条端点把整包读进内存，先按 content-length 预检，超限直接 413（不解析、不缓冲）。
// /ui/api/login 也在列：下方 F4/F7 中间件要读它的 body 取用户名，超大体量必须先拦。
// `PUT /file/{name}`（暂存）**本身是流式的、不吃内存**，但它必须一起限：暂存进去的对象随后会被
// 落库那步整包读回内存（见 src/profile.ts 的 PayloadTooLargeError），把上限统一在入口，
// "任何单个传输对象都 ≤ 上限"才是可解释的不变式（真实护栏仍是落库时按对象实际大小的判定）。
app.use('*', async (c, next) => {
  const path = normalizePath(c.req.path);
  const limited =
    (c.req.method === 'PUT' && (path === '/SyncClipboard.json' || path.startsWith('/file/'))) ||
    (c.req.method === 'POST' && (path === '/api/history' || path === '/ui/api/login')) ||
    (c.req.method === 'PATCH' && path.startsWith('/api/history/'));
  if (!limited) return next();
  const declared = Number(c.req.header('content-length') ?? '0');
  // 上限可由仓库变量 MAX_REQUEST_BODY_BYTES 覆盖（越界/非法值回落默认，见 src/requestLimits.ts）
  if (Number.isFinite(declared) && declared > maxRequestBodyBytes(c.env)) {
    // 仍然排空：否则本 isolate 的后续请求会以 503 结束（见 src/auth.ts 的同名说明）。
    // 这里是流式丢弃，不会把体读进内存。
    await drainRequestBody(c.req.raw);
    return new Response('Payload Too Large', { status: 413 });
  }
  await next();
});

// F4：/ui/api/* 的状态变更方法做来源判定（纵深防御；SameSite=Strict 是第一道）。
// 带 Origin 且 host 与请求 host 不同 → 403；Sec-Fetch-Site: cross-site → 403；
// 无 Origin 的 CLI/测试客户端放行（浏览器对跨站写请求一律会带 Origin，故该放行面不构成绕过）。
app.use('/ui/api/*', async (c, next) => {
  const method = c.req.method;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      const requestHost = c.req.header('host') ?? new URL(c.req.url).host;
      const requestProto = (c.req.header('x-forwarded-proto') ?? 'https').toLowerCase();
      let allowed = false;
      try {
        const parsed = new URL(origin);
        const originProto = parsed.protocol.replace(':', '');
        allowed =
          parsed.host === requestHost ||
          (stripDefaultPort(parsed.host, originProto) === stripDefaultPort(requestHost, requestProto) &&
            hostWithoutPort(parsed.host) === hostWithoutPort(requestHost));
      } catch {
        allowed = false; // Origin: null / 畸形值：按外源处理
      }
      if (!allowed) {
        await drainRequestBody(c.req.raw);
        return Response.json({ error: 'cross_origin_rejected' }, { status: 403 });
      }
    }
    if ((c.req.header('sec-fetch-site') ?? '').toLowerCase() === 'cross-site') {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'cross_origin_rejected' }, { status: 403 });
    }
  }

  // F7：/ui/api/login 的凭据在 body 里（走不到 authFailure），这里补齐限速；
  // 带 Basic 头的 /ui/api/* 请求同样纳入 IP 维度（凭据维度由协议路径与 login 覆盖）。
  // 路径按尾斜杠归一：Hono 的 strict:false 让 `/ui/api/login/` 也落到同一个 handler，
  // 不归一就会留下一条绕过限速的等价路径。
  const normalized = normalizePath(c.req.path);
  const isLogin = method === 'POST' && normalized === '/ui/api/login';
  if (!isLogin && c.req.header('authorization') === undefined) return next();
  let username: string | null = null;
  if (isLogin) {
    try {
      username = readUsername(await c.req.raw.clone().json());
    } catch {
      /* 非 JSON 或空体：只用 IP 维度 */
    }
  }
  const verdict = checkAuthRateLimit(c.env, c.req.raw, username, c.executionCtx);
  if (verdict !== null) {
    await drainRequestBody(c.req.raw);
    return tooManyRequests(verdict.retryAfterSeconds);
  }
  await next();
  if (c.res.status === 401) {
    noteAuthFailure(c.env, c.req.raw, username, c.executionCtx);
  } else if (c.res.ok) {
    noteAuthSuccess(c.env, c.req.raw, username, c.executionCtx);
  }
});

// 全局 Basic Auth（所有端点，含 /api/version、/api/time —— 上游 [Authorize] 类级）
app.use('*', async (c, next) => {
  // 界面三面（`/ui/*`、`/ui_v1/*`、`/ui_v2/*`）是本站页面自己的面，鉴权由 src/ui/guard.ts 负责
  // （会话 Cookie 或 Basic）。注意静态那两面由外层 fetch 直接走了静态资源、根本到不了这里，
  // 这条跳过真正覆盖的是 `/ui/api/*`（它的守卫在 src/ui/routes.ts）。
  // 若走这里的 Basic-only 中间件，浏览器拿 Cookie 打进来的每个请求都会被 401。
  //
  // 根路径的**浏览器导航**同样放行：否则打开站点会被弹原生凭据框，
  // 而 Web UI 存在的意义就是替代那个弹窗。判定收得很紧——必须是 GET + Accept 含 text/html，
  // 故 PROPFIND /（客户端探活/目录列举）与任何脚本调用仍然走 Basic Auth，协议行为不变。
  const isBrowserRootNavigation =
    c.req.method === 'GET' &&
    c.req.path === '/' &&
    (c.req.header('accept') ?? '').includes('text/html');
  if (c.req.path.startsWith('/ui/') || isBrowserRootNavigation) return next();
  const denied = authFailure(c.env, c.req.raw, c.executionCtx);
  if (denied) {
    // 先排空请求体：否则带 body 的请求（如 POST /api/history）在鉴权失败时会触发
    // 运行时错误「Can't read from request stream after response has been sent.」并以 503 结束
    await drainRequestBody(c.req.raw);
    return denied;
  }
  await next();
});

app.route('/', createWebdavRoutes());
app.route('/', createHistoryRoutes());
app.route('/', createUiRoutes());

// 基础端点
// GET api/version：上游 `Ok(SyncClipboardProperty.AppVersion)`，AppVersion 是 **string** →
// 走 StringOutputFormatter → text/plain 裸串（无引号）。客户端用 ReadAsStringAsync + AppVersion.TryParse，
// 故这里保持 text 而非 json（否则 TryParse 会拿到带引号的串）。
app.get('/api/version', (c) => {
  const res = c.text(c.env.VERSION);
  // F1：弱凭据的机器可读信号（同时打一次 console.warn）。默认不阻断服务，见 src/auth.ts。
  if (warnWeakCredentials(c.env)) res.headers.set('x-credential-warning', 'weak');
  return res;
});
// GET api/time：上游返回的是 **DateTimeOffset**（不是 string）→ 走 JSON 格式化器 →
// `application/json` 的带引号 ISO 串。官方客户端用 ReadFromJsonAsync<DateTimeOffset> 读取，
// text/plain 的裸时间戳会因「媒体类型不支持 + 不是合法 JSON」直接抛异常（真实互通断裂）。
app.get('/api/time', (c) => c.json(new Date().toISOString()));

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // 路径**字面段**归一放在最前面：上游（ASP.NET Core）路由对字面段不区分大小写
    // （`/API/version`、`/SyncClipboard.JSON`、`/api/history/Statistics`、`/SYNCCLIPBOARDHUB/negotiate`
    // 都命中），Hono 与下面的 `url.pathname === HUB_PATH` 都是精确比较 ⇒ 必须先归一。
    // 只动字面段，`/file/{fileName}` 与 `/api/history/{profileId}` 的取值原样保留（见 src/pathCase.ts）。
    const normalizedPath = normalizeProtocolPath(new URL(request.url).pathname);
    if (normalizedPath !== null) {
      const rewritten = new URL(request.url);
      rewritten.pathname = normalizedPath; // 赋值 pathname 保留 query
      request = new Request(rewritten, request);
    }
    const url = new URL(request.url);

    // Web 界面开关（GitHub 变量 UI_ENABLED，默认开；判定见 src/uiEnabled.ts）。
    // 三个界面挂载点（2026-09-19 改名后）：/ui_v1（V1，默认界面）/ /ui_v2（V2，开发测试版）
    // /ui（只剩一层跳转壳）。它们**共用**同一个开关 —— 关掉时必须全部 404，否则
    // "关掉界面"会留下一个仍可访问的界面，那正是这个开关要消除的东西。
    //
    // `/ui/api/*` 与界面资源**同前缀但不同族**：它是服务端接口（`src/ui/routes.ts` 的路由），
    // 必须原样交给下面的 Hono，绝不能被当成界面资源去问静态资源，也不能在关闭态被换成 404 页
    // （关闭态它返回与 routes.ts 兜底同形的 JSON，见 src/uiEnabled.ts）。
    const path = url.pathname;
    const isUiApi = path.startsWith('/ui/api/');
    // ⚠️ 这份前缀清单**不是**唯一事实源：`public/` 下的 `ui*` 目录才算数，`wrangler.toml` 的
    // run_worker_first、`public/_headers` 的规则是另外两处副本。三处由 `test/ui-guard.test.ts` 钉在一起
    // （判据：前缀集合 == `public/` 的挂载点集合）—— 新增/改名挂载点时三处必须一起改，否则会红。
    const isUiAsset =
      path === '/ui' ||
      path.startsWith('/ui/') ||
      path === '/ui_v1' ||
      path.startsWith('/ui_v1/') ||
      path === '/ui_v2' ||
      path.startsWith('/ui_v2/');

    if (isUiAsset && !isUiApi) {
      // ⚠️ 这条分支只在请求**到达 Worker** 时才跑：`wrangler.toml` 的 run_worker_first 必须
      // 覆盖全部三个前缀（含各自的 `/*`），否则边缘命中静态资源就直接返回、开关静默失效
      // （2026-09-18 曾在 V1 那一面踩到；守卫见 test/ui-guard.test.ts）。
      if (!isUiEnabled(env)) return uiDisabledResponse(false);
      // 先把请求转给静态资源；**未命中资源（404）时回落**到那张设计过的 404 页
      // （与"静态资源直接托管 + not_found_handling=none"时平台的回落行为同形：
      //  `/ui_v1/不存在的路径` 拿到的是那张页，而不是平台默认的纯文本 404）。
      // 三面共用这条链是因为它们的形状完全相同 —— 都没有自己的服务端路由。
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      return notFoundPage(env);
    }

    if (isUiApi && !isUiEnabled(env)) {
      return uiDisabledResponse(true);
    }

    // SignalR negotiate（需 Basic Auth；上游 hub [Authorize]）
    if (url.pathname === `${HUB_PATH}/negotiate`) {
      const denied = authFailure(env, request, ctx);
      if (denied) {
        await drainRequestBody(request);
        return denied;
      }
      try {
        return await negotiateResponse(env, request);
      } catch {
        // token 登记失败时不能让客户端拿到一个注定通过不了升级校验的 token
        return new Response('Hub unavailable', { status: 503 });
      }
    }

    // Hub 连接：全部转发 DO。鉴权在 DO 内完成——校验 negotiate 登记的 connectionToken，
    // 或接受直接携带有效 Basic 凭据的请求（上游 hub 类级 [Authorize] 的等价物，F1）。
    // 覆盖三种传输：WS 升级、SSE 的 GET、长轮询的 GET/POST/DELETE。
    if (url.pathname === HUB_PATH) {
      return forwardToHub(env, request);
    }

    return app.fetch(request, env, ctx);
  },

  // Cron Trigger：历史保留/清理（对齐上游 HistoryCleaner）
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCleanup(env)
        .then((r) => {
          console.log(`[cleanup] expired=${r.expired} trimmed=${r.trimmed} hardDeleted=${r.hardDeleted} orphans=${r.orphans} batches=${r.batches}`);
        })
        // F11：兜底 catch —— 清理失败必须留下可观测信号，而不是只留一行 Uncaught Error
        // （runCleanup 自身也把失败写进 Meta cleanup:lastError，两处互补：日志给运维、Meta 给 UI）
        .catch((err: unknown) => {
          console.error('[cleanup] fatal', err);
        }),
    );
  },
};

export { SyncClipboardHub };
