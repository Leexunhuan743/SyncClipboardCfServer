// Web 历史界面的后端面 `/ui/api/*` 端到端验证（会话 Cookie 或 Basic 鉴权）。
//
// 为什么单独一套而不并进 transports/query-filters：那是**协议契约**（官方客户端在读），
// 这里是**本站自己的面**——鉴权方式不同（Cookie + Basic 双通道、401 不带
// WWW-Authenticate），分页/排序语义不同（可变 pageSize、白名单列、总数）。
// 但它与协议端点共用同一张表与同一写路径（historyOps.applyHistoryUpdate），
// 故本套件写记录时仍走官方 `PUT /SyncClipboard.json`，验证的是「两条面共享同一份数据」。
//
// 隔离方式：本套件写入的记录全部在 beforeAll 里**自己创建**，列表断言一律用
// `search=<自己的标记>` 先筛出本次记录 —— 任何断言都不依赖库里既有数据
// （否则在只有 schema 的干净实例上会因「恰好有别人遗留的记录」而假绿）。
//
// 本套件**会写目标库**（3 条记录，见 LIST 的 beforeAll），afterAll 逐个收尾软删；
// 记录是普通 Text 且时间戳取 now（非未来值），故 PATCH 收尾必然成功，
// 残留行最终也会被 Cron 硬删。
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { assertWritableTarget } from './support/target-guard';
import { verifyCredentials } from '../src/auth';
import type { Bindings } from '../src/env';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

// 本套件会写目标库：默认只允许指向本机 dev server，指向远端需显式 ALLOW_REMOTE_TARGET=1
assertWritableTarget(BASE);
// 凭据变量名专用化：`USER`/`USERNAME` 在宿主环境里恒被占用（同 transports.test.ts）
const USER = process.env.SYNC_USER ?? 'admin';
const PASS = process.env.SYNC_PASS ?? 'admin';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const RUN = Date.now().toString(36);
const MARK = `ui-test-${RUN}`;
// 排序用例需要 ≥2 条**自己创建**且 size 明显不同的记录（否则「单调不减」会退化成
// 依赖库里既有数据）。标记刻意不含 MARK 子串：`search=MARK` 因此只命中主记录。
const SORT_MARK = `ui-sort-${RUN}`;
const SORT_SHORT = `${SORT_MARK}-a`;
const SORT_LONG = `${SORT_MARK}-b${'x'.repeat(32)}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex').toUpperCase();

// 会话 Cookie 的极简 jar：解析 Set-Cookie、按名字存取、Max-Age=0 视为删除。
// 不引入第三方 jar 依赖；也正因 fetch 不自动持 Cookie，这里手动模拟浏览器的行为，
// 让「logout 清除 Cookie」成为可断言的客户端语义。
const jar = new Map<string, string>();
function captureSetCookie(res: Response): void {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return;
  const pair = setCookie.split(';')[0] ?? '';
  const eq = pair.indexOf('=');
  if (eq < 0) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  // 过期的清除 Cookie（logout 发的 Max-Age=0）→ 从 jar 删除
  if (value === '') jar.delete(name);
  else jar.set(name, value);
}
function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// 带 Cookie 的请求（jar 为空时省略 Cookie 头）
function fetchWithJar(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jar.size > 0 && !headers.has('Cookie')) headers.set('Cookie', cookieHeader());
  return fetch(`${BASE}${path}`, { ...init, headers });
}

// 写路径用的 Basic 请求（官方协议端点 / UI 受保护端点共用）
async function req(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, { ...init, headers: { Authorization: AUTH, ...(init.headers ?? {}) } });
}

// 定位本次标记的记录：列表里可能有 0..1 条（被删前 1 条、删后 0 条）
async function findMine(): Promise<{ type: number; hash: string; starred: boolean } | null> {
  const res = await req(`/ui/api/history?search=${encodeURIComponent(MARK)}`);
  expect(res.status, '列表请求').toBe(200);
  const body = (await res.json()) as { total: number; items: { type: number; hash: string; starred: boolean }[] };
  expect(body.total, 'search 只命中本标记的记录').toBe(body.items.length);
  return body.items[0] ?? null;
}

// 本套件写入的全部记录（hash）：afterAll 逐个回收，任何失败路径都不留残留
const createdHashes: string[] = [];

// 用官方协议（PUT /SyncClipboard.json）写一条 Text 记录 —— 与官方客户端上传走同一条路径，
// 故同时验证「官方写 → UI 面可见」。hash 按上游规则由文本算出（客户端也是这么算的）。
async function putText(text: string): Promise<string> {
  const hash = sha256(text);
  const res = await req('/SyncClipboard.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Text', hash, text, hasData: false, size: text.length }),
  });
  if (res.status !== 200) {
    throw new Error(`PUT /SyncClipboard.json(${text}) -> ${res.status} ${await res.text()}`);
  }
  createdHashes.push(hash);
  return hash;
}

describe('UI API 鉴权（会话 Cookie / Basic / 401 语义）', () => {
  it('登录：错密码 401、对密码 200 且签发 set-cookie', async () => {
    const wrong = await fetchWithJar('/ui/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: 'definitely-wrong-password' }),
    });
    expect(wrong.status, '错密码必须是 401 而不是 200').toBe(401);
    const wrongBody = (await wrong.json()) as { error?: string };
    expect(wrongBody.error, '401 应带可诊断 error').toBe('invalid_credentials');

    const ok = await fetchWithJar('/ui/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    expect(ok.status, '对密码必须是 200').toBe(200);
    const setCookie = ok.headers.get('set-cookie');
    expect(setCookie, '成功登录必须返回 set-cookie').toBeTruthy();
    expect(setCookie, 'Cookie 名必须是会话 Cookie 名').toContain('sb_ui_session=');
    // 记录进 jar，供后续用例使用
    captureSetCookie(ok);
  });

  it('会话：带已签发 Cookie → authenticated:true', async () => {
    expect(jar.size, '前置：上一用例登录成功').toBeGreaterThan(0);
    const res = await fetchWithJar('/ui/api/session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean; username: string | null };
    expect(body.authenticated, '有效会话 Cookie 必须判为已登录').toBe(true);
    expect(body.username).toBe(USER);
  });

  it('会话：logout 清除 Cookie 后 → authenticated:false', async () => {
    const out = await fetchWithJar('/ui/api/logout', { method: 'POST' });
    expect(out.status).toBe(200);
    captureSetCookie(out);
    expect(jar.has('sb_ui_session'), 'logout 的 set-cookie 必须把会话 Cookie 从 jar 删除').toBe(false);

    const res = await fetchWithJar('/ui/api/session');
    const body = (await res.json()) as { authenticated: boolean };
    expect(body.authenticated, 'logout 后会话必须失效').toBe(false);
  });

  it('会话：伪造 Cookie（改一位签名）→ authenticated:false', async () => {
    // 重新登录拿真 Cookie，篡改签名末尾一位后再用
    const login = await fetchWithJar('/ui/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    captureSetCookie(login);
    const real = jar.get('sb_ui_session')!;
    // 篡改签名的**首位**：该字符的 6 位全部有效，解码后的字节必然改变 → 验签必然失败。
    // 不能篡改末位：32 字节签名的 base64url 是 43 个字符（43×6 = 258 位，多出 2 位），
    // 末字符只用高 **4** 位、低 2 位是填充位，而 atob 忽略填充位——只动到填充位的改动
    // 解码后字节完全相同、验签照样通过。那样写会随「本次签名恰好是什么」随机通过或失败
    // （本地绿、CI 红，已实锤一次）。
    const dot = real.lastIndexOf('.');
    const payload = real.slice(0, dot);
    const signature = real.slice(dot + 1);
    const forgedSignature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    // 把前提本身也断言出来：篡改后的 base64 必须解码成**不同的字节**。
    // 少了这一条，将来有人改回末位、或换了别的编码方式，这条用例又会变成抽奖。
    const decode = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(decode(forgedSignature).equals(decode(signature)), '篡改必须真的改变签名字节').toBe(false);
    jar.set('sb_ui_session', `${payload}.${forgedSignature}`);

    const res = await fetchWithJar('/ui/api/session');
    const body = (await res.json()) as { authenticated: boolean };
    expect(body.authenticated, '签名被改的 Cookie 必须被拒绝').toBe(false);

    // 还原成真 Cookie，避免污染后续用例
    jar.set('sb_ui_session', real);
  });

  it('鉴权边界：/ui/api/history 无凭据 401、带 Basic 200', async () => {
    const anon = await fetch(`${BASE}/ui/api/history`);
    expect(anon.status).toBe(401);
    const withBasic = await req('/ui/api/history');
    expect(withBasic.status).toBe(200);
  });

  it('鉴权边界：401 响应不带 www-authenticate（浏览器不得弹原生凭据框）', async () => {
    const anon = await fetch(`${BASE}/ui/api/history`);
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate'), '必须不带 WWW-Authenticate').toBeNull();
    // 带 body 的受保护端点同样不能带
    const anonPost = await fetch(`${BASE}/ui/api/history/batch-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ type: 'Text', hash: 'X' }] }),
    });
    expect(anonPost.status).toBe(401);
    expect(anonPost.headers.get('www-authenticate')).toBeNull();
  });

  it('drain 回归：带 body 的 401 之后，同 isolate 的后续请求仍是 200 而非 503', async () => {
    // 事故历史：鉴权失败时未排空请求体就返回响应 → Workers 抛
    // 「Can't read from request stream after response has been sent.」，本 isolate 后续请求 503。
    const denied = await fetch(`${BASE}/ui/api/history/batch-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ type: 'Text', hash: 'X' }] }),
    });
    expect(denied.status).toBe(401);

    const followUp = await req('/ui/api/history');
    expect(followUp.status, '401 后紧接的带凭据请求不得被污染成 503').toBe(200);
  });
});

describe('UI API 列表（分页/过滤/搜索/排序白名单）', () => {
  // 本 describe 的断言一律基于**自己创建的**记录，故记录必须在这里先建好：
  // 既保证用例不依赖库里的既有数据（干净实例上也不会假绿），也让 afterAll 有据可清。
  let mainHash = '';
  beforeAll(async () => {
    const probe = await req('/ui/api/session');
    if (probe.status !== 200) throw new Error(`dev server 不可用 (${BASE}): /ui/api/session -> ${probe.status}`);
    mainHash = await putText(MARK);
    await putText(SORT_SHORT);
    await putText(SORT_LONG);
  });

  it('列表形状：{total,page,pageSize,items}，items.length <= pageSize', async () => {
    const res = await req('/ui/api/history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      page: number;
      pageSize: number;
      items: unknown[];
    };
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('page');
    expect(body).toHaveProperty('pageSize');
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length, 'items 不得超过 pageSize').toBeLessThanOrEqual(body.pageSize);
  });

  it('pageSize=99999 被钳制到 500（上限）', async () => {
    const res = await req('/ui/api/history?pageSize=99999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pageSize: number; items: unknown[] };
    expect(body.pageSize, 'pageSize 必须钳到 UI_MAX_PAGE_SIZE=500').toBe(500);
    expect(body.items.length).toBeLessThanOrEqual(500);
  });

  it('types=Text 只返回 Text（type===0）', async () => {
    // 标记 + types 组合：既证明过滤放行 Text，又证明「官方写 → UI 面可见」
    const res = await req(`/ui/api/history?search=${encodeURIComponent(MARK)}&types=Text`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { type: number; hash: string }[] };
    expect(body.items.length, 'search + types=Text 必须命中本次记录').toBeGreaterThan(0);
    expect(body.items.some((i) => i.hash === mainHash), '官方协议写入的记录必须能从 UI 面读到').toBe(true);
    for (const item of body.items) {
      expect(item.type, `非 Text 记录混入: ${JSON.stringify(item)}`).toBe(0);
    }

    // 不带 search：过滤要在整个库上生效（结果非空由本次写入的 Text 记录保证）
    const all = await req('/ui/api/history?types=Text&pageSize=500');
    const allBody = (await all.json()) as { items: { type: number }[] };
    expect(allBody.items.length).toBeGreaterThan(0);
    for (const item of allBody.items) {
      expect(item.type, `types=Text 下混入非 Text 记录: ${JSON.stringify(item)}`).toBe(0);
    }
  });

  it('starred=true 只返回 starred 记录（且真的排除了未星标）', async () => {
    // 自建自恢复：先星标本条 → 两个方向各断言一次 → 恢复未星标，不影响后面的往返用例
    const star = await req(`/ui/api/history/Text/${mainHash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });
    expect(star.status, 'PATCH 收藏').toBe(200);

    const on = await req(`/ui/api/history?search=${encodeURIComponent(MARK)}&starred=true`);
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as { items: { hash: string; starred: boolean }[] };
    expect(onBody.items.length, '星标后必须出现在 starred=true 结果里').toBeGreaterThan(0);
    for (const item of onBody.items) {
      expect(item.starred, 'starred=true 过滤下出现未星标记录').toBe(true);
    }
    // 反向：同一条记录在 starred=false 下必须消失 —— 证明过滤在真正区分，而不是恒真
    const off = await req(`/ui/api/history?search=${encodeURIComponent(MARK)}&starred=false`);
    const offBody = (await off.json()) as { items: { hash: string }[] };
    expect(offBody.items.some((i) => i.hash === mainHash), '星标记录不得出现在 starred=false 结果里').toBe(
      false,
    );

    const unstar = await req(`/ui/api/history/Text/${mainHash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: false }),
    });
    expect(unstar.status, 'PATCH 取消收藏（自恢复）').toBe(200);
    const restored = await req(`/ui/api/history?search=${encodeURIComponent(MARK)}&starred=true`);
    const restoredBody = (await restored.json()) as { items: unknown[] };
    expect(restoredBody.items, '恢复未星标后不得再出现在 starred=true 结果里').toHaveLength(0);
  });

  it('search 命中文本子串', async () => {
    // 记录由本 describe 的 beforeAll 用官方协议写入（同时验证「官方写 → UI 面可见」）
    const full = await findMine();
    expect(full, 'search 必须命中本标记的整串').not.toBeNull();
    expect(full!.hash).toBe(mainHash);
    // 部分子串命中（只给标记的前半段）
    const partial = await req(`/ui/api/history?search=${encodeURIComponent(MARK.slice(0, MARK.length - 3))}`);
    const partialBody = (await partial.json()) as { items: { hash: string }[] };
    expect(
      partialBody.items.some((i) => i.hash === mainHash),
      'search 部分子串必须命中（LIKE %text%）',
    ).toBe(true);
  });

  it('page 超出范围：items 为空但 total 不变', async () => {
    // 用标记做隔离：此时记录已存在（上一用例创建），total 稳定为 1
    const page1 = await req(`/ui/api/history?search=${encodeURIComponent(MARK)}&page=1`);
    const body1 = (await page1.json()) as { total: number; items: unknown[] };
    expect(body1.total).toBe(1);
    expect(body1.items.length).toBe(1);

    const oob = await req(`/ui/api/history?search=${encodeURIComponent(MARK)}&page=999999999`);
    const bodyOob = (await oob.json()) as { total: number; page: number; items: unknown[] };
    expect(bodyOob.items, '超出范围页必须无条目').toHaveLength(0);
    expect(bodyOob.total, 'total 是匹配记录数，与页码无关').toBe(body1.total);
  });

  it('排序白名单：sort=constructor/toString/__proto__ 一律 400 而非 500', async () => {
    for (const sort of ['constructor', 'toString', '__proto__']) {
      const res = await req(`/ui/api/history?sort=${sort}`);
      expect(res.status, `sort=${sort} 必须 400（白名单拦截，而非 SQL 报错 500）`).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error, `sort=${sort} 的 400 应带 error`).toBeTruthy();
    }
  });

  it('sort=size&order=asc 的 size 单调不减', async () => {
    // 基于本 describe 自建的两条记录（size 明显不同），不依赖库里既有数据
    const res = await req(
      `/ui/api/history?search=${encodeURIComponent(SORT_MARK)}&sort=size&order=asc&pageSize=500`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { size: number }[] };
    expect(body.items.length, '排序用例的两条自建记录都必须在结果里').toBe(2);

    let prev = -Infinity;
    for (const item of body.items) {
      expect(item.size, 'size 升序必须单调不减').toBeGreaterThanOrEqual(prev);
      prev = item.size;
    }
    // 只验「不减」无法区分 asc/desc 或列错配，故再钉死实际顺序（size = 文本长度）
    expect(body.items.map((i) => i.size)).toEqual([SORT_SHORT.length, SORT_LONG.length]);
  });

  it('置顶恒排在主排序列之前；pinnedFirst=false 才回到纯列序', async () => {
    // 判别力来自「置顶的那条 size 更大」：纯 size 升序会把它排在后面，
    // 故下面的顺序断言只有在置顶优先生效时才成立（置顶没生效 → 两条顺序直接翻过来）。
    const pinMark = `ui-pin-${RUN}`;
    const shortText = `${pinMark}-a`;
    const longText = `${pinMark}-b${'y'.repeat(32)}`;
    const shortHash = await putText(shortText);
    const longHash = await putText(longText);

    const pin = await req(`/ui/api/history/Text/${longHash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status, 'PATCH 置顶').toBe(200);
    expect(((await pin.json()) as { pinned: boolean }).pinned).toBe(true);

    const list = async (extra: string) => {
      const res = await req(
        `/ui/api/history?search=${encodeURIComponent(pinMark)}&sort=size&order=asc&pageSize=500${extra}`,
      );
      expect(res.status, `列表请求（${extra || '默认'}）`).toBe(200);
      const body = (await res.json()) as { items: { hash: string; pinned: boolean }[] };
      expect(body.items, '两条自建记录都必须在结果里').toHaveLength(2);
      return body.items;
    };

    const pinned = await list('');
    expect(
      pinned.map((i) => i.hash),
      '置顶的记录必须在最前 —— 即使 size 升序本来会把它排在后面',
    ).toEqual([longHash, shortHash]);
    expect(pinned[0]!.pinned, '最前那条必须是置顶的').toBe(true);

    const plain = await list('&pinnedFirst=false');
    expect(
      plain.map((i) => i.hash),
      'pinnedFirst=false 必须回到纯 size 升序（「复制最近一条」靠它保持"最新"的含义）',
    ).toEqual([shortHash, longHash]);

    // 自恢复：置顶是全局状态，留着会让后续用例与本地实例多出一条置顶记录
    const unpin = await req(`/ui/api/history/Text/${longHash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    });
    expect(unpin.status, '自恢复：取消置顶').toBe(200);
  });

  it('数据端点：Text 记录 /data 请求 → 404 且 error ∈ {not_found, data_missing}', async () => {
    const mine = await findMine();
    expect(mine, '前置：标记记录存在').not.toBeNull();
    const res = await req(`/ui/api/history/Text/${mine!.hash}/data`);
    // 这条记录 hasData=false → transferDataFile='' → not_found；若 R2 对象丢了则是 data_missing。
    // 两者都是「可判别的数据缺失」而非 500 —— 前端据此渲染「数据不可用」。
    expect(res.status, '/data 对无数据记录必须 404，不能 500').toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(['not_found', 'data_missing']).toContain(body.error);
  });

  it('写操作：PATCH 收藏 → starred=true；取消 → false', async () => {
    const mine = await findMine();
    expect(mine, '前置：标记记录存在').not.toBeNull();
    const { hash } = mine!;

    const star = await req(`/ui/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });
    expect(star.status, 'PATCH 收藏').toBe(200);
    expect(((await star.json()) as { starred: boolean }).starred).toBe(true);

    const starredList = await req(`/ui/api/history?starred=true&search=${encodeURIComponent(MARK)}`);
    const starredBody = (await starredList.json()) as { items: { hash: string; starred: boolean }[] };
    expect(
      starredBody.items.some((i) => i.hash === hash && i.starred === true),
      '收藏后必须出现在 starred=true 列表里',
    ).toBe(true);

    const unstar = await req(`/ui/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: false }),
    });
    expect(unstar.status, 'PATCH 取消收藏').toBe(200);
    expect(((await unstar.json()) as { starred: boolean }).starred).toBe(false);

    const unstarredList = await req(`/ui/api/history?starred=true&search=${encodeURIComponent(MARK)}`);
    const unstarredBody = (await unstarredList.json()) as { items: unknown[] };
    expect(unstarredBody.items, '取消收藏后不得再出现在 starred=true 列表里').toHaveLength(0);
  });

  it('写操作：批量删除后列表不再出现', async () => {
    const mine = await findMine();
    expect(mine, '前置：标记记录存在').not.toBeNull();

    const del = await req('/ui/api/history/batch-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ type: 'Text', hash: mine!.hash }], update: { isDelete: true } }),
    });
    expect(del.status, '批量删除').toBe(200);
    const delBody = (await del.json()) as { updated: number; failed: number };
    expect(delBody.updated, '删除响应必须报告删除成功').toBe(1);
    expect(delBody.failed).toBe(0);

    const after = await findMine();
    expect(after, '批量删除后列表里不得再出现该记录').toBeNull();
  });
});

describe('UI API 回归：早退路径必须排空请求体（review 修复）', () => {
  it('PATCH 非法 type/hash（带 body）→ 400 {error: invalid_profile_id}，且不污染后续请求', async () => {
    // 修复前：PATCH 在 parsePathIds 失败时直接 400 返回，未读入站体 → Workers 抛
    // 「Can't read from request stream after response has been sent.」并让本 isolate 的
    // 后续请求 503（会话过期后在页面上点一次收藏/删除就会命中这条路径）。
    const bad = await req('/ui/api/history/NotAType/abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });
    expect(bad.status, '非法 type/hash 的 PATCH 必须 400').toBe(400);
    const badBody = (await bad.json()) as { error?: string };
    expect(badBody.error, '400 响应体必须形如 {error: invalid_profile_id}').toBe('invalid_profile_id');

    const followUp = await req('/ui/api/statistics');
    expect(followUp.status, '400 未排空会污染 isolate → 后续请求 503').toBe(200);
  });

  it('GET 单条/数据端点非法 type/hash → 400 {error: invalid_profile_id}', async () => {
    for (const path of ['/ui/api/history/NotAType/abc', '/ui/api/history/NotAType/abc/data']) {
      const res = await req(path);
      expect(res.status, `${path} 必须 400`).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error, `${path} 的 400 响应体`).toBe('invalid_profile_id');
    }
  });

  it('POST /ui/api/logout 带 body → 200，且不污染后续请求', async () => {
    // 修复前：logout 是同步早退（不读 body），而它是公开端点，任何人都能带 body 打过来
    // → 「响应先于入站体发出」让本 isolate 的后续请求 503。
    const out = await fetch(`${BASE}/ui/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anything: true }),
    });
    expect(out.status, 'logout 带 body 必须 200').toBe(200);

    const followUp = await req('/ui/api/statistics');
    expect(followUp.status, 'logout 未排空会污染 isolate → 后续请求 503').toBe(200);
  });
});

describe('UI API 回收站视图（deleted=true）与恢复', () => {
  const RECYCLE_MARK = `ui-recycle-${RUN}`;

  async function listUi(params: string): Promise<{ total: number; items: { hash: string; isDeleted: boolean }[] }> {
    const res = await req(`/ui/api/history?${params}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; items: { hash: string; isDeleted: boolean }[] };
    expect(body.total, 'search 只命中本标记的记录').toBe(body.items.length);
    return body;
  }

  it('删掉的记录：默认列表看不到，deleted=true 看得到，恢复后回到默认列表', async () => {
    // 内联 Text（无数据文件）→ 属于「可恢复」的那一类，正是界面会给「恢复」按钮的记录
    const hash = await putText(RECYCLE_MARK);
    const path = `/ui/api/history/Text/${hash}`;
    const patch = (body: Record<string, unknown>): Promise<Response> =>
      req(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, lastModified: new Date().toISOString() }),
      });

    expect((await patch({ isDelete: true, version: 1 })).status).toBe(200);

    const active = await listUi(`search=${encodeURIComponent(RECYCLE_MARK)}`);
    expect(active.total, '已删除的记录不得出现在默认列表里').toBe(0);

    const recycle = await listUi(`search=${encodeURIComponent(RECYCLE_MARK)}&deleted=true`);
    expect(recycle.total, '回收站视图必须能看到已删除的记录').toBe(1);
    expect(recycle.items[0]!.isDeleted, '回收站里的行 isDeleted 必须为真（界面据此渲染“恢复”）').toBe(true);

    // 恢复：与界面同一条写路径（PATCH isDelete:false）。数据文件为空的记录才允许。
    expect((await patch({ isDelete: false, version: 2 })).status).toBe(200);
    expect((await listUi(`search=${encodeURIComponent(RECYCLE_MARK)}`)).total).toBe(1);
    expect((await listUi(`search=${encodeURIComponent(RECYCLE_MARK)}&deleted=true`)).total).toBe(0);
  });

  it('类型计数随视图走：byType 跟 deleted，byTypeActive 恒为活跃口径', async () => {
    // 工具栏的类型计数来自 byType（随视图），统计条「存储占用」的明细来自 byTypeActive（恒活跃）——
    // 已删记录的 R2 数据文件在软删时就删了，那行不能跟着视图走。
    const text = `${RECYCLE_MARK}-stats`;
    const hash = await putText(text);
    const payload = async (query = ''): Promise<{ byType: { Text: number }; byTypeActive: { Text: number } }> => {
      const res = await req(`/ui/api/statistics${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { byType: { Text: number }; byTypeActive: { Text: number } };
    };

    const before = await payload();
    const beforeDeleted = await payload('?deleted=true');

    const del = await req(`/ui/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDelete: true, version: 1, lastModified: new Date().toISOString() }),
    });
    expect(del.status).toBe(200);

    const active = await payload();
    const deleted = await payload('?deleted=true');
    expect(active.byType.Text, '活跃口径应减少 1').toBe(before.byType.Text - 1);
    expect(deleted.byType.Text, '回收站口径应增加 1').toBe(beforeDeleted.byType.Text + 1);
    expect(active.byTypeActive.Text, 'byTypeActive 与活跃口径一致').toBe(active.byType.Text);
    expect(deleted.byTypeActive.Text, '回收站视图下 byTypeActive 仍是活跃口径（存储明细用它）').toBe(
      active.byType.Text,
    );
  });

  it('收藏计数按视图各给一个：统计条那一格与工具栏「收藏」筛选必须同源', async () => {
    // 统计条「已收藏」与工具栏「收藏」筛选在同一屏。协议 DTO 的 `starredCount` 是**全库**口径
    // （上游语义），拿它画卡片会出现"卡片说 12、点开筛选只有 9"——2026-09-21 dogfood 实测。
    // 故两个视图各给一个（都是全表聚合，与请求的 deleted 无关，一次都给）。
    const text = `${RECYCLE_MARK}-starred`;
    const hash = await putText(text);
    const path = `/ui/api/history/Text/${hash}`;
    const patch = (body: Record<string, unknown>): Promise<Response> =>
      req(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, lastModified: new Date().toISOString() }),
      });
    const counts = async (): Promise<{ active: number; deleted: number }> => {
      const res = await req('/ui/api/statistics');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { starredCountActive: number; starredCountDeleted: number };
      return { active: body.starredCountActive, deleted: body.starredCountDeleted };
    };

    const before = await counts();
    expect((await patch({ starred: true, version: 1 })).status).toBe(200);
    const starred = await counts();
    expect(starred.active, '收藏一条活跃记录：活跃口径 +1').toBe(before.active + 1);
    expect(starred.deleted, '活跃记录的收藏不该进回收站口径').toBe(before.deleted);

    expect((await patch({ isDelete: true, version: 2 })).status).toBe(200);
    const moved = await counts();
    expect(moved.active, '同一条进回收站后：活跃口径退回去').toBe(before.active);
    expect(moved.deleted, '回收站口径 +1（卡片与「收藏」筛选在回收站视图里也同源）').toBe(before.deleted + 1);
  });

  it('deleted 参数只认 true/false：非法值 400（而不是静默当成 false）', async () => {
    const res = await req('/ui/api/history?deleted=yes');
    expect(res.status).toBe(400);
    // 计数端点用同一套解析（共用 parseDeletedFlag），语义必须一致
    expect((await req('/ui/api/statistics?deleted=yes')).status).toBe(400);
  });
});

describe('UI API 缓存策略（JSON no-store、数据端点例外）', () => {
  // 后端能力评估 §3.2：列表/统计/信号这些 JSON 响应原本没有任何 cache-control，
  // 浏览器可以合法地拿陈旧副本（返回键回退最明显）。修法是统一补 no-store，
  // 但**必须跳过数据端点**——它自带 `private, max-age=60`，是预览/缩略图的复用基础。
  const name = `ui-cache-${RUN}.bin`;
  const content = Buffer.from(`cache-probe-${RUN}`);
  // 上游 File 记录的 hash 规则：sha256(文本 | sha256(数据))，两段都是大写十六进制
  const fileHash = createHash('sha256')
    .update(`${name}|${createHash('sha256').update(content).digest('hex').toUpperCase()}`)
    .digest('hex')
    .toUpperCase();

  it('JSON 响应补 no-store，数据端点保留私有短缓存', async () => {
    // 造一条**带数据**的记录：先 PUT /file 暂存，再 PUT /SyncClipboard.json 入库
    // （与官方客户端上传同一条路径，故 R2 对象与记录在同一处）
    expect((await req(`/file/${name}`, { method: 'PUT', body: content })).status, '暂存文件').toBe(200);
    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'File',
        hash: fileHash,
        text: name,
        hasData: true,
        dataName: name,
        size: content.length,
      }),
    });
    expect(put.status, '入库带数据记录').toBe(200);

    for (const path of [
      '/ui/api/history?pageSize=1',
      '/ui/api/statistics',
      '/ui/api/poll',
      '/ui/api/info',
      '/ui/api/integrity',
      '/ui/api/session',
    ]) {
      const res = await req(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), `${path} 必须补 no-store`).toBe('no-store');
    }

    const data = await req(`/ui/api/history/File/${fileHash}/data`);
    expect(data.status, '带数据记录的 /data 必须 200').toBe(200);
    expect(data.headers.get('cache-control'), '数据端点自带缓存不得被 no-store 覆盖').toBe(
      'private, max-age=60',
    );

    // 收尾：软删（走官方 PATCH 的三段式路径 `/api/history/:type/:hash`——不是 profileId 两段式，
    // 写成 `File-<hash>` 会 404 并且被容错断言掩盖：记录与 R2 对象会一次次留在库里）
    const cleanup = await req(`/api/history/File/${fileHash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDelete: true, version: 10_000, lastModified: new Date().toISOString() }),
    });
    expect(cleanup.status, '收尾软删必须真的成功（404 说明路径写错了）').toBe(200);
    // 收尾生效的**可观测**证据：这条记录不再出现在活跃列表里（否则残留会静默堆积）
    const leftovers = (await (await req(`/ui/api/history?search=${encodeURIComponent(name)}`)).json()) as {
      total: number;
    };
    expect(leftovers.total, '收尾后活跃列表里不应还有本次记录').toBe(0);
  });
});

describe('UI API 推送票据与 WebSocket 通路（backend-gaps §2.1）', () => {
  // 这条链路此前完全不存在：界面只能 10 秒轮询（一个开着的标签 ≈ 8.6k 请求/天）。
  // 测试要覆盖两端：Worker 签发的票据必须能通过 DO 的连接鉴权（浏览器发 WS 时**带不了请求头**，
  // 票据就是那条通道），以及连上之后**真的**能收到广播（只验握手会漏掉「连上了但收不到」）。
  it('票据 → WebSocket 握手 → 写入记录后收到广播', async () => {
    const ticketRes = await req('/ui/api/hub-ticket', { method: 'POST' });
    expect(ticketRes.status, '票据端点必须可用（503 = DO 打不通）').toBe(200);
    const { token, path } = (await ticketRes.json()) as { token: string; path: string };
    expect(token, '票据不能为空').toBeTruthy();
    expect(path, '票据必须给出可直接使用的连接路径').toBe(`/SyncClipboardHub?id=${token}`);

    const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}${path}`);
    const frames: string[] = [];
    // 等的是**事件本身**（握手响应 / 广播），超时只作兜底：这两个信号都是服务端推来的，
    // 没有需要猜的间隔。轮询式等待会把「多久算到」变成一个魔数。
    let onFrame: ((frame: string) => void) | null = null;
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      for (const frame of event.data.split('\x1e')) {
        if (frame === '') continue;
        frames.push(frame);
        onFrame?.(frame);
      }
    });
    const nextFrame = (predicate: (frame: string) => boolean, label: string, timeoutMs = 10_000) =>
      new Promise<string>((resolve, reject) => {
        const seen = frames.find(predicate);
        if (seen !== undefined) return resolve(seen);
        // 连接提前结束就立刻失败并带上原因：票据被拒/鉴权失败时应当**毫秒级**报出来，
        // 而不是空等超时——「超时」对排查鉴权问题没有任何信息量。
        const giveUp = (reason: string) => {
          clearTimeout(timer);
          onFrame = null;
          reject(new Error(`${label}（${reason}）`));
        };
        const timer = setTimeout(() => giveUp(`超时 ${timeoutMs}ms`), timeoutMs);
        socket.addEventListener('close', (event) => giveUp(`连接关闭 code=${event.code} ${event.reason ?? ''}`), { once: true });
        socket.addEventListener('error', () => giveUp('连接出错'), { once: true });
        onFrame = (frame) => {
          if (!predicate(frame)) return;
          clearTimeout(timer);
          onFrame = null;
          resolve(frame);
        };
      });

    try {
      socket.addEventListener('open', () => socket.send('{"protocol":"json","version":1}\x1e'));
      await nextFrame((frame) => frame === '{}', '未收到握手响应 {}（票据未通过 DO 鉴权？）');

      // 一次真实写入 → 服务端广播 RemoteHistoryChanged（与官方客户端同一条广播路径）
      await putText(`ui-push-${RUN}`);
      await nextFrame((frame) => frame.includes('"RemoteHistoryChanged"'), '连上了却没收到广播');
    } finally {
      socket.close();
    }
  });

  it('票据端点必须要求凭据（未认证 → 401，不发票据）', async () => {
    const anon = await fetch(`${BASE}/ui/api/hub-ticket`, { method: 'POST' });
    expect(anon.status).toBe(401);
  });
});

describe('UI API 维护面契约（批量上限 / 清空 / 完整性 / 保留策略来源）', () => {
  // 这一组钉的是**接口契约本身**：这些端点由界面按钮直接调用，形状变了界面会静默出错，
  // 而它们各自的行为验证在别处（清空/覆盖对 Cron 的联动见 test/cleanup.test.ts）。
  it('清空端点：scope 非法 → 400；非 JSON → 415', async () => {
    const bad = await req('/ui/api/history/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'everything' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_scope' });

    const wrongType = await req('/ui/api/history/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'scope=all',
    });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ error: 'unsupported_media_type' });
  });

  it('批量写：≥101 条 → 400（单次 100 条封顶，调用方分片）；非布尔字段 → 400', async () => {
    // 成本纪律：每条 ≈5 次子请求，200 条正好顶到单次调用 1000 次内部子请求的上限、零余量
    const tooMany = await req('/ui/api/history/batch-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: Array.from({ length: 101 }, () => ({ type: 'Text', hash: 'F'.repeat(64) })),
        update: { starred: true },
      }),
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: 'too_many_items' });

    // 非布尔的字段名不能静默忽略：那会让「批量收藏」在拼错字段时变成一次静默成功的空操作
    const badField = await req('/ui/api/history/batch-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ type: 'Text', hash: 'F'.repeat(64) }], update: { starred: 'yes' } }),
    });
    expect(badField.status).toBe(400);
    expect(await badField.json()).toEqual({ error: 'invalid_request' });
  });

  it('完整性自检：计数自洽、清单不超过上限、`missingTruncated` 由计数推导', async () => {
    const res = await req('/ui/api/integrity');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recordsWithData: number;
      historyObjects: number;
      missingCount: number;
      missingTruncated: boolean;
      missing: { type: string; hash: string; text: string; createTime: string; size: number }[];
    };
    expect(Number.isInteger(body.recordsWithData)).toBe(true);
    expect(Number.isInteger(body.historyObjects)).toBe(true);
    expect(body.missing.length).toBeLessThanOrEqual(50);
    expect(body.missingCount).toBeGreaterThanOrEqual(body.missing.length);
    expect(body.missingTruncated).toBe(body.missingCount > body.missing.length);
    for (const item of body.missing) {
      expect(typeof item.hash).toBe('string');
      expect(Number.isFinite(Date.parse(item.createTime)), `createTime 必须是 ISO 串：${item.createTime}`).toBe(true);
    }
  });

  it('/ui/api/info 的 retention 带来源字段，且与 PUT 回读同源', async () => {
    const info = (await (await req('/ui/api/info')).json()) as { retention: Record<string, unknown> };
    expect(Object.keys(info.retention).sort()).toEqual([
      'maxCountSource',
      'maxSavedHistoryCount',
      'retentionMinutes',
      'retentionSource',
    ]);
    expect(['env', 'meta']).toContain(info.retention.retentionSource);
    expect(['env', 'meta']).toContain(info.retention.maxCountSource);

    // 界面据此显示「此处的设置 / 部署环境变量」——来源只报在 settings 那边等于永远显示「部署环境变量」
    // （复核发现的接线缺口）。清除一处覆盖（幂等：不存在时删掉零行）后两边必须一致。
    const cleared = (await (
      await req('/ui/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionMinutes: null }),
      })
    ).json()) as { retention: { retentionMinutes: number | null; retentionSource: string } };
    const after = (await (await req('/ui/api/info')).json()) as { retention: { retentionMinutes: number | null } };
    expect(after.retention.retentionMinutes).toBe(cleared.retention.retentionMinutes);
    expect(cleared.retention.retentionSource).toBe('env');
  });
});

describe('verifyCredentials 未配置凭据边界（单元，review 修复）', () => {
  // 假 env：verifyCredentials 只读 USERNAME/PASSWORD，其余绑定不需要
  const unconfigured = { USERNAME: '', PASSWORD: '' } as unknown as Bindings;
  const configured = { USERNAME: 'u', PASSWORD: 'p' } as unknown as Bindings;

  it('未配置凭据（空用户名/密码）时，空凭据也必须拒绝（fail-closed）', () => {
    // 修复前：safeEqual('', undefined) 两侧都是零长度字节数组 → 判等 → true，
    // 于是 `Authorization: Basic Og==`（即 ":"）能通过，/ui/api/session 返回
    // authenticated:true，把「未配置」诊断掩盖成「已登录」。
    expect(verifyCredentials(unconfigured, '', '')).toBe(false);
    expect(verifyCredentials(unconfigured, 'u', 'p')).toBe(false);
  });

  it('配置凭据后：正确凭据 true、错误凭据 false', () => {
    expect(verifyCredentials(configured, 'u', 'p')).toBe(true);
    expect(verifyCredentials(configured, 'u', 'x')).toBe(false);
    expect(verifyCredentials(configured, 'x', 'p')).toBe(false);
  });
});

describe('UI API 数据端点 Range（206 / 416 / 回退 200）', () => {
  // docs/backend-gaps.md §2.3：Range **只**加在这个端点上。协议侧 `/file/{name}` 与
  // `/api/history/{id}/data` 忽略 Range 是对齐上游的有意行为（F29b，fix-regressions 有断言守着），
  // 故本套件不碰那两条路径。
  const name = `ui-range-${RUN}.bin`;
  // 内容用可读字符：切片断言直接比字符串，失败时看得出到底取了哪一段
  const content = Buffer.from('0123456789abcdefghij');
  const text = content.toString();
  // 零长度对象单列一条：Range 在它上面按 RFC 9110 §14.2 被忽略（见 routes.ts 的注释），
  // 与「起点越界 → 416」是两条不同的分支，必须有断言钉住。
  const emptyName = `ui-range-empty-${RUN}.bin`;
  const emptyContent = Buffer.alloc(0);
  // 上游 File 记录的 hash 规则：sha256(文本 | sha256(数据))，两段都是大写十六进制
  const fileHashOf = (fileName: string, data: Buffer): string =>
    createHash('sha256')
      .update(`${fileName}|${createHash('sha256').update(data).digest('hex').toUpperCase()}`)
      .digest('hex')
      .toUpperCase();
  const fileHash = fileHashOf(name, content);
  const emptyHash = fileHashOf(emptyName, emptyContent);
  const DATA = `/ui/api/history/File/${fileHash}/data`;
  const EMPTY_DATA = `/ui/api/history/File/${emptyHash}/data`;

  // 造一条**带数据**的记录：先 PUT /file 暂存，再 PUT /SyncClipboard.json 入库
  const putFileRecord = async (fileName: string, hash: string, data: Buffer): Promise<void> => {
    expect((await req(`/file/${fileName}`, { method: 'PUT', body: data })).status, '暂存文件').toBe(200);
    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'File',
        hash,
        text: fileName,
        hasData: true,
        dataName: fileName,
        size: data.length,
      }),
    });
    expect(put.status, '入库带数据记录').toBe(200);
  };

  beforeAll(async () => {
    const probe = await req('/ui/api/session');
    if (probe.status !== 200) throw new Error(`dev server 不可用 (${BASE}): /ui/api/session -> ${probe.status}`);
    await putFileRecord(name, fileHash, content);
    await putFileRecord(emptyName, emptyHash, emptyContent);
  });

  afterAll(async () => {
    // 软删收尾（走官方 PATCH，与 UI 同一写路径；软删会连带清掉 R2 数据目录）。
    // 路径必须是 `:type/:hash` 三段形态：`File-<hash>` 是 GET/DELETE 的 profileId 形态，
    // 用在 PATCH 上只会 404 —— 同时容忍那个 404 就会「看起来清理成功、记录其实还在」。
    // 只容忍「记录根本没建成」（例如 beforeAll 就失败），真正的残留由下面的活跃列表断言兜底。
    for (const [hash, fileName] of [
      [fileHash, name],
      [emptyHash, emptyName],
    ] as const) {
      const cleanup = await req(`/api/history/File/${hash}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDelete: true, version: 10_000, lastModified: new Date().toISOString() }),
      });
      expect([200, 404], `收尾软删 ${fileName}`).toContain(cleanup.status);
      const list = await req(`/ui/api/history?search=${encodeURIComponent(fileName)}`);
      const body = (await list.json()) as { total: number };
      expect(body.total, `收尾后 ${fileName} 不得留在活跃列表里（残留即清理路径写错）`).toBe(0);
    }
  });

  it('无 Range → 200 全量 + accept-ranges: bytes', async () => {
    const res = await req(DATA);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges'), '声明支持 Range，浏览器/播放器才会发区间请求').toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(content.length));
    expect(await res.text()).toBe(text);
  });

  it('bytes=0-4 → 206，content-range 与 5 字节体', async () => {
    const res = await req(DATA, { headers: { Range: 'bytes=0-4' } });
    expect(res.status, '可满足的单段区间必须 206').toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-4/${content.length}`);
    expect(res.headers.get('content-length')).toBe('5');
    expect(await res.text()).toBe(text.slice(0, 5));
    // 206 仍带着数据端点原有的头：Range 不改变缓存/内联语义
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    // ⚠️ 2026-09-21：夹具是 `ui-range-<RUN>.bin`，`.bin` **不在**内联白名单里 ⇒ 现在强制 `attachment`
    // （策略由"可渲染黑名单"改成"默认-deny 内联白名单"，见 docs/progress.md §106）。
    expect(res.headers.get('content-disposition')?.startsWith('attachment')).toBe(true);
  });

  it('bytes=5-（省略末尾）→ 206 直到对象结尾', async () => {
    const res = await req(DATA, { headers: { Range: 'bytes=5-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 5-${content.length - 1}/${content.length}`);
    expect(res.headers.get('content-length')).toBe(String(content.length - 5));
    expect(await res.text()).toBe(text.slice(5));
  });

  it('bytes=-3（后缀区间）→ 206 末 3 字节', async () => {
    const res = await req(DATA, { headers: { Range: 'bytes=-3' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes ${content.length - 3}-${content.length - 1}/${content.length}`,
    );
    expect(res.headers.get('content-length')).toBe('3');
    expect(await res.text()).toBe(text.slice(-3));
  });

  it('末尾超出对象长度 → 收窄到对象末尾（RFC 9110：不算不可满足）', async () => {
    const res = await req(DATA, { headers: { Range: `bytes=5-${content.length + 999}` } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 5-${content.length - 1}/${content.length}`);
    expect(await res.text()).toBe(text.slice(5));
  });

  it('起点 ≥ size → 416 + content-range: bytes */size（不回对象体）', async () => {
    const res = await req(DATA, { headers: { Range: 'bytes=999999-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${content.length}`);
    expect((await res.arrayBuffer()).byteLength, '416 必须不回对象体').toBe(0);
  });

  it('bytes=-0 → 416（后缀长度 0 不可满足，RFC 9110 §14.1.2）', async () => {
    const res = await req(DATA, { headers: { Range: 'bytes=-0' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${content.length}`);
  });

  it('零长度对象：Range 被忽略 → 200 空体（不是 206/416）', async () => {
    // RFC 9110 §14.2 允许服务端对「没有内容的表示」忽略 Range；§14.1.2 下它的可满足形态只剩
    // 非零后缀区间，硬做 206/416 都得拼出退化的 content-range，故这里钉死「忽略」这条选择。
    for (const raw of ['bytes=0-', 'bytes=0-0', 'bytes=-5']) {
      const res = await req(EMPTY_DATA, { headers: { Range: raw } });
      expect(res.status, `${raw} 在零长度对象上必须回 200`).toBe(200);
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect((await res.arrayBuffer()).byteLength, `${raw} 的响应体必须为空`).toBe(0);
    }
  });

  it('多段 Range → 有意忽略，回退 200 全量', async () => {
    const res = await req(DATA, { headers: { Range: 'bytes=0-1,3-4' } });
    expect(res.status, '多段要 multipart/byteranges 响应体，本端点有意不做').toBe(200);
    expect(res.headers.get('content-length')).toBe(String(content.length));
    expect(await res.text()).toBe(text);
  });

  it('畸形 Range → 忽略，回退 200 全量', async () => {
    for (const raw of ['bytes=abc', 'bytes=5-3', 'bytes=', 'bytes=-', 'items=0-3']) {
      const res = await req(DATA, { headers: { Range: raw } });
      expect(res.status, `${raw} 必须当作没有 Range 处理`).toBe(200);
      expect(await res.text(), `${raw} 的响应体`).toBe(text);
    }
  });
});

// 收尾：本套件会写目标库，必须自己清理干净（即使用例中途失败 —— 记录可能已处于
// 星标/非星标、已删/未删任一状态，用官方 PATCH isDelete 走与 UI 相同的写路径，
// 与 UI 实现缺陷解耦）。清单来自 putText 的登记，故 beforeAll 建的每条都在这里回收。
afterAll(async () => {
  const failed: string[] = [];
  for (const hash of createdHashes) {
    let res: Response;
    try {
      res = await req(`/api/history/Text/${hash}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDelete: true, version: 10_000, lastModified: new Date().toISOString() }),
      });
    } catch (err) {
      failed.push(`${hash}: ${(err as Error).message}`);
      continue;
    }
    // 404 = 记录已不存在（被批量删除用例删掉或从未创建），同样是干净状态
    if (res.status !== 200 && res.status !== 404) {
      failed.push(`${hash}: PATCH ${res.status}`);
    }
  }
  // 清理失败必须让套件失败 —— 静默残留正是本收尾要避免的事
  expect(failed, `清理失败，目标库可能已被写入残留记录：${failed.join('; ')}`).toEqual([]);
});
