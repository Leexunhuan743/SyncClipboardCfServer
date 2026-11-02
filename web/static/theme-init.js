// 首帧主题：阻塞式**经典脚本**（不是 module），在 <head> 里同步执行，避免先闪一帧默认风格/白屏。
// 外链而非内联：CSP 是 `script-src 'self'`，内联脚本会被拒。用 var 写法：不经过任何转换，依赖最小。
// 风格表必须与 src/theme.ts 的 STYLES 一致（test/ui-guard.test.ts 守着）。
(function () {
  // 标签页图标随风格 / 明暗变：每套风格的图标都呼应它自己的品牌标记（themes.css 的 .brand__mark）。
  // 先写 SVG（立即生效），再异步栅格化成 PNG 给不支持 SVG 图标的浏览器（Safari）。
  // 暴露成全局函数，运行期切换风格时由 src/theme.ts 调用同一份实现，不另抄一份调色板。
  var GLYPH =
    '<rect x="5.2" y="6.4" width="13.6" height="12.4" rx="2.4" fill="none" stroke="C" stroke-width="1.5"/>' +
    '<path d="M9.4 6.6v-.5c0-.6.5-1.1 1.1-1.1h3c.6 0 1.1.5 1.1 1.1v.5M8.8 11.2h6.4M8.8 14.6h4" fill="none" stroke="C" stroke-width="1.5" stroke-linecap="round"/>';
  function faviconSvg(style, dark) {
    var g = function (c) { return GLYPH.split('C').join(c); };
    var body;
    if (style === 'coast') {
      body = '<circle cx="12.9" cy="12.6" r="10.6" fill="#E8583A"/><circle cx="12" cy="12" r="10.6" fill="#EBA54A"/>' + g('#1f2a40');
    } else if (style === 'paper') {
      body = '<rect x="1" y="1" width="22" height="22" rx="8" fill="#B24A25"/>' + g('#FFF8EC');
    } else if (style === 'pop') {
      body = '<rect x="2.6" y="2.6" width="20.4" height="20.4" rx="2" fill="#F0603A"/><rect x="1" y="1" width="20.4" height="20.4" rx="2" fill="#2B3A5C"/>' + g('#F7F2E6');
    } else {
      body = '<rect x="1" y="1" width="22" height="22" rx="5" fill="' + (dark ? '#7b8cff' : '#4c5fef') + '"/>' + g(dark ? '#0d111f' : '#fff');
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + body + '</svg>';
  }
  // 浏览器对「改已有 <link rel=icon> 的 href」并不总会刷新标签页图标（Chrome 在同时存在多个 icon 时尤其明显），
  // 所以每次都**删掉旧的、新建一个**，并且始终只留一个：先放 SVG（立即生效），栅格化完成后换成 PNG（Safari 也认）。
  function putIcon(type, href) {
    var head = document.head;
    var old = head.querySelectorAll('link[rel~="icon"]');
    for (var i = 0; i < old.length; i++) head.removeChild(old[i]);
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = type;
    link.href = href;
    head.appendChild(link);
  }
  var faviconTicket = 0;
  window.__clipFavicon = function (style, dark) {
    try {
      var ticket = ++faviconTicket;
      var uri = 'data:image/svg+xml,' + encodeURIComponent(faviconSvg(style, dark));
      putIcon('image/svg+xml', uri);
      var img = new Image();
      img.onload = function () {
        if (ticket !== faviconTicket) return; // 期间又切了风格：这张已过期
        try {
          var canvas = document.createElement('canvas');
          canvas.width = canvas.height = 64;
          canvas.getContext('2d').drawImage(img, 0, 0, 64, 64);
          putIcon('image/png', canvas.toDataURL('image/png'));
        } catch (err) { /* 画布不可用：保留 SVG */ }
      };
      img.src = uri;
    } catch (err) { /* 图标只是点缀：失败就保留静态图标 */ }
  };

  try {
    var STYLES = { coast: ['dark', '#1f2a40'], paper: ['light', '#F2E8D2'], pop: ['light', '#EDE4D2'] };
    var style = localStorage.getItem('clip-style');
    if (!STYLES[style]) style = 'default';
    var saved = localStorage.getItem('clip-theme');
    var mode = saved === 'dark' || saved === 'light' ? saved : 'system';
    var dark;
    var chrome;
    if (style === 'default') {
      dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      chrome = dark ? '#0d111f' : '#f5f6fa';
    } else {
      dark = STYLES[style][0] === 'dark';
      chrome = STYLES[style][1];
    }
    var root = document.documentElement;
    root.dataset.style = style;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themeMode = mode;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', chrome);
    window.__clipFavicon(style, dark);
  } catch (err) {
    document.documentElement.dataset.theme = 'light';
  }
})();
