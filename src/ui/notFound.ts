// 界面命名空间（`/ui`、`/ui_v1`、`/ui_v2`）下未匹配路径的 404 页。
//
// 只对界面前缀生效：协议路径（`/api/*`、`/SyncClipboard.json`、`/file/*`）的 404 语义是
// 客户端依赖的契约（例如 `GET /api/history/{id}/data` 缺数据必须 404），不能换成 HTML 页面。
//
// 四个前缀共用这一张：它是**站点的** 404，不属于任何一版界面。代价是它的样式取自
// `/ui_v2/css/*`（V2 的设计系统）—— 为一页 404 在两套设计系统里各写一份才是浪费。
// 页内那个"返回剪贴板历史"指向**默认界面**（`/ui_v1/`，2026-09-18 起的定位，见 ADR D17）。
// 图标取 `/ui_shared/brand/`（两版共用面，2026-09-21 起品牌图标在那里）。
//
// ⚠️ **类名刻意不用 BEM 形态**（`page404__title` 之类）：`test/ui-contract.test.ts` 的
// 「CSS 定义但无人使用的类必须为零」守卫只采集 `block__element` / `block--modifier` 形态。
// 这一页的样式全部内联在下面的 `<style>` 里（它由 Worker 出，不经过静态资源层），
// 若用 BEM 命名就会被那道守卫抽到、再因为"两份 HTML 里没有它"而报死规则。
// 这是刻意的形态选择，不是疏漏。

const HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>页面不存在 · 剪贴板历史</title>
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow" />
    <link rel="icon" href="/ui_shared/brand/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/ui_v2/css/tokens-v2.css" />
    <link rel="stylesheet" href="/ui_v2/css/base-v2.css" />
    <style>
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
        你要找的界面不在这个地址下。剪贴板历史在 <a href="/ui_v1/">/ui_v1/</a>（默认界面），
        开发测试版在 <code>/ui_v2/app/</code>，
        SyncClipboard 客户端用的接口在站点根路径（<code>/SyncClipboard.json</code>、
        <code>/api/history/*</code>、<code>/file/*</code>）。
      </p>
      <a class="home" href="/ui_v1/">返回剪贴板历史</a>
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
        "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
