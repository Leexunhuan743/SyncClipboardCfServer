// 界面运行时探针（手动运行，不属于 npm test 套件）
//
// 为什么需要它：截图只能证明"看起来对"，证明不了"DOM 里的值对"。这个仓库的前端是零构建的，
// 没有组件测试，于是「概览说 2191、列表说 1009」「抽屉点了没开」这类问题
// 只能靠人肉对着屏幕猜。本脚本用 CDP 读**真实页面的真实 DOM 值**，把它们打出来。
//
// 用法（需 dev server 已启动）：
//   node test/manual/probe.mjs
//   node test/manual/probe.mjs --url "/ui/app/?deleted=1"
//
// 与 shoot.mjs 的关系：两者共用同一套 CDP 起浏览器/登录/注入 Cookie 的做法，
// 但目的不同 —— shoot 出图（给人看），probe 出值（给断言看）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const URL_PATH = arg('url', '/ui/app/');
const PORT = Number(arg('port', '9341'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SETTLE = Number(arg('settle', '4500'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const path of BROWSERS) if (existsSync(path)) return path;
  throw new Error(`未找到 Edge/Chrome：\n  ${BROWSERS.join('\n  ')}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === undefined || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
      else resolve(msg.result);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30_000);
    });
  }
}

async function waitForDevTools(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return res.json();
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`DevTools 端点未就绪：${last?.message}`);
}

const profileDir = join(tmpdir(), `probe-profile-${process.pid}`);
mkdirSync(profileDir, { recursive: true });
const proc = spawn(
  findBrowser(),
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let browserWs;
let cdp;
try {
  const version = await waitForDevTools(PORT);
  browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browserWs.addEventListener('open', resolve, { once: true });
    browserWs.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  cdp = new Cdp(browserWs);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  // 真实登录接口 → 服务端签发的会话 Cookie（不是伪造已登录状态）
  const login = await fetch(`${BASE}/ui/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}：${await login.text()}`);
  const rawCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const eq = rawCookie.indexOf('=');
  await send('Network.setCookie', {
    name: rawCookie.slice(0, eq),
    value: rawCookie.slice(eq + 1),
    domain: new URL(BASE).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  });

  // 收集控制台错误与失败请求：页面"看起来对但其实是坏的"最常见的两种形态
  const consoleErrors = [];
  const failedRequests = [];
  cdp.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(`未捕获异常：${msg.params?.exceptionDetails?.exception?.description ?? ''}`);
    }
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(`${msg.params?.type} ${msg.params?.errorText}`);
    }
    if (msg.method === 'Network.responseReceived' && (msg.params?.response?.status ?? 200) >= 400) {
      failedRequests.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
  });

  await send('Page.navigate', { url: `${BASE}${URL_PATH}` });
  await new Promise((r) => setTimeout(r, SETTLE));

  const read = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(
        `${d.text ?? 'Uncaught'} :: ${d.exception?.description ?? JSON.stringify(d).slice(0, 400)}`,
      );
    }
    return result.result.value;
  };

  const state = await read(`JSON.stringify({
    booted: document.documentElement.dataset.appBooted ?? null,
    theme: document.documentElement.dataset.theme ?? null,
    h1Count: document.querySelectorAll('h1').length,
    rows: document.querySelectorAll('.item').length,
    boardCount: document.querySelector('.board-head__count')?.textContent ?? null,
    chipAll: document.querySelector('.chip[data-kind="All"] .chip__num')?.textContent ?? null,
    overviewTotal: document.querySelector('.overview__stat .overview__value')?.textContent ?? null,
    overviewTotalLabel: document.querySelector('.overview__stat .overview__label')?.textContent ?? null,
    overviewSize: [...document.querySelectorAll('.overview__stat')].at(-1)?.querySelector('.overview__value')?.textContent ?? null,
    kinds: [...document.querySelectorAll('.kinds__item')].map((n) => n.textContent.trim()),
    // 趋势图：条数只证明 DOM 在，**不等于看得见** —— 2026-09-18 的缺陷正是
    // "14 根柱都在、可见高度 0"（基础规则的 .main > .overview 前缀压过了窄屏那档媒体查询）。
    // 故把渲染盒一起量出来：中屏/桌面上它应当让位（h=0），窄屏应当独占一行（h>0）。
    sparkBars: document.querySelectorAll('.overview__spark rect').length,
    sparkBox: (() => {
      const box = document.querySelector('.overview__spark')?.getBoundingClientRect();
      return box ? { w: Math.round(box.width), h: Math.round(box.height) } : null;
    })(),
    syncState: document.querySelector('.sync')?.dataset.state ?? null,
    syncLabel: document.querySelector('.sync__label')?.textContent ?? null,
    noticeHidden: document.getElementById('notice')?.hidden ?? null,
    daymarks: [...document.querySelectorAll('.daymark')].map((n) => n.textContent.trim()),
    firstRowKind: document.querySelector('.item__kind')?.dataset.type ?? null,
    firstRowMeta: document.querySelector('.entry__meta')?.textContent ?? null,
    // ⚠️ 取"第一行"必须按**类**取，不能按 tr:first-of-type：默认排序（createTime）下
    // tbody 的第一个 tr 是**分组小标题**（.daymark），tr:first-of-type 命中的是它 ⇒
    // 这一项会恒为空数组（看起来像"行内没有操作按钮"，实测 2026-09-18）。
    firstRowOps: [...(document.querySelector('.item')?.querySelectorAll('.rowops .icon-btn') ?? [])].map((b) => b.dataset.icon),
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  })`);
  console.log('STATE  ', state);

  // 打开抽屉（概览带整条是按钮）
  await read(
    `document.getElementById('overview').dispatchEvent(new MouseEvent('click', { bubbles: true })), 'clicked'`,
  );
  await new Promise((r) => setTimeout(r, 900));
  const drawer = await read(`JSON.stringify({
    open: document.querySelector('.drawer')?.open ?? null,
    sections: [...document.querySelectorAll('.section__title')].map((n) => n.textContent),
    retentionDays: document.querySelector('.drawer input[type="number"]')?.value ?? null,
    facts: [...document.querySelectorAll('.drawer .fact')].map((f) => f.textContent.trim()).slice(0, 10),
    bars: document.querySelectorAll('.drawer .bar').length,
    copyline: document.querySelector('.copyline__text')?.textContent ?? null,
  })`);
  console.log('DRAWER ', drawer);
  await read(`document.querySelector('.drawer')?.close(), 'closed'`);

  // 空状态（用一个不可能命中的搜索词逼出来，不写库）
  await send('Page.navigate', { url: `${BASE}${URL_PATH}?search=zzz-none-zzz` });
  await new Promise((r) => setTimeout(r, 2500));
  const empty = await read(`JSON.stringify({
    blank: document.querySelector('.blank')?.dataset.kind ?? null,
    title: document.querySelector('.blank__title')?.textContent ?? null,
    actions: [...document.querySelectorAll('.blank__actions .btn')].map((b) => b.textContent),
  })`);
  console.log('EMPTY  ', empty);

  console.log('CONSOLE ERRORS', consoleErrors.length ? consoleErrors : 'none');
  console.log('FAILED REQUESTS', failedRequests.length ? failedRequests : 'none');
} finally {
  try {
    cdp?.ws.close();
    browserWs?.close();
  } catch {
    /* 忽略 */
  }
  proc.kill();
  await new Promise((r) => setTimeout(r, 400));
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结果 */
  }
}
