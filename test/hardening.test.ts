// 审计残余 G2 与 G6 的判别性用例（修复后新增）。G1 也在这里。
//
// G1：会话密钥的派生缓存按 env 对象（isolate）为键 —— 更新 secrets 不保证换掉 isolate，
//     于是同一 isolate 会继续用旧口令派生的密钥验签：改口令后旧会话在缓存存活期内仍被接受。
//     修复：缓存改按**口令值**做键。判据是「同一个 env 对象上改口令，旧令牌立刻失效」。
//
// G2：readSession 只验签、不检查凭据是否已配置 —— 未配置时 sessionKey 的 IKM 退化为空串
//     （无任何秘密输入），任何第三方都能用同一份公开算法离线签出一个「有效」令牌，
//     让 /ui/api/session 报告 authenticated:true。修复：readSession 前置 fail-closed。
//     本文件用**与 src/ui/session.ts 完全相同的派生管线**伪造空口令令牌，证明它现在被拒；
//     并用「正确口令签发的同形令牌」作阳性对照 —— 否则「一律返回 null」也能骗过测试。
//
// G6：SearchText 超过 D1 的 LIKE 模式字节上限时查询报错，表现为未处理的 500。
//     修复：在协议与 UI 两个入口按**字节**校验（48 字节上限），超长回 400。
//
// （G5 是 Group zip 条目名的校验，用例在 test/hash.test.ts 的 parseGroupZip 一组里。）
import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_BYTES, normalizeSearchText } from '../src/serialization';
import { parseUiHistoryQuery } from '../src/ui/query';
import { readSession, SESSION_COOKIE } from '../src/ui/session';
import { createHistoryRoutes } from '../src/routes/history';
import type { Bindings } from '../src/env';

// ---------- G2：伪造管线（与 session.ts 同算法：HKDF-SHA256 → HMAC-SHA256）----------
const HKDF_SALT = 'syncclipboard-cf-server';
const HKDF_INFO = 'ui-session-cookie-v1';
const enc = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function forgeSessionCookie(password: string, payload: { u: string; exp: number }): Promise<string> {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) },
    material,
    256,
  );
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encoded = base64Url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(encoded));
  return `${encoded}.${base64Url(new Uint8Array(sig))}`;
}

const cookieRequest = (token: string) =>
  new Request('https://sync.example.com/ui/api/session', {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });

describe('G2 · 凭据未配置时会话校验 fail-closed', () => {
  it('空口令派生的密钥签发的令牌 → null（修复前：会被当成有效会话）', async () => {
    const forged = await forgeSessionCookie('', { u: 'attacker', exp: Date.now() + 60_000 });
    // 未配置凭据：env 里没有 USERNAME/PASSWORD
    const unconfigured = {} as Bindings;
    expect(await readSession(unconfigured, cookieRequest(forged))).toBeNull();
  });

  it('阳性对照：凭据已配置时，同形令牌用正确口令签发 → 被接受（证明上条不是"一律 null"）', async () => {
    const configured = { USERNAME: 'syncuser', PASSWORD: 'correct-horse-battery-staple' } as Bindings;
    const good = await forgeSessionCookie('correct-horse-battery-staple', {
      u: 'syncuser',
      exp: Date.now() + 60_000,
    });
    const session = await readSession(configured, cookieRequest(good));
    expect(session, '正确口令签发的令牌必须被接受').not.toBeNull();
    expect(session?.username).toBe('syncuser');

    // 同一环境下的空口令令牌仍必须被拒（密钥不同）
    const empty = await forgeSessionCookie('', { u: 'attacker', exp: Date.now() + 60_000 });
    expect(await readSession(configured, cookieRequest(empty))).toBeNull();
  });
});

describe('G1 · 改口令后旧会话立即失效（派生密钥按口令值缓存）', () => {
  it('同一个 env 对象上改口令：旧令牌被拒、新令牌被接受', async () => {
    // 同一个 env 对象 = 「isolate 没换、env 对象也没换」的最坏情形：
    // 按对象（或按 isolate）缓存密钥时，这里会继续用旧口令派生的密钥验签。
    const env = { USERNAME: 'syncuser', PASSWORD: 'first-password-aaaa' } as Bindings;
    const oldToken = await forgeSessionCookie('first-password-aaaa', {
      u: 'syncuser',
      exp: Date.now() + 60_000,
    });
    expect(await readSession(env, cookieRequest(oldToken)), '改口令前应被接受（否则本用例没有判别力）')
      .not.toBeNull();

    env.PASSWORD = 'second-password-bbbb';
    expect(await readSession(env, cookieRequest(oldToken)), '改口令后旧令牌必须立刻失效').toBeNull();

    const newToken = await forgeSessionCookie('second-password-bbbb', {
      u: 'syncuser',
      exp: Date.now() + 60_000,
    });
    expect(await readSession(env, cookieRequest(newToken)), '阳性对照：新口令签发的令牌应被接受')
      .not.toBeNull();
  });
});

describe('G6 · SearchText 上限（按字节）', () => {
  it('48 字节通过、49 字节与多字节超限被拒', () => {
    const ok = 'x'.repeat(MAX_SEARCH_BYTES);
    expect(normalizeSearchText(ok)).toBe(ok);
    expect(() => normalizeSearchText('x'.repeat(MAX_SEARCH_BYTES + 1))).toThrow(/at most 48 bytes/);
    // 24 个中文字符 = 72 字节 > 48 ⇒ 必须按字节判，否则会在 D1 处才炸
    expect(() => normalizeSearchText('中'.repeat(24))).toThrow(/at most 48 bytes/);
    expect(normalizeSearchText('')).toBeNull();
    expect(normalizeSearchText(null)).toBeNull();
  });

  it('UI 入口把超长搜索转成查询错误（路由层 → 400），而不是让它走到 D1', () => {
    expect(() => parseUiHistoryQuery(new URLSearchParams({ search: 'x'.repeat(49) }))).toThrow();
    expect(parseUiHistoryQuery(new URLSearchParams({ search: 'x'.repeat(48) })).search).toBe(
      'x'.repeat(48),
    );
  });

  it('协议入口 POST /api/history/query：49 字节 → 400（修复前会走到 D1 并 500）', async () => {
    // 校验发生在接触 env.DB 之前，故用空 env 即可驱动（若走到 DB 会抛错 → 那就不是 400）
    const app = createHistoryRoutes();
    const fd = new FormData();
    fd.set('SearchText', 'x'.repeat(49));
    const res = await app.request('/api/history/query', { method: 'POST', body: fd }, {} as never);
    expect(res.status, '超长 SearchText 必须在入口被拒为 400').toBe(400);
  });
});

// 限速的**归因制**（本轮加固）：只有拿到 cf-connecting-ip 才启用 IP 维度。该头在生产恒由
// Cloudflare 覆写、客户端不可伪造；缺头时若把请求全塞进同一个 ip:unknown 桶，10 次错凭据
// 就能把所有客户端一起锁 15 分钟（限速是削峰控制、不是鉴权边界）⇒ 不可归因则不封锁。
//
// 注意「归因」有两个维度：IP 与**用户名**。用例 1 用「无 IP 头 + 每次换用户名」制造真正的
// 不可归因流量；用例 2 固定 IP + 每次换用户名，证明该锁仍然生效（否则用例 1 可能只是限速整体失效）。
describe('限速归因制：不可归因不封锁，可归因仍封锁', () => {
  // 必须给真实凭据：未配置时是 500 fail-closed，那是另一条路径（见上面的 G2 用例）。
  const ENV = { USERNAME: 'syncuser', PASSWORD: 'correct-horse-battery-staple', VERSION: '3.2.1' } as never;
  const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
  const worker = async (headers: Record<string, string>) =>
    (await import('../src/index')).default.fetch(
      new Request('https://sync.example.com/api/version', { headers }),
      ENV,
      CTX,
    );
  const wrongAs = (user: string, extra: Record<string, string> = {}) => ({
    authorization: `Basic ${Buffer.from(`${user}:wrong-password`).toString('base64')}`,
    ...extra,
  });

  it('无 cf-connecting-ip + 每次换用户名：连打 20 次仍全 401（不进入可锁桶）', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await worker(wrongAs(`nobody-${Date.now()}-${i}`))).status);
    expect([...new Set(codes)], '不可归因流量不应被封锁').toEqual([401]);
  });

  it('固定 cf-connecting-ip + 每次换用户名：第 11 次起为 429（证明上条不是「限速整体失效」）', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await worker(wrongAs(`nobody-ip-${Date.now()}-${i}`, { 'cf-connecting-ip': ip }))).status);
    }
    expect(codes.slice(0, 10).every((c) => c === 401), `前 10 次应全 401，实际 ${JSON.stringify(codes)}`).toBe(true);
    expect(codes[10]).toBe(429);
    expect(codes[11]).toBe(429);
  });
});
