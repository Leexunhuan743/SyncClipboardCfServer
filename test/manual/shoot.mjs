// 视觉回归截图工具（手动运行，不属于 npm test 套件）
//
// 为什么需要它：这个仓库的前端是**零构建的原生 ES 模块**，没有编译器、也没有浏览器端测试，
// 「改完之后界面上长什么样」只能靠人打开浏览器看。本脚本驱动本机 Edge/Chrome 的无头实例，
// 把真实页面渲染成 PNG。
//
// 用法（需 dev server 已启动）：
//   node test/manual/shoot.mjs --out .shots --user admin --pass admin
//   node test/manual/shoot.mjs --only list,dark --width 1440 --height 900
//
// 设计约束：
//   · **零依赖**：只用 node: builtins 与全局 WebSocket（Node ≥ 22）；仓库的 devDependencies 里
//     没有 playwright/puppeteer，为截图引入一个浏览器内核是重资产。
//   · **不写入仓库目录**：截图落在 --out（默认 .shots/，已加 .gitignore）。
//   · 登录走真实接口（POST /ui/api/login），拿到服务端签发的会话 Cookie，
//     因此截到的是使用者看到的页面（而不是靠注入脚本伪造已登录状态）。
//
// 起浏览器/登录/注入 Cookie/CDP 原语都在 ./cdp.mjs 里（与 probe / probe-ui-v1 / states 共用）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, loginAndSetCookie } from './cdp.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

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

mkdirSync(OUT, { recursive: true });

const { send, close } = await launchBrowser({ port: PORT, width: WIDTH, height: HEIGHT });
try {
  // 缩放：launchBrowser 不设 deviceScaleFactor，这里连同窗口尺寸一起定下来
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  if (DARK) {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
  }

  async function goto(url, { settleMs = 1800 } = {}) {
    await send('Page.navigate', { url });
    await wait(settleMs);
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

  // 本脚本出的是 **V2**（`/ui_v2/app/`）的图。`/ui/` 是只做跳转的壳，它把人送到默认界面 V1
  // `/ui_v1/` —— V1 自己的出图在 probe-ui-v1.mjs 的 `--shots`。
  const APP = `${BASE}/ui_v2/app/`;

  await goto(APP);
  // 等列表真的渲染出来：骨架 → 真行；失败时是空状态或错误态，两者都算"有结果"，
  // 不能因为等不到行就拍一张还在转的骨架。
  await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + 15000;
      const tick = () => {
        const item = document.querySelector('.item');
        if (item) return setTimeout(() => resolve('rows'), 600);
        if (document.querySelector('.blank') || document.querySelector('.ghost')) return resolve('state');
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
    await wait(500);
    await shoot('02-list-dark');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Runtime.evaluate', { expression: `document.documentElement.dataset.theme='light'` });
    await wait(300);
  }
  if (wants('drawer')) {
    await send('Runtime.evaluate', { expression: `document.getElementById('overview').click()` });
    await wait(700);
    await shoot('03-drawer');
    await send('Runtime.evaluate', { expression: `document.querySelector('.drawer')?.close()` });
  }
  if (wants('trash')) {
    await goto(`${APP}?deleted=1`, { settleMs: 1800 });
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
  if (wants('v1')) {
    await goto(`${BASE}/ui_v1/`, { settleMs: 1200 });
    await shoot('07-ui-v1');
  }
  if (wants('empty')) {
    // 用一个不可能命中的搜索词逼出空状态（不写库、不改数据）
    await goto(`${APP}?search=zzz-no-such-record-zzz`, { settleMs: 1800 });
    await shoot('08-empty-filter');
  }
  if (wants('mobile')) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await goto(APP, { settleMs: 2000 });
    await shoot('09-mobile');
  }

  console.log('[shoot] 完成');
} finally {
  close();
}
