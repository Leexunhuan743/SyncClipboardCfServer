// V1（`/ui_old/`）界面的运行时探针（手动运行，不属于 npm test 套件）
//
// 为什么 V1 也需要它：2026-09-17 起 `public/ui_old/` 从「冻结存档」重新变成**在维护的**
// 界面（备用界面，见该目录 README）。维护状态的界面需要它自己的一份「读真实 DOM 值」的
// 工具——截图只能证明"看起来对"，证明不了"计算值对"。V2 有 `probe.mjs`，本文件是它的 V1
// 对位物：同一套 CDP 起浏览器/登录/注入 Cookie 的做法，探针内容按 V1 的 DOM 重写。
//
// 用法（需 dev server 已启动）：
//   node test/manual/probe-ui-old.mjs
//   node test/manual/probe-ui-old.mjs --width 390 --height 844
//   node test/manual/probe-ui-old.mjs --dark
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
const URL_PATH = arg('url', '/ui_old/');
const PORT = Number(arg('port', '9343'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SETTLE = Number(arg('settle', '4000'));
const DARK = process.argv.includes('--dark');
// `--anonymous`：不注入会话 Cookie。登录页在已登录时会立刻跳走（login.js 的 session 探测），
// 所以「看登录页长什么样」必须用未登录身份打开。
const ANONYMOUS = process.argv.includes('--anonymous');
// `--shots <dir>`：除了打印数值，还把若干**真实状态**截成 PNG（给人看）。
// 不传就只出数值 —— 这是它与 shoot.mjs 的分工：shoot 只出图，probe 出值，两者都能出图时
// 以"谁拥有这个界面"为准：V1 的运行时证据都收在本文件里。
const SHOTS = arg('shots', null);
// `--write`：额外走一次**真实的写路径**（收藏开关来回切一次，净零）。默认不做：
// 本探针默认只读，只有显式加这个参数才会改动目标实例上的数据（与仓库里"写库套件要显式放行"
// 是同一条纪律）。它验的是"点下去真的写进去了"，而不只是"按钮画得对"。
const WRITE = process.argv.includes('--write');

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
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === undefined || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
      else resolve(msg.result);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

const profileDir = join(tmpdir(), `probe-ui-old-${process.pid}`);
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

let browserWs;
let cdp;
try {
  const version = await waitForDevTools(PORT);
  browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browserWs.addEventListener('open', resolve, { once: true });
    browserWs.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), {
      once: true,
    });
  });
  cdp = new Cdp(browserWs);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 真实登录接口 → 服务端签发的会话 Cookie（与 shoot/probe 同一做法，不伪造已登录状态）
  if (!ANONYMOUS) {
    const login = await fetch(`${BASE}/ui/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    if (!login.ok) throw new Error(`登录失败 ${login.status}：${await login.text()}`);
    const rawCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const eq = rawCookie.indexOf('=');
    await send('Network.setCookie', {
      name: rawCookie.slice(0, eq),
      value: rawCookie.slice(eq + 1),
      domain: new URL(BASE).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    });
  }

  const consoleErrors = [];
  const failedRequests = [];
  cdp.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(`未捕获异常：${msg.params?.exceptionDetails?.exception?.description ?? ''}`);
    }
    if (msg.method === 'Network.responseReceived' && (msg.params?.response?.status ?? 200) >= 400) {
      failedRequests.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
  });

  if (DARK) {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
  }

  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, SETTLE));

  const read = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(
        `${d.text ?? 'Uncaught'} :: ${d.exception?.description ?? JSON.stringify(d).slice(0, 400)}`,
      );
    }
    return result.result.value;
  };

  // 对比度按 sRGB 相对亮度算（WCAG 2.x）。徽标这类小字必须 ≥ 4.5:1。
  const CONTRAST_HELPER = `
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (css) => (css.match(/\\d+(\\.\\d+)?/g) ?? []).slice(0, 3).map(Number);
    const contrast = (a, b) => {
      const [l1, l2] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
      return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
    };
    const box = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
    };
  `;

  const state = await read(`(() => {
    ${CONTRAST_HELPER}
    const q = (sel) => document.querySelector(sel);
    const rows = [...document.querySelectorAll('.table tr.row')];
    const chip = q('.col-type .chip');
    const chipStyle = chip ? getComputedStyle(chip) : null;
    const empty = q('.empty');
    const selection = q('.results__selection');
    const sortHeads = [...document.querySelectorAll('.table thead th')].map((th) => {
      const r = th.getBoundingClientRect();
      const label = th.querySelector('.th-sort');
      const lr = label ? label.getBoundingClientRect() : null;
      return {
        text: th.textContent.trim(),
        w: Math.round(r.width),
        h: Math.round(r.height),
        top: Math.round(r.top),
        labelTop: lr ? Math.round(lr.top) : null,
        labelH: lr ? Math.round(lr.height) : null,
      };
    });
    const theadRow = document.querySelector('.table thead tr');
    const theadRect = theadRow ? theadRow.getBoundingClientRect() : null;
    // 表头**格子**相对表头**行**的位移：sticky 生效时它会被顶离行盒，而布局高度不变。
    // 2026-09-17 的教训：.results 上的 overflow:hidden 让卡片成了滚动容器，
    // th 的 top:var(--header-h) 于是把表头下推 56px（自然位置只有 42px 的头栏），
    // 结果表头灰底压在第一行数据上 —— 只量行高永远量不出来，必须量这个差。
    const firstHeadCell = theadRow ? theadRow.querySelector('th') : null;
    const theadCellOffset = theadRect && firstHeadCell
      ? Math.round((firstHeadCell.getBoundingClientRect().top - theadRect.top) * 10) / 10
      : null;
    const theadInfo = theadRect
      ? {
          top: Math.round(theadRect.top),
          h: Math.round(theadRect.height),
          display: getComputedStyle(theadRow).display,
          flexWrap: getComputedStyle(theadRow).flexWrap,
          align: getComputedStyle(theadRow).alignItems,
          paddingTop: getComputedStyle(theadRow).paddingTop,
          scrollHeight: theadRow.scrollHeight,
          clientHeight: theadRow.clientHeight,
          checkOffsetTop: theadRow.firstElementChild
            ? theadRow.firstElementChild.offsetTop
            : null,
          labelOffsetTop: theadRow.querySelector('.th-sort')?.parentElement.offsetTop ?? null,
          children: [...theadRow.children].map((child) => ({
            cls: (child.className || '').toString().slice(0, 24),
            top: child.offsetTop,
            h: child.offsetHeight,
          })),
          overflowX: getComputedStyle(theadRow).overflowX,
          scrollLeft: theadRow.scrollLeft,
          scrollWidth: theadRow.scrollWidth,
          clientWidth: theadRow.clientWidth,
        }
      : null;
    const stats = q('.stats');
    const toolbar = q('.toolbar');
    // 四种类型徽标的前景/背景直接读令牌：列表当前页不一定同时出现四种类型，
    // 而「深色下徽标对比度」这条判据必须对四个都成立才叫成立。
    const rootStyle = getComputedStyle(document.documentElement);
    const token = (name) => rootStyle.getPropertyValue(name).trim();
    const typeContrast = ['text', 'image', 'file', 'group'].map((kind) => {
      const fg = token('--type-' + kind);
      const bg = token('--type-' + kind + '-bg');
      const probe = document.createElement('span');
      probe.style.color = fg;
      probe.style.backgroundColor = bg;
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const pair = { kind, color: style.color, bg: style.backgroundColor,
        contrast: contrast(style.color, style.backgroundColor) };
      probe.remove();
      return pair;
    });
    return JSON.stringify({
      booted: document.documentElement.dataset.appBooted ?? null,
      theme: document.documentElement.dataset.theme ?? null,
      rows: rows.length,
      headText: q('.results__count')?.textContent ?? null,
      rowHeight: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : null,
      // **逐行**高度：只量第一行是"抽样"，而"所有行等高"是**集合上的不变式** ——
      // 2026-09-17 的教训：上面那个 rowHeight 只取 rows[0]，于是"第一行与其余行不一样"
      // 这类问题恰好被这个采样点遮住（用户截图指出第一行更高，而探针只报了一个数）。
      // （这段注释里不能出现反引号：整块是模板字面量，一个反引号就会把它提前结束。）
      rowHeights: [...new Set(rows.map((r) => +r.getBoundingClientRect().height.toFixed(1)))].sort(
        (a, b) => a - b,
      ),
      rowHeightsFirst5: rows.slice(0, 5).map((r) => +r.getBoundingClientRect().height.toFixed(1)),
      // 比"众数"高的行是哪几条、高在哪：行高不一致本身不是缺陷（缩略图/换行/徽标都会撑高），
      // 但**必须知道是哪一类行** —— 否则"第一行为什么更高"这种问题只能靠盯图猜。
      tallRows: (() => {
        const heights = rows.map((r) => r.getBoundingClientRect().height);
        if (heights.length === 0) return null;
        const counts = new Map();
        for (const h of heights) counts.set(h, (counts.get(h) ?? 0) + 1);
        const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        return rows
          .map((r, index) => ({ r, index, h: r.getBoundingClientRect().height }))
          .filter((entry) => Math.abs(entry.h - mode) > 0.05)
          .slice(0, 6)
          .map((entry) => ({
            index: entry.index,
            h: +entry.h.toFixed(1),
            mode: +mode.toFixed(1),
            key: (entry.r.dataset.key ?? '').slice(0, 18),
            thumb: Boolean(entry.r.querySelector('.cell-content__thumb')),
            flags: entry.r.querySelector('.cell-content__flags')?.textContent ?? '',
            textLines: (() => {
              const text = entry.r.querySelector('.cell-content__text');
              if (!text) return null;
              const style = getComputedStyle(text);
              const line = Number.parseFloat(style.lineHeight) || 18;
              return Math.round(text.getBoundingClientRect().height / line);
            })(),
          }));
      })(),
      // 第一行每个单元格的高度与宽度：用来定位"是哪一格把它撑高的"
      firstRowCells: rows.length
        ? [...rows[0].children].map((td) => ({
            cls: (td.className || '').toString().slice(0, 24),
            h: Math.round(td.getBoundingClientRect().height),
            w: Math.round(td.getBoundingClientRect().width),
          }))
        : null,
      tableTop: q('.table') ? Math.round(q('.table').getBoundingClientRect().top) : null,
      contentColWidth: box(q('.row__cell-content'))?.w ?? null,
      chip: chipStyle
        ? { text: chip.textContent.trim(), color: chipStyle.color, bg: chipStyle.backgroundColor,
            contrast: contrast(chipStyle.color, chipStyle.backgroundColor) }
        : null,
      typeContrast,
      emptyHiddenAttr: empty ? empty.hidden : null,
      emptyDisplay: empty ? getComputedStyle(empty).display : null,
      selectionHiddenAttr: selection ? selection.hidden : null,
      selectionDisplay: selection ? getComputedStyle(selection).display : null,
      statsHeight: box(stats)?.h ?? null,
      // 活动趋势（借自 V2 的 /ui/api/activity）：柱子数、高度分布与可访问名。
      // 「14 根柱子都有高度」是判据本身 —— 0 高度的柱子视觉上等于"这天不存在"。
      spark: (() => {
        const node = q('.stats__spark');
        if (!node) return null;
        const bars = [...node.querySelectorAll('.spark__bar')];
        return {
          bars: bars.length,
          heights: bars.map((b) => Math.round(b.getBoundingClientRect().height)),
          ariaLabel: node.getAttribute('aria-label'),
          zeroBars: bars.filter((b) => b.dataset.zero === 'true').length,
        };
      })(),
      toolbarHeight: box(toolbar)?.h ?? null,
      // 工具栏每一组的位置与宽度：溢出与"挤成几行"都只能从这些盒子看出来
      toolbarBoxes: toolbar
        ? [...toolbar.children].map((child) => {
            const r = child.getBoundingClientRect();
            return {
              cls: (child.className || '').toString().replace('toolbar__group', 'grp'),
              x: Math.round(r.left),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          })
        : null,
      sortHeads,
      theadInfo,
      // 必须是 0：不为 0 说明表头被 sticky 顶离了它自己的行盒（视觉上压住相邻行）
      theadCellOffset,
      headGap: (() => {
        const head = q('.results__head');
        const table = q('.table');
        if (!head || !table) return null;
        return Math.round((table.getBoundingClientRect().top - head.getBoundingClientRect().bottom) * 10) / 10;
      })(),
      rowActionButtons: rows.length ? rows[0].querySelectorAll('.row-actions .icon-btn').length : null,
      rowActionsOpacity: rows.length ? getComputedStyle(rows[0].querySelector('.row-actions')).opacity : null,
      // 行内操作必须落在自己的单元格里：表格不产生滚动条，溢出只会表现为"贴到卡片右边"
      // 或盖住相邻列——两种都不会报错，只能靠量。取一行按钮最多的（图片行：4 个）。
      actionsFit: (() => {
        if (!rows.length) return null;
        const row = rows.find((r) => r.querySelectorAll('.row-actions .icon-btn').length >= 4) ?? rows[0];
        const cell = row.querySelector('.col-actions');
        const cellRect = cell.getBoundingClientRect();
        const boxes = [...cell.querySelectorAll('.icon-btn')].map((b) => b.getBoundingClientRect());
        if (!boxes.length) return null;
        const left = Math.min(...boxes.map((b) => b.left));
        const right = Math.max(...boxes.map((b) => b.right));
        return {
          count: boxes.length,
          cellW: Math.round(cellRect.width),
          span: Math.round(right - left),
          overflow: Math.round(right - cellRect.right),
        };
      })(),
      noticeVisible: q('.notice-bar') ? !q('.notice-bar').hidden : null,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // 横向溢出的**肇事者**：scrollWidth > clientWidth 只说"有溢出"，
      // 定位还得逐元素量右边缘。取最靠右的前 5 个，附标签名与类名。
      // （本条注释里不能出现反引号：整段是模板字面量，一个反引号就会把它提前结束。）
      overflowers: (() => {
        const limit = document.documentElement.clientWidth;
        return [...document.querySelectorAll('body *')]
          .map((node) => {
            const r = node.getBoundingClientRect();
            return { node, right: r.right, width: r.width };
          })
          .filter((e) => e.right > limit + 1 && e.width > 0)
          .sort((a, b) => b.right - a.right)
          .slice(0, 5)
          .map((e) => ({
            tag: e.node.tagName.toLowerCase(),
            cls: (e.node.className || '').toString().slice(0, 60),
            right: Math.round(e.right),
            w: Math.round(e.width),
          }));
      })(),
    });
  })()`);
  console.log('STATE   ', state);

  // ===== 首屏截图必须在**任何交互之前**拍 =====
  // 下面三段（SELECTION / KEYNAV / IME）会真的去点复选框、按方向键、往搜索框里打字，
  // 而 IME 那段收尾时会走 `setFilters({ search, page: 1 })` —— **把页码重置回 1**。
  // 于是 `--url '/ui_old/?page=99'` 这种用法下，STATE 打印的是越界页（夹取前 rows=0、
  // 夹取后 rows=9），而 01-list.png 里却是第 1 页：截图与数值互相矛盾，而"照片不是那个
  // 状态"的证据比没有证据更糟（这一次就是这么被骗了一遍）。故把拍照点提到 STATE 之后。
  const shotDir = SHOTS ? resolve(SHOTS) : null;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('[shot] →', file);
  };
  if (shotDir) await shot('01-list');

  // ===== 绘制几何审计 =====
  //
  // 这一类检查是 2026-09-17 两次"看走眼"之后补的：**布局指标全对、只有像素不对**的缺陷
  // （sticky 位移、绝对定位跑出容器、相邻行压在一起）在 `getBoundingClientRect` 的"高度"里
  // 完全看不出来 —— 必须逐元素比**矩形之间的包含与重叠关系**。
  // 判据都是集合上的不变式（"所有格子都在自己行里"），不是抽样。
  const AUDIT_EXPR = `(() => {
    const round = (n) => Math.round(n * 10) / 10;
    const findings = [];
    const rect = (node) => node.getBoundingClientRect();
    const label = (node) => {
      const cls = (node.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
      return node.tagName.toLowerCase() + (cls ? '.' + cls : '');
    };
    const push = (kind, node, detail) => {
      if (findings.length >= 12) return;
      findings.push({ kind, el: label(node), detail });
    };

    // ① 单元格必须在自己的行盒里（差 0.5px 以内）。
    //    这条会抓住 sticky 被"顶离"行盒的情况：布局高度不变，只有绘制位置变了。
    for (const tr of document.querySelectorAll('.table tr')) {
      const box = rect(tr);
      for (const cell of tr.children) {
        const r = rect(cell);
        if (r.width === 0 && r.height === 0) continue; // 被 display:none 的列
        const deltaBottom = round(r.bottom - box.bottom);
        const deltaTop = round(box.top - r.top);
        if (deltaTop > 0.5 || deltaBottom > 0.5) {
          push('cell-outside-row', cell, { deltaTop, deltaBottom });
        }
      }
    }

    // ② 相邻行不得互相压住（带 overlap 说明有位移或负 margin）
    const rows = [...document.querySelectorAll('.table tr.row')];
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rect(rows[i - 1]);
      const cur = rect(rows[i]);
      const overlap = round(prev.bottom - cur.top);
      if (overlap > 0.5) push('rows-overlap', rows[i], { overlap });
    }

    // ③ 结果区的三段（头栏 / 表格 / 空状态）不得互相压住
    const segs = [...document.querySelectorAll('.results > *')].filter((n) => !n.hidden);
    for (let i = 1; i < segs.length; i += 1) {
      const prev = rect(segs[i - 1]);
      const cur = rect(segs[i]);
      if (cur.top + 0.5 < prev.bottom) {
        push('results-overlap', segs[i], { overlap: round(prev.bottom - cur.top) });
      }
    }

    // ④ 任何被裁剪祖先（overflow 不是 visible）包住的元素，绘制矩形必须在那个裁剪盒里。
    //    这条抓的是"被 overflow 裁掉一半"的内容（按钮贴边、芯片跑出卡片…）。
    for (const node of document.querySelectorAll('.results *, .toolbar *, .stats *')) {
      const r = rect(node);
      if (r.width === 0 && r.height === 0) continue;
      let parent = node.parentElement;
      let clip = null;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          // 滚动容器允许内容超出（那是它的用途）：只在它**没有可滚动溢出**时判定
          const scrollable = parent.scrollWidth > parent.clientWidth + 1 || parent.scrollHeight > parent.clientHeight + 1;
          if (!scrollable) clip = { box: rect(parent), owner: parent };
          break;
        }
        parent = parent.parentElement;
      }
      if (!clip) continue;
      const over = {
        top: round(clip.box.top - r.top),
        bottom: round(r.bottom - clip.box.bottom),
        left: round(clip.box.left - r.left),
        right: round(r.right - clip.box.right),
      };
      const worst = Math.max(over.top, over.bottom, over.left, over.right);
      if (worst > 0.5) push('clipped', node, { owner: label(clip.owner), ...over });
    }

    return JSON.stringify({ findings, count: findings.length });
  })()`;
  const runAudit = async (label) => console.log('AUDIT   ', `${label} ${await read(AUDIT_EXPR)}`);
  await runAudit('initial');

  // 选择条的开合：勾选第一行 → 读条 → 取消选择 → 再读条。
  // 这一段存在的理由：`.results__selection` 的 CSS 里写了 `display: flex`，而 JS 用 `hidden`
  // 关它——若没有 `[hidden]` 守卫，取消选择后那条「已选 N 条 + 批量按钮」会**留在页面上**。
  const selectionFlow = await read(`(async () => {
    const first = document.querySelector('.table tr.row input.checkbox');
    if (!first) return JSON.stringify({ skipped: 'no rows' });
    const read2 = () => {
      const head = document.querySelector('.results__head');
      const sel = document.querySelector('.results__selection');
      const info = document.querySelector('.results__count');
      return {
        selHidden: sel.hidden,
        selDisplay: getComputedStyle(sel).display,
        selH: Math.round(sel.getBoundingClientRect().height),
        selText: sel.textContent.trim().slice(0, 60),
        infoHidden: info.hidden,
        headH: Math.round(head.getBoundingClientRect().height),
      };
    };
    first.click();
    await new Promise((r) => setTimeout(r, 200));
    const on = read2();
    first.click();
    await new Promise((r) => setTimeout(r, 200));
    const off = read2();
    return JSON.stringify({ on, off });
  })()`);
  console.log('SELECTION', selectionFlow);

  // 行间方向键：焦点放在第 1 行的「预览」上，按 ↓ 后应当落在第 2 行的**同一个**控件上。
  // 这条检查存在的理由：方向键是**纯增量**（Tab 顺序一个不动），它最容易在重构行结构时
  // 被顺手弄坏 —— 坏了不会有任何报错，只是键盘用户按了没反应。
  const keyNav = await read(`(async () => {
    const rows = [...document.querySelectorAll('.table tr.row')];
    if (rows.length < 2) return JSON.stringify({ skipped: 'not enough rows' });
    const describe = () => {
      const node = document.activeElement;
      const row = node?.closest?.('tr.row');
      return {
        tag: node?.tagName?.toLowerCase() ?? null,
        action: node?.dataset?.action ?? null,
        isCheckbox: node?.classList?.contains('checkbox') ?? false,
        rowIndex: row ? rows.indexOf(row) : null,
      };
    };
    const first = rows[0].querySelector('[data-action="preview"]') ?? rows[0].querySelector('button, input');
    first.focus();
    const before = describe();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const after = describe();
    const last = rows[rows.length - 1].querySelector('[data-action="preview"]');
    last?.focus();
    last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const atEnd = describe();
    return JSON.stringify({ before, after, atEnd });
  })()`);
  console.log('KEYNAV  ', keyNav);

  // 输入法组合期间的搜索（中文/日文）：拼音串不该被当成搜索词发出去。
  // 判据用 URL 而不是"数请求"：`setFilters` 里 `syncUrl` 是**同步**执行的，所以只要发出了一次
  // 搜索，`?search=` 会立刻出现在地址栏上 —— URL 是这条链路上最直接的事实源。
  const imeSearch = await read(`(async () => {
    const input = document.getElementById('search');
    if (!input) return JSON.stringify({ skipped: 'no search input' });
    const current = () => new URLSearchParams(location.search).get('search');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'z';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(140);
    input.value = 'zh';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(600); // 超过 260ms 的去抖窗口：若组合期间会发，这里已经发出去了
    const duringComposition = current();
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await wait(700);
    const afterComposition = current();
    // 收尾：清空搜索，别把状态留给后面的检查
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(500);
    return JSON.stringify({ duringComposition, afterComposition, reset: current() });
  })()`);
  console.log('IME     ', imeSearch);

  // 批量复制（2026-09-18）：**真的点一次**，再把剪贴板读回来逐字对照。
  // 为什么不能只看渲染：这条链上有四段各自会静默失败的东西 —— 选中集、batch-meta 分片、
  // 全文拼接、剪贴板写入 —— 而"按钮画得对"与"内容真的进去了"是两件事。
  // 它**不改服务端数据**（只读 + 写本机剪贴板），故属于默认的只读探针，不需要 --write。
  // 剪贴板权限：headless 下页面不算"已聚焦"，直接 readText 会被拒，故先授权限 + 打开焦点模拟。
  await send('Browser.grantPermissions', {
    origin: BASE,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const batchCopy = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rows = [...document.querySelectorAll('tbody tr.row')].slice(0, 2);
    if (rows.length < 2) return JSON.stringify({ skipped: '少于两行' });
    const cellText = (row) => (row.querySelector('.cell-content__text')?.textContent ?? '').trim();
    const texts = rows.map(cellText);
    for (const row of rows) {
      const box = row.querySelector('.checkbox');
      if (box && !box.checked) box.click();
    }
    await wait(150);
    const batchButtons = () => [...document.querySelectorAll('.results__selection button')];
    const button = batchButtons().find((b) => (b.textContent ?? '').includes('复制选中'));
    if (!button) return JSON.stringify({ error: '选择条里没有「复制选中」' });
    button.click();
    // 进行中态要**同步**读：click 派发是同步的，处理器里的第一句就是 setPending(true)，
    // 故这一刻必然已置上。等到 40ms 再读会变成"看请求有多快"——两条小记录的批量复制
    // 早就跑完了（实测 pendingDuring 恒为 null），那是在测网络而不是测代码。
    const pendingImmediately = button.dataset.loading ?? null;
    await wait(2500);
    const pendingAfter = button.dataset.loading ?? null;
    let clipboard = '';
    try {
      clipboard = await navigator.clipboard.readText();
    } catch (error) {
      clipboard = 'ERR:' + (error?.message ?? error);
    }
    const result = {
      first: texts[0].slice(0, 24),
      second: texts[1].slice(0, 24),
      pendingImmediately,
      pendingAfter,
      clipboardReadable: !clipboard.startsWith('ERR:'),
      clipboardHead: clipboard.slice(0, 60),
      containsFirst: texts[0] !== '' && clipboard.includes(texts[0]),
      containsSecond: texts[1] !== '' && clipboard.includes(texts[1]),
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
    };
    // 收尾：取消选择（只动本机界面状态，不碰服务端）
    batchButtons().find((b) => (b.textContent ?? '').includes('取消选择'))?.click();
    return JSON.stringify(result);
  })()`);
  console.log('BATCHCOPY', batchCopy);

  // ===== A5 · 失败路径的「重试」（2026-09-18）=====
  // 用 `Network.emulateNetworkConditions({ offline: true })` 把下一次列表请求打成网络失败，
  // 再点提示条里的「重试」看列表是否恢复。为什么要"制造"故障：真实的瞬时故障没法按需出现，
  // 而这条修复的全部内容就是"提示条里有没有重试按钮、那个按钮是否真的重发了请求"。
  await send('Network.enable');
  const offline = (on) =>
    send('Network.emulateNetworkConditions', {
      offline: on,
      latency: 0,
      downloadThroughput: on ? 0 : -1,
      uploadThroughput: on ? 0 : -1,
    });
  await offline(true);
  const retryState = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const refreshButton = document.querySelector('.toolbar .icon-btn[aria-label="刷新"]');
    if (!refreshButton) return JSON.stringify({ skipped: '找不到刷新按钮' });
    const rowsBefore = document.querySelectorAll('tbody tr.row').length;
    refreshButton.click();
    await wait(900);
    const action = document.querySelector('.toast__action');
    const toastText = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
    // 顺带读一眼顶栏那枚「状态图标 + 部署信息」：断网后推送通道会掉线，图标应当从
    // 广播/信号（live）换成刷新箭头（offline），而 hover 文案（title）从"实时推送"换成"轮询刷新"。
    const status = document.querySelector('.status');
    return JSON.stringify({
      rowsBefore,
      hasAction: Boolean(action),
      actionLabel: action?.textContent ?? null,
      toastText: toastText.slice(0, 120),
      statusTitle: status?.title ?? null,
      statusTone: status?.dataset.tone ?? null,
      statusIcon: (status?.querySelector('path')?.getAttribute('d') ?? '').slice(0, 16),
    });
  })()`);
  // 恢复网络**再**点重试 —— 这才是真实时序（网断 → 失败 → 网通 → 按下重试）。
  // 第一次实现把点重试放在恢复之前，于是重试自己也失败、失联横幅当然还挂着，读起来像"重试坏了"。
  await offline(false);
  const retryAfter = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const action = document.querySelector('.toast__action');
    action?.click();
    await wait(1800);
    return JSON.stringify({
      rowsAfter: document.querySelectorAll('tbody tr.row').length,
      staleBanner: !document.getElementById('notice')?.hidden,
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ').slice(0, 80),
    });
  })()`);
  console.log('RETRY   ', `${retryState} → ${retryAfter}`);

  // ===== A4 · 有结果时的一键复位筛选（2026-09-18）=====
  await send('Page.navigate', { url: `${BASE}/ui_old/?types=File` });
  await new Promise((r) => setTimeout(r, 1800));
  const resetFilter = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const head = document.querySelector('.results__head');
    const button = [...(head?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('清除筛选'));
    const before = {
      search: location.search,
      headText: head?.textContent?.trim().slice(0, 40) ?? null,
      hasButton: Boolean(button),
      buttonHidden: button?.hidden ?? null,
      fileChipPressed: [...document.querySelectorAll('.segmented__item')].find((b) => (b.textContent ?? '').includes('文件'))?.getAttribute('aria-pressed'),
    };
    if (!button) return JSON.stringify({ before });
    button.click();
    await wait(1200);
    return JSON.stringify({
      before,
      after: {
        search: location.search,
        headText: document.querySelector('.results__head')?.textContent?.trim().slice(0, 40) ?? null,
        allChipPressed: [...document.querySelectorAll('.segmented__item')][0]?.getAttribute('aria-pressed'),
        rows: document.querySelectorAll('tbody tr.row').length,
      },
    });
  })()`);
  console.log('RESETFILTER', resetFilter);

  // ===== A8 · 顶栏「复制最近一条」（2026-09-18）=====
  // 断言三件事：按钮真的把内容写进了剪贴板（逐字对照第一行的正文）、提示条报了条数、
  // 而且它取的是**全库最新**而不是当前列表的第一行（当前列表此时未被筛选/排序过，两者一致）。
  await send('Page.navigate', { url: `${BASE}/ui_old/` });
  await new Promise((r) => setTimeout(r, 1800));
  const copyLatest = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const button = document.querySelector('.app-header button[aria-label="复制最近一条"]');
    const firstRowText = (document.querySelector('tbody tr.row .cell-content__text')?.textContent ?? '').trim();
    if (!button) return JSON.stringify({ skipped: '找不到复制最近一条' });
    const hidden = button.hidden;
    button.click();
    // 与批量复制同一条纪律：进行中态要**同步**读
    const pendingImmediately = document.querySelector('.app-header button[aria-label="复制最近一条"]')?.dataset.loading ?? null;
    await wait(1500);
    let clipboard = '';
    try {
      clipboard = await navigator.clipboard.readText();
    } catch (error) {
      clipboard = 'ERR:' + (error?.message ?? error);
    }
    return JSON.stringify({
      hidden,
      pendingImmediately,
      firstRowText: firstRowText.slice(0, 24),
      clipboardHead: clipboard.slice(0, 40),
      containsFirstRow: firstRowText !== '' && clipboard.includes(firstRowText),
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ').slice(0, 80),
    });
  })()`);
  console.log('COPYLATEST', copyLatest);

  // ===== 状态图标的三个字形（2026-09-18）=====
  // 顶栏那枚胶囊里，状态只由**图标**承载（文字只写"部署信息"），故三个字形必须真的会换。
  // 刺激用的是应用自己认的那个事件：`visibilitychange` → 隐藏时 `pushChannel.stop()` →
  // 状态转 offline（`main.js` 的可见性处理器就是这么写的），回前台再 start()。
  // 比"断网"更可靠：断网掐不掉已经建立的 WebSocket（实测那时仍是 live）。
  const statusIcons = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const readStatus = () => {
      const node = document.querySelector('.status');
      return {
        title: node?.title ?? null,
        tone: node?.dataset.tone ?? null,
        icon: (node?.querySelector('path')?.getAttribute('d') ?? '').slice(0, 14),
        label: node?.textContent?.trim() ?? null,
      };
    };
    const live = readStatus();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(200);
    const hidden = readStatus();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(400);
    const back = readStatus();
    return JSON.stringify({ live, hidden, back });
  })()`);
  console.log('STATUSICON', statusIcons);

  if (WRITE) {
    // 写路径：点第一行的「收藏」→ 按钮就地变状态 → 服务端真的存了 → 再点回去。
    // 三条断言各有理由：① 点了要有反应（本地就地更新，不等下一次轮询）；
    // ② 服务端要真的落了（否则会"看着成功了、刷新就没了"）；③ 要能切回去（净零）。
    const writeCheck = await read(`(async () => {
      const row = document.querySelector('.table tr.row');
      const button = row?.querySelector('[data-action="star"]');
      if (!button) return JSON.stringify({ skipped: 'no star button' });
      const key = row.dataset.key;
      const sep = key.indexOf('-');
      const type = key.slice(0, sep);
      const hash = key.slice(sep + 1);
      const readServer = async () => {
        const res = await fetch('/ui/api/history/' + encodeURIComponent(type) + '/' + encodeURIComponent(hash));
        const body = await res.json();
        return { status: res.status, starred: body.starred, version: body.version };
      };
      const before = { pressed: button.getAttribute('aria-pressed'), server: await readServer() };
      button.click();
      await new Promise((r) => setTimeout(r, 900));
      const flipped = { pressed: button.getAttribute('aria-pressed'), server: await readServer() };
      button.click();
      await new Promise((r) => setTimeout(r, 900));
      const restored = { pressed: button.getAttribute('aria-pressed'), server: await readServer() };
      return JSON.stringify({ key, before, flipped, restored });
    })()`);
    console.log('WRITE   ', writeCheck);
  }

  if (SHOTS) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // 01-list 已在 STATE 之后、交互之前拍过（见那里的注释）

    // 回收站：写入路径不碰它（只读），用它验证「已删除行的对比度 + 恢复按钮的禁用理由」
    await send('Page.navigate', { url: `${BASE}/ui_old/?deleted=1` });
    await wait(2500);
    await runAudit('trash');
    await shot('02-trash');

    // 空状态：用一个不可能命中的搜索词逼出来（不写库、不改数据）
    await send('Page.navigate', { url: `${BASE}/ui_old/?search=zzz-no-such-record` });
    await wait(2500);
    await runAudit('empty');
    await shot('03-empty');

    // 部署信息：2026-09-18 起并进了顶栏那枚**状态胶囊**（`[● 实时推送 ⓘ]`，整枚可点），
    // 故这里按 aria-label **包含**「部署信息」来找 —— 前缀随状态变（实时推送/正在连接/轮询刷新）。
    await send('Page.navigate', { url: `${BASE}/ui_old/` });
    await wait(2500);
    await read(
      `[...document.querySelectorAll('.app-header__actions button')]
        .find((b) => (b.getAttribute('aria-label') ?? '').includes('部署信息'))?.click(), 'clicked'`,
    );
    await wait(900);
    await runAudit('info-dialog');
    await shot('04-info');
    await read(`document.querySelector('dialog[open]')?.close(), 'closed'`);
    await wait(400);

    // 预览：文本行的「预览」按钮（第一行）
    await read(
      `document.querySelector('.table tr.row [data-action="preview"]')?.click(), 'clicked'`,
    );
    await wait(900);
    await runAudit('preview-dialog');
    await shot('05-preview');
    await read(`document.querySelector('dialog[open]')?.close(), 'closed'`);
    await wait(300);

    // 选择条：勾选前两行后截图 —— 它同时验证「选中态的背景、批量按钮、计数隐藏」
    await read(
      `(() => {
        const boxes = [...document.querySelectorAll('.table tr.row input.checkbox')].slice(0, 2);
        for (const box of boxes) box.click();
        return 'checked';
      })()`,
    );
    await wait(400);
    await runAudit('selection');
    await shot('06-selection');
  }

  console.log('CONSOLE ERRORS', consoleErrors.length ? consoleErrors : 'none');
  console.log('FAILED REQUESTS', failedRequests.length ? failedRequests : 'none');
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
    /* 临时目录清不掉不影响结果 */
  }
}
