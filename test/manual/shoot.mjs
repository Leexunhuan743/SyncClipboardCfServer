// 视觉回归截图工具（手动运行，不属于 npm test 套件）
//
// 为什么需要它：这个仓库的前端是**零构建的原生 ES 模块**，没有编译器、也没有浏览器端测试。
// 「改完之后界面上长什么样」此前只能靠人打开浏览器看，于是每轮 UI 改动都无法自证。
// 本脚本用一个**无依赖**的 CDP 客户端驱动本机 Edge/Chrome 的无头实例，把真实页面渲染成 PNG。
//
// 用法（需 dev server 已启动）：
//   node test/manual/shoot.mjs --out .shots --user admin --pass admin
//   node test/manual/shoot.mjs --only list,dark --width 1440 --height 900
//
// 设计约束：
//   · **零依赖**：只用 node:child_process / node:fs / node:http / 全局 WebSocket（Node ≥ 22）。
//     仓库的 devDependencies 里没有 playwright/puppeteer，为截图引入一个浏览器内核是重资产。
//   · **不写入仓库目录**：截图落在 --out（默认 .shots/，已加 .gitignore）。
//   · 登录走真实表单之外的**真实接口**（POST /ui/api/login），拿到的是服务端签发的会话 Cookie，
//     因此截到的就是使用者看到的页面（而不是靠注入脚本伪造已登录状态）。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ===== 参数 =====
function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const OUT = resolve(arg('out', '.shots'));
const PORT = Number(arg('port', '9333'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SCALE = Number(arg('scale', '1'));
const ONLY = arg('only', null);
const DARK = process.argv.includes('--dark');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const path of BROWSERS) if (existsSync(path)) return path;
  throw new Error(`未找到 Edge/Chrome，找了这些位置：\n  ${BROWSERS.join('\n  ')}`);
}

// ===== 极简 CDP 客户端（node:http 拿 /json/version，全局 WebSocket 走协议）=====
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
        return;
      }
      // 会话级事件：分发给等待中的 helper
      const waiter = msg.sessionId ? this.sessions.get(msg.sessionId) : null;
      if (waiter && msg.method) waiter(msg);
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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function waitForDevTools(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`DevTools 端点未就绪（:${port}）：${lastError?.message}`);
}

// ===== 主流程 =====
const browserPath = findBrowser();
const profileDir = join(tmpdir(), `shoot-profile-${process.pid}`);
mkdirSync(profileDir, { recursive: true });
mkdirSync(OUT, { recursive: true });

console.log(`[shoot] 浏览器 ${browserPath}`);
console.log(`[shoot] 目标   ${BASE}`);

const proc = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=' + SCALE,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
let browserWs;
try {
  const version = await waitForDevTools(PORT);
  console.log(`[shoot] ${version.Browser}`);
  browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browserWs.addEventListener('open', resolve, { once: true });
    browserWs.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  cdp = new Cdp(browserWs);

  // 建一个页面 target
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  // ---- 登录：真实接口，拿服务端签发的会话 Cookie ----
  const login = await fetch(`${BASE}/ui/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}：${await login.text()}`);
  const setCookie = login.headers.getSetCookie?.() ?? [];
  const rawCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!rawCookie) throw new Error('登录成功但没拿到 Set-Cookie');
  const target = new URL(BASE);
  await send('Network.setCookie', {
    name: rawCookie.split('=')[0],
    value: rawCookie.slice(rawCookie.indexOf('=') + 1),
    domain: target.hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  });
  console.log(`[shoot] 已植入会话 Cookie：${rawCookie.split('=')[0]}`);

  if (DARK) {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
  }

  // ---- 打开页面并等网络静默 ----
  async function goto(url, { settleMs = 1800 } = {}) {
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, settleMs));
  }

  async function shoot(name, { fullPage = false } = {}) {
    const params = { format: 'png' };
    if (fullPage) params.captureBeyondViewport = true;
    const { data } = await send('Page.captureScreenshot', params);
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`[shoot] → ${file}`);
    return file;
  }

  const wants = (name) => !ONLY || ONLY.split(',').includes(name);

  // 这是 **V2** 的出图脚本：应用本体在 `/ui_v2/app/`。
  // （`/ui/` 是只做跳转的壳，它把人送到**默认界面 V1** `/ui_v1/` ——
  //   V1 自己的出图在 probe-ui-v1.mjs 的 `--shots`。）
  const APP = `${BASE}/ui_v2/app/`;

  await goto(APP);
  // 等列表真的渲染出来（首屏是骨架 → 真行；失败时是空状态或错误态，
  // 两者都算"有结果"，不能因为等不到行就拍一张还在转的骨架）
  await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + 15000;
      const tick = () => {
        if (document.querySelector('.item') || document.querySelector('.blank') || document.querySelector('.ghost')) {
          // 已经出现行的场合再等一拍，让缩略图与布局稳定
          if (document.querySelector('.item')) return setTimeout(() => resolve('rows'), 600);
          return resolve('state');
        }
        if (Date.now() > deadline) return resolve('timeout');
        setTimeout(tick, 150);
      };
      tick();
    })`,
    awaitPromise: true,
  });

  if (wants('list')) await shoot('01-list-light');
  if (wants('list-dark')) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await send('Runtime.evaluate', { expression: `document.documentElement.dataset.theme='dark'` });
    await new Promise((r) => setTimeout(r, 500));
    await shoot('02-list-dark');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Runtime.evaluate', { expression: `document.documentElement.dataset.theme='light'` });
    await new Promise((r) => setTimeout(r, 300));
  }
  if (wants('drawer')) {
    await send('Runtime.evaluate', { expression: `document.getElementById('overview').click()` });
    await new Promise((r) => setTimeout(r, 700));
    await shoot('03-drawer');
    await send('Runtime.evaluate', { expression: `document.querySelector('.drawer')?.close()` });
  }
  if (wants('trash')) {
    await goto(`${APP}?deleted=1`);
    await new Promise((r) => setTimeout(r, 1800));
    await shoot('04-trash');
  }
  if (wants('login')) {
    await goto(`${BASE}/ui_v2/app/login.html`);
    await shoot('05-login');
  }
  if (wants('404')) {
    await goto(`${BASE}/ui/nope-not-here`);
    await shoot('06-notfound');
  }
  if (wants('old')) {
    await goto(`${BASE}/ui_v1/`);
    await new Promise((r) => setTimeout(r, 1200));
    await shoot('07-ui-old');
  }
  if (wants('empty')) {
    // 用一个不可能命中的搜索词逼出空状态（不写库、不改数据）
    await goto(`${APP}?search=zzz-no-such-record-zzz`);
    await new Promise((r) => setTimeout(r, 1800));
    await shoot('08-empty-filter');
  }

  // 移动视口
  if (wants('mobile')) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await goto(APP);
    await new Promise((r) => setTimeout(r, 2000));
    await shoot('09-mobile');
  }

  console.log('[shoot] 完成');
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
