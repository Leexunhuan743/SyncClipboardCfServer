// 认证失败限速（F7，docs/security-fix-plan.md §二·F7）
//
// 存储层设计（按 Main 的修正意见，**不用 D1**）：
//   - **权威计数在 Durable Object**：env.HUB 的单实例（`hubStub`），单线程长驻，天然串行化计数、跨 isolate 一致。
//     端点实现见 src/durable/SyncClipboardHub.ts 的 AUTH_RATE_LIMIT_PATH。
//   - **请求快路径只读 isolate 内存 Map**（O(1)、零 I/O）。正常同步路径——官方客户端每请求都带**正确** Basic——
//     既不计数也不产生任何额外往返；命中封锁直接 429，且**不进入凭据比较**（不泄露时序，也不能被绕过）。
//   - **只有失败才访问 DO**（成功路径仅在本地确有失败记录时才异步清一次），且一律经 `ctx.waitUntil` 投递，
//     不阻塞响应。否决 D1 方案的原因：失败路径每请求一次 D1 写 = 攻击者用错口令直接烧掉 D1 写入额度。
//   - **维度**：`ip:<cf-connecting-ip>` 与 `user:<用户名小写>` 各自独立计数与封锁（IP 轮换时凭据维度挡住；
//     同一 IP 换用户名时 IP 维度挡住）。另有**全局**失败计数，只用于告警、**绝不**用于封锁——
//     否则攻击者可以用垃圾请求把合法用户锁死。
//   - 未配置凭据的场景不会走到这里：authFailure 先返回 500（fail-closed）。
//
// 已知局限（取舍，非缺陷）：
//   - 跨 isolate 的权威封锁通过「热状态下每 ≥ SNAPSHOT_INTERVAL_MS 拉一次 DO 快照」传播，
//     拉取本身异步，故某个 isolate 对某个 key 的封锁最多滞后**一个请求**生效。
//     同一客户端 IP 稳定落在同一 colo，攻击者的失败必然把该 isolate 变热，故第 11 次失败起立即生效。
//   - DO 状态在重启/驱逐后可能丢失（低频落盘、尽力而为）：丢失等价于计数器归零，最坏情况是多给 10 次失败。

import { Bindings } from './env';
import { isLoopbackRequest } from './requestLimits';
import { hubStub } from './hub';

// 限速窗口：15 分钟（失败计数在此窗口内累计，窗口过期即重置）
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// 窗口内允许的失败次数：第 11 次请求命中封锁（阈值本身不封锁，留一次「最后一次机会」的语义）
export const AUTH_RATE_LIMIT_MAX_FAILURES = 10;
// 封锁时长：从触发封锁的那次失败起算
export const AUTH_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
// 全局失败告警阈值（只 console.warn，不封锁）
export const AUTH_RATE_LIMIT_BURST_WARN = 50;
// DO 侧内部端点（仅 Worker → DO 调用，不经外部路由暴露）
export const AUTH_RATE_LIMIT_PATH = '/auth-rate-limit';
// DO 侧低频落盘的 storage key（每 AUTH_RATE_LIMIT_PERSIST_EVERY_FAILURES 次失败或产生新封锁时落一次）
export const AUTH_RATE_LIMIT_STORAGE_KEY = 'authRateLimits';
export const AUTH_RATE_LIMIT_PERSIST_EVERY_FAILURES = 20;
// 热状态下拉取 DO 权威快照的最小间隔（避免被攻击流量放大成 DO 打点）
const SNAPSHOT_INTERVAL_MS = 5_000;
// 计数表容量上限：条目数超过它先清理过期项、再按最早窗口淘汰（防止随机 key 撑爆内存）
const MAX_TRACKED_KEYS = 4096;
const PRUNE_THRESHOLD = 256;

export interface AuthLimitState {
  windowStart: number;
  count: number;
  /** 0 = 未封锁；否则为封锁截止时间（epoch 毫秒） */
  blockedUntil: number;
}

export interface AuthRateLimitVerdict {
  retryAfterSeconds: number;
}

/** 只取 waitUntil：Hono 的 ExecutionContext 与 DurableObjectState 都满足 */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

// ===== 纯状态机（isolate 侧与 DO 侧共用同一套语义）=====

// 记一次失败：窗口内累加、窗口过期重置；达到阈值则开始封锁。
// 注意封锁只看 blockedUntil，与 count 是否被窗口重置无关（已封锁的 key 不会再走到这里：
// 预检会先 429，凭据比较不会发生，因此不存在「被封锁的 key 又被记一次失败」）。
export function applyAuthFailure(state: AuthLimitState | undefined, now: number): AuthLimitState {
  const sameWindow = state !== undefined && now - state.windowStart < AUTH_RATE_LIMIT_WINDOW_MS;
  const count = (sameWindow ? state.count : 0) + 1;
  const blockedUntil =
    count >= AUTH_RATE_LIMIT_MAX_FAILURES ? now + AUTH_RATE_LIMIT_BLOCK_MS : (state?.blockedUntil ?? 0);
  return { windowStart: sameWindow ? state.windowStart : now, count, blockedUntil };
}

export function isAuthLimitBlocked(state: AuthLimitState | undefined, now: number): boolean {
  return state !== undefined && state.blockedUntil > now;
}

export function authLimitRetryAfterSeconds(state: AuthLimitState, now: number): number {
  return Math.max(1, Math.ceil((state.blockedUntil - now) / 1000));
}

// 清理过期项 + 容量封顶（isolate 侧与 DO 侧共用）。仅在条目数超过阈值时做全表扫描，避免每请求 O(n)。
export function pruneAuthLimits(limits: Map<string, AuthLimitState>, now: number): void {
  if (limits.size <= PRUNE_THRESHOLD) return;
  for (const [key, state] of limits) {
    if (!isAuthLimitBlocked(state, now) && now - state.windowStart >= AUTH_RATE_LIMIT_WINDOW_MS) {
      limits.delete(key);
    }
  }
  if (limits.size <= MAX_TRACKED_KEYS) return;
  const byAge = [...limits.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
  for (let i = 0; i < byAge.length && limits.size > MAX_TRACKED_KEYS; i++) {
    limits.delete(byAge[i]![0]);
  }
}

// ===== isolate 侧缓存 =====

interface IsolateLimitCache {
  limits: Map<string, AuthLimitState>;
  /** 本 isolate 最近一次记录失败的时间（>0 即处于「热」状态：按间隔拉取 DO 快照） */
  lastFailureAt: number;
  lastSnapshotAt: number;
  lastBurstWarnAt: number;
}

const cache: IsolateLimitCache = {
  limits: new Map(),
  lastFailureAt: 0,
  lastSnapshotAt: 0,
  lastBurstWarnAt: 0,
};

// 限速维度键。IP 取 cf-connecting-ip（生产上由 Cloudflare 覆写、客户端不可伪造，故恒存在；
// 非生产路径若缺失则退化为固定串 `ip:unknown`——但 loopback 请求在 authLimitKeys 里已被整体豁免，
// 不会与之共用桶）。
// 导出：DO 侧的连接鉴权失败路径（WS/SSE/长轮询不走 Worker 的 authFailure）必须用同一套 key。
export function authLimitIpKey(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip');
  return `ip:${ip !== null && ip !== '' ? ip : 'unknown'}`;
}

// 凭据维度键：用户名不区分大小写（避免 `Admin` / `admin` 绕过同一个计数）。
export function authLimitUserKey(username: string | null): string | null {
  if (username === null || username === '') return null;
  return `user:${username.toLowerCase()}`;
}

export function authLimitKeys(request: Request, username: string | null): string[] {
  // 本地开发/测试（loopback）不参与限速：生产流量不可能来自 loopback。
  if (isLoopbackRequest(request)) return [];
  const keys: string[] = [];
  // **归因制**：只有拿到 cf-connecting-ip 才启用 IP 维度。该头在生产恒由 Cloudflare 覆写、
  // 客户端不可伪造；而缺头时若把所有请求塞进同一个 `ip:unknown` 桶，10 次错凭据就能把
  // **全部客户端**一起锁 15 分钟（限速是削峰控制、不是鉴权边界，鉴权仍由 Basic 门把关）。
  // 因此不可归因 ⇒ 不封锁（用户名维度若可得仍然生效，那是可归因的）。
  if (request.headers.get('cf-connecting-ip')) keys.push(authLimitIpKey(request));
  const userKey = authLimitUserKey(username);
  if (userKey !== null) keys.push(userKey);
  return keys;
}

// 预检：命中封锁返回裁决（调用方据此返回 429 + Retry-After），否则 null。
// **同步**：只读 isolate 内存；DO 快照经 ctx.waitUntil 异步补充，不阻塞本次响应。
export function checkAuthRateLimit(
  env: Bindings,
  request: Request,
  username: string | null,
  ctx?: WaitUntil,
): AuthRateLimitVerdict | null {
  const now = Date.now();
  const keys = authLimitKeys(request, username);
  for (const key of keys) {
    const state = cache.limits.get(key);
    if (isAuthLimitBlocked(state, now)) {
      return { retryAfterSeconds: authLimitRetryAfterSeconds(state!, now) };
    }
  }
  // 热状态（本 isolate 在窗口内见过失败）才拉 DO 快照：正常客户端完全不产生这次往返。
  const hot = cache.lastFailureAt > 0 && now - cache.lastFailureAt < AUTH_RATE_LIMIT_WINDOW_MS;
  if (ctx && hot && now - cache.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
    cache.lastSnapshotAt = now;
    ctx.waitUntil(syncWithHub(env, 'snapshot', keys, now));
  }
  return null;
}

// 记一次认证失败：本地立即计数（本 isolate 从第 11 次失败起即刻生效），并异步上报 DO 汇总。
export function noteAuthFailure(
  env: Bindings,
  request: Request,
  username: string | null,
  ctx?: WaitUntil,
): void {
  const now = Date.now();
  const keys = authLimitKeys(request, username);
  cache.lastFailureAt = now;
  for (const key of keys) {
    cache.limits.set(key, applyAuthFailure(cache.limits.get(key), now));
  }
  pruneAuthLimits(cache.limits, now);
  if (ctx) ctx.waitUntil(syncWithHub(env, 'report', keys, now));
}

// 认证成功：清除该 key 的失败计数（本地立即清；仅当本地确有记录时才通知 DO，正常同步路径零 I/O）。
export function noteAuthSuccess(
  env: Bindings,
  request: Request,
  username: string | null,
  ctx?: WaitUntil,
): void {
  const keys = authLimitKeys(request, username).filter((key) => cache.limits.delete(key));
  if (keys.length > 0 && ctx) ctx.waitUntil(callHub(env, 'clear', keys));
}

// ===== DO 交互（失败路径与快照，均不阻塞响应）=====

interface AuthLimitHubResult {
  blocks: Record<string, number>;
  burst: number;
}

function readBlocks(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || !('blocks' in value)) return {};
  const raw = value.blocks;
  if (typeof raw !== 'object' || raw === null) return {};
  const blocks: Record<string, number> = {};
  for (const [key, until] of Object.entries(raw)) {
    if (typeof until === 'number' && Number.isFinite(until)) blocks[key] = until;
  }
  return blocks;
}

function readBurst(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('burst' in value)) return 0;
  const burst = value.burst;
  return typeof burst === 'number' && Number.isFinite(burst) ? burst : 0;
}

// DO 不可达时静默降级：本地计数仍然生效（限速是纵深防御，不能因为存储故障把正常请求打成 5xx）。
async function callHub(
  env: Bindings,
  op: 'report' | 'snapshot' | 'clear',
  keys: string[],
): Promise<AuthLimitHubResult | null> {
  try {
    const res = await hubStub(env).fetch(`https://hub${AUTH_RATE_LIMIT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, keys }),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return { blocks: readBlocks(data), burst: readBurst(data) };
  } catch {
    return null;
  }
}

// 把 DO 的权威封锁合并进本地缓存（只升不降：本地已知的封锁时限不会被 DO 的短时限拉回）
function mergeBlocks(blocks: Record<string, number>, now: number): void {
  for (const [key, blockedUntil] of Object.entries(blocks)) {
    if (blockedUntil <= now) continue;
    const prev = cache.limits.get(key);
    cache.limits.set(key, {
      windowStart: prev?.windowStart ?? now,
      count: prev?.count ?? AUTH_RATE_LIMIT_MAX_FAILURES,
      blockedUntil: Math.max(prev?.blockedUntil ?? 0, blockedUntil),
    });
  }
  pruneAuthLimits(cache.limits, now);
}

// 全局失败量达到告警阈值时打一条显著日志（**不封锁**：阈值封锁会让攻击者能锁死合法用户）
function warnOnBurst(burst: number, now: number): void {
  if (burst < AUTH_RATE_LIMIT_BURST_WARN) return;
  if (now - cache.lastBurstWarnAt < AUTH_RATE_LIMIT_WINDOW_MS) return;
  cache.lastBurstWarnAt = now;
  console.warn('[security] credential guessing burst', { failuresInWindow: burst, windowMs: AUTH_RATE_LIMIT_WINDOW_MS });
}

async function syncWithHub(
  env: Bindings,
  op: 'report' | 'snapshot',
  keys: string[],
  now: number,
): Promise<void> {
  const result = await callHub(env, op, keys);
  if (result === null) return;
  mergeBlocks(result.blocks, now);
  if (op === 'report') warnOnBurst(result.burst, now);
}
