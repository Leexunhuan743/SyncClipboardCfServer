// 首帧前把主题定下来：深色用户不该先看到一瞬白屏。
//
// 两条不能改的形态：
//   1. 必须是**阻塞式经典脚本**（放在 <head>、无 type="module"）——module 默认 defer，
//      要等 HTML 解析完才执行，那就正好晚于首帧。
//   2. 独立成文件而不是内联：只有外链脚本才能让 CSP 保持 `script-src 'self'`，
//      不必开 'unsafe-inline'、也不必维护内联脚本的 hash。
(function () {
  try {
    var saved = localStorage.getItem('sb-ui-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    // 让浏览器 UI（移动端顶栏/状态栏）跟随生效主题，而不是只跟随系统
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = meta && getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.setAttribute('content', bg);
  } catch (err) {
    document.documentElement.dataset.theme = 'light';
  }
})();
