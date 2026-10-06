// 三个手动探针（probe / probe-ui-v1 / states / shoot）共用的 CDP 原语。
//
// 抽出来的理由：这几份脚本各自复制过一整套「找浏览器 / 起无头实例 / 连 CDP / 等 DevTools 就绪 /
// 登录并注入会话 Cookie」的代码，改动一处要同步四处。这里只放**不含判据**的原语 ——
// 判据（check/expect/record）留在各脚本里，因为它们按各自的界面写，本就不是同一件事。
//
// 这不是测试框架：没有断言、没有 runner、没有报告格式，只有启动/发送/读取/清理四件事。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser() {
  for (const path of BROWSERS) if (existsSync(path)) return path;
  throw new Error(`未找到 Edge/Chrome：\n  ${BROWSERS.join('\n  ')}`);
}

/** 极简 CDP 客户端：只做「发一条命令、等它的结果」，够探针用。 */
export class Cdp {
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

export async function waitForDevTools(port, timeoutMs = 20_000) {
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

/**
 * 起一个无头浏览器、连上 CDP、开好页面会话。
 * 返回 `{ cdp, send, read, profileDir, close }`：
 *   · `send(method, params)`  —— 发到页面会话（sessionId 已绑定）
 *   · `read(expression)`      —— 求值并取回值（页面异常会抛，不做静默吞）
 *   · `close()`               —— 关连接、杀进程、删临时 profile
 * `touch` 只开触摸模拟（`(pointer: coarse)` 成立），**不**动 viewport —— 理由见调用点。
 */
export async function launchBrowser({ port, width, height, touch = false }) {
  const profileDir = join(tmpdir(), `probe-profile-${process.pid}-${port}`);
  mkdirSync(profileDir, { recursive: true });
  const proc = spawn(
    findBrowser(),
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const close = () => {
    try {
      cdp?.ws.close();
    } catch {
      /* 已关 */
    }
    proc.kill();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  };

  let browserWs;
  let cdp;
  try {
    const version = await waitForDevTools(port);
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

    if (touch) {
      // 触摸模拟：只有开了它，`(pointer: coarse)` 才成立 —— 无头浏览器默认恒为细指针，
      // 390px 下量到的是「窄窗口桌面」而不是手机。**不**动 `Emulation.setDeviceMetricsOverride`
      // （`mobile: true` 会换掉视口语义，让同一份页面多出与命中区无关的横向溢出读数）。
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }

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

    return { cdp, send, read, profileDir, close };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * 真实登录接口 → 服务端签发的会话 Cookie → 注入页面。
 * 走真实接口（不是伪造已登录状态），因此截到/量到的就是使用者看到的页面。
 * 返回 `{ cookieName, cookieValue }`：需要**摘掉再装回** Cookie 的脚本（如 states 测登录页）要用它。
 */
export async function loginAndSetCookie(send, { base, user, pass }) {
  const login = await fetch(`${base}/ui/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}：${await login.text()}`);
  const rawCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const eq = rawCookie.indexOf('=');
  const cookieName = rawCookie.slice(0, eq);
  const cookieValue = rawCookie.slice(eq + 1);
  await send('Network.setCookie', {
    name: cookieName,
    value: cookieValue,
    domain: new URL(base).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  });
  return { cookieName, cookieValue };
}

/** 收集控制台错误与失败请求：页面「看起来对但其实是坏的」最常见的两种形态。 */
export function collectErrors(cdp) {
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
  return { consoleErrors, failedRequests };
}

/** 断言/记录的收集器：判据影响退出码，只 console.log 不算验证。 */
export function createRecorder() {
  const problems = [];
  return {
    problems,
    check(name, ok, detail) {
      if (ok) return;
      problems.push(detail === undefined || detail === '' ? name : name + '（读到 ' + detail + '）');
    },
  };
}
