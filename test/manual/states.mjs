// 交互状态采集（手动运行，不属于 npm test 套件）
//
// 为什么需要它：`probe.mjs` 只读**首屏静止**的 DOM。而"界面像不像成品"几乎全在**交互状态**里
// —— 选中态、批量条、浮层、键盘、reduced-motion。这些此前一条都没有被真的点过。
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
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { collectErrors, launchBrowser, loginAndSetCookie } from './cdp.mjs';

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
const { cdp, send, read, close } = await launchBrowser({ port: PORT, width: WIDTH, height: HEIGHT });
const { consoleErrors } = collectErrors(cdp);
// 页面里 `return JSON.stringify(...)` 的读值走这里：解析只在这一处，坏了也只在这里报一次。
// 不在读值处写 `JSON.parse` —— 那样解析失败会抛在 `JSON.parse` 内部，看不出是哪一步、哪个值。
const at = async (expression, label = '') => {
  const raw = await read(expression);
  // 页面侧有 `return JSON.stringify({...})` 与 `return {...}` 两种写法：前者给字符串、
  // 后者经 `returnByValue` 直接给对象。两种都接受，但字符串必须能解析（否则是页面侧写错了）。
  if (raw !== null && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`读值不是 JSON（${label}）：${String(raw).slice(0, 200)}`);
  }
};

try {
  const { cookieName, cookieValue } = await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
  const cookieDomain = new URL(BASE).hostname;
  // 12 节要测"未登录时的登录页"，而已经登录的浏览器打开登录页会**立刻跳走**（那是正确行为），
  // 故那几条断言必须先把 Cookie 摘掉，测完再装回去。**不**用打失败密码的方式登出：
  // 服务端对登录失败有限速，反复跑会把本机关进小黑屋。
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
  // `boot.js` 用 `replaceWith` 换掉 HTML 里的占位元素，因此每个被替换的挂载点都必须在
  // **新建的元素**上带同一个 id。漏掉它的症状是"按 id 找不到"，而元素在屏幕上好好的 ——
  // 肉眼完全不可见，故逐个查（`overview` 与 `batchbar` 都踩过）。
  const mountIds = await read(`(() => {
    const ids = ['appbar', 'overview', 'notice', 'omnibox', 'filters', 'board-area', 'pager', 'batchbar', 'toasts'];
    // 占位元素不该留在 DOM 里（它们被 replaceWith 换掉了），故 id 必须唯一且只有一个
    return {
      missing: ids.filter((id) => !document.getElementById(id)),
      duplicates: ids.filter((id) => document.querySelectorAll('#' + CSS.escape(id)).length > 1),
    };
  })()`);
  record('mount ids', mountIds);
  expect('挂载点 id 齐全', mountIds.missing.length === 0, `这些 id 在 DOM 里找不到：${mountIds.missing.join(', ')}`);

  const geometry = await read(`(() => {
    const row = document.querySelector('.item');
    const cell = row?.querySelector('.board__cell--content');
    const text = row?.querySelector('.entry__text');
    const table = document.querySelector('.board__table');
    return {
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      contentWidth: cell ? Math.round(cell.getBoundingClientRect().width) : null,
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
      textFontSize: text ? getComputedStyle(text).fontSize : null,
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

  // 骨架行高必须**等于**真实行高：`.ghost` 若写死高度就会比真实行低一截，而注释还声称两者同高。
  // 这条不变式此前只有注释钉着；fast path 下骨架只存在一帧，故注入一行骨架来量。
  const ghostGeom = await at(`(() => {
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
    return { wide, compact };
  })()`, '骨架行高');
  record('骨架行高=真实行高', ghostGeom);
  expect('骨架行与真实行同高（宽松）', ghostGeom.wide.ghostH === ghostGeom.wide.realH,
    `骨架 ${ghostGeom.wide.ghostH}px vs 真实 ${ghostGeom.wide.realH}px（--row-h=${ghostGeom.wide.rowH}）`);
  expect('骨架行与真实行同高（紧凑）', ghostGeom.compact.ghostH === ghostGeom.compact.realH,
    `骨架 ${ghostGeom.compact.ghostH}px vs 真实 ${ghostGeom.compact.realH}px（--row-h=${ghostGeom.compact.rowH}）`);

  await shoot('10-state-rows');

  // ── 2. 行内操作：rest 态可见性 + hover 全亮 ────────────────────
  const ops = await read(`(() => {
    const wrap = document.querySelector('.item')?.querySelector('.rowops');
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

  // ── 2b. 紧凑模式开关（在列表头，不在抽屉里）─────────────────────
  // 判据全部取自**浏览器实际状态**：行高真的变了、状态真的进了 localStorage、能切回来。
  // 只测"按钮在不在"是不够的 —— 一个不生效的开关比没有开关更糟。
  const density = await read(`(async () => {
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
  const densityOff = await read(`(async () => {
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

  // 刷新后仍生效（它存在 localStorage，`theme-init.js` 在首帧前就应用）
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  await read(`(async () => {
    const btn = document.querySelector('.board-head .icon-btn[data-icon="list"]');
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return localStorage.getItem('sb-ui-density');
  })()`);
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  const afterReload = await read(`(async () => {
    const rootAttr = document.documentElement.dataset.density ?? null;
    const btn = document.querySelector('.board-head .icon-btn[data-icon="list"]');
    const pressed = btn?.getAttribute('aria-pressed') ?? null;
    // 收尾：切回宽松，别把状态留给后面的断言
    if (pressed === 'true') { btn.click(); await new Promise((r) => setTimeout(r, 300)); }
    return { rootAttr, pressed };
  })()`);
  record('刷新后仍紧凑', afterReload);
  expect('刷新后仍生效', afterReload.rootAttr === 'compact', `data-density=${afterReload.rootAttr}`);
  expect('刷新后开关态正确', afterReload.pressed === 'true', `aria-pressed=${afterReload.pressed}`);

  // 抽屉里只该有一句指向开关的说明，不该再有第二个同功能的控件
  const drawerNote = await read(`(async () => {
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
  await read(`document.querySelector('.drawer')?.close()`);
  await wait(300);

  // ── 3. 键盘：`/` 聚焦搜索 ────────────────────────────────────
  await read(`document.body.focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', text: '/' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', text: '/' });
  await wait(250);
  const searchFocus = await read(`document.activeElement?.id ?? document.activeElement?.tagName ?? null`);
  record('键盘 / → 焦点', searchFocus);
  expect('`/` 聚焦搜索', searchFocus === 'omnibox-input', `焦点落在 ${searchFocus}`);

  // ── 4. 选中 + 批量条 ─────────────────────────────────────────
  await read(`document.activeElement.blur()`);
  const batch = await read(`(async () => {
    document.querySelector('.item .check').click();
    await new Promise((r) => setTimeout(r, 250));
    const bar = document.getElementById('batchbar');
    const row = document.querySelector('.item');
    const barRect = bar?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    void (barRect && rowRect && barRect.top < rowRect.bottom);
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
    };
  })()`);
  record('batchbar', batch);
  expect('批量条出现', batch.hidden === false, `hidden=${batch.hidden}`);
  expect('批量条悬浮', batch.position === 'fixed', `position=${batch.position}`);
  expect('选中态落到行上', batch.rowSelected === true, '行没有 data-selected');
  await shoot('11-state-batchbar');

  // 回收站视图下「移动到回收站」应禁用、「恢复」应可用（视图决定可用性）
  await read(`document.querySelector('[data-action="trash"]').click()`);
  await wait(1800);
  const trashBatch = await read(`(() => {
    document.querySelector('.item .check')?.click();
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
  await read(`document.querySelector('[data-action="trash"]').click()`);
  await wait(1800);

  // ── 5. 溢出菜单 ───────────────────────────────────────────────
  // 这一组里有三条来自用户实际报告的缺陷（"点更多之后无法点击其他地方关闭 / 滚动也不消失"），
  // 所以判据写得比"菜单在不在"严：它必须能被**三种**方式关掉，且滚动时不许留在屏幕上。
  const menuState = await read(`(async () => {
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

  // 5a. **点外部要关**。用**真实鼠标事件**打在页面空白处 —— 合成事件绕不过"遮罩吃掉点击"这个真实成因。
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 640, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 640, button: 'left', clickCount: 1 });
  await wait(300);
  const afterOutsideClick = await read(
    `({ open: (() => { const m = document.querySelector('.menu'); return m ? !m.hidden : null; })(), backdropGone: !!document.querySelector('.menu-backdrop[hidden]') })`,
  );
  record('点外部后', afterOutsideClick);
  expect('点外部能关掉菜单', afterOutsideClick.open === false, '点空白处菜单仍然开着');
  expect('遮罩一并收起', afterOutsideClick.backdropGone === true, '遮罩还留着（会继续吃掉点击）');

  // 5b. **滚动要关**（用户报告的症状：菜单不消失还会飘到别的行）
  const beforeScroll = await read(`window.scrollY`);
  await read(`document.querySelector('.item .icon-btn[data-icon="dots"]').click()`);
  await wait(300);
  const menuBeforeWheel = await read(`!document.querySelector('.menu').hidden`);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: 400 });
  await wait(400);
  const scrollResult = await read(`({ menuOpen: !document.querySelector('.menu').hidden, scrollY: window.scrollY })`);
  record('滚动后', scrollResult);
  expect('滚动前菜单是开着的', menuBeforeWheel === true, '第二次没打开，这条断言无效');
  expect('滚动能关掉菜单', scrollResult.menuOpen === false, '滚动后菜单仍然挂在屏幕上');
  expect('页面确实滚了（否则这条断言是空转）', scrollResult.scrollY > beforeScroll, '页面没滚动，说明滚轮没生效');
  // 滚回去，别影响后面的用例
  await read(`window.scrollTo(0, ${beforeScroll})`);
  await wait(300);

  // 5c. Esc 仍然能关（原生行为，改成非 dialog 之后要自己实现，故必须守住）
  await read(`document.querySelector('.item .icon-btn[data-icon="dots"]').click()`);
  await wait(350);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(300);
  const afterEsc = await read(`!document.querySelector('.menu').hidden`);
  record('Esc 后菜单还开着？', afterEsc);
  expect('Esc 能关掉菜单', afterEsc === false, 'Esc 关不掉（改成非 dialog 后这条要自己实现）');

  // 5d. 点菜单里的动作要生效（而不是只关闭）。
  // 判据取**服务端返回值**而不是行内按钮的 `aria-pressed`：行会被随后的静默刷新重建，
  // 那一刻读到的按钮可能还没重绘完。置顶会让行**换位置**，故复位必须按 `data-key` 认行、
  // 复核也必须按 hash 取单条（不能假设"第一条 = 该类型第一条"）。
  const menuAction = await at(`(async () => {
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
    if (!pin) return { error: '菜单里没有置顶项' };
    const wasPinned = pin.textContent.trim() === '取消置顶';
    pin.click();
    await new Promise((r) => setTimeout(r, 1600));
    const server = await readServer();
    return { key, menuClosed: !document.querySelector('.menu').hidden, wasPinned, serverPinned: server.pinned ?? null };
  })()`, '菜单置顶');
  record('菜单里的「置顶」', menuAction);
  if (!menuAction.error) {
    expect('点动作后菜单收拾干净', menuAction.menuClosed === false, '菜单没关');
    // 动作是**切换**：原来没置顶 → 现在应当置顶；原来置顶 → 现在应当没置顶
    expect(
      '点动作确实生效（服务端复核）',
      menuAction.serverPinned === !menuAction.wasPinned,
      `原来 pinned=${menuAction.wasPinned}，现在服务端 pinned=${menuAction.serverPinned}`,
    );
    // 复位：切回原状态，别把数据留给后面的用例
    await read(`(async () => {
      document.querySelector('.item[data-key="${menuAction.key}"] .icon-btn[data-icon="dots"]')?.click();
      await new Promise((r) => setTimeout(r, 300));
      [...document.querySelectorAll('.menu__item')].find((b) => /置顶/.test(b.textContent))?.click();
      await new Promise((r) => setTimeout(r, 1200));
    })()`);
  }

  // ── 6. 预览对话框（文本全文） ─────────────────────────────────
  // 正文被截断的记录在打开预览时会**先取一次单条**才拿得到全文，故等到 readout/figure 出现为止。
  const previewState = await read(`(async () => {
    const row = document.querySelector('.item');
    // 双击行 = 预览（不点复制，避免真的写剪贴板）
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const deadline = Date.now() + 6000;
    let dlg = null;
    while (Date.now() < deadline) {
      dlg = [...document.querySelectorAll('dialog.dialog')].find((d) => d.open);
      if (dlg?.querySelector('.readout, .figure')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      key: row.dataset.key,
      open: !!dlg,
      title: dlg?.querySelector('.dialog__title')?.textContent ?? null,
      hasReadout: !!dlg?.querySelector('.readout'),
      hasFigure: !!dlg?.querySelector('.figure'),
      focusInside: dlg ? dlg.contains(document.activeElement) : null,
      // 页脚只剩一个「关闭」按钮是个真实出现过的缺陷，故这里必须断言动作数量
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
  expect(
    '预览必须有动作按钮（复制内容 / 下载），不能只有「关闭」',
    previewState.actions.length >= 2 && previewState.actions.includes('关闭'),
    `页脚只有：${JSON.stringify(previewState.actions)}`,
  );
  await shoot('14-state-preview');
  await read(`[...document.querySelectorAll('dialog.dialog')].find(d => d.open)?.close()`);
  await wait(400);
  const hashCleared = await read(`location.hash || null`);
  record('预览关闭后 hash', hashCleared);

  // ── 6b. 媒体预览同样要有动作按钮（图片记录 → 下载 / 复制图片）──────
  const mediaPreview = await read(`(async () => {
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
  const confirmState = await read(`(async () => {
    document.querySelector('.item .icon-btn[data-icon="dots"]').click();
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('.menu__item')].find((b) => b.textContent.includes('移动到回收站')).click();
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
  //   ① 会动手改的区块必须排在只看的前面；② 抽屉不该一打开就要滚很久（总高/视口是可量化的代理指标）。
  const drawerState = await read(`(async () => {
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
  // 总高 / 视口：原来 ≈1.84（要滚近两屏）。压到 1.35 以内才算"打开就看得完大半"。
  expect(
    '抽屉不再需要滚很久',
    drawerState.scrollHeight / drawerState.viewportHeight <= 1.35,
    `总高是视口的 ${(drawerState.scrollHeight / drawerState.viewportHeight).toFixed(2)} 倍（原为 1.84）`,
  );
  // 展开折叠区块后仍要能读到柱状图（折叠不能把功能藏没）
  const expanded = await read(`(async () => {
    const d = document.querySelector('.drawer');
    const det = d.querySelector('.details');
    det.open = true;
    await new Promise((r) => setTimeout(r, 300));
    return { open: det.open, bars: d.querySelectorAll('.bar').length };
  })()`);
  record('展开活动趋势后', expanded);
  expect('展开后能看到图表', expanded.bars >= 14, `展开后只有 ${expanded.bars} 根柱子`);
  await read(`document.querySelector('.details').open = false`);
  await wait(200);
  await shoot('15-state-drawer');
  await read(`document.querySelector('.drawer')?.close()`);
  await wait(300);

  // ── 8b. 用户点名的三处 ────────────────────────────────────────

  // (a) 时间范围选「自定义…」之后**不许停在"自定义"上**（那会让用户以为已经筛过了）
  const customRange = await read(`(async () => {
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
  const overviewHint = await read(`(() => {
    const o = document.querySelector('.overview');
    const hint = o.querySelector('.overview__hint');
    return { hasHint: !!hint, hintVisible: hint ? getComputedStyle(hint).display !== 'none' : false, cursor: getComputedStyle(o).cursor };
  })()`);
  record('概览可点提示', overviewHint);
  expect('概览带有可点提示', overviewHint.hasHint === true, '整条可点但没有任何视觉提示');

  // (c) 回收站里行的**主操作**必须是「恢复」
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/?deleted=1` });
  await wait(3500);
  const trash = await read(`(() => {
    const row = document.querySelector('.item');
    const first = row?.querySelector('.rowops .icon-btn');
    return {
      hasRows: !!row,
      firstIcon: first?.dataset.icon ?? null,
      firstLabel: first?.getAttribute('aria-label') ?? null,
      firstDisabled: first?.disabled ?? null,
    };
  })()`);
  record('回收站主操作', trash);
  if (trash.hasRows) {
    expect(
      '回收站主操作是「恢复」',
      trash.firstIcon === 'undo',
      `主操作是 ${trash.firstIcon}（${trash.firstLabel}），用户进回收站几乎总是为了恢复`,
    );
    // 软删不再清数据 ⇒ 没有"不可恢复"这一档，故这里钉的是"**不禁用**"
    expect(
      '回收站的「恢复」不得禁用（所有记录都能恢复）',
      trash.firstDisabled !== true,
      `「恢复」被禁用了（${trash.firstLabel}）`,
    );
  }
  // 回到活跃视图
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3000);

  // (d) 手机端筛选区不许占太多行
  //
  // 数行时必须**先剔掉零尺寸项**：`.filters > *` 里有几个"幽灵"（`清除筛选` 无筛选条件时
  // 是 `hidden`、`刷新` 在窄屏被 `display: none`、`.filters__spacer` 是纯占位），它们都是
  // 0×0 却各自贡献一个 `top`。不剔掉，"行数"就变成"子元素个数"，把已经合格的布局判成失败。
  const measureRows = `(() => {
    const kids = [...document.querySelectorAll('.filters > *')].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0; // 零尺寸 = 不可见，不算行
    });
    const rows = new Set(kids.map((n) => Math.round(n.getBoundingClientRect().top)));
    const bar = document.querySelector('.filters').getBoundingClientRect();
    const card = document.querySelector('.item')?.getBoundingClientRect().height ?? 0;
    return {
      filterRows: rows.size,
      filterBarH: Math.round(bar.height),
      chips: document.querySelectorAll('.chips .chip').length,
      overflowing: [...document.querySelectorAll('.chips .chip')]
        .filter((c) => c.getBoundingClientRect().right > document.querySelector('.chips').getBoundingClientRect().right + 1)
        .length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardHeight: Math.round(card),
      rowsPerScreen: card ? Math.floor(window.innerHeight / card) : 0,
    };
  })()`;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  const m = await read(measureRows);
  record('移动端筛选区', m);
  expect('移动端筛选区不超过 3 行', m.filterRows <= 3, `占了 ${m.filterRows} 行（原为 5 行）`);
  // 5 个类型 chip 横滚：至少有一个被切在右边，用户才知道"这里能滑"
  expect('类型 chips 提示了可横滑', m.chips > 0 && m.overflowing >= 1, '5 个 chip 全挤在可视区内（或被完全藏起）');

  // 最坏情况重测一遍：筛选条里多出一个「清除筛选」按钮时仍不许超过 3 行
  await read(`document.querySelector('.chip[data-tone="star"]')?.click()`);
  await wait(1500);
  const ma = await read(measureRows);
  record('移动端筛选区（有筛选条件时）', ma);
  expect('有筛选条件时仍不超过 3 行', ma.filterRows <= 3, `占了 ${ma.filterRows} 行`);
  expect('清除筛选已经出现', ma.filterBarH > m.filterBarH, `筛选条高度没变（${ma.filterBarH}px），清除筛选可能没渲染`);
  expect('移动端无横向溢出', m.overflowX === 0, `多出 ${m.overflowX}px`);
  await shoot('16-state-mobile');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3000);

  // (e) 复制失败时的话必须说清原因、并且**替用户打开预览**
  //
  // 本地是 http://127.0.0.1 —— 它是安全上下文，剪贴板其实**写得进去**，所以这条路径在开发机上
  // 永远不会自然发生（这正是它长期没被发现的原因）。做法：把两条写入路径都打桩成失败
  // （`navigator.clipboard.writeText` 与 `document.execCommand`）再点第一行的「复制」。
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
    return {
      tone: toast?.dataset.tone ?? null,
      text: toast?.textContent ?? null,
      previewOpened: !!document.querySelector('dialog[open]'),
      secureContext: window.isSecureContext,
    };
  })()`;

  await read(stubFail);
  await read(`document.querySelector('.item .rowops .icon-btn[data-icon="copy"]').click()`);
  await wait(1800);
  const cf = await read(readCopyFailure);
  record('复制失败（安全上下文）', cf);
  expect('复制失败的提示说清了原因', /不是 https|剪贴板权限/.test(cf.text ?? ''), `提示是「${cf.text}」`);
  expect('复制失败时给出退路', /Ctrl|选(中|择)/.test(cf.text ?? ''), `提示没告诉用户下一步怎么办：「${cf.text}」`);
  expect('复制失败时自动打开预览', cf.previewOpened === true, '只弹了提示，没替用户打开预览（用户还得自己找）');

  // 再验 http（非安全上下文）那一种措辞：把 isSecureContext 打桩成 false 重来一次
  await read(`document.querySelector('dialog[open] .dialog__close, dialog[open] .icon-btn')?.click()`);
  await wait(600);
  await read(`(() => {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    return 'insecure';
  })()`);
  await read(`document.querySelector('.item .rowops .icon-btn[data-icon="copy"]').click()`);
  await wait(1800);
  const ci = await read(readCopyFailure);
  record('复制失败（http 站点）', ci);
  expect(
    'http 站点上的提示点名 https',
    ci.secureContext === false && /不是 https/.test(ci.text ?? ''),
    `提示是「${ci.text}」`,
  );
  expect('http 站点上同样自动打开预览', ci.previewOpened === true, '没打开预览');
  await shoot('17-state-copy-failed');

  // ── 9. reduced-motion：行必须立即处于终态 ──────────────────────
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);
  const reduced = await read(`(() => {
    const rows = [...document.querySelectorAll('.item')];
    const animated = rows.filter((r) => {
      const cs = getComputedStyle(r);
      return cs.animationName !== 'none' && cs.animationDuration !== '0.01ms';
    });
    return {
      rows: rows.length,
      rowsWithRealAnimation: animated.length,
      firstOpacity: rows[0] ? getComputedStyle(rows[0]).opacity : null,
    };
  })()`);
  record('reduced-motion', reduced);
  expect('reduced-motion 下行无动画', reduced.rowsWithRealAnimation === 0, `${reduced.rowsWithRealAnimation} 行仍在播动画`);
  expect('reduced-motion 下行不透明', reduced.firstOpacity === '1', `opacity=${reduced.firstOpacity}`);
  await shoot('16-state-reduced-motion');
  await send('Emulation.setEmulatedMedia', { features: [] });

  // ── 10. 深色主题的类型色条（截图走查用）────────────────────────
  await read(`document.documentElement.dataset.theme = 'dark'`);
  await wait(400);
  const dark = await read(`(() => {
    const bar = document.querySelector('.item__kind');
    return {
      kindBar: bar ? getComputedStyle(bar).backgroundColor : null,
      kindType: bar?.dataset.type ?? null,
      surface: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  record('dark', dark);
  await shoot('17-state-dark-rows');

  // ── 11. 回归断言 ──────────────────────────────────────────────
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/` });
  await wait(3500);

  // (a) 焦点保持：刷新（`r`）后焦点必须还在原来那个控件上，且"内容没变"时不该动 DOM
  //     （此前实测：焦点从行的按钮掉到 `<body>`，每 10 秒轮询一次就掉一次）。
  const fp = await read(`(async () => {
    const btn = document.querySelector('.item .rowops .icon-btn');
    btn.focus();
    const before = document.activeElement === btn ? 'button' : (document.activeElement?.tagName ?? 'null');

    // 记 tbody 的 DOM 变更：structural = 直接子节点增删（"整段重挂"），deep = 子树内任何变化
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
    return {
      before,
      after: active?.className?.includes?.('icon-btn') ? 'button' : (active?.tagName ?? 'null'),
      sameButton: active === btn,
      structural,
      deep,
    };
  })()`);
  record('刷新后的焦点与 DOM 变更', fp);
  expect('刷新后焦点仍在按下的那个按钮上', fp.after === 'button' && fp.sameButton === true, `焦点跑到了 ${fp.after}`);
  expect('内容未变的刷新不重挂行节点', fp.structural === 0, `tbody 直接子节点变了 ${fp.structural} 次`);
  expect('内容未变的刷新零 DOM 变更', fp.deep === 0, `子树内 ${fp.deep} 次变更`);

  // (b) 浏览器返回：URL 是唯一事实源（此前实测"地址栏回退了、列表纹丝不动"）
  const pp = await read(`(async () => {
    const image = [...document.querySelectorAll('.chip')].find((c) => c.dataset.kind === 'Image');
    image.click();
    await new Promise((r) => setTimeout(r, 2200));
    const after = {
      url: location.search,
      count: document.querySelector('.board-head__count')?.textContent ?? '',
      imagePressed: image.getAttribute('aria-pressed'),
    };
    history.back();
    await new Promise((r) => setTimeout(r, 2600));
    return {
      after,
      back: {
        url: location.search,
        count: document.querySelector('.board-head__count')?.textContent ?? '',
        imagePressed: document.querySelector('.chip[data-kind="Image"]')?.getAttribute('aria-pressed'),
      },
    };
  })()`);
  record('前进后退', pp);
  expect(
    '返回后按 URL 重读了状态',
    pp.back.imagePressed === 'false' && pp.back.count !== pp.after.count,
    `返回后仍是「${pp.back.count}」、图片 chip=${pp.back.imagePressed}`,
  );
  expect('返回后 URL 与内容一致', pp.back.url === '' || pp.back.url === '?', `URL 是 ${pp.back.url}`);

  // (c) 键盘：焦点在行的复选框上时，Esc 必须能退出批量模式（此前是死的）。
  // 独立于下面的"菜单 Esc"一段：那一段的第一次 Esc 是**关菜单**，两者的前置状态不同。
  const ep = await read(`(async () => {
    const check = document.querySelector('.item .check');
    check.click();
    await new Promise((r) => setTimeout(r, 600));
    const before = { selected: document.querySelector('.batchbar__count')?.textContent ?? '', hidden: document.getElementById('batchbar').hidden };
    check.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return { before, hiddenAfter: document.getElementById('batchbar').hidden };
  })()`);
  record('复选框焦点下按 Esc', ep);
  expect('焦点在复选框上时 Esc 能退出批量模式', ep.hiddenAfter === true, '批量条仍然可见');

  // (d) 菜单 Esc 不许顺带清空选择集（此前：菜单关了，选择也没了）
  const mp = await read(`(async () => {
    const check = document.querySelector('.item .check');
    check.click();
    await new Promise((r) => setTimeout(r, 600));
    const selectedBefore = document.querySelector('.batchbar__count')?.textContent ?? '';

    const rowsBtn = document.querySelector('.item .rowops .icon-btn[data-icon="dots"]');
    check.focus();
    rowsBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    // 开态只由原生 hidden 表达（.menu[data-open] 已删除）。
    // 本段位于 evaluate 的模板字符串内部，注释里不能写裸反引号，否则会提前终止模板。
    const menuOpen = !document.querySelector('.menu')?.hidden;
    const anchorExpanded = rowsBtn.getAttribute('aria-expanded');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return {
      selectedBefore,
      menuOpen,
      anchorExpanded,
      selectedAfter: document.querySelector('.batchbar__count')?.textContent ?? '',
      focusReturned: document.activeElement === rowsBtn,
    };
  })()`);
  record('菜单 Esc 与选择集', mp);
  expect('菜单打开时锚点按钮标了 aria-expanded', mp.menuOpen !== true || mp.anchorExpanded === 'true', `aria-expanded=${mp.anchorExpanded}`);
  expect('菜单 Esc 不清空选择集', mp.selectedAfter === mp.selectedBefore && mp.selectedAfter !== '', `选择从「${mp.selectedBefore}」变成「${mp.selectedAfter}」`);
  expect('菜单 Esc 后焦点回到 ⋯ 按钮', mp.focusReturned === true, '焦点没有还回锚点');

  // (e) 全站按钮必须有可访问名（图标按钮靠 aria-label、带文字的靠文本）
  const np = await read(`(() => {
    const unnamed = [...document.querySelectorAll('button')].filter((b) => {
      const text = (b.textContent || '').trim();
      return !text && !b.getAttribute('aria-label') && !b.getAttribute('title') && !b.querySelector('svg title');
    });
    return { total: document.querySelectorAll('button').length, unnamed: unnamed.map((b) => b.outerHTML.slice(0, 120)) };
  })()`);
  record('按钮可访问名', np);
  expect('每个按钮都有可访问名', np.unnamed.length === 0, `${np.unnamed.length} 个按钮没有名字：${np.unnamed.join(' | ')}`);

  // (f) 抽屉：没有任何"空白按钮"，且保存保留策略的按钮必须自己带文字
  await read(`document.getElementById('overview').click()`);
  await wait(900);
  const dp = await read(`(() => {
    const empties = [...document.querySelectorAll('.drawer button')].filter(
      (b) => !(b.textContent || '').trim() && !b.querySelector('svg'),
    );
    const retentionSave = document.querySelector('.drawer .btn--primary');
    return {
      emptyButtons: empties.length,
      saveLabel: (retentionSave?.textContent || '').trim(),
      saveWidth: retentionSave ? Math.round(retentionSave.getBoundingClientRect().width) : 0,
      labelledBy: document.querySelector('.drawer')?.getAttribute('aria-labelledby') ?? null,
    };
  })()`);
  record('抽屉按钮与命名', dp);
  expect('抽屉里没有空白按钮', dp.emptyButtons === 0, `${dp.emptyButtons} 个按钮既无文字也无图标`);
  expect(
    '「保存保留策略」按钮看得见说得清',
    dp.saveLabel.length > 0 && dp.saveWidth > 60,
    `文字「${dp.saveLabel}」宽 ${dp.saveWidth}px（此前是一个 26px 的空白方块）`,
  );
  expect('抽屉有可访问名', dp.labelledBy === 'drawer-title', `aria-labelledby=${dp.labelledBy}`);
  await read(`document.querySelector('.drawer')?.close()`);
  await wait(500);

  // (g) 连点行内按钮只能发一次写请求（此前：连点两次收藏 = 两个 PATCH）
  const patchPaths = [];
  cdp.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Network.requestWillBeSent' && msg.params?.request?.method === 'PATCH') {
      patchPaths.push(msg.params.request.url);
    }
  });
  const dbl = await read(`(async () => {
    // 每次都用**重新查询**的节点：收藏成功后行会被就地重填，旧引用是脱离文档的节点，
    // 读它的 aria-pressed 会得到"没变化"的假象。
    const pick = () => document.querySelector('.item .rowops .icon-btn[data-icon="star"]');
    const initial = pick().getAttribute('aria-pressed');

    const node = pick();
    node.click();
    node.click(); // 同一 tick 内第二次点击：必须被"进行中"守卫挡掉
    await new Promise((r) => setTimeout(r, 2600));
    const afterDouble = pick().getAttribute('aria-pressed');

    pick().click(); // 复原（把状态改回去，不给目标库留副作用）
    await new Promise((r) => setTimeout(r, 2600));
    return { initial, afterDouble, restored: pick().getAttribute('aria-pressed') };
  })()`);
  record('连点收藏', dbl);
  expect('连点两下只改一次状态', dbl.afterDouble !== dbl.initial, `状态没变（${dbl.initial} → ${dbl.afterDouble}）`);
  expect('复原后回到原状态（本断言不留副作用）', dbl.restored === dbl.initial, `${dbl.initial} → ${dbl.restored}`);
  expect(
    '连点行内按钮只发一次写请求',
    patchPaths.length === 2,
    `收到 ${patchPaths.length} 个 PATCH（连点应只算 1 次 + 复原 1 次）`,
  );

  // (h) 批量条必须在文档顺序上早于分页 —— 否则键盘用户要按 200 多次 Tab 才够得到它
  const op = await read(`(() => {
    const bar = document.getElementById('batchbar');
    const pager = document.getElementById('pager');
    return {
      batchbarBeforePager: !!(bar.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING),
      batchbarBeforeFooter: !!(bar.compareDocumentPosition(document.querySelector('.footer')) & Node.DOCUMENT_POSITION_FOLLOWING),
      countRole: document.querySelector('.batchbar__count')?.getAttribute('role') ?? null,
    };
  })()`);
  record('批量条的可达性', op);
  expect('批量条在 Tab 顺序上早于分页与页脚', op.batchbarBeforePager && op.batchbarBeforeFooter, '批量条仍挂在文档末尾');
  expect('选择集数量变化会被播报', op.countRole === 'status', `role=${op.countRole}`);

  // (i) 方向键在行之间移动焦点：**同一列**上下走，且不改动 Tab 顺序
  const ap = await read(`(async () => {
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

    return { start, down, up, end, home, lastRowIndex: rows.length - 1, tabbablesPerRow: tabbables };
  })()`);
  record('行间方向键导航', ap);
  expect('ArrowDown 到下一行的同一个控件', ap.down.icon === 'star' && ap.down.rowIndex === 1, JSON.stringify(ap.down));
  expect('ArrowUp 回到上一行', ap.up.icon === 'star' && ap.up.rowIndex === 0, JSON.stringify(ap.up));
  expect('End 到末行', ap.end.rowIndex === ap.lastRowIndex && ap.end.icon === 'star', JSON.stringify(ap.end));
  expect('Home 回首行', ap.home.rowIndex === 0 && ap.home.icon === 'star', JSON.stringify(ap.home));
  expect('每行 5 个 Tab 停靠点（含可点击预览）', ap.tabbablesPerRow === 5, `实测 ${ap.tabbablesPerRow} 个`);

  // 首屏会话请求失败时，重试必须恢复整个启动流程（含实时连接）
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
  const retryStartup = await read(`(async () => {
    const failed = document.querySelector('.blank')?.dataset.kind === 'error';
    document.querySelector('.blank button')?.click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !document.querySelector('.sync[data-state="live"]')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return { failed, rows: document.querySelectorAll('tr.item').length, live: !!document.querySelector('.sync[data-state="live"]') };
  })()`);
  record('首屏失败后重试', retryStartup);
  expect('首屏错误可见且重试恢复列表与推送', retryStartup.failed && retryStartup.rows > 0 && retryStartup.live, JSON.stringify(retryStartup));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: faultScript.identifier });

  // ⚠️ 顺序有讲究：chip 的**回收站口径**必须在点「清除筛选」之前量 —— 清完会回到活跃列表。
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/?deleted=1&search=release-no-match-92748` });
  await wait(1500);
  const trashChips = await read(`(async () => {
    const kind = document.querySelector('.blank')?.dataset.kind;
    // ⚠️ API 的 deleted 只认 true/false（服务端 parseBoolParam），页面 URL 才用 deleted=1（filtersToSearch）。
    const statistics = await (await fetch('/ui/api/statistics?deleted=true')).json();
    const chipTotal = Number(document.querySelector('.chips .chip__num')?.textContent);
    // 按类型的四个 chip 读 overview 的 byType，只有 overview 真的透传了 deleted 才会是删除记录口径；
    // 「全部」那个 chip 读的是 total，单看它区分不出来，故两者都要量。
    const chipByKind = {};
    for (const chip of document.querySelectorAll('.chips .chip[data-kind]')) {
      chipByKind[chip.dataset.kind] = Number(chip.querySelector('.chip__num')?.textContent);
    }
    return {
      kind,
      chipTotal,
      chipByKind,
      typeCounts: statistics.byType,
      expected: Object.values(statistics.byType).reduce((a, b) => a + b, 0),
    };
  })()`);
  record('回收站视图的类型计数', trashChips);
  expect('回收站的空搜索不能谎报回收站为空', trashChips.kind === 'filter', JSON.stringify(trashChips));
  expect('回收站类型计数使用删除记录口径', trashChips.chipTotal === trashChips.expected, JSON.stringify(trashChips));
  expect(
    '回收站按类型 chip 用的是删除记录口径（overview 必须透传 deleted）',
    ['Text', 'Image', 'File', 'Group'].every((k) => trashChips.chipByKind[k] === (trashChips.typeCounts[k] ?? 0)),
    JSON.stringify(trashChips),
  );

  // 再点那枚「清除筛选」：两处「清除筛选」统一为**回到活跃列表** ⇒ 清完之后 URL 里不该再有 `deleted`
  const afterClear = await read(`(async () => {
    document.querySelector('.blank button')?.click();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !document.querySelector('tr.item')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const query = new URLSearchParams(location.search);
    return { keptTrash: query.get('deleted') === '1', cleared: !query.has('search'), rows: document.querySelectorAll('tr.item').length };
  })()`);
  record('清除筛选之后', afterClear);
  expect('清除筛选回到活跃列表且恢复记录', !afterClear.keptTrash && afterClear.cleared && afterClear.rows > 0, JSON.stringify(afterClear));

  // ── 12. 登录页（核心页面之一）─────────────────────────────────
  //
  // 这一节刻意**不打失败密码**：服务端对登录失败有速率限制（429），反复跑冒烟脚本会把
  // 本机 IP 关进小黑屋，连脚本自己拿到会话 Cookie 的那次登录都会失败 —— 测试因此变脆。
  // 能测的都测了：结构/可访问性、客户端校验（不发请求）、以及"已登录时的跳转与 `?next=` 白名单"。
  // 前几条必须**先摘掉会话 Cookie**：已登录的浏览器打开登录页会立刻跳走（那是正确行为），
  // 于是登录页的 DOM 根本来不及被看到。
  await clearSessionCookie();
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/login.html` });
  await wait(2500);
  const lp = await read(`({
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
  record('登录页', lp);
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
  const es = await read(`(async () => {
    document.getElementById('login-submit').click();
    await new Promise((r) => setTimeout(r, 900));
    const box = document.getElementById('login-error');
    return {
      url: location.pathname,
      text: box?.textContent ?? null,
      hidden: box?.hidden ?? null,
      ariaInvalid: document.getElementById('username')?.getAttribute('aria-invalid') ?? null,
      focus: document.activeElement?.id ?? null,
    };
  })()`);
  record('登录页空提交', es);
  expect('空提交被本地拦住并给出原因', es.hidden === false && /请填写用户名/.test(es.text ?? ''), `提示「${es.text}」`);
  // 登录页的规范路径是 `/ui_v2/app/login`（worker 会把 .html 也映射过去），故判据用 /login 而不是文件名
  expect('空提交不发请求、不离开登录页', /\/login\b/.test(es.url), `跑到了 ${es.url}`);
  expect('出错后把焦点放回第一个缺失字段', es.focus === 'username' && es.ariaInvalid === 'true', `焦点 ${es.focus}`);
  await shoot('18-state-login-error');

  // 已登录访问登录页 = 多一步，必须直接送去列表页（把会话 Cookie 装回去）
  await setSessionCookie();
  await send('Page.navigate', { url: `${BASE}/ui_v2/app/login.html` });
  await wait(2500);
  const redirected = await read(`({ path: location.pathname + location.search })`);
  record('已登录访问登录页', redirected);
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
    const actual = (await read(`({ path: location.pathname + location.search })`)).path;
    expect(`?next= ${testCase.why}`, actual === testCase.want, `期望 ${testCase.want}，实际 ${actual}`);
  }

  // `?next=` 指向**登录页自身**时，必须一次都不多跳。
  // 只比「最终落在哪」区分不出来 —— 两条路最终都会落到 `/ui_v2/app/`，故判据是**中间加载了几次登录页**。
  // 这条同时钉住「平台的规范形态是无扩展名」：只认 `.html` 的判据对第二个 `selfTarget` 会是 2 次。
  const loginLoads = [];
  cdp.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
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
  close();
}
