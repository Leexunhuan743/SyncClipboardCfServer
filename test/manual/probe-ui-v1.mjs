// V1（`/ui_v1/`）界面的运行时探针（手动运行，不属于 npm test 套件）。
// V1 是在维护的默认界面（`public/ui_v1/README`），截图只能证明"看起来对"，
// 证明不了"计算值对" —— 本文件读真实 DOM 值，CDP 原语共用 `./cdp.mjs`。
//
// 用法（需 dev server 已启动）：
//   node test/manual/probe-ui-v1.mjs
//   node test/manual/probe-ui-v1.mjs --width 390 --height 844
//   node test/manual/probe-ui-v1.mjs --width 1024 --coarse   # 触屏模拟（COARSE 行会报媒体查询是否真匹配）
//   node test/manual/probe-ui-v1.mjs --dark
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectErrors, createRecorder, launchBrowser, loginAndSetCookie } from './cdp.mjs';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8787');
// 默认流程会真实写入再清理 PROBE-* 记录：必须在起浏览器、登录和任何请求之前拦住非本机目标，
// 免得把探针误指线上实例。
const targetHost = new URL(BASE).hostname;
const localTargets = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
if (!localTargets.has(targetHost) && process.env.ALLOW_REMOTE_TARGET !== '1') {
  throw new Error(`V1 探针会写入/删除历史记录，拒绝非本机目标：${BASE}（确认是可丢弃实例后用 ALLOW_REMOTE_TARGET=1 放行）`);
}
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const URL_PATH = arg('url', '/ui_v1/');
const PORT = Number(arg('port', '9343'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SETTLE = Number(arg('settle', '4000'));
const DARK = process.argv.includes('--dark');
// 登录页在已登录时会立刻跳走（login.js 的 session 探测）⇒ 看登录页必须用未登录身份打开。
const ANONYMOUS = process.argv.includes('--anonymous');
// `--shots <dir>`：额外把若干**真实状态**截成 PNG（与 shoot.mjs 的分工：shoot 只出图、probe 出值）。
const SHOTS = arg('shots', null);
// 默认流程的 SAVE 检查就会创建一条 PROBE-* 文本记录，再软删并彻底删除（清理失败会判红）。
// `--write` **额外**走收藏/置顶开关的往返写路径（状态净零）。两者都只应指向可写的本地测试实例。
const WRITE = process.argv.includes('--write');
// `--coarse`：模拟触屏（`pointer: coarse`）。行内操作那一排的命中区与间距只在粗指针下才变，
// 「下载紧挨着删除」这类误触只能在这一档量到。
const COARSE = process.argv.includes('--coarse');

// 判据与几何审计合并进同一个数组，末尾那处 `process.exitCode` 才是判据的唯一出口。
const { problems: auditFindings, check } = createRecorder();
// 「跳过」与「通过」必须分得开：每个块都可能因**前提不满足**而 `return { skipped: ... }`，
// 这里把打印出来的每个 `"skipped"` 记下来，末尾统一判 —— 只有环境/数据前提允许跳过，
// 其余（比如选择器与实现不同源）一律算判据失效 ⇒ 进 findings。
const skips = [];
const origLog = console.log;
console.log = (...args) => {
  const raw = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  for (const m of raw.matchAll(/"skipped":\s*"([^"]*)"/g)) skips.push(m[1]);
  origLog(...args);
};
// 允许跳过的前提（**只能往里加"数据/环境本来就如此"的理由**，不能往里加"找不到元素"）：
const SKIP_IS_PRECONDITION = [
  /coarse pointer/, // 触屏构件对触屏有意不挂监听
  /every row is pinned/, // 库里每一行都已置顶 ⇒ 没有"未置顶的行"可测
  /not enough rows/,
  /no rows in switched view/,
  /少于两行/, // 批量复制需要两行
  /not Text/, // 第一行不是文本记录 ⇒ 编辑路径不适用
  /no star button/, // 该行没有收藏开关（回收站视图）
  /no pin button/,
  /no 收藏 button/, // 每行都已收藏
  /no download button/, // 该行无数据文件 ⇒ 没有下载按钮
  /no sticky chain/, // 卡片档没有吸顶表头 ⇒ "不被吸顶链挡住"这条判据不适用
];

// 文本下载的落点（`TEXTDL` 一行要读回磁盘上的那个 .txt）。
const downloadDir = join(tmpdir(), `probe-ui-old-dl-${process.pid}`);
const { cdp, send, read, close } = await launchBrowser({
  port: PORT,
  width: WIDTH,
  height: HEIGHT,
  touch: COARSE,
});
const { consoleErrors, failedRequests } = collectErrors(cdp);
try {
  // 真实输入的派发：细指针用鼠标；`--coarse` 下 Chrome headless 的触屏模拟会让
  // `Input.dispatchMouseEvent` **永久挂起**（CDP 30s 超时，切回 `Input.dispatchTouchEvent` 即恢复）
  // —— 粗指针本来就该用轻点：一次 touchStart + touchEnd，浏览器会合成兼容的 click。
  const tapAt = async (x, y) => {
    if (COARSE) {
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }],
      });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return;
    }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
  };
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    // `mobile: true` 是必需的：Chrome 的 `(pointer: coarse)` 跟的是设备模拟里的"主指针"，
    // 只开 touch 事件时不匹配。**不**随 `--coarse` 改视口语义之外的东西（那会引入无关的水平溢出）。
    mobile: COARSE,
  });
  if (COARSE) await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

  if (!ANONYMOUS) await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });

  // ===== 首帧主题脚本的时序 =====
  // `theme-init.js` 是 `<head>` 里位于样式表之后的经典阻塞脚本，它那句
  // `getComputedStyle(documentElement).getPropertyValue('--bg')` 到底取不取得到值，静态判不了。
  // 这里**不改源码**地观测两笔：① 包装 `getComputedStyle` 记下每次调用时看到的 `--bg`；
  // ② 监听 `meta[name=theme-color]` 的 `content` 首次写入的时刻（`readyState` + 已加载样式表数）。
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

  // 首屏性能读数：cls = layout-shift 的**非输入**位移之和（buffered ⇒ 含本页加载期全部位移）；
  // marks = 加载各阶段的高度快照（docH / 页脚位置 / 骨架行数 / readyState）。
  // ⚠️ 注入串里不许出现反引号（模板字面量），一个反引号就会把它提前结束。
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
        const f = document.querySelector('.app-footer');
        const h = (sel) => {
          const n = document.querySelector(sel);
          return n ? Math.round(n.getBoundingClientRect().height) : null;
        };
        const mount = document.querySelector('#results-mount');
        P.marks.push({
          why: why,
          ready: document.readyState,
          t: Math.round(performance.now()),
          docH: document.documentElement ? document.documentElement.scrollHeight : null,
          innerH: window.innerHeight,
          footerTop: f ? Math.round(f.getBoundingClientRect().top) : null,
          skeleton: document.querySelectorAll('.skeleton__row').length,
          headerH: h('.app-header'),
          statsH: h('.stats'),
          toolbarH: h('.toolbar'),
          mountTop: mount ? Math.round(mount.getBoundingClientRect().top) : null,
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

  // 对比度按 sRGB 相对亮度算（WCAG 2.x），小字必须 ≥ 4.5:1。
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
    // 表头**格子**相对表头**行**的位移：sticky 生效时格子被顶离行盒，而布局高度不变
    // ⇒ 表头灰底会压在第一行数据上，只量行高永远量不出来。
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
    // 徽标对比度直接读令牌：列表当前页不一定同时出现四种类型，而判据要对四个都成立。
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
      // **逐行**高度：只量第一行是抽样，而"所有行等高"是集合上的不变式。
      rowHeights: [...new Set(rows.map((r) => +r.getBoundingClientRect().height.toFixed(1)))].sort(
        (a, b) => a - b,
      ),
      rowHeightsFirst5: rows.slice(0, 5).map((r) => +r.getBoundingClientRect().height.toFixed(1)),
      // 比"众数"高的行是哪几条、高在哪（缩略图/换行/徽标都会撑高，得知道是哪一类行）。
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
      // 活动趋势（借自 V2 的 /ui/api/activity）：柱子数与高度分布。
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
      // 工具栏每一组的位置与宽度：溢出与"挤成几行"都只能从这些盒子看出来。
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
      // 必须是 0：不为 0 说明表头被 sticky 顶离了它自己的行盒（视觉上压住相邻行）。
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
      // 或盖住相邻列，两种都不报错，只能靠量。取一行按钮最多的（图片行：4 个）。
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
      // 缺席断言：提示条已随改名一起移除，恒为 true，谁加回来就变 false。
      // ⚠️ 本条注释里不能出现反引号：整段是模板字面量。
      noticeBarRemoved: q('.notice-bar') === null,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // 吸顶元素必须**不透明**：吸顶意味着它盖在滚过的内容上，透明底会让下面的行透出来
      // （头栏改成恒吸顶后底色仍只在选中态 ⇒ 未选中时是一块透明玻璃）。只有计算色能看见这件事。
      stickyBg: ['.results__head', '.table th']
        .map((sel) => {
          const el = document.querySelector(sel);
          return el ? { sel, bg: getComputedStyle(el).backgroundColor } : null;
        })
        .filter(Boolean),
      // 横向溢出的**肇事者**：scrollWidth > clientWidth 只说"有溢出"，定位还得逐元素量右边缘。
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

  // ===== 吸顶元素必须**不透明** =====
  // 几何审计只比矩形关系、行高判据只看布局、`ui-guard` 只看模块图 —— 只有**计算色**能看见
  // "透不透"。头栏与表头两条都要查，缺一条就漏一半。
  {
    const s = JSON.parse(state);
    const bg = s.stickyBg ?? [];
    const seeThrough = bg.filter(
      (x) => x.bg === 'transparent' || /^rgba?\([^)]*,\s*0(\.0*)?\)$/.test(String(x.bg).replace(/\s+/g, ' ')),
    );
    check(
      '吸顶的头栏与表头都有不透明底色（否则滚过的行会透出来）',
      bg.length === 2 && seeThrough.length === 0,
      JSON.stringify(bg),
    );
  }

  // ── 首屏性能：CLS 与加载各阶段高度（把「连续重载 CLS 全 0」那条变成判据）──
  const perf = JSON.parse(
    await read(`JSON.stringify({
      cls: Math.round((window.__probePerf ? window.__probePerf.cls : -1) * 1e4) / 1e4,
      clsAtLoad: window.__probePerf && window.__probePerf.clsAtLoad !== undefined
        ? Math.round(window.__probePerf.clsAtLoad * 1e4) / 1e4 : null,
      shifts: window.__probePerf ? window.__probePerf.shifts : null,
      marks: window.__probePerf ? window.__probePerf.marks : null,
      docH: document.documentElement.scrollHeight,
      rows: document.querySelectorAll('.table tr.row').length,
      rowH: document.querySelector('.table tr.row') ? Math.round(document.querySelector('.table tr.row').getBoundingClientRect().height) : null,
      listH: document.querySelector('.table') ? Math.round(document.querySelector('.table').getBoundingClientRect().height) : null,
      footerTop: document.querySelector('.footer') ? Math.round(document.querySelector('.footer').getBoundingClientRect().top) : null,
    })`),
  );
  console.log('PERF    ', JSON.stringify(perf));
  const preJs = (perf.marks ?? []).find((m) => m.why === 'interactive');
  check(
    '首屏 CLS 没退化（0.1 = "good" 阈值）',
    (perf.clsAtLoad ?? perf.cls) >= 0 && (perf.clsAtLoad ?? perf.cls) <= 0.1,
    'clsAtLoad=' + String(perf.clsAtLoad) + ' cls=' + String(perf.cls) + ' shifts=' + JSON.stringify(perf.shifts),
  );
  check(
    '首帧（JS 未跑）页脚已在折线以下 —— #results-mount 的 min-height 契约',
    preJs === undefined || preJs.footerTop === null || preJs.footerTop >= preJs.innerH,
    JSON.stringify(preJs),
  );

  // ===== 静止即静止：到达并停住 =====
  // 判据是 `document.getAnimations()` 里没有还在跑的动画；例外只有在用持续动效编码"正在做"的
  // 推送通道旋转环（骨架屏只在首屏未就绪时存在）。
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
  // `firstBgSeen` = `getComputedStyle` 被第一次调用时看到的 `--bg`（即 theme-init 看到的值）；
  // 判据：首次写入发生在 `readyState === 'loading'` 且写入值 ≠ HTML 静态值 ⇒ theme-init 取值成功。
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

  // ===== 运行期：先写 `data-theme` 再读计算值是否会读到旧值 =====
  // **非破坏性**：同一个同步块里设属性 → 读数 → 立刻还原 `data-theme` 与 `theme-color`，
  // 中间态不渲染，后续读数不受影响。
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

  // ===== 顶栏那枚「部署信息」胶囊：四个字**不许断开** =====
  // 胶囊是 flex 项，顶栏一挤就按比例被压，而中文没有词边界 ⇒ 没有 nowrap 时会折成两行并溢出。
  // 量四件事：① `labelLines` 数**文字的行盒**（`getClientRects()` 在 flex 里被块化，只有 1 个盒子，
  // 必须用 Range 取文本矩形）；② 胶囊自身的宽高；③ 顶栏内容超出的量（超出部分被
  // `html { overflow-x: clip }` 裁掉，屏幕上"看不见"但东西真的没了）；④ 最右控件还在不在视口里。
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

  // ===== 工具栏：「每页条数 + 刷新」这一组 =====
  // ① 每页条数在窄屏还看得见；② 两件在**同一组/同一行**；③ 整组贴行尾（`margin-left: auto`）：
  // `gapToRight` 应为 0；放不下时整组落到下一行，那时 `sameRowAsFilters` 为 false 但 gap 仍应为 0。
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
      // 七枚 chip 的**文字都要在**、类型五枚的**计数也要在**、每枚都有 aria-label、
      // 且类型那排**不溢出**（放不下时换行）。
      chips: [...document.querySelectorAll('.toolbar .segmented__item')].map((b) => {
        // 文字那一段是**无类名**的 span（toolbar.js 用 el('span', {text})），故按"不是计数的那个"来认。
        const labelSpan =
          b.querySelector('.segmented__label') ??
          [...b.children].find((c) => c.tagName === 'SPAN' && !c.classList.contains('segmented__count')) ??
          null;
        const count = b.querySelector('.segmented__count');
        const vis = (n) => Boolean(n) && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
        return {
          aria: b.getAttribute('aria-label'),
          labelShown: vis(labelSpan),
          countShown: vis(count),
          pressed: b.getAttribute('aria-pressed'),
        };
      }),
      typesGroup: (() => {
        const g = toolbar?.querySelector('.toolbar__group--types');
        if (!g) return null;
        const chips = [...g.querySelectorAll('.segmented__item')];
        const right = Math.max(...chips.map((c) => c.getBoundingClientRect().right));
        return {
          overflows: g.scrollWidth > g.clientWidth + 1,
          rightOver: Math.round(right - g.getBoundingClientRect().right),
        };
      })(),
    });
  })()`);
  console.log('PAGERBAR', pagerBar);
  {
    const p = JSON.parse(pagerBar);
    const narrow = WIDTH <= 560;
    const chips = p.chips ?? [];
    const types = chips.slice(0, 5);
    const views = chips.slice(5);
    // 定形结论：**这一行不折叠任何文字** —— 类型五枚保留图标 + 文字 + 计数，两枚视图 chip
    // 也保留文字；放不下时换行（下面那条溢出判据）。
    check(
      '七个 chip 的文字都显示（这一行不折字：折了两枚视图 chip 会在行中间留一个大洞）',
      chips.length === 7 && chips.every((c) => c.labelShown === true),
      JSON.stringify(chips.map((c) => ({ aria: c.aria, labelShown: c.labelShown }))),
    );
    check(
      '类型 chip 的计数也显示（数字是"有几条"的唯一可见来源）',
      types.length === 5 && types.every((c) => c.countShown === true),
      JSON.stringify(types.map((c) => c.countShown)),
    );
    check(
      '类型 chip 的 aria-label 与计数同源（形如"文本 631"）',
      types.length === 5 && types.every((c) => /^(全部|文本|图片|文件|组合)( [0-9]+)?$/.test(c.aria ?? '')),
      JSON.stringify(types.map((c) => c.aria)),
    );
    // 两枚视图 chip **不另挂 aria-label**：文字本来就显示着，再挂一个不同的名字会违反
    // "可见标签必须包含在可访问名里"。它们的说明在 `title` 上。
    check(
      '视图 chip（收藏 / 回收站）的名字就是它的可见文字（不另挂 aria-label）',
      views.length === 2 && views.every((c) => c.labelShown === true && (c.aria ?? '') === ''),
      JSON.stringify(views.map((c) => ({ labelShown: c.labelShown, aria: c.aria }))),
    );
    check(
      narrow ? '窄屏：类型那排**换行**而不是被裁掉（不溢出工具栏右缘）' : '宽屏：类型那排不溢出',
      p.typesGroup?.overflows === false,
      JSON.stringify(p.typesGroup),
    );
  }

  // ===== 行内操作这一排的命中区 =====
  // 44px 命中区之间只要重叠或贴太近，「下载」与「删除」就会互相误触。量五件事：
  // 媒体查询是否真匹配（不匹配则这次证据无效）、这一排的 rest 不透明度、按钮实际尺寸、
  // 相邻按钮的**中心距**（≥44 才不重叠）、最宽一行（4 个按钮）是否还在单元格里。
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
  // （`.icon-btn[disabled]` 曾带 `pointer-events: none`）。临时节点读计算值，读完立刻摘掉。
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

  // ===== 分页在窄屏的行结构 =====
  // 判据是"控件之间的**行关系**"而不是"看着行不行"：范围文本允许独占一行（它长），
  // 但「上一页 / 第 X/Y 页 / 下一页」必须**同一行**（窄屏那条 `width: 100%` 曾把页码标签撑成整行）。
  const pager = await read(`(() => {
    const nav = document.querySelector('.pagination');
    if (!nav) return JSON.stringify({ skipped: 'no .pagination' });
    const rectOf = (node) => (node ? node.getBoundingClientRect() : null);
    const buttons = [...nav.querySelectorAll('button')];
    const range = rectOf(nav.querySelector('.pagination__range'));
    const label = rectOf(nav.querySelector('.pagination__page'));
    const prev = rectOf(buttons.find((b) => (b.textContent ?? '').includes('上一页')));
    const next = rectOf(buttons.find((b) => (b.textContent ?? '').includes('下一页')));
    // 判据是竖直投影是否重叠，**不是"top 相等"**：容器是 align-items center，
    // 36px 的按钮与 18px 的文字天然差 9px（拿 top 比会写出假阴性）。
    const sameLine = (a, b) => (a && b ? a.bottom > b.top + 1 && b.bottom > a.top + 1 : null);
    const tops = [range, prev, label, next].filter(Boolean).map((r) => Math.round(r.top));
    return JSON.stringify({
      // rows（去重后的 top 个数）**不能**当作行数：同一行上居中对齐的控件 top 各不相同。
      rangeAloneOnFirstLine: range && prev ? !sameLine(range, prev) : null,
      prevLabelSameLine: sameLine(prev, label),
      labelNextSameLine: sameLine(label, next),
      rangeOwnLine: range && prev ? Math.round(range.top) < Math.round(prev.top) : null,
      // 控制组要**靠右**：最后一个**可见**子元素的右缘与容器右缘的差值应≈0（窄屏换行到第二行同样成立）。
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

  // 首屏截图必须在**任何交互之前**拍：下面几段会真的点复选框、按方向键、往搜索框打字，
  // 而 IME 那段收尾会把页码重置回 1 —— 否则截图与 STATE 数值互相矛盾。
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
  // **布局指标全对、只有像素不对**的缺陷（sticky 位移、绝对定位跑出容器、相邻行压在一起）
  // 在"高度"里完全看不出来，必须逐元素比**矩形之间的包含与重叠关系**。判据都是集合上的不变式。
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
  // 每次审计结果累计进 `auditFindings`，末尾统一决定退出码（只打印的话人工不逐行看就发现不了）。
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

  // ===== 骨架行高 = 真实行高 =====
  //
  // V1 的骨架行高有**两档**，两档都要求等于真实行高（推导在 `components.css` 的 `.skeleton__row`）：
  //   · 表格档（>860px）绑定 `.table td` 盒模型 —— 8+8+1+30 = 47px；
  //   · 卡片档（≤860px）绑定 `.table tr.row` 盒模型 —— 实测 103px（细指针）/ 117px（粗指针）。
  // 骨架与真实行不同高，内容落地时折线以上的东西就会位移，它就从「CLS 的解法」变成来源。
  //
  // ⚠️ 骨架在 fast path 下只存在一帧 ⇒ 就地造一份**真的** `.skeleton` 放进 `.results`
  // （与真实那一份同一个父元素、同一套 CSS），量完立刻摘掉 —— 不改页面状态、也不进截图。
  // 判据取真实行的**最小值**（骨架该对齐的是设计保证的那一档）。⚠️ 这里**不该出现 `--row-h`**：
  // 那是 V2 的令牌。`realMin` / `realMax` 只打进读数、**不进 findings**。
  // 第二条判据是**行距**：卡片档骨架必须与真实卡片一样相邻（只改行高不改 padding/gap 仍差 12px）。
  const skeletonGeom = await read(`(() => {
    const rows = [...document.querySelectorAll('.table tr.row')];
    if (!rows.length) return JSON.stringify({ skipped: 'no rows' });
    const hs = rows.map((r) => r.getBoundingClientRect().height);
    // 「设计保证的那一档」= **没有徽标**的普通卡片行：带徽标且内容格 ≤360px 时是另一档，
    // 而骨架画不了"哪一行带徽标"，拿全体最小值当基准是数据相关的假阳性。
    const plain = rows.filter((r) => r.querySelector('.cell-content__flags .chip') === null);
    const plainHs = plain.map((r) => r.getBoundingClientRect().height);
    const plainPitch =
      plain.length > 1
        ? Math.round(plain[1].getBoundingClientRect().top - plain[0].getBoundingClientRect().top)
        : null;
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
      plainRows: plain.length,
      baseMin: plainHs.length > 0 ? Math.round(Math.min(...plainHs)) : Math.round(Math.min(...hs)),
      realPitch: plainPitch,
      skeleton: skRow,
      skPitch,
      gap: (plainHs.length > 0 ? Math.round(Math.min(...plainHs)) : Math.round(Math.min(...hs))) - skRow,
    });
  })()`);
  console.log('SKELETON', skeletonGeom);
  {
    const s = JSON.parse(skeletonGeom);
    if (s.skipped) auditFindings.push('skeleton: ' + s.skipped);
    else {
      if (s.gap !== 0) {
        auditFindings.push(
          'skeleton: 骨架行高 ≠ 真实行高（' + s.mode + ' 档 骨架 ' + s.skeleton + ' vs 真实 ' + s.realMin + '，差 ' + s.gap + 'px）',
        );
      }
      // 卡片档还要「相邻」：真实卡片是 0 间距 + 1px 分隔线，骨架行距必须等于卡片行距。
      // 表格档的 12px 行距是那一档自己的观感选择，不在本条判据里。
      if (s.mode === 'card' && s.realPitch === null) {
        // 一屏里没有"无徽标"的卡片行可比 ⇒ 取不到基准，记一条已跳过而不是判红（否则是假阳性）。
        console.log('[skip] skeleton: 没有无徽标的卡片行可作基准（plainRows=' + s.plainRows + '）');
      }
      if (s.mode === 'card' && s.realPitch !== null && s.skPitch !== s.realPitch) {
        auditFindings.push(
          'skeleton: 卡片档骨架行距 ≠ 卡片行距（骨架 ' + s.skPitch + ' vs 卡片 ' + s.realPitch + 'px）',
        );
      }
    }
  }

  // 选择条的开合：勾选第一行 → 读条 → 取消选择 → 再读条。
  // `.results__selection` 的 CSS 写了 `display: flex`，而 JS 用 `hidden` 关它 —— 没有 `[hidden]`
  // 守卫时，取消选择后「已选 N 条 + 批量按钮」会**留在页面上**。
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

  // 选中态的两条**行体**交互：① 选区非空时点行体 = 切换该行选中（不开预览）；
  // ② Shift+点击 = 范围选择（锚点与复选框共用 `anchorIndex`，范围与已有选区取并集）。
  // 这两条坏了的表现是"点了没反应"或"预览弹出来了"，都不会让别的测量变红（上面的 SELECTION
  // 走的是复选框，覆盖不到行体这条路）⇒ 判据进 auditFindings。
  const selectModes = await read(`(async () => {
    // 前面几段可能留下文字选区或开着的对话框：行体点击在"正在划选文字"时会**有意**不动作，
    // 而模态框会挡住点击 —— 先归零，这一段测的才是它自己那两条语义。
    window.getSelection()?.removeAllRanges();
    document.querySelector('dialog[open]')?.close();
    const rows = [...document.querySelectorAll('.table tr.row')];
    if (rows.length < 4) return JSON.stringify({ skipped: 'not enough rows' });
    const bodyOf = (row) => row.querySelector('.cell-content__text') ?? row.querySelector('.cell-content') ?? row;
    const checked = () => rows.filter((r) => r.querySelector('input.checkbox')?.checked).length;
    const countText = () => (document.querySelector('.results__selection-count')?.textContent ?? '').trim();
    const wait = () => new Promise((r) => setTimeout(r, 120));
    const click = (node, shift = false) => node.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift }));

    rows[0].querySelector('input.checkbox').click(); // 复选框那条路（锚点也落在这里）
    await wait();
    const afterCheckbox = { checked: checked(), count: countText() };

    click(bodyOf(rows[1])); // ① 选区非空 ⇒ 切换第 1 行选中，且**不开**预览
    await wait();
    const afterRowClick = { checked: checked(), count: countText(), dialogOpen: !!document.querySelector('dialog[open]') };

    click(bodyOf(rows[3]), true); // ② Shift+点 ⇒ 锚点(1)..3 全选，并集后应为 4
    await wait();
    const afterShift = { checked: checked(), count: countText() };

    // ③ mousedown 上的掐断（只在"选中态 + Shift + 落在行体"时）：原生 Shift+click 会扩展**文字选择**，
    //    那一下必须被 preventDefault；而**普通**按下要放行 —— 拖动划选文字复制那条路不能堵。
    const downEvent = (shift) =>
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: shift });
    const shiftDown = downEvent(true);
    bodyOf(rows[1]).dispatchEvent(shiftDown);
    const plainDown = downEvent(false);
    bodyOf(rows[1]).dispatchEvent(plainDown);
    const mousedown = { shiftPrevented: shiftDown.defaultPrevented, plainPrevented: plainDown.defaultPrevented };

    const clear = [...document.querySelectorAll('.results__selection button')].find((b) => b.textContent.includes('取消选择'));
    clear?.click();
    await wait();
    const afterClear = { checked: checked(), count: countText() };
    return JSON.stringify({ rows: rows.length, afterCheckbox, afterRowClick, afterShift, mousedown, afterClear });
  })()`);
  console.log('SELMODE ', selectModes);
  {
    const s = JSON.parse(selectModes);
    if (s.skipped) console.log('SELMODE  skipped:', s.skipped);
    else {
      if (s.afterCheckbox.checked !== 1) auditFindings.push('select: 复选框没有选中一行（checked=' + s.afterCheckbox.checked + '）');
      if (s.afterRowClick.checked !== 2) {
        auditFindings.push('select: 选区非空时点行体没有切换该行选中（checked=' + s.afterRowClick.checked + '）');
      }
      if (s.afterRowClick.dialogOpen) {
        auditFindings.push('select: 选区非空时点行体把预览打开了（应当只切换选中）');
      }
      if (s.afterShift.checked !== 4) {
        auditFindings.push('select: Shift+点击没有范围选中（期望 4 行，checked=' + s.afterShift.checked + '）');
      }
      if (!s.mousedown.shiftPrevented) {
        auditFindings.push('select: 选中态 Shift+按下行体没有被 preventDefault（原生会扩展文字选择）');
      }
      if (s.mousedown.plainPrevented) {
        auditFindings.push('select: 普通按下行体被 preventDefault 了（拖动划选文字复制那条路被堵）');
      }
      if (s.afterClear.checked !== 0) {
        auditFindings.push('select: 「取消选择」没有清空选区（checked=' + s.afterClear.checked + '）');
      }
    }
  }

  // 浏览器后退也必须走筛选的成员资格规则：旧实现从回收站后退时选区仍有 1 条，活跃列表却没有任何
  // 勾选行，批量操作因此指向看不见的记录（ADR D38）。
  const popSelection = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (ready) => {
      for (let i = 0; i < 50; i += 1) {
        if (ready()) return true;
        await wait(100);
      }
      return false;
    };
    const original = location.search;
    const view = document.querySelector('.toolbar button[title^="回收站"]');
    if (!view) return JSON.stringify({ error: 'no recycle view button' });
    view.click();
    const switched = await until(() => location.search !== original && !document.querySelector('.table')?.hidden);
    const checkbox = document.querySelector('tbody tr.row input.checkbox');
    if (!switched || !checkbox) {
      history.back();
      await until(() => location.search === original);
      return JSON.stringify({ skipped: 'no rows in switched view' });
    }
    checkbox.click();
    const before = document.querySelector('.results__selection-count')?.textContent?.trim() ?? '';
    history.back();
    const restored = await until(() => location.search === original && !document.querySelector('.table')?.hidden);
    return JSON.stringify({
      before,
      restored,
      selectionHidden: document.querySelector('.results__selection')?.hidden,
      selectedChecked: document.querySelectorAll('tbody input.checkbox:checked').length,
    });
  })()`);
  console.log('POPSEL   ', popSelection);
  {
    const result = JSON.parse(popSelection);
    if (result.skipped) console.log('POPSEL   skipped:', result.skipped);
    else check(
      '后退恢复筛选时清空不再属于当前视图的选择',
      result.before.includes('已选 1 条') && result.restored === true &&
        result.selectionHidden === true && result.selectedChecked === 0,
      popSelection,
    );
  }

  // 行间方向键：焦点放在第 1 行的「预览」上，按 ↓ 后应当落在第 2 行的**同一个**控件上。
  // 方向键是**纯增量**（Tab 顺序一个不动），坏了不会有任何报错，只是键盘用户按了没反应。
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

  // 输入法组合期间的搜索：拼音串不该被当成搜索词发出去。判据用 URL 而不是"数请求"——
  // `setFilters` 里 `syncUrl` 是**同步**执行的，只要发出过一次搜索，`?search=` 会立刻出现在地址栏上。
  const imeSearch = await read(`(async () => {
    const input = document.querySelector('.toolbar input.input--search');
    // 取不到就**不是"跳过"而是判据失效**：选择器必须与工具栏同源（曾用 getElementById('search')，
    // 而搜索框根本没有这个 id —— 这条 IME 判据一直在空转）。
    if (!input) return JSON.stringify({ skipped: 'no search input（判据失效：选择器与工具栏不同源）' });
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
    // 收尾：清空搜索，别把状态留给后面的检查。
    // ⚠️ 还要等**列表真的回来**（去抖 260ms + 一次往返），否则下一条判据读到空列表。
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 60 && document.querySelectorAll('tbody tr.row').length === 0; i += 1) await wait(100);
    await wait(400);
    return JSON.stringify({ duringComposition, afterComposition, reset: current() });
  })()`);
  console.log('IME     ', imeSearch);

  // 批量复制：**真的点一次**，再把剪贴板读回来逐字对照（选中集、batch-meta 分片、全文拼接、
  // 剪贴板写入四段都会静默失败，而"按钮画得对"与"内容真的进去了"是两件事）。
  // 它**不改服务端数据**（只读 + 写本机剪贴板），故属于默认的只读探针。
  // 剪贴板权限：headless 下页面不算"已聚焦"，直接 readText 会被拒 ⇒ 先授权限 + 打开焦点模拟。
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
    // 进行中态要**同步**读：click 派发是同步的，处理器第一句就是 setPending(true)。
    // 等到 40ms 再读会变成"看请求有多快"（两条小记录的批量复制早就跑完了）。
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
      // 行尾归一后再比：Windows 剪贴板往返会把行内的 \\n 变成 \\r\\n，直接 includes 会读到 false。
      containsFirst: texts[0] !== '' && clipboard.replace(/\\r\\n/g, '\\n').includes(texts[0]),
      containsSecond: texts[1] !== '' && clipboard.replace(/\\r\\n/g, '\\n').includes(texts[1]),
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
    };
    // 收尾：取消选择（只动本机界面状态，不碰服务端）
    batchButtons().find((b) => (b.textContent ?? '').includes('取消选择'))?.click();
    return JSON.stringify(result);
  })()`);
  console.log('BATCHCOPY', batchCopy);

  // ===== 悬停预览浮层 =====
  //
  // 这个构件**唯一**不能出错的地方是：它贴在行下方、必然压住后面几行，却**绝不能接收指针
  // 事件** —— 一旦接收，被压住那几行的 hover 与点击全被吞掉。这条性质在别的守卫里看不见
  // （`ui-guard` 只查模块图与挂载点、`docs.test` 只查数目、tsc/eslint 不管 CSS 命中测试），
  // 只在这台真实浏览器里成立或不成立。
  //
  // 手法：把**真实第一行**的正文宽度收窄 → `line-clamp:1` 的纵向裁切成立 → `buildRow` 里那个
  // 真实监听器的 `check` 通过 ⇒ 用的是真实浮层节点与真实 CSS。收窄在同一个表达式里还原。
  const hoverTip = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      return JSON.stringify({ skipped: 'coarse pointer（本构件对触屏有意不挂监听）' });
    }
    const el = document.querySelector('tbody tr.row .cell-content__text');
    if (!el) return JSON.stringify({ skipped: 'no rows' });
    // 先滚进视口：触发元素在视口外时量出来的浮层坐标没有意义。
    el.scrollIntoView({ block: 'center' });
    await wait(200);
    const widthBefore = el.style.width;
    el.style.width = '40px';
    el.dispatchEvent(new MouseEvent('mouseenter'));
    await wait(500);
    const t = document.getElementById('ui-tooltip');
    const text = t.querySelector('.tooltip__text');
    const r = t.getBoundingClientRect();
    // 取浮层的**中心点**：它一定落在浮层矩形内，而浮层又压在某一行上 ⇒ 这个点既是"浮层覆盖处"
    // 又是"某一行的位置"，正是被吞掉时最容易看出来的那一点。
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const out = {
      visible: !t.hidden,
      pointerEvents: getComputedStyle(t).pointerEvents,
      hitIsTooltip: t.contains(hit),
      hitClass: hit ? (hit.className || hit.tagName) : null,
      pointInRect: cx >= Math.round(r.left) && cx <= Math.round(r.right) && cy >= Math.round(r.top) && cy <= Math.round(r.bottom),
      point: [cx, cy],
      height: Math.round(r.height),
      // 正文区封顶 6 行（6 × 20.8 = 124.8）：长内容被裁在这里，不给滚动条也不给说明行。
      textHeight: Math.round(text.getBoundingClientRect().height),
    };
    el.style.width = widthBefore;
    el.dispatchEvent(new MouseEvent('mouseleave'));
    await wait(300);
    out.hiddenAfterLeave = t.hidden;
    return JSON.stringify(out);
  })()`);
  console.log('HOVER   ', hoverTip);
  {
    const h = JSON.parse(hoverTip);
    if (h.skipped) {
      if (!COARSE) auditFindings.push('hover: ' + h.skipped);
    } else {
      if (!h.visible) auditFindings.push('hover: 正文收窄到被裁之后悬停没出浮层 ⇒ 后面几条判据都失去前提');
      if (h.pointerEvents !== 'none') {
        auditFindings.push(`hover: 浮层的 pointer-events 是 ${h.pointerEvents}（必须 none）—— 它会吞掉被压住那几行的 hover 与点击`);
      }
      if (h.hitIsTooltip) auditFindings.push(`hover: 浮层覆盖处的 elementFromPoint 命中浮层本身（读到 ${h.hitClass}）⇒ 那几行点不到`);
      if (!h.pointInRect) auditFindings.push(`hover: 取样点 ${JSON.stringify(h.point)} 落在浮层矩形之外 ⇒ 上面那条判据失去了前提`);
      if (h.textHeight > 126) auditFindings.push(`hover: 正文区高 ${h.textHeight}px，超过 6 行的封顶（125px）`);
      if (!h.hiddenAfterLeave) auditFindings.push('hover: 离开触发元素之后浮层没收起');
    }
  }

  // ===== 预览关闭即释放正文 =====
  //
  // 预览对话框是**启动期创建、常驻 `body`** 的节点，关闭时只 `dialog.close()` 的话，
  // 正文与页脚按钮的闭包会一直留在 DOM 里，直到下次打开预览才被 `replaceChildren` 换掉。
  // 判据两条各钉一半：① 关闭、等退出过渡跑完之后正文必须是空的（钉"到底有没有释放"）；
  // ② 关闭之后、退出过渡**还在跑**的那一帧里正文必须还在（钉"释放得是不是时候"）——
  // 立刻 `replaceChildren` 的写法能过 ①，但用户会看见"框还在淡出、字先没了"（框高也会跳）。
  // ② 自带前提：那一帧 `display` 若已是 `none`（减弱动效），清得早也看不见，就不该报。
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
    await wait(150); // 退出过渡跑到一半（实测总长 ~0.3s）
    const duringFade = snap();
    await wait(750); // 给足余量等过渡结束 + 清理那一帧
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

  // ===== 编辑态的关闭语义与快捷键 =====
  //
  // 四条判据：① 编辑中点**背景**（CDP 真事件点在框外的遮罩上）不关框、也不退出编辑；
  // ② Ctrl/⌘ + Enter = 保存（用"内容没改"这条零副作用路径验：不发请求，框仍开着、编辑态退出、
  // 没有弹「已保存」）；③ 单独按 Enter **不是**保存（编辑态仍在、正文多一个换行）；
  // ④ 两枚按钮的 hover 提示（`title`）与 `aria-keyshortcuts` 就是各自快捷键。
  // 用真事件：`.click()` 只证明"监听器在"，而用户是拿鼠标点在遮罩上、拿键盘按下去的。
  await send('Page.navigate', { url: `${BASE}/ui_v1/?types=Text` });
  await new Promise((r) => setTimeout(r, 2200));
  const editOpen = JSON.parse(
    (await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const row = document.querySelector('tbody tr.row');
      if (!row) return JSON.stringify({ skipped: 'no rows' });
      row.querySelector('[data-action="preview"]')?.click();
      await wait(1300);
      const dlg = document.querySelector('dialog.dialog[open]');
      if (!dlg) return JSON.stringify({ skipped: 'preview did not open' });
      const editBtn = [...dlg.querySelectorAll('.dialog__foot button')]
        .find((b) => (b.textContent ?? '').trim() === '编辑');
      if (!editBtn) return JSON.stringify({ skipped: 'no edit button (first row is not Text?)' });
      editBtn.click();
      await wait(400);
      const area = dlg.querySelector('.dialog__edit');
      if (!area) return JSON.stringify({ skipped: 'edit mode did not open' });
      const box = dlg.getBoundingClientRect();
      return JSON.stringify({
        chars: area.value.length,
        foot: [...dlg.querySelectorAll('.dialog__foot button')].map((b) => ({
          label: (b.textContent ?? '').trim(),
          title: b.getAttribute('title'),
          keys: b.getAttribute('aria-keyshortcuts'),
        })),
        box: { l: Math.round(box.left), t: Math.round(box.top) },
      });
    })()`)) ?? '{}',
  );
  const editState = async () =>
    JSON.parse(
      (await read(`(() => {
        const dlg = document.querySelector('dialog.dialog[open]');
        return JSON.stringify({
          open: Boolean(dlg),
          editing: Boolean(dlg ? dlg.querySelector('.dialog__edit') : null),
          toasts: dlg ? dlg.querySelectorAll('#toasts .toast').length : null,
          chars: dlg && dlg.querySelector('.dialog__edit') ? dlg.querySelector('.dialog__edit').value.length : null,
        });
      })()`)) ?? '{}',
    );
  const keyEvent = (kind, k, code, vk, modifiers = 0, text = undefined) =>
    send('Input.dispatchKeyEvent', {
      type: kind,
      key: k,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    });
  const pressKey = async (k, code, vk, modifiers = 0, text = undefined) => {
    await keyEvent('keyDown', k, code, vk, modifiers, text);
    await keyEvent('keyUp', k, code, vk, modifiers);
  };
  // ① 真实鼠标点背景：取对话框外、视口内的一个点（左上角四分之一处，框居中时必然落在遮罩上）。
  const backdrop = editOpen.skipped === undefined
    ? { x: Math.max(2, Math.floor(editOpen.box.l / 2)), y: Math.max(2, Math.floor(editOpen.box.t / 2)) }
    : null;
  if (backdrop) {
    await tapAt(backdrop.x, backdrop.y);
    await new Promise((r) => setTimeout(r, 250));
  }
  const afterBackdrop = backdrop ? await editState() : { open: null, editing: null };
  // ② Ctrl+Enter（内容没改 ⇒ 走"无变化"分支：不写库、退出编辑、框仍开着）
  if (backdrop) await pressKey('Enter', 'Enter', 13, 2);
  await new Promise((r) => setTimeout(r, 350));
  const afterCtrlEnter = await editState();
  // ③ 重新进入编辑，单独按 Enter：必须是**换行**，不是保存
  await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dlg = document.querySelector('dialog.dialog[open]');
    [...dlg.querySelectorAll('.dialog__foot button')]
      .find((b) => (b.textContent ?? '').trim() === '编辑')?.click();
    await wait(350);
    dlg.querySelector('.dialog__edit')?.focus();
    return 'ok';
  })()`);
  await pressKey('Enter', 'Enter', 13, 0, '\r');
  await new Promise((r) => setTimeout(r, 250));
  const afterPlainEnter = await editState();
  // Esc：退出编辑、但**不关框**（= 取消的快捷键）
  await pressKey('Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 300));
  const afterEsc = await editState();
  console.log(
    'PRVEDIT',
    JSON.stringify({ editOpen, afterBackdrop, afterCtrlEnter, afterPlainEnter, afterEsc }),
  );
  {
    const o = editOpen;
    if (o.skipped) auditFindings.push('preview-edit: ' + o.skipped);
    else {
      check(
        '编辑中点背景不关框（真实鼠标点在遮罩上）',
        afterBackdrop.open === true && afterBackdrop.editing === true,
        JSON.stringify(afterBackdrop),
      );
      check(
        'Ctrl+Enter = 保存（内容没改 ⇒ 退出编辑、不关框、不发请求）',
        afterCtrlEnter.open === true && afterCtrlEnter.editing === false && afterCtrlEnter.toasts === 0,
        JSON.stringify(afterCtrlEnter),
      );
      check(
        '单独按 Enter 不是保存（正文换行，编辑态保持）',
        afterPlainEnter.editing === true && afterPlainEnter.chars === (o.chars ?? 0) + 1,
        JSON.stringify(afterPlainEnter) + ' 编辑前正文长度=' + String(o.chars),
      );
      check('Esc = 取消（退出编辑但不关框）', afterEsc.open === true && afterEsc.editing === false, JSON.stringify(afterEsc));
      const saveBtn = (o.foot ?? []).find((b) => b.label === '保存') ?? {};
      const cancelBtn = (o.foot ?? []).find((b) => b.label === '取消') ?? {};
      check(
        '保存/取消的 hover 提示写着各自快捷键（title + aria-keyshortcuts）',
        typeof saveBtn.title === 'string' &&
          saveBtn.title.includes('Ctrl') &&
          saveBtn.keys === 'Control+Enter Meta+Enter' &&
          typeof cancelBtn.title === 'string' &&
          cancelBtn.title.includes('Esc') &&
          cancelBtn.keys === 'Escape',
        JSON.stringify({ save: saveBtn, cancel: cancelBtn }),
      );
    }
    // 收尾：关掉对话框（后面的块要求一个干净的页面状态）
    await read(`document.querySelector('dialog.dialog[open]')?.close(), 'closed'`);
    await new Promise((r) => setTimeout(r, 400));
  }

  // ===== 对话框开着的提示条必须是**真提示条** =====
  //
  // 四件事，缺一条都不算做到：① 弹的是全局那条（同一个 `#toasts` 宿主、同一个 `.toast` 节点），
  // 不是对话框里另造的一份；② 宿主被搬进**当前这个对话框**里（top layer —— 这是它看得见的前提）；
  // ③ 它**真的在 backdrop 之上**：临时打开命中区后，**真实鼠标**点在它中心，命中的是它自己
  // （提示条平时 `pointer-events: none`，不该吞掉底下的点击，所以量之前要临时打开）；
  // ④ 不压页脚，且 2.6s 后自己收掉。
  // 用「复制文本」触发：它走 `toasts.show` 而**不写任何记录**，探针不该为弹提示条往库里塞数据。
  const prvToast = JSON.parse(
    (await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const row = document.querySelector('tbody tr.row');
      row?.querySelector('[data-action="preview"]')?.click();
      await wait(1300);
      const dlg = document.querySelector('dialog.dialog[open]');
      if (!dlg) return JSON.stringify({ skipped: 'preview did not open' });
      const copy = [...dlg.querySelectorAll('.dialog__foot button')]
        .find((b) => (b.textContent ?? '').trim().startsWith('复制'));
      if (!copy) return JSON.stringify({ skipped: 'no copy button in footer' });
      copy.click();
      await wait(500);
      const host = document.querySelector('#toasts');
      const toast = host ? host.querySelector('.toast') : null;
      if (!toast) return JSON.stringify({ skipped: 'no toast appeared' });
      const r = toast.getBoundingClientRect();
      const foot = dlg.querySelector('.dialog__foot').getBoundingClientRect();
      // 命中区临时打开，只为量「它有没有被 backdrop 盖住」（与"量过渡属性前注入 transition:none"同一类手法）。
      window.__toastHit = null;
      toast.style.pointerEvents = 'auto';
      toast.addEventListener('click', () => { window.__toastHit = 'toast'; }, { once: true });
      const cs = document.createElement('style');
      cs.id = 'probe-hit';
      cs.textContent = '#toasts{pointer-events:auto}';
      document.head.append(cs);
      const out = {
        dockedInDialog: dlg.contains(host),
        hostParent: host.parentElement?.className ?? null,
        toastClass: toast.className,
        insideDialogRect:
          r.top >= dlg.getBoundingClientRect().top - 1 && r.bottom <= dlg.getBoundingClientRect().bottom + 1,
        aboveFooter: Math.round(r.bottom) <= Math.round(foot.top) + 1,
        rect: { t: Math.round(r.top), b: Math.round(r.bottom) },
        footTop: Math.round(foot.top),
        center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      };
      return JSON.stringify(out);
    })()`)) ?? '{}',
  );
  // 真实鼠标点在提示条中心：这一下能证明**没有任何东西盖在它上面**（被 backdrop 压住时，
  // 点击会落到 dialog 上 —— 那正是"假提示条"的实测形态）。
  let prvToastClick = null;
  if (!prvToast.skipped && prvToast.center) {
    await tapAt(prvToast.center.x, prvToast.center.y);
    await new Promise((r) => setTimeout(r, 1600));
    prvToastClick = JSON.parse(
      (await read(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const dlg = document.querySelector('dialog.dialog[open]');
        const hit = window.__toastHit;
        document.getElementById('probe-hit')?.remove();
        const toast = document.querySelector('#toasts .toast');
        if (toast) toast.style.pointerEvents = '';
        const gone = await (async () => { await wait(2900); return document.querySelectorAll('#toasts .toast').length === 0; })();
        return JSON.stringify({
          hit,
          dialogStillOpen: Boolean(dlg),
          editingBack: Boolean(dlg?.querySelector('.dialog__edit')),
          gone,
          parentAfter: document.querySelector('#toasts')?.parentElement?.tagName ?? null,
        });
      })()`)) ?? '{}',
    );
  }
  console.log('PRVTOAST', JSON.stringify(prvToast), 'CLICK', JSON.stringify(prvToastClick));
  {
    if (prvToast.skipped) auditFindings.push('preview-toast: ' + prvToast.skipped);
    else {
      check('对话框开着时的提示条就是全局那条（同一个 #toasts 宿主）', prvToast.dockedInDialog === true, JSON.stringify(prvToast));
      check(
        '提示条没有被 backdrop 盖住（真实鼠标点它中心，命中的是它自己）',
        prvToastClick?.hit === 'toast' && prvToastClick?.dialogStillOpen === true,
        JSON.stringify(prvToastClick),
      );
      check(
        '提示条浮在页脚之上（不盖住页脚按钮）',
        prvToast.aboveFooter === true,
        'toast.bottom=' + String(prvToast.rect.b) + ' foot.top=' + String(prvToast.footTop),
      );
      check('提示条 2.6s 后自己收掉', prvToastClick?.gone === true, JSON.stringify(prvToastClick));
    }
    // 关框之后宿主必须回到 body：否则下一条**不在对话框里**触发的提示条会被留在（已关闭的）框里
    // —— 关闭的 `<dialog>` 是 `display:none`，提示条就跟着一起消失了。
    await read(`document.querySelector('dialog.dialog[open]')?.close(), 'closed'`);
    await new Promise((r) => setTimeout(r, 500));
    const hostAfterClose = await read(`document.querySelector('#toasts')?.parentElement?.tagName ?? null`);
    check('关框后提示条宿主回到 body（后续提示条不会跟着关闭的框一起消失）', hostAfterClose === 'BODY', String(hostAfterClose));
  }

  // ===== 快捷键 =====
  //
  // 六件事：① `?` 打开帮助浮层且里面**列全**了各组键；② `t` 真的切换主题（读 `html[data-theme]`）；
  // ③ `r` 真的重发列表请求；④ `n` / `p` 真的翻页（回到第 1 页收尾）；⑤ **输入处让路**：搜索框里
  // 按 `r` 不能触发刷新（否则用户打不出这个字母）；⑥ **对话框打开时让路**。
  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, 2400));
  const keyPress = (k, code, vk, modifiers = 0, text = undefined) =>
    (async () => {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: k,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
        ...(text === undefined ? {} : { text, unmodifiedText: text }),
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    })();
  // 「这次按键有没有真的触发列表请求」用**页面内拦 fetch + 时间戳**来量，而不是"总请求数"或
  // "按钮的进行中态"：总请求数会被防抖搜索与后台轮询（可见 10s / 隐藏 30s）污染；
  // 按钮的 `data-loading` 在本地只存在 ~10ms。判据因此收成"按键之后 **120ms 内**有没有
  // `/ui/api/history` 请求"：轮询撞进这个窗口的概率约 1%，而正例必然命中。
  await read(`(() => {
    if (window.__reqLog) return 'already';
    window.__reqLog = [];
    const original = window.fetch;
    window.fetch = (...args) => {
      const url = String(args[0]?.url ?? args[0] ?? '');
      if (url.includes('/ui/api/history')) window.__reqLog.push(performance.now());
      return original(...args);
    };
    return 'hooked';
  })()`);
  // 按键前记账 → 按键 → 等 120ms → 数窗口内的列表请求
  const requestsAfterKey = async (press) => {
    const t0 = await read(`performance.now()`);
    await press();
    await new Promise((r) => setTimeout(r, 120));
    return read(`window.__reqLog.filter((t) => t >= ${t0}).length`);
  };
  // ① `?` → 帮助浮层（`?` 在所有常见布局上都要 Shift）
  await keyPress('?', 'Slash', 191, 8, '?');
  await new Promise((r) => setTimeout(r, 500));
  const helpState = JSON.parse(
    (await read(`(() => {
      const dlg = document.querySelector('dialog.dialog[open]');
      if (!dlg) return JSON.stringify({ open: false });
      const labels = [...dlg.querySelectorAll('.shortcuts__item')].map((li) => ({
        keys: [...li.querySelectorAll('kbd')].map((k) => k.textContent).join('+'),
        label: li.querySelector('.shortcuts__label')?.textContent ?? '',
      }));
      return JSON.stringify({ open: true, title: dlg.querySelector('.dialog__title')?.textContent, groups: [...dlg.querySelectorAll('.shortcuts__title')].map((h) => h.textContent), labels });
    })()`)) ?? '{}',
  );
  // ⑥ 对话框开着时 `r` 必须让路
  const rInDialog = await requestsAfterKey(() => keyPress('r', 'KeyR', 82, 0, 'r'));
  await read(`document.querySelector('dialog.dialog[open]')?.close(), 'closed'`);
  await new Promise((r) => setTimeout(r, 400));
  // ② `t` 切主题
  const themeBefore = await read(`document.documentElement.dataset.theme ?? null`);
  await keyPress('t', 'KeyT', 84, 0, 't');
  await new Promise((r) => setTimeout(r, 400));
  const themeAfter = await read(`document.documentElement.dataset.theme ?? null`);
  await keyPress('t', 'KeyT', 84, 0, 't'); // 收尾：切回去
  await new Promise((r) => setTimeout(r, 400));
  const themeRestored = await read(`document.documentElement.dataset.theme ?? null`);
  // ③ `r` 刷新列表
  const rHits = await requestsAfterKey(() => keyPress('r', 'KeyR', 82, 0, 'r'));
  await new Promise((r) => setTimeout(r, 900));
  // ④ `n` / `p` 翻页（先看第 1 页的页码文本）
  const pageText = () =>
    read(`(() => {
      const el = [...document.querySelectorAll('.pagination *')].find((n) => /第\\s*\\d+\\s*\\/\\s*\\d+\\s*页/.test(n.textContent ?? ''));
      return el?.textContent?.trim() ?? null;
    })()`);
  const pageBefore = await pageText();
  await keyPress('n', 'KeyN', 78, 0, 'n');
  await new Promise((r) => setTimeout(r, 900));
  const pageAfterNext = await pageText();
  await keyPress('p', 'KeyP', 80, 0, 'p');
  await new Promise((r) => setTimeout(r, 900));
  const pageAfterPrev = await pageText();
  // ⑤ 输入处让路：聚焦搜索框后按 r（这一条只看**非搜索**请求）
  await read(`(() => {
    const box = document.querySelector('.toolbar input[type="search"], .toolbar input[type="text"]');
    box?.focus();
    return box ? 'focused' : 'no search box';
  })()`);
  const rInInput = await requestsAfterKey(() => keyPress('r', 'KeyR', 82, 0, 'r'));
  const searchValue = await read(`document.querySelector('.toolbar input[type="search"], .toolbar input[type="text"]')?.value ?? null`);
  // ⑦ `f` / `h`：两个视图开关（只看收藏 / 回收站）。判据是**URL 与 chip 的 aria-pressed 同时变**，
  //    且再按一次能回到原样（净零）—— 只看 URL 会把"键触发了但视图没切"读成通过。
  //    前置：上一步把 `r` 打进了搜索框，此时焦点还在框里、列表也被 `?search=r` 筛过 ——
  //    不先清掉的话，下面按 `f` 只会往框里再打一个字母。
  await read(`(() => {
    const box = document.querySelector('.toolbar input');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.blur();
    return true;
  })()`);
  for (let i = 0; i < 60; i += 1) {
    const url = await read(`location.search`);
    if (!url.includes('search=')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 700));
  const viewState = async () =>
    JSON.parse(
      (await read(`JSON.stringify({
        url: location.search,
        pressed: [...document.querySelectorAll('.segmented__item[aria-pressed="true"]')].map((b) => b.textContent.trim()),
        head: document.querySelector('.results__count')?.textContent ?? null,
      })`)) ?? '{}',
    );
  const viewBefore = await viewState();
  await keyPress('f', 'KeyF', 70, 0, 'f');
  await new Promise((r) => setTimeout(r, 1500));
  const afterF = await viewState();
  await keyPress('f', 'KeyF', 70, 0, 'f'); // 收尾
  await new Promise((r) => setTimeout(r, 1500));
  const afterFBack = await viewState();
  await keyPress('h', 'KeyH', 72, 0, 'h');
  await new Promise((r) => setTimeout(r, 1500));
  const afterH = await viewState();
  await keyPress('h', 'KeyH', 72, 0, 'h'); // 收尾
  await new Promise((r) => setTimeout(r, 1500));
  const afterHBack = await viewState();
  const views = { viewBefore, afterF, afterFBack, afterH, afterHBack };
  console.log(
    'KEYS    ',
    JSON.stringify({ help: helpState.groups ?? null, helpKeys: (helpState.labels ?? []).map((l) => l.keys), pageBefore, pageAfterNext, pageAfterPrev, themeBefore, themeAfter, themeRestored, reqs: { refresh: rHits, inDialog: rInDialog, inInput: rInInput }, searchValue, views: { viewBefore, afterF, afterFBack, afterH, afterHBack } }),
  );
  {
    check('`?` 打开快捷键帮助浮层', helpState.open === true && helpState.title === '键盘快捷键', JSON.stringify(helpState.groups ?? null));
    check(
      '帮助浮层列全了四组键（列表页 / 行内 / 预览框 / 编辑正文）',
      (helpState.groups ?? []).join(',') === '列表页,行内（焦点落在某一行上时）,预览框,编辑正文',
      JSON.stringify(helpState.groups ?? null),
    );
    const keys = new Set((helpState.labels ?? []).map((l) => l.keys));
    // 行内一组的导航（↑↓ / Home·End / Shift+方向键 / Tab）+ 动作（v/c/d/s/i/r/Delete）
    const wanted = ['/', '?', 'r', 't', 'n', 'p', 'b', 'f', 'h', 'Esc', 'v', 's', 'i', 'c', 'd', 'e', 'Ctrl+Enter', 'Esc', 'Delete+Backspace', 'Shift+↑/↓'];
    check(
      '帮助浮层里每个键都在（含 r/t/n/p/c/d/e 与编辑态的 Ctrl+Enter）',
      wanted.every((w) => keys.has(w)),
      '缺：' + wanted.filter((w) => !keys.has(w)).join(',') + ' 实际=' + [...keys].join(' '),
    );
    check('`t` 切换主题', themeBefore !== null && themeAfter !== null && themeBefore !== themeAfter, String(themeBefore) + ' → ' + String(themeAfter));
    check('再按 `t` 主题切回去（可逆）', themeRestored === themeBefore, String(themeRestored));
    check('`r` 刷新列表（按键后 120ms 内真的发出列表请求）', rHits >= 1, '窗口内请求数=' + String(rHits));
    check('`n` 翻到下一页', pageAfterNext !== null && pageAfterNext !== pageBefore, `${pageBefore} → ${pageAfterNext}`);
    check('`p` 翻回上一页', pageAfterPrev === pageBefore, `${pageAfterNext} → ${pageAfterPrev}`);
    check('搜索框里按 `r` 不触发刷新（输入处让路）', rInInput === 0 && searchValue === 'r', `窗口内请求数=${String(rInInput)}，输入框值=${String(searchValue)}`);
    check('对话框打开时按 `r` 不触发刷新（对话框有自己的键）', rInDialog === 0, '窗口内请求数=' + String(rInDialog));
    const v = views;
    check(
      '`f` 切到"只看收藏"（URL 与 chip 的 aria-pressed 同时变）',
      v.afterF.url.includes('starred') && v.afterF.pressed.some((t) => t.includes('收藏')),
      JSON.stringify(v.afterF),
    );
    check('再按一次 `f` 回到原视图（净零）', v.afterFBack.url === v.viewBefore.url, `${v.viewBefore.url} → ${v.afterFBack.url}`);
    check(
      '`h` 切到回收站视图（URL 与 chip 的 aria-pressed 同时变）',
      v.afterH.url.includes('deleted') && v.afterH.pressed.some((t) => t.includes('回收站')),
      JSON.stringify(v.afterH),
    );
    check('再按一次 `h` 回到历史记录（净零）', v.afterHBack.url === v.viewBefore.url, `${v.viewBefore.url} → ${v.afterHBack.url}`);
  }

  // ===== 键盘可用性（"只用键盘能不能把整页用完"）=====
  //
  // ① 行内动作键：`v` 预览、`s` 收藏（可逆）、`Delete` 进确认框（初始焦点必须是「取消」、Esc 取消、
  // 行数不变）；② `c` 复制：剪贴板里真的出现这一行的正文；③ `Shift+↓` 从锚点行**扩展选择**；
  // ④ **聚焦滚动不落在吸顶链下**；⑤ 输入处让路；⑥ 对话框的焦点交接（打开进正文框、关闭回触发按钮）；
  // ⑦ Tab 顺序的第一个可聚焦元素是「跳到主内容」。
  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, 2400));
  const rowKeys = JSON.parse(
    (await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const rowAt = (i) => document.querySelectorAll('tbody tr.row')[i];
      const focusCell = (i) => rowAt(i).querySelector('input.checkbox').focus();
      const checkedCount = () => document.querySelectorAll('tbody tr.row input.checkbox:checked').length;
      const out = {};
      out.firstFocusable = (() => {
        const nodes = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((n) => !n.disabled && n.offsetParent !== null);
        return nodes[0]?.textContent?.trim().slice(0, 8) ?? null;
      })();
      // ⑤ 输入处让路（先做，免得后面把选择集留在地上）
      const box = document.querySelector('.toolbar input');
      box.focus();
      out.inputFocused = document.activeElement === box;
      // ① 行内动作键
      focusCell(1);
      // 初值必须**先读**：这一行是否已收藏由库里的数据决定（写死"按前=true"会在该行恰好未收藏时假红）。
      out.starBefore = rowAt(1).querySelector('[data-action="star"]')?.getAttribute('aria-pressed') ?? null;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }));
      await wait(600);
      out.starAfterKey = rowAt(1).querySelector('[data-action="star"]')?.getAttribute('aria-pressed') ?? null;
      // 再按一次复原（净零）
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }));
      await wait(600);
      out.starRestored = rowAt(1).querySelector('[data-action="star"]')?.getAttribute('aria-pressed') ?? null;
      // ③ Shift+↓ 扩展选择
      const rowsBefore = document.querySelectorAll('tbody tr.row').length;
      focusCell(4);
      const shift = (key) => {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true }));
      };
      const before = checkedCount();
      shift('ArrowDown');
      await wait(400);
      shift('ArrowDown');
      await wait(500);
      out.rangeChecked = checkedCount();
      out.rangeGrew = out.rangeChecked - before;
      // 收尾：清空选择
      [...document.querySelectorAll('.results__selection button')]
        .find((b) => (b.textContent ?? '').includes('取消选择'))?.click();
      await wait(500);
      out.afterClear = checkedCount();
      out.rowsIntact = document.querySelectorAll('tbody tr.row').length === rowsBefore;
      return JSON.stringify(out);
    })()`)) ?? '{}',
  );
  // ① `v` → 预览（真键盘）
  await read(`document.querySelectorAll('tbody tr.row')[1].querySelector('input.checkbox').focus(), 1`);
  await keyPress('v', 'KeyV', 86, 0, 'v');
  await new Promise((r) => setTimeout(r, 1300));
  const previewKey = JSON.parse(
    (await read(`JSON.stringify({
      open: Boolean(document.querySelector('dialog.dialog[open]')),
      title: document.querySelector('dialog.dialog[open] .dialog__title')?.textContent ?? null,
    })`)) ?? '{}',
  );
  await keyPress('Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 700));

  // ① Delete → 确认框（真键盘），Esc 取消后行数不变
  await read(`document.querySelectorAll('tbody tr.row')[1].querySelector('input.checkbox').focus(), 1`);
  const rowsBeforeDelete = await read(`document.querySelectorAll('tbody tr.row').length`);
  await keyPress('Delete', 'Delete', 46);
  await new Promise((r) => setTimeout(r, 600));
  const deleteDialog = JSON.parse(
    (await read(`JSON.stringify({
      open: Boolean(document.querySelector('dialog.dialog[open]')),
      focusLabel: (document.activeElement?.textContent ?? '').trim().slice(0, 6),
      title: document.querySelector('dialog.dialog[open] .dialog__title')?.textContent ?? null,
    })`)) ?? '{}',
  );
  await keyPress('Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 700));
  const rowsAfterCancel = await read(`document.querySelectorAll('tbody tr.row').length`);
  // ② `c` → 剪贴板里是这一行的正文
  await read(`(async () => {
    const b = document.querySelectorAll('tbody tr.row')[1];
    window.__rowText = (b.querySelector('.cell-content__text')?.textContent ?? '').slice(0, 40);
    b.querySelector('input.checkbox').focus();
    return 'ok';
  })()`);
  await keyPress('c', 'KeyC', 67, 0, 'c');
  await new Promise((r) => setTimeout(r, 900));
  const copied = JSON.parse(
    (await read(`(async () => {
      let text = null;
      try { text = await navigator.clipboard.readText(); } catch (error) { text = 'ERR:' + String(error).slice(0, 40); }
      // 行尾必须先归一：记录里的正文可能是 CRLF（官方客户端从 Windows 剪贴板发来的就是），
      // 而列表里那格读到的 textContent 是 LF ⇒ 直接 startsWith 会假红。
      const norm = (s) => String(s).replace(/\\r\\n?/g, '\\n');
      return JSON.stringify({ head: (text ?? '').slice(0, 40), matchesCell: text !== null && norm(text).startsWith(norm(window.__rowText)) });
    })()`)) ?? '{}',
  );
  // ④ 聚焦滚动不落在吸顶链下（折叠态）
  const occlusion = JSON.parse(
    (await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = [...document.querySelectorAll('tbody tr.row')];
      const btn = rows[8].querySelector('[data-action="preview"]');
      const docTop = btn.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.round(docTop + 6));
      // 等折叠**稳定**（过渡期间几何还是展开态，量出来的是假红）
      for (let i = 0; i < 40 && document.documentElement.dataset.header !== 'hidden'; i += 1) await wait(50);
      await wait(120);
      btn.focus();
      await wait(400);
      const after = Math.round(btn.getBoundingClientRect().top);
      // 判据只在**有吸顶链**的那一档成立：卡片档（≤860px）的表头是 position: static 且在视口上方
      // 很远，表头矩形 bottom 会是负数 —— 拿它当门槛，"after >= stickyBottom - 0.5" 就**恒真**。
      const th = document.querySelector('.table th');
      const stickyChain = Boolean(th) && getComputedStyle(th).position === 'sticky';
      const stickyBottom = stickyChain ? Math.round(th.getBoundingClientRect().bottom) : null;
      window.scrollTo(0, 0);
      await wait(300);
      return JSON.stringify({ focused: document.activeElement === btn, after, stickyChain, stickyBottom, margin: getComputedStyle(btn).scrollMarginTop });
    })()`)) ?? '{}',
  );
  // ⑥ 对话框焦点交接：打开时在正文框、关闭后回到触发按钮
  const handoff = JSON.parse(
    (await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.querySelectorAll('tbody tr.row')[1].querySelector('[data-action="preview"]');
      btn.focus();
      btn.click();
      await wait(1300);
      const initial = document.activeElement?.className ?? null;
      document.querySelector('dialog.dialog[open]')?.close();
      await wait(600);
      return JSON.stringify({ initial, restored: document.activeElement === btn });
    })()`)) ?? '{}',
  );
  console.log('KBD     ', JSON.stringify({ rowKeys, previewKey, deleteDialog, copied, occlusion, handoff }));
  {
    check('`v`：焦点在行内时打开预览（真键盘，见 previewKeyOpen）', previewKey.open === true, JSON.stringify(previewKey));
    check(
      '`s` 切换收藏并可逆（净零）',
      rowKeys.starBefore !== null &&
        rowKeys.starAfterKey === (rowKeys.starBefore === 'true' ? 'false' : 'true') &&
        rowKeys.starRestored === rowKeys.starBefore,
      `按前=${String(rowKeys.starBefore)} → 按后=${String(rowKeys.starAfterKey)} → 复原=${String(rowKeys.starRestored)}`,
    );
    check('`Shift+↓` 从锚点行扩展选择（键盘等价于 Shift+点击）', rowKeys.rangeGrew >= 2, '新增选中=' + String(rowKeys.rangeGrew));
    check('清空选择后无残留（净零）', rowKeys.afterClear === 0 && rowKeys.rowsIntact === true, JSON.stringify({ afterClear: rowKeys.afterClear, rowsIntact: rowKeys.rowsIntact }));
    check('`Delete` 打开确认框，且初始焦点在「取消」', deleteDialog.open === true && deleteDialog.focusLabel === '取消', JSON.stringify(deleteDialog));
    check('取消后行数不变（没有误删）', rowsAfterCancel === rowsBeforeDelete, `${rowsBeforeDelete} → ${rowsAfterCancel}`);
    check('`c` 把这一行的正文真的写进了剪贴板', copied.matchesCell === true, JSON.stringify(copied));
    if (occlusion.stickyChain === false) {
      // 该档没有吸顶链 ⇒ 这条判据**没有前提**：显式写进 SKIPPED（白名单里放行），而不是记成通过。
      origLog('KBD      occlusion skipped: no sticky chain（本档无吸顶表头，判据不适用）');
      skips.push('no sticky chain（本档无吸顶表头，判据不适用）');
    } else {
      check(
        '聚焦行内控件时不会被吸顶链挡住（滚动留出 scroll-margin）',
        occlusion.focused === true && occlusion.after >= occlusion.stickyBottom - 0.5,
        `top=${String(occlusion.after)} 吸顶底边=${String(occlusion.stickyBottom)} margin=${String(occlusion.margin)}`,
      );
    }
    check('预览打开时初始焦点在正文框，关闭后回到触发按钮', handoff.initial === 'dialog__body' && handoff.restored === true, JSON.stringify(handoff));
    check('Tab 顺序的第一个可聚焦元素是跳链「跳到主内容」', (rowKeys.firstFocusable ?? '').includes('跳到主内容'), String(rowKeys.firstFocusable));
  }

  // ===== 键盘层与提示条停靠的回归 =====
  //
  // 四件事，此前都没有判据：① 焦点在行内**复选框**上时，列表级快捷键（`t`/`?`/`n`/`p`）必须照样
  // 生效（此前一律按 `tagName` 让路，而复选框也是 `INPUT` ⇒ 键盘选行/方向键导航的落点上全部静默失效）；
  // ② `n`/`p` 翻页后焦点必须留在**分页条**上（此前掉回 `<body>`，此后方向键与行内动作键全部失灵）；
  // ③ `Ctrl`+滚轮不能被预览框的滚轮转发吞掉（此前 `preventDefault` ⇒ 预览开着时页面缩放失效）；
  // ④ 提示条**先显示、对话框后打开**这一档，宿主也必须搬进 top layer；嵌套模态下必须搬进
  // **真正在最上层**的那个框（文档序 ≠ top layer 序）。
  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, 2400));
  const kbFix = { before: JSON.parse((await read(`(() => {
    const box = document.querySelectorAll('tbody tr.row')[1]?.querySelector('input.checkbox');
    if (!box) return JSON.stringify({ skipped: 'no rows' });
    box.focus();
    return JSON.stringify({ onCheckbox: document.activeElement === box, theme: document.documentElement.dataset.theme ?? null, page: new URLSearchParams(location.search).get('page') });
  })()`)) ?? '{}') };
  await keyPress('t', 'KeyT', 84, 0, 't');
  await new Promise((r) => setTimeout(r, 500));
  kbFix.afterT = await read(`document.documentElement.dataset.theme ?? null`);
  await keyPress('t', 'KeyT', 84, 0, 't'); // 收尾：切回去
  await new Promise((r) => setTimeout(r, 500));
  await keyPress('?', 'Slash', 191, 8, '?');
  await new Promise((r) => setTimeout(r, 600));
  kbFix.helpFromCheckbox = await read(`Boolean(document.querySelector('dialog[open] .shortcuts'))`);
  await keyPress('Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 600));
  // ② 翻页：焦点必须留在分页条上（此前是 <body>）
  await read(`document.querySelectorAll('tbody tr.row')[1]?.querySelector('input.checkbox')?.focus(), 1`);
  await keyPress('n', 'KeyN', 78, 0, 'n');
  await new Promise((r) => setTimeout(r, 1700));
  kbFix.afterN = JSON.parse((await read(`JSON.stringify({
    page: new URLSearchParams(location.search).get('page'),
    active: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''),
    inPager: Boolean(document.activeElement?.closest?.('.pagination')),
  })`)) ?? '{}');
  await keyPress('p', 'KeyP', 80, 0, 'p');
  await new Promise((r) => setTimeout(r, 1700));
  kbFix.afterP = await read(`new URLSearchParams(location.search).get('page')`);
  // ③ 帮助浮层的**可见入口**（此前只有 `?`，界面上没有任何按钮）
  kbFix.helpButton = JSON.parse((await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.querySelector('.toolbar .icon-btn[aria-label="键盘快捷键"]');
    if (!b) return JSON.stringify({ found: false });
    // 翻页/改筛选会把结果区滚进视野 ⇒ 工具栏可能在视口外，而真实鼠标点不到视口外的坐标。
    b.scrollIntoView({ block: 'center' });
    await wait(400);
    const r = b.getBoundingClientRect();
    window.__helpPoint = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    return JSON.stringify({ found: true, visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight, point: window.__helpPoint });
  })()`)) ?? '{}');
  if (kbFix.helpButton.found) {
    await tapAt(kbFix.helpButton.point.x, kbFix.helpButton.point.y);
    await new Promise((r) => setTimeout(r, 400));
    kbFix.helpByButton = await read(`Boolean(document.querySelector('dialog[open] .shortcuts'))`);
    await keyPress('Escape', 'Escape', 27);
    await new Promise((r) => setTimeout(r, 600));
  }
  // ⑤ `b` = 把焦点送到选中操作条（从列表深处够批量动作的唯一入口）。
  // ⚠️ 必须排在下面"④ 预览框"之前：列表级派发器见到 `dialog[open]` 就让路。
  await read(`(() => {
    const rows = [...document.querySelectorAll('tbody tr.row')];
    const box = rows[5]?.querySelector('input.checkbox');
    if (!box) return false;
    box.focus();
    box.click(); // 选中一行（与 Space 同一条路径）
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await keyPress('b', 'KeyB', 66, 0, 'b');
  await new Promise((r) => setTimeout(r, 400));
  kbFix.selectionBar = JSON.parse((await read(`JSON.stringify({
    checked: document.querySelectorAll('tbody tr.row input.checkbox:checked').length,
    inBar: Boolean(document.activeElement?.closest?.('.results__selection')),
    label: (document.activeElement?.getAttribute?.('aria-label') ?? document.activeElement?.textContent ?? '').trim().slice(0, 12),
    destructive: Boolean(document.activeElement?.classList?.contains('btn--danger-solid')),
  })`)) ?? '{}');
  // 收尾：`Esc` 清空选择（顺带钉住 Esc 这条）
  await keyPress('Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 500));
  kbFix.afterEscClear = await read(`document.querySelectorAll('tbody tr.row input.checkbox:checked').length`);
  // ④ 预览框：`e` 走 `data-action` 那条映射（真键盘），以及 Ctrl+滚轮不被吞
  await read(`document.querySelectorAll('tbody tr.row')[1].querySelector('[data-action="preview"]').focus(), 1`);
  await keyPress('Enter', 'Enter', 13, 0, '\r');
  await new Promise((r) => setTimeout(r, 1300));
  kbFix.previewActions = await read(`JSON.stringify([...document.querySelectorAll('dialog.dialog[open] .dialog__foot [data-action]')].map((b) => b.dataset.action))`);
  await keyPress('e', 'KeyE', 69, 0, 'e');
  await new Promise((r) => setTimeout(r, 900));
  kbFix.editByKey = await read(`Boolean(document.querySelector('dialog.dialog[open] .dialog__edit'))`);
  await keyPress('Escape', 'Escape', 27); // 退出编辑
  await new Promise((r) => setTimeout(r, 700));
  kbFix.wheel = JSON.parse((await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pre = document.querySelector('dialog[open] .dialog__pre');
    if (pre) pre.textContent = 'x'.repeat(4000); // 让正文真的可滚（否则处理器短路，量不到 preventDefault）
    window.__wheel = [];
    document.addEventListener('wheel', (e) => window.__wheel.push({ ctrl: e.ctrlKey, prevented: e.defaultPrevented }));
    const r = document.querySelector('dialog[open] .dialog__foot').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), scrollable: document.querySelector('dialog[open] .dialog__body').scrollHeight > document.querySelector('dialog[open] .dialog__body').clientHeight + 1 });
  })()`)) ?? '{}');
  if (kbFix.wheel.scrollable && !COARSE) {
    const wheelAt = (modifiers) =>
      send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: kbFix.wheel.x, y: kbFix.wheel.y, deltaX: 0, deltaY: 120, modifiers });
    await wheelAt(0);
    await new Promise((r) => setTimeout(r, 250));
    await wheelAt(2); // 2 = Ctrl
    await new Promise((r) => setTimeout(r, 250));
    kbFix.wheelEvents = JSON.parse((await read(`JSON.stringify(window.__wheel)`)) ?? '[]');
  } else if (kbFix.wheel.scrollable) {
    // 粗指针设备没有滚轮，且 headless 触屏模拟下 mouseWheel 与鼠标一样会挂起 ⇒ 不派发、判据也不跑
    kbFix.wheelEvents = [];
  }

  await read(`document.querySelector('dialog.dialog[open]')?.close(), 1`);
  await new Promise((r) => setTimeout(r, 600));
  console.log('KBD2    ', JSON.stringify(kbFix));
  {
    check('焦点在行内复选框上时 `t` 仍然切主题（列表级键不被 INPUT 吞掉）', kbFix.before.theme !== null && kbFix.afterT !== null && kbFix.before.theme !== kbFix.afterT, `${String(kbFix.before.theme)} → ${String(kbFix.afterT)}`);
    check('焦点在行内复选框上时 `?` 仍然打开帮助浮层', kbFix.helpFromCheckbox === true, JSON.stringify(kbFix.helpFromCheckbox));
    check('`n` 翻到下一页且焦点留在分页条上（不掉回 <body>）', kbFix.afterN.page === '2' && kbFix.afterN.inPager === true, JSON.stringify(kbFix.afterN));
    check('`p` 翻回上一页', kbFix.afterP !== '2', `page=${String(kbFix.afterP)}`);
    check('快捷键帮助有**可见入口**（工具栏那枚按钮能打开它）', kbFix.helpButton.found === true && kbFix.helpButton.visible === true && kbFix.helpByButton === true, JSON.stringify(kbFix.helpButton));
    check(
      '`b` 把焦点送到选中操作条，且不停在销毁性按钮上',
      kbFix.selectionBar?.inBar === true && kbFix.selectionBar?.destructive === false,
      JSON.stringify(kbFix.selectionBar),
    );
    check('`Esc` 清空选择（净零）', kbFix.afterEscClear === 0, String(kbFix.afterEscClear));
    check('预览框的键按 `data-action` 找到按钮（`e` 真键盘进入编辑态）', kbFix.editByKey === true, String(kbFix.previewActions));
    if (kbFix.wheel.scrollable && !COARSE) {
      const plain = (kbFix.wheelEvents ?? []).find((e) => e.ctrl === false);
      const ctrl = (kbFix.wheelEvents ?? []).find((e) => e.ctrl === true);
      check('滚轮转发照旧接管（正文可滚时普通滚轮被 preventDefault）', plain?.prevented === true, JSON.stringify(kbFix.wheelEvents));
      check('`Ctrl`+滚轮（浏览器缩放）不被吞', ctrl?.prevented === false, JSON.stringify(kbFix.wheelEvents));
    }
  }

  // 提示条停靠：**先显示提示条、后打开对话框**（此前只在 show() 里停靠 ⇒ 这一档宿主留在 body）
  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, 2400));
  const dock = {};
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await read(`document.querySelector('.toolbar .icon-btn[aria-label="刷新"]').click(), 1`);
  await new Promise((r) => setTimeout(r, 1200));
  dock.before = JSON.parse((await read(`JSON.stringify({
    hasAction: Boolean(document.querySelector('#toasts .toast__action')),
    parent: document.getElementById('toasts')?.parentElement?.tagName ?? null,
  })`)) ?? '{}');
  // ⚠️ 顺序：先恢复网络，再打开预览框 —— 离线时预览框取全文会失败并**自己收壳**，后面读不到对话框。
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await read(`document.querySelectorAll('tbody tr.row')[1].querySelector('[data-action="preview"]').click(), 1`);
  await new Promise((r) => setTimeout(r, 1400));
  dock.afterOpen = JSON.parse((await read(`(() => {
    const host = document.getElementById('toasts');
    const action = host?.querySelector('.toast__action');
    const r = action?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) : null;
    window.__retry2 = r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    return JSON.stringify({
      parent: host?.parentElement?.className ?? null,
      dockedInDialog: Boolean(host?.closest('dialog')),
      dialogOpen: Boolean(document.querySelector('dialog.dialog[open]')),
      // 提示条现在浮在对话框页脚**之上** ⇒ 重试按钮的新坐标要重新取。
      // 命中判定要 closest('.toast__action')：按钮中心的最上层元素是它内部的 label 元素。
      retryHit: Boolean(hit?.closest?.('.toast__action')),
    });
  })()`)) ?? '{}');
  if (dock.afterOpen.dialogOpen && dock.afterOpen.retryHit) {
    const p = JSON.parse((await read(`JSON.stringify(window.__retry2)`)) ?? 'null');
    await tapAt(p.x, p.y);
    await new Promise((r) => setTimeout(r, 1600));
  }
  dock.afterClick = JSON.parse((await read(`JSON.stringify({
    dialogStillOpen: Boolean(document.querySelector('dialog.dialog[open]')),
    actionGone: !document.querySelector('#toasts .toast__action'),
  })`)) ?? '{}');
  // 嵌套模态：预览之上再开确认框 ⇒ 宿主必须搬进**真正在最上层**的那个框（文档序 ≠ top layer 序）
  await read(`(() => {
    const foot = document.querySelector('dialog.dialog[open]')?.querySelector('.dialog__foot');
    [...(foot?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('移动到回收站'))?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  dock.nested = JSON.parse((await read(`(() => {
    const host = document.getElementById('toasts');
    const open = [...document.querySelectorAll('dialog[open]')];
    const hostDialog = host?.closest('dialog') ?? null;
    const r = hostDialog?.querySelector('.dialog__title')?.getBoundingClientRect() ?? null;
    const hit = r ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) : null;
    return JSON.stringify({
      openCount: open.length,
      hostIn: hostDialog?.className ?? null,
      topLayerAtHostTitle: hit?.closest('dialog')?.className ?? null,
    });
  })()`)) ?? '{}');
  await keyPress('Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 600));
  await read(`document.querySelector('dialog.dialog[open]')?.close(), 1`);
  await new Promise((r) => setTimeout(r, 500));
  // 收尾：本块自己弹的提示条（带「重试」那条停留 10 秒）必须清掉 —— 否则后面的块会读到它（SAVE 块曾因此假红）。
  await read(`document.querySelectorAll('#toasts .toast').forEach((n) => n.remove()), 1`);
  console.log('DOCK    ', JSON.stringify(dock));
  {
    if (dock.before.hasAction !== true) {
      origLog('DOCK     skipped: no retry toast（离线刷新没有弹出带动作的提示条）');
      skips.push('no retry toast');
    } else {
      check('提示条**先显示**、对话框后打开时，宿主也搬进 top layer', dock.afterOpen.dockedInDialog === true && dock.afterOpen.dialogOpen === true, JSON.stringify(dock.afterOpen));
      check(
        '此时点提示条里的「重试」命中它自己（不会点到 backdrop 把对话框关掉）',
        dock.afterClick.dialogStillOpen === true && dock.afterClick.actionGone === true,
        JSON.stringify(dock.afterClick),
      );
      check(
        '嵌套模态时宿主停在**最上层**那个框（打开顺序，不是文档序）',
        dock.nested.hostIn !== null && dock.nested.hostIn === dock.nested.topLayerAtHostTitle,
        JSON.stringify(dock.nested),
      );
    }
  }

  // ===== 编辑保存的**真实路径** =====
  //
  // 这条路径此前**没有判据**（探针只测了"内容没变 ⇒ 不发请求"那条，它绕过保存后的反馈），
  // 于是 `toasts.show`（那个对象上只有 `info`/`error`）一路走到用户手里才被发现。
  //
  // 判据四件事：① 真发了一次 POST；② 记录数 +1；③ 出现**真提示条**且文案是"已保存为新记录（N 个字符）"；
  // ④ 自己收拾干净（软删 + 彻底删除，按内容里的探针标记定位，跑完不残留）。
  // 它**写服务端数据**，但净零且不依赖 --write：这条路径太关键，不能被"默认不写"挡在门禁之外。
  const saveMarker = `PROBE-${Date.now().toString(36)}`;
  const saveResult = JSON.parse(
    (await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__posts = [];
      const of = window.fetch;
      window.fetch = (...a) => {
        const url = String(a[0]?.url ?? a[0] ?? '');
        const method = (a[1]?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.includes('/ui/api/history')) window.__posts.push(url);
        return of(...a);
      };
      const before = (await (await fetch('/ui/api/history?page=1&pageSize=1')).json()).total ?? null;
      const row = document.querySelector('tbody tr.row');
      row?.querySelector('[data-action="preview"]')?.click();
      await wait(1300);
      const dlg = document.querySelector('dialog.dialog[open]');
      const edit = [...(dlg?.querySelectorAll('.dialog__foot button') ?? [])].find((b) => (b.textContent ?? '').trim() === '编辑');
      if (!edit) return JSON.stringify({ skipped: 'no edit button (first row is not Text?)' });
      edit.click();
      await wait(400);
      const area = dlg.querySelector('.dialog__edit');
      if (!area) return JSON.stringify({ skipped: 'edit mode did not open' });
      area.value = area.value + ${JSON.stringify('\n' + saveMarker)};
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ before, marker: ${JSON.stringify(saveMarker)} });
    })()`)) ?? '{}',
  );
  let saveState = { skipped: saveResult.skipped ?? 'not attempted' };
  if (!saveResult.skipped) {
    // 真键盘：Ctrl+Enter 就是用户按的那个
    await keyPress('Enter', 'Enter', 13, 2);
    await new Promise((r) => setTimeout(r, 1800));
    saveState = JSON.parse(
      (await read(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const dlg = document.querySelector('dialog.dialog[open]');
        // 读**全部**提示条里匹配"已保存为新记录"的那一条：宿主里可能还有别的提示（本探针自己弹的）。
        const toasts = [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent);
        // ⚠️ 用 [0-9] 而不是 \\d：这段是**模板字面量**，\\d 里的反斜杠会被吃掉（变成 d+）⇒ 正则永不匹配。
        const toast = toasts.find((t) => /^已保存为新记录（[0-9]+ 个字符）$/.test(t)) ?? null;
        const after = (await (await fetch('/ui/api/history?page=1&pageSize=1')).json()).total ?? null;
        const out = {
          posts: window.__posts.length,
          after,
          toast,
          editing: Boolean(dlg?.querySelector('.dialog__edit')),
          errorShown: dlg?.querySelector('.alert--error')?.hidden === false
            ? dlg.querySelector('.alert--error').textContent
            : null,
          // 诊断用（判据失败时能看出"是没弹、还是被别的提示挤掉、还是宿主不在文档里"）
          toastDebug: {
            all: toasts,
            anywhere: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
            hostInDoc: document.body.contains(document.getElementById('toasts')),
            hostParent: document.getElementById('toasts')?.parentElement?.className ?? null,
          },
        };
        // 收拾干净：按内容里的探针标记定位 → 软删 → 彻底删除。
        // ⚠️ type 必须转成**字符串**再发：列表 JSON 里它是**数字**，而 batch-purge 的入口判据是
        // typeof entry.type === 'string' ⇒ 直接透传数字会被判 invalid、静默留在回收站里。
        const marker = ${JSON.stringify(saveMarker)};
        const look = async (deleted) =>
          (await (await fetch('/ui/api/history?page=1&pageSize=20&sort=id&order=desc&search=' +
            encodeURIComponent(marker) + (deleted ? '&deleted=true' : ''))).json());
        const found = await look(false);
        const mine = (found.items ?? []).filter((it) => (it.text ?? '').includes(marker));
        out.created = mine.length;
        let purged = 0;
        const purgeBodies = [];
        for (const it of mine) {
          const key = String(it.type) + '/' + it.hash;
          await fetch('/ui/api/history/' + key, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ isDelete: true }),
          });
          const res = await fetch('/ui/api/history/batch-purge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: [{ type: String(it.type), hash: it.hash }] }),
          });
          const body = await res.json();
          purgeBodies.push(body);
          purged += body.purged ?? 0;
        }
        out.purged = purged;
        out.purgeBodies = purgeBodies;
        // 残留要看**回收站**：软删之后它在活跃视图里本来就看不见
        out.trashResidual = (await look(true)).total ?? null;
        out.activeResidual = (await look(false)).total ?? null;
        out.finalTotal = (await (await fetch('/ui/api/history?page=1&pageSize=1')).json()).total ?? null;
        document.querySelector('dialog.dialog[open]')?.close();
        await wait(300);
        return JSON.stringify(out);
      })()`)) ?? '{}',
    );
  }
  console.log('SAVE    ', JSON.stringify({ marker: saveMarker, ...saveResult, ...saveState }));
  {
    if (saveState.skipped && saveResult.skipped) auditFindings.push('save: ' + String(saveResult.skipped));
    else {
      check('保存真的发出了 POST /ui/api/history', saveState.posts >= 1, JSON.stringify(saveState));
      check('保存后记录数 +1', saveState.after === (saveResult.before ?? 0) + 1, `${saveResult.before} → ${saveState.after}`);
      check(
        '保存后弹出**真提示条**且文案正确（回归：`toasts.show` 不是函数）',
        typeof saveState.toast === 'string' && /^已保存为新记录（\d+ 个字符）$/.test(saveState.toast),
        JSON.stringify({ toast: saveState.toast, errorShown: saveState.errorShown }),
      );
      check(
        '保存路径无就地报错（编辑框已退出、错误盒隐藏）',
        saveState.editing === false && saveState.errorShown === null,
        JSON.stringify(saveState),
      );
      check(
        '探针自己收拾干净（软删 + 彻底删除，**回收站里也不残留**）',
        saveState.purged >= 1 && saveState.trashResidual === 0 && saveState.activeResidual === 0,
        JSON.stringify({ purged: saveState.purged, bodies: saveState.purgeBodies, trash: saveState.trashResidual, active: saveState.activeResidual, finalTotal: saveState.finalTotal }),
      );
    }
  }

  // ===== 顶栏折叠（"滚动的时候最上面这一个折叠起来"）=====
  //
  // 四件事：① 向下滚且离开顶部 120px 之后**整条滑出**；② 头栏与表头**跟着上移**（顶栏原来占的
  // 56px 不留空带：头栏贴 0、表头贴 45）；③ 向上滚**立刻展开**；④ **多选时不弹回来**：
  // 折叠态下勾一行，顶栏仍滑出、头栏仍贴 0 ⇒ **零位移**（"选中时不折"那版会把内容推下 56px，
  // 与"选中前后零位移"自相矛盾）。
  const headerFold = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), h: Math.round(r.height) };
    };
    const snap = () => ({
      y: Math.round(window.scrollY),
      vw: window.innerWidth,
      header: box('.app-header'),
      head: box('.results__head'),
      th: box('.table th'),
      attr: document.documentElement.dataset.header ?? null,
      headTopCss: getComputedStyle(document.querySelector('.results__head')).top,
    });
    const to = async (y) => { window.scrollTo(0, y); await wait(520); };
    const out = {};
    await to(0);
    out.atTop = snap();
    await to(300);
    out.down300 = snap();
    await to(900);
    out.down900 = snap();
    await to(600);
    out.up = snap();
    // 再折回去，然后在这一态下勾一行（DOM 点击 ⇒ 不会因为"滚进视口"而改变滚动位置）
    await to(900);
    await wait(200);
    const rows = [...document.querySelectorAll('tbody tr.row')];
    const vis = rows.find((r) => {
      const b = r.getBoundingClientRect();
      return b.top > 200 && b.bottom < 700;
    });
    out.selectedFound = Boolean(vis);
    vis?.querySelector('input.checkbox')?.click();
    await wait(620);
    out.selected = snap();
    // 收尾：取消选择 + 回到顶部（别把状态留给后面的检查）
    [...document.querySelectorAll('.results__selection button')]
      .find((b) => (b.textContent ?? '').includes('取消选择'))
      ?.click();
    window.scrollTo(0, 0);
    await wait(620);
    out.reset = snap();
    return JSON.stringify(out);
  })()`);
  console.log('HEADERFOLD', headerFold);
  {
    const s = JSON.parse(headerFold);
    // 表头只在**表格档**（>860px）吸顶；卡片档它是 `top: auto`、随页面滚走 ⇒ 这两条判据必须分档。
    const cardMode = (s.down900?.vw ?? 1440) <= 860;
    const thCollapsedOk = cardMode ? (s.down900?.th === null || s.down900.th.top < 0) : s.down900?.th?.top === 45;
    const hidden = (x) => x?.header?.top <= -56;
    check('向下滚离开顶部 120px 之后顶栏整条滑出', s.down900?.attr === 'hidden' && hidden(s.down900), JSON.stringify(s.down900));
    check('顶栏滑出后头栏贴到顶（不留空带）', s.down900?.head?.top === 0, '头栏 top=' + String(s.down900?.head?.top));
    check(
      cardMode ? '卡片档：表头随页面滚走（不参与让位）' : '表格档：顶栏滑出后表头跟着上移一格（top: 45px）',
      thCollapsedOk,
      '表头 top=' + String(s.down900?.th?.top) + ' 视口宽=' + String(s.down900?.vw),
    );
    check('向上滚立刻展开顶栏', s.up?.attr !== 'hidden' && s.up?.header?.top === 0, JSON.stringify(s.up));
    // ④ 多选时**不弹回来**：折叠态下勾一行，顶栏仍滑出、头栏仍贴 0、表头仍贴 45 ⇒ **零位移**（分档同上）。
    const thSelectedOk = cardMode ? (s.selected?.th === null || s.selected.th.top < 0) : s.selected?.th?.top === 45;
    check(
      '多选时不弹回顶栏（勾一行仍保持折叠，零位移）',
      s.selected?.attr === 'hidden' &&
        hidden(s.selected) &&
        s.selected?.head?.top === 0 &&
        thSelectedOk,
      `attr=${String(s.selected?.attr)} header.top=${String(s.selected?.header?.top)} head.top=${String(s.selected?.head?.top)} th.top=${String(s.selected?.th?.top)} 找到可见行=${String(s.selectedFound)}`,
    );
    // 收尾状态：取消选择 + 回顶部 ⇒ 顶栏回来（回归到未折叠态）
    check(
      '取消选择并回到顶部后顶栏回来',
      s.reset?.attr !== 'hidden' && s.reset?.header?.top === 0,
      JSON.stringify(s.reset),
    );
  }

  // ===== 部署信息的「保留策略」说明里必须写着那条豁免 =====
  // 判据是"看得见且读得到"：静态文案被折掉、被压住、字在但不可见，都等于这个承诺没出现
  // （文案在 `ui_v1/js/components/info.js` 的 `.note` 里）。
  // ⚠️ 必须放在**默认流程**里：写进 `if (SHOTS)` 那段时，默认跑的探针根本不执行它 —— `findings=0` 是假的。
  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, 2000));
  await read(
    `[...document.querySelectorAll('.app-header__actions button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('部署信息'))?.click(), 'clicked'`,
  );
  await new Promise((r) => setTimeout(r, 800));
  const retentionNote = await read(`(() => {
    const notes = [...document.querySelectorAll('dialog[open] .note')];
    const note = notes.find((n) => (n.textContent || '').indexOf('两项清理') >= 0);
    if (!note) return JSON.stringify({ found: false, candidates: notes.length });
    const r = note.getBoundingClientRect();
    const cs = getComputedStyle(note);
    return JSON.stringify({
      found: true,
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility === 'visible',
      exempt: (note.textContent || '').indexOf('收藏与置顶的记录不受这两项清理影响') >= 0,
    });
  })()`);
  console.log('RETENTION-NOTE', retentionNote);
  {
    const n = JSON.parse(retentionNote);
    check(
      '保留策略的说明里写明「收藏与置顶的记录不受这两项清理影响」，且它在对话框里真的可见',
      n.found && n.visible && n.exempt,
      JSON.stringify(n),
    );
  }
  await read(`document.querySelector('dialog[open]')?.close(), 'closed'`);
  await new Promise((r) => setTimeout(r, 300));

  // ===== 文本下载 =====
  // 判据不是"点了有反应"，而是**磁盘上真的出现了一个 .txt，且内容与这条记录的正文对得上**。
  // 列表里的正文被截断到 500 字符，故要在命中一条长文本时跑才完整：
  //   node test/manual/probe-ui-v1.mjs --url "/ui_v1/?types=Text&search=LLLL"
  //
  // 必须**自己重新导航一次**：前面的 IME 段收尾会清空搜索（列表回到无筛选状态），
  // 直接点第一行会点到另一条记录。
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
      const files = readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload'));
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

  // ===== 失败路径的「重试」 =====
  // 用 `Network.emulateNetworkConditions({ offline: true })` 把下一次列表请求打成网络失败，
  // 再点提示条里的「重试」看列表是否恢复（真实的瞬时故障没法按需出现）。
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
    // 顺带读一眼顶栏那枚状态图标：断网后推送通道会掉线，图标应从广播/信号（live）换成刷新箭头（offline），
    // 而 hover 文案（title）从"实时推送"换成"轮询刷新"。
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

  // ===== 有结果时的一键复位筛选 =====
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
      // 「按钮明显不明显」也有计算值可量：旧版（btn--quiet）边框 0px、背景全透明、颜色是次要色，
      // 与紧挨着的说明文字同色，读起来不是按钮。
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

  // ===== 范围切换时的工具栏抖动 =====
  // 切换**范围**会换掉整份类型计数，`countsForView` 的守卫在新计数到达前把五个 chip 的计数清空
  // → 分段控件变窄 → 搜索框与 spacer 分走腾出的宽度 → 下一帧再弹回。修法是给计数槽定宽。
  // 判据是"**同一份数据内**帧间有没有大跳"（闪 = 一跳一弹），不是"末态与初态是否相同"。
  const toolbarShift = await read(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const widthOf = (selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? -1);
    const box = () => ({ search: widthOf('.toolbar__group--search'), types: widthOf('.toolbar__group--types') });
    const recycleButton = [...document.querySelectorAll('.segmented__item')].find((b) => (b.textContent ?? '').includes('回收站'));
    if (!recycleButton) return JSON.stringify({ skipped: '找不到回收站按钮' });

    const counts = () => [...document.querySelectorAll('.segmented__item')].map((b) => b.textContent.trim()).join('|');
    const before = box();
    const beforeCounts = counts();
    recycleButton.click();
    const during = box();   // 同步重绘之后、统计回来之前 —— 也就是"闪"的那一帧
    const duringCounts = counts();
    await wait(80);
    const after80 = box();
    const after80Counts = counts();
    await wait(1500);
    const settled = box();
    const settledCounts = counts();
    // 收尾：再点一次回到原来的范围（后面的步骤默认在活跃列表上跑）
    recycleButton.click();
    await wait(1500);

    // ⚠️ 判据按**计数文本**分帧：只比较"相邻两帧的计数完全相同"的那几对，跨数据的那一跳单列
    // （本地服务器 80ms 内就返回了，after80 已经带着新计数）。
    const frames = [
      { key: 'before', box: before, counts: beforeCounts },
      { key: 'during', box: during, counts: duringCounts },
      { key: 'after80', box: after80, counts: after80Counts },
      { key: 'settled', box: settled, counts: settledCounts },
    ];
    let jitter = { search: 0, types: 0 };
    for (let i = 1; i < frames.length; i += 1) {
      if (frames[i].counts !== frames[i - 1].counts) continue;
      jitter = {
        search: Math.max(jitter.search, Math.abs(frames[i].box.search - frames[i - 1].box.search)),
        types: Math.max(jitter.types, Math.abs(frames[i].box.types - frames[i - 1].box.types)),
      };
    }
    // 预算 20px：修前的第一跳是 50（搜索框）/ 99（类型组）。
    const budget = 20;
    return JSON.stringify({
      before, during, after80, settled,
      counts: { before: beforeCounts, during: duringCounts, after80: after80Counts, settled: settledCounts },
      searchDelta: jitter.search,
      typesDelta: jitter.types,
      settledDelta: { search: Math.abs(settled.search - before.search), types: Math.abs(settled.types - before.types) },
      ok: jitter.search <= budget && jitter.types <= budget,
    });
  })()`);
  console.log('TOOLBARSW', toolbarShift);
  {
    const t = JSON.parse(toolbarShift);
    check(
      '切换范围时工具栏不抖（同一份计数内的帧间位移 ≤ 20px）',
      t.ok === true,
      `抖动 search=${t.searchDelta} types=${t.typesDelta}（跨数据那一跳是计数变化：${JSON.stringify(t.settledDelta)}）`,
    );
  }

  // ===== 顶栏「复制最近一条」 =====
  // 三件事：按钮真的把内容写进了剪贴板（逐字对照第一行的正文）、提示条报了条数、
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

  // ===== 状态图标的三个字形 =====
  // 顶栏那枚胶囊里状态只由**图标**承载（文字只写"部署信息"），故三个字形必须真的会换。
  // 刺激用应用自己认的那个事件：`visibilitychange` → 隐藏时 `pushChannel.stop()` → 状态转 offline，
  // 回前台再 start()。比"断网"可靠：断网掐不掉已经建立的 WebSocket。
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
    // 三条断言各有理由：① 点了要有反应（本地就地更新，不等下一次轮询）；② 服务端要真的落了；
    // ③ 要能切回去（净零）。
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

    // 批量动作后的「焦点不被抢回」：`list.restoreFocus()` 会把焦点交给结果区，它带着一圈 ~0.5s 的
    // 重试（用于等浏览器关闭模态后的补焦）—— 那一圈**不能**把用户自己放好的焦点抢回来。
    // 没有这道守卫时，`document.activeElement` 会变成表头的全选框。
    const focusKeep = await read(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!document.querySelector('tbody tr.row')) return JSON.stringify({ skipped: 'no rows' });
      const search = document.querySelector('.toolbar input.input--search');
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

    // 置顶（列表**恒置顶优先**，见 src/ui/query.ts 的 pinnedFirst）验三件连起来的事：
    //   ① 服务端真的落了 pinned=true（否则只是画得对）；② 徽标就地出现（不等下一次整页刷新）；
    //   ③ 这一行真的挪到了置顶组里（按下前在它上面的行现在全是置顶的），且按回去之后整表顺序**逐行还原**。
    // 取「页内最后一个未置顶」的行：第 1 行本来就在最前、证明不了"会移动"；而库里已经有一批置顶记录时，
    // 随便取第 4 行会取到**已置顶**的行 —— 那一下是按"取消置顶"，行会往下走，断言方向就反了。
    const pinCheck = await read(`(async () => {
      const rows = () => [...document.querySelectorAll('.table tr.row')];
      const order = () => rows().map((r) => r.dataset.key);
      const before = order();
      const isPinned = (r) => r.querySelector('[data-action="pin"]')?.getAttribute('aria-pressed') === 'true';
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

    // 部署信息：并进了顶栏那枚**状态胶囊**，故按 aria-label **包含**「部署信息」来找（前缀随状态变）
    await send('Page.navigate', { url: `${BASE}/ui_v1/` });
    await wait(2500);
    await read(
      `[...document.querySelectorAll('.app-header__actions button')]
        .find((b) => (b.getAttribute('aria-label') ?? '').includes('部署信息'))?.click(), 'clicked'`,
    );
    await wait(900);
    await runAudit('info-dialog');
    await shot('04-info');
    // 保留策略那段说明的判据在**默认流程**里（见 RETENTION-NOTE 段）。
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
    // 只能靠真实鼠标移动来验（手工加个类或改样式是"我让它展开的"，验不到 `:hover` 这条真正的路径）。
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
      if (!COARSE) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: footerBox.x, y: footerBox.y });
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
          // 文案改成项目名之后，"它会开到哪"只剩 title 这一条通道：可访问名仍是可见文字，
          // title 只作描述与悬停提示。
          triggerTitle: box?.querySelector('.footer-links__trigger')?.getAttribute('title') ?? null,
          panelVisible: cs ? cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.9 : null,
          // 面板必须在触发器的**上方**（用户要的"向上拉"）：面板下边缘 ≤ 触发器上边缘
          aboveTrigger: r && triggerRect ? Math.round(r.bottom) <= Math.round(triggerRect.top) : null,
          insideViewport: r ? r.left >= 0 && r.right <= window.innerWidth : null,
          // 面板要**贴着入口**（锚页脚整块时中间会空出一条带子）
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

    // 分页区单独一张：窄屏下它曾经折成四行、两个按钮各占一整行（判据看 `PAGER` 行）。
    // **必须先把指针移开**：上一步的悬停还开着致谢面板，它会正好盖住分页区（拍出来是废图）。
    if (!COARSE) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
    await wait(400);
    await read(`(() => {
      document.querySelector('.pagination')?.scrollIntoView({ block: 'center' });
      return 'scrolled';
    })()`);
    await wait(400);
    await shot('08-pager');
  }

  // 判据空转的出口：凡不是"前提如此"的 skipped，一律算判据失效。放在 SUMMARY 之前 —— 它自己也进 findings。
  const badSkips = skips.filter((s) => !SKIP_IS_PRECONDITION.some((re) => re.test(s)));
  check('没有判据在空转（skipped 只能来自环境/数据前提）', badSkips.length === 0, JSON.stringify(badSkips));
  console.log('SKIPPED ', skips.length ? JSON.stringify(skips) : 'none');
  console.log('CONSOLE ERRORS', consoleErrors.length ? consoleErrors : 'none');
  console.log('FAILED REQUESTS', failedRequests.length ? failedRequests : 'none');
  console.log('AUDIT SUMMARY', auditFindings.length === 0 ? 'findings=0' : JSON.stringify(auditFindings));
  process.exitCode = auditFindings.length === 0 ? 0 : 1;
} finally {
  close();
}
