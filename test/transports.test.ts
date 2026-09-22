// SignalR 三种传输的兼容性测试（对齐上游 ASP.NET Core SignalR 的宣告顺序与降级能力）
// 前置：本地 dev server 已运行（npm run dev）
//
// 覆盖：
//   WebSockets（首选）—— 既有路径，回归
//   ServerSentEvents  —— 新增：EventSource 流式接收 + POST 上报
//   LongPolling       —— 新增：GET 取消息（挂起/超时）、POST 上报、DELETE 关闭
// 每个传输都验证：握手成功、能收到广播、连接可保持（心跳生效）。
import { describe, expect, it, beforeAll, vi } from 'vitest';
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

// @microsoft/signalr 的运行时支持 `options.WebSocket`（HttpConnection 读取 this._options.WebSocket，
// 供调用方注入自定义 WebSocket 构造函数），但其 TS 声明未暴露该字段。
// 这里显式补充，避免把整个 options 断言成 any。
interface HubOptionsWithWebSocket extends signalR.IHttpConnectionOptions {
  WebSocket?: new (url: string, protocols?: string | string[]) => unknown;
}

function hasHash(v: unknown): v is { hash: string } {
  return typeof v === 'object' && v !== null && 'hash' in v;
}

async function putProfile(text: string) {
  const hash = sha256(text);
  const res = await fetch(`${BASE}/SyncClipboard.json`, {
    method: 'PUT',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Text', hash, text, hasData: false, size: text.length }),
  });
  if (res.status !== 200) throw new Error(`PUT /SyncClipboard.json -> ${res.status}`);
  return hash;
}

// 用指定传输建立连接，PUT 一次 profile，断言收到两条广播
async function expectBroadcastOverTransport(transportName: string, transport: signalR.HttpTransportType) {
  // @microsoft/signalr 在 Node 下默认用 ws 库，而 ws 库不读 HTTP(S)_PROXY；
  // 当 BASE 是远端且本机需经代理出网时，WS 会在客户端侧失败（服务端并无问题）。
  // 注入全局 WebSocket（undici，会走代理），让该用例在任何环境下都能验证服务端 WS 路径。
  // 这不改变被测服务端的任何行为。
  const options: HubOptionsWithWebSocket = { headers: { Authorization: AUTH }, transport, WebSocket };
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${BASE}/SyncClipboardHub`, options)
    .build();

  const profiles: unknown[] = [];
  const histories: unknown[] = [];
  connection.on('RemoteProfileChanged', (dto) => profiles.push(dto));
  connection.on('RemoteHistoryChanged', (dto) => histories.push(dto));

  await connection.start();
  // 传输确实被采用（长轮询/SSE 的连接对象上会记录 transport 名）
  expect(connection.connectionId, `${transportName}: connectionId`).toBeTruthy();

  const text = `transport-${transportName}-${Date.now()}`;
  const hash = await putProfile(text);

  // 等待消息送达（长轮询依赖下一次轮询或已挂起的轮询被唤醒）
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (profiles.some((p) => hasHash(p) && p.hash === hash) && histories.some((h) => hasHash(h) && h.hash === hash)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  expect(profiles.some((p) => hasHash(p) && p.hash === hash), `${transportName}: RemoteProfileChanged`).toBe(true);
  expect(histories.some((h) => hasHash(h) && h.hash === hash), `${transportName}: RemoteHistoryChanged`).toBe(true);

  await connection.stop();
}

// 批量写把逐条广播**合并成一次** DO 子请求（2026-09-22，ADR D33）。合并唯一允许的后果是
// "少 N-1 次子请求" —— 客户端收到的东西必须与逐条广播时**一模一样**（每条记录一条消息）。
// 这条用例钉的正是这个不变量，且走的是真实链路：真实连接 + 真实 `/ui/api/history/batch-update`。
describe('批量写的合并广播（ADR D33）', () => {
  it('一次 batch-update 改 3 条 ⇒ 连接上出现 3 条独立 RemoteHistoryChanged', async () => {
    const options: HubOptionsWithWebSocket = {
      headers: { Authorization: AUTH },
      transport: signalR.HttpTransportType.LongPolling,
      WebSocket,
    };
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(`${BASE}/SyncClipboardHub`, options)
      .build();
    const histories: unknown[] = [];
    connection.on('RemoteHistoryChanged', (dto) => histories.push(dto));
    await connection.start();

    const stamp = Date.now();
    const hashes: string[] = [];
    for (const i of [1, 2, 3]) hashes.push(await putProfile(`batch-broadcast-${stamp}-${i}`));

    // 先等 PUT 自己那三条广播到齐，再清空计数 —— 否则"到了"的可能仍是 PUT 发的那条（假通过）。
    // `vi.waitFor` 而不是手写 `setTimeout` 轮询：这里等的是**网络到达**（真实集成链路），
    // 用假计时器推不动它，而 `vi.waitFor` 会按真实时间重试、超时即失败并指出是哪一条没到。
    await vi.waitFor(
      () => {
        const got = new Set(histories.filter(hasHash).map((h) => h.hash));
        for (const hash of hashes) expect(got.has(hash), `PUT 的广播 ${hash.slice(0, 8)}`).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );
    histories.length = 0;

    const res = await fetch(`${BASE}/ui/api/history/batch-update`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: hashes.map((hash) => ({ type: 'Text', hash })),
        update: { starred: true },
      }),
    });
    expect(res.status, '批量写必须成功').toBe(200);
    expect((await res.json()) as { updated: number }).toMatchObject({ updated: 3 });

    await vi.waitFor(
      () => {
        const got = new Set(histories.filter(hasHash).map((h) => h.hash));
        for (const hash of hashes) expect(got.has(hash), `合并广播漏了 ${hash.slice(0, 8)}`).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );
    await connection.stop();
  });
});

beforeAll(async () => {
  const res = await fetch(`${BASE}/`, { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`dev server 不可用 (${BASE}): ${res.status}`);
});

describe('SignalR 传输宣告与降级', () => {
  it('negotiate 按上游顺序宣告三种传输（WebSockets → ServerSentEvents → LongPolling）', async () => {
    const res = await fetch(`${BASE}/SyncClipboardHub/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connectionToken: string;
      availableTransports: { transport: string; transferFormats: string[] }[];
    };
    expect(body.connectionToken).toBeTruthy();
    expect(body.availableTransports.map((t) => t.transport)).toEqual([
      'WebSockets',
      'ServerSentEvents',
      'LongPolling',
    ]);
    // 与上游 ASP.NET Core SignalR 的传输格式表一致
    const byName = Object.fromEntries(body.availableTransports.map((t) => [t.transport, t.transferFormats]));
    expect(byName.WebSockets).toEqual(['Text', 'Binary']);
    expect(byName.ServerSentEvents).toEqual(['Text']);
    expect(byName.LongPolling).toEqual(['Text', 'Binary']);
  });

  it('WebSockets：握手 + 广播（回归）', async () => {
    await expectBroadcastOverTransport('ws', signalR.HttpTransportType.WebSockets);
  }, 40_000);

  it('ServerSentEvents：握手 + 广播（回退能力）', async () => {
    await expectBroadcastOverTransport('sse', signalR.HttpTransportType.ServerSentEvents);
  }, 30_000);

  it('LongPolling：握手 + 广播（回退能力）', async () => {
    await expectBroadcastOverTransport('lp', signalR.HttpTransportType.LongPolling);
  }, 40_000);

  it('长轮询首轮 GET 立即返回 200（对齐 ASP.NET：首个轮询用于完成初始化）', async () => {
    const negotiate = await fetch(`${BASE}/SyncClipboardHub/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers: { Authorization: AUTH },
    });
    const { connectionToken } = (await negotiate.json()) as { connectionToken: string };

    const started = Date.now();
    const res = await fetch(`${BASE}/SyncClipboardHub?id=${connectionToken}&_=${Date.now()}`, {
      headers: { Authorization: AUTH },
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(elapsed, '首个轮询不应挂起').toBeLessThan(3_000);

    // 清理：客户端关闭时发的 DELETE（客户端容忍 404，这里应 200）
    const del = await fetch(`${BASE}/SyncClipboardHub?id=${connectionToken}`, {
      method: 'DELETE',
      headers: { Authorization: AUTH },
    });
    expect(del.status).toBe(200);
  }, 20_000);

  it('长轮询挂起的上限有界：无消息时不会永久挂住（>25s 内必须返回）', async () => {
    const negotiate = await fetch(`${BASE}/SyncClipboardHub/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers: { Authorization: AUTH },
    });
    const { connectionToken } = (await negotiate.json()) as { connectionToken: string };

    // 首次 GET 建立连接
    await fetch(`${BASE}/SyncClipboardHub?id=${connectionToken}&_=${Date.now()}`, {
      headers: { Authorization: AUTH },
    });

    // 第二次 GET 会挂起；服务端 Ping（15s）或 25s 超时应使其返回
    const started = Date.now();
    const res = await fetch(`${BASE}/SyncClipboardHub?id=${connectionToken}&_=${Date.now()}`, {
      headers: { Authorization: AUTH },
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed, '应在 POLL_TIMEOUT 前后返回').toBeLessThan(31_000);

    await fetch(`${BASE}/SyncClipboardHub?id=${connectionToken}`, {
      method: 'DELETE',
      headers: { Authorization: AUTH },
    });
  }, 45_000);

  it('自动回退：不指定传输时，WS 不可用的网络下仍能连接并收到广播', async () => {
    // 这条是「回退能力」的核心验证：不强制传输（与官方客户端一致，OfficialAdapter 未设置
    // Transports），由客户端按服务端宣告顺序自行选择。在 WS 可用的网络会走 WebSockets；
    // 在 WS 被阻断的网络（如剥离 Upgrade 的代理）应自动降级到 SSE/长轮询并仍然连通。
    const autoOptions: HubOptionsWithWebSocket = { headers: { Authorization: AUTH }, WebSocket };
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(`${BASE}/SyncClipboardHub`, autoOptions)
      .build();
    const profiles: unknown[] = [];
    connection.on('RemoteProfileChanged', (dto) => profiles.push(dto));

    await connection.start();
    expect(connection.connectionId).toBeTruthy();

    const text = `auto-fallback-${Date.now()}`;
    const hash = await putProfile(text);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !profiles.some((p) => hasHash(p) && p.hash === hash)) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(profiles.some((p) => hasHash(p) && p.hash === hash), '自动选择的传输应能收到广播').toBe(true);

    await connection.stop();
  }, 40_000);

  it('无有效凭据与 token 时，三种传输的连接请求一律 401', async () => {
    // SSE
    const sse = await fetch(`${BASE}/SyncClipboardHub?id=forged`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(sse.status, 'SSE').toBe(401);
    // 长轮询 GET
    const get = await fetch(`${BASE}/SyncClipboardHub?id=forged`);
    expect(get.status, 'LongPolling GET').toBe(401);
    // 长轮询 POST
    const post = await fetch(`${BASE}/SyncClipboardHub?id=forged`, { method: 'POST', body: 'x' });
    expect(post.status, 'LongPolling POST').toBe(401);
    // 长轮询 DELETE
    const del = await fetch(`${BASE}/SyncClipboardHub?id=forged`, { method: 'DELETE' });
    expect(del.status, 'LongPolling DELETE').toBe(401);
  }, 20_000);
});
