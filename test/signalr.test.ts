// SignalR 兼容性测试：@microsoft/signalr（与 .NET 客户端同协议）连本地 hub
// 前置：本地 dev server 已运行（npm run dev）
import { describe, expect, it, beforeAll } from 'vitest';
import * as signalR from '@microsoft/signalr';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const USER = process.env.USER ?? 'admin';
const PASS = process.env.PASS ?? 'admin';
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
