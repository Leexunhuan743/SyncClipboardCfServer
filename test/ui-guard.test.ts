// `/ui/api/*` 鉴权的**注册顺序**回归防护（审计 cfserver-audit-003 §七·5）。
//
// 不变式：`/ui/api/*` 下除三条有意公开的端点外，**未携带凭据（会话 Cookie / Basic）的请求一律 401**。
// 这条不变式目前不由每条路由自带——受保护路由自己不做鉴权，它来自
// `guarded.use('/ui/api/*', uiAuthMiddleware())` 注册在受保护路由**之前**这一顺序。
// 于是把该 use 下移、或把守卫作用域收窄成具体路径，鉴权就会**静默失效**：端点照常工作，
// 只是不再要求凭据。既有功能测试都带着凭据打真实服务器，因此不会红，代码评审也看不出来。
//
// 做法：不硬编码「哪条路由该 401」，而是读 Hono 的注册表（`app.routes`）**枚举**应用上实际注册的
// 每条 `/ui/api/*` 具体路由，逐条发一次不带 Cookie/Authorization 的真实请求
// （进程内 `app.request`，不依赖 8787 常驻实例），只对白名单网开一面。
// 新增路由若忘了分类 → 默认按受保护断言 → 红；把 use 下移 → 受保护路由拿不到 401 → 红。
import { describe, expect, it } from 'vitest';
import { createUiRoutes } from '../src/ui/routes';
import type { Bindings } from '../src/env';
import worker from '../src/index';
import { isUiEnabled } from '../src/uiEnabled';

const USER = 'guard-probe-user';
const PASS = 'guard-probe-password';

// 只填鉴权相关字段：本套件打的是**未认证**请求，守卫在碰 DB/R2 之前就拒答；三条公开端点也走
// 「不读库」的分支（login 用正确凭据签发 Cookie，logout/session 不读库）。缺 DB/R2 是刻意的：
// 万一某条受保护路由漏挂守卫，它会因绑定缺失抛错被 Hono 转成 500 —— 同样不是 401，测试照样红，
// 不会出现「因为拿不到绑定所以碰巧通过」的假绿。
const ENV = { USERNAME: USER, PASSWORD: PASS, VERSION: 'guard-test' } as unknown as Bindings;

// 守卫的拒答体（src/ui/guard.ts 的 uiUnauthorized）。用它把「守卫拒答」与「业务 401」区分开：
// 例如 login 用错凭据时返回的 {"error":"invalid_credentials"} 也是 401，但那证明不了守卫在位。
const GUARD_REJECTION = JSON.stringify({ error: 'unauthorized' });

// 有意公开的三条端点（源码里各自有注释记录理由：登录、登出、会话探测）。
// 探针请求逐条给出：login 必须带**正确**凭据 —— 否则它自身的错误凭据分支也是 401，
// 无法区分「守卫放行后的业务 401」与「守卫拒答」，而判定后者正是本测试的目的。
const PUBLIC_PROBES: Record<string, RequestInit> = {
  'POST /ui/api/login': {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  },
  'POST /ui/api/logout': { method: 'POST' },
  'GET /ui/api/session': { method: 'GET' },
};

// `/ui/api/*` 的全部具体路由（方法 + 路径）。既是「每条路由都必须被分类」的清单——
// 新增/删除端点会在这里显现，逼迫改动者在 EXPECTED_API_ROUTES 清单与 PUBLIC_PROBES 白名单之间做选择——
// 也是**枚举有效性**的哨兵：Hono 换了路由表形态、或过滤条件写错时这里立刻红，
// 而不是遍历 0 条路由后假绿。
const EXPECTED_API_ROUTES: readonly string[] = [
  'POST /ui/api/login',
  'POST /ui/api/logout',
  'GET /ui/api/session',
  'GET /ui/api/history',
  'GET /ui/api/history/:type/:hash',
  'GET /ui/api/history/:type/:hash/data',
  'PATCH /ui/api/history/:type/:hash',
  'POST /ui/api/history/batch-update',
  'POST /ui/api/history/batch-meta',
  'POST /ui/api/history/clear',
  'POST /ui/api/hub-ticket',
  'GET /ui/api/statistics',
  'GET /ui/api/overview',
  'GET /ui/api/activity',
  'GET /ui/api/info',
  'GET /ui/api/poll',
  'GET /ui/api/integrity',
  'PUT /ui/api/settings',
];

describe('/ui/api/* 鉴权不因注册顺序静默失效（遍历式回归）', () => {
  const app = createUiRoutes();
  const apiEntries = app.routes.filter((r) => r.path.startsWith('/ui/api/'));
  const concrete = apiEntries.filter((r) => !r.path.includes('*'));
  const wildcard = apiEntries.filter((r) => r.path.includes('*'));

  it('盘点：具体路由集合与分类清单一致，通配条目只有守卫与命名空间兜底', () => {
    expect(
      concrete.map((r) => `${r.method} ${r.path}`).sort(),
      '注册的 /ui/api/* 具体路由与清单不一致：新增/删除端点必须先在 EXPECTED_API_ROUTES 登记，公开端点还要进 PUBLIC_PROBES',
    ).toEqual([...EXPECTED_API_ROUTES].sort());

    // 通配条目 = 缓存策略中间件（`no-store`）+ 守卫中间件 + `/ui/api/*` 的 JSON 404 兜底，三者都是 ALL 方法。
    // 带具体方法的通配路由意味着「守卫之外的宽匹配」，必须显式分类，故这里直接拒绝。
    expect(
      wildcard.map((r) => `${r.method} ${r.path}`),
      '出现未分类的通配路由（守卫之外的宽匹配）',
    ).toEqual(['ALL /ui/api/*', 'ALL /ui/api/*', 'ALL /ui/api/*']);
  });

  it('未带凭据：白名单外一律 401，白名单内不被拦', async () => {
    const leaked: string[] = []; // 受保护路由没有 401
    const notGuard: string[] = []; // 401 了，但不是守卫的拒答（鉴权来源不明）
    const blocked: string[] = []; // 公开端点被守卫拦下

    for (const route of concrete) {
      const key = `${route.method} ${route.path}`;
      const isPublic = key in PUBLIC_PROBES;
      // `:param` 换成固定占位段：守卫只看路径前缀，参数值取什么都不影响本测试的判定
      const path = route.path.replace(/:[^/]+/g, 'guard-probe');
      const res = await app.request(path, PUBLIC_PROBES[key] ?? { method: route.method }, ENV);
      const body = await res.text();

      if (isPublic) {
        if (res.status >= 400) blocked.push(`${key} → ${res.status} ${body.slice(0, 120)}`);
        continue;
      }
      if (res.status !== 401) leaked.push(`${key} → ${res.status} ${body.slice(0, 120)}`);
      else if (body !== GUARD_REJECTION) notGuard.push(`${key} → 401 ${body.slice(0, 120)}`);
    }

    expect(
      leaked,
      `以下受保护路由在未带凭据时可访问（守卫可能已被下移到路由之后、或被收窄作用域）：\n${leaked.join('\n')}`,
    ).toEqual([]);
    expect(
      notGuard,
      `以下路由的 401 响应体不是守卫的拒答体（401 来源不明，无法证明守卫在位）：\n${notGuard.join('\n')}`,
    ).toEqual([]);
    expect(
      blocked,
      `以下有意公开的端点被守卫拦下了（公开端点必须在 guarded 之外注册）：\n${blocked.join('\n')}`,
    ).toEqual([]);
  });

  it('守卫覆盖整个命名空间：未注册的 /ui/api/* 路径同样不经鉴权不可达', async () => {
    // 不依赖路由表：即便枚举失效或将来新增路由，命名空间内的**任意**路径都必须先过守卫。
    // 它同时钉住「守卫注册在 `/ui/api/*` 的 404 兜底之前」——顺序反过来时未注册路径会先拿到
    // 404 JSON（既是信息泄漏，也说明守卫已被下移）。
    for (const path of ['/ui/api/__not_registered__', '/ui/api/__not_registered__/deep']) {
      const res = await app.request(path, { method: 'GET' }, ENV);
      expect(res.status, `${path} 未经鉴权必须 401 而不是 404`).toBe(401);
      expect(await res.text(), `${path} 的拒答体`).toBe(GUARD_REJECTION);
    }
  });
});

// 界面部署开关（GitHub 仓库变量 `UI_ENABLED`，判定见 src/uiEnabled.ts）。
// 它必须**关得住静态资源**：`public/ui/*` 现在由 `[assets] run_worker_first = ["/ui", "/ui/*"]`
// 先送进 Worker，再由出口决定"转回 ASSETS"还是"404"。若哪天 run_worker_first 被删掉，
// 关闭态下资源仍会被平台直接托管 ⇒ 这两条断言会红（这正是要守的不变式）。
describe('UI 部署开关（UI_ENABLED）', () => {
  const CTX = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  // 记录静态资源被访问的次数：关闭态**一次都不该**访问（关得干净），开启态该访问（说明转发链路在）
  function makeEnv(uiEnabled: string | undefined, assetStatus: number) {
    const seen: string[] = [];
    const env = {
      USERNAME: USER,
      PASSWORD: PASS,
      VERSION: 'flag-test',
      ...(uiEnabled === undefined ? {} : { UI_ENABLED: uiEnabled }),
      ASSETS: {
        async fetch(req: Request): Promise<Response> {
          seen.push(new URL(req.url).pathname);
          return assetStatus === 200
            ? new Response('asset-body', { status: 200, headers: { 'content-type': 'text/plain' } })
            : new Response('', { status: 404 });
        },
      },
    } as unknown as Bindings;
    return { env, seen };
  }

  const at = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://sync.example.com${path}`, { headers }), makeEnv('true', 200).env, CTX);

  it('关闭态：/ui、页面、静态资源、/ui/api/* 一律 404，且完全不碰静态资源', async () => {
    const { env, seen } = makeEnv('false', 200);
    const cases: [string, 'page' | 'api'][] = [
      ['/ui', 'page'],
      ['/ui/', 'page'],
      ['/ui/index.html', 'page'],
      ['/ui/app/', 'page'],
      ['/ui/app/index.html', 'page'],
      ['/ui/js/boot.js', 'page'],
      ['/ui/api/session', 'api'],
      ['/ui/api/login', 'api'],
      ['/ui/api/history', 'api'],
    ];
    for (const [path, kind] of cases) {
      // 注意：不带任何凭据——界面开关在**鉴权之前**判定，未认证也必须拿到 404（而不是 401）
      const res = await worker.fetch(new Request(`https://sync.example.com${path}`), env, CTX);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(kind === 'api' ? '{"error":"not_found"}' : 'Not Found');
    }
    expect(seen, '关闭态不该去读静态资源').toEqual([]);
  });

  it('关闭态：根路径对浏览器 (Accept: text/html) 不再跳转，协议面照旧走鉴权', async () => {
    const { env } = makeEnv('false', 200);
    const root = await worker.fetch(
      new Request('https://sync.example.com/', { headers: { accept: 'text/html' } }),
      env,
      CTX,
    );
    expect(root.status).toBe(200);
    expect(await root.text()).toBe('Server is running.');
    // 协议面未被界面开关波及：无凭据 → 仍然是 401（而不是 404/500）
    const version = await worker.fetch(new Request('https://sync.example.com/api/version'), env, CTX);
    expect(version.status).toBe(401);
    // 鉴权失败并**不**依赖静态资源，也不该碰它
    expect(await version.text()).toBe('Unauthorized');
  });

  it('判定口径：只有显式 false 才算关（未设置 / true / 其它值都是开）', () => {
    expect(isUiEnabled({ UI_ENABLED: undefined } as unknown as Bindings)).toBe(true);
    expect(isUiEnabled({} as unknown as Bindings)).toBe(true);
    expect(isUiEnabled({ UI_ENABLED: 'true' } as unknown as Bindings)).toBe(true);
    expect(isUiEnabled({ UI_ENABLED: 'TRUE' } as unknown as Bindings)).toBe(true);
    expect(isUiEnabled({ UI_ENABLED: '' } as unknown as Bindings)).toBe(true); // 变量没配 ⇒ 退回线上默认（开）
    expect(isUiEnabled({ UI_ENABLED: 'false' } as unknown as Bindings)).toBe(false);
    expect(isUiEnabled({ UI_ENABLED: ' FALSE ' } as unknown as Bindings)).toBe(false);
    expect(isUiEnabled({ UI_ENABLED: '0' } as unknown as Bindings)).toBe(true); // 不认 0/no/off，避免误关
  });

  it('开启态：/ui/* 先转静态资源；资源未命中(404)时回落给 Hono 的 404 页', async () => {
    // 命中资源 → 原样返回（含 /ui 的 307 跳转，由静态资源自己产生）
    const hit = await at('/ui/js/boot.js');
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe('asset-body');

    // 未命中资源 → 回落 Hono，拿到的是那张 404 页（与"静态资源直接托管"时平台自己回落的行为一致）
    const { env, seen } = makeEnv('true', 404);
    const missing = await worker.fetch(new Request('https://sync.example.com/ui/__missing__'), env, CTX);
    expect(seen, '未命中也先问过静态资源').toEqual(['/ui/__missing__']);
    expect(missing.status).toBe(404);
    expect(await missing.text(), '应回落到 Hono 的 404 页而不是一张空 404').toContain('这个地址没有页面');

    // /ui/api/* 不走静态资源（它一直是 Worker 路由）
    const api = await worker.fetch(new Request('https://sync.example.com/ui/api/__nope__'), env, CTX);
    expect(api.status).toBe(401); // 未带凭据 ⇒ 先被守卫拦下
    expect(seen, '/ui/api/* 不该去问静态资源').toEqual(['/ui/__missing__']);
  });

  // V1 存档（`public/ui_old/`，冻结不再维护，见该目录 README）与 V2 共用同一个界面开关。
  // 这条守卫拦的是"关掉界面却留下一个仍可访问的旧界面"——那正是这个开关要消除的东西。
  it('V1 存档同样受界面开关约束：关闭态 404，开启态转静态资源', async () => {
    const off = makeEnv('false', 200);
    for (const path of ['/ui_old', '/ui_old/', '/ui_old/index.html', '/ui_old/js/main.js']) {
      const res = await worker.fetch(new Request(`https://sync.example.com${path}`), off.env, CTX);
      expect(res.status, `${path} 在关闭态必须 404`).toBe(404);
    }
    // 关闭态**一次都不该**去读静态资源（与 /ui/* 同一条纪律：关得干净）
    expect(off.seen, '关闭态的存档请求不该去读静态资源').toEqual([]);

    // 开启态：存档面没有服务端路由，故直接转静态资源
    const on = makeEnv('true', 200);
    const res = await worker.fetch(new Request('https://sync.example.com/ui_old/index.html'), on.env, CTX);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset-body');
    expect(on.seen).toEqual(['/ui_old/index.html']);
  });
});
