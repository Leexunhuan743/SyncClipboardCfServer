// 交互状态采集（手动运行，不属于 npm test 套件）
//
// 为什么需要它：`probe.mjs` 只读**首屏静止**的 DOM。而"界面像不像成品"几乎全在**交互状态**里
// —— 选中态、批量条、浮层、键盘、reduced-motion。这些此前一条都没有被验证过：
// 写的时候是照着约定写的，但没人**真的点过**。
//
// 本脚本用 CDP 逐个进入这些状态，把每一步的可观测事实（元素存在性、属性值、几何尺寸、
// 层级关系）打出来，并在关键状态截图。判据用"事实"而不是"看起来对不对"：
//   · 批量条出现时它必须是 `position: fixed` 且不遮挡行（读 rect 比较）
//   · 菜单必须贴在按钮旁边且**在视口内**（读 rect）
//   · 预览对话框必须是 `open` 且焦点在它内部
//   · `prefers-reduced-motion: reduce` 下行必须立即处于终态（读 animation-name）
//
// 用法（需 dev server 已启动）：
//   node test/manual/states.mjs                 # 全部状态 + 截图
//   node test/manual/states.mjs --no-shots      # 只读值
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const OUT = resolve(arg('out', '.shots'));
const PORT = Number(arg('port', '9351'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SHOTS = !process.argv.includes('--no-shots');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const path of BROWSERS) if (existsSync(path)) return path;
  throw new Error(`未找到 Edge/Chrome：\n  ${BROWSERS.join('\n  ')}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { settle, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
        else settle(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    return new Promise((settle, reject) => {
      this.pending.set(id, { settle, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30_000);
    });
  }
}

async function waitForDevTools(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return res.json();
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`DevTools 端点未就绪：${last?.message}`);
}

const results = [];
const problems = [];
function record(name, value) {
  results.push({ name, value });
  console.log(`${name.padEnd(22)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
function expect(name, condition, detail) {
  if (condition) return;
  problems.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}

mkdirSync(OUT, { recursive: true });
const profileDir = join(tmpdir(), `states-profile-${process.pid}`);
mkdirSync(profileDir, { recursive: true });

const proc = spawn(
  findBrowser(),
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
let browserWs;
try {
  const version = await waitForDevTools(PORT);
  browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((settle, reject) => {
    browserWs.addEventListener('open', settle, { once: true });
    browserWs.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  cdp = new Cdp(browserWs);

  const consoleErrors = [];
  cdp.listeners.push((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(`未捕获：${msg.params?.exceptionDetails?.exception?.description ?? ''}`);
    }
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  for (const domain of ['Runtime.enable', 'Page.enable']) void domain;

  const login = await fetch(`${BASE}/ui/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}`);
  const rawCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const eq = rawCookie.indexOf('=');
  const cookieName = rawCookie.slice(0, eq);
  const cookieValue = rawCookie.slice(eq + 1);
  const cookieDomain = new URL(BASE).hostname;

  /**
   * 会话 Cookie 的开关。
   *
   * 12 节要测"未登录时的登录页"，而已经登录的浏览器打开登录页会**立刻跳走**（那是正确的行为），
   * 所以那几条断言必须先把 Cookie 摘掉；测"已登录时的跳转"时再装回去。
   * 不打失败密码：服务端对登录失败有速率限制，反复跑会把本机关进小黑屋。
   */
  const setSessionCookie = () =>
    send('Network.setCookie', {
      name: cookieName,
      value: cookieValue,
      domain: cookieDomain,
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    });
  const clearSessionCookie = () => send('Network.deleteCookies', { name: cookieName, domain: cookieDomain });

  await setSessionCookie();

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`${d.text ?? 'Uncaught'} :: ${d.exception?.description ?? ''}`);
    }
    return result.result.value;
  };

  const shoot = async (name, { fullPage = false } = {}) => {
    if (!SHOTS) return;
    const params = { format: 'png' };
    if (fullPage) params.captureBeyondViewport = true;
    const { data } = await send('Page.captureScreenshot', params);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(4000);

  // ── 1. 行高与密度 + **挂载点 id 契约** ────────────────────────
  // `id` 契约：`boot.js` 用 `replaceWith` 换掉 HTML 里的占位元素，因此每个被替换的挂载点
  // 都必须在**新建的元素**上带同一个 id。漏掉它的症状是"按 id 找不到"，
  // 而元素在屏幕上好好的 —— 肉眼完全不可见。这里逐个查（`overview` 与 `batchbar` 都踩过）。
  const mountIds = await evaluate(`(() => {
    const ids = ['appbar', 'overview', 'notice', 'omnibox', 'filters', 'board-area', 'pager', 'batchbar', 'toasts'];
    const missing = ids.filter((id) => !document.getElementById(id));
    return {
      missing,
      // 占位元素不该留在 DOM 里（它们被 replaceWith 换掉了），故 id 必须唯一且只有一个
      duplicates: ids.filter((id) => document.querySelectorAll('#' + CSS.escape(id)).length > 1),
    };
  })()`);
  record('mount ids', mountIds);
  expect('挂载点 id 齐全', mountIds.missing.length === 0, `这些 id 在 DOM 里找不到：${mountIds.missing.join(', ')}`);

  const geometry = await evaluate(`(() => {
    const row = document.querySelector('.item');
    const cell = row?.querySelector('.board__cell--content');
    const text = row?.querySelector('.entry__text');
    const meta = row?.querySelector('.entry__meta');
    const table = document.querySelector('.board__table');
    const cs = text ? getComputedStyle(text) : null;
    return {
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      contentWidth: cell ? Math.round(cell.getBoundingClientRect().width) : null,
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
      textFontSize: cs?.fontSize ?? null,
      textLineHeight: cs?.lineHeight ?? null,
      metaFontSize: meta ? getComputedStyle(meta).fontSize : null,
      overviewHeight: Math.round(document.querySelector('.overview')?.getBoundingClientRect().height ?? 0),
      rowsPerScreen: row ? Math.floor(window.innerHeight / row.getBoundingClientRect().height) : null,
    };
  })()`);
  record('geometry', geometry);
  // 正文必须拿到表格的绝大部分宽度（"正文优先"这条原则的机械判据）
  expect(
    '正文宽度占比',
    geometry.contentWidth / geometry.tableWidth >= 0.55,
    `内容列只占表格的 ${((geometry.contentWidth / geometry.tableWidth) * 100).toFixed(1)}%`,
  );
  // 行高是**观感**问题，但有一个下限：两行内容 + 缩略图必须放得下（不然会截断）
  expect('行高容得下两行', geometry.rowHeight >= 64, `行高只有 ${geometry.rowHeight}px`);

  // 骨架行高必须**等于**真实行高（2026-09-19 修，审计报告 §10.1）：
  // 修前 `.ghost` 写死 `height: var(--row-h)`，每行比真实行低 13px（50 行满页差 650px），
  // 而三处注释都声称两者同高 —— 这条不变式此前**只有注释钉着**，故在此补一条几何断言。
  // 注入一行骨架来量：fast path 下骨架只存在一帧，走正常流程是量不到的。
  const ghostGeom = JSON.parse(await evaluate(`(() => {
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.className = 'ghost';
    probe.innerHTML = '<span class="ghost__bar ghost__bar--kind"></span>'
      + '<span class="ghost__bar ghost__bar--wide"></span>'
      + '<span class="ghost__bar ghost__bar--short"></span>';
    document.body.append(probe);
    const measure = () => ({
      ghostH: Math.round(probe.getBoundingClientRect().height),
      realH: Math.round(document.querySelector('tr.item')?.getBoundingClientRect().height ?? 0),
      rowH: getComputedStyle(root).getPropertyValue('--row-h').trim(),
    });
    const had = root.dataset.density;
    const wide = measure();
    root.dataset.density = 'compact';
    const compact = measure();
    if (had === undefined) delete root.dataset.density; else root.dataset.density = had;
    probe.remove();
    return JSON.stringify({ wide, compact });
  })()`));
  record('骨架行高=真实行高', ghostGeom);
  expect('骨架行与真实行同高（宽松）', ghostGeom.wide.ghostH === ghostGeom.wide.realH,
    `骨架 ${ghostGeom.wide.ghostH}px vs 真实 ${ghostGeom.wide.realH}px（--row-h=${ghostGeom.wide.rowH}）`);
  expect('骨架行与真实行同高（紧凑）', ghostGeom.compact.ghostH === ghostGeom.compact.realH,
    `骨架 ${ghostGeom.compact.ghostH}px vs 真实 ${ghostGeom.compact.realH}px（--row-h=${ghostGeom.compact.rowH}）`);

  await shoot('10-state-rows');

  // ── 2. 行内操作：rest 态可见性 + hover 全亮 ────────────────────
  const ops = await evaluate(`(() => {
    const row = document.querySelector('.item');
    const wrap = row?.querySelector('.rowops');
    const buttons = [...(wrap?.querySelectorAll('.icon-btn') ?? [])];
    return {
      count: buttons.length,
      opacity: wrap ? getComputedStyle(wrap).opacity : null,
      icons: buttons.map((b) => b.dataset.icon),
      labels: buttons.map((b) => b.getAttribute('aria-label')),
      hitHeight: buttons[0] ? Math.round(buttons[0].getBoundingClientRect().height) : null,
    };
  })()`);
  record('rowops', ops);
  expect('行操作数', ops.count === 3, `期望 3 个（主操作 + 收藏 + 溢出），实际 ${ops.count}`);
  expect('行操作 rest 可见', Number(ops.opacity) >= 0.5, `rest 不透明度只有 ${ops.opacity}，等于不可见`);

  // ── 2b. 紧凑模式开关（用户要求：从抽屉移到列表头）───────────────
  // 判据全部取自**浏览器实际状态**：行高真的变了、状态真的进了 localStorage、能切回来。
  // 只测"按钮在不在"是不够的 —— 一个不生效的开关比没有开关更糟。
  const density = await evaluate(`(async () => {
    const btn = document.querySelector('.board-head .icon-btn[data-icon="list"]');
    if (!btn) return { error: '列表头没有紧凑模式开关' };
    const before = Math.round(document.querySelector('.item').getBoundingClientRect().height);
    const pressedBefore = btn.getAttribute('aria-pressed');
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      before,
      after: Math.round(document.querySelector('.item').getBoundingClientRect().height),
      pressedBefore,
      pressedAfter: btn.getAttribute('aria-pressed'),
      stored: localStorage.getItem('sb-ui-density'),
      rootAttr: document.documentElement.dataset.density ?? null,
      label: btn.getAttribute('aria-label'),
    };
  })()`);
  record('density toggle', density);
  expect('紧凑开关存在', !density.error, density.error ?? '');
  expect('行高真的变矮', density.after < density.before, `行高 ${density.before} → ${density.after}（没变矮）`);
  expect('状态可见', density.pressedAfter === 'true', `aria-pressed=${density.pressedAfter}`);
  expect('写进了 localStorage', density.stored === 'compact', `stored=${density.stored}`);

  // 关掉再确认能切回来（避免"只能进不能出"）
  const densityOff = await evaluate(`(async () => {
    const btn = document.querySelector('.board-head .icon-btn[data-icon="list"]');
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      height: Math.round(document.querySelector('.item').getBoundingClientRect().height),
      pressed: btn.getAttribute('aria-pressed'),
      rootAttr: document.documentElement.dataset.density ?? null,
    };
  })()`);
  record('density off', densityOff);
  expect('能切回宽松', densityOff.pressed === 'false', `aria-pressed=${densityOff.pressed}`);
  expect('行高回来了', densityOff.height === density.before, `行高 ${densityOff.height}，期望 ${density.before}`);

  // 刷新后仍然生效（它存在 localStorage，`theme-init.js` 在首帧前就应用）
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  const densityPersist = await evaluate(`(async () => {
    const btn = document.querySelector('.board-head .icon-btn[data-icon="list"]');
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return { stored: localStorage.getItem('sb-ui-density') };
  })()`);
  expect('紧凑模式写盘', densityPersist.stored === 'compact', `stored=${densityPersist.stored}`);
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  const afterReload = await evaluate(`(async () => {
    const compact = Math.round(document.querySelector('.item').getBoundingClientRect().height);
    const rootAttr = document.documentElement.dataset.density ?? null;
    const btn = document.querySelector('.board-head .icon-btn[data-icon="list"]');
    const pressed = btn?.getAttribute('aria-pressed') ?? null;
    // 收尾：切回宽松，别把状态留给后面的断言
    if (pressed === 'true') { btn.click(); await new Promise((r) => setTimeout(r, 300)); }
    return { compact, rootAttr, pressed };
  })()`);
  record('刷新后仍紧凑', afterReload);
  expect('刷新后仍生效', afterReload.rootAttr === 'compact', `data-density=${afterReload.rootAttr}`);
  expect('刷新后开关态正确', afterReload.pressed === 'true', `aria-pressed=${afterReload.pressed}`);

  // 抽屉里只该有一句指向开关的说明，不该再有第二个同功能的控件
  const drawerNote = await evaluate(`(async () => {
    document.getElementById('overview').click();
    await new Promise((r) => setTimeout(r, 800));
    const row = [...document.querySelectorAll('.drawer .row')].find((r) => r.textContent.includes('行高'));
    return {
      text: row?.textContent?.trim() ?? null,
      hasControls: row ? row.querySelectorAll('input, select, button').length : null,
    };
  })()`);
  record('抽屉里的行高行', drawerNote);
  expect('抽屉只说明不重复控件', drawerNote.hasControls === 0, `抽屉里还有 ${drawerNote.hasControls} 个可改行高的控件`);
  expect('说明指出了开关位置', /☰|列表/.test(drawerNote.text ?? ''), `文案是「${drawerNote.text}」`);
  await evaluate(`document.querySelector('.drawer')?.close()`);
  await wait(300);

  // ── 3. 键盘：`/` 聚焦搜索 ────────────────────────────────────
  await evaluate(`document.body.focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', text: '/' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/' });
  await wait(250);
  const searchFocus = await evaluate(
    `document.activeElement?.id ?? document.activeElement?.tagName ?? null`,
  );
  record('键盘 / → 焦点', searchFocus);
  expect('`/` 聚焦搜索', searchFocus === 'omnibox-input', `焦点落在 ${searchFocus}`);

  // ── 4. 选中 + 批量条 ─────────────────────────────────────────
  await evaluate(`document.activeElement.blur()`);
  const batch = await evaluate(`(async () => {
    const box = document.querySelector('.item .check');
    box.click();
    await new Promise((r) => setTimeout(r, 250));
    const bar = document.getElementById('batchbar');
    const row = document.querySelector('.item');
    const barRect = bar?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    return {
      hidden: bar?.hidden ?? null,
      count: bar?.querySelector('.batchbar__count')?.textContent ?? null,
      actions: [...(bar?.querySelectorAll('.btn') ?? [])].map((b) => ({
        label: b.querySelector('.btn__label')?.textContent,
        disabled: b.disabled,
      })),
      position: bar ? getComputedStyle(bar).position : null,
      rowSelected: row?.hasAttribute('data-selected') ?? null,
      checkboxChecked: document.querySelector('.item .check')?.checked ?? null,
      // 批量条是**悬浮**的：它不该把行的位置推下去（页面上第一条行的 top 不应变化）
      overlapsRow: barRect && rowRect ? barRect.top < rowRect.bottom : null,
    };
  })()`);
  record('batchbar', batch);
  expect('批量条出现', batch.hidden === false, `hidden=${batch.hidden}`);
  expect('批量条悬浮', batch.position === 'fixed', `position=${batch.position}`);
  expect('选中态落到行上', batch.rowSelected === true, '行没有 data-selected');
  await shoot('11-state-batchbar');

  // 回收站视图下「移动到回收站」应禁用、「恢复」应可用（视图决定可用性）
  await evaluate(`document.querySelector('[data-action="trash"]').click()`);
  await wait(1800);
  const trashBatch = await evaluate(`(() => {
    const box = document.querySelector('.item .check');
    box?.click();
    const bar = document.getElementById('batchbar');
    return {
      rows: document.querySelectorAll('.item').length,
      actions: [...(bar?.querySelectorAll('.btn') ?? [])].map((b) => ({
        label: b.querySelector('.btn__label')?.textContent,
        disabled: b.disabled,
      })),
    };
  })()`);
  record('batchbar@回收站', trashBatch);
  await shoot('12-state-trash');
  // 回到活跃视图
  await evaluate(`document.querySelector('[data-action="trash"]').click()`);
  await wait(1800);

  // ── 5. 溢出菜单 ───────────────────────────────────────────────
  // 这一组里有三条是**用户实际报告的缺陷**（"点更多之后无法点击其他地方关闭 / 滚动也不消失"），
  // 所以判据写得比"菜单在不在"严：它必须能被**三种**方式关掉，且滚动时不许留在屏幕上。
  const menuState = await evaluate(`(async () => {
    const btn = document.querySelector('.item .icon-btn[data-icon="dots"]');
    const rect = btn.getBoundingClientRect();
    btn.click();
    await new Promise((r) => setTimeout(r, 350));
    const menu = document.querySelector('.menu');
    const mRect = menu?.getBoundingClientRect();
    return {
      open: menu ? !menu.hidden : null,
      items: [...(menu?.querySelectorAll('.menu__item') ?? [])].map((b) => b.textContent.trim()),
      // 菜单必须贴在被点的按钮旁边（纵向距离 < 一个按钮高度），而不是飘在屏幕中间
      gapFromButton: mRect && rect ? Math.round(mRect.top - rect.bottom) : null,
      inViewport: mRect
        ? mRect.top >= 0 && mRect.left >= 0 &&
          mRect.bottom <= window.innerHeight && mRect.right <= window.innerWidth
        : null,
      focusInside: menu?.contains(document.activeElement) ?? null,
      backdropPresent: !!document.querySelector('.menu-backdrop:not([hidden])'),
    };
  })()`);
  record('menu', menuState);
  expect('菜单打开', menuState.open === true, `open=${menuState.open}`);
  expect('菜单在视口内', menuState.inViewport === true, '菜单超出了视口');
  expect('菜单贴着按钮', Math.abs(menuState.gapFromButton ?? 999) < 40, `与按钮距离 ${menuState.gapFromButton}px`);
  await shoot('13-state-menu');

  // 5a. **点外部要关**（用户报告的第 1 个症状）。
  // 用**真实鼠标事件**打在页面空白处 —— 合成事件绕不过"遮罩吃掉点击"这个真实成因。
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 640, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 640, button: 'left', clickCount: 1 });
  await wait(300);
  const afterOutsideClick = await evaluate(
    `JSON.stringify({ open: (() => { const m = document.querySelector('.menu'); return m ? !m.hidden : null; })(), backdropGone: !!document.querySelector('.menu-backdrop[hidden]') })`,
  );
  record('点外部后', afterOutsideClick);
  expect('点外部能关掉菜单', JSON.parse(afterOutsideClick).open === false, '点空白处菜单仍然开着');
  expect('遮罩一并收起', JSON.parse(afterOutsideClick).backdropGone === true, '遮罩还留着（会继续吃掉点击）');

  // 5b. **滚动要关**（用户报告的第 2 个症状：菜单不消失还会飘到别的行）
  const beforeScroll = await evaluate(`window.scrollY`);
  await evaluate(`document.querySelector('.item .icon-btn[data-icon="dots"]').click()`);
  await wait(300);
  const menuBeforeWheel = await evaluate(`!document.querySelector('.menu').hidden`);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: 400 });
  await wait(400);
  const scrollResult = await evaluate(
    `JSON.stringify({ menuOpen: !document.querySelector('.menu').hidden, scrollY: window.scrollY })`,
  );
  record('滚动后', scrollResult);
  expect('滚动前菜单是开着的', menuBeforeWheel === true, '第二次没打开，这条断言无效');
  expect('滚动能关掉菜单', JSON.parse(scrollResult).menuOpen === false, '滚动后菜单仍然挂在屏幕上');
  expect('页面确实滚了（否则这条断言是空转）', JSON.parse(scrollResult).scrollY > beforeScroll, '页面没滚动，说明滚轮没生效');
  // 滚回去，别影响后面的用例
  await evaluate(`window.scrollTo(0, ${beforeScroll})`);
  await wait(300);

  // 5c. Esc 仍然能关（原生行为，改成非 dialog 之后要自己实现，故必须守住）
  await evaluate(`document.querySelector('.item .icon-btn[data-icon="dots"]').click()`);
  await wait(350);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(300);
  const afterEsc = await evaluate(`!document.querySelector('.menu').hidden`);
  record('Esc 后菜单还开着？', afterEsc);
  expect('Esc 能关掉菜单', afterEsc === false, 'Esc 关不掉（改成非 dialog 后这条要自己实现）');

  // 5d. 点菜单里的动作要生效（而不是只关闭）。
  // 判据取**服务端返回值**而不是行内按钮的 `aria-pressed`：行会被随后的静默刷新重建，
  // 那一刻读到的按钮可能还没重绘完（实测踩过这个假阴性）。
  //
  // 2026-09-18 修正 —— 置顶优先生效后暴露了两处过期假设（都是这条脚本自己的，不是界面的）：
  //   ① 复核不能走"列表第一条 = 该类型第一条"（`?pageSize=1&types=X`）：置顶恒排在最前，
  //      刚被取消置顶的那条已经不是该类型的首条 → `find` 落空，读到 `null`（跑出来就是这条假红）。
  //      改成**按 hash 取单条**，不依赖任何排序假设。
  //   ② 复位必须按 `data-key` 认行：置顶/取消置顶会让这一行**换位置**，原来"再点一次第一条"
  //      会去切另一条记录（旧行为下行不动，所以一直没暴露）。
  const menuAction = await evaluate(`(async () => {
    const key = document.querySelector('.item').dataset.key;
    const nth = () => document.querySelector('.item[data-key="' + key + '"]');
    const [type, ...rest] = key.split('-');
    const readServer = async () => {
      const res = await fetch(
        '/ui/api/history/' + encodeURIComponent(type) + '/' + encodeURIComponent(rest.join('-')),
        { credentials: 'same-origin' },
      );
      const body = await res.json();
      return { status: res.status, pinned: body.pinned };
    };
    nth().querySelector('.icon-btn[data-icon="dots"]').click();
    await new Promise((r) => setTimeout(r, 350));
    const pin = [...document.querySelectorAll('.menu__item')].find((b) => /置顶/.test(b.textContent));
    if (!pin) return JSON.stringify({ error: '菜单里没有置顶项' });
    const wasPinned = pin.textContent.trim() === '取消置顶';
    pin.click();
    await new Promise((r) => setTimeout(r, 1600));
    const server = await readServer();
    return JSON.stringify({
      key,
      menuClosed: !document.querySelector('.menu').hidden,
      wasPinned,
      serverPinned: server.pinned ?? null,
    });
  })()`);
  record('菜单里的「置顶」', menuAction);
  if (!JSON.parse(menuAction).error) {
    const parsed = JSON.parse(menuAction);
    expect('点动作后菜单收拾干净', parsed.menuClosed === false, '菜单没关');
    // 动作是**切换**：原来没置顶 → 现在应当置顶；原来置顶 → 现在应当没置顶
    expect(
      '点动作确实生效（服务端复核）',
      parsed.serverPinned === !parsed.wasPinned,
      `原来 pinned=${parsed.wasPinned}，现在服务端 pinned=${parsed.serverPinned}`,
    );
    // 复位：切回原状态，别把数据留给后面的用例
    await evaluate(`(async () => {
      document.querySelector('.item[data-key="${parsed.key}"] .icon-btn[data-icon="dots"]')?.click();
      await new Promise((r) => setTimeout(r, 300));
      const pin = [...document.querySelectorAll('.menu__item')].find((b) => /置顶/.test(b.textContent));
      pin?.click();
      await new Promise((r) => setTimeout(r, 1200));
    })()`);
  }

  // ── 6. 预览对话框（文本全文） ─────────────────────────────────
  // 这一条特意等久一点：正文被截断的记录（`textTruncated`）在打开预览时会**先取一次单条**
  // 才拿得到全文，900ms 不够（实测第一次跑就是在这里读到 hasReadout=false）。
  const previewState = await evaluate(`(async () => {
    const row = document.querySelector('.item');
    const truncated = row.dataset.key;
    // 双击行 = 预览（不点复制，避免真的写剪贴板）
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    // 等到 readout 或 figure 出现（最多 6s）
    const deadline = Date.now() + 6000;
    let dlg = null;
    while (Date.now() < deadline) {
      dlg = [...document.querySelectorAll('dialog.dialog')].find((d) => d.open);
      if (dlg?.querySelector('.readout, .figure')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      key: truncated,
      open: !!dlg,
      title: dlg?.querySelector('.dialog__title')?.textContent ?? null,
      hasReadout: !!dlg?.querySelector('.readout'),
      readoutChars: dlg?.querySelector('.readout')?.textContent?.length ?? null,
      hasFigure: !!dlg?.querySelector('.figure'),
      focusInside: dlg ? dlg.contains(document.activeElement) : null,
      actions: [...(dlg?.querySelectorAll('.dialog__foot .btn') ?? [])].map((b) => b.textContent.trim()),
      hash: location.hash || null,
    };
  })()`);
  record('preview', previewState);
  expect('预览打开', previewState.open === true, '双击行没有打开预览');
  expect(
    '预览有内容',
    previewState.hasReadout || previewState.hasFigure,
    '对话框打开了但既没有文本区也没有图片区（正文可能没取回来）',
  );
  expect('预览抢到焦点', previewState.focusInside === true, '焦点不在对话框内（焦点陷阱失效）');
  // `actions` 之前只是被**记录**、没有被断言 —— 于是"预览框只剩一个「关闭」按钮"
  // 这个缺陷在本地悄悄活了很久，直到线上截图走查才被肉眼发现（2026-09-16）。
  // 教训：脚本收进 result 的字段必须有人断言，否则它只是一段没人读的日志。
  expect(
    '预览必须有动作按钮（复制内容 / 下载），不能只有「关闭」',
    previewState.actions.length >= 2 && previewState.actions.includes('关闭'),
    `页脚只有：${JSON.stringify(previewState.actions)}`,
  );
  await shoot('14-state-preview');
  await evaluate(`[...document.querySelectorAll('dialog.dialog')].find(d => d.open)?.close()`);
  await wait(400);
  const hashCleared = await evaluate(`location.hash || null`);
  record('预览关闭后 hash', hashCleared);

  // ── 6b. 媒体预览同样要有动作按钮（图片记录 → 下载 / 复制图片）──────
  const mediaPreview = await evaluate(`(async () => {
    const chip = [...document.querySelectorAll('.chip')].find((c) => c.dataset.kind === 'Image');
    if (!chip) return { skipped: '没有图片筛选 chip' };
    chip.click();
    await new Promise((r) => setTimeout(r, 2400));
    const row = document.querySelector('.item');
    if (!row) return { skipped: '本地没有图片记录' };
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const deadline = Date.now() + 6000;
    let dlg = null;
    while (Date.now() < deadline) {
      dlg = [...document.querySelectorAll('dialog.dialog')].find((d) => d.open);
      if (dlg?.querySelector('.figure')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const result = {
      hasFigure: !!dlg?.querySelector('.figure'),
      title: dlg?.querySelector('.dialog__title')?.textContent ?? null,
      actions: [...(dlg?.querySelectorAll('.dialog__foot .btn') ?? [])].map((b) => b.textContent.trim()),
    };
    dlg?.close();
    await new Promise((r) => setTimeout(r, 300));
    // 回到「全部」视图，后面的小节依赖默认视图
    [...document.querySelectorAll('.chip')].find((c) => c.dataset.kind === 'All')?.click();
    await new Promise((r) => setTimeout(r, 2200));
    return result;
  })()`);
  record('媒体预览', mediaPreview);
  if (!mediaPreview.skipped) {
    expect(
      '图片预览必须有「下载」动作',
      mediaPreview.actions.includes('下载'),
      `页脚只有：${JSON.stringify(mediaPreview.actions)}`,
    );
  }

  // ── 7. 移动到回收站的确认框（不真的动：只打开再取消） ────────────────────
  const confirmState = await evaluate(`(async () => {
    const row = document.querySelector('.item');
    row.querySelector('.icon-btn[data-icon="dots"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const del = [...document.querySelectorAll('.menu__item')].find((b) => b.textContent.includes('移动到回收站'));
    del.click();
    await new Promise((r) => setTimeout(r, 600));
    const dlg = [...document.querySelectorAll('dialog.dialog')].find((d) => d.open);
    const buttons = [...(dlg?.querySelectorAll('.dialog__foot .btn') ?? [])];
    const result = {
      open: !!dlg,
      title: dlg?.querySelector('.dialog__title')?.textContent ?? null,
      message: dlg?.querySelector('.dialog__body .note')?.textContent?.slice(0, 80) ?? null,
      buttons: buttons.map((b) => ({ label: b.textContent.trim(), cls: b.className })),
      focusInside: dlg ? dlg.contains(document.activeElement) : null,
    };
    // 取消（点第一个按钮）——不执行移动
    buttons[0]?.click();
    await new Promise((r) => setTimeout(r, 400));
    result.stillOpen = [...document.querySelectorAll('dialog.dialog')].some((d) => d.open);
    return result;
  })()`);
  record('confirm', confirmState);
  expect('确认框打开', confirmState.open === true, '菜单里的「移动到回收站」没有打开确认框');
  expect(
    '确认框必须说清"动的是哪一条 + 后果"',
    typeof confirmState.message === 'string' &&
      confirmState.message.includes('移动到回收站') &&
      confirmState.message.includes('所有同步设备'),
    `正文是「${confirmState.message}」`,
  );
  expect('确认框有取消与确认两个按钮', confirmState.buttons.length === 2, JSON.stringify(confirmState.buttons));
  expect('取消能关掉确认框', confirmState.stillOpen === false, '取消后对话框仍然打开');

  // ── 8. 抽屉（复核 + 焦点 + **信息层级**） ─────────────────────
  // 除了"打得开"，这里还守两条**用户视角**的不变式：
  //   ① 会动手改的区块必须排在只看的前面（用户反馈"概览与设置更加合理优化一下"）；
  //   ② 抽屉不该一打开就要滚很久 —— 总高相对视口的倍数是可量化的代理指标。
  const drawerState = await evaluate(`(async () => {
    document.getElementById('overview').click();
    await new Promise((r) => setTimeout(r, 700));
    const d = document.querySelector('.drawer');
    const body = d.querySelector('.drawer__body');
    // 区块顺序按 **DOM 顺序** 取（不是按高度），这才是"用户从上往下看到什么"
    const order = [...body.children].map((n) => {
      const t = n.querySelector('.section__title') ?? n.querySelector('.details__summary .section__title');
      return t?.textContent ?? '(未命名)';
    });
    const details = body.querySelector('.details');
    return {
      open: d?.open ?? null,
      order,
      bars: d.querySelectorAll('.bar').length,
      facts: d.querySelectorAll('.fact').length,
      focusInside: d.contains(document.activeElement),
      width: Math.round(d.getBoundingClientRect().width),
      scrollHeight: Math.round(body.scrollHeight),
      viewportHeight: Math.round(body.clientHeight),
      // 打开时折叠区块应是**收起**的（否则省下的高度是假的）
      detailsClosed: details ? !details.open : null,
      detailsSummary: details?.querySelector('.details__value')?.textContent ?? null,
    };
  })()`);
  record('drawer', {
    open: drawerState.open,
    order: drawerState.order,
    bars: drawerState.bars,
    facts: drawerState.facts,
    width: drawerState.width,
    scrollHeight: drawerState.scrollHeight,
    ratio: Number((drawerState.scrollHeight / drawerState.viewportHeight).toFixed(2)),
  });
  expect('抽屉打开', drawerState.open === true, `open=${drawerState.open}`);
  // 会改的设置在前、只读的信息在后
  const orderIndex = (name) => drawerState.order.findIndex((t) => t.includes(name));
  expect(
    '设置类区块排在只读区块之前',
    orderIndex('视图偏好') >= 0 && orderIndex('视图偏好') < orderIndex('部署信息'),
    `实际顺序：${drawerState.order.join(' → ')}`,
  );
  expect(
    '保留策略在部署信息之前',
    orderIndex('保留策略') >= 0 && orderIndex('保留策略') < orderIndex('部署信息'),
    `实际顺序：${drawerState.order.join(' → ')}`,
  );
  expect('活动趋势默认收起', drawerState.detailsClosed === true, '折叠区块打开时就是展开的，省下的高度是假的');
  expect(
    '活动趋势有一行摘要',
    /近 \d+ 天|还没有数据/.test(drawerState.detailsSummary ?? ''),
    `摘要是「${drawerState.detailsSummary}」`,
  );
  // 总高 / 视口：原来 1536/833 ≈ 1.84（要滚近两屏）。压到 1.35 以内才算"打开就看得完大半"。
  expect(
    '抽屉不再需要滚很久',
    drawerState.scrollHeight / drawerState.viewportHeight <= 1.35,
    `总高是视口的 ${(drawerState.scrollHeight / drawerState.viewportHeight).toFixed(2)} 倍（原为 1.84）`,
  );
  // 展开折叠区块后仍要能读到柱状图（折叠不能把功能藏没）
  const expanded = await evaluate(`(async () => {
    const d = document.querySelector('.drawer');
    const det = d.querySelector('.details');
    det.open = true;
    await new Promise((r) => setTimeout(r, 300));
    return { open: det.open, bars: d.querySelectorAll('.bar').length };
  })()`);
  record('展开活动趋势后', expanded);
  expect('展开后能看到图表', expanded.bars >= 14, `展开后只有 ${expanded.bars} 根柱子`);
  await evaluate(`document.querySelector('.details').open = false`);
  await wait(200);
  await shoot('15-state-drawer');
  await evaluate(`document.querySelector('.drawer')?.close()`);
  await wait(300);

  // ── 8b. 用户点名的三处（第四轮修，2026-09-15）─────────────────
  // 每一条都对应一个真实的用户抱怨，判据取"用户能不能顺畅做完这件事"，不是"代码有没有这段"。

  // (a) 时间范围选「自定义…」之后**不许停在"自定义"上**（那会让用户以为已经筛过了）
  const customRange = await evaluate(`(async () => {
    const sel = [...document.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === '时间范围');
    const before = sel.value;
    const countBefore = document.querySelector('.board-head__count').textContent;
    sel.value = 'custom';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
    const drawerOpen = document.querySelector('.drawer')?.open ?? false;
    const valueAfter = sel.value;
    const countAfter = document.querySelector('.board-head__count').textContent;
    document.querySelector('.drawer')?.close();
    await new Promise((r) => setTimeout(r, 300));
    return { before, valueAfter, drawerOpen, countBefore, countAfter };
  })()`);
  record('选「自定义…」后', customRange);
  expect('选「自定义…」会打开抽屉', customRange.drawerOpen === true, '抽屉没打开，用户没地方填日期');
  expect(
    '下拉框不许停在「自定义」',
    customRange.valueAfter === customRange.before,
    `下拉框停在 ${customRange.valueAfter}，而列表没筛（用户会以为筛过了）`,
  );
  expect(
    '列表结果也不该变',
    customRange.countAfter === customRange.countBefore,
    `列表从「${customRange.countBefore}」变成「${customRange.countAfter}」`,
  );

  // (b) 概览带必须看得出可点
  const overviewHint = await evaluate(`(() => {
    const o = document.querySelector('.overview');
    const hint = o.querySelector('.overview__hint');
    return JSON.stringify({
      hasHint: !!hint,
      hintVisible: hint ? getComputedStyle(hint).display !== 'none' : false,
      cursor: getComputedStyle(o).cursor,
    });
  })()`);
  record('概览可点提示', overviewHint);
  expect('概览带有可点提示', JSON.parse(overviewHint).hasHint === true, '整条可点但没有任何视觉提示');

  // (c) 回收站里行的**主操作**必须是「恢复」
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/?deleted=1` });
  await wait(3500);
  const trashPrimary = await evaluate(`(() => {
    const row = document.querySelector('.item');
    const first = row?.querySelector('.rowops .icon-btn');
    return JSON.stringify({
      hasRows: !!row,
      firstIcon: first?.dataset.icon ?? null,
      firstLabel: first?.getAttribute('aria-label') ?? null,
      firstDisabled: first?.disabled ?? null,
      rowDeletedBadge: !!row?.querySelector('.tag'),
    });
  })()`);
  record('回收站主操作', trashPrimary);
  const trash = JSON.parse(trashPrimary);
  if (trash.hasRows) {
    const expected = trash.firstDisabled ? 'undo' : 'undo';
    expect(
      '回收站主操作是「恢复」',
      trash.firstIcon === expected,
      `主操作是 ${trash.firstIcon}（${trash.firstLabel}），用户进回收站几乎总是为了恢复`,
    );
    expect(
      '不可恢复的记录给出原因',
      !trash.firstDisabled || /不可恢复|数据文件/.test(trash.firstLabel ?? ''),
      `按钮被禁用了但标签只说「${trash.firstLabel}」`,
    );
  }
  // 回到活跃视图
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3000);

  // (d) 手机端筛选区不许占太多行
  //
  // 数行时必须**先剔掉零尺寸项**：`.filters > *` 里有两个"幽灵"
  //   · `清除筛选` 在无筛选条件时是 `hidden`（0×0，`top` 读出来是 0）；
  //   · `刷新` 在窄屏被 `display: none`（0×0，同样是 0）；
  //   · `.filters__spacer` 是纯占位，高度也是 0，但它是**独立的一次 layout**，
  //     会贡献一个自己的 `top`。
  // 不剔掉它们，"行数"就变成"子元素个数"——第一版就是这样量出 4 行、把已经合格的布局判成失败的。
  // 判据必须是"占了多高"，不是"有几个 top"。
  const measureRows = `(() => {
    const kids = [...document.querySelectorAll('.filters > *')].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0; // 零尺寸 = 不可见，不算行
    });
    const rows = new Set(kids.map((n) => Math.round(n.getBoundingClientRect().top)));
    const card = document.querySelector('.item')?.getBoundingClientRect().height ?? 0;
    const bar = document.querySelector('.filters').getBoundingClientRect();
    return JSON.stringify({
      filterRows: rows.size,
      filterBarH: Math.round(bar.height),
      chips: document.querySelectorAll('.chips .chip').length,
      overflowing: [...document.querySelectorAll('.chips .chip')]
        .filter((c) => c.getBoundingClientRect().right > document.querySelector('.chips').getBoundingClientRect().right + 1)
        .length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardHeight: Math.round(card),
      rowsPerScreen: card ? Math.floor(window.innerHeight / card) : 0,
    });
  })()`;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  const mobile = await evaluate(measureRows);
  record('移动端筛选区', mobile);
  const m = JSON.parse(mobile);
  expect('移动端筛选区不超过 3 行', m.filterRows <= 3, `占了 ${m.filterRows} 行（原为 5 行）`);
  // 5 个类型 chip 横滚：至少有一个被切在右边，用户才知道"这里能滑"
  expect('类型 chips 提示了可横滑', m.chips > 0 && m.overflowing >= 1, `5 个 chip 全挤在可视区内（或被完全藏起）`);

  // 最坏情况重测一遍：筛选条里多出一个「清除筛选」按钮时仍不许超过 3 行
  await evaluate(`document.querySelector('.chip[data-tone="star"]')?.click()`);
  await wait(1500);
  const mobileActive = await evaluate(measureRows);
  record('移动端筛选区（有筛选条件时）', mobileActive);
  const ma = JSON.parse(mobileActive);
  expect('有筛选条件时仍不超过 3 行', ma.filterRows <= 3, `占了 ${ma.filterRows} 行`);
  expect('清除筛选已经出现', ma.filterBarH > m.filterBarH, `筛选条高度没变（${ma.filterBarH}px），清除筛选可能没渲染`);
  expect('移动端无横向溢出', m.overflowX === 0, `多出 ${m.overflowX}px`);
  await shoot('16-state-mobile');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3000);

  // (e) 复制失败时的话必须说清原因、并且**替用户打开预览**
  //
  // 本地是 http://127.0.0.1 —— 它是安全上下文，剪贴板其实**写得进去**，
  // 所以这条路径在开发机上永远不会自然发生（这正是它长期没被发现的原因）。
  // 做法：把两条写入路径都打桩成失败（`navigator.clipboard.writeText` 与
  // `document.execCommand`），再点第一行的「复制」。只改页面内的全局，不写库。
  const stubFail = `(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('stub')), write: () => Promise.reject(new Error('stub')) },
    });
    document.execCommand = () => false;
    return 'stubbed';
  })()`;
  const readCopyFailure = `(() => {
    const toast = document.querySelector('.toast');
    return JSON.stringify({
      hasTextRow: !!document.querySelector('.item .rowops .icon-btn[data-icon="copy"]'),
      tone: toast?.dataset.tone ?? null,
      text: toast?.textContent ?? null,
      previewOpened: !!document.querySelector('dialog[open]'),
      secureContext: window.isSecureContext,
    });
  })()`;

  await evaluate(stubFail);
  await evaluate(`document.querySelector('.item .rowops .icon-btn[data-icon="copy"]').click()`);
  await wait(1800);
  const copyFail = await evaluate(readCopyFailure);
  record('复制失败（安全上下文）', copyFail);
  const cf = JSON.parse(copyFail);
  expect('复制失败的提示说清了原因', /不是 https|剪贴板权限/.test(cf.text ?? ''), `提示是「${cf.text}」`);
  expect('复制失败时给出退路', /Ctrl|选(中|择)/.test(cf.text ?? ''), `提示没告诉用户下一步怎么办：「${cf.text}」`);
  expect('复制失败时自动打开预览', cf.previewOpened === true, '只弹了提示，没替用户打开预览（用户还得自己找）');

  // 再验 http（非安全上下文）那一种措辞：把 isSecureContext 打桩成 false 重来一次
  await evaluate(`document.querySelector('dialog[open] .dialog__close, dialog[open] .icon-btn')?.click()`);
  await wait(600);
  await evaluate(`(() => {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    return 'insecure';
  })()`);
  await evaluate(`document.querySelector('.item .rowops .icon-btn[data-icon="copy"]').click()`);
  await wait(1800);
  const copyInsecure = await evaluate(readCopyFailure);
  record('复制失败（http 站点）', copyInsecure);
  const ci = JSON.parse(copyInsecure);
  expect(
    'http 站点上的提示点名 https',
    ci.secureContext === false && /不是 https/.test(ci.text ?? ''),
    `提示是「${ci.text}」`,
  );
  expect('http 站点上同样自动打开预览', ci.previewOpened === true, '没打开预览');
  await shoot('17-state-copy-failed');

  // ── 9. reduced-motion：行必须立即处于终态 ──────────────────────
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  const reduced = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.item')];
    const animated = rows.filter((r) => {
      const cs = getComputedStyle(r);
      return cs.animationName !== 'none' && cs.animationDuration !== '0.01ms';
    });
    return {
      rows: rows.length,
      rowsWithRealAnimation: animated.length,
      firstOpacity: rows[0] ? getComputedStyle(rows[0]).opacity : null,
      ghostAnimations: document.querySelectorAll('.ghost').length,
    };
  })()`);
  record('reduced-motion', reduced);
  expect('reduced-motion 下行无动画', reduced.rowsWithRealAnimation === 0, `${reduced.rowsWithRealAnimation} 行仍在播动画`);
  expect('reduced-motion 下行不透明', reduced.firstOpacity === '1', `opacity=${reduced.firstOpacity}`);
  await shoot('16-state-reduced-motion');
  await send('Emulation.setEmulatedMedia', { features: [] });

  // ── 10. 深色主题的对比度抽查（类型色条 vs 背景） ────────────────
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await wait(400);
  const dark = await evaluate(`(() => {
    const bar = document.querySelector('.item__kind');
    const text = document.querySelector('.entry__text');
    return {
      kindBar: bar ? getComputedStyle(bar).backgroundColor : null,
      kindType: bar?.dataset.type ?? null,
      textColor: text ? getComputedStyle(text).color : null,
      surface: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  record('dark', dark);
  await shoot('17-state-dark-rows');

  // ── 11. 第五轮审计后的回归断言（2026-09-16）─────────────────────
  //
  // 这一节钉住的是"审计发现的缺陷已经被修掉"，每条都对应一个被实测复现过的行为。
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);

  // (a) 焦点保持：刷新（`r`）后焦点必须还在原来那个控件上，且"内容没变"时不该动 DOM。
  //     修之前实测：焦点从行的复制按钮掉到 `<body>`，每 10 秒轮询一次就掉一次。
  const focusProbe = await evaluate(`(async () => {
    const btn = document.querySelector('.item .rowops .icon-btn');
    btn.focus();
    const before = document.activeElement === btn ? 'button' : (document.activeElement?.tagName ?? 'null');

    // 记录 tbody 的 DOM 变更次数（内容完全没变的一次刷新应当是 0）
    // 分两层记：structural（tbody 的直接子节点增删 —— 就是"整段重挂"）与
    // deep（子树内的任何子节点/文本变化 —— 例如分组小标题的数字）。
    const tbody = document.querySelector('.board__table tbody');
    let structural = 0;
    let deep = 0;
    const observerA = new MutationObserver((records) => { structural += records.length; });
    observerA.observe(tbody, { childList: true });
    const observerB = new MutationObserver((records) => { deep += records.length; });
    observerB.observe(tbody, { childList: true, subtree: true, characterData: true });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    await new Promise((r) => setTimeout(r, 2200));
    observerA.disconnect();
    observerB.disconnect();

    const active = document.activeElement;
    return JSON.stringify({
      before,
      after: active?.className?.includes?.('icon-btn') ? 'button' : (active?.tagName ?? 'null'),
      sameButton: active === btn,
      structural,
      deep,
    });
  })()`);
  record('刷新后的焦点与 DOM 变更', focusProbe);
  const fp = JSON.parse(focusProbe);
  expect('刷新后焦点仍在按下的那个按钮上', fp.after === 'button' && fp.sameButton === true, `焦点跑到了 ${fp.after}`);
  expect('内容未变的刷新不重挂行节点', fp.structural === 0, `tbody 直接子节点变了 ${fp.structural} 次`);
  expect('内容未变的刷新零 DOM 变更', fp.deep === 0, `子树内 ${fp.deep} 次变更`);

  // (b) 浏览器返回：URL 是唯一事实源。修之前实测"地址栏回退了、列表纹丝不动"。
  const popProbe = await evaluate(`(async () => {
    const chips = [...document.querySelectorAll('.chip')];
    const image = chips.find((c) => c.dataset.kind === 'Image');
    image.click();
    await new Promise((r) => setTimeout(r, 2200));
    const after = {
      url: location.search,
      count: document.querySelector('.board-head__count')?.textContent ?? '',
      imagePressed: image.getAttribute('aria-pressed'),
    };
    history.back();
    await new Promise((r) => setTimeout(r, 2600));
    return JSON.stringify({
      after,
      back: {
        url: location.search,
        count: document.querySelector('.board-head__count')?.textContent ?? '',
        imagePressed: document.querySelector('.chip[data-kind="Image"]')?.getAttribute('aria-pressed'),
      },
    });
  })()`);
  record('前进后退', popProbe);
  const pp = JSON.parse(popProbe);
  expect(
    '返回后按 URL 重读了状态',
    pp.back.imagePressed === 'false' && pp.back.count !== pp.after.count,
    `返回后仍是「${pp.back.count}」、图片 chip=${pp.back.imagePressed}`,
  );
  expect('返回后 URL 与内容一致', pp.back.url === '' || pp.back.url === '?', `URL 是 ${pp.back.url}`);

  // (c) 键盘：焦点在行的复选框上时，Esc 必须能退出批量模式（修之前是死的）
  const escProbe = await evaluate(`(async () => {
    const check = document.querySelector('.item .check');
    check.click();
    await new Promise((r) => setTimeout(r, 600));
    const before = { selected: document.querySelector('.batchbar__count')?.textContent ?? '', hidden: document.getElementById('batchbar').hidden };
    check.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return JSON.stringify({ before, hiddenAfter: document.getElementById('batchbar').hidden });
  })()`);
  record('复选框焦点下按 Esc', escProbe);
  const ep = JSON.parse(escProbe);
  expect('焦点在复选框上时 Esc 能退出批量模式', ep.hiddenAfter === true, `批量条仍然可见`);

  // (d) 菜单 Esc 不许顺带清空选择集（修之前：菜单关了，选择也没了）
  const menuEscProbe = await evaluate(`(async () => {
    const check = document.querySelector('.item .check');
    check.click();
    await new Promise((r) => setTimeout(r, 600));
    const selectedBefore = document.querySelector('.batchbar__count')?.textContent ?? '';

    const rowsBtn = document.querySelector('.item .rowops .icon-btn[data-icon="dots"]');
    rowsBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    // 开态只由原生 hidden 表达（.menu[data-open] 已于 2026-09-19 删除，见审计 N-13）。
    // ⚠️ 本段位于 evaluate 的模板字符串内部，注释里**不能写裸反引号**，否则会提前终止模板
    // 并把后面的文本当 Node 侧代码执行（2026-09-19 的 N-14 正是这么让整份文件不可运行的）。
    const menuOpen = !document.querySelector('.menu')?.hidden;
    const anchorExpanded = rowsBtn.getAttribute('aria-expanded');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return JSON.stringify({
      selectedBefore,
      menuOpen,
      anchorExpanded,
      selectedAfter: document.querySelector('.batchbar__count')?.textContent ?? '',
      focusReturned: document.activeElement === rowsBtn,
    });
  })()`);
  record('菜单 Esc 与选择集', menuEscProbe);
  const mp = JSON.parse(menuEscProbe);
  expect('菜单打开时锚点按钮标了 aria-expanded', mp.menuOpen !== true || mp.anchorExpanded === 'true', `aria-expanded=${mp.anchorExpanded}`);
  expect('菜单 Esc 不清空选择集', mp.selectedAfter === mp.selectedBefore && mp.selectedAfter !== '', `选择从「${mp.selectedBefore}」变成「${mp.selectedAfter}」`);
  expect('菜单 Esc 后焦点回到 ⋯ 按钮', mp.focusReturned === true, '焦点没有还回锚点');

  // (e) 全站按钮必须有可访问名（图标按钮靠 aria-label、带文字的靠文本）
  const namesProbe = await evaluate(`(() => {
    const unnamed = [...document.querySelectorAll('button')].filter((b) => {
      const text = (b.textContent || '').trim();
      return !text && !b.getAttribute('aria-label') && !b.getAttribute('title') && !b.querySelector('svg title');
    });
    return JSON.stringify({ total: document.querySelectorAll('button').length, unnamed: unnamed.map((b) => b.outerHTML.slice(0, 120)) });
  })()`);
  record('按钮可访问名', namesProbe);
  const np = JSON.parse(namesProbe);
  expect('每个按钮都有可访问名', np.unnamed.length === 0, `${np.unnamed.length} 个按钮没有名字：${np.unnamed.join(' | ')}`);

  // (f) 抽屉：没有任何"空白按钮"，且保存保留策略的按钮必须自己带文字
  await evaluate(`document.getElementById('overview').click()`);
  await wait(900);
  const drawerProbe = await evaluate(`(() => {
    const empties = [...document.querySelectorAll('.drawer button')].filter(
      (b) => !(b.textContent || '').trim() && !b.querySelector('svg'),
    );
    const retentionSave = document.querySelector('.drawer .btn--primary');
    const banner = document.querySelector('.drawer .note--warn');
    void banner;
    return JSON.stringify({
      emptyButtons: empties.length,
      saveLabel: (retentionSave?.textContent || '').trim(),
      saveWidth: retentionSave ? Math.round(retentionSave.getBoundingClientRect().width) : 0,
      labelledBy: document.querySelector('.drawer')?.getAttribute('aria-labelledby') ?? null,
      activityShown: !!document.querySelector('.drawer .details__value')?.textContent,
    });
  })()`);
  record('抽屉按钮与命名', drawerProbe);
  const dp = JSON.parse(drawerProbe);
  expect('抽屉里没有空白按钮', dp.emptyButtons === 0, `${dp.emptyButtons} 个按钮既无文字也无图标`);
  expect(
    '「保存保留策略」按钮看得见说得清',
    dp.saveLabel.length > 0 && dp.saveWidth > 60,
    `文字「${dp.saveLabel}」宽 ${dp.saveWidth}px（修之前是一个 26px 的空白方块）`,
  );
  expect('抽屉有可访问名', dp.labelledBy === 'drawer-title', `aria-labelledby=${dp.labelledBy}`);
  await evaluate(`document.querySelector('.drawer')?.close()`);
  await wait(500);

  // (g) 连点行内按钮只能发一次写请求（修之前：连点两次收藏 = 两个 PATCH）
  await send('Network.enable');
  const patchPaths = [];
  cdp.listeners.push((msg) => {
    if (msg.method === 'Network.requestWillBeSent' && msg.params?.request?.method === 'PATCH') {
      patchPaths.push(msg.params.request.url);
    }
  });
  const dblProbe = await evaluate(`(async () => {
    // 每次都用**重新查询**的节点：收藏成功后行会被就地重填，旧引用是脱离文档的节点，
    // 读它的 aria-pressed 会得到"没变化"的假象（第一版就栽在这里）。
    const pick = () => document.querySelector('.item .rowops .icon-btn[data-icon="star"]');
    const initial = pick().getAttribute('aria-pressed');

    const node = pick();
    node.click();
    node.click(); // 同一 tick 内第二次点击：必须被"进行中"守卫挡掉
    await new Promise((r) => setTimeout(r, 2600));
    const afterDouble = pick().getAttribute('aria-pressed');

    pick().click(); // 复原（把状态改回去，不给目标库留副作用）
    await new Promise((r) => setTimeout(r, 2600));
    return JSON.stringify({ initial, afterDouble, restored: pick().getAttribute('aria-pressed') });
  })()`);
  record('连点收藏', dblProbe);
  const dbl = JSON.parse(dblProbe);
  expect('连点两下只改一次状态', dbl.afterDouble !== dbl.initial, `状态没变（${dbl.initial} → ${dbl.afterDouble}）`);
  expect('复原后回到原状态（本断言不留副作用）', dbl.restored === dbl.initial, `${dbl.initial} → ${dbl.restored}`);
  expect(
    '连点行内按钮只发一次写请求',
    patchPaths.length === 2,
    `收到 ${patchPaths.length} 个 PATCH（连点应只算 1 次 + 复原 1 次）`,
  );

  // (h) 批量条必须在文档顺序上早于分页 —— 否则键盘用户要按 200 多次 Tab 才够得到它
  const orderProbe = await evaluate(`(() => {
    const bar = document.getElementById('batchbar');
    const pager = document.getElementById('pager');
    const position = bar.compareDocumentPosition(pager);
    return JSON.stringify({
      batchbarBeforePager: !!(position & Node.DOCUMENT_POSITION_FOLLOWING),
      batchbarBeforeFooter: !!(bar.compareDocumentPosition(document.querySelector('.footer')) & Node.DOCUMENT_POSITION_FOLLOWING),
      countRole: document.querySelector('.batchbar__count')?.getAttribute('role') ?? null,
      toastLive: document.getElementById('toasts')?.getAttribute('aria-live') ?? null,
    });
  })()`);
  record('批量条的可达性', orderProbe);
  const op = JSON.parse(orderProbe);
  expect('批量条在 Tab 顺序上早于分页与页脚', op.batchbarBeforePager && op.batchbarBeforeFooter, '批量条仍挂在文档末尾');
  expect('选择集数量变化会被播报', op.countRole === 'status', `role=${op.countRole}`);


  // (i) 方向键在行之间移动焦点（A-31）：**同一列**上下走，且不改动 Tab 顺序
  const arrowProbe = await evaluate(`(async () => {
    const rows = [...document.querySelectorAll('.item')];
    const starOf = (row) => row.querySelector('.rowops .icon-btn[data-icon="star"]');
    const describe = () => {
      const a = document.activeElement;
      const row = a?.closest?.('tr.item');
      return { icon: a?.dataset?.icon ?? null, rowIndex: row ? rows.indexOf(row) : -1, tag: a?.tagName ?? null };
    };

    starOf(rows[0]).focus();
    const start = describe();

    const press = (key) => document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );

    press('ArrowDown');
    const down = describe();
    press('ArrowUp');
    const up = describe();
    press('End');
    const end = describe();
    press('Home');
    const home = describe();

    // 预览内容本身也是按钮：每行 5 个控件，方向键仍可跳到下一行同类控件。
    const tabbables = [...rows[0].querySelectorAll('button, input, a, [tabindex]')]
      .filter((n) => n.tabIndex >= 0).length;

    return JSON.stringify({ start, down, up, end, home, lastRowIndex: rows.length - 1, tabbablesPerRow: tabbables });
  })()`);
  record('行间方向键导航', arrowProbe);
  const ap = JSON.parse(arrowProbe);
  expect('ArrowDown 到下一行的同一个控件', ap.down.icon === 'star' && ap.down.rowIndex === 1, JSON.stringify(ap.down));
  expect('ArrowUp 回到上一行', ap.up.icon === 'star' && ap.up.rowIndex === 0, JSON.stringify(ap.up));
  expect('End 到末行', ap.end.rowIndex === ap.lastRowIndex && ap.end.icon === 'star', JSON.stringify(ap.end));
  expect('Home 回首行', ap.home.rowIndex === 0 && ap.home.icon === 'star', JSON.stringify(ap.home));
  expect('每行 5 个 Tab 停靠点（含可点击预览）', ap.tabbablesPerRow === 5, `实测 ${ap.tabbablesPerRow} 个`);

  // 发布回归：首屏会话请求失败，重试必须恢复整个启动流程（含实时连接）。
  const faultScript = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const original = window.fetch.bind(window);
      let first = true;
      window.fetch = (...args) => {
        if (first && String(args[0]).includes('/ui/api/session')) {
          first = false;
          return Promise.reject(new TypeError('release-test: session unavailable'));
        }
        return original(...args);
      };
    })();`,
  });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(1500);
  const retryStartup = JSON.parse(await evaluate(`(async () => {
    const failed = document.querySelector('.blank')?.dataset.kind === 'error';
    document.querySelector('.blank button')?.click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !document.querySelector('.sync[data-state="live"]')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return JSON.stringify({failed, rows:document.querySelectorAll('tr.item').length,
      live:!!document.querySelector('.sync[data-state="live"]')});
  })()`));
  record('首屏失败后重试', JSON.stringify(retryStartup));
  expect('首屏错误可见且重试恢复列表与推送', retryStartup.failed && retryStartup.rows > 0 && retryStartup.live, JSON.stringify(retryStartup));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: faultScript.identifier });

  await send('Page.navigate', { url: `${BASE}/ui_v2/app/?deleted=1&search=release-no-match-92748` });
  await wait(1500);
  // ⚠️ 顺序有讲究（2026-09-21 修）：chip 的**回收站口径**必须在**点「清除筛选」之前**量 ——
  // D19 定案后那一下会回到活跃列表，点击之后再读 chip 拿到的是活跃口径。
  // 此前这两条断言读的是点击**之后**的数字、却拿 `statistics?deleted=true` 当期望值，于是恒失败
  // （`states.mjs` 不在 AGENTS.md §2 第 5 条点名的两个探针里，所以这处失败一直没人看见）。
  const trashChips = JSON.parse(await evaluate(`(async () => {
    const kind = document.querySelector('.blank')?.dataset.kind;
    // ⚠️ API 的 deleted 只认 true/false（服务端 parseBoolParam），页面 URL 才用 deleted=1（filtersToSearch）。
    // 这里原来写 deleted=1 ⇒ 恒 400、响应里没有 byType ⇒ Object.values(undefined) 抛错（2026-09-19 修，见 N-15）。
    const statistics = await (await fetch('/ui/api/statistics?deleted=true')).json();
    const chipTotal = Number(document.querySelector('.chips .chip__num')?.textContent);
    // 按类型的四个 chip 才是**真正**受 overview 的 \`deleted\` 参数影响的东西
    // （它们读 \`stats.byType\`，而「全部」那个 chip 读的是 total）。只比「全部」的话，
    // 即使 overview 完全忽略 \`deleted\`、把活跃口径的计数发下来，断言照样通过 —— 见下一条 expect。
    const chipByKind = {};
    for (const chip of document.querySelectorAll('.chips .chip[data-kind]')) {
      chipByKind[chip.dataset.kind] = Number(chip.querySelector('.chip__num')?.textContent);
    }
    return JSON.stringify({kind, chipTotal, chipByKind,
      typeCounts:statistics.byType,
      expected:Object.values(statistics.byType).reduce((a,b) => a+b, 0)});
  })()`));
  record('回收站视图的类型计数', JSON.stringify(trashChips));
  expect('回收站的空搜索不能谎报回收站为空', trashChips.kind === 'filter', JSON.stringify(trashChips));
  expect('回收站类型计数使用删除记录口径', trashChips.chipTotal === trashChips.expected, JSON.stringify(trashChips));
  // 上面那条只覆盖「全部」chip（它读 total，与视图无关的那条聚合）。这条覆盖**按类型的四个 chip**：
  // 它们的数字来自 overview 的 `byType`，只有 overview 真的透传了 `deleted` 才会等于
  // `statistics?deleted=1` 的口径 —— 这正是本次修复的核心。
  expect(
    '回收站按类型 chip 用的是删除记录口径（overview 必须透传 deleted）',
    ['Text', 'Image', 'File', 'Group'].every(
      (k) => trashChips.chipByKind[k] === (trashChips.typeCounts[k] ?? 0),
    ),
    JSON.stringify(trashChips),
  );

  // 再点那枚「清除筛选」。2026-09-20 定案（ADR D19）：两处「清除筛选」统一为**回到活跃列表**
  // ⇒ 清完之后 URL 里不该再有 `deleted`。此前这条断言钉的是相反的行为（"保留回收站"），
  // 是 2026-09-18 只改了空状态那一处的遗留。
  const afterClear = JSON.parse(await evaluate(`(async () => {
    document.querySelector('.blank button')?.click();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !document.querySelector('tr.item')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const query = new URLSearchParams(location.search);
    return JSON.stringify({keptTrash:query.get('deleted') === '1', cleared:!query.has('search'),
      rows:document.querySelectorAll('tr.item').length});
  })()`));
  record('清除筛选之后', JSON.stringify(afterClear));
  expect('清除筛选回到活跃列表且恢复记录', !afterClear.keptTrash && afterClear.cleared && afterClear.rows > 0, JSON.stringify(afterClear));

  // ── 12. 登录页（核心页面之一，此前只有一张截图、零断言）──────────
  //
  // 这一节刻意**不打失败密码**：服务端对登录失败有速率限制（429），反复跑冒烟脚本会把
  // 本机 IP 关进小黑屋，连脚本自己拿到会话 Cookie 的那次登录都会失败 —— 测试因此变脆。
  // 能测的都测了：结构/可访问性、客户端校验（不发请求）、以及"已登录时的跳转与 `?next=` 白名单"
  // （后两者只用已有的会话 Cookie，一次登录请求都不发）。
  //
  // 前两条必须**先摘掉会话 Cookie**：已登录的浏览器打开登录页会立刻跳走（那是正确行为），
  // 于是登录页的 DOM 根本来不及被看到。
  await clearSessionCookie();
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/login.html` });
  await wait(2500);
  const loginPage = await evaluate(`JSON.stringify({
    url: location.pathname,
    h1: document.querySelectorAll('h1').length,
    labelled: [...document.querySelectorAll('.auth__form input')].map((i) => ({
      id: i.id,
      type: i.type,
      hasLabel: !!document.querySelector('label[for="' + i.id + '"]'),
      required: i.required,
      autocomplete: i.autocomplete,
    })),
    errorRole: document.getElementById('login-error')?.getAttribute('role') ?? null,
    errorHidden: document.getElementById('login-error')?.hidden ?? null,
    submitName: (document.getElementById('login-submit')?.textContent ?? '').trim(),
    focus: document.activeElement?.id ?? null,
    hasNoscript: !!document.querySelector('noscript'),
  })`);
  record('登录页', loginPage);
  const lp = JSON.parse(loginPage);
  expect('登录页有唯一的 h1', lp.h1 === 1, `h1 数量 ${lp.h1}`);
  expect(
    '两个输入框都有绑定 label、都是必填、都声明了 autocomplete',
    lp.labelled.length === 2 && lp.labelled.every((i) => i.hasLabel && i.required && i.autocomplete),
    JSON.stringify(lp.labelled),
  );
  expect(
    '错误区是 role=alert 且初始隐藏',
    lp.errorRole === 'alert' && lp.errorHidden === true,
    `role=${lp.errorRole} hidden=${lp.errorHidden}`,
  );
  expect('提交按钮有可读文字', lp.submitName.length > 0, `文字「${lp.submitName}」`);
  expect('打开即聚焦用户名（页面上唯一的下一步）', lp.focus === 'username', `焦点在 ${lp.focus}`);
  expect('无脚本时给出说明', lp.hasNoscript === true, '缺少 noscript 兜底');

  // 空提交：必须**在本地**拦住（不发请求、不离开本页）
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/login.html` });
  await wait(2200);
  const emptySubmit = await evaluate(`(async () => {
    document.getElementById('login-submit').click();
    await new Promise((r) => setTimeout(r, 900));
    const box = document.getElementById('login-error');
    return JSON.stringify({
      url: location.pathname,
      text: box?.textContent ?? null,
      hidden: box?.hidden ?? null,
      ariaInvalid: document.getElementById('username')?.getAttribute('aria-invalid') ?? null,
      focus: document.activeElement?.id ?? null,
    });
  })()`);
  record('登录页空提交', emptySubmit);
  const es = JSON.parse(emptySubmit);
  expect('空提交被本地拦住并给出原因', es.hidden === false && /请填写用户名/.test(es.text ?? ''), `提示「${es.text}」`);
  // 登录页的规范路径是 `/ui_v2/app/login`（worker 会把 .html 也映射过去），故判据用 /login 而不是文件名
  expect('空提交不发请求、不离开登录页', /\/login\b/.test(es.url), `跑到了 ${es.url}`);
  expect('出错后把焦点放回第一个缺失字段', es.focus === 'username' && es.ariaInvalid === 'true', `焦点 ${es.focus}`);
  await shoot('18-state-login-error');

  // 已登录访问登录页 = 多一步，必须直接送去列表页（把会话 Cookie 装回去）
  await setSessionCookie();
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/login.html` });
  await wait(2500);
  const redirected = JSON.parse(await evaluate(`JSON.stringify({ path: location.pathname + location.search })`));
  record('已登录访问登录页', JSON.stringify(redirected));
  expect('已登录时登录页直接跳列表页', redirected.path === '/ui_v2/app/', `跳到了 ${redirected.path}`);

  // `?next=` 白名单：同源深链接要照办，跨源一律回落到列表页
  const nextCases = [
    { next: '/ui_v2/app/?types=Image', want: '/ui_v2/app/?types=Image', why: '同源深链接照办' },
    { next: 'https://evil.example/x', want: '/ui_v2/app/', why: '绝对跨源回落' },
    { next: '//evil.example/x', want: '/ui_v2/app/', why: '协议相对回落' },
    { next: '/\\evil.example/x', want: '/ui_v2/app/', why: '反斜杠（浏览器视同 /）回落' },
    { next: '/ui_v2/app/login.html', want: '/ui_v2/app/', why: '指向登录页自身（防死循环）回落' },
  ];
  for (const testCase of nextCases) {
    await send('Page.navigate', { url: `${BASE}/ui_v2/app/login.html?next=${encodeURIComponent(testCase.next)}` });
    await wait(2200);
    const actual = JSON.parse(await evaluate(`JSON.stringify({ path: location.pathname + location.search })`)).path;
    expect(`?next= ${testCase.why}`, actual === testCase.want, `期望 ${testCase.want}，实际 ${actual}`);
  }

  // N-8：`?next=` 指向**登录页自身**时，必须一次都不多跳。
  // 只比「最终落在哪」区分不出来 —— 两条路最终都会落到 `/ui_v2/app/`（登录页在已登录态会再跳一次），
  // 所以判据是**中间加载了几次登录页**：修前是 2 次（登录页 → 登录页 → 列表页），修后是 1 次。
  // 这条同时钉住「平台的规范形态是无扩展名」：只认 `.html` 的判据对第二个 `selfTarget` 会是 2 次。
  const loginLoads = [];
  cdp.listeners.push((msg) => {
    // 只看主文档导航（`parentId` 缺省 = 主 frame）；子 frame 不算
    if (msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId) {
      loginLoads.push(msg.params.frame.url);
    }
  });
  for (const selfTarget of ['/ui_v2/app/login.html', '/ui_v2/app/login']) {
    loginLoads.length = 0;
    await send('Page.navigate', { url: `${BASE}/ui_v2/app/login.html?next=${encodeURIComponent(selfTarget)}` });
    await wait(2200);
    const loads = loginLoads.filter((url) => url.includes('/ui_v2/app/login')).length;
    record(`?next=${selfTarget} 的导航链`, loginLoads.map((u) => u.replace(BASE, '')).join(' → '));
    expect(
      `?next=${selfTarget} 只加载登录页一次（不因自指多跳）`,
      loads === 1,
      `登录页被加载 ${loads} 次：${loginLoads.map((u) => u.replace(BASE, '')).join(' → ')}`,
    );
  }

  console.log('');
  record('console errors', consoleErrors.length ? consoleErrors : 'none');
  expect('控制台零错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  console.log('');
  if (problems.length === 0) {
    console.log('✅ 全部断言通过');
  } else {
    console.log(`❌ ${problems.length} 条断言失败：`);
    for (const p of problems) console.log(`   - ${p}`);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
} finally {
  try {
    cdp?.ws.close();
    browserWs?.close();
  } catch {
    /* 忽略 */
  }
  proc.kill();
  await new Promise((r) => setTimeout(r, 400));
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}
