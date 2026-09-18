// Worker 入口：Basic Auth → Hono 路由；SignalR negotiate/WS 升级走独立路径
import { Hono } from 'hono';
import { Bindings } from './env';
import { authFailure, drainRequestBody } from './auth';
import { createWebdavRoutes } from './routes/webdav';
import { createHistoryRoutes } from './routes/history';
import { forwardToHub, negotiateResponse, HUB_PATH } from './hub';
import { SyncClipboardHub } from './durable/SyncClipboardHub';
import { runCleanup } from './cleanup';

const app = new Hono<{ Bindings: Bindings }>({ strict: false }) // 尾斜杠容忍：对齐 ASP.NET 路由（客户端 AdjustDirectoryUrl 会加 /）;

// 全局 Basic Auth（所有端点，含 /api/version、/api/time —— 上游 [Authorize] 类级）
app.use('*', async (c, next) => {
  const denied = authFailure(c.env, c.req.raw);
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

// 基础端点
// GET api/version：上游 `Ok(SyncClipboardProperty.AppVersion)`，AppVersion 是 **string** →
// 走 StringOutputFormatter → text/plain 裸串（无引号）。客户端用 ReadAsStringAsync + AppVersion.TryParse，
// 故这里保持 text 而非 json（否则 TryParse 会拿到带引号的串）。
app.get('/api/version', (c) => c.text(c.env.VERSION));
// GET api/time：上游返回的是 **DateTimeOffset**（不是 string）→ 走 JSON 格式化器 →
// `application/json` 的带引号 ISO 串。官方客户端用 ReadFromJsonAsync<DateTimeOffset> 读取，
// text/plain 的裸时间戳会因「媒体类型不支持 + 不是合法 JSON」直接抛异常（真实互通断裂）。
app.get('/api/time', (c) => c.json(new Date().toISOString()));

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // SignalR negotiate（需 Basic Auth；上游 hub [Authorize]）
    if (url.pathname === `${HUB_PATH}/negotiate`) {
      const denied = authFailure(env, request);
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
      runCleanup(env).then((r) => {
        console.log(`[cleanup] expired=${r.expired} trimmed=${r.trimmed} hardDeleted=${r.hardDeleted} orphans=${r.orphans} batches=${r.batches}`);
      }),
    );
  },
};

export { SyncClipboardHub };
