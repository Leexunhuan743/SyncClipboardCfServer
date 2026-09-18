// 广播触发与 negotiate 辅助（docs/protocol.md §6）
import { Bindings } from './env';

export const HUB_INSTANCE = 'hub';
export const HUB_PATH = '/SyncClipboardHub';
// token 登记路径（DO 侧同此常量）
export const REGISTER_TOKEN_PATH = '/register-token';

// 逐字对齐上游：ASP.NET Core SignalR 对 WebSockets 传输**硬编码**宣告 ["Text","Binary"]，
// 与服务端实际注册了哪些协议无关（上游 Web.cs:38 只 AddSignalR() = 仅 JSON）。
// 官方客户端用默认 JSON(Text) 协议，两种宣告都能连上（已实测）；为保持 negotiate 载荷
// 与上游逐字一致，这里保留 "Binary"（F13：不再自行收敛为 Text）。
const WS_TRANSFER_FORMATS = ['Text', 'Binary'];
// 上游对 SSE 只宣告 Text、对长轮询宣告 Text+Binary（ASP.NET Core SignalR 的固定表）
const SSE_TRANSFER_FORMATS = ['Text'];
const LP_TRANSFER_FORMATS = ['Text', 'Binary'];

// 宣告顺序即客户端的尝试顺序（客户端按列表顺序取第一个可用的传输）。
// 与上游一致：WebSockets 优先；WS 不可用（代理剥离 Upgrade、防火墙只放行普通 HTTP）时
// 回退 ServerSentEvents，再回退 LongPolling —— 这是上游具备、此前本实现缺失的降级能力。
const AVAILABLE_TRANSPORTS = [
  { transport: 'WebSockets', transferFormats: WS_TRANSFER_FORMATS },
  { transport: 'ServerSentEvents', transferFormats: SSE_TRANSFER_FORMATS },
  { transport: 'LongPolling', transferFormats: LP_TRANSFER_FORMATS },
];

function hubStub(env: Bindings): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName(HUB_INSTANCE));
}

// 写操作后广播（上游 _hubContext.Clients.All.RemoteProfileChanged / RemoteHistoryChanged）。
// 广播失败不影响主响应（上游 hub 异常被吞）。
export async function broadcast(
  env: Bindings,
  target: 'RemoteProfileChanged' | 'RemoteHistoryChanged',
  payload: unknown,
): Promise<void> {
  try {
    await hubStub(env).fetch('https://hub/broadcast', {
      method: 'POST',
      body: JSON.stringify({ target, payload }),
    });
  } catch {
    /* 忽略广播失败 */
  }
}

// 把 WebSocket 升级请求转发给 DO（index.ts 外层 fetch 使用）
export function forwardToHub(env: Bindings, request: Request): Promise<Response> {
  return hubStub(env).fetch(request);
}

// negotiate 响应（.NET SignalR JSON 协议）
// - 按上游顺序宣告三种传输（WebSockets → ServerSentEvents → LongPolling），客户端取首个可用的
// - negotiateVersion >= 1 时返回 connectionToken（v1 token 模式，WS/SSE/长轮询 URL 用 ?id=connectionToken）
// - 老客户端（无 negotiateVersion）用 connectionId 作为连接 id
// - 无论哪种模式都把 token 登记到 Hub：WS 升级时 DO 会校验它（F1）
export async function negotiateResponse(env: Bindings, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const negotiateVersion = url.searchParams.get('negotiateVersion');
  const connectionToken = randomToken();

  // 登记失败必须让 negotiate 失败：否则客户端会拿到一个永远无法通过升级校验的 token
  await registerConnectionToken(env, connectionToken);

  if (negotiateVersion !== null) {
    return Response.json({
      negotiateVersion: 1,
      connectionId: connectionToken,
      connectionToken,
      availableTransports: AVAILABLE_TRANSPORTS,
    });
  }

  return Response.json({
    connectionId: connectionToken,
    availableTransports: AVAILABLE_TRANSPORTS,
  });
}

async function registerConnectionToken(env: Bindings, token: string): Promise<void> {
  await hubStub(env).fetch(`https://hub${REGISTER_TOKEN_PATH}`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
