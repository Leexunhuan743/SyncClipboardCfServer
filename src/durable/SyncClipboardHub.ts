// SignalR 兼容 Hub（Durable Object，docs/design.md §3）
// 持有客户端连接并广播；支持三种传输，与上游 ASP.NET Core SignalR 的宣告顺序一致：
//   WebSockets（首选）→ ServerSentEvents → LongPolling
// 另负责 negotiate 签发的 connectionToken 的登记与校验（上游 hub 类级 [Authorize] 的等价物）。
//
// 三种传输的连接模型：
//   ws  —— WebSocketPair，服务端主动 send/close
//   sse —— 挂起的流式响应（transform stream + writer），按 `data: <msg>\n\n` 帧写入
//   lp  —— 无状态轮询：GET 取消息（无消息则挂起至多 POLL_TIMEOUT_MS、或返回 204 表示服务端关闭），
//          POST 上报客户端消息，DELETE 关闭连接
// 三种传输共用同一套心跳（15s Ping）与静默清理（60s），因为客户端 ServerTimeout 对三者一致。
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
  AUTH_RATE_LIMIT_WINDOW_MS,
  applyAuthFailure,
  authLimitKeys,
  authLimitRetryAfterSeconds,
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

// 长轮询单连接队列上限（F9 第四类封顶）：无上限时一次写可让 N 条连接各积压整条消息
// （实测 30 连接 × 1.6MB = 48MB，单连接累积 4.5MB）。超限按「服务端关闭」语义结束该连接
// （下一次轮询 204，客户端据此停止轮询），不发明新的状态码。
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
  // WebSocket 连接（含最后活跃时间，用于静默清理）
  private wsClients = new Map<WebSocket, number>();
  private sseClients = new Map<string, SseClient>();
  private lpClients = new Map<string, LongPollClient>();
  private state: DurableObjectState;
  private env: Bindings;
  // 认证失败计数的权威副本（F7；Worker 侧 src/rateLimit.ts 调用本 DO 的 AUTH_RATE_LIMIT_PATH）。
  // DO 单线程，计数天然串行化，无需额外的锁或事务。
  private authLimits = new Map<string, AuthLimitState>();
  private authFailuresSincePersist = 0;
  private burstWindowStart = 0;
  private burstCount = 0;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
    // 低频落盘的计数在 DO 重启后恢复。丢失等价于计数归零（最坏多给阈值次失败），故为尽力而为。
    state.blockConcurrencyWhile(async () => {
      try {
        const saved = await state.storage.get<Record<string, AuthLimitState>>(
          AUTH_RATE_LIMIT_STORAGE_KEY,
        );
        if (saved) this.authLimits = new Map(Object.entries(saved));
      } catch {
        /* 读取失败按空表起算 */
      }
    });
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
      const { target, payload } = (await request.json()) as { target: string; payload: unknown };
      console.log(`[DO] broadcast ${target}, clients=${this.clientCount()}`);
      this.broadcast(target, payload);
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

  // ---------- WebSocket ----------

  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.wsClients.set(server, Date.now());
    this.scheduleHeartbeat();
    server.accept();

    server.addEventListener('message', (event) => {
      this.wsClients.set(server, Date.now());
      const text = typeof event.data === 'string' ? event.data : '';
      const reply = this.replyToClientMessage(text);
      if (reply === 'close') {
        try {
          server.send(closeMessage());
        } catch {
          /* 已关闭 */
        }
        server.close();
        return;
      }
      if (reply !== null) {
        try {
          server.send(reply);
        } catch {
          this.wsClients.delete(server);
        }
      }
    });

    const drop = () => {
      this.wsClients.delete(server);
      this.scheduleHeartbeat();
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', () => {
      drop();
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
    });

    return new Response(null, { status: 101, webSocket: client });
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
    this.scheduleHeartbeat();

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
    this.scheduleHeartbeat();
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
      this.scheduleHeartbeat();
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
      this.scheduleHeartbeat();
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
          this.scheduleHeartbeat();
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
    const now = Date.now();
    if (op === 'report') {
      for (const key of keys) {
        this.authLimits.set(key, applyAuthFailure(this.authLimits.get(key), now));
        this.countBurst(now);
      }
      pruneAuthLimits(this.authLimits, now);
      this.persistAuthLimits(now);
    } else if (op === 'clear') {
      for (const key of keys) {
        this.authLimits.delete(key);
      }
    }
    const blocks: Record<string, number> = {};
    for (const key of keys) {
      const state = this.authLimits.get(key);
      if (state !== undefined && isAuthLimitBlocked(state, now)) blocks[key] = state.blockedUntil;
    }
    return Response.json({ blocks, burst: this.burstCount });
  }

  // 全局失败计数（仅在**告警**中使用；封锁只按 ip/user 维度，避免攻击者用垃圾请求锁死合法用户）
  private countBurst(now: number): void {
    if (now - this.burstWindowStart >= AUTH_RATE_LIMIT_WINDOW_MS) {
      this.burstWindowStart = now;
      this.burstCount = 0;
    }
    this.burstCount++;
  }

  // 低频落盘：每 N 次失败落一次（失败路径不做同步存储写，也不写 D1）
  private persistAuthLimits(now: number): void {
    const blocked = [...this.authLimits.values()].some((state) => isAuthLimitBlocked(state, now));
    this.authFailuresSincePersist++;
    if (!blocked && this.authFailuresSincePersist < AUTH_RATE_LIMIT_PERSIST_EVERY_FAILURES) return;
    this.authFailuresSincePersist = 0;
    const snapshot: Record<string, AuthLimitState> = {};
    for (const [key, state] of this.authLimits) snapshot[key] = state;
    void this.state.storage.put(AUTH_RATE_LIMIT_STORAGE_KEY, snapshot).catch(() => {
      /* 落盘失败不影响限速判定（内存态仍然生效） */
    });
  }

  // ---------- 心跳与清理 ----------

  // DO alarm：发心跳、清理死连接并安排下一轮（DO 空闲时定时器冻结，alarm 由平台保证触发）
  async alarm(): Promise<void> {
    this.sendPings();
    this.closeIdleClients();
    this.scheduleHeartbeat();
  }

  private clientCount(): number {
    return this.wsClients.size + this.sseClients.size + this.lpClients.size;
  }

  private scheduleHeartbeat(): void {
    if (this.clientCount() === 0) {
      return;
    }
    void this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  // 向全部连接发送 Ping：WebSocket 直接发；SSE 写 data 帧；长轮询入队（下次轮询立即取走）。
  // 长轮询尤其依赖它——空轮询响应不会重置客户端 ServerTimeout，必须有真实消息。
  private sendPings(): void {
    const ping = pingMessage();
    for (const [ws] of this.wsClients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(ping);
        }
      } catch {
        this.wsClients.delete(ws);
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
    for (const [ws, last] of this.wsClients) {
      if (now - last > IDLE_TIMEOUT_MS) {
        this.wsClients.delete(ws);
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
    const now = Date.now();
    const keys = authLimitKeys(request, basicAuthUsername(request));
    for (const key of keys) {
      const state = this.authLimits.get(key);
      if (state !== undefined && isAuthLimitBlocked(state, now)) {
        return tooManyRequests(authLimitRetryAfterSeconds(state, now));
      }
    }
    if (checkBasicAuth(this.env, request)) {
      for (const key of keys) this.authLimits.delete(key); // 成功即清零
      return null;
    }
    for (const key of keys) {
      this.authLimits.set(key, applyAuthFailure(this.authLimits.get(key), now));
    }
    pruneAuthLimits(this.authLimits, now);
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
    for (const [ws] of this.wsClients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      } catch {
        this.wsClients.delete(ws);
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
