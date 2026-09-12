// HTTP Basic Auth（协议契约 docs/protocol.md §1）
// 对齐上游 BasicAuthenticationHandler.cs：
//   - scheme 大小写不敏感（上游 StartsWith("basic", OrdinalIgnoreCase)）
//   - 凭据按 UTF-8 解码（上游 Encoding.UTF8.GetString(Convert.FromBase64String(...))）
//     atob() 是 latin1 解码，非 ASCII 用户名/密码会被破坏导致误判 401
//   - 密码取首个冒号之后的全部（比上游 Split(':') 更宽容，不影响官方客户端）
import { Bindings } from './env';
import type { Context, Next } from 'hono';

const AUTH_HEADER = 'Authorization';
const WWW_AUTHENTICATE = 'Basic realm="SyncClipboard"';

export function checkBasicAuth(env: Bindings, request: Request): boolean {
  const header = request.headers.get(AUTH_HEADER);
  if (!header) return false;

  const space = header.indexOf(' ');
  if (space < 0) return false;
  if (header.slice(0, space).toLowerCase() !== 'basic') return false;

  const encoded = header.slice(space + 1).trim();
  let decoded: string;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    decoded = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return false;
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, env.USERNAME) && safeEqual(pass, env.PASSWORD);
}

// 常量时间字节比较，避免用响应时间侧信道逐字符猜测密码。
// 长度不同直接返回 false（与上游 C# string == 的长度短路语义一致）。
function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

// 凭据未配置时给出可诊断的错误，而不是让调用方对着 401 反复猜（同类项目审计项 2.3）。
// 注意：本实现**不使用**上游的 admin/admin 默认值（fail-closed，避免弱默认凭据上生产）。
export function isAuthConfigured(env: Bindings): boolean {
  return (
    typeof env.USERNAME === 'string' && env.USERNAME !== '' &&
    typeof env.PASSWORD === 'string' && env.PASSWORD !== ''
  );
}

// 统一鉴权入口：返回 Response 表示拒绝（401/500），null 表示通过
export function authFailure(env: Bindings, request: Request): Response | null {
  if (!isAuthConfigured(env)) {
    return new Response(
      'Server authentication is not configured: set the USERNAME and PASSWORD secrets',
      { status: 500 },
    );
  }
  if (!checkBasicAuth(env, request)) return unauthorized();
  return null;
}

export function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': WWW_AUTHENTICATE },
  });
}

// Hono 中间件：校验 Basic Auth，失败返回 401
export const basicAuthMiddleware = (env: Bindings) =>
  async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    if (!checkBasicAuth(env, c.req.raw)) {
      return unauthorized();
    }
    await next();
  };
