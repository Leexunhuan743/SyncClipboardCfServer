// 界面运行时探针（手动运行，不属于 npm test 套件）
//
// 为什么需要它：截图只能证明"看起来对"，证明不了"DOM 里的值对"。这个仓库的前端是零构建的，
// 没有组件测试，于是「概览说 2191、列表说 1009」「抽屉点了没开」这类问题
// 只能靠人肉对着屏幕猜。本脚本用 CDP 读**真实页面的真实 DOM 值**，把它们打出来。
//
// 用法（需 dev server 已启动）：
//   node test/manual/probe.mjs
//   node test/manual/probe.mjs --url "/ui_v2/app/?deleted=1"
//   node test/manual/probe.mjs --width 390 --touch        ← 触摸模拟：不加上它，(pointer: coarse) 永远不成立
//
// 与 shoot.mjs 的关系：两者共用同一套 CDP 起浏览器/登录/注入 Cookie 的做法，
// 但目的不同 —— shoot 出图（给人看），probe 出值（给断言看）。
//
// 2026-09-19 起：probe 不只打印，还在文件末尾用 check() **自己断言一批不变式**（审计 §3 F-3）；
// 不达标会打印一行 AUDIT 失败清单并把退出码置 1 —— 此前「探针读到空数组」与「读到 1009」
// 在终端里长得一样，任何缺陷都不会让它变红。
// 同日晚（审计 F-5）：新增 `--touch`（`Emulation.setTouchEmulationEnabled`）与
// `--control-h-sm` / `(pointer: coarse)` 两个读数（外加一条判据）。**探针默认是细指针** ——
// `--width 390` 量到的是「窄窗口桌面」而不是手机；这一条不写明，就会有人把宽度规则"修"回去。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const URL_PATH = arg('url', '/ui_v2/app/');
const PORT = Number(arg('port', '9341'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SETTLE = Number(arg('settle', '4500'));
// 触摸模拟（审计 F-5）：没有它，`(pointer: coarse)` 在无头浏览器里恒为假。
const TOUCH = process.argv.includes('--touch');

// ===== 判据的收集器（2026-09-19 补，审计 §3 F-3）=====
// 只钉不变式：不含会随开发库里记录数漂的绝对条数（审计当时读到 1009，本轮已变）。
const problems = [];
function check(name, ok, detail) {
  if (ok) return;
  problems.push(detail === undefined || detail === '' ? name : name + '（读到 ' + detail + '）');
}

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

const profileDir = join(tmpdir(), `probe-profile-${process.pid}`);
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
    browserWs.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  cdp = new Cdp(browserWs);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  if (TOUCH) {
    // 触摸模拟：只有开了它，`(pointer: coarse)` 才成立 —— 无头浏览器默认恒为细指针，
    // 390px 下量到的是“窄窗口桌面”而不是手机（审计 F-5 的根因）。
    // ⚠️ 只开触摸模拟、**不**动 `Emulation.setDeviceMetricsOverride`：后者（`mobile: true`）
    // 会换掉视口语义，实测同一份页面在 390px 下会多出一个与命中区无关的横向溢出读数
    // —— 那样两个模式就不可比了。视口继续由 `--window-size` 决定。
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  // 真实登录接口 → 服务端签发的会话 Cookie（不是伪造已登录状态）
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

  // 收集控制台错误与失败请求：页面"看起来对但其实是坏的"最常见的两种形态
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
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(`${msg.params?.type} ${msg.params?.errorText}`);
    }
    if (msg.method === 'Network.responseReceived' && (msg.params?.response?.status ?? 200) >= 400) {
      failedRequests.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
  });

  // 首屏性能读数（2026-09-20 补）：把「A-02 那族数」（804→4454 / CLS 0.90）从**历史读数**变成
  // **每次都能复核**的读数。两件事：
  //  · cls   = layout-shift 的**非输入**位移之和（buffered ⇒ 含本页加载期全部位移）
  //  · marks = 加载各阶段的高度快照 ⇒ 把 `.board-area`「首帧就要把页脚推到折线以下」这条
  //            契约（`min-height: 70vh` 的**存在理由**）变成可判定的断言
  // ⚠️ 注入串里**不许出现反引号**（模板字面量，N-14 形态；2026-09-20 在 probe-ui-v1.mjs 上踩过）。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const P = { cls: 0, shifts: [], marks: [] };
      window.__probePerf = P;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            P.cls += e.value;
            if (P.shifts.length < 6) {
              P.shifts.push({
                v: Math.round(e.value * 1e5) / 1e5,
                src: (e.sources || []).slice(0, 3).map((s) => (s.node ? (s.node.className || s.node.tagName) : '?') + ''),
              });
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (e) { P.err = String(e); }
      const snap = (why) => {
        const f = document.querySelector('.footer');
        P.marks.push({
          why: why,
          ready: document.readyState,
          t: Math.round(performance.now()),
          docH: document.documentElement ? document.documentElement.scrollHeight : null,
          innerH: window.innerHeight,
          footerTop: f ? Math.round(f.getBoundingClientRect().top) : null,
          ghost: document.querySelectorAll('.ghost').length,
        });
      };
      snap('pre-doc');
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') {
          snap('interactive');
          requestAnimationFrame(() => snap('rAF1'));
        }
      });
      document.addEventListener('DOMContentLoaded', () => snap('DCL'));
      window.addEventListener('load', () => {
        snap('load');
        setTimeout(() => snap('load+300'), 300);
        setTimeout(() => { P.clsAtLoad = P.cls; snap('load+1500'); }, 1500);
      });
    })()`,
  });

  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, SETTLE));

  const read = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(
        `${d.text ?? 'Uncaught'} :: ${d.exception?.description ?? JSON.stringify(d).slice(0, 400)}`,
      );
    }
    return result.result.value;
  };

  const state = await read(`JSON.stringify({
    booted: document.documentElement.dataset.appBooted ?? null,
    theme: document.documentElement.dataset.theme ?? null,
    h1Count: document.querySelectorAll('h1').length,
    rows: document.querySelectorAll('.item').length,
    boardCount: document.querySelector('.board-head__count')?.textContent ?? null,
    chipAll: document.querySelector('.chip[data-kind="All"] .chip__num')?.textContent ?? null,
    overviewTotal: document.querySelector('.overview__stat .overview__value')?.textContent ?? null,
    overviewTotalLabel: document.querySelector('.overview__stat .overview__label')?.textContent ?? null,
    overviewSize: [...document.querySelectorAll('.overview__stat')].at(-1)?.querySelector('.overview__value')?.textContent ?? null,
    // 类型计数在筛选条的 chips 上：chipAll 只取「全部」那一枚，这里把四个类型也读出来。
    // （本块是模板字符串，注释里不许出现反引号。）此前读 .kinds__item —— 那个类没有生产者
    // （概览带的类型分布 2026-09-15 起已移除，见 ui_v2/js/ui/overview.js:64-68），
    // 字段恒为空数组、且没有被断言，属"探针在空转"。
    kinds: [...document.querySelectorAll('.chip[data-kind]:not([data-kind="All"]) .chip__num')].map((n) =>
      n.textContent.trim(),
    ),
    // 趋势图：条数只证明 DOM 在，**不等于看得见** —— 2026-09-18 的缺陷正是
    // "14 根柱都在、可见高度 0"（基础规则的 .main > .overview 前缀压过了窄屏那档媒体查询）。
    // 故把渲染盒一起量出来：中屏/桌面上它应当让位（h=0），窄屏应当独占一行（h>0）。
    sparkBars: document.querySelectorAll('.overview__spark rect').length,
    sparkBox: (() => {
      const box = document.querySelector('.overview__spark')?.getBoundingClientRect();
      return box ? { w: Math.round(box.width), h: Math.round(box.height) } : null;
    })(),
    syncState: document.querySelector('.sync')?.dataset.state ?? null,
    syncLabel: document.querySelector('.sync__label')?.textContent ?? null,
    noticeHidden: document.getElementById('notice')?.hidden ?? null,
    daymarks: [...document.querySelectorAll('.daymark')].map((n) => n.textContent.trim()),
    firstRowKind: document.querySelector('.item__kind')?.dataset.type ?? null,
    firstRowMeta: document.querySelector('.entry__meta')?.textContent ?? null,
    // ⚠️ 取"第一行"必须按**类**取，不能按 tr:first-of-type：默认排序（createTime）下
    // tbody 的第一个 tr 是**分组小标题**（.daymark），tr:first-of-type 命中的是它 ⇒
    // 这一项会恒为空数组（看起来像"行内没有操作按钮"，实测 2026-09-18）。
    firstRowOps: [...(document.querySelector('.item')?.querySelectorAll('.rowops .icon-btn') ?? [])].map((b) => b.dataset.icon),
    // 命中区令牌与指针类型（审计 F-5）：「--control-h-sm」只应随**指针精度**变、不随视口宽度变。
    // （本块是模板字符串 ⇒ 注释里不许出现反引号。）
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    controlHSm: getComputedStyle(document.documentElement).getPropertyValue('--control-h-sm').trim(),
    // 骨架行高 vs 真实行高（2026-09-19 修 N-16）。注入一行骨架来量：fast path 下
    // 骨架只存在一帧，走正常流程量不到。
    // 判据取真实行的**下限**而不是第一行：两档的真实行高都由「内容」决定，而内容随数据变
    // （表格档由 --row-h 定高、卡片档由缩略图与文本行数撑开），骨架不该跟着内容猜；
    // 唯一由设计保证的是下限 —— 表格档是 height: var(--row-h) 那条，卡片档是每个真实行
    // 都有的固定尺寸缩略图（row.js 的 renderEntry 无条件建它）。
    // （本块是模板字符串 ⇒ 注释里不许出现反引号。）
    ghostH: (() => {
      const probe = document.createElement('div');
      probe.className = 'ghost';
      probe.innerHTML = '<span class="ghost__bar ghost__bar--kind"></span>'
        + '<span class="ghost__bar ghost__bar--wide"></span>'
        + '<span class="ghost__bar ghost__bar--short"></span>';
      document.body.append(probe);
      const h = Math.round(probe.getBoundingClientRect().height);
      probe.remove();
      return h;
    })(),
    // 取**众数**而不是最小/最大：实测三个组合里真实行的分布各有一个离群值 ——
    // 最小的那张是**末行**（末行没有下边框），而「少掉多少」**随模式不同**：
    //   · 卡片档（≤720px）：行不再是表格行，下边框是**整条 1px** ⇒ 125 → 124；
    //   · 表格档（>720px）：board-v2.css 的 .board__table 用了 border-collapse: collapse，
    //     那条分隔线由相邻两行**各担一半**、末行只少自己那一半 ⇒ 77 → 76.5。
    //     （同一条账也在 .ghost 的等式里：表格档 +1px = 两个 0.5 之和。）
    // 最大的那张是**内容更长**的卡片（卡片档行高由内容撑开，见 board-v2.css 的推导）。
    // 众数 = 「典型的那一档」，也正是骨架该对齐的那一档。
    // ⚠️ 本块是模板字符串，注释里**不许出现反引号**（会提前终止模板，N-14 形态）。
    rowModeH: (() => {
      const hs = [...document.querySelectorAll('tr.item')].map((n) =>
        Math.round(n.getBoundingClientRect().height),
      );
      if (!hs.length) return null;
      const tally = new Map();
      for (const h of hs) tally.set(h, (tally.get(h) ?? 0) + 1);
      return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    })(),
    // 卡片档的判据就是 CSS 里那个媒体查询本身（board-v2.css 的 @media (max-width: 720px)），
    // 用它把下面两条判据的期望值分成两档。
    cardMode: matchMedia('(max-width: 720px)').matches,
    // 骨架的**包裹层节奏**（N-16 的第二半）：ui/ghost.js 建的是 div.board > div.ghost…，
    // 而真实卡片之间由 .board__table tbody 的 gap: var(--sp-2) 分开。这里按原样搭一份
    // 「包裹层 + 两行骨架」再量 —— 真实骨架只在 fast path 的一帧里存在，量不到。
    // （本块是模板字符串 ⇒ 注释里不许出现反引号。）
    // 量的是**两行之间的实际间距**（第二行的上边缘 − 第一行的下边缘），不是包裹层的总高：
    // 包裹层自己是 .board，表格档那条基础规则带 1px 边框，总高会混进 2px 与间距无关的量
    // （第一版判据就踩了这个：实测 156 而期望 154）。
    ghostWrap: (() => {
      const wrap = document.createElement('div');
      wrap.className = 'board';
      wrap.innerHTML = '<div class="ghost"></div><div class="ghost"></div>';
      document.body.append(wrap);
      const cs = getComputedStyle(wrap);
      const rects = [...wrap.children].map((n) => n.getBoundingClientRect());
      const out = {
        display: cs.display,
        gap: cs.rowGap,
        between: rects.length === 2 ? Math.round(rects[1].top - rects[0].bottom) : null,
      };
      wrap.remove();
      return out;
    })(),
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // 概览带的值占位与真实值的高度（2026-09-22 补）。
    // 为什么必须在这里量：占位与真实不同高时，数据落地会把**下面的内容**推下去 —— 而那件事
    // 只在"概览带占视口比例大"的窄屏才越过 CLS 预算（390 档 0.1217 vs 1440 档 0.0026），
    // 所以 CLS 那条判据抓不到它在宽屏的表现，这条按几何直接钉。
    // 占位高度靠**克隆一个 .overview__value 再塞一个 .overview__ghost** 量：直接把 ghost 挂到
    // body 上会继承 body 的字号（16px）而不是 --fs-title（17px），量出来的不是它的真实高度。
    // （本段在模板字符串里，注释中不能出现反引号。）
    overviewGhostH: (() => {
      const value = document.querySelector('.overview__value');
      if (!value || !value.parentElement) return null;
      const clone = value.cloneNode(false);
      const probe = document.createElement('span');
      probe.className = 'overview__ghost';
      clone.append(probe);
      value.parentElement.append(clone);
      const h = Math.round(probe.getBoundingClientRect().height * 100) / 100;
      clone.remove();
      return h;
    })(),
    overviewValueH: (() => {
      const value = document.querySelector('.overview__value');
      return value ? Math.round(value.getBoundingClientRect().height * 100) / 100 : null;
    })(),
    // 横向溢出的**肇事者**：上面那个标量只说「有没有溢出」，定位还得逐元素量右边缘；
    // 而 html/body 的 overflow-x: clip（base-v2.css:17/32）只影响绘制与滚动、**不改变布局盒**，
    // 所以 getBoundingClientRect 即使在被 clip 掩着时也看得见肇事者 —— 这正是 V1 探针一直有、
    // 而 V2 缺的那条证据（审计 §12.16）。取最靠右的前 5 个，附标签名与类名。
    // （本段在模板字符串里，注释中不能出现反引号。）
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
  })`);
  console.log('STATE  ', state);

  // ── 首屏性能：CLS 与加载各阶段高度（A-02 那族数的**可复核**版本）──
  // 读点放在**首屏刚落地、探针还没开始交互**的位置：再往后探针自己会点按钮、切筛选，
  // 那些位移多为 `hadRecentInput`（已排除），但读在末尾会混进"当前视图"的高度 —— 实测踩过：
  // 放在末尾时读到 `rows:0 / daymarks:[]`（那一刻页面已被切到别的状态）。
  const perf = JSON.parse(
    await read(`JSON.stringify({
      cls: Math.round((window.__probePerf ? window.__probePerf.cls : -1) * 1e4) / 1e4,
      clsAtLoad: window.__probePerf && window.__probePerf.clsAtLoad !== undefined
        ? Math.round(window.__probePerf.clsAtLoad * 1e4) / 1e4 : null,
      shifts: window.__probePerf ? window.__probePerf.shifts : null,
      marks: window.__probePerf ? window.__probePerf.marks : null,
      docH: document.documentElement.scrollHeight,
      rows: document.querySelectorAll('.item').length,
      rowH: document.querySelector('.item') ? Math.round(document.querySelector('.item').getBoundingClientRect().height) : null,
      listH: (() => { const t = document.querySelector('.board__table tbody') || document.querySelector('.board'); return t ? Math.round(t.getBoundingClientRect().height) : null; })(),
      daymarks: [...document.querySelectorAll('.daymark')].map((d) => Math.round(d.getBoundingClientRect().height)),
      footerTop: document.querySelector('.footer') ? Math.round(document.querySelector('.footer').getBoundingClientRect().top) : null,
    })`),
  );
  console.log('PERF    ', JSON.stringify(perf));
  const preJs = (perf.marks ?? []).find((m) => m.why === 'interactive');
  check(
    '首屏 CLS 没退化（判据取 0.1 = "good" 阈值，其职责是抓回归：修前那两条是 0.85 / 0.93）',
    (perf.clsAtLoad ?? perf.cls) >= 0 && (perf.clsAtLoad ?? perf.cls) <= 0.1,
    'clsAtLoad=' + String(perf.clsAtLoad) + ' cls=' + String(perf.cls) + ' shifts=' + JSON.stringify(perf.shifts),
  );
  check(
    '首帧（JS 未跑）页脚已在折线以下 —— min-height: 70vh 的契约',
    preJs === undefined || preJs.footerTop === null || preJs.footerTop >= preJs.innerH,
    JSON.stringify(preJs),
  );

  // 打开抽屉（概览带整条是按钮）
  await read(
    `document.getElementById('overview').dispatchEvent(new MouseEvent('click', { bubbles: true })), 'clicked'`,
  );
  await new Promise((r) => setTimeout(r, 900));
  const drawer = await read(`JSON.stringify({
    open: document.querySelector('.drawer')?.open ?? null,
    sections: [...document.querySelectorAll('.section__title')].map((n) => n.textContent),
    retentionDays: document.querySelector('.drawer input[type="number"]')?.value ?? null,
    retentionCount: document.querySelectorAll('.drawer input[type="number"]')[1]?.value ?? null,
    retentionHints: [...document.querySelectorAll('.drawer input[type="number"]')].map((n) => n.placeholder),
    retentionNote: document.querySelector('.drawer [id="retention-status"]')?.textContent ?? null,
    facts: [...document.querySelectorAll('.drawer .fact')].map((f) => f.textContent.trim()).slice(0, 10),
    bars: document.querySelectorAll('.drawer .bar').length,
    copyline: document.querySelector('.copyline__text')?.textContent ?? null,
  })`);
  console.log('DRAWER ', drawer);
  await read(`document.querySelector('.drawer')?.close(), 'closed'`);

  // ===== 预览关闭即释放正文（2026-09-20，`docs/archive/AUDIT-v1-v2-divergence.md` §4.2）=====
  //
  // 缺陷形态：对话框是**启动期创建、常驻 `body`** 的节点（`ui/dialog.js` 里 `createDialog`
  // 一进来就 `document.body.append(dialog)`），关闭时只 `dialog.close()`，正文与页脚一直留在
  // DOM 里，直到**下次 `open()`** 才被 `clear(body)` 换掉。用户不再预览第二条 ⇒ 整条记录
  // （文本全文可达 `api.js` 的响应上限）到页面销毁都不释放。
  //
  // 两条判据各钉一半（只钉一条会放过一个错解）：
  //   ① 关闭、等退出过渡跑完之后，正文与页脚必须是空的 —— 钉"到底有没有释放"；
  //   ② 关闭之后、退出过渡**还在跑**的那一帧里正文必须还在 —— 钉"释放得是不是时候"。
  // ② 的理由：`.dialog` 有 0.2s 的退出过渡（`overlay-v2.css` 的 `@starting-style` +
  // `transition-behavior: allow-discrete`），在 `close` 里立刻 `clear(body)` 的写法**能过 ①**
  // 、但用户会看见"框还在淡出、字先没了"（框高也会跟着跳）。量过：点「关闭」之后
  // `display: block` 持续到 ~250ms 才变 `none`，所以 t+150ms 那一帧确实还在画。
  // ② 自带前提：那一帧若已经是 `display: none`（减弱动效 / 不支持 `allow-discrete`），
  // 清得早也看不见，不该报。
  const previewClose = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('tbody tr.item');
    if (!row) return JSON.stringify({ skipped: 'no rows' });
    const openBtn = row.querySelector('[data-action="preview"]');
    if (!openBtn) return JSON.stringify({ skipped: 'no preview button' });
    openBtn.click();
    await wait(1400);
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
    const closeBtn = dlg.querySelector('.dialog__close');
    if (!closeBtn) return JSON.stringify({ skipped: 'no close button' });
    closeBtn.click();
    await wait(150);
    const duringFade = snap();
    await wait(750);
    const after = snap();
    return JSON.stringify({
      before,
      duringFade,
      after,
      stillOpen: dlg.open,
      hashCleared: location.hash === '',
    });
  })()`);
  console.log('PRVCLOSE', previewClose);

  // 空状态（用一个不可能命中的搜索词逼出来，不写库）
  await send('Page.navigate', { url: `${BASE}${URL_PATH}?search=zzz-none-zzz` });
  await new Promise((r) => setTimeout(r, 2500));
  const empty = await read(`JSON.stringify({
    blank: document.querySelector('.blank')?.dataset.kind ?? null,
    title: document.querySelector('.blank__title')?.textContent ?? null,
    actions: [...document.querySelectorAll('.blank__actions .btn')].map((b) => b.textContent),
  })`);
  console.log('EMPTY  ', empty);

  // ===== 判据（2026-09-19 补，F-3）=====
  // 这一层只钉**不变式** —— 不钉会随开发库里记录数漂的绝对条数（审计当时读到 1009，本轮已变）。
  // 目的是把「探针读到空数组」和「探针读到 1009」在终端里区分开：前者现在会让退出码变成 1。
  const S = JSON.parse(state);
  const D = JSON.parse(drawer);
  const E = JSON.parse(empty);

  // ⚠️ 下面这几条描述的是**默认（未筛选）列表页**的形态：把 --url 指到带 search 的页面上，
  //    「列表渲染出了行」「看板标题带上了同一个数字」等几条会红 —— 那不是误报，而是
  //    "没落在探针认识的那个视图上"（§94.9 就是用这个办法证明这些判据真的会红）。
  // 页面真的起来了
  check('应用已启动（dataset.appBooted）', S.booted === '1', S.booted);
  check('只有一个 h1', S.h1Count === 1, S.h1Count);
  check('列表渲染出了行', S.rows > 0, S.rows);
  check('分组标题在位', S.daymarks.length > 0, JSON.stringify(S.daymarks));
  check('首行类型已归一化成枚举名', typeof S.firstRowKind === 'string' && S.firstRowKind !== '', JSON.stringify(S.firstRowKind));
  check('首行有操作按钮', S.firstRowOps.length > 0, JSON.stringify(S.firstRowOps));
  check('提示条初始隐藏', S.noticeHidden === true, String(S.noticeHidden));
  check('推送通道处于实时态', S.syncState === 'live', String(S.syncState));

  // 计数口径互相自洽：四个类型芯片之和 ==「全部」芯片 == 概览总数 == 看板标题里那个数。
  const kindNums = S.kinds.map(Number);
  check('四个类型芯片都读到了计数', S.kinds.length === 4 && kindNums.every((n) => Number.isInteger(n) && n >= 0), JSON.stringify(S.kinds));
  check('「全部」芯片有计数', typeof S.chipAll === 'string' && /^\d+$/.test(S.chipAll), JSON.stringify(S.chipAll));
  check('四个类型之和 ==「全部」', kindNums.reduce((a, b) => a + b, 0) === Number(S.chipAll), S.kinds.join('+') + ' = ' + S.chipAll);
  check('概览总数 ==「全部」芯片', S.overviewTotal === S.chipAll, String(S.overviewTotal) + ' vs ' + S.chipAll);
  check('看板标题带上了同一个数字', typeof S.boardCount === 'string' && S.boardCount.startsWith(String(S.chipAll)), JSON.stringify(S.boardCount));

  // 横向溢出：**逐元素几何证据**才算数 —— 上面那个标量在 overflow-x: clip 下可能被抹平（见注释）
  check('没有元素越出视口右缘（布局几何证据）', S.overflowers.length === 0, JSON.stringify(S.overflowers));

  // 命中区按**指针精度**、不按视口宽度（审计 F-5）。28 / 44 取自 `tokens-v2.css:175-176` 的两个
  // 令牌值（`--control-h-sm: 28px` / `--hit-min: 44px`）；窄屏与宽屏必须给同一个答案。
  // 探针默认细指针（⇒ 28px），`--touch` 才模拟粗指针（⇒ 44px）。
  check(
    '小控件命中区只随指针精度变（细指针 28px / 粗指针 44px）',
    S.controlHSm === (S.pointerCoarse ? '44px' : '28px'),
    String(S.controlHSm) + ' / coarse=' + String(S.pointerCoarse),
  );

  // 骨架行高必须等于真实行的**典型**行高（审计 N-16 / §94 第 13 行）。
  // 修前卡片档（≤720px）是 77 vs 125（细指针）/ 135（粗指针）—— 每行差 48 / 58px，
  // 而三处注释（board-v2.css、ui/ghost.js、ui/board.js）都只写了"表格档同高、卡模式不适用"。
  // 表格档（>720px）本来就成立，故这一条在四个组合里都该是绿的。
  check(
    '骨架行高 = 真实行的典型行高（表格档与卡片档都成立）',
    S.ghostH === S.rowModeH,
    '骨架 ' + String(S.ghostH) + ' vs 真实众数 ' + String(S.rowModeH),
  );

  // N-16 的第二半：骨架**之间**的间距。卡片档每两张卡片之间是 --sp-2（8px），骨架之间也
  // 必须有；表格档的行与行之间本来就没有间距（各行的下边框就是分隔）。缺这条时 50 行骨架
  // 比真实页短 8×49 = 392px，正是 ui/ghost.js 文件头在意的「整页高度突变」。
  check(
    '骨架之间的间距 = 卡片之间的间距（卡片档 --sp-2 / 表格档 0）',
    S.ghostWrap.between === (S.cardMode ? 8 : 0),
    '两行之间 ' + String(S.ghostWrap.between) + 'px（期望 ' + String(S.cardMode ? 8 : 0) +
      '）；卡片档=' + String(S.cardMode) + '；gap=' + String(S.ghostWrap.gap),
  );

  // 概览带的值占位必须与真实值**同一个行盒** —— 与上面两条骨架判据同源（占位 ≠ 真实 ⇒ 推挤）。
  // 2026-09-22 实测（390×844）：ghost 是 `0.7em`（12px）而真实值是 `17 × 1.05 = 17.85px`，
  // 数据落地时每格长高 6px、概览带整体高 32px，把 omnibox 与看板推下去 ⇒ 首屏 CLS **0.1217**
  // （越过 0.1 预算）。1440 档量到 0.0026 —— 所以 CLS 那条判据**抓不到**它在宽屏的形态，
  // 这条按几何直接钉，四个组合里都该绿。容差 0.5px：两边同源，但行盒可能被取整。
  check(
    '概览带的值占位与真实值同高（数据落地不再推挤下面的内容）',
    S.overviewGhostH !== null &&
      S.overviewValueH !== null &&
      Math.abs(S.overviewGhostH - S.overviewValueH) <= 0.5,
    '占位 ' + String(S.overviewGhostH) + ' vs 真实 ' + String(S.overviewValueH),
  );

  // 抽屉
  check('概览带能点开抽屉', D.open === true, String(D.open));
  check('抽屉的七个分区都在', D.sections.length === 7, JSON.stringify(D.sections));
  check('保留策略两个输入框都带生效值提示', D.retentionHints.length === 2 && D.retentionHints.every((h) => /^当前 \d+$/.test(h)), JSON.stringify(D.retentionHints));
  check('保留策略的来源说明非空', typeof D.retentionNote === 'string' && D.retentionNote.includes('来源'), JSON.stringify(D.retentionNote));
  check('抽屉趋势柱数 == 概览趋势柱数', D.bars === S.sparkBars, String(D.bars) + ' vs ' + String(S.sparkBars));
  check('抽屉里给出了本服务地址', typeof D.copyline === 'string' && D.copyline.startsWith(BASE), JSON.stringify(D.copyline));

  // 预览关闭即释放正文与页脚（`docs/archive/AUDIT-v1-v2-divergence.md` §4.2，2026-09-20）
  // ⚠️ 这条判据描述的是**默认列表页里的第一行**：`--url` 指到空结果页时读不到行 ⇒ 会红
  //   （那不是误报，而是"没落在探针认识的那个视图上"，与上面那组 STATE 判据同一个口径）。
  const P = JSON.parse(previewClose);
  if (P.skipped) {
    check('预览关闭前后能读到对话框（判据前提）', false, String(P.skipped));
  } else {
    check('预览打开后正文非空（判据前提）', P.before.kids > 0, '正文 ' + String(P.before.kids) + ' 个节点');
    check(
      '关闭预览后释放正文与页脚（不留整条记录在常驻 <dialog> 里）',
      P.after.kids === 0 && P.after.footKids === 0,
      '正文 ' + String(P.after.kids) + ' 个节点 / ' + String(P.after.chars) + ' 字符，页脚 ' +
        String(P.after.footKids) + ' 个',
    );
    check(
      '退出过渡期间正文仍在（不做"框还在淡出、字先没了"）',
      P.duringFade.display === 'none' || P.duringFade.kids === P.before.kids,
      '框仍是 ' + String(P.duringFade.display) + ' 时正文已变成 ' + String(P.duringFade.kids) +
        ' 个节点（打开时 ' + String(P.before.kids) + '）',
    );
    check('关闭预览后对话框确实关掉了', P.stillOpen === false, String(P.stillOpen));
  }

  // 空状态
  check('搜索无结果时落到「筛选」空状态', E.blank === 'filter', String(E.blank));
  check('空状态有标题', typeof E.title === 'string' && E.title !== '', JSON.stringify(E.title));
  check('空状态给了下一步按钮', E.actions.length > 0, JSON.stringify(E.actions));

  console.log('CONSOLE ERRORS', consoleErrors.length ? consoleErrors : 'none');
  console.log('FAILED REQUESTS', failedRequests.length ? failedRequests : 'none');
  check('控制台没有错误', consoleErrors.length === 0, JSON.stringify(consoleErrors));
  check('没有失败请求', failedRequests.length === 0, JSON.stringify(failedRequests));

  console.log('AUDIT   ', problems.length === 0 ? 'problems=0' : JSON.stringify(problems));
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
    /* 临时目录清不掉不影响结果 */
  }
}
