// 首帧前把主题与密度定下来：深色用户不该先看到一瞬白屏，紧凑模式的用户也不该看到行高先跳一下。
//
// 三条不能改的形态：
//   1. 必须是**阻塞式经典脚本**（放在 <head>、无 type="module"）—— module 默认 defer，
//      要等 HTML 解析完才执行，那就正好晚于首帧。
//   2. 独立成文件而不是内联：只有外链脚本才能让 CSP 保持 `script-src 'self'`，
//      不必开 'unsafe-inline'、也不必维护内联脚本的 hash。
//   3. 不读 `getComputedStyle`（V1 的写法）：本文件与 `theme.js` 都用**显式映射**，
//      代价是 `--bg` 在这里重复一次。⚠️ 原注释给的理由是「此刻样式表还没加载、查不到值」——
//      **2026-09-20 实测证伪**：两版都把这个脚本放在全部 `<link>` **之后**，而经典阻塞
//      脚本会等前置样式表 ⇒ `getComputedStyle` 在 `readyState` 还是 `loading` 时就读到了
//      `--bg`（那次读数取自 **V1 的探针**：读到 `#191817`，那是 V1 `tokens.css` 的深色 `--bg`，
//      5 张样式表已加载；本文件这一版的两个值是 `tokens-v2.css` 的 `#15191a` / `#f5f2ee`。
//      见 `docs/progress.md` §94 第 17 行）。
//      显式映射**仍然是对的**（不依赖加载时序），但它不是「唯一可行」的那条路。
(function () {
  // 与 `tokens-v2.css` 的 `--bg` 必须一致。这是本文件唯一一处重复。读计算值那条路**其实可用**
  // （实测见文件头第 3 条），这里选显式映射是为了**不依赖加载时序** —— 是取舍，不是被迫。
  var BG = { light: '#f5f2ee', dark: '#15191a' };
  var THEME_KEY = 'sb-ui-theme';
  var DENSITY_KEY = 'sb-ui-density';

  var root = document.documentElement;

  try {
    var saved = localStorage.getItem(THEME_KEY);
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light';
    root.dataset.theme = theme;

    // 让浏览器 UI（移动端顶栏/状态栏）跟随**生效**主题，而不是只跟随系统
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BG[theme]);
  } catch (err) {
    root.dataset.theme = 'light';
  }

  // 紧凑模式：只写 `data-density`，行高由 `tokens-v2.css` 的令牌切换（组件层不感知）
  try {
    if (localStorage.getItem(DENSITY_KEY) === 'compact') root.dataset.density = 'compact';
  } catch (err) {
    /* 隐私模式下 localStorage 可能抛错：忽略，用默认密度 */
  }
})();
