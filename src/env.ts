// Cloudflare Workers 绑定类型（wrangler.toml 声明）
export interface Bindings {
  DB: D1Database;
  R2: R2Bucket;
  HUB: DurableObjectNamespace;
  // 静态资源（`[assets] binding = "ASSETS"`）。因为
  // `[assets] run_worker_first = ["/ui", "/ui/*", "/ui_v1", "/ui_v1/*", "/ui_v2", "/ui_v2/*"]`，
  // 三个界面前缀（`public/ui_v1/*`、`public/ui_v2/*`、`public/ui/*`）的请求会**先进 Worker**：
  // 开关开着时由入口转回 `ASSETS.fetch()`，关着时直接 404。
  ASSETS: Fetcher;
  VERSION: string;
  MAX_SAVED_HISTORY_COUNT: string;
  HISTORY_RETENTION_MINUTES: string;
  USERNAME: string;
  PASSWORD: string;
  // 弱凭据硬失败开关（F1）。默认关：线上当前使用的就是文档化默认口令，硬失败会直接切断同步；
  // 置为 'true' 时，命中弱值的凭据一律 500（fail-closed），用于轮换完成后的强制收紧。
  ENFORCE_STRONG_CREDENTIALS?: string;
  // Web 界面开关（GitHub 仓库变量 UI_ENABLED）。**只有显式 'false' 才关**，其余（含未设置）为开。
  // 判定与用法见 src/uiEnabled.ts。
  UI_ENABLED?: string;
  // 整包读入内存的写端点上限（默认 48MiB，可调到 64MiB）。越界/非法值**回落默认**（见 src/requestLimits.ts）。
  MAX_REQUEST_BODY_BYTES?: string;
  // 认证失败限速四参数。**不建议改**（防御性默认值经过实测标定，见 src/rateLimit.ts 与 README）；
  // 非法/越界值逐字段回落默认。DO 与 Worker 读同一套取值。
  AUTH_RATE_LIMIT_WINDOW_MS?: string;
  AUTH_RATE_LIMIT_MAX_FAILURES?: string;
  AUTH_RATE_LIMIT_BLOCK_MS?: string;
  AUTH_RATE_LIMIT_BURST_WARN?: string;
}
