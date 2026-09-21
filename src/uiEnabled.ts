// Web 界面的部署开关（GitHub 仓库变量 `UI_ENABLED`，默认**开**）
//
// 为什么需要它：界面资源（`public/ui_v1/*`、`public/ui_v2/*`、`public/ui/*`、`public/ui_shared/*`）由 Cloudflare 托管，
// **但协议面（`/api/*`、`/SyncClipboard.json`、
// `/file/*`、Hub）完全不需要界面**。只想把它当纯协议服务端用（例如给别人一个同步后端、或不想暴露
// 登录页）时，应当能一键关掉界面，而不必去改仓库、也不必删静态资源。
//
// 关闭后的行为（有意保持"干脆"）：
//   - 四个界面前缀（`/ui/...`、`/ui_v1/...`、`/ui_v2/...`、`/ui_shared/...`，含静态资源）与接口命名空间
//     （`/ui/api/*`，含裸 `/ui/api`）一律 **404**；
//   - 根路径 `/` 对浏览器**不再 302 到 `/ui_v1/`**，而是与其它客户端一样返回 `Server is running.`；
//   - 协议面完全不受影响（`/api/version`、`/SyncClipboard.json`、`/file/*`、Hub 照常）。
//
// 判定口径：只认字符串 `'false'`（大小写与首尾空白无关）为关闭；未设置或其它值均为**开**。
// 这样"变量没配/配错"时行为退回线上的默认状态，而不是把界面意外关掉。
import type { Bindings } from './env';

export function isUiEnabled(env: Bindings): boolean {
  return (env.UI_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

/**
 * 关闭界面时的 404 体：`/ui/api/*` 用与 `src/ui/routes.ts` 兜底同形的 JSON，
 * 其余（页面与静态资源）用与协议 404 一致的纯文本 —— 不泄露"这里本来有个界面"。
 */
export function uiDisabledResponse(isApi: boolean): Response {
  return isApi
    ? Response.json({ error: 'not_found' }, { status: 404 })
    : new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
}
