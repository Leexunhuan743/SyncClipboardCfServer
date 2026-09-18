// HTTP Basic Auth（协议契约 docs/protocol.md §1）
// 对齐上游 BasicAuthenticationHandler.cs：
//   - scheme 大小写不敏感（上游 StartsWith("basic", OrdinalIgnoreCase)）
//   - 凭据按 UTF-8 解码（上游 Encoding.UTF8.GetString(Convert.FromBase64String(...))）
//     atob() 是 latin1 解码，非 ASCII 用户名/密码会被破坏导致误判 401
//   - 密码取首个冒号之后的全部（比上游 Split(':') 更宽容，不影响官方客户端）
import { Bindings } from './env';
import { checkAuthRateLimit, noteAuthFailure, noteAuthSuccess } from './rateLimit';
import type { WaitUntil } from './rateLimit';
import type { Context, Next } from 'hono';

const AUTH_HEADER = 'Authorization';
const WWW_AUTHENTICATE = 'Basic realm="SyncClipboard"';

// 已知文档化默认值（F1 弱凭据告警）。静态查找表用 Record（见工程约定）。
const WEAK_CREDENTIAL_VALUES: Record<string, true> = {
  admin: true,
  password: true,
  your_password: true,
  your_username: true,
  changeme: true,
  syncclipboard: true,
};
// 口令/用户名短于该长度视为弱（暴力枚举的搜索空间不足）
const MIN_CREDENTIAL_LENGTH = 8;

interface BasicCredentials {
  user: string;
  pass: string;
}

// 解析 Authorization: Basic 头 → 凭据；缺失/畸形/非 base64 返回 null。
// 单独成函数是因为限速需要**只取用户名**做维度键（不比较凭据即可得到），避免重复解码。
function parseBasicCredentials(request: Request): BasicCredentials | null {
  const header = request.headers.get(AUTH_HEADER);
  if (!header) return null;

  const space = header.indexOf(' ');
  if (space < 0) return null;
  if (header.slice(0, space).toLowerCase() !== 'basic') return null;

  const encoded = header.slice(space + 1).trim();
  let decoded: string;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    decoded = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

export function checkBasicAuth(env: Bindings, request: Request): boolean {
  const credentials = parseBasicCredentials(request);
  return credentials !== null && verifyCredentials(env, credentials.user, credentials.pass);
}

// 只取用户名（**不比较凭据**）：限速的凭据维度用它做 key。
// 导出给 DO 侧：WS/SSE/长轮询的鉴权在 DO 内完成，不经过 authFailure。
export function basicAuthUsername(request: Request): string | null {
  const credentials = parseBasicCredentials(request);
  return credentials !== null ? credentials.user : null;
}

// 凭据校验的唯一实现：HTTP Basic 头与 UI 登录表单都走这里。
// 两项都比较完毕再合并结果（不短路）——短路会让「用户名错」比「密码错」早返回，
// 用响应时间就能区分用户名是否存在。
export function verifyCredentials(env: Bindings, user: string, pass: string): boolean {
  // 未配置凭据时一律不通过（fail-closed）。
  // 少了这一句会出现 fail-open：USERNAME/PASSWORD 未设置时 safeEqual 的两侧
  // （TextEncoder.encode('') 与 encode(undefined)）都是零长度数组，比较结果为真，
  // 于是 /ui/api/session 对 `Authorization: Basic Og==`（即 ":"）返回 authenticated:true ——
  // 界面显示成「已登录」，而所有受保护端点仍返回 500，真正的「未配置」诊断被掩盖。
  if (!isAuthConfigured(env)) return false;
  // 弱凭据硬失败（默认关，见 env.ENFORCE_STRONG_CREDENTIALS）：打开后所有通道一并 fail-closed，
  // 无需在每个调用点（UI 登录、UI 守卫、Basic 协议）重复判定。
  if (env.ENFORCE_STRONG_CREDENTIALS === 'true' && hasWeakCredentials(env)) return false;
  const userOk = safeEqual(user, env.USERNAME);
  const passOk = safeEqual(pass, env.PASSWORD);
  return userOk && passOk;
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

// 弱凭据判定（F1）：命中已知文档化默认值，或长度不足 8。
export function hasWeakCredentials(env: Bindings): boolean {
  if (!isAuthConfigured(env)) return false; // 未配置走 500 fail-closed 的诊断，不重复报告
  const user = env.USERNAME.toLowerCase();
  const pass = env.PASSWORD.toLowerCase();
  return (
    user.length < MIN_CREDENTIAL_LENGTH ||
    pass.length < MIN_CREDENTIAL_LENGTH ||
    WEAK_CREDENTIAL_VALUES[user] === true ||
    WEAK_CREDENTIAL_VALUES[pass] === true
  );
}

// 每个 isolate 只告警一次，避免刷日志
let weakCredentialWarned = false;

// 弱凭据告警（F1）。**不阻断服务**：线上当前用的就是文档化默认口令，硬失败会直接切断用户同步；
// 轮换完成后可用 ENFORCE_STRONG_CREDENTIALS=true 收紧为 fail-closed。返回是否弱（供响应头/判定复用）。
export function warnWeakCredentials(env: Bindings): boolean {
  const weak = hasWeakCredentials(env);
  if (weak && !weakCredentialWarned) {
    weakCredentialWarned = true;
    console.warn(
      '[security] weak credentials: USERNAME/PASSWORD is a documented default or shorter than ' +
        `${MIN_CREDENTIAL_LENGTH} characters. Rotate now (wrangler secret put PASSWORD) — ` +
        'these values are guessable and grant full access to clipboard history.',
    );
  }
  return weak;
}

// 统一鉴权入口：返回 Response 表示拒绝（401/429/500），null 表示通过。
// ctx 只用于把限速计数**异步**投递给 DO（不阻塞响应）；缺省时退化为纯 isolate 内计数。
export function authFailure(env: Bindings, request: Request, ctx?: WaitUntil): Response | null {
  if (!isAuthConfigured(env)) {
    return new Response(
      'Server authentication is not configured: set the USERNAME and PASSWORD secrets',
      { status: 500 },
    );
  }
  // F1：弱凭据只告警不阻断（默认）；ENFORCE_STRONG_CREDENTIALS=true 时才 fail-closed
  if (warnWeakCredentials(env) && env.ENFORCE_STRONG_CREDENTIALS === 'true') {
    return new Response(
      'Server credentials are too weak: rotate USERNAME/PASSWORD to high-entropy values (at least ' +
        `${MIN_CREDENTIAL_LENGTH} characters, not the documented defaults)`,
      { status: 500 },
    );
  }
  const credentials = parseBasicCredentials(request);
  const username = credentials !== null ? credentials.user : null;
  // 限速预检必须排在凭据比较**之前**：被封锁时连比较都不做（不泄露时序，也不能被绕过）
  const verdict = checkAuthRateLimit(env, request, username, ctx);
  if (verdict !== null) return tooManyRequests(verdict.retryAfterSeconds);
  if (credentials === null || !verifyCredentials(env, credentials.user, credentials.pass)) {
    noteAuthFailure(env, request, username, ctx);
    return unauthorized();
  }
  noteAuthSuccess(env, request, username, ctx);
  return null;
}

// 429 响应。文案与头对所有维度（IP / 用户名 / 全局）完全一致，
// 因此既不泄露「用户名是否存在」，也不泄露「哪一维触发了封锁」。
export function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: {
      'Retry-After': String(retryAfterSeconds),
      'WWW-Authenticate': WWW_AUTHENTICATE,
    },
  });
}

export function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': WWW_AUTHENTICATE },
  });
}

// 提前返回响应前必须消费掉请求体：Workers 运行时在「响应已发出但入站体未被读完」时会抛
// `Can't read from request stream after response has been sent.`，并让**后续请求**以 503 结束
// （实测：带 body 的 POST 走鉴权失败路径后，紧接着的 DELETE 收到 503）。
// 注意：`body.cancel()` 不足以消除该错误，必须真正读完；这里用流式丢弃避免把大 body 读进内存。
export async function drainRequestBody(request: Request): Promise<void> {
  const body = request.body;
  if (!body) return;
  try {
    await body.pipeTo(new WritableStream());
  } catch {
    /* 体已被消费或不可读：忽略 */
  }
}

// Hono 中间件：校验 Basic Auth，失败返回 401
export const basicAuthMiddleware = (env: Bindings) =>
  async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    if (!checkBasicAuth(env, c.req.raw)) {
      return unauthorized();
    }
    await next();
  };
