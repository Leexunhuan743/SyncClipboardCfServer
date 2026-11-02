// 全局错误处理：把「D1 免费额度用完」从一个裸 500 变成可读的 503。
//
// 背景：D1 免费计划每天最多读 500 万行，超了之后**所有**需要读行的查询都会被平台拒绝，直到 UTC 0 点才恢复
// （线上真发生过：错误是 `Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or
// wait until tomorrow (midnight UTC)`）。此前这类错误落进 Hono 的默认处理 ⇒ 一个没有任何说明的 500 ⇒ 界面显示
// 「加载失败」、官方客户端当成服务器故障乱重试，没人知道真正的原因，也不知道何时会好。
// 503 + `Retry-After`（距 UTC 0 点的秒数）+ 一句人话：界面能原样显示，客户端也知道这是「稍后再试」。
import type { Context } from 'hono';

// 平台报错的措辞可能随版本微调：认「D1 的免费额度」「每日行读 / 行写上限」这几个稳定的关键词，不认整句。
const QUOTA_PATTERN = /(exceeded D1|D1'?s free tier|free tier daily row|daily row (read|written|write) limit)/i;

/** 沿 cause 链取若干层 message，判断是不是 D1 额度错误。 */
export function isD1QuotaError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const message = (cur as { message?: unknown }).message;
    if (typeof message === 'string' && QUOTA_PATTERN.test(message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** 距离下一个 UTC 0 点（免费额度重置）还有多少秒，至少 1。 */
export function secondsUntilUtcMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

export function quotaExceededResponse(now = Date.now()): Response {
  return Response.json(
    {
      error: 'd1_quota_exceeded',
      detail: '今天的 Cloudflare D1 免费读取额度已用完，服务暂时读不了数据；UTC 0 点（北京时间早上 8 点）自动恢复。',
    },
    { status: 503, headers: { 'retry-after': String(secondsUntilUtcMidnight(now)), 'cache-control': 'no-store' } },
  );
}

/** `app.onError` 用：额度错误 → 503；其它错误保持 Hono 默认行为（500 纯文本），并留一条日志。 */
export function handleAppError(err: unknown, c: Context): Response {
  if (isD1QuotaError(err)) {
    console.warn('[quota] D1 daily row limit exceeded:', c.req.method, new URL(c.req.url).pathname);
    return quotaExceededResponse();
  }
  console.error('[error]', c.req.method, new URL(c.req.url).pathname, err instanceof Error ? err.message : String(err));
  return c.text('Internal Server Error', 500);
}
