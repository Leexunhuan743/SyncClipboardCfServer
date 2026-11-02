// SignalR（JSON 协议）帧解析：纯函数，无 DOM 依赖，可在 Node 下直接测试。
// 每条消息以 RS(0x1e) 结尾，一个 WebSocket 帧里可能有多条消息（必须按 RS 拆）。
export const RS = '\x1e';

/** 把一个 WebSocket 帧拆成若干条消息（RS 分隔；尾部/连续分隔符不算消息）。 */
export function parseFrames(text: string): string[] {
  return text.split(RS).filter((part) => part !== '');
}

/**
 * 服务端消息分类：返回 SignalR 的类型号（1=Invocation 广播、6=Ping、7=Close），
 * 或 `'handshake'`（握手成功响应 `{}`，没有 type 字段）、`'unknown'`（无法解析）。
 * 只有 1 是「有东西变了」——这正是本页面唯一需要的语义。
 */
export function classifyMessage(raw: string): number | 'handshake' | 'unknown' {
  try {
    const msg = JSON.parse(raw);
    if (msg && typeof msg === 'object' && typeof (msg as { type?: unknown }).type === 'number') {
      return (msg as { type: number }).type;
    }
    return 'handshake';
  } catch {
    return 'unknown';
  }
}

