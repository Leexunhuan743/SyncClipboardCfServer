// 首帧前把主题与密度定下来：深色用户不该先看到一瞬白屏，紧凑模式的用户也不该看到行高先跳一下。
//
// 三条不能改的形态：
//   1. 必须是**阻塞式经典脚本**（放在 <head>、无 type="module"）—— module 默认 defer，
//      要等 HTML 解析完才执行，那就正好晚于首帧。
//   2. 独立成文件而不是内联：只有外链脚本才能让 CSP 保持 `script-src 'self'`，
//      不必开 'unsafe-inline'、也不必维护内联脚本的 hash。
//   3. 不读 `getComputedStyle`（V1 的写法）：**此刻样式表还没加载**，自定义属性查不到值，
//      于是 `theme-color` 永远停在 HTML 里那个静态值上。V2 改成显式映射，两行、且确定。
(function () {
  // 与 `tokens-v2.css` 的 `--bg` 必须一致。这是本文件唯一一处重复 —— 但另一条路（读计算值）
  // 因为时序原因在首帧根本不可用，所以这里是有意为之的重复，不是疏漏。
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
