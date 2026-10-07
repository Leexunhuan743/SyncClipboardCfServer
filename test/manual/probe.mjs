// 界面运行时探针（手动运行，不属于 npm test 套件）
//
// 为什么需要它：截图只能证明"看起来对"，证明不了"DOM 里的值对"。前端是零构建的、没有组件测试，
// 「概览说 2191、列表说 1009」「抽屉点了没开」这类问题只能靠人肉对着屏幕猜。本脚本用 CDP 读
// **真实页面的真实 DOM 值**，并把一批不变式交给 check() 断言：不达标会打印 AUDIT 失败清单、
// 退出码置 1 —— 否则「读到空数组」与「读到正常值」在终端里长得一样，缺陷不会让它变红。
//
// 用法（需 dev server 已启动）：
//   node test/manual/probe.mjs
//   node test/manual/probe.mjs --url "/ui_v2/app/?deleted=1"
//   node test/manual/probe.mjs --width 390 --touch        ← 触摸模拟：不加上它，(pointer: coarse) 永远不成立
//
// 起浏览器/登录/注入 Cookie/CDP 原语都在 ./cdp.mjs 里（与 shoot / probe-ui-v1 / states 共用）。
// ⚠️ 探针默认是**细指针**：`--width 390` 量到的是「窄窗口桌面」而不是手机。不写明，就会有人把
// 宽度规则"修"回去。
import { launchBrowser, loginAndSetCookie, collectErrors, createRecorder } from './cdp.mjs';

// 判据收集器：只钉不变式，不含会随开发库里记录数漂的绝对条数。
const { problems, check } = createRecorder();

// ── 注入式性能采集：CLS（非输入位移之和，buffered ⇒ 含加载期全部位移）与各阶段高度快照 ──
// fast path 下骨架只存在一帧，且加载期的高度变化只在内存里，必须在页面内埋采集点。
// （本串是模板字面量 ⇒ 注释里不许出现反引号。）
const PERF_HOOK = `(() => {
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
})()`;

// ── 首屏 DOM 读数（默认未筛选列表页）──
const STATE_EXPR = `JSON.stringify({
  booted: document.documentElement.dataset.appBooted ?? null,
  theme: document.documentElement.dataset.theme ?? null,
  h1Count: document.querySelectorAll('h1').length,
  rows: document.querySelectorAll('.item').length,
  boardCount: document.querySelector('.board-head__count')?.textContent ?? null,
  chipAll: document.querySelector('.chip[data-kind="All"] .chip__num')?.textContent ?? null,
  overviewTotal: document.querySelector('.overview__stat .overview__value')?.textContent ?? null,
  overviewTotalLabel: document.querySelector('.overview__stat .overview__label')?.textContent ?? null,
  overviewSize: [...document.querySelectorAll('.overview__stat')].at(-1)?.querySelector('.overview__value')?.textContent ?? null,
  // 类型计数只在筛选条的 chips 上（概览带的类型分布已移除，读 .kinds__item 恒为空数组）。
  kinds: [...document.querySelectorAll('.chip[data-kind]:not([data-kind="All"]) .chip__num')].map((n) =>
    n.textContent.trim(),
  ),
  // 趋势图：条数只证明 DOM 在，**不等于看得见**（曾有"柱都在、可见高度 0"的缺陷），
  // 故连渲染盒一起量：中屏/桌面上它让位（h=0），窄屏独占一行（h>0）。
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
  // ⚠️ 取"第一行"必须按**类**取，不能按 tr:first-of-type：默认排序下 tbody 的第一个 tr 是
  // 分组小标题（.daymark），按 tr 取会恒为空数组（看起来像"行内没有操作按钮"）。
  firstRowOps: [...(document.querySelector('.item')?.querySelectorAll('.rowops .icon-btn') ?? [])].map((b) => b.dataset.icon),
  // 命中区令牌与指针类型：「--control-h-sm」只应随**指针精度**变、不随视口宽度变。
  pointerCoarse: matchMedia('(pointer: coarse)').matches,
  controlHSm: getComputedStyle(document.documentElement).getPropertyValue('--control-h-sm').trim(),
  // 骨架行高 vs 真实行高：注入一行骨架来量（fast path 下骨架只存在一帧，走正常流程量不到）。
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
  // 真实行高取**众数**、不取最小/最大：末行没有下边框（卡片档少 1px、表格档因 border-collapse
  // 只少自己那一半的 0.5px），而内容更长的卡片会被撑高。众数 = 典型的那一档，正是骨架该对齐的。
  rowModeH: (() => {
    const hs = [...document.querySelectorAll('tr.item')].map((n) =>
      Math.round(n.getBoundingClientRect().height),
    );
    if (!hs.length) return null;
    const tally = new Map();
    for (const h of hs) tally.set(h, (tally.get(h) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  })(),
  // 卡片档的判据就是 CSS 里那个媒体查询本身，用它把下面两条判据的期望值分成两档。
  cardMode: matchMedia('(max-width: 720px)').matches,
  // 骨架之间的节奏：ui/ghost.js 建的是 div.board > div.ghost…，真实卡片之间由 tbody 的
  // gap: var(--sp-2) 分开。按原样搭一份「包裹层 + 两行骨架」再量（真实骨架只存在一帧）。
  // 量的是**两行之间的实际间距**、不是包裹层总高：包裹层自己是 .board，表格档带 1px 边框，
  // 总高会混进与间距无关的量。
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
  // 概览带的值占位与真实值的高度：两者不同高时，数据落地会把**下面的内容**推下去 —— 那件事只在
  // 窄屏才越过 CLS 预算，CLS 那条判据抓不到它在宽屏的形态，所以按几何直接钉。
  // 占位高度靠**克隆一个 .overview__value 再塞一个 .overview__ghost** 量：直接把 ghost 挂到
  // body 上会继承 body 的字号，量出来的不是它的真实高度。
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
  // 横向溢出的**肇事者**：上面那个标量只说「有没有溢出」，定位还得逐元素量右边缘；而
  // html/body 的 overflow-x: clip 只影响绘制与滚动、**不改变布局盒**，所以 getBoundingClientRect
  // 在被 clip 掩着时也看得见肇事者。取最靠右的前 5 个，附标签名与类名。
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
})`;

// 读点放在**首屏刚落地、探针还没开始交互**的位置：再往后探针自己会点按钮、切筛选，读完会混进
// "当前视图"的高度（实测读到 rows:0 / daymarks:[]）。
const PERF_EXPR = `JSON.stringify({
  cls: Math.round((window.__probePerf ? window.__probePerf.cls : -1) * 1e4) / 1e4,
  clsAtLoad: window.__probePerf && window.__probePerf.clsAtLoad !== undefined
    ? Math.round(window.__probePerf.clsAtLoad * 1e4) / 1e4 : null,
  shifts: window.__probePerf ? window.__probePerf.shifts : null,
  marks: window.__probePerf ? window.__probePerf.marks : null,
  rows: document.querySelectorAll('.item').length,
  footerTop: document.querySelector('.footer') ? Math.round(document.querySelector('.footer').getBoundingClientRect().top) : null,
})`;

const DRAWER_EXPR = `JSON.stringify({
  open: document.querySelector('.drawer')?.open ?? null,
  sections: [...document.querySelectorAll('.section__title')].map((n) => n.textContent),
  retentionHints: [...document.querySelectorAll('.drawer input[type="number"]')].map((n) => n.placeholder),
  retentionNote: document.querySelector('.drawer [id="retention-status"]')?.textContent ?? null,
  bars: document.querySelectorAll('.drawer .bar').length,
  copyline: document.querySelector('.copyline__text')?.textContent ?? null,
})`;

// 关闭预览：两条判据各钉一半（只钉一条会放过一个错解）——
//   ① 退出过渡跑完后正文与页脚必须为空 ⇒ 钉"到底有没有释放"：对话框是常驻 body 的节点，
//      不在关闭时清空的话，整条记录（文本全文可达 api.js 的响应上限）留到页面销毁；
//   ② 退出过渡**还在跑**的那一帧正文必须还在 ⇒ 钉"释放得是不是时候"：.dialog 有 0.2s 的退出
//      过渡，在 close 里立刻清空能过 ①，但会看见"框还在淡出、字先没了"（框高也跟着跳）。
// ② 自带前提：那一帧若已是 display: none（减弱动效 / 不支持 allow-discrete），清得早也看不见。
const PREVIEW_CLOSE_EXPR = `(async () => {
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
})()`;

// 空状态：用一个不可能命中的搜索词逼出来，不写库。
const EMPTY_EXPR = `JSON.stringify({
  blank: document.querySelector('.blank')?.dataset.kind ?? null,
  title: document.querySelector('.blank__title')?.textContent ?? null,
  actions: [...document.querySelectorAll('.blank__actions .btn')].map((b) => b.textContent),
})`;

// 命令行（默认值即验收口径：BASE/USER/PASS/PORT/WIDTH/HEIGHT/URL_PATH/SETTLE）
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const URL_PATH = arg('url', '/ui_v2/app/');
const PORT = Number(arg('port', '9341'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SETTLE = Number(arg('settle', '4500'));
// 触摸模拟：不加它，(pointer: coarse) 在无头浏览器里恒为假。
const TOUCH = process.argv.includes('--touch');

const { cdp, send, read, close } = await launchBrowser({
  port: PORT,
  width: WIDTH,
  height: HEIGHT,
  touch: TOUCH,
});
try {
  const { consoleErrors, failedRequests } = collectErrors(cdp);
  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });

  // 首屏性能读数：把「A-02 那族数」从历史读数变成每次都能复核的读数 —— 加载期的位移总量，
  // 以及各阶段的高度快照（`.board-area` 的 min-height: 70vh 为何存在）。
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PERF_HOOK });

  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, SETTLE));

  const state = await read(STATE_EXPR);
  console.log('STATE  ', state);
  const perf = JSON.parse(await read(PERF_EXPR));
  console.log('PERF   ', JSON.stringify(perf));

  // 首帧（JS 未跑）页脚已在折线以下 —— min-height: 70vh 的契约
  const preJs = (perf.marks ?? []).find((m) => m.why === 'interactive');
  check(
    '首屏 CLS 没退化（判据取 0.1 = "good" 阈值，其职责是抓回归）',
    (perf.clsAtLoad ?? perf.cls) >= 0 && (perf.clsAtLoad ?? perf.cls) <= 0.1,
    'clsAtLoad=' + String(perf.clsAtLoad) + ' cls=' + String(perf.cls) + ' shifts=' + JSON.stringify(perf.shifts),
  );
  check(
    '首帧（JS 未跑）页脚已在折线以下 —— min-height: 70vh 的契约',
    preJs === undefined || preJs.footerTop === null || preJs.footerTop >= preJs.innerH,
    JSON.stringify(preJs),
  );

  // 打开抽屉（概览带整条是按钮）
  await read(`document.getElementById('overview').dispatchEvent(new MouseEvent('click', { bubbles: true })), 'clicked'`);
  await new Promise((r) => setTimeout(r, 900));
  const drawer = await read(DRAWER_EXPR);
  console.log('DRAWER ', drawer);
  await read(`document.querySelector('.drawer')?.close(), 'closed'`);

  const previewClose = await read(PREVIEW_CLOSE_EXPR);
  console.log('PRVCLOSE', previewClose);

  // 空状态（用一个不可能命中的搜索词逼出来，不写库）
  await send('Page.navigate', { url: `${BASE}${URL_PATH}?search=zzz-none-zzz` });
  await new Promise((r) => setTimeout(r, 2500));
  const empty = await read(EMPTY_EXPR);
  console.log('EMPTY  ', empty);

  // ===== 判据 =====
  // ⚠️ 下面这几条描述的是**默认（未筛选）列表页**的形态：把 --url 指到带 search 的页面上，
  // 「列表渲染出了行」「看板标题带上了同一个数字」等几条会红 —— 那不是误报，而是"没落在探针
  // 认识的那个视图上"。
  const S = JSON.parse(state);
  const D = JSON.parse(drawer);
  const E = JSON.parse(empty);

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

  // 命中区按**指针精度**、不按视口宽度。28 / 44 取自 `tokens-v2.css` 的两个令牌值
  // （--control-h-sm: 28px / --hit-min: 44px）；窄屏与宽屏必须给同一个答案。
  // 探针默认细指针（⇒ 28px），--touch 才模拟粗指针（⇒ 44px）。
  check(
    '小控件命中区只随指针精度变（细指针 28px / 粗指针 44px）',
    S.controlHSm === (S.pointerCoarse ? '44px' : '28px'),
    String(S.controlHSm) + ' / coarse=' + String(S.pointerCoarse),
  );

  // 骨架行高必须等于真实行的**典型**行高（表格档与卡片档都成立）。
  check(
    '骨架行高 = 真实行的典型行高（表格档与卡片档都成立）',
    S.ghostH === S.rowModeH,
    '骨架 ' + String(S.ghostH) + ' vs 真实众数 ' + String(S.rowModeH),
  );

  // 骨架**之间**的间距：卡片档每两张卡片之间是 --sp-2（8px），骨架之间也必须有；表格档的行与
  // 行之间本来就没有间距（各行的下边框就是分隔）。缺这条时 50 行骨架比真实页短 8×49 = 392px，
  // 正是 ui/ghost.js 在意的「整页高度突变」。
  check(
    '骨架之间的间距 = 卡片之间的间距（卡片档 --sp-2 / 表格档 0）',
    S.ghostWrap.between === (S.cardMode ? 8 : 0),
    '两行之间 ' + String(S.ghostWrap.between) + 'px（期望 ' + String(S.cardMode ? 8 : 0) +
      '）；卡片档=' + String(S.cardMode) + '；gap=' + String(S.ghostWrap.gap),
  );

  // 概览带的值占位必须与真实值**同一个行盒** —— 与上面两条骨架判据同源（占位 ≠ 真实 ⇒ 推挤）。
  // 容差 0.5px：两边同源，但行盒可能被取整。
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

  // 预览关闭即释放正文与页脚
  // ⚠️ 这条判据描述的是**默认列表页里的第一行**：--url 指到空结果页时读不到行 ⇒ 会红
  // （那不是误报，而是"没落在探针认识的那个视图上"，与上面那组 STATE 判据同一个口径）。
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
  close();
}
