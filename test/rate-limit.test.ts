// F7 认证失败限速 / F8 明文跳转与 HSTS / F4 来源校验 / F9 请求体上限与长轮询队列封顶 / F11 scheduled 兜底
//
// 全部**进程内**驱动：直接调用 src/index.ts 的 Worker（fetch/scheduled）与 src/durable/SyncClipboardHub.ts
// 的 DO 类，不依赖 8787 常驻实例。理由：这些断言的对象是中间件顺序、限速状态机与连接队列，
// 进程内才能精确控制时间（窗口过期）、客户端 IP 维度与 DO 权威状态。
//
// DO 运行时只有 workerd 提供，故限速的 Worker 侧用一个**与 DO 同语义**的内存 stub
// （复用 src/rateLimit.ts 的纯状态机 applyAuthFailure 与同一套 key 约定），
// 并另有一组针对**真实 DO 类**（new SyncClipboardHub(...)）的端点/队列断言，避免 stub 自说自话。
//
// 限速缓存是 isolate 级（模块级 Map）且本文件所有用例共享同一份模块实例，因此**每个用例用一套
// 独立的身份（用户名 + IP）**；否则上一个用例攒下的失败会把下一个用例的第一个请求打成 429。
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Bindings } from '../src/env';
import {
  AUTH_RATE_LIMIT_BLOCK_MS,
  AUTH_RATE_LIMIT_MAX_FAILURES,
  AUTH_RATE_LIMIT_PATH,
  AUTH_RATE_LIMIT_RANGES,
  AUTH_RATE_LIMIT_STORAGE_KEY,
  DEFAULT_AUTH_RATE_LIMIT_CONFIG,
  applyAuthFailure,
  authRateLimitConfig,
} from '../src/rateLimit';
import type { AuthLimitState } from '../src/rateLimit';
import {
  MAX_QUEUED_BYTES,
  MAX_QUEUED_MESSAGES,
  SyncClipboardHub,
} from '../src/durable/SyncClipboardHub';
import worker from '../src/index';
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES_CEILING,
  MAX_REQUEST_BODY_BYTES_FLOOR,
  maxRequestBodyBytes,
} from '../src/requestLimits';
import { runCleanup } from '../src/cleanup';
import type * as cleanupModule from '../src/cleanup';

// F11 的兜底断言需要让清理真的失败一次；其余用例用手册里的成功返回。
// 部分 mock：仅替换 runCleanup，保留 cleanup.ts 的其它导出（UI 侧读 Meta 键契约）。
vi.mock('../src/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof cleanupModule>();
  return {
    ...actual,
    runCleanup: vi.fn(async () => ({ expired: 0, trimmed: 0, hardDeleted: 0, orphans: 0, batches: 0 })),
  };
});

// 默认身份（不跑限速的用例用：DO/广播/体量上限）
const USER = 'syncuser';
const PASS = 'correct-horse-battery-staple';
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

const seq = { value: 10 };

interface TestIdentity {
  user: string;
  pass: string;
  ip: string;
}

// 每个用例一套独立身份：用户名维度与 IP 维度都必须唯一（见文件头的说明）
function createIdentity(): TestIdentity {
  const n = seq.value++;
  return { user: `syncuser-${n}`, pass: `correct-horse-battery-${n}`, ip: `198.51.100.${n}` };
}

interface TestCtx {
  waitUntil(promise: Promise<unknown>): void;
  /** 等待所有 waitUntil 投递的任务落定（限速上报、DO 清理都是异步投递，不阻塞响应） */
  flush(): Promise<void>;
}

function createCtx(): TestCtx {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    },
    async flush(): Promise<void> {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0));
      }
    },
  };
}

interface AuthLimitResponseBody {
  blocks: Record<string, number>;
  burst: number;
}

// DO stub：与 src/durable/SyncClipboardHub.ts 的 AUTH_RATE_LIMIT_PATH 端点同语义（report/snapshot/clear）
// overrides 用于把「开关型环境变量」（请求体上限、限速四参数）注进 env；不传即默认值。
function createEnv(
  identity?: TestIdentity,
  overrides: Partial<Bindings> = {},
): { env: Bindings; limits: Map<string, AuthLimitState> } {
  const limits = new Map<string, AuthLimitState>();
  let burst = 0;
  const hub = {
    // 真实 DurableObjectStub 同时支持 fetch(request) 与 fetch(url, init) 两种调用形式
    // （src/hub.ts 的 broadcast 与 src/rateLimit.ts 的 callHub 都用后者），stub 必须一并支持，
    // 否则调用会静默落进 catch（限速退化成纯 isolate 内计数，测试假绿）。
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input as RequestInfo, init);
      const body = (await request.json()) as { op: string; keys: string[] };
      const now = Date.now();
      if (body.op === 'report') {
        for (const key of body.keys) {
          limits.set(key, applyAuthFailure(limits.get(key), now));
          burst++;
        }
      } else if (body.op === 'clear') {
        for (const key of body.keys) limits.delete(key);
      }
      const blocks: Record<string, number> = {};
      for (const key of body.keys) {
        const state = limits.get(key);
        if (state !== undefined && state.blockedUntil > now) blocks[key] = state.blockedUntil;
      }
      return Response.json({ blocks, burst });
    },
  };
  const env = {
    DB: {} as never,
    R2: {} as never,
    HUB: { idFromName: (name: string) => name, get: () => hub } as never,
    // 静态资源绑定：本套件打的全是协议路径与 /ui/api/*，界面那三面（/ui、/ui_v1、/ui_v2）走的是
    // 静态资源前缀，因此这里永远不该被调用 —— 一旦被调用就说明路由判据被改坏了，让它显式失败而不是静默通过。
    ASSETS: {
      fetch: () => {
        throw new Error('本套件不该访问静态资源（UI_ENABLED 门控/路由前缀判据变了？）');
      },
    } as unknown as Fetcher,
    VERSION: '3.2.0',
    MAX_SAVED_HISTORY_COUNT: '1000',
    HISTORY_RETENTION_MINUTES: '10080',
    USERNAME: identity?.user ?? USER,
    PASSWORD: identity?.pass ?? PASS,
    ...overrides,
  } satisfies Bindings;
  return { env, limits };
}

function versionRequest(ip: string, user: string, pass: string): Request {
  return new Request('https://sync.example.com/api/version', {
    headers: { 'cf-connecting-ip': ip, authorization: basic(user, pass) },
  });
}

// 直接在 DO stub 上制造封锁（模拟其他 isolate 已经发生的失败流量）
function seedBlocked(limits: Map<string, AuthLimitState>, key: string): void {
  let state: AuthLimitState | undefined;
  for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES; i++) state = applyAuthFailure(state, Date.now());
  limits.set(key, state!);
}

async function fetchWorker(env: Bindings, ctx: TestCtx, request: Request): Promise<Response> {
  return worker.fetch(request, env, ctx as unknown as ExecutionContext);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('F7 认证失败限速', () => {
  it('第 11 次失败 → 429 + Retry-After，且封锁期内的正确凭据同样被拒', async () => {
    const id = createIdentity();
    const { env } = createEnv(id);
    const ctx = createCtx();

    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES; i++) {
      const res = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'wrong-password'));
      expect(res.status, `第 ${i + 1} 次失败不应被限速`).toBe(401);
    }

    const blocked = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'wrong-password'));
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    expect(Number.isSafeInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(AUTH_RATE_LIMIT_BLOCK_MS / 1000));
    // 拒答体与所有维度一致（不泄露「用户名是否存在」，也不泄露哪一维触发封锁）
    expect(await blocked.text()).toBe('Too Many Requests');

    // 预检排在凭据比较之前：封锁期内即使猜中口令也拿不到 200
    const correctWhileBlocked = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, id.pass));
    expect(correctWhileBlocked.status).toBe(429);
  });

  it('正确凭据不计入、会清零，正常同步永不限速', async () => {
    const id = createIdentity();
    const { env } = createEnv(id);
    const ctx = createCtx();

    // 官方客户端那样的高频正确同步（30 次）：一律 200，且一次都不计数
    for (let i = 0; i < 30; i++) {
      const res = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, id.pass));
      expect(res.status, `第 ${i + 1} 次正常同步`).toBe(200);
    }

    // 再攒 5 次失败（若上面 30 次成功被计入，这里会提前触发 429）
    for (let i = 0; i < 5; i++) {
      expect((await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'nope'))).status).toBe(401);
    }

    // 一次成功即清零（若不清零，接下来的第 5 次失败就会触发 429）
    const ok = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, id.pass));
    expect(ok.status).toBe(200);
    await ctx.flush(); // 成功后的 DO clear 是异步投递

    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES; i++) {
      const res = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'nope'));
      expect(res.status, `清零后的第 ${i + 1} 次失败`).toBe(401);
    }
    expect((await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'nope'))).status).toBe(429);
  });

  it('窗口过期后计数与封锁一并重置', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-13T00:00:00.000Z') });
    const id = createIdentity();
    const { env } = createEnv(id);
    const ctx = createCtx();

    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES; i++) {
      expect((await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'nope'))).status).toBe(401);
    }
    expect((await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'nope'))).status).toBe(429);

    // 越过 15 分钟窗口（也是封锁时长）
    vi.setSystemTime(new Date('2026-09-13T00:20:00.000Z'));
    const afterWindow = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'nope'));
    expect(afterWindow.status, '窗口过期后应重新计数（401）而不是继续 429').toBe(401);
    expect((await fetchWorker(env, ctx, versionRequest(id.ip, id.user, id.pass))).status).toBe(200);
  });

  it('DO 侧已封锁的 key 会传到本 isolate（跨 isolate 权威状态）', async () => {
    // 固定时钟：快照拉取有最小间隔（5s），用真实时钟会受前序用例影响而不确定。
    // 关键：日期必须**晚于真实当前时间** —— 限速缓存是模块级共享的，先前用真实时钟的用例
    // 会把 cache.lastSnapshotAt 记成真实 epoch；若本用例的假时钟落在它之前，
    // `now - lastSnapshotAt` 为负 ⇒ 快照间隔判定永远不满足 ⇒ 本用例会假红。
    vi.useFakeTimers({ now: new Date('2030-01-01T03:00:00.000Z') });
    const id = createIdentity();
    const target = createIdentity();
    const { env, limits } = createEnv(id);
    const ctx = createCtx();

    // 本 isolate 先见一次失败 → 进入「热」状态（此后才会按间隔拉 DO 快照）
    expect((await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'nope'))).status).toBe(401);
    await ctx.flush();

    // 另一个 isolate 已把 target.ip 打到封锁（DO 权威状态）
    seedBlocked(limits, `ip:${target.ip}`);

    // 越过 5s 快照间隔：本 isolate 尚不知情，首个请求仍会被比较（同步预检无 I/O），但已异步拉取快照
    vi.setSystemTime(new Date('2030-01-01T03:00:06.000Z'));
    const first = await fetchWorker(env, ctx, versionRequest(target.ip, id.user, id.pass));
    expect(first.status).toBe(200);
    await ctx.flush();

    // 快照合并后：该 key 的请求（哪怕凭据正确）在凭据比较之前就被拒
    vi.setSystemTime(new Date('2030-01-01T03:00:07.000Z'));
    const second = await fetchWorker(env, ctx, versionRequest(target.ip, id.user, id.pass));
    expect(second.status).toBe(429);
  });

  it('登录端点（凭据在 body 里）同样限速，尾斜杠变体不能绕过', async () => {
    const id = createIdentity();
    const { env } = createEnv(id);
    const ctx = createCtx();
    const login = (path: string) =>
      fetchWorker(
        env,
        ctx,
        new Request(`https://sync.example.com${path}`, {
          method: 'POST',
          body: JSON.stringify({ username: id.user, password: 'wrong-password' }),
          headers: { 'cf-connecting-ip': id.ip, 'content-type': 'application/json' },
        }),
      );

    // 前 9 次走标准路径、第 10 次走尾斜杠变体（Hono strict:false 下同一 handler）——两者共享计数
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES - 1; i++) {
      expect((await login('/ui/api/login')).status, `第 ${i + 1} 次登录失败`).toBe(401);
    }
    expect((await login('/ui/api/login/')).status).toBe(401);

    const blocked = await login('/ui/api/login');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // 正确的表单凭据在封锁期内同样被拒（预检在凭据比较之前）
    const correctWhileBlocked = await fetchWorker(
      env,
      ctx,
      new Request('https://sync.example.com/ui/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: id.user, password: id.pass }),
        headers: { 'cf-connecting-ip': id.ip, 'content-type': 'application/json' },
      }),
    );
    expect(correctWhileBlocked.status).toBe(429);
  });

  it('未配置凭据仍走 500 fail-closed（不进入限速逻辑）', async () => {
    const id = createIdentity();
    const { env } = createEnv(id);
    const ctx = createCtx();
    const unconfigured = { ...env, USERNAME: '', PASSWORD: '' } as Bindings;
    const res = await fetchWorker(unconfigured, ctx, versionRequest(id.ip, '', ''));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('USERNAME and PASSWORD');
  });

  it('弱凭据只告警不阻断（F1）；ENFORCE_STRONG_CREDENTIALS=true 时 fail-closed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const strong = createIdentity();
    const weakIdentity = createIdentity();
    const { env } = createEnv(strong);
    const ctx = createCtx();
    const weak = { ...env, USERNAME: 'admin', PASSWORD: 'admin' } as Bindings;

    const strongRes = await fetchWorker(env, ctx, versionRequest(strong.ip, strong.user, strong.pass));
    expect(strongRes.status).toBe(200);
    const weakRes = await fetchWorker(weak, ctx, versionRequest(weakIdentity.ip, 'admin', 'admin'));
    expect(weakRes.status, '默认不阻断服务').toBe(200);
    expect(weakRes.headers.get('x-credential-warning'), '弱凭据给出机器可读信号').toBe('weak');
    expect(strongRes.headers.get('x-credential-warning')).toBeNull();
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('[security] weak credentials'))).toBe(true);

    const enforced = { ...weak, ENFORCE_STRONG_CREDENTIALS: 'true' } as Bindings;
    const enforcedRes = await fetchWorker(enforced, ctx, versionRequest(weakIdentity.ip, 'admin', 'admin'));
    expect(enforcedRes.status).toBe(500);
    expect(await enforcedRes.text()).toContain('too weak');
  });
});

describe('F4 /ui/api/* 状态变更端点的来源校验', () => {
  const PATCH_PATH = '/ui/api/history/Text-0123456789ABCDEF0123456789ABCDEF';

  function patch(extra: Record<string, string>, ip: string): Request {
    return new Request(`https://sync.example.com${PATCH_PATH}`, {
      method: 'PATCH',
      body: JSON.stringify({ isDelete: true }),
      headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json', ...extra },
    });
  }

  it('外源 Origin → 403', async () => {
    const { env } = createEnv();
    const res = await fetchWorker(env, createCtx(), patch({ origin: 'https://evil.example' }, createIdentity().ip));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_rejected' });
  });

  it('Sec-Fetch-Site: cross-site → 403', async () => {
    const { env } = createEnv();
    const res = await fetchWorker(
      env,
      createCtx(),
      patch({ 'sec-fetch-site': 'cross-site' }, createIdentity().ip),
    );
    expect(res.status).toBe(403);
  });

  it('带有效 Basic 凭据的跨站写同样 403（沉淀的凭据不能绕过来源校验）', async () => {
    const identity = createIdentity();
    const { env } = createEnv(identity);
    const res = await fetchWorker(
      env,
      createCtx(),
      patch(
        { origin: 'https://evil.example', authorization: basic(identity.user, identity.pass) },
        identity.ip,
      ),
    );
    expect(res.status).toBe(403);
  });

  it('无 Origin 的 CLI 客户端放行（未被 403 拦，落到鉴权 401）', async () => {
    const { env } = createEnv();
    const res = await fetchWorker(env, createCtx(), patch({}, createIdentity().ip));
    expect(res.status).toBe(401);
  });

  it('同源 Origin（含显式默认端口）放行', async () => {
    const { env } = createEnv();
    const exact = await fetchWorker(
      env,
      createCtx(),
      patch({ origin: 'https://sync.example.com' }, createIdentity().ip),
    );
    expect(exact.status).toBe(401);
    const defaultPort = await fetchWorker(
      env,
      createCtx(),
      patch({ origin: 'https://sync.example.com:443' }, createIdentity().ip),
    );
    expect(defaultPort.status).toBe(401);
  });

  it('GET 不做来源校验（跨站读不被本中间件拦）', async () => {
    const { env } = createEnv();
    const res = await fetchWorker(
      env,
      createCtx(),
      new Request(`https://sync.example.com${PATCH_PATH}`, {
        headers: { 'cf-connecting-ip': createIdentity().ip, origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('G3 · batch-update 只接受 application/json', () => {
  function batch(contentType: string, body: string, identity: TestIdentity): Request {
    return new Request('https://sync.example.com/ui/api/history/batch-update', {
      method: 'POST',
      body,
      headers: {
        authorization: basic(identity.user, identity.pass),
        'cf-connecting-ip': identity.ip,
        'content-type': contentType,
      },
    });
  }

  it('跨站表单能发出的两种内容类型（text/plain、multipart/form-data）→ 415', async () => {
    for (const type of ['text/plain', 'multipart/form-data; boundary=x']) {
      const identity = createIdentity();
      const { env } = createEnv(identity);
      const res = await fetchWorker(env, createCtx(), batch(type, 'items=1', identity));
      expect(res.status, `${type} 不应被当作 JSON 请求处理`).toBe(415);
      expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
    }
  });

  it('阳性对照：application/json 通过内容类型检查（走到业务层 → 400 参数错，而不是 415）', async () => {
    const identity = createIdentity();
    const { env } = createEnv(identity);
    const res = await fetchWorker(env, createCtx(), batch('application/json', '{}', identity));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'items_required' });
  });
});

describe('F8 明文跳转与 HSTS', () => {
  it('明文 + 非 loopback host → 301 到同路径 https', async () => {
    const id = createIdentity();
    const { env } = createEnv(id);
    const res = await fetchWorker(
      env,
      createCtx(),
      new Request('http://sync.example.com/api/version', {
        headers: { 'cf-connecting-ip': id.ip, 'x-forwarded-proto': 'http', authorization: basic(id.user, id.pass) },
      }),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://sync.example.com/api/version');
  });

  it('本地开发（loopback）既不跳转也不加 HSTS', async () => {
    const id = createIdentity();
    const { env } = createEnv(id);
    const res = await fetchWorker(
      env,
      createCtx(),
      new Request('http://127.0.0.1:8787/api/version', {
        headers: { 'cf-connecting-ip': id.ip, 'x-forwarded-proto': 'http', authorization: basic(id.user, id.pass) },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect(await res.text()).toBe('3.2.0');
  });

  it('经边缘（cf-ray / x-forwarded-proto: https）的响应带 HSTS', async () => {
    const id = createIdentity();
    const { env } = createEnv(id);
    const viaCfRay = await fetchWorker(
      env,
      createCtx(),
      new Request('https://sync.example.com/api/version', {
        headers: { 'cf-connecting-ip': id.ip, 'cf-ray': '9c0ffee12345-SJC', authorization: basic(id.user, id.pass) },
      }),
    );
    expect(viaCfRay.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    const viaProto = await fetchWorker(
      env,
      createCtx(),
      new Request('https://sync.example.com/api/version', {
        headers: {
          'cf-connecting-ip': id.ip,
          'x-forwarded-proto': 'https',
          authorization: basic(id.user, id.pass),
        },
      }),
    );
    expect(viaProto.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });
});

describe('F9 请求体上限（413）', () => {
  const oversize = String(MAX_REQUEST_BODY_BYTES + 1);
  it('会把整包读入内存 / 会消费大对象的写端点都按 content-length 快速 413', async () => {    const { env } = createEnv();
    const cases: Array<{ method: string; path: string }> = [
      { method: 'PUT', path: '/SyncClipboard.json' },
      { method: 'POST', path: '/api/history' },
      { method: 'PATCH', path: '/api/history/Text-0123456789ABCDEF0123456789ABCDEF' },
      // 暂存端点本身是流式的，但它一起限：否则"流式暂存大对象 + 小 JSON 提交"会绕过
      // 请求头预检，让落库那步在 arrayBuffer() 处 OOM（真实护栏见 src/profile.ts）
      { method: 'PUT', path: '/file/big.bin' },
    ];
    for (const item of cases) {
      const res = await fetchWorker(
        env,
        createCtx(),
        new Request(`https://sync.example.com${item.path}`, {
          method: item.method,
          body: 'x',
          headers: { authorization: basic(USER, PASS), 'content-length': oversize },
        }),
      );
      expect(res.status, `${item.method} ${item.path}`).toBe(413);
    }
  });

  it('登录端点的超大体量同样 413（该路径的 body 会被中间件读取）', async () => {
    const { env } = createEnv();
    const res = await fetchWorker(
      env,
      createCtx(),
      new Request('https://sync.example.com/ui/api/login', {
        method: 'POST',
        body: 'x',
        headers: { 'content-length': oversize },
      }),
    );
    expect(res.status).toBe(413);
  });

  it('恰好等于上限不拦（落到鉴权），列表外的端点不受影响', async () => {
    const { env } = createEnv();
    const atLimit = await fetchWorker(
      env,
      createCtx(),
      new Request('https://sync.example.com/api/history', {
        method: 'POST',
        body: 'x',
        headers: { 'content-length': String(MAX_REQUEST_BODY_BYTES) },
      }),
    );
    expect(atLimit.status).toBe(401); // 未带凭据 → 鉴权拒绝（说明体量预检没误伤）
    const otherRoute = await fetchWorker(
      env,
      createCtx(),
      new Request('https://sync.example.com/SyncClipboard.json', {
        method: 'POST',
        body: 'x',
        headers: { 'content-length': oversize },
      }),
    );
    expect(otherRoute.status).toBe(401); // 同 path 但方法不在列表 → 不限体量
  });
});

describe('F9 长轮询队列封顶（真实 DO 类）', () => {
  // P1（WS 迁 Hibernation API，docs/design.md D42）之后 DO 会调 `state.acceptWebSocket` /
  // `state.getWebSockets`（`clientCount()` 与 `scheduleHeartbeat()` 都要用），以及
  // `storage.getAlarm()`（心跳防重排判据）⇒ 夹具必须一并实现，否则这组用例直接 TypeError
  // （桩与真实接口不一致，不是被测量行为）。
  // 限速快照改成**按需加载**（`loadAuthLimitsOnce`）后，构造函数不再调 `blockConcurrencyWhile`；
  // 夹具仍实现它 —— 真实的 `DurableObjectState` 一定有此成员，桩缺了会让「DO 类在别处用到它」
  // 变成 TypeError（同上：桩与真实接口不一致，不是被测量行为）。
  // `seed` 预置 storage（例如**上一版遗留的**限速快照形态）；`peek` 回传同一份 Map，供断言落盘内容。
  function createDoState(
    seed: Record<string, unknown> = {},
    peek?: { storage?: Map<string, unknown> },
  ): DurableObjectState {
    const storage = new Map<string, unknown>(Object.entries(seed));
    if (peek) peek.storage = storage;
    const sockets: WebSocket[] = [];
    return {
      blockConcurrencyWhile: async (callback: () => Promise<unknown>) => callback(),
      acceptWebSocket: (ws: WebSocket) => {
        sockets.push(ws);
      },
      getWebSockets: () => sockets,
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => {
          storage.set(key, value);
        },
        delete: async (key: string) => storage.delete(key),
        list: async () => new Map(),
        setAlarm: async () => {},
        getAlarm: async () => null,
      },
    } as unknown as DurableObjectState;
  }

  function hubClientRequest(id: string): Request {
    return new Request(`https://hub/SyncClipboardHub?id=${id}`, {
      headers: { authorization: basic(USER, PASS) },
    });
  }

  async function broadcastTo(hub: SyncClipboardHub, payload: string): Promise<Response> {
    return hub.fetch(
      new Request('https://hub/broadcast', {
        method: 'POST',
        headers: { authorization: basic(USER, PASS) },
        body: JSON.stringify({ target: 'RemoteHistoryChanged', payload }),
      }),
    );
  }

  it('排队消息数超过上限 → 关闭连接（204）并记录日志', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { env } = createEnv();
    const hub = new SyncClipboardHub(createDoState(), env);

    // 首个 GET 只建立连接并立即返回（与 ASP.NET 一致），此时没有挂起的轮询 → 后续消息全部入队
    expect((await hub.fetch(hubClientRequest('lp-many'))).status).toBe(200);
    for (let i = 0; i <= MAX_QUEUED_MESSAGES; i++) {
      expect((await broadcastTo(hub, `m${i}`)).status).toBe(200);
    }
    expect(logs.mock.calls.some((call) => String(call[0]).startsWith('[hub] queue overflow'))).toBe(true);
    // 超限即「服务端关闭」：后续轮询 204（不发明新状态码）
    expect((await hub.fetch(hubClientRequest('lp-many'))).status).toBe(204);
  });

  it('单条超大消息触发字节上限', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { env } = createEnv();
    const hub = new SyncClipboardHub(createDoState(), env);

    expect((await hub.fetch(hubClientRequest('lp-big'))).status).toBe(200);
    expect((await broadcastTo(hub, 'x'.repeat(MAX_QUEUED_BYTES + 1))).status).toBe(200);
    expect(logs.mock.calls.some((call) => String(call[0]).startsWith('[hub] queue overflow'))).toBe(true);
    expect((await hub.fetch(hubClientRequest('lp-big'))).status).toBe(204);
  });

  it('一次请求投递整批（ADR D33）：消息仍**逐条**入队，内容与顺序不变', async () => {
    const { env } = createEnv();
    const hub = new SyncClipboardHub(createDoState(), env);
    expect((await hub.fetch(hubClientRequest('lp-batch'))).status).toBe(200);

    // 批量写的广播形态：一次子请求带多个载荷（100 条批量写从 100 次 DO 调用降到 1 次）。
    // 这里钉的是**合并不许改变消息**：三条独立消息、按序到达，而不是一条把三个拼起来。
    const res = await hub.fetch(
      new Request('https://hub/broadcast', {
        method: 'POST',
        headers: { authorization: basic(USER, PASS) },
        body: JSON.stringify({ target: 'RemoteHistoryChanged', payloads: ['b1', 'b2', 'b3'] }),
      }),
    );
    expect(res.status).toBe(200);

    const body = await (await hub.fetch(hubClientRequest('lp-batch'))).text();
    expect(body.match(/RemoteHistoryChanged/g)?.length, '三条独立消息').toBe(3);
    const positions = ['b1', 'b2', 'b3'].map((m) => body.indexOf(m));
    expect(positions.every((i) => i >= 0), '三个载荷都在').toBe(true);
    expect(positions, '按入参顺序').toEqual([...positions].sort((a, b) => a - b));
  });

  it('未超限的消息仍按原语义整批取回', async () => {
    const { env } = createEnv();
    const hub = new SyncClipboardHub(createDoState(), env);
    expect((await hub.fetch(hubClientRequest('lp-ok'))).status).toBe(200);
    await broadcastTo(hub, 'm1');
    await broadcastTo(hub, 'm2');
    const poll = await hub.fetch(hubClientRequest('lp-ok'));
    expect(poll.status).toBe(200);
    const body = await poll.text();
    expect(body).toContain('m1');
    expect(body).toContain('m2');
  });

  it('Hub 连接鉴权失败同样限速（WS/SSE/长轮询不走 Worker 中间件）', async () => {
    const { env } = createEnv();
    const hub = new SyncClipboardHub(createDoState(), env);
    const bad = () =>
      hub.fetch(
        new Request('https://hub/SyncClipboardHub?id=lp-auth', {
          headers: { authorization: basic('admin', 'wrong'), 'cf-connecting-ip': '203.0.113.99' },
        }),
      );

    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES; i++) {
      expect((await bad()).status, `第 ${i + 1} 次错误凭据`).toBe(401);
    }
    const blocked = await bad();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // 封锁只针对失败维度：携带正确凭据的正常客户端不受影响（不同 IP 键 + 正确凭据）
    const legit = await hub.fetch(
      new Request('https://hub/SyncClipboardHub?id=lp-legit', {
        headers: { authorization: basic(USER, PASS), 'cf-connecting-ip': '203.0.113.100' },
      }),
    );
    expect(legit.status).toBe(200);
  });

  it('AUTH_RATE_LIMIT_PATH 端点：report 累计到阈值才封锁、snapshot 只读、clear 清空', async () => {
    const { env } = createEnv();
    const hub = new SyncClipboardHub(createDoState(), env);
    const call = (op: string, keys: string[]) =>
      hub.fetch(
        new Request(`https://hub${AUTH_RATE_LIMIT_PATH}`, { method: 'POST', body: JSON.stringify({ op, keys }) }),
      );

    const key = 'ip:203.0.113.7';
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES - 1; i++) {
      const res = await call('report', [key]);
      expect((await res.json<AuthLimitResponseBody>()).blocks).toEqual({});
    }
    const atThreshold = await (await call('report', [key])).json<AuthLimitResponseBody>();
    expect(Object.keys(atThreshold.blocks)).toEqual([key]);

    // snapshot 是只读的：不累计计数
    const snapshot = await (await call('snapshot', ['ip:203.0.113.8'])).json<AuthLimitResponseBody>();
    expect(snapshot.blocks).toEqual({});
    const stillBlocked = await (await call('snapshot', [key])).json<AuthLimitResponseBody>();
    expect(Object.keys(stillBlocked.blocks)).toEqual([key]);

    const cleared = await (await call('clear', [key])).json<AuthLimitResponseBody>();
    expect(cleared.blocks).toEqual({});
  });

  // 落盘形态的**形状守卫**（2026-09-25）：形态在本分支里改过一次（旧版是平铺的
  // `Record<string, AuthLimitState>`，新版是 `{persistedAt, limits}`），而生产 DO 存储里可能
  // 还留着旧值 ⇒ 没有守卫时 `Object.entries(saved.limits)` 会抛 TypeError 并被静默 catch。
  // 这一组是那条路径的**正对照（新形态被采信）与迁移（旧形态按空表起算、下一次落盘自愈）**。
  it('新形态快照 {persistedAt, limits} 被采信：封锁跨实例恢复（形状守卫的正对照）', async () => {
    const { env } = createEnv();
    const key = 'ip:203.0.113.51';
    const blockedUntil = Date.now() + AUTH_RATE_LIMIT_BLOCK_MS;
    const state = createDoState({
      [AUTH_RATE_LIMIT_STORAGE_KEY]: {
        persistedAt: Date.now(),
        limits: { [key]: { windowStart: Date.now(), count: AUTH_RATE_LIMIT_MAX_FAILURES, blockedUntil } },
      },
    });
    const hub = new SyncClipboardHub(state, env);
    const res = await hub.fetch(
      new Request(`https://hub${AUTH_RATE_LIMIT_PATH}`, { method: 'POST', body: JSON.stringify({ op: 'snapshot', keys: [key] }) }),
    );
    expect((await res.json<AuthLimitResponseBody>()).blocks).toEqual({ [key]: blockedUntil });
  });

  it('旧版平铺形态被识别为「无快照」：不采信、告警一次，下一次落盘即迁到新形态', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = createEnv();
    const key = 'ip:203.0.113.52';
    const peek: { storage?: Map<string, unknown> } = {};
    // 旧版落盘形态：平铺表，且里面有一条「已封锁」的记录
    const legacy = { [key]: { windowStart: Date.now(), count: 99, blockedUntil: Date.now() + AUTH_RATE_LIMIT_BLOCK_MS } };
    const hub = new SyncClipboardHub(createDoState({ [AUTH_RATE_LIMIT_STORAGE_KEY]: legacy }, peek), env);
    const call = (op: string, keys: string[]) =>
      hub.fetch(new Request(`https://hub${AUTH_RATE_LIMIT_PATH}`, { method: 'POST', body: JSON.stringify({ op, keys }) }));

    // 旧形态不被采信 ⇒ 按空表起算（代价与既有取舍同侧：最坏多给阈值次失败），并留下一条可查的告警
    expect((await (await call('snapshot', [key])).json<AuthLimitResponseBody>()).blocks).toEqual({});
    expect(warn.mock.calls.some((c) => String(c[0]).includes('authRateLimits'))).toBe(true);

    // 下一次落盘写回新形态（自愈）
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES; i++) await call('report', [key]);
    const persisted = peek.storage?.get(AUTH_RATE_LIMIT_STORAGE_KEY) as
      | { persistedAt?: unknown; limits?: Record<string, unknown> }
      | undefined;
    expect(typeof persisted?.persistedAt).toBe('number');
    expect(Object.keys(persisted?.limits ?? {})).toEqual([key]);

    // 这份新快照能被同一个守卫读回（换一个实例 ⇒ 走一次真实的按需加载）
    const rebooted = new SyncClipboardHub(createDoState({ [AUTH_RATE_LIMIT_STORAGE_KEY]: persisted }, {}), env);
    const after = await rebooted.fetch(
      new Request(`https://hub${AUTH_RATE_LIMIT_PATH}`, { method: 'POST', body: JSON.stringify({ op: 'snapshot', keys: [key] }) }),
    );
    expect(Object.keys((await after.json<AuthLimitResponseBody>()).blocks)).toEqual([key]);
  });
});

describe('F11 scheduled 兜底', () => {
  it('清理抛错时 scheduled 不产生未捕获拒绝，并留下 [cleanup] fatal 日志', async () => {
    vi.mocked(runCleanup).mockRejectedValueOnce(new Error('injected cleanup failure'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = createEnv();
    const ctx = createCtx();

    await expect(
      worker.scheduled({} as ScheduledController, env, ctx as unknown as ExecutionContext),
    ).resolves.toBeUndefined();
    await ctx.flush();

    expect(errorLog.mock.calls.some((call) => call[0] === '[cleanup] fatal')).toBe(true);
  });

  it('清理正常时记录一行可观测的 [cleanup] 汇总', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { env } = createEnv();
    const ctx = createCtx();

    await worker.scheduled({} as ScheduledController, env, ctx as unknown as ExecutionContext);
    await ctx.flush();

    expect(log.mock.calls.some((call) => String(call[0]).startsWith('[cleanup] expired='))).toBe(true);
  });
});

// 2026-09-15：这两个旋钮可由 GitHub 仓库变量覆盖（见 README「部署开关」）。
// 限速四参数在文档里明确写着**不建议变化**，所以这里既钉住"能改"，也钉住"非法值不改变可用性"。
describe('环境变量覆盖：请求体上限 / 限速参数', () => {
  it('maxRequestBodyBytes：仅接受 [FLOOR, CEILING] 内的整数，其余一律回落默认值', () => {
    expect(maxRequestBodyBytes({})).toBe(MAX_REQUEST_BODY_BYTES);
    expect(maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: '' })).toBe(MAX_REQUEST_BODY_BYTES);
    expect(maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: '  ' })).toBe(MAX_REQUEST_BODY_BYTES);
    // 合法覆盖（正常同步 40MB 文件的场景）
    expect(maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: '41943040' })).toBe(41943040);
    expect(maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: String(MAX_REQUEST_BODY_BYTES_FLOOR) })).toBe(
      MAX_REQUEST_BODY_BYTES_FLOOR,
    );
    expect(maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: String(MAX_REQUEST_BODY_BYTES_CEILING) })).toBe(
      MAX_REQUEST_BODY_BYTES_CEILING,
    );
    // 非法/越界 → 默认（**不** fail-closed：配置写错不该把写请求全打死）
    for (const bad of [
      'abc',
      '1.5',
      '-1',
      '0',
      String(MAX_REQUEST_BODY_BYTES_FLOOR - 1),
      String(MAX_REQUEST_BODY_BYTES_CEILING + 1),
      '999999999999',
    ]) {
      expect(maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: bad }), bad).toBe(MAX_REQUEST_BODY_BYTES);
    }
  });

  it('authRateLimitConfig：逐字段校验，坏字段单独回落（好字段不受牵连）', () => {
    expect(authRateLimitConfig({})).toEqual(DEFAULT_AUTH_RATE_LIMIT_CONFIG);
    expect(authRateLimitConfig({ AUTH_RATE_LIMIT_MAX_FAILURES: '5' }).maxFailures).toBe(5);
    // 窗口合法、失败数越界：只有越界那个字段回落
    const mixed = authRateLimitConfig({
      AUTH_RATE_LIMIT_WINDOW_MS: '60000',
      AUTH_RATE_LIMIT_MAX_FAILURES: '1000',
    });
    expect(mixed.windowMs).toBe(60000);
    expect(mixed.maxFailures).toBe(DEFAULT_AUTH_RATE_LIMIT_CONFIG.maxFailures);
    // 每个字段的边界都按同一张表校验
    for (const key of Object.keys(AUTH_RATE_LIMIT_RANGES) as Array<keyof typeof AUTH_RATE_LIMIT_RANGES>) {
      const { min, max } = AUTH_RATE_LIMIT_RANGES[key];
      const varName = {
        windowMs: 'AUTH_RATE_LIMIT_WINDOW_MS',
        maxFailures: 'AUTH_RATE_LIMIT_MAX_FAILURES',
        blockMs: 'AUTH_RATE_LIMIT_BLOCK_MS',
        burstWarn: 'AUTH_RATE_LIMIT_BURST_WARN',
      }[key];
      expect(authRateLimitConfig({ [varName]: String(min) })[key], `${varName}=${min}`).toBe(min);
      expect(authRateLimitConfig({ [varName]: String(max) })[key], `${varName}=${max}`).toBe(max);
      expect(authRateLimitConfig({ [varName]: String(min - 1) })[key], `${varName}=${min - 1}`).toBe(
        DEFAULT_AUTH_RATE_LIMIT_CONFIG[key],
      );
      expect(authRateLimitConfig({ [varName]: String(max + 1) })[key], `${varName}=${max + 1}`).toBe(
        DEFAULT_AUTH_RATE_LIMIT_CONFIG[key],
      );
      expect(authRateLimitConfig({ [varName]: 'xyz' })[key], `${varName}=xyz`).toBe(
        DEFAULT_AUTH_RATE_LIMIT_CONFIG[key],
      );
    }
  });

  it('MX：把上限调到 1MiB 后，2MiB 的写请求 413；512KiB 的请求放行到鉴权（401）', async () => {
    const oneMiB = 1024 * 1024;
    const { env } = createEnv(undefined, { MAX_REQUEST_BODY_BYTES: String(oneMiB) });
    const put = (contentLength: number) =>
      fetchWorker(
        env,
        createCtx(),
        new Request('https://sync.example.com/SyncClipboard.json', {
          method: 'PUT',
          body: 'x',
          headers: { authorization: basic(USER, 'wrong'), 'content-length': String(contentLength) },
        }),
      );
    // 超过覆盖后的上限 → 413（说明覆盖真的生效，而不是仍按默认 32MiB 放行）
    expect((await put(2 * oneMiB)).status).toBe(413);
    // 未超过 → 不被 413 拦，落到鉴权失败（401）。用错口令是为了不碰 DB/R2。
    expect((await put(oneMiB / 2)).status).toBe(401);
  });

  it('MX：把失败阈值调到 3 后，第 4 次失败即 429（默认要第 11 次）', async () => {
    const id = createIdentity();
    const { env } = createEnv(id, { AUTH_RATE_LIMIT_MAX_FAILURES: '3' });
    const ctx = createCtx();
    for (let i = 0; i < 3; i++) {
      const res = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'wrong-password'));
      expect(res.status, `第 ${i + 1} 次失败`).toBe(401);
    }
    const blocked = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'wrong-password'));
    expect(blocked.status, '第 4 次失败应命中覆盖后的阈值').toBe(429);
  });

  it('MX：阈值写坏时回落默认（第 11 次才封锁）—— 配置失误不改变可用性', async () => {
    const id = createIdentity();
    const { env } = createEnv(id, { AUTH_RATE_LIMIT_MAX_FAILURES: '0' });
    const ctx = createCtx();
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_FAILURES; i++) {
      const res = await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'wrong-password'));
      expect(res.status, `第 ${i + 1} 次失败`).toBe(401);
    }
    expect((await fetchWorker(env, ctx, versionRequest(id.ip, id.user, 'wrong-password'))).status).toBe(429);
  });
});
