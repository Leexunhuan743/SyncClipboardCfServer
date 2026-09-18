// 广播触发与 negotiate 辅助（docs/protocol.md §6）
import { Bindings } from './env';

export const HUB_INSTANCE = 'hub';
export const HUB_PATH = '/SyncClipboardHub';
// token 登记路径（DO 侧同此常量）
export const REGISTER_TOKEN_PATH = '/register-token';
// 服务端支持的最大 negotiate 版本（上游 `HttpConnectionDispatcher._protocolVersion = 1`）；
// 客户端请求更高版本时被钳制到该值
const MAX_NEGOTIATE_VERSION = 1;

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
// 三传输及其可承载的格式。顺序 = 上游 `services.AddSignalR()` 的宣告顺序 = 客户端尝试顺序。
// 对 UI 的 info 端点也用它：把「本服务端支持哪些传输」如实告诉部署者。
export const AVAILABLE_TRANSPORTS = [
  { transport: 'WebSockets', transferFormats: WS_TRANSFER_FORMATS },
  { transport: 'ServerSentEvents', transferFormats: SSE_TRANSFER_FORMATS },
  { transport: 'LongPolling', transferFormats: LP_TRANSFER_FORMATS },
];

export function hubStub(env: Bindings): DurableObjectStub {
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
// 逐字对齐 ASP.NET Core 的 `HttpConnectionDispatcher.ProcessNegotiate` + `NegotiateProtocol.WriteResponse`：
//   - 版本判定（源码依据见 docs/protocol.md §6）：
//       缺参数 → 版本 0；非整数 → `{"error":"The client requested a non-integer protocol version."}`；
//       负数（< MinimumProtocolVersion=0）→ `{"error":"The client requested version '<v>', but the server does not support this version."}`；
//       > 1 → 钳为服务端最大值 1
//   - 出错时**仍返回 HTTP 200**，响应体只有 `error` 字段（dispatcher 不设置非 200 状态码）
//   - `negotiateVersion` **恒出现**（版本 0 也会写成 `"negotiateVersion":0`）
//   - `connectionToken` 仅在版本 > 0 时出现；`connectionId` 恒出现
//   - `availableTransports` 恒出现（数组），顺序即客户端尝试顺序
// 无论哪种版本都把 token 登记到 Hub：v1 客户端用它作 `?id=`；版本 0 客户端用 connectionId 作 `?id=`
// （本实现刻意让二者同值，使两种形态都能通过 DO 的连接鉴权，F1）。
export async function negotiateResponse(env: Bindings, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawVersion = url.searchParams.get('negotiateVersion');

  const parsed = negotiateClientVersion(rawVersion);
  if (typeof parsed === 'string') {
    // 上游此路径不创建连接、不签发 token，响应体只有 error
    return Response.json({ error: parsed });
  }
  const clientVersion = parsed;

  const connectionToken = await issueConnectionToken(env);

  const body: Record<string, unknown> = {
    negotiateVersion: clientVersion,
    connectionId: connectionToken,
  };
  if (clientVersion > 0) {
    body.connectionToken = connectionToken;
  }
  body.availableTransports = AVAILABLE_TRANSPORTS;
  return Response.json(body);
}

// 返回钳制后的版本号，或上游语义下的错误消息字符串
function negotiateClientVersion(raw: string | null): number | string {
  if (raw === null) return 0; // 未携带 → 版本 0（MinimumProtocolVersion 为 0，故不是错误）
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    return 'The client requested a non-integer protocol version.';
  }
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    // 上游：clientProtocolVersion < MinimumProtocolVersion(0) → 版本不支持
    return `The client requested version '${raw.trim()}', but the server does not support this version.`;
  }
  return Math.min(n, MAX_NEGOTIATE_VERSION);
}

// 生成随机连接令牌并登记进 DO —— negotiate 与 UI 的实时推送端点（`/ui/api/hub-ticket`）
// 共用这一条路径。登记失败必须让调用方失败：否则会把一张永远通不过升级校验的票据发出去。
// 版本 0 的客户端不带 ?id=，仅靠 Basic 头通过 DO 鉴权；登记它对两种形态都无害。
export async function issueConnectionToken(env: Bindings): Promise<string> {
  const token = randomToken();
  await registerConnectionToken(env, token);
  return token;
}

async function registerConnectionToken(env: Bindings, token: string): Promise<void> {
  const res = await hubStub(env).fetch(`https://hub${REGISTER_TOKEN_PATH}`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  // 必须看状态码：DO 存储异常时它会返回非 2xx，而调用方（negotiate / UI 票据端点）已经把
  // 「登记失败」当作可失败路径处理（503）——不看状态码就会把一张**注定连不上**的票据发出去，
  // 表现为「客户端反复重连、界面显示未连接」这类没有线索的现象。
  if (!res.ok) throw new Error(`hub register-token failed: ${res.status}`);
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
