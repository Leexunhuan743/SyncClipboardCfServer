// SignalR 兼容 Hub（Durable Object，docs/design.md §3）
// 持有客户端连接并广播；支持三种传输，与上游 ASP.NET Core SignalR 的宣告顺序一致：
//   WebSockets（首选）→ ServerSentEvents → LongPolling
// 另负责 negotiate 签发的 connectionToken 的登记与校验（上游 hub 类级 [Authorize] 的等价物）。
//
// 三种传输的连接模型：
//   ws  —— WebSocketPair + **Hibernation API**（`state.acceptWebSocket` 登记，事件走
//          `webSocketMessage` / `webSocketClose` / `webSocketError` 类方法），服务端主动 send/close
//   sse —— 挂起的流式响应（transform stream + writer），按 `data: <msg>\n\n` 帧写入
//   lp  —— 无状态轮询：GET 取消息（无消息则挂起至多 POLL_TIMEOUT_MS、或返回 204 表示服务端关闭），
//          POST 上报客户端消息，DELETE 关闭连接
// 三种传输共用同一套心跳（15s Ping）与静默清理（60s），因为客户端 ServerTimeout 对三者一致。
//
// ⚠️ WS **必须**走 Hibernation API：用标准 WS API（`server.accept()` + `addEventListener`）时
// 「No WebSocket standard API is used」这一条 hibernate 前置条件不成立 ⇒ 对象在**整个连接期间**
// 计 duration（官方 pricing 脚注 4：Calling `accept()` on a WebSocket in an Object will incur
// duration charges for the entire time the WebSocket is connected），与是否真被回收无关。
// 实测代价：本 DO 吃掉 Free 日额度的 84.5–85.5%（11,014–11,103 GB-s/天，activeTime 99.6%）；
// 迁移后同样的 15 s alarm 心跳下 duration 降到满额的 0.076–0.1%。
// 依据与回归面：docs/do-hibernation-plan.md §5 P1 / §8、docs/design.md D42。
// ⚠️ 两种 API **不可并用**：`acceptWebSocket` 之后 `addEventListener` 收不到事件。
// ⚠️ SSE 与长轮询**仍是**不可 hibernate 的（活着的 `writer` / 未兑现的 `pending` 无法迁移）
// ⇒ 有这两类连接在线时，本对象照样全程计费。这是已知且已登记的边界（D42）。
import { parseClientMessage, handshakeResponse, invocationMessage, closeMessage, pingMessage } from './signalr';
import {
  basicAuthUsername,
  checkBasicAuth,
  unauthorized,
  tooManyRequests,
  isAuthConfigured,
  drainRequestBody,
} from '../auth';
import { REGISTER_TOKEN_PATH } from '../hub';
import {
  AUTH_RATE_LIMIT_PATH,
  AUTH_RATE_LIMIT_PERSIST_EVERY_FAILURES,
  AUTH_RATE_LIMIT_STORAGE_KEY,
  applyAuthFailure,
  authLimitKeys,
  authLimitRetryAfterSeconds,
  authRateLimitConfig,
  isAuthLimitBlocked,
  pruneAuthLimits,
} from '../rateLimit';
import type { AuthLimitState } from '../rateLimit';
import { Bindings } from '../env';

const BROADCAST_PATH = '/broadcast';
// 心跳间隔（官方 ASP.NET SignalR 默认 KeepAliveInterval 15s；须 < 客户端 ServerTimeout 30s）
const HEARTBEAT_INTERVAL_MS = 15_000;
// connectionToken 有效期：覆盖 negotiate → 连接建立之间的窗口以及短期重连
const TOKEN_TTL_MS = 10 * 60 * 1000;
// 静默超时：上游由 ASP.NET SignalR 框架的 ClientTimeoutInterval(30s) 主动关闭静默客户端。
// 这里取 60s（> 客户端 15s keepalive 的 4 倍），避免误杀正常空闲连接，同时让死连接有界。
const IDLE_TIMEOUT_MS = 60_000;
// 长轮询单次挂起上限。客户端自身的 HTTP 超时为 100s，这里取 25s 远小于它：
// 且服务端每 15s 的 Ping 会先行返回，故正常情况不会走到这个超时。
const POLL_TIMEOUT_MS = 25_000;
const TOKEN_PREFIX = 'tok:';
// 认证失败计数的落盘节流（详见 persistAuthLimits）：两次「纯计数推进」落盘之间的最小间隔。
// 取 15 s 与 hibernate 的静默阈值（10 s）同一量级 —— 节流窗口决定「hibernate 会抹掉多少失败次数」
// （即攻击者停手等 hibernate 能多试几次），而写率上界是 1 行 / 15 s，与攻击流量无关。
const AUTH_RATE_LIMIT_PERSIST_MIN_INTERVAL_MS = 15_000;

// 认证失败计数的落盘形态（单个 storage key ⇒ 一次落盘 = 1 行写）。
// `persistedAt` 必须**一起**落盘：节流判据的内存基线会被 hibernate 清掉，只有把「上次落盘时刻」
// 本身存下来，唤醒后「距上次落盘多久」才仍然算得对 —— 否则每段静默都会把节流重置成「刚落过盘」，
// 于是节流形同虚设（每次失败都落一行）。
interface PersistedAuthLimits {
  persistedAt: number;
  limits: Record<string, AuthLimitState>;
}

/** 单条限速状态的形状判据（`AuthLimitState` 的三个数值字段）。 */
function isAuthLimitState(value: unknown): value is AuthLimitState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as { windowStart?: unknown; count?: unknown; blockedUntil?: unknown };
  return typeof s.windowStart === 'number' && typeof s.count === 'number' && typeof s.blockedUntil === 'number';
}

/**
 * 落盘快照的形状守卫：只认 `{ persistedAt, limits }`，其余（含**上一版的平铺形态**
 * `Record<string, AuthLimitState>`、以及任何损坏值）一律返回 `null`。
 *
 * 为什么需要它：形态在本分支里改过一次（旧版直接落平铺表），而 DO 存储里可能还留着旧值 ——
 * 没有守卫时 `Object.entries(saved.limits)` 会抛 `TypeError`，只能靠构造函数里那个
 * `catch {}` 兜住（**结果相同、但错误被静默**）。有了守卫，这条路径的语义是显式的：
 * 「形态不认识 ⇒ 按空表起算」，并且调用处可以据此告警一次。
 * 代价与既有取舍同侧：计数归零最坏等于「多给阈值次失败」；下一次落盘即写回新形态（自愈）。
 */
function readPersistedAuthLimits(raw: unknown): PersistedAuthLimits | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as { persistedAt?: unknown; limits?: unknown };
  if (typeof v.persistedAt !== 'number') return null;
  if (typeof v.limits !== 'object' || v.limits === null) return null;
  const limits: Record<string, AuthLimitState> = {};
  for (const [key, value] of Object.entries(v.limits as Record<string, unknown>)) {
    if (isAuthLimitState(value)) limits[key] = value;
  }
  return { persistedAt: v.persistedAt, limits };
}

// 长轮询单连接队列上限（F9 第四类封顶）：无上限时一次写可让 N 条连接各积压整条消息
// （实测 30 连接 × 1.6MB = 48MB，单连接累积 4.5MB）。超限按「服务端关闭」语义结束该连接
// （下一次轮询 204，客户端据此停止轮询），不发明新的状态码。
// ⚠️ `MAX_QUEUED_BYTES` 判的是**UTF-16 码元数**（`message.length`，见 `LongPollClient.queuedBytes`
// 的字段注释），它是体积的保守代理——1 码元 ≤ 2 字节，故实际占用不会超过这里的两倍。
// 名字沿用"字节"是因为它表达的是「队列体积上限」这个意图，改名字要连 test/rate-limit.test.ts 一起改。
export const MAX_QUEUED_MESSAGES = 64;
export const MAX_QUEUED_BYTES = 1_000_000;

// 长轮询响应头（禁用缓存，避免中间代理复用空响应）
const POLL_HEADERS: Record<string, string> = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-cache, no-store',
};

// 长轮询连接（无状态轮询的服务端侧状态）。
// 挂起轮询用「序号 + resolve」表示：超时回调只在自己仍是当前序号时生效，
// 从而无需保存/清除定时器句柄（也避免 setTimeout 返回值类型在 Workers 与 Node 类型间的分歧）。
interface LongPollClient {
  id: string;
  queue: string[];
  /** queue 中消息的字节数（UTF-16 码元数，仅用于封顶判定） */
  queuedBytes: number;
  pending: ((response: Response) => void) | null;
  pollSeq: number;
  lastSeen: number;
  closed: boolean;
}

// SSE 连接（挂起的流式响应）
interface SseClient {
  id: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  lastSeen: number;
  closed: boolean;
}

// 限速端点的请求体解析（body 是内部调用方构造的，但仍按不可信输入做形状校验）
function readAuthLimitOp(body: unknown): 'report' | 'snapshot' | 'clear' | null {
  if (typeof body !== 'object' || body === null || !('op' in body)) return null;
  const op = body.op;
  return op === 'report' || op === 'snapshot' || op === 'clear' ? op : null;
}

function readAuthLimitKeys(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('keys' in body)) return [];
  const raw = body.keys;
  if (!Array.isArray(raw)) return [];
  return raw.filter((key): key is string => typeof key === 'string' && key !== '').slice(0, 8);
}

export class SyncClipboardHub {
  // ⚠️ WS 连接集合**不在内存里**：由平台代管（`state.getWebSockets()`），每连接的 `lastSeen`
  // 存在该连接的 attachment 里（hibernate 会丢弃内存态，连接本身不丢）。
  private sseClients = new Map<string, SseClient>();
  private lpClients = new Map<string, LongPollClient>();
  private state: DurableObjectState;
  private env: Bindings;
  // 认证失败计数的权威副本（F7；Worker 侧 src/rateLimit.ts 调用本 DO 的 AUTH_RATE_LIMIT_PATH）。
  // DO 单线程，计数天然串行化，无需额外的锁或事务。
  // ⚠️ hibernate 会**常规性**地清空这份内存态（每段静默约 10 s），而封锁窗口是分钟级 ⇒ 落盘
  // 不再是「尽力而为」，而是封锁语义的一部分（详见 persistAuthLimits 与 docs/design.md D42）。
  private authLimits = new Map<string, AuthLimitState>();
  /** 快照加载的 memo（见 loadAuthLimitsOnce） */
  private authLimitsLoaded: Promise<void> | null = null;
  private authFailuresSincePersist = 0;
  /** 上次落盘时刻（随快照一起落盘，唤醒后由快照恢复 ⇒ 节流判据跨 hibernate 仍然有效） */
  private authLimitsPersistedAt = 0;
  /** 上次落盘时各 key 的封锁截止时间（识别「封锁开始/延长」这一实质变化；唤醒后同样从快照恢复） */
  private authLimitsPersistedBlocks = new Map<string, number>();
  private burstWindowStart = 0;
  private burstCount = 0;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  /**
   * 落盘快照的**按需**加载（只在首次用到限速状态时读一次）。
   *
   * 为什么不在构造函数里读（2026-09-25 微优化，理由带实测）：hibernate 之后构造函数
   * **每次唤醒都会重跑**，而绝大多数唤醒根本用不到限速状态 —— 客户端 15 s keepalive、每次广播、
   * 每条连接事件都会唤醒它（合并后估算 1.2 万–2.9 万次唤醒/天）⇒ 原来的写法就是同量级的 storage 读，
   * 而且给**每次**唤醒都加一个存储往返的延迟，这些读全部白费。改成按需后：**只有**真正要判定或
   * 查询限速的那两条入口（`handleAuthRateLimit` / `connectionAuthFailure`）会读。
   * memo 一个 Promise：DO 单线程下并发调用共享同一次读取；读失败不重试（与旧写法同侧 ——
   * 该实例按空表起算，下一次唤醒是新实例、会重新读）。
   */
  private loadAuthLimitsOnce(): Promise<void> {
    this.authLimitsLoaded ??= (async () => {
      try {
        const raw: unknown = await this.state.storage.get(AUTH_RATE_LIMIT_STORAGE_KEY);
        const saved = readPersistedAuthLimits(raw);
        if (saved === null) {
          if (raw !== undefined && raw !== null) {
            // 上一版遗留的平铺形态（或损坏值）：按空表起算，下一次落盘即写回新形态
            console.warn('[hub] authRateLimits 快照形态不识别（上一版遗留或损坏）⇒ 按空表起算');
          }
          return;
        }
        this.authLimits = new Map(Object.entries(saved.limits));
        this.authLimitsPersistedAt = saved.persistedAt;
        for (const [key, limit] of this.authLimits) {
          if (limit.blockedUntil > 0) this.authLimitsPersistedBlocks.set(key, limit.blockedUntil);
        }
      } catch {
        /* 读取失败按空表起算 */
      }
    })();
    return this.authLimitsLoaded;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 认证失败限速端点：仅 Worker（src/rateLimit.ts）经 HUB binding 调用，
    // 外部请求不会路由到这里（index.ts 只把 HUB_PATH / negotiate 转发给 DO）。
    if (url.pathname === AUTH_RATE_LIMIT_PATH && request.method === 'POST') {
      return this.handleAuthRateLimit(request);
    }

    // 广播入口（Worker 写操作后调用；上游 _hubContext.Clients.All 等价）
    if (url.pathname === BROADCAST_PATH && request.method === 'POST') {
      // 两种形态（2026-09-22，ADR D33）：
      //   · `{target, payload}`   —— 单条写（PUT / POST / PATCH）
      //   · `{target, payloads}`  —— **批量写**：一次子请求投递整批。消息仍然**逐条**入队，
      //     顺序与内容与"逐条广播 N 次"完全一致；省掉的只是 N-1 次 DO 子请求
      //     （免费档「内部服务子请求」上限 1000/次调用，批量删除 1000 条逐条广播就正好触顶）。
      const { target, payload, payloads } = (await request.json()) as {
        target: string;
        payload?: unknown;
        payloads?: unknown[];
      };
      const batch = Array.isArray(payloads) ? payloads : [payload];
      console.log(`[DO] broadcast ${target} ×${batch.length}, clients=${this.clientCount()}`);
      for (const item of batch) this.broadcast(target, item);
      return new Response(null, { status: 200 });
    }

    // token 登记入口（negotiate 通过 Basic Auth 后调用）
    if (url.pathname === REGISTER_TOKEN_PATH && request.method === 'POST') {
      const { token } = (await request.json()) as { token?: string };
      if (typeof token !== 'string' || token === '') {
        return new Response('token is required', { status: 400 });
      }
      await this.registerToken(token);
      return new Response(null, { status: 200 });
    }

    // 统一鉴权：negotiate 签发的有效 token，或直接携带有效 Basic 凭据
    // （.NET 客户端在 WS/SSE/长轮询请求上都带 Authorization 头；浏览器只能靠 ?id=）
    if (!isAuthConfigured(this.env)) {
      // 凭据未配置时给出可诊断错误（与 HTTP 路径一致），而不是让调用方对着 401 猜
      await drainRequestBody(request);
      return new Response(
        'Server authentication is not configured: set the USERNAME and PASSWORD secrets',
        { status: 500 },
      );
    }
    const denied = await this.connectionAuthFailure(url, request);
    if (denied !== null) {
      // 先排空请求体再返回：否则带 body 的 POST 会触发运行时错误并变成 503
      await drainRequestBody(request);
      return denied;
    }

    // WebSocket 升级
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocket(request);
    }

    switch (request.method) {
      case 'GET':
        // SSE 与长轮询共用 GET：靠 Accept 头区分（EventSource 固定发 text/event-stream）
        if ((request.headers.get('Accept') ?? '').includes('text/event-stream')) {
          return this.handleSseConnect(url);
        }
        return this.handleLongPoll(url);
      case 'POST':
        return this.handleClientMessage(url, request);
      case 'DELETE':
        return this.handleLongPollClose(url);
      default:
        await drainRequestBody(request);
        return new Response('Method Not Allowed', { status: 405 });
    }
  }

  // ---------- WebSocket（Hibernation API）----------

  // 升级：用 `state.acceptWebSocket(server)` 把连接交给平台代管，事件走下面三个类方法。
  // 101 响应与其响应头与标准 API 形态**逐字节一致** ⇒ wire 不变（docs/protocol.md §10 无新差异行）。
  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    // `lastSeen` 只能存 attachment（内存 Map 会被 hibernate 丢弃）。⚠️ 单条 attachment 上限
    // 16,384 字节；且「改完之后不重新序列化就不保留」⇒ 每次触碰都要重写一次。
    server.serializeAttachment({ lastSeen: Date.now() });
    void this.scheduleHeartbeat();
    return new Response(null, { status: 101, webSocket: client });
  }

  // 消息：握手响应 / Close 回帧 / Ping 忽略（与旧的 message 监听器逐句等价）。
  // 参数是 `string | ArrayBuffer`；hibernate 过的连接被唤醒后本方法同样会被调用，
  // 因此**不得**依赖任何内存态（连接集合与 lastSeen 都不在内存里）。
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    ws.serializeAttachment({ lastSeen: Date.now() });
    const text = typeof message === 'string' ? message : '';
    const reply = this.replyToClientMessage(text);
    if (reply === 'close') {
      try {
        ws.send(closeMessage());
      } catch {
        /* 已关闭 */
      }
      ws.close();
      return;
    }
    if (reply !== null) {
      try {
        ws.send(reply);
      } catch {
        // 连接集合由平台代管 ⇒ 这里只需结束这条连接（旧实现是从内存 Map 里删掉）
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
      }
    }
  }

  // 关闭。⚠️ **必须显式 `ws.close(code, reason)`**：本仓库 `compatibility_date = "2025-09-01"`
  // 早于 `2026-04-07`，官方文档明确「On older compatibility dates … you must call
  // `ws.close(code, reason)` inside this handler to complete the WebSocket close handshake.
  // Failing to reciprocate the close will result in `1006` errors on the client」
  // ⇒ 漏掉这一句会让客户端收到 1006（表现为「连接莫名断开」）。**不要**靠升级 compat 日期回避：
  // 那会一次性引入该日期之前的全部行为变更，而本仓库的 compat 日期是有意钉住的。
  // 后两个形参是平台传入的（`wasClean` / 错误对象），本实现不用 —— 保留下划线名以表明是有意忽略。
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* 已关闭 */
    }
    void this.scheduleHeartbeat();
  }

  // 错误：与旧的 error 监听器等价（结束该连接 + 重算心跳）。
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    void this.scheduleHeartbeat();
    try {
      ws.close();
    } catch {
      /* 已关闭 */
    }
  }

  // ---------- Server-Sent Events ----------

  // SSE：返回挂起的流式响应，之后由 broadcast/心跳向 writer 写入 `data: <msg>\n\n` 帧。
  // 客户端（EventSource）把每个 data 字段内容交给 onreceive，故帧内必须是完整 SignalR 消息。
  private handleSseConnect(url: URL): Response {
    const id = url.searchParams.get('id') ?? '';
    // 同 id 重复连接：关闭旧连接，避免 writer 泄漏
    this.closeSseClient(id);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const sse: SseClient = { id, writer, lastSeen: Date.now(), closed: false };
    this.sseClients.set(id, sse);
    void this.scheduleHeartbeat();

    // 立即写一个注释帧：促使头部与首字节尽早下发（部分中间代理会缓冲到首字节）
    void this.writeSseRaw(sse, ': connected\n\n');

    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        // 禁止中间层缓冲（nginx 等默认会缓冲流式响应）
        'x-accel-buffering': 'no',
      },
    });
  }

  private async writeSseRaw(sse: SseClient, text: string): Promise<void> {
    if (sse.closed) return;
    try {
      await sse.writer.write(new TextEncoder().encode(text));
    } catch {
      // 客户端已断开：写失败即视为连接结束
      this.closeSseClient(sse.id);
    }
  }

  private closeSseClient(id: string): void {
    const sse = this.sseClients.get(id);
    if (!sse) return;
    sse.closed = true;
    this.sseClients.delete(id);
    try {
      void sse.writer.close();
    } catch {
      /* 已关闭 */
    }
    void this.scheduleHeartbeat();
  }

  // ---------- 长轮询 ----------

  // GET：取消息。首次请求建立连接并立即返回（与 ASP.NET 一致：首个轮询用于完成初始化）；
  // 有排队消息立即返回；否则挂起至多 POLL_TIMEOUT_MS（超时返回 200 空体，客户端会重新轮询）；
  // 服务端主动关闭时返回 204（客户端据此结束轮询）。
  private async handleLongPoll(url: URL): Promise<Response> {
    const id = url.searchParams.get('id') ?? '';
    let lp = this.lpClients.get(id);
    if (!lp) {
      lp = { id, queue: [], queuedBytes: 0, pending: null, pollSeq: 0, lastSeen: Date.now(), closed: false };
      this.lpClients.set(id, lp);
      void this.scheduleHeartbeat();
      return new Response(null, { status: 200, headers: POLL_HEADERS });
    }
    lp.lastSeen = Date.now();
    if (lp.closed) {
      return new Response(null, { status: 204 });
    }
    const queued = lp.queue.join('');
    if (queued !== '') {
      lp.queue = [];
      lp.queuedBytes = 0;
      return new Response(queued, { status: 200, headers: POLL_HEADERS });
    }
    return this.waitForClientMessage(lp);
  }

  private waitForClientMessage(lp: LongPollClient): Promise<Response> {
    // 同一连接上不应有两个挂起轮询；若发生（客户端异常时序），让旧的那个立即以空体返回
    if (lp.pending) {
      this.settlePoll(lp, new Response(null, { status: 200, headers: POLL_HEADERS }));
    }
    const seq = ++lp.pollSeq;
    const { promise, resolve } = Promise.withResolvers<Response>();
    lp.pending = resolve;
    setTimeout(() => {
      if (lp.pollSeq === seq && lp.pending === resolve) {
        lp.pending = null;
        resolve(new Response(null, { status: 200, headers: POLL_HEADERS }));
      }
    }, POLL_TIMEOUT_MS);
    return promise;
  }

  // 结束挂起轮询；递增序号使已排队的超时回调失效（避免它再改动状态）
  private settlePoll(lp: LongPollClient, response: Response): void {
    const resolve = lp.pending;
    if (!resolve) return;
    lp.pollSeq++;
    lp.pending = null;
    resolve(response);
  }

  // POST：客户端上报消息（握手 / Ping / Close）。三种传输共用同一套消息语义。
  private async handleClientMessage(url: URL, request: Request): Promise<Response> {
    const id = url.searchParams.get('id') ?? '';
    // 长轮询客户端可能先发 POST（异常时序）；此处按需补建连接，避免消息被丢弃
    let lp = this.lpClients.get(id);
    if (!lp && !this.sseClients.has(id)) {
      lp = { id, queue: [], queuedBytes: 0, pending: null, pollSeq: 0, lastSeen: Date.now(), closed: false };
      this.lpClients.set(id, lp);
    }
    if (lp) lp.lastSeen = Date.now();
    const sse = this.sseClients.get(id);
    if (sse) sse.lastSeen = Date.now();

    const text = await request.text();
    const reply = this.replyToClientMessage(text);
    if (reply === 'close') {
      this.closeSseClient(id);
      if (lp) {
        lp.closed = true;
        this.settlePoll(lp, new Response(null, { status: 204 }));
      }
      return new Response(null, { status: 200 });
    }
    if (reply !== null) {
      // 同步返回给发起方（HTTP 200），同时把握手响应投递到该连接的接收通道
      this.deliverTo(id, reply);
    }
    return new Response(null, { status: 200 });
  }

  // DELETE：客户端主动结束长轮询（ASP.NET 返回 200；客户端亦容忍 404）
  private handleLongPollClose(url: URL): Response {
    const id = url.searchParams.get('id') ?? '';
    const lp = this.lpClients.get(id);
    if (lp) {
      lp.closed = true;
      this.settlePoll(lp, new Response(null, { status: 204 }));
      this.lpClients.delete(id);
      void this.scheduleHeartbeat();
    }
    const sse = this.sseClients.get(id);
    if (sse) this.closeSseClient(id);
    return new Response(null, { status: 200 });
  }

  // ---------- 消息语义（三种传输共用）----------

  // 返回要回送的内容；'close' 表示客户端要求关闭；null 表示无需回应
  private replyToClientMessage(text: string): string | 'close' | null {
    const msg = parseClientMessage(text);
    switch (msg.kind) {
      case 'handshake':
        return handshakeResponse();
      case 'close':
        return 'close';
      case 'ping':
      case 'unknown':
      case 'invocation':
        // 官方客户端纯监听：无服务端 RPC，忽略
        return null;
    }
  }

  private deliverTo(id: string, message: string): void {
    const sse = this.sseClients.get(id);
    if (sse) {
      void this.writeSseRaw(sse, `data: ${message}\n\n`);
      return;
    }
    const lp = this.lpClients.get(id);
    if (lp && !lp.closed) {
      if (lp.pending) {
        this.settlePoll(lp, new Response(message, { status: 200, headers: POLL_HEADERS }));
      } else {
        lp.queue.push(message);
        lp.queuedBytes += message.length;
        // 排队意味着客户端已停止轮询；超过上限说明它不会再来取，按「服务端关闭」结束连接，
        // 避免广播被无界地堆在内存里（F9：一次写 30 连接 × 1.6MB = 48MB）。
        if (lp.queue.length > MAX_QUEUED_MESSAGES || lp.queuedBytes > MAX_QUEUED_BYTES) {
          console.log(
            `[hub] queue overflow, closing client id=${lp.id} messages=${lp.queue.length} bytes=${lp.queuedBytes}`,
          );
          // 与既有「服务端关闭」路径一致：保留 closed 标记（挂起中的轮询以 204 结束，
          // 之后的轮询同样 204），由客户端主动 DELETE 或静默清理回收条目。
          lp.closed = true;
          lp.queue = [];
          lp.queuedBytes = 0;
          this.settlePoll(lp, new Response(null, { status: 204 }));
          void this.scheduleHeartbeat();
        }
      }
    }
  }

  // ---------- 认证失败限速（F7）----------

  // Worker 侧 src/rateLimit.ts 的内部端点。op：
  //   report   —— 记一次失败（窗口内累加；达阈值即产生封锁），返回这些 key 的封锁状态
  //   snapshot —— 只读：返回这些 key 当前的封锁状态（跨 isolate 传播权威封锁）
  //   clear    —— 认证成功，清除这些 key 的失败计数
  private async handleAuthRateLimit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('invalid JSON body', { status: 400 });
    }
    const op = readAuthLimitOp(body);
    const keys = readAuthLimitKeys(body);
    if (op === null || keys.length === 0) {
      return new Response('op must be report|snapshot|clear and keys a non-empty string array', {
        status: 400,
      });
    }
    await this.loadAuthLimitsOnce();
    const now = Date.now();
    // 限速参数可由仓库变量覆盖（**不建议改**）：DO 与 Worker 必须读**同一套**取值，否则会出现
    // "Worker 认为没封锁、DO 认为封锁"的分裂判定（两边都用 src/rateLimit.ts 的同一函数）。
    const limitConfig = authRateLimitConfig(this.env);
    if (op === 'report') {
      for (const key of keys) {
        this.authLimits.set(key, applyAuthFailure(this.authLimits.get(key), now, limitConfig));
        this.countBurst(now, limitConfig.windowMs);
      }
      pruneAuthLimits(this.authLimits, now, limitConfig);
      this.persistAuthLimits(now);
    } else if (op === 'clear') {
      let cleared = false;
      for (const key of keys) {
        if (this.authLimits.delete(key)) cleared = true;
      }
      // 计数清零是实质变化：不落盘的话，陈旧计数会在 hibernate 唤醒后复活（可能误封合法用户）
      if (cleared) this.persistAuthLimits(now, true);
    }
    const blocks: Record<string, number> = {};
    for (const key of keys) {
      const state = this.authLimits.get(key);
      if (state !== undefined && isAuthLimitBlocked(state, now)) blocks[key] = state.blockedUntil;
    }
    return Response.json({ blocks, burst: this.burstCount });
  }

  // 全局失败计数（仅在**告警**中使用；封锁只按 ip/user 维度，避免攻击者用垃圾请求锁死合法用户）
  private countBurst(now: number, windowMs: number): void {
    if (now - this.burstWindowStart >= windowMs) {
      this.burstWindowStart = now;
      this.burstCount = 0;
    }
    this.burstCount++;
  }

  // 落盘认证失败状态。失败路径**不 await** 这次写（也不写 D1）—— DO 的 output gate 保证
  // 它在响应送出前已持久化，所以「不 await」不等于「不保证」。
  //
  // ⚠️ 为什么落盘是**安全语义**而不是「尽力而为」：hibernate 会**常规性**地清空内存态
  // （每段静默约 10 s 一次；P1 之后更频繁），而封锁窗口是分钟级（默认 15 min）⇒ 只靠内存时
  // 「被封禁的来源停手 10 秒就能重来」。因此封锁状态必须落盘；节流窗口则决定攻击者能多试几次。
  //
  // 落盘触发（都是「状态实质变化」，且**不**按失败次数写一行）：
  //   ① 任一 key **开始或延长**封锁 —— 安全关键状态，立即落盘（不受节流）；
  //   ② 计数清零（认证成功）—— `force`：不落盘的话陈旧计数会在唤醒后复活，可能误封合法用户；
  //   ③ 纯计数推进 —— 「距上次落盘 ≥ AUTH_RATE_LIMIT_PERSIST_MIN_INTERVAL_MS」或
  //      「累计失败 ≥ AUTH_RATE_LIMIT_PERSIST_EVERY_FAILURES」满足其一才落。
  // 写放大（每次封锁事件的行写数）：一次 `put` = **1 行**。快速爆破（请求不断 ⇒ DO 不 hibernate）
  // 时计数在内存里连续累加，通常只落 1 行（封锁那一刻）；慢速试探（每段静默被 hibernate 一次）
  // 时按节流窗口落，上界 = 封锁窗口 / 15 s + 1 ≈ **61 行**（默认 15 min），且与攻击流量无关。
  private persistAuthLimits(now: number, force = false): void {
    this.authFailuresSincePersist++;
    if (!force && !this.authLimitsChanged(now)) return;
    this.authFailuresSincePersist = 0;
    this.authLimitsPersistedAt = now;
    const limits: Record<string, AuthLimitState> = {};
    this.authLimitsPersistedBlocks.clear();
    for (const [key, state] of this.authLimits) {
      limits[key] = state;
      if (state.blockedUntil > 0) this.authLimitsPersistedBlocks.set(key, state.blockedUntil);
    }
    const snapshot: PersistedAuthLimits = { persistedAt: now, limits };
    void this.state.storage.put(AUTH_RATE_LIMIT_STORAGE_KEY, snapshot).catch(() => {
      /* 落盘失败不影响限速判定（内存态仍然生效） */
    });
  }

  /** 距上次落盘之间是否发生了「实质变化」（封锁开始/延长、计数推进到阈值或节流窗口）。
   *  ⚠️ 判据必须能在 hibernate 之后仍然成立 ⇒ `authLimitsPersistedAt` 与 `authLimitsPersistedBlocks`
   *  都随快照落盘、并由构造函数恢复；若只用内存基线，每次唤醒都会被重置成「刚落过盘」，
   *  于是节流失效（每次失败都落一行）而计数仍被抹掉。 */
  private authLimitsChanged(now: number): boolean {
    for (const [key, state] of this.authLimits) {
      if (
        state.blockedUntil > now &&
        state.blockedUntil > (this.authLimitsPersistedBlocks.get(key) ?? 0)
      ) {
        return true; // 封锁开始或延长
      }
    }
    return (
      this.authFailuresSincePersist >= AUTH_RATE_LIMIT_PERSIST_EVERY_FAILURES ||
      now - this.authLimitsPersistedAt >= AUTH_RATE_LIMIT_PERSIST_MIN_INTERVAL_MS
    );
  }

  // ---------- 心跳与清理 ----------

  // DO alarm：发心跳、清理死连接并安排下一轮（DO 空闲时定时器冻结，alarm 由平台保证触发）
  async alarm(): Promise<void> {
    this.sendPings();
    this.closeIdleClients();
    this.rearmHeartbeatInAlarm();
  }

  /**
   * `alarm()` 内的重排：**不读** `getAlarm()`。
   *
   * 官方语义：`alarm()` 正在执行时 `getAlarm()` 返回 `null`（除非期间又 `setAlarm` 过）——
   * 本仓库的防重排判据（`scheduleHeartbeat`）本来就建立在同一条语义上，所以「我在 alarm 里」
   * 本身就等价于「平台上没有待触发的 alarm」⇒ 那次 storage 读是多余的（按 15 s 节拍 = 5,760 读/天）。
   * 边界：若本轮 `sendPings` / `closeIdleClients` 期间某个连接事件同步调过 `scheduleHeartbeat`
   * 并排了 alarm，这里会把它**覆盖**成「此刻 + 15 s」—— 两个时间只差几毫秒，语义等价（心跳仍是
   * 15 s 节拍，且不会出现两个 alarm：存储层只有一个 alarm 槽）。
   */
  private rearmHeartbeatInAlarm(): void {
    if (this.clientCount() === 0) return;
    void this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private clientCount(): number {
    // WS 的连接集合由平台代管（内存 Map 已被 hibernate 移除）。
    // ⚠️ 已知口径差：`getWebSockets()` 可能仍包含正在关闭（CLOSING）的连接 ⇒ 计数可能略高于
    // 实际活连接数，最坏后果是心跳多排几轮（不丢消息、不误杀连接）。
    return this.state.getWebSockets().length + this.sseClients.size + this.lpClients.size;
  }

  /** 安排下一轮心跳 alarm。
   *  **判据必须是平台上的 pending alarm（`getAlarm()`），不能是内存标志**：hibernate 会清空内存态
   *  （每段静默约 10 s），唤醒后内存标志是 false 而平台上 alarm 仍在路上 ⇒ 用内存标志会**重复**
   *  `setAlarm`（覆盖已有 alarm，等于把心跳往后推）。
   *  ⚠️ `getAlarm()` 在 `alarm()` **正在执行**时返回 `null`（除非期间又 `setAlarm` 过）⇒ 不能把它
   *  读成「从未排程」；按官方示例的 `if (!currentAlarm)` 形态理解即可：只有「确实已有一个待触发的
   *  alarm」才跳过。`alarm()` 内重排时它必然是 `null`，于是会重新排程 —— 这正是要的语义。
   *  为什么必须防重排：直接 `setAlarm(now+15s)` 会覆盖已有 alarm，而连接建立/关闭（8 个调用点）
   *  都会调 scheduleHeartbeat —— 若连接事件来得比 15s 更勤，心跳将**永远不触发**，
   *  WebSocket/SSE 客户端在 30s ServerTimeout 处被自己判超时并反复重连。 */
  private async scheduleHeartbeat(): Promise<void> {
    if (this.clientCount() === 0) return;
    let currentAlarm: number | null;
    try {
      currentAlarm = await this.state.storage.getAlarm();
    } catch {
      // 读失败按「未排程」处理：宁可多排一次，也不能让心跳停摆
      currentAlarm = null;
    }
    if (currentAlarm !== null) return;
    void this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  // 向全部连接发送 Ping：WebSocket 直接发；SSE 写 data 帧；长轮询入队（下次轮询立即取走）。
  // 长轮询尤其依赖它——空轮询响应不会重置客户端 ServerTimeout，必须有真实消息。
  // ⚠️ 这里**不**刷新 WS 的 `lastSeen`（与迁移前一致）：客户端的 15s keepalive Ping 会经
  // `webSocketMessage` 刷新它，而服务端 ping 若也刷新，半开 TCP 就永远不会被 `closeIdleClients` 回收。
  private sendPings(): void {
    const ping = pingMessage();
    for (const ws of this.state.getWebSockets()) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(ping);
        }
      } catch {
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
      }
    }
    for (const sse of this.sseClients.values()) {
      void this.writeSseRaw(sse, `data: ${ping}\n\n`);
    }
    for (const lp of this.lpClients.values()) {
      this.deliverTo(lp.id, ping);
    }
  }

  // 关闭静默超过 IDLE_TIMEOUT_MS 的连接（半开 TCP 不会有 close/error 事件，F10）
  private closeIdleClients(): void {
    const now = Date.now();
    for (const ws of this.state.getWebSockets()) {
      // `lastSeen` 从 attachment 读（内存 Map 已被 hibernate 移除）。缺失按 0 处理 —— 那意味着
      // 「从未见过这条连接」；所以**每个** accept/消息路径都必须重新序列化 attachment，
      // 否则唤醒后第一轮就会把全部 WS 当死连接关掉（症状：「一唤醒就全体掉线」）。
      const attachment = ws.deserializeAttachment() as { lastSeen?: number } | null;
      const last = attachment?.lastSeen ?? 0;
      if (now - last > IDLE_TIMEOUT_MS) {
        try {
          ws.close(1000, 'idle timeout');
        } catch {
          /* 已关闭 */
        }
      }
    }
    for (const [id, sse] of this.sseClients) {
      if (now - sse.lastSeen > IDLE_TIMEOUT_MS) {
        this.closeSseClient(id);
      }
    }
    for (const [id, lp] of this.lpClients) {
      if (now - lp.lastSeen > IDLE_TIMEOUT_MS) {
        lp.closed = true;
        // 挂起的轮询以 204 结束，客户端据此停止轮询而不是继续重试
        this.settlePoll(lp, new Response(null, { status: 204 }));
        this.lpClients.delete(id);
      }
    }
  }

  // ---------- token 登记与校验 ----------

  // negotiate 后登记 connectionToken（带 TTL），并顺手清理过期项
  private async registerToken(token: string): Promise<void> {
    const now = Date.now();
    try {
      const existing = await this.state.storage.list<number>({ prefix: TOKEN_PREFIX });
      for (const [key, expiry] of existing) {
        if (typeof expiry !== 'number' || expiry <= now) {
          await this.state.storage.delete(key);
        }
      }
    } catch {
      /* 清理失败不影响登记 */
    }
    await this.state.storage.put(TOKEN_PREFIX + token, now + TOKEN_TTL_MS);
  }

  // 连接鉴权 + 失败限速（F7）。WS/SSE/长轮询的鉴权在 DO 内完成、不经过 Worker 的 authFailure，
  // 因此这里用**同一套 key 约定与同一个状态机**直接在 DO 内判定（DO 自己就是权威存储，零额外往返）。
  // 返回 Response 表示拒绝（401/429），null 表示通过。
  private async connectionAuthFailure(url: URL, request: Request): Promise<Response | null> {
    const token = url.searchParams.get('id');
    if (token) {
      try {
        const expiry = await this.state.storage.get<number>(TOKEN_PREFIX + token);
        if (typeof expiry === 'number' && expiry > Date.now()) return null;
      } catch {
        /* 读取失败按未授权处理 */
      }
    }
    // 只有走到「要判定/推进限速」这一支才需要快照（有效 token 在上面已放行 ⇒ 该路径零存储读）
    await this.loadAuthLimitsOnce();
    const now = Date.now();
    const keys = authLimitKeys(request, basicAuthUsername(request));
    for (const key of keys) {
      const state = this.authLimits.get(key);
      if (state !== undefined && isAuthLimitBlocked(state, now)) {
        return tooManyRequests(authLimitRetryAfterSeconds(state, now));
      }
    }
    if (checkBasicAuth(this.env, request)) {
      let cleared = false;
      for (const key of keys) {
        if (this.authLimits.delete(key)) cleared = true; // 成功即清零
      }
      // 清零必须落盘（同 handleAuthRateLimit 的 clear）：否则陈旧计数会在唤醒后复活
      if (cleared) this.persistAuthLimits(now, true);
      return null;
    }
    for (const key of keys) {
      this.authLimits.set(
        key,
        applyAuthFailure(this.authLimits.get(key), now, authRateLimitConfig(this.env)),
      );
    }
    pruneAuthLimits(this.authLimits, now, authRateLimitConfig(this.env));
    this.persistAuthLimits(now);
    return unauthorized();
  }

  // ---------- 广播 ----------

  // 向全部连接广播 Invocation（单连接失败隔离，不影响其余）
  private broadcast(target: string, payload: unknown): void {
    let message: string;
    try {
      message = invocationMessage(target, [payload]);
    } catch {
      return;
    }
    for (const ws of this.state.getWebSockets()) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      } catch {
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
      }
    }
    for (const sse of this.sseClients.values()) {
      void this.writeSseRaw(sse, `data: ${message}\n\n`);
    }
    for (const lp of this.lpClients.values()) {
      this.deliverTo(lp.id, message);
    }
  }
}
