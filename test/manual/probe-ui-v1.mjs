// V1（`/ui_v1/`）界面的运行时探针（手动运行，不属于 npm test 套件）
//
// 为什么 V1 也需要它：2026-09-17 起 `public/ui_v1/` 从「冻结存档」重新变成**在维护的**
// 界面（2026-09-18 起是**默认界面**，见该目录 README）。维护状态的界面需要它自己的一份「读真实 DOM 值」的
// 工具——截图只能证明"看起来对"，证明不了"计算值对"。V2 有 `probe.mjs`，本文件是它的 V1
// 对位物：同一套 CDP 起浏览器/登录/注入 Cookie 的做法，探针内容按 V1 的 DOM 重写。
//
// 用法（需 dev server 已启动）：
//   node test/manual/probe-ui-v1.mjs
//   node test/manual/probe-ui-v1.mjs --width 390 --height 844
//   node test/manual/probe-ui-v1.mjs --width 1024 --coarse   # 触屏模拟（COARSE 行会报媒体查询是否真匹配）
//   node test/manual/probe-ui-v1.mjs --dark
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const URL_PATH = arg('url', '/ui_v1/');
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
// `--coarse`：模拟触屏（`pointer: coarse`）。行内操作那一排的命中区与间距只在粗指针下才变，
// 而它正是"下载紧挨着删除"这类误触的现场 —— 只能在模拟成触屏时才量得到。
const COARSE = process.argv.includes('--coarse');

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
// 文本下载的落点（`TEXTDL` 一行要读回磁盘上的那个 .txt），与浏览器 profile 同生命周期
const downloadDir = join(tmpdir(), `probe-ui-old-dl-${process.pid}`);
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
    // 触屏模拟必须**在导航之前**设好（媒体查询首帧就参与布局），且 `mobile: true` 是必需的：
    // Chrome 的 `(pointer: coarse)` 跟的是设备模拟里的"主指针"，只开 touch 事件时不匹配。
    mobile: COARSE,
  });
  if (COARSE) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }

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

  // ===== 首帧主题脚本的时序（`docs/AUDIT-redundancies.md` §11 #10；本仓库 §94 第 17 行）=====
  // `theme-init.js` 是 `<head>` 里 **位于样式表之后**的经典阻塞脚本，它那句
  // `getComputedStyle(documentElement).getPropertyValue('--bg')` **到底取不取得到值**，
  // 静态判不了：V2 的注释断言"此刻样式表还没加载、永远停在 HTML 静态值上"，
  // 而按 HTML 规范前置样式表会阻塞经典脚本 —— 两种说法都说得通。
  // 这里做**不改源码**的观测，两条证据链：
  //   ① 包装 `getComputedStyle`，记下它每次被调用时看到的 `--bg`（第一笔就是 theme-init）；
  //   ② 监听 `meta[name=theme-color]` 的 `content` 首次被写入的时刻（`readyState` + 已加载样式表数）。
  // 判据：首次写入发生在 `readyState === 'loading'` 且写入值 ≠ HTML 里的静态值 ⇒ theme-init 取值成功。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__probeTheme = { calls: [], writes: [] };
      const orig = window.getComputedStyle;
      window.getComputedStyle = function (...args) {
        const style = orig.apply(this, args);
        try {
          window.__probeTheme.calls.push({
            bg: style.getPropertyValue('--bg').trim(),
            sheets: document.styleSheets.length,
            ready: document.readyState,
          });
        } catch {}
        return style;
      };
      new MutationObserver((records) => {
        for (const record of records) {
          window.__probeTheme.writes.push({
            content: record.target.getAttribute('content'),
            ready: document.readyState,
            sheets: document.styleSheets.length,
          });
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['content'] });
    })();`,
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

  // ===== 静止即静止（handfeel §7 的落点：到达并停住）=====
  // 判据不是"看着不动"，而是 `document.getAnimations()` 里没有还在跑的动画。允许的例外只有
  // **在用持续动效编码"正在做"的那两个**：推送通道连接中的旋转环、以及骨架屏的呼吸
  // （骨架屏只在首屏未就绪时存在，这里一般看不到）。其余任何 running 动画都意味着
  // "页面已经静止了，但还有东西在动" —— 那正是装饰性循环动效的形态。
  const settled = await read(`(() => {
    const running = document.getAnimations().filter((a) => a.playState === 'running');
    const nameOf = (a) => a.animationName ?? (a.transitionProperty ? 'transition:' + a.transitionProperty : 'unknown');
    return JSON.stringify({
      runningCount: running.length,
      names: [...new Set(running.map(nameOf))],
      pushTone: document.querySelector('.status')?.dataset.tone ?? null,
      resultsBusy: document.querySelector('.results')?.hasAttribute('data-busy') ?? null,
    });
  })()`);
  console.log('SETTLED ', settled);

  // ===== 首帧主题脚本：把上面那支观测读回来 =====
  // `theme` = 生效主题；`meta` = 最终写进 `theme-color` 的值（HTML 静态值是 `#faf8f5`）；
  // `firstBgSeen` = `getComputedStyle` 被**第一次**调用时看到的 `--bg`（即 theme-init 看到的值）。
  const themeProbe = await read(`(() => {
    const probe = window.__probeTheme ?? { calls: [], writes: [] };
    return JSON.stringify({
      theme: document.documentElement.dataset.theme ?? null,
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      nowBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      firstBgSeen: probe.calls[0] ? probe.calls[0].bg : null,
      firstSeenReady: probe.calls[0] ? probe.calls[0].ready : null,
      firstSeenSheets: probe.calls[0] ? probe.calls[0].sheets : null,
      writes: probe.writes,
    });
  })()`);
  console.log('THEMECOLOR', themeProbe);

  // ===== 运行期那条断言（V2 `theme.js:9-10`：「切换后 `getComputedStyle` 会立即返回**旧值**」）=====
  // 两版运行期都是"先写 `dataset.theme`、再读计算值去同步 `theme-color`" ⇒ 这条断言若是假的，
  // 两边都不用绕开计算值。**非破坏性**：同一个同步块里设属性→读数→立刻还原（还原 `data-theme`
  // 与 `theme-color` 两样），中间态不渲染，后续读数不受影响。
  const themeSwitch = await read(`(() => {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    const keepTheme = root.dataset.theme;
    const keepMeta = meta ? meta.getAttribute('content') : null;
    const other = keepTheme === 'dark' ? 'light' : 'dark';
    const before = getComputedStyle(root).getPropertyValue('--bg').trim();
    root.dataset.theme = other;
    const after = getComputedStyle(root).getPropertyValue('--bg').trim();
    root.dataset.theme = keepTheme;
    if (meta && keepMeta !== null) meta.setAttribute('content', keepMeta);
    return JSON.stringify({
      from: keepTheme,
      to: other,
      before,
      after,
      stale: before === after,
      restoredTheme: root.dataset.theme,
      restoredMeta: meta ? meta.getAttribute('content') : null,
    });
  })()`);
  console.log('THEMESWITCH', themeSwitch);

  // ===== 顶栏那枚「部署信息」胶囊：四个字**不许断开**（2026-09-18 用户截图）=====
  // 用户看到的形态是「部署信 / 息」两行、字还溢出了 30px 高的胶囊。根因是**没有 nowrap**：
  // 胶囊是 flex 项，顶栏一挤就按比例被压，而中文没有词边界，于是"能压到只剩一个字的宽度"。
  // 这里量四件事，任何一条不达标都能一眼定位：
  //   ① `labelLines` —— 数**文字的行盒**：`entry.getClientRects()` 不行（它在 flex 里被块化，
  //      只有一个盒子，288px 实测那会儿它报 1、而高度是 81px 的 4 行），用 Range 取文本的矩形；
  //      ② 胶囊自身的宽高（字溢出去时 label 盒比胶囊高）；
  //   ③ `innerOverflow` —— 顶栏内容超出容器的量，超出的部分会被 `html { overflow-x: clip }` 裁掉，
  //      屏幕上"看不见"但东西真的没了；④ 最右那个控件还在不在视口里。
  const header = await read(`(() => {
    const entry = document.querySelector('.status__entry');
    const pill = document.querySelector('.status');
    const inner = document.querySelector('.app-header__inner');
    const actions = document.querySelector('.app-header__actions');
    const last = actions?.lastElementChild;
    const e = entry?.getBoundingClientRect();
    const p = pill?.getBoundingClientRect();
    let labelLines = null;
    if (entry) {
      const range = document.createRange();
      range.selectNodeContents(entry);
      labelLines = range.getClientRects().length;
    }
    return JSON.stringify({
      label: entry?.textContent?.trim() ?? null,
      whiteSpace: entry ? getComputedStyle(entry).whiteSpace : null,
      labelLines,
      labelBox: e ? [Math.round(e.width), Math.round(e.height)] : null,
      pillBox: p ? [Math.round(p.width), Math.round(p.height)] : null,
      labelOverflowsPill: e && p ? Math.round(e.height - p.height) > 0 : null,
      innerOverflow: inner ? Math.round(inner.scrollWidth - inner.clientWidth) : null,
      lastControlRight: last ? Math.round(last.getBoundingClientRect().right) : null,
      viewport: window.innerWidth,
    });
  })()`);
  console.log('HEADER  ', header);

  // ===== 工具栏：「每页条数 + 刷新」这一组（2026-09-18 用户要求）=====
  // 用户要的是"50 条/页 绑定刷新，放在下面一行右边"。三件事都要量，缺一条就不算做到：
  // ① 每页条数**在窄屏还看得见**（上一版是 `display: none`，那条已被反转）；
  // ② 两件在**同一组/同一行**（它们本来就是 `.toolbar__group--pager` 的两个孩子）；
  // ③ 整组贴**行尾**（`margin-left: auto`）：`gapToRight` 应为 0；放不下时它会整体落到下一行，
  //    那时 `sameRowAsFilters` 为 false 但 `gapToRight` 仍应为 0。
  const pagerBar = await read(`(() => {
    const toolbar = document.querySelector('.toolbar');
    const pager = toolbar?.querySelector('.toolbar__group--pager') ?? null;
    const size = toolbar?.querySelector('select[aria-label="每页条数"]') ?? null;
    const refresh = toolbar?.querySelector('button[aria-label="刷新"]') ?? null;
    const filters = toolbar?.querySelector('select[aria-label="时间范围"]')?.closest('.toolbar__group') ?? null;
    const rect = (n) => {
      const r = n?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), right: Math.round(r.right), w: Math.round(r.width) } : null;
    };
    const box = toolbar?.getBoundingClientRect();
    const same = (a, b) => Boolean(a && b) && a.top < b.bottom && b.top < a.bottom;
    const rb = pager?.getBoundingClientRect();
    return JSON.stringify({
      sizeSelectVisible: size ? getComputedStyle(size).display !== 'none' : null,
      sizeBox: rect(size),
      refreshBox: rect(refresh),
      pagerBox: rect(pager),
      filtersBox: rect(filters),
      sameRowAsFilters: same(rb, filters?.getBoundingClientRect()),
      gapToRight: rb && box ? Math.round(box.right - rb.right) : null,
      toolbarOverflow: toolbar ? Math.round(toolbar.scrollWidth - toolbar.clientWidth) : null,
      viewport: window.innerWidth,
    });
  })()`);
  console.log('PAGERBAR', pagerBar);

  // ===== 行内操作这一排的命中区（2026-09-18）=====
  // 判据来自 V2 踩过的坑：44px 命中区之间只要重叠或贴太近，「下载」与「删除」就会互相误触。
  // 这里量五件事：媒体查询是否真的匹配（不匹配则这次证据无效，一眼能看出）、这一排的 rest 不透明度、
  // 按钮的实际尺寸、相邻按钮的**中心距**（≥44 才不重叠）、以及最宽一行（4 个按钮）是否还在单元格里。
  const coarseGeom = await read(`(() => {
    const rows = [...document.querySelectorAll('tbody tr.row')];
    if (!rows.length) return JSON.stringify({ skipped: 'no rows' });
    const wide = rows.find((r) => r.querySelectorAll('.row-actions .icon-btn').length >= 4) ?? rows[0];
    const cell = wide.querySelector('.col-actions');
    const btns = [...cell.querySelectorAll('.icon-btn')];
    const boxes = btns.map((b) => b.getBoundingClientRect());
    const cellBox = cell.getBoundingClientRect();
    const centers = boxes.map((b) => Math.round((b.left + b.right) / 2));
    const pitch = centers.slice(1).map((c, i) => c - centers[i]);
    const bar = document.querySelector('.row-actions');
    return JSON.stringify({
      coarseMatches: matchMedia('(pointer: coarse)').matches,
      opacity: bar ? getComputedStyle(bar).opacity : null,
      gap: bar ? getComputedStyle(bar).columnGap : null,
      buttons: btns.length,
      size: boxes.length ? [Math.round(boxes[0].width), Math.round(boxes[0].height)] : null,
      centerPitch: pitch,
      minPitch: pitch.length ? Math.min(...pitch) : null,
      cellWidth: Math.round(cellBox.width),
      overflowRight: boxes.length ? Math.round(boxes[boxes.length - 1].right - cellBox.right) : null,
    });
  })()`);
  console.log('COARSE  ', coarseGeom);

  // 禁用态的行内按钮还能不能被指针"够到"：够不到就没有 title 提示、也没有 not-allowed 光标
  // （`.icon-btn[disabled]` 曾经带 `pointer-events: none`，于是「数据不可用，无法下载」永远看不见）。
  // 用一个临时节点读计算值，读完立刻摘掉 —— 不改页面状态、也不进截图。
  const disabledIcon = await read(`(() => {
    const probe = document.createElement('button');
    probe.className = 'icon-btn';
    probe.type = 'button';
    probe.disabled = true;
    probe.title = '探针临时节点';
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const out = { pointerEvents: cs.pointerEvents, cursor: cs.cursor, opacity: cs.opacity };
    probe.remove();
    return JSON.stringify(out);
  })()`);
  console.log('DISABLED', disabledIcon);

  // ===== 分页在窄屏的行结构（2026-09-18 用户截图：390px 下折成四行、按钮各占一行）=====
  // 判据是"控件之间的**行关系**"而不是"看着行不行"：范围文本允许独占一行（它长），
  // 但「上一页 / 第 X/Y 页 / 下一页」必须**同一行**。根因曾是两者共用 `pagination__range`
  // 这个类，窄屏那条 `width: 100%` 把页码标签也撑成整行。
  const pager = await read(`(() => {
    const nav = document.querySelector('.pagination');
    if (!nav) return JSON.stringify({ skipped: 'no .pagination' });
    const rectOf = (node) => (node ? node.getBoundingClientRect() : null);
    const buttons = [...nav.querySelectorAll('button')];
    const range = rectOf(nav.querySelector('.pagination__range'));
    const label = rectOf(nav.querySelector('.pagination__page'));
    const prev = rectOf(buttons.find((b) => (b.textContent ?? '').includes('上一页')));
    const next = rectOf(buttons.find((b) => (b.textContent ?? '').includes('下一页')));
    // 判据是竖直投影是否重叠，**不是"top 相等"**：分页容器是 align-items center，
    // 36px 的按钮与 18px 的文字天然差 9px —— 第一版拿 top 比，写出了假阴性。
    // （提醒：这一段在模板串里，注释里不要再出现反引号，否则会把外层串提前闭合。）
    const sameLine = (a, b) => (a && b ? a.bottom > b.top + 1 && b.bottom > a.top + 1 : null);
    const tops = [range, prev, label, next].filter(Boolean).map((r) => Math.round(r.top));
    return JSON.stringify({
      // rows（去重后的 top 个数）**不能**当作行数：同一行上居中对齐的控件 top 各不相同
      // （36px 按钮 vs 18px 文字差 9px）。只报"谁和谁同行"这两条关系。
      rangeAloneOnFirstLine: range && prev ? !sameLine(range, prev) : null,
      prevLabelSameLine: sameLine(prev, label),
      labelNextSameLine: sameLine(label, next),
      rangeOwnLine: range && prev ? Math.round(range.top) < Math.round(prev.top) : null,
      // 控制组要**靠右**：最后一个**可见**子元素（窄屏是 next，桌面还有跳页输入框跟在它后面）
      // 的右缘与容器右缘的差值应≈0。窄屏换行到第二行时同样成立 —— 那正是 margin-left:auto 的作用。
      groupRightGap: (() => {
        const visible = [...nav.children].filter((n) => getComputedStyle(n).display !== 'none');
        const last = visible[visible.length - 1];
        return last ? Math.round(nav.getBoundingClientRect().right - last.getBoundingClientRect().right) : null;
      })(),
      widths: [range, prev, label, next].map((r) => (r ? Math.round(r.width) : null)),
      overflowRight: next ? Math.round(next.right - window.innerWidth) : null,
    });
  })()`);
  console.log('PAGER   ', pager);

  // ===== 首屏截图必须在**任何交互之前**拍 =====
  // 下面三段（SELECTION / KEYNAV / IME）会真的去点复选框、按方向键、往搜索框里打字，
  // 而 IME 那段收尾时会走 `setFilters({ search, page: 1 })` —— **把页码重置回 1**。
  // 于是 `--url '/ui_v1/?page=99'` 这种用法下，STATE 打印的是越界页（夹取前 rows=0、
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
  // 判据一直在，但**只打印、不影响退出码** —— 人工不逐行看输出就发现不了（审计 §12.16③）。
  // 这里把每次结果累计起来，末尾统一决定退出码；同目录的 states.mjs 早已是这个写法。
  const auditFindings = [];
  const runAudit = async (label) => {
    const raw = await read(AUDIT_EXPR);
    console.log('AUDIT   ', label + ' ' + raw);
    try {
      for (const f of JSON.parse(raw).findings ?? []) auditFindings.push(label + ': ' + f.kind + ' ' + f.el);
    } catch {
      auditFindings.push(label + ': 无法解析 AUDIT 结果');
    }
  };
  await runAudit('initial');

  // ===== 骨架行高 = 真实行高（2026-09-20，`docs/progress.md` §94 第 16 行）=====
  //
  // V1 的骨架行高有**两档**，两档都要求等于真实行高（理由在 `components.css` 的
  // `.skeleton__row` 注释里）：
  //   · 表格档（>860px）绑定 `.table td` 的盒模型 —— 8+8+1+30 = 47px；
  //   · 卡片档（≤860px）绑定 `.table tr.row` 的盒模型 —— 实测 103px（细指针）/ 117px（粗指针）。
  // 骨架一旦与真实行不同高，内容落地时折线以上的东西就会位移，它就从「CLS 的解法」变成来源。
  //
  // ⚠️ 骨架在 fast path 下只存在一帧（数据一到就被 `list.js` 换成表格），走正常流程量不到
  // ⇒ 就地造一份**真的** `.skeleton`、放进 `.results`（与真实那一份同一个父元素、同一套 CSS），
  // 量完立刻摘掉 —— 不改页面状态、也不进截图（同上面 `.icon-btn[disabled]` 那条的做法）。
  //
  // 判据取真实行的**最小值**：两档的真实行高都可能随内容漂，骨架该对齐的是设计保证的那一档
  // （表格档是 `.table td` 的盒模型 `8+8+1+30 = 47px`；卡片档是每行都有的固定 48px 内容区
  //  + 固定 30/44px 操作行）。⚠️ 这里**不该出现 `--row-h`** —— 那是 V2 的令牌，`public/ui_v1/`
  //  里一处都没有；V1 的表格档绑的是 `.table td`，等式写在 `components.css` 的 `.skeleton__row` 上。
  // `realMin` / `realMax` 都会打进上面那行读数，**那是查「行高有没有漂」的入口**：V1 的末行用
  // `border-bottom-color: transparent` 保住盒模型，所以两个数本来该相等（V2 那边相反，末行真的
  // 会矮 0.5px，故 V2 的探针改用众数）。⚠️ 但这两个数**不进 findings** —— 本探针的判据只有
  // `gap` 与卡片档的 `skPitch`，别把"读数里有"读成"不达标会红"。
  // 第二条判据是**行距**：卡片档的骨架行必须与真实卡片一样相邻（真实卡片是 0 间距 +
  // 1px 分隔线）。只改行高不改 `.skeleton` 的 padding/gap，每行仍差 12px（50 行 600px），
  // 骨架整页照样比真实页短一截。
  const skeletonGeom = await read(`(() => {
    const rows = [...document.querySelectorAll('.table tr.row')];
    if (!rows.length) return JSON.stringify({ skipped: 'no rows' });
    const hs = rows.map((r) => r.getBoundingClientRect().height);
    const probe = document.createElement('div');
    probe.className = 'skeleton';
    probe.setAttribute('role', 'status');
    for (let i = 0; i < 2; i += 1) {
      const inner = document.createElement('div');
      inner.className = 'skeleton__row';
      probe.append(inner);
    }
    (document.querySelector('.results') ?? document.body).append(probe);
    const a = probe.children[0].getBoundingClientRect();
    const b = probe.children[1].getBoundingClientRect();
    const skRow = Math.round(a.height);
    const skPitch = Math.round(b.top - a.top);
    probe.remove();
    return JSON.stringify({
      mode: getComputedStyle(rows[0]).display === 'flex' ? 'card' : 'table',
      viewport: window.innerWidth,
      coarse: matchMedia('(pointer: coarse)').matches,
      rows: rows.length,
      realMin: Math.round(Math.min(...hs)),
      realMax: Math.round(Math.max(...hs)),
      realPitch:
        rows.length > 1
          ? Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top)
          : null,
      skeleton: skRow,
      skPitch,
      gap: Math.round(Math.min(...hs)) - skRow,
    });
  })()`);
  console.log('SKELETON', skeletonGeom);
  {
    // 不达标就进 auditFindings ⇒ 影响退出码（与上面那组几何审计同一个出口）
    const s = JSON.parse(skeletonGeom);
    if (s.skipped) auditFindings.push('skeleton: ' + s.skipped);
    else {
      if (s.gap !== 0) {
        auditFindings.push(
          'skeleton: 骨架行高 ≠ 真实行高（' + s.mode + ' 档 骨架 ' + s.skeleton + ' vs 真实 ' + s.realMin + '，差 ' + s.gap + 'px）',
        );
      }
      // 卡片档还要「相邻」：真实卡片是 0 间距 + 1px 分隔线，骨架的行距必须等于卡片行距。
      // 表格档的 12px 行距是那一档自己的观感选择（骨架＝一列小条），不在本条判据里。
      if (s.mode === 'card' && s.realPitch !== null && s.skPitch !== s.realPitch) {
        auditFindings.push(
          'skeleton: 卡片档骨架行距 ≠ 卡片行距（骨架 ' + s.skPitch + ' vs 卡片 ' + s.realPitch + 'px）',
        );
      }
    }
  }

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

  // ===== 预览关闭即释放正文（2026-09-20，`docs/archive/AUDIT-v1-v2-divergence.md` §4.2）=====
  //
  // 缺陷形态：预览对话框是**启动期创建、常驻 `body`** 的节点，关闭时只 `dialog.close()`，
  // 正文（`<pre>` 里的整条全文）与页脚按钮的闭包一直留在 DOM 里，直到**下次打开预览**才被
  // `replaceChildren` 换掉。用户不再预览第二条 ⇒ 这条记录到页面销毁都不释放。
  //
  // 判据有**两条，各钉一半**（只钉一条会放过一个错解）：
  //   ① 关闭、等退出过渡跑完之后，正文必须是空的 —— 钉"到底有没有释放"；
  //   ② 关闭之后、退出过渡**还在跑**的那一帧里，正文必须还在 —— 钉"释放得是不是时候"。
  // ② 存在的理由：`.dialog` 有 0.3s 的退出过渡（`motion.css` 的 `@starting-style` +
  // `transition-behavior: allow-discrete`），在 `close` 里立刻 `replaceChildren` 的写法**能过 ①**
  // 、但用户会看见"框还在淡出、字先没了"（框的高度也会跟着跳）。量过：点 ✕ 之后
  // `display: block` 持续到 ~400ms 才变 `none`，所以 t+150ms 那一帧确实还在画。
  // ② 自己带着前提：那一帧 `display` 若已经是 `none`（减弱动效 / 不支持 `allow-discrete`），
  // 清得早也看不见，就不该报。
  const previewClose = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('tbody tr.row');
    if (!row) return JSON.stringify({ skipped: 'no rows' });
    const openBtn = row.querySelector('[data-action="preview"]');
    if (!openBtn) return JSON.stringify({ skipped: 'no preview button' });
    openBtn.click();
    await wait(1200);
    const dlg = document.querySelector('dialog.dialog[open]');
    if (!dlg) return JSON.stringify({ skipped: 'preview did not open' });
    const body = dlg.querySelector('.dialog__body');
    const foot = dlg.querySelector('.dialog__foot');
    const snap = () => ({
      kids: body.childElementCount,
      chars: (body.textContent ?? '').length,
      footKids: foot.childElementCount,
      display: getComputedStyle(dlg).display,
    });
    const before = snap();
    const closeBtn = document.querySelector('button[aria-label="关闭预览"]');
    if (!closeBtn) return JSON.stringify({ skipped: 'no close button' });
    closeBtn.click();
    // 退出过渡跑到一半（实测总长 ~0.3s）
    await wait(150);
    const duringFade = snap();
    // 给足余量等过渡结束 + 清理那一帧
    await wait(750);
    const after = snap();
    return JSON.stringify({
      before,
      duringFade,
      after,
      stillOpen: dlg.open,
      hashCleared: location.hash === '',
      bodyTextAfter: (body.textContent ?? '').slice(0, 40),
    });
  })()`);
  console.log('PRVCLOSE', previewClose);
  {
    const p = JSON.parse(previewClose);
    if (p.skipped) auditFindings.push('preview-close: ' + p.skipped);
    else {
      if (p.before.kids === 0) {
        auditFindings.push('preview-close: 打开后正文是空的 ⇒ 这条判据失去了前提（预览没渲染出东西）');
      }
      // ② 「字先没了」：框还在画、正文却已经清空
      if (p.duringFade.display !== 'none' && p.duringFade.kids !== p.before.kids) {
        auditFindings.push(
          'preview-close: 正文在退出过渡期间就被清了（框仍是 ' + p.duringFade.display +
            '、正文 ' + p.duringFade.kids + ' vs 打开时 ' + p.before.kids + '）⇒ 用户会看到"框还在淡出、字先没了"',
        );
      }
      // ① 「没释放」：过渡跑完之后正文/页脚仍在常驻 <dialog> 里
      if (p.after.kids !== 0 || p.after.footKids !== 0) {
        auditFindings.push(
          'preview-close: 关闭后没释放（正文 ' + p.after.kids + ' 个节点 / ' + p.after.chars +
            ' 字符，页脚 ' + p.after.footKids + ' 个）⇒ 整条记录留在常驻 <dialog> 里',
        );
      }
      if (p.stillOpen) auditFindings.push('preview-close: 点 ✕ 之后对话框仍然是打开态');
    }
  }

  // ===== 文本下载（2026-09-18，"文本也可以下载，格式保存成 txt"）=====
  // 判据不是"点了有反应"，而是**磁盘上真的出现了一个 .txt，且内容与这条记录的正文对得上**。
  // 列表里的正文被截断到 500 字符，所以这条探针要在命中一条长文本时跑才有意义：
  //   node test/manual/probe-ui-v1.mjs --url "/ui_v1/?types=Text&search=LLLL"
  // （本机那条 11000 字符的 `Text_….txt` 夹具就是这样命中的。）截断的那条会走"先取全文"，
  // 于是 `bytes` 应当是全文而不是 500 字符。
  //
  // 必须**自己重新导航一次**：前面的 IME 段收尾时会清空搜索（列表回到无筛选状态），
  // 直接点第一行会点到另一条记录 —— 第一版就是这么量错的（拿到 `Text-68C2F5F9.txt` 27 字节，
  // 而那一行根本不是 `search=LLLL` 命中的那条）。
  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, 2500));
  mkdirSync(downloadDir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
  const dlCell = JSON.parse(
    (await read(`(() => {
      const row = document.querySelector('tbody tr.row');
      if (!row) return JSON.stringify({ skipped: 'no rows' });
      const btn = row.querySelector('[data-action="download"]');
      if (!btn) return JSON.stringify({ skipped: 'no download button' });
      const cell = row.querySelector('.cell-content__text')?.textContent ?? '';
      const flags = [...row.querySelectorAll('.cell-content__flags .chip')].map((c) => c.textContent);
      btn.click();
      return JSON.stringify({ cell, flags, label: btn.getAttribute('aria-label') });
    })()`)) ?? '{}',
  );
  let dlFile = null;
  if (!dlCell.skipped) {
    for (let i = 0; i < 60 && !dlFile; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const files = existsSync(downloadDir)
        ? readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload'))
        : [];
      if (files.length > 0) dlFile = files[0];
    }
  }
  const dlText = dlFile ? readFileSync(join(downloadDir, dlFile), 'utf8') : null;
  console.log(
    'TEXTDL  ',
    JSON.stringify({
      skipped: dlCell.skipped ?? null,
      label: dlCell.label ?? null,
      name: dlFile,
      bytes: dlText === null ? null : Buffer.byteLength(dlText, 'utf8'),
      chars: dlText === null ? null : dlText.length,
      headMatchesCell: dlText !== null && dlCell.cell ? dlText.startsWith(dlCell.cell) : null,
      cellChars: (dlCell.cell ?? '').length,
      flags: dlCell.flags ?? null,
    }),
  );

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
  await send('Page.navigate', { url: `${BASE}/ui_v1/?types=File` });
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
      // 「按钮明显不明显」也有计算值可量（2026-09-18 用户要求"明显点"）：旧版（btn--quiet）
      // 边框 0px、背景全透明、颜色是次要色 —— 与紧挨着的说明文字完全同色，读起来不是按钮。
      // 注意：这一段在模板串里，注释里不要再出现反引号（第一版就是这么把外层串闭合掉的）。
      buttonStyle: (() => {
        if (!button) return null;
        const cs = getComputedStyle(button);
        return {
          borderWidth: cs.borderTopWidth,
          borderColor: cs.borderTopColor,
          background: cs.backgroundColor,
          color: cs.color,
          height: Math.round(button.getBoundingClientRect().height),
        };
      })(),
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

  // ===== 范围切换时的工具栏抖动（2026-09-18）=====
  // 用户报告的现象："点回收站之后前面的搜索框会闪一下"。机制是切换**范围**会换掉整份类型计数，
  // 而 `countsForView` 的守卫在新计数到达前把五个 chip 的计数清空 → 分段控件窄 ~99px →
  // 搜索框与 spacer 分走腾出的宽度 → 下一帧再弹回。修法是给计数槽定宽（`.segmented__count` 的 4ch）。
  // 这里把"修好"变成可复算的判据：**前后三帧的宽度差 ≤ 2px**（修前实测 搜索框 50 / 类型组 99）。
  const toolbarShift = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const widthOf = (selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? -1);
    const box = () => ({ search: widthOf('.toolbar__group--search'), types: widthOf('.toolbar__group--types') });
    const recycleButton = [...document.querySelectorAll('.segmented__item')].find((b) => (b.textContent ?? '').includes('回收站'));
    if (!recycleButton) return JSON.stringify({ skipped: '找不到回收站按钮' });

    const before = box();
    recycleButton.click();
    const during = box();   // 同步重绘之后、统计回来之前 —— 也就是"闪"的那一帧
    await wait(80);
    const after80 = box();
    await wait(1500);
    const settled = box();
    // 收尾：再点一次回到原来的范围（后面的步骤默认在活跃列表上跑）
    recycleButton.click();
    await wait(1500);

    // 判据是"**帧与帧之间**有没有大跳"（闪 = 一跳一弹），而不是"末态与初态是否相同"：
    // 切换范围后计数本来就会变（1009 → 2008），宽度随之变几像素是数据变化，不是抖动。
    const step = (key) => {
      const values = [before[key], during[key], after80[key], settled[key]];
      let worst = 0;
      for (let i = 1; i < values.length; i += 1) worst = Math.max(worst, Math.abs(values[i] - values[i - 1]));
      return worst;
    };
    const searchDelta = step('search');
    const typesDelta = step('types');
    // 预算 20px：修前的第一跳是 50（搜索框）/ 99（类型组）；修后只剩"数字位数变化"那几像素。
    const budget = 20;
    return JSON.stringify({
      before, during, after80, settled,
      searchDelta, typesDelta,
      ok: searchDelta <= budget && typesDelta <= budget,
    });
  })()`);
  console.log('TOOLBARSW', toolbarShift);

  // ===== A8 · 顶栏「复制最近一条」（2026-09-18）=====
  // 断言三件事：按钮真的把内容写进了剪贴板（逐字对照第一行的正文）、提示条报了条数、
  // 而且它取的是**全库最新**而不是当前列表的第一行（当前列表此时未被筛选/排序过，两者一致）。
  await send('Page.navigate', { url: `${BASE}/ui_v1/` });
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

    // 批量动作后的「焦点不被抢回」（2026-09-18 修）。`list.restoreFocus()` 会把焦点交给结果区，
    // 它带着一圈 ~0.5s 的重试（用于等浏览器关闭模态后的补焦）。那一圈**不能**把用户自己放好的
    // 焦点抢回来 —— 这条探针量的就是这件事：动作后立刻点搜索框，等过整个重试窗口，焦点还该在
    // 搜索框里。没有这道守卫时，`document.activeElement` 会变成表头的全选框。
    const focusKeep = await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!document.querySelector('tbody tr.row')) return JSON.stringify({ skipped: 'no rows' });
      const search = document.getElementById('search');
      const pick = async () => {
        const box = document.querySelector('tbody tr.row .checkbox');
        if (box && !box.checked) box.click();
        await wait(140);
      };
      const button = (label) =>
        [...document.querySelectorAll('.results__selection button')].find(
          (b) => (b.textContent ?? '').trim() === label,
        );
      await pick();
      const on = button('收藏');
      if (!on) return JSON.stringify({ skipped: 'no 收藏 button' });
      on.click();
      await wait(60); // 请求已发出、restoreFocus 的重试计时器已排上，但还没走完
      search.focus();
      const justFocused = document.activeElement === search;
      await wait(1200); // 覆盖 8×60ms 的重试窗口
      const after = document.activeElement?.id || document.activeElement?.tagName || null;
      // 净零：把收藏切回去，再取消选择（都不改服务端净状态）
      await pick();
      button('取消收藏')?.click();
      await wait(900);
      [...document.querySelectorAll('.results__selection button')]
        .find((b) => (b.textContent ?? '').includes('取消选择'))
        ?.click();
      await wait(300);
      return JSON.stringify({ justFocused, after, keptByUser: after === 'search' });
    })()`);
    console.log('FOCUSKEEP', focusKeep);

    // 置顶（2026-09-18 起列表**恒置顶优先**，见 src/ui/query.ts 的 pinnedFirst）：
    // 这条探针验的不是"按钮按下去了"，而是三件连起来的事 ——
    //   ① 服务端真的落了 pinned=true（否则只是画得对）；
    //   ② 徽标就地出现（不用等下一次整页刷新）；
    //   ③ 这一行真的挪到了置顶组里（按下前在它上面的行，现在全是置顶的），
    //      且收尾按回去之后整表顺序**逐行还原**（排序键是 CreateTime，置顶只改 LastModified）。
    // 取「第一个未置顶、且上面还有行」的那一行：第 1 行本来就在最前，置顶它证明不了"会移动"；
    // 而库里已经有一批置顶记录时，随便取第 4 行会取到**已置顶**的行 —— 那一下是按"取消置顶"，
    // 行会往下走，断言的方向就反了（本机实测：前 13 行都是置顶的）。
    const pinCheck = await read(`(async () => {
      const rows = () => [...document.querySelectorAll('.table tr.row')];
      const order = () => rows().map((r) => r.dataset.key);
      const before = order();
      const isPinned = (r) => r.querySelector('[data-action="pin"]')?.getAttribute('aria-pressed') === 'true';
      // 取**页内最后一个未置顶**的行：位移一眼可见（本机是 50 → 置顶组末尾），
      // 而"第一个未置顶的行"在已经有一批置顶记录时只会挪一两位，证明不了什么。
      const unpinned = rows().filter((r) => r.querySelector('[data-action="pin"]') && !isPinned(r));
      const target = unpinned[unpinned.length - 1];
      if (!target) return JSON.stringify({ skipped: 'every row is pinned' });
      const key = target.dataset.key;
      const find = () => rows().find((r) => r.dataset.key === key) ?? null;
      const button = find()?.querySelector('[data-action="pin"]');
      if (!button) return JSON.stringify({ skipped: 'no pin button' });
      const indexBefore = before.indexOf(key);
      const pinnedBefore = rows().filter(isPinned).length;
      const readServer = async () => {
        const sep = key.indexOf('-');
        const res = await fetch(
          '/ui/api/history/' + encodeURIComponent(key.slice(0, sep)) + '/' + encodeURIComponent(key.slice(sep + 1)),
        );
        const body = await res.json();
        return { status: res.status, pinned: body.pinned, name: body.dataName ?? null };
      };
      button.click();
      await new Promise((r) => setTimeout(r, 1400));
      const afterOrder = order();
      const indexAfter = afterOrder.indexOf(key);
      const current = find();
      const flags = (current?.querySelector('.cell-content__flags')?.textContent ?? '').trim();
      const allAbovePinned = afterOrder.slice(0, Math.max(0, indexAfter)).every((k) => {
        const r = rows().find((x) => x.dataset.key === k);
        return r ? isPinned(r) : false;
      });
      const server = await readServer();
      // 收尾：按回去（净零）。等重新对账完成再读顺序。
      find()?.querySelector('[data-action="pin"]')?.click();
      await new Promise((r) => setTimeout(r, 1400));
      const back = await readServer();
      return JSON.stringify({
        key,
        indexBefore,
        pinnedBefore,
        indexAfter,
        moved: indexBefore - indexAfter,
        movedUp: indexAfter < indexBefore,
        allAbovePinned,
        badge: flags,
        server,
        back,
        orderRestored: order().join('|') === before.join('|'),
      });
    })()`);
    console.log('PIN     ', pinCheck);
  }

  if (SHOTS) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // 01-list 已在 STATE 之后、交互之前拍过（见那里的注释）

    // 回收站：写入路径不碰它（只读），用它验证「已删除行的对比度 + 恢复按钮的禁用理由」
    await send('Page.navigate', { url: `${BASE}/ui_v1/?deleted=1` });
    await wait(2500);
    await runAudit('trash');
    await shot('02-trash');

    // 空状态：用一个不可能命中的搜索词逼出来（不写库、不改数据）
    await send('Page.navigate', { url: `${BASE}/ui_v1/?search=zzz-no-such-record` });
    await wait(2500);
    await runAudit('empty');
    await shot('03-empty');

    // 部署信息：2026-09-18 起并进了顶栏那枚**状态胶囊**（`[● 实时推送 ⓘ]`，整枚可点），
    // 故这里按 aria-label **包含**「部署信息」来找 —— 前缀随状态变（实时推送/正在连接/轮询刷新）。
    await send('Page.navigate', { url: `${BASE}/ui_v1/` });
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

    // 页脚：入口是**本项目的地址**，悬停时向上拉出「致谢」面板，里面是**另外两个**项目。
    // 只能靠真实鼠标移动来验（CDP `Input.dispatchMouseEvent`）——手工加个类或改样式是"我让它展开的"，
    // 验不到 `:hover` 这条真正的路径。先把入口滚进视野（页脚在文档最底部，rect 可能在视口之外），
    // 再派发 mouseMoved，然后**读回来**：面板可见、在入口**上方**、不越出视口、恰好两个链接。
    await send('Page.navigate', { url: `${BASE}/ui_v1/` });
    await wait(2500);
    const footerBox = JSON.parse(
      (await read(`(() => {
        const trigger = document.querySelector('.footer-links__trigger');
        if (!trigger) return JSON.stringify({ skipped: 'no .footer-links__trigger' });
        trigger.scrollIntoView({ block: 'center' });
        const r = trigger.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`)) ?? '{}',
    );
    if (footerBox.skipped) {
      console.log('FOOTER  ', JSON.stringify(footerBox));
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: footerBox.x, y: footerBox.y });
      await wait(500);
      const footerState = await read(`(() => {
        const box = document.querySelector('.footer-links');
        const panel = box?.querySelector('.footer-links__panel');
        const items = [...(panel?.querySelectorAll('.footer-links__item') ?? [])];
        const r = panel?.getBoundingClientRect();
        const triggerRect = box?.querySelector('.footer-links__trigger')?.getBoundingClientRect();
        const inner = document.querySelector('.app-footer__inner')?.getBoundingClientRect();
        const note = document.querySelector('.app-footer__inner > span')?.getBoundingClientRect();
        const cs = panel ? getComputedStyle(panel) : null;
        const overlaps = (a, b) =>
          Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        return JSON.stringify({
          hovered: box?.matches(':hover') ?? null,
          triggerHref: box?.querySelector('.footer-links__trigger')?.getAttribute('href') ?? null,
          // 文案改成项目名之后，**"它会开到哪"只剩 title 这一条通道**（2026-09-18 用户要求补上）：
          // 可访问名仍是可见文字（SyncClipboard CfServer），title 只作描述与悬停提示。
          triggerTitle: box?.querySelector('.footer-links__trigger')?.getAttribute('title') ?? null,
          panelVisible: cs ? cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.9 : null,
          // 面板必须在触发器的**上方**（用户要的"向上拉"）：面板下边缘 ≤ 触发器上边缘
          aboveTrigger: r && triggerRect ? Math.round(r.bottom) <= Math.round(triggerRect.top) : null,
          insideViewport: r ? r.left >= 0 && r.right <= window.innerWidth : null,
          // 面板要**贴着入口**（2026-09-18 用户指出：锚页脚整块时中间空出一条带子）
          gapAboveEntry: r && triggerRect ? Math.round(triggerRect.top - r.bottom) : null,
          // 右缘贴内容盒右缘、左缘不越出内容盒（两者合起来才是"不出视口"）
          panelInsideFooterBox: r && inner ? r.left >= Math.round(inner.left) - 1 && r.right <= Math.round(inner.right) + 1 : null,
          // 隐私说明那行不能被面板压住
          panelOverlapsNote: overlaps(r, note),
          itemCount: items.length,
          links: items.map((a) => a.getAttribute('href')),
        });
      })()`);
      console.log('FOOTER  ', footerState);
      await shot('07-footer-links');
    }

    // 分页区单独一张：窄屏下它曾经折成四行、两个按钮各占一整行（用户 2026-09-18 的截图）。
    // 判据看 `PAGER` 行。**必须先把指针移开**：上一步的悬停还开着致谢面板，它会正好盖住分页区
    // （第一版就是这么拍出一张"看不出问题"的废图）。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
    await wait(400);
    await read(`(() => {
      document.querySelector('.pagination')?.scrollIntoView({ block: 'center' });
      return 'scrolled';
    })()`);
    await wait(400);
    await shot('08-pager');
  }

  console.log('CONSOLE ERRORS', consoleErrors.length ? consoleErrors : 'none');
  console.log('FAILED REQUESTS', failedRequests.length ? failedRequests : 'none');
  console.log('AUDIT SUMMARY', auditFindings.length === 0 ? 'findings=0' : JSON.stringify(auditFindings));
  process.exitCode = auditFindings.length === 0 ? 0 : 1;
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
    rmSync(downloadDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结果 */
  }
}
