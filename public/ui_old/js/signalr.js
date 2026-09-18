// 原生 SignalR（JSON 协议）推送通道：只实现本页面用得到的那一小块 —— 连上、保活、收广播。
//
// 为什么不用 `@microsoft/signalr`：前端是**零构建**的原生 ES 模块（ADR D12），引入 npm 包就得
// 加打包器或手抄一份 UMD。而这里需要的协议面极小，服务端就在同仓（`src/durable/signalr.ts`），
// 消息形状以那份实现为准：
//   客户端 → 服务端：`{"protocol":"json","version":1}` 握手；`{"type":6}` 心跳
//   服务端 → 客户端：`{}` 握手成功；`{"type":1,"target":…,"arguments":[…]} ` 广播；`{"type":6}` 心跳
// 每条消息以 RS(0x1e) 结尾，一个 WebSocket 帧里可能有多条消息（必须按 RS 拆）。
//
// 连接凭据走 `?id=<票据>`：浏览器的 WebSocket 构造函数**不能设置请求头**，票据由
// `/ui/api/hub-ticket`（会话 Cookie 鉴权）签发，这在 DO 侧是既有的连接鉴权通道之一。
const RS = '\x1e';
const HANDSHAKE = `${JSON.stringify({ protocol: 'json', version: 1 })}${RS}`;
const PING = `${JSON.stringify({ type: 6 })}${RS}`;

// DO 侧静默超过 60 秒即断（`SyncClipboardHub.IDLE_TIMEOUT_MS`），且**任何**入站消息都会重置计时，
// 故这里每 30 秒发一次心跳（留一半余量；DO 自己每 15 秒也会下发一次 ping）。
const HEARTBEAT_MS = 30_000;
// 重连退避：首次 2 秒，逐次翻倍到 60 秒。断线期间界面继续靠轮询收敛（见 main.js）。
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// 连续失败到这一次数就停止重连。动机：环境若根本不支持 WebSocket（或被 CSP / 代理稳定阻断），
// 每 ≤60 秒重试一次的代价是 ≈1.4k 请求/天 —— 与它取代的轮询同量级，白花。
// 计数在**握手成功**时清零；页面切回前台会重新 start()（同时清零），故不会永久失效。
const MAX_CONSECUTIVE_FAILURES = 5;

/** 把一个 WebSocket 帧拆成若干条消息（RS 分隔；尾部/连续分隔符不算消息）。 */
export function parseFrames(text) {
  return text.split(RS).filter((part) => part !== '');
}

/**
 * 服务端消息分类：返回 SignalR 的类型号（1=Invocation 广播、6=Ping、7=Close），
 * 或 `'handshake'`（握手成功响应 `{}`，没有 type 字段）、`'unknown'`（无法解析）。
 * 只有 1 是「有东西变了」——这正是本页面唯一需要的语义。
 */
export function classifyMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg && typeof msg === 'object' && typeof msg.type === 'number') return msg.type;
    return 'handshake';
  } catch {
    return 'unknown';
  }
}

/**
 * 建立推送通道。状态机很小但每条转换都有理由：
 *   offline → connecting（取票据 + 建连）→ live（收到握手响应）→ offline（断开或有错）→ 退避重连
 * `acquireTicket` 返回连接路径（`/SyncClipboardHub?id=…`）；它失败时同样退避重试——
 * 拿不到票据通常意味着 DO 不可达，那正是最需要保持轮询的时候。
 */
export function createPushChannel({ acquireTicket, onSignal, onState }) {
  let socket = null;
  let heartbeat = 0;
  let retryTimer = 0;
  let retryDelay = RETRY_MIN_MS;
  let state = 'offline';
  let stopped = false;
  let failures = 0;
  // 取票据期间也占住「正在连接」：否则两次 start()（boot + 一次可见性切换）会各取一张票据、
  // 各建一条连接 —— 后建的那条覆盖 `socket`，先建的那条就再也没人关得掉。
  let pending = false;

  function setState(next) {
    if (state === next) return;
    state = next;
    onState?.(next);
  }

  function clearTimers() {
    clearInterval(heartbeat);
    heartbeat = 0;
    clearTimeout(retryTimer);
    retryTimer = 0;
  }

  function scheduleRetry() {
    if (stopped || retryTimer || failures >= MAX_CONSECUTIVE_FAILURES) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      open();
    }, delay);
  }

  function teardown(nextSocket) {
    // 判据是「**当前是否另有**一条连接」，不是「它是不是自己那条」：
    //   · `socket` 为 null  → 收尾（error 处理器已把引用清掉，close 才到；正常断网就是这条路径）
    //   · `socket` 就是它    → 收尾（当前连接自己结束）
    //   · `socket` 是别人    → 忽略（stop() 或新连接已取代它，迟到的 close 不能动新连接的心跳与状态）
    // 上一版写成 `socket !== nextSocket` 就返回，把 error→close 那条**常见**路径整个吞掉了：
    // 状态永远停在 'live'（面板显示「已连接」却早已断开）、轮询停在看门狗档、也不再重连。
    if (socket !== null && socket !== nextSocket) return;
    socket = null;
    clearInterval(heartbeat);
    heartbeat = 0;
    failures += 1;
    setState('offline');
    scheduleRetry();
  }

  function open() {
    if (stopped || socket || pending) return;
    pending = true;
    setState('connecting');
    acquireTicket()
      .then((path) => {
        pending = false;
        if (stopped || socket) return;
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${scheme}//${location.host}${path}`);
        socket = ws;

        ws.addEventListener('open', () => {
          retryDelay = RETRY_MIN_MS;
          ws.send(HANDSHAKE);
        });
        ws.addEventListener('message', (event) => {
          // 二进制帧不该出现（服务端只发文本）；忽略而不是尝试解码
          if (typeof event.data !== 'string') return;
          for (const frame of parseFrames(event.data)) {
            const kind = classifyMessage(frame);
            if (kind === 'handshake') {
              failures = 0;
              setState('live');
              // 握手成功才开始心跳：连之前发消息没有意义，还会让 DO 看到一个半开连接
              if (heartbeat === 0) {
                heartbeat = setInterval(() => {
                  if (socket?.readyState === WebSocket.OPEN) socket.send(PING);
                }, HEARTBEAT_MS);
              }
            } else if (kind === 1) {
              // 任何广播都当作「有东西变了」：具体的增量由列表刷新自己算（与轮询同一条路径），
              // 于是多设备并发改动的对账逻辑只有一份。
              onSignal?.();
            } else if (kind === 7) {
              ws.close();
            }
          }
        });
        ws.addEventListener('close', () => teardown(ws));
        ws.addEventListener('error', () => {
          // error 之后浏览器必然再发 close；这里只清掉引用，重连交给 close 那一路，
          // 否则两条路径各排一次重连，退避会翻倍得莫名其妙。
          if (socket === ws) socket = null;
        });
      })
      .catch(() => {
        // 拿不到票据多半是 DO 不可达或会话过期：同样计入失败，避免在坏环境里无限重试
        pending = false;
        failures += 1;
        setState('offline');
        scheduleRetry();
      });
  }

  return {
    start() {
      // 环境层面就不支持时直接放弃（剩下的交给轮询），不必等五次失败
      if (typeof WebSocket !== 'function') {
        setState('offline');
        return;
      }
      stopped = false;
      failures = 0;
      open();
    },
    stop() {
      stopped = true;
      clearTimers();
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close();
        } catch {
          /* 已关闭 */
        }
      }
      setState('offline');
    },
    get state() {
      return state;
    },
  };
}
