// 界面命名空间（`/ui`）下未匹配路径的 404 页。
//
// 只对界面前缀生效：协议路径（`/api/*`、`/SyncClipboard.json`、`/file/*`）的 404 语义是
// 客户端依赖的契约（例如 `GET /api/history/{id}/data` 缺数据必须 404），不能换成 HTML 页面。
//
// 这一页由 Worker 直接出（不经静态资源层），样式全部内联在下面的 `<style>` 里，
// 不依赖界面的任何 CSS —— 界面资源本身 404 时，这一页仍然自洽。
// 图标取 `/ui/brand/`。

const HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>页面不存在 · 剪贴板历史</title>
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow" />
    <link rel="icon" href="/ui/brand/favicon.svg" type="image/svg+xml" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f6f7fb;
        --ink: #151a2d;
        --ink-muted: #5a6280;
        --accent: #4c5fef;
        --accent-ink: #fff;
        --surface-3: #e7eaf4;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #0e1220; --ink: #eef0fa; --ink-muted: #9aa3c2; --accent: #7a8bff; --accent-ink: #0b0f22; --surface-3: #232a44; }
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .wrap {
        max-width: 30rem;
        margin: 0 auto;
        padding: 16vh 1.5rem 0;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        align-items: flex-start;
      }
      .wrap h1 { font-size: 1.5rem; }
      .wrap p { color: var(--ink-muted); line-height: 1.7; }
      .wrap code {
        font-family: var(--font-mono);
        font-size: 0.9em;
        background: var(--surface-3);
        padding: 1px 5px;
        border-radius: 4px;
      }
      .wrap a.home {
        display: inline-flex;
        align-items: center;
        height: 34px;
        padding: 0 1rem;
        border-radius: 6px;
        background: var(--accent);
        color: var(--accent-ink);
        font-size: 0.8125rem;
        font-weight: 500;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <h1>这个地址没有页面</h1>
      <p>
        剪贴板历史在 <a href="/ui/">/ui/</a>。
        SyncClipboard 客户端用的接口在站点根路径（<code>/SyncClipboard.json</code>、
        <code>/api/history/*</code>、<code>/file/*</code>）。
      </p>
      <a class="home" href="/ui/">返回剪贴板历史</a>
    </main>
  </body>
</html>
`;

export function notFoundPage(): Response {
  // 这一页由 Worker 出（不是静态资源），拿不到 `public/_headers` 里的那套头，故在这里单独补齐。
  // 它没有任何脚本，故 `script-src 'none'`；一段内联 `<style>` 是这页唯一的样式 ——
  // 与其为它开 `'unsafe-inline'` 去放宽整站策略，不如就地允许（这页不含任何用户数据）。
  return new Response(HTML, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
