// SignalR 兼容性测试：@microsoft/signalr（与 .NET 客户端同协议）连本地 hub
// 前置：本地 dev server 已运行（npm run dev）
import { describe, expect, it, beforeAll } from 'vitest';
import * as signalR from '@microsoft/signalr';
import { createHash } from 'node:crypto';
import { assertWritableTarget } from './support/target-guard';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

// 本套件会写目标库：默认只允许指向本机 dev server，指向远端需显式 ALLOW_REMOTE_TARGET=1
assertWritableTarget(BASE);
// 凭据变量名专用化：`USER`/`USERNAME` 在宿主环境里恒被占用
// （Windows 有 USERNAME，Ubuntu CI runner 有 USER=runner），用它们会让测试
// 拿错凭据→401 假失败。只认 SYNC_USER / SYNC_PASS，默认与 .dev.vars 示例一致。
const USER = process.env.SYNC_USER ?? 'admin';
const PASS = process.env.SYNC_PASS ?? 'admin';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex').toUpperCase();

// @microsoft/signalr 在 Node 下默认用 ws 库，而 ws 库不读 HTTP(S)_PROXY：BASE 为远端且本机需经代理
// 出网时，WS 会在**客户端侧**握手失败（服务端无问题），表现为整组用例超时。
// 注入全局 WebSocket（undici，会走代理）使本文件在本地与线上都能验证服务端行为。
// 运行时支持 `options.WebSocket`，但其 TS 声明未暴露该字段。
interface HubOptionsWithWebSocket extends signalR.IHttpConnectionOptions {
  WebSocket?: new (url: string, protocols?: string | string[]) => unknown;
}

// 广播 DTO 形状收窄（含 hash 字段的协议对象）
function hasHash(v: unknown): v is { hash: string } {
  return typeof v === 'object' && v !== null && 'hash' in v;
}

// 有界轮询等待条件成立。F6 的真实主张是「广播被 await、不会因 floating promise 丢失」——
// 服务端把消息交给传输后，帧仍需经网络抵达客户端；本地 RTT≈0 时「响应即已收到」貌似成立，
// 但经代理/WAN 访问线上时该假设不成立（断言会假失败）。有界等待保留了判别力：
// 若广播真的丢失（响应后才 fire-and-forget，Workers 可能在响应后终止该 promise），
// 无论等多久都收不到，用例仍会失败。
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(100);
  }
  return predicate();
}

function delay(ms: number): Promise<void> {
  // 心跳测试故意使用真实时钟：验证服务端 alarm 心跳 vs 客户端 ServerTimeout（30s）的真实交互，
  // 无法用假时钟替代（涉及跨进程 WS 连接与 DO alarm）。
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function connect() {
  const options: HubOptionsWithWebSocket = { headers: { Authorization: AUTH }, WebSocket };
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${BASE}/SyncClipboardHub`, options)
    .build();
  await connection.start();
  return connection;
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/`, { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`dev server 不可用 (${BASE}): ${res.status}`);
});

describe('SignalR 兼容 Hub', () => {
  it('连接 + 握手成功（拿到 connectionId）', { timeout: 60_000 }, async () => {
    const connection = await connect();
    expect(connection.connectionId).toBeTruthy();
    await connection.stop();
  });

  it('PUT /SyncClipboard.json 触发 RemoteProfileChanged + RemoteHistoryChanged 广播', { timeout: 60_000 }, async () => {
    const connection = await connect();
    const profile: unknown[] = [];
    const history: unknown[] = [];
    connection.on('RemoteProfileChanged', (dto) => profile.push(dto));
    connection.on('RemoteHistoryChanged', (dto) => history.push(dto));

    const text = `signalr-${Date.now()}`;
    const hash = sha256(text);
    const res = await fetch(`${BASE}/SyncClipboard.json`, {
      method: 'PUT',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash, text, hasData: false }),
    });
    expect(res.status).toBe(200);

    // 服务端在响应前 await 广播；这里仍有界等待帧抵达（见 waitFor 说明）。
    // 并发跑其他测试文件时可能混入无关广播，故只断言本次 PUT 的 hash。
    expect(await waitFor(() => profile.some((p) => hasHash(p) && p.hash === hash)), 'RemoteProfileChanged').toBe(true);
    expect(await waitFor(() => history.some((h) => hasHash(h) && h.hash === hash)), 'RemoteHistoryChanged').toBe(true);
    await connection.stop();
  });

  it('PATCH /api/history 成功路径也触发 RemoteHistoryChanged（F6：广播在响应返回前 await）', { timeout: 60_000 }, async () => {
    const connection = await connect();
    const history: unknown[] = [];
    connection.on('RemoteHistoryChanged', (dto) => history.push(dto));

    const text = `signalr-patch-${Date.now()}`;
    const hash = sha256(text);
    const put = await fetch(`${BASE}/SyncClipboard.json`, {
      method: 'PUT',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash, text, hasData: false, size: text.length }),
    });
    expect(put.status).toBe(200);

    const res = await fetch(`${BASE}/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true, version: 999 }),
    });
    expect(res.status).toBe(200);
    // 服务端在响应前 await 广播；floating promise 的实现会非确定性丢失（等待也不会到达）
    expect(await waitFor(() => history.some((h) => hasHash(h) && h.hash === hash)), 'RemoteHistoryChanged').toBe(true);
    await connection.stop();
  });

  it('心跳：连接保持超过客户端 ServerTimeout（30s）不掉线', { timeout: 60_000 }, async () => {
    const connection = await connect();
    let closed: Error | undefined;
    connection.onclose((e) => (closed = e));

    // 真实时钟：验证 DO alarm 心跳（15s）能跨过客户端 ServerTimeout（30s）
    await delay(35_000);
    expect(closed).toBeUndefined();
    expect(connection.state).toBe(signalR.HubConnectionState.Connected);
    await connection.stop();
  });
});

// ===== 握手校验（2026-10-03）：协议/版本不支持时必须**显式拒** =====
// 客户端只在收到 `error` 时才认"握手失败" —— 实测本仓 dev 依赖的 `@microsoft/signalr`
// （`dist/esm/HubConnection.js` 的 `_processHandshakeResponse`）把 `responseMessage.error` 抛成
// `Server returned handshake error: …`（.NET 客户端同构）。不拒的话，只说 MessagePack 的客户端会
// **以为握手成功**、随后在每一帧上报解析错误（症状是"连上了但一直掉"）。
describe('SignalR 握手校验：协议/版本（原始 WS，不用客户端库的判断）', () => {
  const RS = '\u001e';
  const WS_BASE = BASE.replace(/^http/, 'ws');

  // negotiate 拿 connectionToken（v1 形态；本实现让 connectionId 与 token 同值，两者都可作 ?id=）
  async function negotiateToken(): Promise<string> {
    const res = await fetch(`${BASE}/SyncClipboardHub/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectionToken?: string; connectionId?: string };
    return body.connectionToken ?? body.connectionId ?? '';
  }

  function rawHandshake(
    token: string,
    handshake: Record<string, unknown>,
    { expectClose = true }: { expectClose?: boolean } = {},
  ): Promise<{ frames: string[]; closed: boolean }> {
    const { promise, resolve } = Promise.withResolvers<{ frames: string[]; closed: boolean }>();
    const frames: string[] = [];
    const done = (): void => resolve({ frames, closed: true });
    const ws = new WebSocket(`${WS_BASE}/SyncClipboardHub?id=${token}`);
    // ⚠️ 用 `addEventListener`，**不是** `ws.onmessage = …`：本仓库的类型面是 Workers 的 `WebSocket`
    //    （只有 addEventListener / send / close），而运行时这里是 undici 的 WHATWG WebSocket —— 两者都支持。
    ws.addEventListener('message', (event) => {
      frames.push(typeof event.data === 'string' ? event.data : '');
      if (!expectClose) ws.close();
    });
    ws.addEventListener('close', done);
    ws.addEventListener('error', done);
    ws.addEventListener('open', () => ws.send(JSON.stringify(handshake) + RS));
    // 兜底（真实时钟，故意）：这是**真实跨进程 WS**（undici ↔ workerd/DO 平台时钟），假时钟替代不了；
    // 它的唯一用途是把"服务端没关闭连接"报成 closed=false 的断言失败，而不是挂到 vitest 超时。
    setTimeout(() => resolve({ frames, closed: false }), 15_000);
    return promise;
  }

  it('不支持的协议 ⇒ 回 {"error":…} 帧并**关闭**连接（上游 SendHandshakeError 同形）', { timeout: 60_000 }, async () => {
    const token = await negotiateToken();
    const { frames, closed } = await rawHandshake(token, { protocol: 'messagepack', version: 1 });
    const joined = frames.join('');
    expect(joined, '必须回一个带 error 的握手响应').toContain('"error"');
    expect(joined).toContain("Requested protocol 'messagepack' is not available.");
    expect(closed, '拒绝后必须关闭连接').toBe(true);
  });

  it('版本非「≥1 的整数」⇒ 同样拒绝（version=0）', { timeout: 60_000 }, async () => {
    const token = await negotiateToken();
    const { frames, closed } = await rawHandshake(token, { protocol: 'json', version: 0 });
    const joined = frames.join('');
    expect(joined).toContain('"error"');
    expect(joined).toContain("does not support version 0 of the 'json' protocol");
    expect(closed).toBe(true);
  });

  it('version=2 **接受**（不写死等值：实测 @microsoft/signalr 8.0.7 的 JsonHubProtocol.version 是 2）', { timeout: 60_000 }, async () => {
    const token = await negotiateToken();
    const { frames } = await rawHandshake(token, { protocol: 'json', version: 2 }, { expectClose: false });
    expect(frames.join(''), '合法握手必须回 {}（带 RS）').toContain('{}');
    expect(frames.join('')).not.toContain('"error"');
  });
});
