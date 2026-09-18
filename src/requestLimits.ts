// 请求体上限（F9）。单独成模块的原因：Worker 入口模块（src/index.ts）的**额外导出**会被运行时
// 当成 handler map 校验（`Incorrect type for map entry ...: the provided value is not of type
// 'function or ExportedHandler'`，wrangler dev 直接起不来），故入口只能导出 default 与 DO 类。

// 整包读入内存的写端点（PUT /SyncClipboard.json、POST /api/history、PATCH /api/history/*）的体量上限。
// 取值依据：官方客户端默认文件上限 20MB（docs/protocol.md §7），32MiB 留出余量；平台侧 Free/Pro 的
// 请求体硬上限是 100MB，而 isolate 内存只有 128MB —— 放行接近 100MB 的体会在 multipart 解析期
// 直接 OOM（那是全站不可用，比 413 严重得多）。需要用更大文件同步时，应连同上游客户端上限一起评估。
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

// 本地回环 host 判定（F8 的明文跳转/HSTS 与 F7 的失败限速共用同一套判定，避免两处漂移）。
// 依据：生产流量一律经边缘进入（Host 是部署域名，且 cf-connecting-ip 由 Cloudflare 覆写、客户端不可伪造），
// 因此「来自 loopback」只可能是本地开发/测试；对这类请求做 https 升级或失败封锁只会自伤，不增加防护。
const LOOPBACK_HOSTS: Record<string, true> = {
  '127.0.0.1': true,
  localhost: true,
  '[::1]': true,
  '::1': true,
};

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS[host.toLowerCase()] === true;
}

export function isLoopbackRequest(request: Request): boolean {
  return isLoopbackHost(new URL(request.url).hostname);
}
