// UI 会话：无状态签名 Cookie（HMAC-SHA256）。
//
// 当前事实：
//   - 密钥由 `PASSWORD` 经 HKDF-SHA256（盐 `HKDF_SALT`、用途 `HKDF_INFO`）派生，**按口令值缓存**
//     （改口令即让全部已签发会话失效，缓存键用口令值而非 env 对象，避免 stale 窗口）；
//   - 载荷 `{u, exp}`，`exp` 由服务端强制（24h，与 clipserver 的 `SESSION_EXPIRE_HOURS` 一致）；
//   - 校验顺序是"先验签、再解析载荷"，且**绑定 `u === env.USERNAME`** —— 改口令或改用户名都让旧会话失效；
//   - 不建服务端会话表：Workers 没有可依赖的进程内状态，签名 Cookie 零存储且可水平扩展。
//
// Cookie 属性与 base64url 编解码分别复用 `hono/utils/cookie` 与 `hono/utils/encode`；
// 不使用 `hono/jwt`（它引入可协商的 `alg` 且"先 decode 再验签"）与 `hono/cookie` 的签名 Cookie
// （把 secret 原样当 HMAC 密钥，且没有服务端强制的过期）。
import type { CookieOptions } from 'hono/utils/cookie';
import { parse as parseCookieHeader, serialize as serializeCookie } from 'hono/utils/cookie';
import { decodeBase64Url, encodeBase64Url } from 'hono/utils/encode';
import { Bindings } from '../env';
import { isAuthConfigured } from '../auth';

export const SESSION_COOKIE = 'sb_ui_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h（与 clipserver 的 SESSION_EXPIRE_HOURS 一致）

// HKDF 上下文：同一份 PASSWORD 在不同用途上派生出不同密钥
const HKDF_SALT = 'syncclipboard-cf-server';
const HKDF_INFO = 'ui-session-cookie-v1';

export interface UiSession {
  username: string;
}

interface SessionPayload {
  u: string;
  exp: number;
}

// 派生密钥按**口令值**缓存：HKDF 本身很快，但每个请求都要用，没必要重复派生。
//
// 不能用 env 对象（或 isolate 生命周期）当缓存键：更新 secrets **不保证**换掉 isolate，
// 也不保证换掉 env 对象；按对象缓存时，同一 isolate 会继续用旧口令派生的密钥验签 ——
// 改口令后旧会话在缓存存活期内仍被接受。按口令值做键可以把这个窗口收敛到零：
// 口令一变，下一次调用立刻重新派生。
let cachedPassword: string | null = null;
let cachedKey: Promise<CryptoKey> | null = null;

function sessionKey(env: Bindings): Promise<CryptoKey> {
  if (cachedKey !== null && cachedPassword === env.PASSWORD) return cachedKey;
  cachedPassword = env.PASSWORD;
  cachedKey = deriveKey(env.PASSWORD);
  return cachedKey;
}

async function deriveKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(HKDF_SALT),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    256,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// ===== 无守卫的纯派生原语（**唯一的消费者是测试**）=====
//
// 为什么导出：`test/hardening.test.ts` 要"用生产的同一套管线伪造一个空口令令牌"证明它会被拒。
// 若测试自己复制一份管线，生产侧一旦换算法/换盐/换编码，测试会**继续用旧算法伪造**，
// 于是给出"空口令令牌被拒"的**错误结论**——这条安全用例的判别力就成了人工同步下的赌注。
//
// 边界（很重要）：只导出**纯原语**。**不要**导出 `issueSession` 这类带 `isAuthConfigured`
// 守卫、或直接读 `env.PASSWORD` 的高层函数——未配置 env 时测试就造不出攻击令牌，
// 那条用例会从"fail-closed 生效"退化成"令牌本来就无效"（判别力被削弱）。
async function deriveSessionKey(password: string): Promise<CryptoKey> {
  return deriveKey(password);
}

// 与 `issueSession` 产出的令牌**同形**（`<payload>.<sig>`，不含 Cookie 属性）。
export async function signSessionToken(
  password: string,
  payload: SessionPayload,
): Promise<string> {
  return signPayload(await deriveSessionKey(password), payload);
}

// 令牌两段都**不带 padding**（本模块的 wire 形态是 `<payload>.<sig>`，签名固定 43 字符），
// 而 hono 的 `encodeBase64Url` 是**保留** `=` 的 ⇒ 两处必须同款处理，故收在一个函数里。
function encodeTokenPart(bytes: ArrayBufferLike): string {
  return encodeBase64Url(bytes).replace(/=+$/, '');
}

// 畸形输入 ⇒ null（不是 500）。hono 的 `decodeBase64Url` 直接走 `atob`：非法字符会抛，
// 缺失的 padding 由 atob 的 forgiving-base64 补齐 —— 与旧实现「先补 padding 再解码」等价。
function decodeTokenPart(text: string): Uint8Array | null {
  try {
    return decodeBase64Url(text);
  } catch {
    return null;
  }
}

async function signPayload(key: CryptoKey, payload: SessionPayload): Promise<string> {
  const encoded = encodeTokenPart(new TextEncoder().encode(JSON.stringify(payload)).buffer);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  return `${encoded}.${encodeTokenPart(signature)}`;
}

// Cookie 属性：HttpOnly（JS 读不到）；SameSite=Strict（UI 与 API 同源，跨站请求不必带会话）；
// Secure 仅 https 下加（本地 http 调试时加了会让浏览器直接丢弃 Cookie）。
// 拼装交给 `hono/utils/cookie` 的 `serialize`：它按 RFC 排列属性、对值做 `encodeURIComponent`
// （本模块的令牌是 base64url，编码是恒等变换），并会拒绝 `Max-Age > 400 天` 这类非法组合。
function cookieOptions(request: Request, maxAgeSeconds: number): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(request.url).protocol === 'https:',
    maxAge: maxAgeSeconds,
  };
}

// 签发：返回可直接放进 Set-Cookie 的值
export async function issueSession(
  env: Bindings,
  request: Request,
  username: string,
): Promise<string> {
  const payload: SessionPayload = { u: username, exp: Date.now() + SESSION_TTL_MS };
  const token = await signPayload(await sessionKey(env), payload);
  return serializeCookie(
    SESSION_COOKIE,
    token,
    cookieOptions(request, Math.floor(SESSION_TTL_MS / 1000)),
  );
}

export function clearSession(request: Request): string {
  // `maxAge: 0` ⇒ 浏览器立即删除（旧实现写的是 `Max-Age=0`，语义相同）。
  return serializeCookie(SESSION_COOKIE, '', cookieOptions(request, 0));
}

// 解析交给 `hono/utils/cookie` 的 `parse`（返回 null-proto 记录）：它处理引号包裹、首尾空白、
// 同名只取首个 —— 取值语义与旧实现相同，只是不再自己 `split(';')`。
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  return parseCookieHeader(header, name)[name] ?? null;
}

// 校验：先验签（crypto.subtle.verify 为常量时间），再解析载荷。
// 签名不通过时不解析载荷——避免把未经验证的 JSON 带进后续逻辑。
export async function readSession(env: Bindings, request: Request): Promise<UiSession | null> {
  // 凭据未配置时**不得**继续验签：此时 §sessionKey 的 IKM 退化为空串（无任何秘密输入），
  // 任何人都能用同一份公开算法离线签发一个「有效」令牌，使 /ui/api/session 报告 authenticated:true。
  // 与 guard 的「未配置即 500」fail-closed 对齐。
  if (!isAuthConfigured(env)) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const signature = decodeTokenPart(token.slice(dot + 1));
  if (!signature) return null;

  const valid = await crypto.subtle.verify(
    'HMAC',
    await sessionKey(env),
    signature,
    new TextEncoder().encode(encoded),
  );
  if (!valid) return null;

  const raw = decodeTokenPart(encoded);
  if (!raw) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.u !== 'string' || typeof payload?.exp !== 'number') return null;
  if (payload.exp <= Date.now()) return null;
  // 会话身份必须就是**当前**用户名：签名只证明"这份载荷由当前 PASSWORD 派生密钥签发过"，
  // 不证明 `u` 就是 `env.USERNAME`。少了这一句，任何用当前 PASSWORD 签出、但 `u` 为其它值的
  // 令牌都会被接受（改用户名后旧 Cookie 仍然有效）。与"改密码即失效"同一性质：改用户名也失效。
  if (payload.u !== env.USERNAME) return null;
  return { username: payload.u };
}
