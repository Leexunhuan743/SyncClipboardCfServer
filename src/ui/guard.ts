// UI 鉴权：会话 Cookie **或** HTTP Basic。
//
// 双通道的理由：
//   - 浏览器页面用会话 Cookie（Basic 会让浏览器弹出原生凭据框，且无法登出）；
//   - curl / 脚本沿用 Basic（与官方 API 一致的凭据，不必先登录拿 Cookie）。
// 与协议端点的区别：这里 401 **不带** WWW-Authenticate —— 否则浏览器会抢先用原生弹窗
// 覆盖我们自己的登录页。
import { Bindings } from '../env';
import { isAuthConfigured, checkBasicAuth, drainRequestBody } from '../auth';
import { readSession, UiSession } from './session';
import type { Context, Next } from 'hono';

export function uiUnauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

export async function authenticateUi(
  env: Bindings,
  request: Request,
): Promise<UiSession | null> {
  const session = await readSession(env, request);
  if (session) return session;
  if (checkBasicAuth(env, request)) {
    return { username: env.USERNAME };
  }
  return null;
}

// 未配置凭据时给出可诊断的 500（与协议端点同一条走查路径），而不是让人对着 401 反复猜。
//
// **失败路径必须先排空请求体**：受守卫的 PATCH / batch-update 都带 body，一旦在未读完入站体时
// 就发出响应，Workers 运行时会抛「Can't read from request stream after response has been sent.」
// 并让本 isolate 的**后续请求**以 503 结束（auth.ts 的 drainRequestBody 注释记录了实测过程；
// index.ts、durable/SyncClipboardHub.ts 的各提前返回点同样处理）。会话过期后在页面上点一次收藏
// 就能命中这条路径，故不是理论问题。
export async function uiAuthFailure(env: Bindings, request: Request): Promise<Response | null> {
  if (!isAuthConfigured(env)) {
    await drainRequestBody(request);
    return Response.json(
      { error: 'server_not_configured', detail: 'Set the USERNAME and PASSWORD secrets' },
      { status: 500 },
    );
  }
  const session = await authenticateUi(env, request);
  if (session) return null;
  await drainRequestBody(request);
  return uiUnauthorized();
}

export const uiAuthMiddleware = () =>
  async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const failure = await uiAuthFailure(c.env, c.req.raw);
    if (failure) return failure;
    await next();
  };
