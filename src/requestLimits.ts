// 请求体上限（F9）。单独成模块的原因：Worker 入口模块（src/index.ts）的**额外导出**会被运行时
// 当成 handler map 校验（`Incorrect type for map entry ...: the provided value is not of type
// 'function or ExportedHandler'`，wrangler dev 直接起不来），故入口只能导出 default 与 DO 类。

// 整包读入内存的写端点（PUT /SyncClipboard.json、POST /api/history、PATCH /api/history/*）的体量上限。
// 默认 **48 MiB**（2026-09-15 定稿：先由 32 提到 64，再按"并发余量"回落到 48）。依据与推导见
// README「为什么默认 48 MiB、上限 64 MiB」：真正的约束不是"平台单请求 100 MiB"，而是
// **isolate 128 MiB 且被并发共享** —— 默认值贴着"实际会发生的大小"取，才留得住并发余量。
export const MAX_REQUEST_BODY_BYTES = 48 * 1024 * 1024;

// 可由 GitHub 仓库变量 `MAX_REQUEST_BODY_BYTES` 覆盖（2026-09-15 接线，见 README「部署开关」）。
// 场景：官方客户端的 `MaxFileByte` 默认上限远大于它（客户端默认 20 MB，可调到 GB 级）——
// 客户端允许传、服务端却回 413，想同步更大的文件时必须有办法调大，否则只能改代码重部署。
export const MAX_REQUEST_BODY_BYTES_FLOOR = 256 * 1024; // 256 KiB：再小会连正常文本/小文件都拒
// 64 MiB：`100 MiB` 的平台上限之下留 36 MiB 余量。不上 80：65–80 MiB 那一段里 Group 解压预算
// 只剩 ≤16 MiB（body 越大解压预算越小），本来就是名存实亡的一档，不值得为它牺牲并发余量。
export const MAX_REQUEST_BODY_BYTES_CEILING = 64 * 1024 * 1024;

// **单个请求的工作集预算**（= 请求体 + 解压后内容），isolate 128 MiB 里留 ~32 MiB 给运行时与并发。
// 为什么需要这个数：Group（文件夹）上传时 zip 的**压缩体与解压内容同时存活**（`parseGroupZip` 边解压
// 边把条目内容留在 `contents` 里），所以两个上限**不能当互不相干**地各自贴顶
// （80 MiB body + 64 MiB 解压 = 144 MiB > 128 MiB，那会在解压中途 OOM，而不是被 413/上限干净拒绝）。
// 于是解压预算随请求体动态收缩：见 hash.ts 的 `groupZipDecompressionCap`。
export const ISOLATE_TRANSFER_BUDGET_BYTES = 96 * 1024 * 1024;

let overrideWarned = false;

/**
 * 解析生效的请求体上限。**只在 [FLOOR, CEILING] 内且为整数时采用变量值**，
 * 其余（未设置 / 非整数 / 越界）一律**回落默认值**并打一次日志。
 *
 * 为什么这里不 fail-closed：这个上限本身就是"防止 isolate OOM"的护栏 —— 若因为配置写错而让
 * 所有写请求 500，那是把配置失误升级成全站不可用，比"忽略这个配置"更糟。
 */
export function maxRequestBodyBytes(env: { MAX_REQUEST_BODY_BYTES?: string }): number {
  const raw = (env.MAX_REQUEST_BODY_BYTES ?? '').trim();
  if (raw === '') return MAX_REQUEST_BODY_BYTES;
  const parsed = Number(raw);
  if (
    Number.isInteger(parsed) &&
    parsed >= MAX_REQUEST_BODY_BYTES_FLOOR &&
    parsed <= MAX_REQUEST_BODY_BYTES_CEILING
  ) {
    return parsed;
  }
  if (!overrideWarned) {
    overrideWarned = true;
    console.warn(
      '[limits] MAX_REQUEST_BODY_BYTES 取值无效，已回落默认值：' +
        `raw='${raw}' 允许范围=${MAX_REQUEST_BODY_BYTES_FLOOR}..${MAX_REQUEST_BODY_BYTES_CEILING} ` +
        `默认=${MAX_REQUEST_BODY_BYTES}`,
    );
  }
  return MAX_REQUEST_BODY_BYTES;
}

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
