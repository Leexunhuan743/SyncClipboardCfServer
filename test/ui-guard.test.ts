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

  // V1（`public/ui_old/`，2026-09-18 起是**默认界面**，见该目录 README）与 V2 共用同一个界面开关。
  // 这条守卫拦的是"关掉界面却留下一个仍可访问的旧界面"——那正是这个开关要消除的东西。
  // 2026-09-18 补：未命中也要回落到那张设计过的 404 页（V1 成了默认界面，打错路径不该拿到纯文本 404）。
  it('V1（默认界面）同样受界面开关约束：关闭态 404，开启态转静态资源，未命中回落 404 页', async () => {
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

    // 未命中：先问静态资源，404 之后回落到那张页（与 /ui/* 同一条行为）
    const miss = makeEnv('true', 404);
    const missing = await worker.fetch(new Request('https://sync.example.com/ui_old/__missing__'), miss.env, CTX);
    expect(miss.seen, '未命中也先问过静态资源').toEqual(['/ui_old/__missing__']);
    expect(missing.status).toBe(404);
    expect(await missing.text(), '应回落到设计过的 404 页而不是平台默认的纯文本').toContain('这个地址没有页面');
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

  // ===== 模块图与自包含（2026-09-18 补）=====
  //
  // 下面三条此前**都不存在**（V2 有同类的"预载清单 == import 闭包"，V1 一直没有）：
  //   ① V1 的 modulepreload 清单是人工维护的，多一项白拉一个文件、少一项留下一段依赖瀑布，
  //      两者都不会报错。2026-09-18 给 V1 新增 `js/messages.js` 时正需要它。
  //   ② 自包含断言原先只查 `js/main.js` 与 `index.html` 两个文件，且其中的
  //      `from '../ui/` 是从 `public/ui_old/js/` 出发的**空断言** —— `../ui/` 指向不存在的
  //      `public/ui_old/ui/`，真正要拦的是 `../../ui/`。现在改成"解析后是否逃出 V1 目录"的结构性判据。
  //   ③ `messages.js` 是 V1 自己的副本（产品面必须自包含，见该文件头），
  //      "两份必然漂移"由这条对等守卫兜住，而不是靠人工 review。

  /** 剥注释。判据与 `test/ui-contract.test.ts` 一致：块注释只认**行首**，
   *  否则注释里的 `/ui/*` 这类通配写法会被当成块注释起点、吃掉整屏正代码。 */
  function stripJsComments(source: string): string {
    return source
      .replace(/(^|\n)([ \t]*)\/\*[\s\S]*?\*\//g, '$1')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  }

  /** V1 目录内的模块 id（`js/main.js` 形式）。 */
  function moduleId(file: string): string {
    return file.replace(/\\/g, '/').replace(/^public\/ui_old\//, '');
  }

  /** 把 `spec` 相对 `id` 解析成模块 id；逃出目录时保留前导 `..`（供调用方判定）。 */
  function resolveFrom(id: string, spec: string): string {
    const stack = id.split('/').slice(0, -1);
    for (const part of spec.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0) stack.pop();
        else stack.push('..');
      } else stack.push(part);
    }
    return stack.join('/');
  }

  function rawSpecifiers(id: string): string[] {
    const source = stripJsComments(readFileSync(join(V1_DIR, id), 'utf8'));
    return [...source.matchAll(/import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  }

  function localImportsOf(id: string): string[] {
    return rawSpecifiers(id)
      .filter((spec) => spec.startsWith('.'))
      .map((spec) => resolveFrom(id, spec));
  }

  /** 入口的传递闭包（不含入口自身），元素为模块 id。 */
  function importClosure(entry: string): string[] {
    const seen = new Set<string>();
    const walk = (id: string): void => {
      for (const dep of localImportsOf(id)) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        walk(dep);
      }
    };
    walk(entry);
    return [...seen].sort();
  }

  it('每张页面的 modulepreload 清单 == 该页入口的 import 闭包（去掉入口自身）', () => {
    for (const page of [
      { name: 'index.html', entry: 'js/main.js' },
      { name: 'login.html', entry: 'js/login.js' },
    ]) {
      const html = readFileSync(join(V1_DIR, page.name), 'utf8');
      const preload = [...html.matchAll(/<link rel="modulepreload" href="\/ui_old\/([^"]+)"/g)]
        .map((m) => m[1]!)
        .sort();
      const closure = importClosure(moduleId(page.entry));
      // 空集合会让这条断言永远为真：先把「抽取器确实在工作」本身钉住
      // （登录页的闭包很小 —— 只有 api/format/next-target 三项）
      expect(preload.length, `${page.name} 没扫到 modulepreload 清单`).toBeGreaterThan(2);
      expect(closure.length, `${page.name} 的 import 闭包`).toBeGreaterThan(2);
      expect(preload, `${page.name} 的 modulepreload 清单 != import 闭包`).toEqual(closure);
    }
  });

  it('V1 前端是完全自包含的：没有任何模块逃出 public/ui_old，页面也不引用 /ui/ 下的资源', () => {
    const ids = walkFiles(join(V1_DIR, 'js'), '.js').map(moduleId);
    expect(ids.length, '没扫到 V1 的 JS 文件（守卫可能失效）').toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const id of ids) {
      for (const spec of rawSpecifiers(id)) {
        if (!spec.startsWith('.')) continue;
        if (resolveFrom(id, spec).startsWith('..')) offenders.push(`${id} → ${spec}`);
      }
    }
    // 两张页面也不得把 `/ui/` 下的东西当**子资源**引用（它是开发测试版，随时可能被破坏性重构或删除）。
    // 注意范围：只查 `<script src>` 与 `<link href>`，**不查** `<a href>` ——
    // 提示条里指向开发测试版入口 `/ui/app/` 的**导航链接**是有意的（见 index.html 的 notice-bar）。
    for (const page of ['index.html', 'login.html']) {
      const html = readFileSync(join(V1_DIR, page), 'utf8');
      for (const m of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(\/ui\/[^"]*)"/g)) {
        offenders.push(`${page} → ${m[1]!}`);
      }
    }
    expect(offenders, '以下引用跨到了 public/ui —— 产品面（V1）必须自包含：').toEqual([]);
  });

  it('V1 的 messages.js 与 V2 的 messages.js 逐字一致（自包含的对等守卫）', () => {
    // 自包含的代价是"两份必然漂移"，而这里漂移的后果是**删除语义被写错**
    // （"带数据文件的记录软删时立即清数据文件"这条最不能错）。守卫从 import 行起逐字比对，
    // 因此也覆盖了两版共有的私有函数 `describeTarget`。V2 真被删掉时，连这条守卫一起删。
    // 锚点 = **第一条 import 语句**，而不是写死的那一行（2026-09-18 修）：原来写死的
    // `import { typeLabel } from './format.js';` 在本次给两版都加上 `truncateText` 之后，
    // 两个文件里都不存在了。断言确实先炸了（不会静默通过），但报出来的原因是"守卫失效"、
    // 不是真实的文案漂移 —— 换成结构性判据之后，以后再增删 import 就不会误报。
    const ANCHOR_RE = /^import[ \t]/m;
    // 归一换行：本守卫管的是"文案是否一致"，不是"行尾是 CRLF 还是 LF"
    // （不同编辑器的保存行为会让后者无意义地红）。
    const body = (text: string, label: string): string => {
      const at = text.search(ANCHOR_RE);
      expect(at, `${label} 里找不到 import 行（守卫可能失效）`).toBeGreaterThan(-1);
      return text.slice(at).replace(/\r\n/g, '\n');
    };
    const v1 = body(readFileSync(join(V1_DIR, 'js/messages.js'), 'utf8'), 'V1 的 messages.js');
    const v2 = body(readFileSync('public/ui/js/messages.js', 'utf8'), 'V2 的 messages.js');
    expect(v1, 'V1 与 V2 的 messages.js 已漂移 —— 改文案时两版都要改').toBe(v2);
  });

  it('挂载点字面量只有一处常量 + 一处有理由的例外', () => {
    // 2026-09-15 的事故有两半：接口前缀被批量改写（已由上一节的 `API_BASE` 守住），
    // 以及**挂载点**引用散落在多处（`redirectToLogin` / 登录页默认落点 / 登出跳转）。
    // 后者此前没有任何守卫 —— 同一次改名照样能改错，症状是"跳到 404"，比接口前缀更难查。
    // 白名单只有两项，出现第三处就必须先改这里（逼作者说明理由）：
    const ALLOWED = [
      { id: 'js/api.js', test: /export const PAGE_BASE = ['"]\/ui_old['"]/ },
      {
        id: 'js/next-target.js',
        test: /u\.pathname === ['"]\/ui_old\/login\.html['"]/,
        // 该模块刻意不 import `api.js`（要保住"纯函数、可被测试直接覆盖"，见其文件头），
        // 所以这一处字面量无法引用 PAGE_BASE。
      },
    ];
    const offenders: string[] = [];
    let hits = 0;
    for (const id of walkFiles(join(V1_DIR, 'js'), '.js').map(moduleId)) {
      stripJsComments(readFileSync(join(V1_DIR, id), 'utf8'))
        .split('\n')
        .forEach((line, index) => {
          if (!/['"`]\/ui_old/.test(line)) return;
          hits += 1;
          if (ALLOWED.some((entry) => entry.id === id && entry.test.test(line))) return;
          offenders.push(`${id}:${index + 1} → ${line.trim()}`);
        });
    }
    expect(hits, '没扫到任何 /ui_old 字面量（守卫可能失效）').toBeGreaterThan(0);
    expect(offenders, '挂载点字面量出现在未登记的位置 —— 改名/搬目录时会漏改：').toEqual([]);
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

  // 默认界面 = V1（`public/ui_old/`），2026-09-18 用户定的定位；V2（`public/ui/app/`）是开发测试版。
  // 这条定位由**三个入口**共同表达，任何一处漏改都会让人落回另一版：
  //   ① `GET /` 的浏览器分支（`src/routes/webdav.ts`）直接 302；
  //   ② `/ui/` 的目录索引壳（`public/ui/index.html`）meta refresh + canonical（给 /ui/ 的书签）；
  //   ③ 两版界面里的提示条（V1 指 V2，V2 的标记是"开发测试版"）。
  // 前两处必须指向同一个地址 —— 只翻一处的话，站点根与 /ui/ 会落到两个不同的界面。
  it('默认界面的入口链一致：GET / 与 /ui/ 的目录索引都指向 V1', () => {
    const webdav = readFileSync('src/routes/webdav.ts', 'utf8');
    const rootRedirect = /c\.redirect\('([^']+)', 302\)/.exec(webdav)?.[1] ?? null;
    const stub = readFileSync('public/ui/index.html', 'utf8');
    const metaRefresh = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(stub)?.[1] ?? null;
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(stub)?.[1] ?? null;

    // 空集合会让断言永远为真：先把三处都抽到了钉住
    expect(rootRedirect, '没抽到 GET / 的重定向目标（守卫可能失效）').not.toBeNull();
    expect(metaRefresh, '没抽到 /ui/ 目录索引的 refresh 目标').not.toBeNull();
    expect(canonical, '没抽到 canonical').not.toBeNull();
    expect(
      [metaRefresh, canonical],
      '站点根与 /ui/ 目录索引必须落到同一个界面（默认界面 = V1）',
    ).toEqual([rootRedirect, rootRedirect]);
    expect(rootRedirect).toBe('/ui_old/');
  });

  // UI_ENABLED=false 必须是**真的关掉**：`/ui_old/*` 若不进 run_worker_first，边缘命中静态资源就
  // 直接返回，请求根本到不了 Worker，`src/index.ts` 里那段 isArchivePath 的 404 判定永远不执行 ——
  // 开关静默失效（V1 从 2026-09-18 起是默认界面，这条就成了承重问题）。
  // 这条守卫是 `docs/ui.md` 里"若哪天有人删掉 run_worker_first，关闭态会静默失效 —— 测试即红"那句话
  // 的兑现：此前**没有任何测试**在读这个配置。
  it('两个界面挂载点都在 run_worker_first 里（否则 UI_ENABLED 静默失效）', () => {
    const toml = readFileSync('wrangler.toml', 'utf8');
    const raw = /run_worker_first\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? null;
    expect(raw, '没抽到 run_worker_first（守卫可能失效）').not.toBeNull();
    const patterns = (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter((entry) => entry !== '');
    for (const pattern of ['/ui', '/ui/*', '/ui_old', '/ui_old/*']) {
      expect(patterns, `run_worker_first 缺少 ${pattern}：那一面的界面开关不会生效`).toContain(pattern);
    }
  });
});
