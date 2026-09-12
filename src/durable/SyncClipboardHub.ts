// SignalR 兼容 Hub（Durable Object，docs/design.md §3）
// 职责：持有所有客户端 WebSocket 连接；接收 /broadcast 写操作通知并向全体广播；
// 通过 DO alarm 定期发送心跳 Ping（客户端 ServerTimeout 默认 30s，官方服务器 15s 心跳）。
// 另负责：negotiate 签发的 connectionToken 登记与升级校验（上游 hub 类级 [Authorize] 的等价物）。
import { parseClientMessage, handshakeResponse, invocationMessage, closeMessage, pingMessage } from './signalr';
import { checkBasicAuth, unauthorized, isAuthConfigured } from '../auth';
import { REGISTER_TOKEN_PATH } from '../hub';
import { Bindings } from '../env';

const BROADCAST_PATH = '/broadcast';
// 心跳间隔（官方 ASP.NET SignalR 默认 KeepAliveInterval 15s；须 < 客户端 ServerTimeout 30s）
const HEARTBEAT_INTERVAL_MS = 15_000;
// connectionToken 有效期：覆盖 negotiate → WS 升级之间的窗口以及短期重连
const TOKEN_TTL_MS = 10 * 60 * 1000;
// 静默超时：上游由 ASP.NET SignalR 框架的 ClientTimeoutInterval(30s) 主动关闭静默客户端。
// 这里取 60s（> 客户端 15s keepalive 的 4 倍），避免误杀正常空闲连接，同时让死连接有界。
const IDLE_TIMEOUT_MS = 60_000;
const TOKEN_PREFIX = 'tok:';

export class SyncClipboardHub {
  private connections = new Set<WebSocket>();
  private lastSeen = new Map<WebSocket, number>();
  private state: DurableObjectState;
  private env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 广播入口（Worker 写操作后调用；上游 _hubContext.Clients.All 等价）
    if (url.pathname === BROADCAST_PATH && request.method === 'POST') {
      const { target, payload } = (await request.json()) as { target: string; payload: unknown };
      console.log(`[DO] broadcast ${target}, connections=${this.connections.size}`);
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

    // WebSocket 升级：/SyncClipboardHub?id={connectionToken}
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (!isAuthConfigured(this.env)) {
        // 凭据未配置时给出可诊断错误（与 HTTP 路径一致），而不是让调用方对着 401 猜
        return new Response(
          'Server authentication is not configured: set the USERNAME and PASSWORD secrets',
          { status: 500 },
        );
      }
      if (!(await this.isUpgradeAuthorized(url, request))) {
        // 未认证/伪造 token 的升级请求一律拒绝（F1）
        return unauthorized();
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.connections.add(server);
      this.lastSeen.set(server, Date.now());
      this.scheduleHeartbeat();
      server.accept();

      server.addEventListener('message', (event) => {
        this.lastSeen.set(server, Date.now());
        const text = typeof event.data === 'string' ? event.data : '';
        const msg = parseClientMessage(text);
        switch (msg.kind) {
          case 'handshake':
            server.send(handshakeResponse());
            break;
          case 'close':
            server.send(closeMessage());
            server.close();
            break;
          case 'ping':
          case 'unknown':
          case 'invocation':
            // 官方客户端纯监听：无服务端 RPC，忽略
            break;
        }
      });

      server.addEventListener('close', () => {
        this.connections.delete(server);
        this.lastSeen.delete(server);
        this.scheduleHeartbeat();
      });
      server.addEventListener('error', () => {
        this.connections.delete(server);
        this.lastSeen.delete(server);
        this.scheduleHeartbeat();
        try {
          server.close();
        } catch {
          /* 已关闭 */
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // DO alarm：发心跳、清理死连接并安排下一轮（DO 空闲时定时器冻结，alarm 由平台保证触发）
  async alarm(): Promise<void> {
    this.sendPings();
    this.closeIdleConnections();
    this.scheduleHeartbeat();
  }

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

  // 升级鉴权：negotiate 签发的有效 token，或直接携带有效 Basic 凭据
  // （.NET 客户端可以在 WS 请求上带 Authorization 头；浏览器/JS 客户端只能靠 ?id=）
  private async isUpgradeAuthorized(url: URL, request: Request): Promise<boolean> {
    const token = url.searchParams.get('id');
    if (token) {
      try {
        const expiry = await this.state.storage.get<number>(TOKEN_PREFIX + token);
        if (typeof expiry === 'number' && expiry > Date.now()) {
          return true;
        }
      } catch {
        /* 读取失败按未授权处理 */
      }
    }
    return checkBasicAuth(this.env, request);
  }

  private scheduleHeartbeat(): void {
    if (this.connections.size === 0) {
      return;
    }
    void this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private sendPings(): void {
    for (const ws of this.connections) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(pingMessage());
        }
      } catch {
        this.connections.delete(ws);
        this.lastSeen.delete(ws);
      }
    }
  }

  // 关闭静默超过 IDLE_TIMEOUT_MS 的连接（半开 TCP 不会有 close/error 事件，F10）
  private closeIdleConnections(): void {
    const now = Date.now();
    for (const ws of this.connections) {
      const last = this.lastSeen.get(ws);
      if (last === undefined) {
        this.lastSeen.set(ws, now);
        continue;
      }
      if (now - last > IDLE_TIMEOUT_MS) {
        this.connections.delete(ws);
        this.lastSeen.delete(ws);
        try {
          ws.close(1000, 'idle timeout');
        } catch {
          /* 已关闭 */
        }
      }
    }
  }

  // 向全部连接广播 Invocation（序列化失败的单连接隔离，不影响其余）
  private broadcast(target: string, payload: unknown): void {
    let message: string;
    try {
      message = invocationMessage(target, [payload]);
    } catch {
      return;
    }
    for (const ws of this.connections) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      } catch {
        this.connections.delete(ws);
        this.lastSeen.delete(ws);
      }
    }
  }
}
