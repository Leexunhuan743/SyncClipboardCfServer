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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createUiRoutes } from '../src/ui/routes';
import type { Bindings } from '../src/env';
import worker from '../src/index';
import { isUiEnabled } from '../src/uiEnabled';
// @ts-expect-error TS7016：`public/ui_old/**` 是零构建的原生 ES 模块，不在 tsconfig 的 include 里
import { API_BASE, api, itemPath } from '../public/ui_old/js/api.js';

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

  // V1（`public/ui_old/`，2026-09-17 起作为备用界面重新纳入维护，见该目录 README）与 V2
  // 共用同一个界面开关。
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

// ===== V1 界面（`public/ui_old/`）的接口前缀与两页一致性 =====
//
// 这一节守的是一个**真实故障**：2026-09-15 把 V1 存档到 `public/ui_old/` 时，`/ui/` → `/ui_old/`
// 的批量改写把 17 处**接口前缀**也一起改了，界面从此去打 `/ui_old/api/*` —— 而服务端从不提供
// 那个命名空间（`src/index.ts` 把 `/ui_old/*` 整体当静态存档）。症状：HTML/CSS/JS 全部 200，
// 页面永远停在骨架屏上，只报一句「初始化失败：Not Found」。
//
// 为什么既有测试一条都没红：`test/ui-contract.test.ts` 的扫描目标在交接时改成了 V2，
// 而 `ui-guard` 只验证 `/ui_old/` 的静态资源受界面开关约束 —— **没有一条断言碰过 V1 的接口前缀**。
// 这个故障因此在线上存活了两天，直到逐文件通读才发现。
//
// 判据取"结构性"的两条，而不是"逐个端点列清单"（后者每次加接口都要同步维护）：
//   ① 接口前缀只有一处字面量，且它就是 `/ui/api`；
//   ② 全部 V1 前端源码里不出现 `/ui_old/api`（无论出现在代码还是注释里）。
describe('V1 界面（public/ui_old）的接口前缀与两页一致性', () => {
  const V1_DIR = 'public/ui_old';

  function walkFiles(dir: string, ext: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkFiles(full, ext));
      else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
  }

  it('接口前缀只有一处字面量，且指向 /ui/api', () => {
    expect(API_BASE).toBe('/ui/api');
  });

  it('URL 构造：单条记录的路径逐段编码，前缀不再被页面挂载点带偏', () => {
    const item = { type: 'Text', hash: 'ABCDEF' };
    expect(itemPath(item)).toBe('/ui/api/history/Text/ABCDEF');
    expect(api.dataUrl(item)).toBe('/ui/api/history/Text/ABCDEF/data');
    expect(api.dataUrl(item, { download: true })).toBe('/ui/api/history/Text/ABCDEF/data?download=1');
    // hash 里的 `#`/`?` 会把裸拼的查询串截断（协议只禁止路径分隔符）
    expect(itemPath({ type: 'Text', hash: 'A#B?C' })).toBe('/ui/api/history/Text/A%23B%3FC');
  });

  it('V1 前端源码里不出现 /ui_old/api（含注释）', () => {
    const offenders: string[] = [];
    const files = walkFiles(join(V1_DIR, 'js'), '.js');
    // 空集合会让这条断言永远为真：先把「扫到了东西」本身钉住（枚举有效性）
    expect(files.length, '没扫到 V1 的 JS 文件（守卫可能失效）').toBeGreaterThan(15);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('/ui_old/api')) offenders.push(file);
    }
    // 两张页面同样不该出现（例如写死的接口地址）
    for (const page of ['index.html', 'login.html']) {
      const text = readFileSync(join(V1_DIR, page), 'utf8');
      if (text.includes('/ui_old/api')) offenders.push(join(V1_DIR, page));
    }
    expect(
      offenders,
      '以下文件里出现了 /ui_old/api —— 服务端没有这个命名空间，界面会停在骨架屏上：',
    ).toEqual([]);
  });

  it('两页的提示条键名一致（关闭状态跨页生效）', () => {
    // 提示条的关闭逻辑在两个入口模块里各写了一份（理由见 js/main.js 的注释）。
    // 一份实现、两处键名，就必须有一条断言钉住"两处一致"——不然在登录页关掉、进列表页又冒出来。
    const readKey = (file: string) =>
      /const NOTICE_KEY = '([^']+)'/.exec(readFileSync(join(V1_DIR, file), 'utf8'))?.[1] ?? null;
    const inList = readKey('js/main.js');
    const inLogin = readKey('js/login.js');
    expect(inList, 'js/main.js 未声明 NOTICE_KEY').not.toBeNull();
    expect(inLogin, 'js/login.js 未声明 NOTICE_KEY').toBe(inList);
  });

  it('两张页面引用的本地资源都存在（死引用 = 一次 404）', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const page of ['index.html', 'login.html']) {
      const html = readFileSync(join(V1_DIR, page), 'utf8');
      for (const m of html.matchAll(/(?:href|src)="(\/ui_old\/[^"]+)"/g)) {
        const rel = m[1]!.replace('/ui_old/', '');
        checked += 1;
        if (!existsSync(join(V1_DIR, rel))) missing.push(`${page} → ${m[1]}`);
      }
    }
    expect(checked, '没扫到任何本地资源引用（守卫可能失效）').toBeGreaterThan(20);
    expect(missing, '页面引用了不存在的本地资源：').toEqual([]);
  });

  // 2026-09-18：文案表改成**两版共用一份**（V2 的 `public/ui/js/messages.js`）。
  // 这条断言钉住"共用"这件事本身：一旦有人把 V1 的 import 换回本地副本，
  // 两版就会各自漂移（此前删除确认的语义句、"搜索词过长"的翻译都各写了一份）。
  it('V1 的文案来自两版共用的那一份，而不是本地副本', () => {
    const main = readFileSync(join(V1_DIR, 'js/main.js'), 'utf8');
    expect(main, 'V1 的 main.js 未引用共用文案表').toContain("from '../../ui/js/messages.js'");
    expect(existsSync('public/ui/js/messages.js'), '共用文案表不存在').toBe(true);
  });
});

// V1 的**样式层**守卫（2026-09-18）。两条都来自"文档写了、实现没跟上"的真实缺陷：
//   ① `base.css` 写着"本项目所有可点元素都有 :active 缩放或变色"，而全仓只有 `.btn` 与
//      `.icon-btn` 两处 —— 触屏没有 hover，缺 `:active` 就等于按下毫无反应（页面像死的）；
//   ② 令牌表里躺着两个只在定义处出现的自定义属性（`--fs-stat`、`--dur-medium`），
//      它们服务的机制（统计数字 30px、同文档视图过渡）都已经改掉/移除，留着会让人误判当前设计。
// V2 那边**有意保留**成组的色阶与成对的 kind-*-soft（政策写在 `tokens-v2.css` 里），
// 所以这两条只扫 V1：V1 没有"成组保留"的例外，一旦出现死令牌就该删或该用。
describe('V1 的样式层契约（令牌不空转、可点控件有按下反馈）', () => {
  const V1_DIR = 'public/ui_old';

  function walk(dir: string, ext: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full, ext));
      else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
  }

  const cssFiles = walk(join(V1_DIR, 'css'), '.css');
  const cssText = cssFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  // 引用可能出现在样式表、脚本（`getPropertyValue('--header-h')`）或页面里
  const allText = [
    cssText,
    ...walk(join(V1_DIR, 'js'), '.js').map((file) => readFileSync(file, 'utf8')),
    ...['index.html', 'login.html'].map((page) => readFileSync(join(V1_DIR, page), 'utf8')),
  ].join('\n');

  it('令牌不空转：没有"定义了却没人 var() 引用"的自定义属性', () => {
    const defined = [...new Set([...cssText.matchAll(/^[ \t]*(--[a-z0-9-]+):/gm)].map((m) => m[1]!))];
    expect(defined.length, '没扫到任何自定义属性（守卫可能失效）').toBeGreaterThan(50);
    // 三种引用形态都算：`var(--x`、JS 里的 `'--x'` / `"--x"`（`getPropertyValue` 那一类）
    const referenced = (name: string) =>
      allText.includes(`var(${name}`) || allText.includes(`'${name}'`) || allText.includes(`"${name}"`);
    const dead = defined.filter((name) => !referenced(name)).sort();
    expect(dead, '定义了却没人引用（要么接上，要么删掉——V1 没有成组保留的例外）').toEqual([]);
  });

  it('可点控件都有按下反馈（:active）：清单写死，新增控件要显式加进来', () => {
    // 这份清单是**手写**的：不靠"看着像按钮"的启发式（那是猜测），而靠"这个类在页面上能按"
    // 这个事实。新增一个可点控件时，这里不加、CSS 不写 :active，就会红。
    const PRESSABLE = [
      'btn', // 所有带文字的按钮（含「清除筛选」那枚胶囊）
      'icon-btn', // 行内动作、主题、登出、对话框关闭
      'segmented__item', // 类型 / 仅收藏 / 回收站
      'th-sort', // 表头排序
      'search__clear', // 清空搜索
      'notice-bar__close', // 顶部提示条关闭
      'toast__action', // 提示条里的「重试」
      'checkbox', // 行选择 / 全选
      'status', // 顶栏「部署信息」（带推送状态那枚胶囊）
    ];
    // 先剥注释：注释里写着 `:active` 三个字（本文件上面就写了一堆）不该算数
    const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]*):active[^{}]*\{/g)].map((m) => m[1]!);
    expect(selectors.length, '没扫到任何 :active 规则（守卫可能失效）').toBeGreaterThan(5);
    const missing = PRESSABLE.filter((cls) => !selectors.some((sel) => sel.includes(`.${cls}`)));
    expect(missing, '这些可点控件没有 :active（触屏上按下毫无反馈，页面像死的）').toEqual([]);
  });

  // 错误状态必须**挂在出错的那个字段上**（`components.md` §2 的 error 格：信息挨着控件、
  // 被 `aria-describedby` 关联、不靠颜色）。V1 的两个表单此前都只写了一个错误框：
  // 登录页（用户名/密码）与部署信息的保留策略（两个数字输入）。
  it('表单错误挂在字段上：aria-invalid + aria-describedby，且 CSS 有对应的视觉态', () => {
    const login = readFileSync(join(V1_DIR, 'js/login.js'), 'utf8');
    const info = readFileSync(join(V1_DIR, 'js/components/info.js'), 'utf8');
    for (const [file, source] of [
      ['js/login.js', login],
      ['js/components/info.js', info],
    ] as const) {
      expect(source, `${file} 没有把错误标到字段上（aria-invalid）`).toContain('aria-invalid');
      expect(source, `${file} 没有把错误与控件关联（aria-describedby）`).toContain('aria-describedby');
    }
    // 关联到的 id 必须真的存在，否则那条描述指向空气
    for (const id of ['login-error', 'retention-status']) {
      expect(
        [...walk(join(V1_DIR, 'js'), '.js'), join(V1_DIR, 'index.html'), join(V1_DIR, 'login.html')].some(
          (file) => readFileSync(file, 'utf8').includes(`id: '${id}'`) || readFileSync(file, 'utf8').includes(`id="${id}"`),
        ),
        `aria-describedby 指向的 #${id} 没有任何生产者`,
      ).toBe(true);
    }
    // 标了 aria-invalid 就得有视觉态：颜色不是主通道，但"什么都没变"会让标记等于不存在
    expect(cssText, 'CSS 没有消费 aria-invalid（字段标了错却看不出）').toContain('[aria-invalid="true"]');
  });
});
