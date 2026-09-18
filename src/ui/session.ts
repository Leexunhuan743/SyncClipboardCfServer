// UI 会话：无状态签名 Cookie（HMAC-SHA256）。
//
// 为什么不用服务端会话表：Workers 没有可依赖的进程内状态（实例随时回收、请求可能落到任意实例），
// 而 D1 存会话表会让每次页面请求多一次写库。签名 Cookie 的语义等价于 clipserver 的登录会话，
// 但零存储、天然可水平扩展；密钥由 PASSWORD 派生，因此**改密码即让全部已签发会话失效**。
import { Bindings } from '../env';
import { isAuthConfigured } from '../auth';

export const SESSION_COOKIE = 'sb_ui_session';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h（与 clipserver 的 SESSION_EXPIRE_HOURS 一致）

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
// 改口令后旧会话在缓存存活期内仍被接受（审计残余 G1）。按口令值做键可以把这个窗口收敛到零：
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

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

function cookieAttributes(request: Request, maxAgeSeconds: number): string {
  // HttpOnly：JS 读不到；SameSite=Strict：UI 与 API 同源，跨站请求不必带会话；
  // Secure：仅 https 下加（本地 http 调试时加了会导致浏览器直接丢弃 Cookie）。
  const secure = isSecureRequest(request) ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${maxAgeSeconds}`;
}

// 签发：返回可直接放进 Set-Cookie 的值
export async function issueSession(
  env: Bindings,
  request: Request,
  username: string,
): Promise<string> {
  const payload: SessionPayload = { u: username, exp: Date.now() + SESSION_TTL_MS };
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await sessionKey(env), new TextEncoder().encode(encoded)),
  );
  const token = `${encoded}.${toBase64Url(signature)}`;
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(request, Math.floor(SESSION_TTL_MS / 1000))}`;
}

export function clearSession(request: Request): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(request, 0)}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// 校验：先验签（crypto.subtle.verify 为常量时间），再解析载荷。
// 签名不通过时不解析载荷——避免把未经验证的 JSON 带进后续逻辑。
export async function readSession(env: Bindings, request: Request): Promise<UiSession | null> {
  // 凭据未配置时**不得**继续验签：此时 §sessionKey 的 IKM 退化为空串（无任何秘密输入），
  // 任何人都能用同一份公开算法离线签发一个「有效」令牌，使 /ui/api/session 报告 authenticated:true。
  // 与 guard 的「未配置即 500」fail-closed 对齐（审计残余 G2）。
  if (!isAuthConfigured(env)) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const signature = fromBase64Url(token.slice(dot + 1));
  if (!signature) return null;

  const valid = await crypto.subtle.verify(
    'HMAC',
    await sessionKey(env),
    signature,
    new TextEncoder().encode(encoded),
  );
  if (!valid) return null;

  const raw = fromBase64Url(encoded);
  if (!raw) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.u !== 'string' || typeof payload?.exp !== 'number') return null;
  if (payload.exp <= Date.now()) return null;
  return { username: payload.u };
}
