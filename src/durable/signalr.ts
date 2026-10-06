// SignalR JSON 协议消息编解码（docs/protocol.md §6）
// 仅需服务端侧子集：握手 / Ping(type 6) / Close(type 7) / Invocation(type 1)
// 注意：SignalR 文本协议每条消息以 RS（0x1E）结尾，发送必须追加、解析必须剥离。

export const SIGNALR_PING = 6;
export const SIGNALR_CLOSE = 7;
export const SIGNALR_INVOCATION = 1;
export const RECORD_SEPARATOR = '\x1e';

export interface ParsedClientMessage {
  kind: 'handshake' | 'ping' | 'close' | 'invocation' | 'unknown';
  target?: string;
  arguments?: unknown[];
  /** kind === 'handshake'：请求里的 `protocol` / `version`（非字符串 / 非数字则为 undefined） */
  protocol?: string;
  version?: number;
}

// 客户端 → 服务端：
//   {"protocol":"json","version":1}\x1e            握手
//   {"type":6}\x1e                                 Ping
//   {"type":7}\x1e                                 Close
//   {"type":1,"target":"...","arguments":[...]}\x1e Invocation（官方客户端纯监听，不会发）
export function parseClientMessage(text: string): ParsedClientMessage {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text.replace(/\x1e+$/g, '')) as Record<string, unknown>;
  } catch {
    return { kind: 'unknown' };
  }
  if (typeof msg.protocol === 'string') {
    return {
      kind: 'handshake',
      protocol: msg.protocol,
      version: typeof msg.version === 'number' ? msg.version : undefined,
    };
  }
  switch (msg.type) {
    case SIGNALR_PING:
      return { kind: 'ping' };
    case SIGNALR_CLOSE:
      return { kind: 'close' };
    case SIGNALR_INVOCATION:
      return { kind: 'invocation', target: msg.target as string, arguments: msg.arguments as unknown[] };
    default:
      return { kind: 'unknown' };
  }
}

// 服务端 → 客户端：
//   握手成功响应：{}\x1e
export function handshakeResponse(): string {
  return '{}' + RECORD_SEPARATOR;
}

// ===== 握手校验（`docs/protocol.md` §10 的 SignalR 行）=====

/** 服务端唯一支持的协议名（比较**大小写不敏感**，与 ASP.NET 的 `HubProtocolResolver` 同侧）。 */
export const SUPPORTED_PROTOCOL = 'json';

/**
 * 判断握手请求是否可接受：接受返回 null，否则返回要回给客户端的 `error` 文案。
 * 为什么必须判（而不是"一律回 `{}`"）：**客户端只在收到 `error` 时才认"握手失败"** ——
 * `@microsoft/signalr` 的 `_processHandshakeResponse` 把 `responseMessage.error` 抛成
 * `Server returned handshake error: …`（.NET 客户端同构）。不判的话，一个只会说 MessagePack
 * 的客户端会**以为握手成功**，随后在每一帧上报解析错误（症状是"连上了但一直掉"），
 * 而上游（ASP.NET `HubConnectionHandler`）是回 `{"error":…}` 并关闭连接。
 * 版本只做「**≥ 1 的整数**」门槛，**不**照 `IsVersionSupported(v) => v == Version` 写死等值：
 * `JsonHubProtocol.version` 在 `@microsoft/signalr@8.0.7` 里是 **2**（老客户端发 1），
 * 写死等值会把这类客户端直接拒掉。
 * ⚠️ 下面两句错误文案按 ASP.NET Core 的常规措辞（**无法从本仓代码核实** ⇒ 标 [推断]）；
 * "回 error 帧并关闭"这一**行为**是核实的（客户端代码 + 上游 handler 的职责）。
 */
export function handshakeRejection(protocol: string | undefined, version: number | undefined): string | null {
  if (protocol === undefined || protocol.toLowerCase() !== SUPPORTED_PROTOCOL) {
    return `Requested protocol '${protocol ?? ''}' is not available.`;
  }
  if (version === undefined || !Number.isInteger(version) || version < 1) {
    return `The server does not support version ${version ?? 0} of the '${protocol}' protocol.`;
  }
  return null;
}

/** 带 `error` 字段的握手响应（客户端据此判失败，见 `handshakeRejection`）。 */
export function handshakeErrorResponse(reason: string): string {
  return JSON.stringify({ error: reason }) + RECORD_SEPARATOR;
}

// 广播 Invocation：{"type":1,"target":"...","arguments":[...]}\x1e
export function invocationMessage(target: string, args: unknown[]): string {
  return JSON.stringify({ type: SIGNALR_INVOCATION, target, arguments: args }) + RECORD_SEPARATOR;
}

// Close：{"type":7}\x1e
export function closeMessage(): string {
  return JSON.stringify({ type: SIGNALR_CLOSE }) + RECORD_SEPARATOR;
}

// Ping：{"type":6}\x1e（心跳；客户端 ServerTimeout 默认 30s，服务器须定期发送）
export function pingMessage(): string {
  return JSON.stringify({ type: SIGNALR_PING }) + RECORD_SEPARATOR;
}
