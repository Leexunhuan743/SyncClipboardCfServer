// Cloudflare Workers 绑定类型（wrangler.toml 声明）
export interface Bindings {
  DB: D1Database;
  R2: R2Bucket;
  HUB: DurableObjectNamespace;
  VERSION: string;
  MAX_SAVED_HISTORY_COUNT: string;
  HISTORY_RETENTION_MINUTES: string;
  USERNAME: string;
  PASSWORD: string;
  // 弱凭据硬失败开关（F1）。默认关：线上当前使用的就是文档化默认口令，硬失败会直接切断同步；
  // 置为 'true' 时，命中弱值的凭据一律 500（fail-closed），用于轮换完成后的强制收紧。
  ENFORCE_STRONG_CREDENTIALS?: string;
}
