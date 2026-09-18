// `/ui/*` 下未匹配路径的 404 页。
//
// 只对 UI 命名空间生效：协议路径（/api/*、/SyncClipboard.json、/file/*）的 404 语义是
// 客户端依赖的契约（例如 GET /api/history/{id}/data 缺数据必须 404），不能换成 HTML 页面。
//
// 不引入静态资源绑定：页面直接引用已经托管在 /ui/css/ 的样式表，省掉一个 ASSETS 绑定与一次
// 内部 fetch。代价只是这段 HTML 内联在 Worker 里（~20 行）。
import { Bindings } from '../env';

const HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>页面不存在 · 剪贴板历史</title>
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow" />
    <link rel="icon" href="/ui/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/ui/css/tokens.css" />
    <link rel="stylesheet" href="/ui/css/base.css" />
    <link rel="stylesheet" href="/ui/css/components.css" />
  </head>
  <body>
    <main class="main" style="max-width: 560px; padding-top: 12vh">
      <h1>这个地址没有页面</h1>
      <p style="color: var(--ink-muted)">
        你要找的界面不在 <code class="mono">/ui/</code> 下。历史记录在
        <a href="/ui/">/ui/</a>，SyncClipboard 客户端用的接口在站点根路径
        （<code class="mono">/SyncClipboard.json</code>、<code class="mono">/api/history/*</code>、
        <code class="mono">/file/*</code>）。
      </p>
      <div class="empty__actions">
        <a class="btn btn--primary" href="/ui/"><span class="btn__label">返回历史记录</span></a>
      </div>
    </main>
  </body>
</html>
`;

export function notFoundPage(_env: Bindings): Response {
  return new Response(HTML, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}
