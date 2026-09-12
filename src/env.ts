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
}
