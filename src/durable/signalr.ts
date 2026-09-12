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
    return { kind: 'handshake' };
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
