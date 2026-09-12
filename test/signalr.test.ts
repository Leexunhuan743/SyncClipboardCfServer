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

// 广播 DTO 形状收窄（含 hash 字段的协议对象）
function hasHash(v: unknown): v is { hash: string } {
  return typeof v === 'object' && v !== null && 'hash' in v;
}

function delay(ms: number): Promise<void> {
  // 心跳测试故意使用真实时钟：验证服务端 alarm 心跳 vs 客户端 ServerTimeout（30s）的真实交互，
  // 无法用假时钟替代（涉及跨进程 WS 连接与 DO alarm）。
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function connect() {
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${BASE}/SyncClipboardHub`, { headers: { Authorization: AUTH } })
    .build();
  await connection.start();
  return connection;
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/`, { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`dev server 不可用 (${BASE}): ${res.status}`);
});

describe('SignalR 兼容 Hub', () => {
  it('连接 + 握手成功（拿到 connectionId）', async () => {
    const connection = await connect();
    expect(connection.connectionId).toBeTruthy();
    await connection.stop();
  });

  it('PUT /SyncClipboard.json 触发 RemoteProfileChanged + RemoteHistoryChanged 广播', async () => {
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

    // 广播 await 于响应内（服务端 await 后返回），响应到达即应收到。
    // 并发跑其他测试文件时可能混入无关广播，故只断言本次 PUT 的 hash 且类型为 Text。
    expect(profile.some((p) => hasHash(p) && p.hash === hash)).toBe(true);
    expect(history.some((h) => hasHash(h) && h.hash === hash)).toBe(true);
    await connection.stop();
  });

  it('PATCH /api/history 成功路径也触发 RemoteHistoryChanged（F6：广播在响应返回前 await）', async () => {
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
    // 响应到达时广播应已 await 完成；floating promise 的实现会非确定性丢失
    expect(history.some((h) => hasHash(h) && h.hash === hash)).toBe(true);
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
