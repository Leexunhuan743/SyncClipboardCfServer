// 线上 SignalR 完整验证（走代理）：连接 / 广播 / 心跳
// 用法：NODE_USE_ENV_PROXY=1 node test/live-signalr.mjs <baseUrl>
// node 24 的 NODE_USE_ENV_PROXY=1 让 fetch 与 WebSocket 读取 HTTP(S)_PROXY 环境变量。
import * as signalR from '@microsoft/signalr';
import { createHash } from 'node:crypto';

// 目标地址由命令行参数或 BASE 环境变量提供（不硬编码任何部署地址）
const BASE = process.argv[2] ?? process.env.BASE;
if (!BASE) {
  console.error('用法: NODE_USE_ENV_PROXY=1 node test/live-signalr.mjs <baseUrl>');
  console.error('或设置 BASE 环境变量。');
  process.exit(2);
}
// 凭据由环境变量提供（默认值与本地 dev server 的 .dev.vars 一致）
const USER = process.env.USERNAME ?? 'admin';
const PASS = process.env.PASSWORD ?? 'admin';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const conn = new signalR.HubConnectionBuilder()
  .withUrl(`${BASE}/SyncClipboardHub`, {
    headers: { Authorization: AUTH },
    // signalr 在 node 默认用 ws 库（不走代理）；改用全局 undici WebSocket，由 NODE_USE_ENV_PROXY=1 代理
    WebSocket: WebSocket,
  })
  .build();

const got = { profile: [], history: [] };
conn.on('RemoteProfileChanged', (d) => {
  got.profile.push(d);
  console.log('[RECV] profile:', d.text);
});
conn.on('RemoteHistoryChanged', (d) => {
  got.history.push(d);
  console.log('[RECV] history:', d.text);
});

async function main() {
  await conn.start();
  console.log('[OK] connected:', conn.connectionId);

  const text = `cf-signalr-${Date.now()}`;
  const hash = createHash('sha256').update(text).digest('hex').toUpperCase();
  const res = await fetch(`${BASE}/SyncClipboard.json`, {
    method: 'PUT',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Text', hash, text, hasData: false }),
  });
  console.log('[PUT]', res.status);

  // 等待广播
  await new Promise((r) => setTimeout(r, 3000));
  const ok = got.profile.some((p) => p.hash === hash) && got.history.some((h) => h.hash === hash);
  console.log('[CHECK] broadcast received:', ok);

  // 心跳：等待 35s 跨过客户端 ServerTimeout（30s），验证线上 DO alarm 心跳
  let closed = false;
  conn.onclose(() => (closed = true));
  await new Promise((r) => setTimeout(r, 35_000));
  console.log('[CHECK] after 35s closed:', closed, '| state:', conn.state);
  const heartbeatOk = !closed && conn.state === signalR.HubConnectionState.Connected;

  await conn.stop();
  process.exit(ok && heartbeatOk ? 0 : 1);
}

main().catch((e) => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
