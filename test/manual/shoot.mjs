// 视觉回归截图（手动运行，不属于 npm test 套件）。驱动本机 Chromium/Chrome/Edge 的无头实例，
// 把真实页面渲染成 PNG，用来「看一眼界面长什么样」—— DOM 存在不等于用户看得见。
//
// 用法（需要本地 dev server 已启动，且库里有些记录）：
//   node test/manual/shoot.mjs --out .shots
//   node test/manual/shoot.mjs --only list,detail --width 1440 --height 900
//   node test/manual/shoot.mjs --out docs/images          # 重出 README 用的三张图
//
// 登录走真实接口（POST /ui/api/login）拿会话 Cookie 再注入，所以截到的就是使用者看到的页面。
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
const ONLY = arg('only', null);
const wants = (name) => !ONLY || ONLY.split(',').includes(name);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const { send, read, close } = await launchBrowser({ port: PORT, width: WIDTH, height: HEIGHT });
try {
  const metrics = (width, height, mobile = false) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const goto = async (url, settle = 1500) => {
    await send('Page.navigate', { url });
    await wait(settle);
  };
  const shoot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`[shoot] → ${file}`);
  };
  const theme = (mode) => read(`localStorage.setItem('clip-theme', '${mode}')`);

  // 登录页要在**未登录**状态下拍：先拍它，再注入 Cookie
  await metrics(WIDTH, HEIGHT);
  if (wants('login')) {
    await goto(`${BASE}/ui/`);
    await read(`document.querySelector('#login-user').value = 'admin'; 1`);
    await read(`document.querySelector('#login-pass').value = 'wrong'; document.querySelector('form').requestSubmit(); 1`);
    await wait(800);
    await shoot('login-error');
  }

  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
  await goto(`${BASE}/ui/`, 600); // localStorage 需要一个真实的同源文档，about:blank 上读会抛 SecurityError
  await theme('light');
  await goto(`${BASE}/ui/`);
  if (wants('list')) await shoot('list-light');
  if (wants('detail')) {
    await read(`document.querySelector('.card').click(); 1`);
    await wait(700);
    await shoot('detail');
    await read(`document.querySelector('.pane__close').click(); 1`);
  }
  if (wants('dark')) {
    await theme('dark');
    await goto(`${BASE}/ui/`);
    await shoot('list-dark');
    await theme('light');
  }
  if (wants('trash')) {
    await goto(`${BASE}/ui/?trash=1`);
    await shoot('trash');
  }
  if (wants('settings')) {
    await goto(`${BASE}/ui/`);
    await read(`document.querySelector('.sidebar__settings').click(); 1`);
    await wait(1200);
    await shoot('settings');
  }
  if (wants('image')) {
    // 打开最新的一条图片记录（库里需要有图片）
    await goto(`${BASE}/ui/?type=Image`);
    await read(`document.querySelector('.card')?.click(); 1`);
    await wait(900);
    await shoot('detail-image');
  }
  if (wants('mobile-detail') || wants('mobile-nav')) {
    await metrics(390, 844, true);
    await goto(`${BASE}/ui/`, 1800);
    if (wants('mobile-nav')) {
      await read(`[...document.querySelectorAll('.tabbar__item')].find((b) => b.textContent === '更多').click(); 1`);
      await wait(600);
      await shoot('mobile-nav');
      await read(`document.querySelector('.scrim').click(); 1`);
      await wait(400);
    }
    if (wants('mobile-detail')) {
      await read(`document.querySelector('.card').click(); 1`);
      await wait(900);
      await shoot('mobile-detail');
    }
  }
  if (wants('compact')) {
    await read(`localStorage.setItem('clip-density', 'compact')`);
    await goto(`${BASE}/ui/`);
    await shoot('compact');
    await metrics(390, 844, true);
    await goto(`${BASE}/ui/`, 1800);
    await shoot('compact-mobile');
    await read(`localStorage.removeItem('clip-density')`);
    await metrics(WIDTH, HEIGHT);
  }
  if (wants('select')) {
    await goto(`${BASE}/ui/`);
    await read(`document.querySelectorAll('.card .tile')[1].click(); document.querySelectorAll('.card .tile')[2].click(); 1`);
    await wait(500);
    await shoot('select');
    await metrics(390, 844, true);
    await goto(`${BASE}/ui/`, 1800);
    await read(`document.querySelectorAll('.card .tile')[0].click(); document.querySelectorAll('.card .tile')[1].click(); 1`);
    await wait(500);
    await shoot('select-mobile');
    await metrics(WIDTH, HEIGHT);
  }
  if (wants('ultrawide')) {
    // 带鱼屏（21:9 / 32:9）：list / detail / settings 三张
    await metrics(3440, 1440);
    await goto(`${BASE}/ui/`);
    await shoot('ultrawide-list');
    await read(`document.querySelector('.card').click(); 1`);
    await wait(900);
    await shoot('ultrawide-detail');
    await read(`document.querySelector('.pane__close').click(); document.querySelector('.sidebar__settings').click(); 1`);
    await wait(1400);
    await shoot('ultrawide-settings');
    await metrics(WIDTH, HEIGHT);
  }
  if (wants('hover')) {
    // 悬停态 + 选择态的勾选框（对着用户报过的"框压在框上"回归看）：先裁出前几张卡的区域
    await goto(`${BASE}/ui/`);
    const box = await read(`(() => { const r = document.querySelector('.card').getBoundingClientRect(); return { x: Math.round(r.left + 200), y: Math.round(r.top + r.height / 2) }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await wait(400);
    await shoot('check-hover');
    await read(`document.querySelectorAll('.card .tile')[1].click(); 1`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await wait(400);
    await shoot('check-selected');
    await read(`localStorage.setItem('clip-density', 'compact')`);
    await goto(`${BASE}/ui/`);
    await read(`document.querySelectorAll('.card .tile')[1].click(); 1`);
    await wait(400);
    await shoot('check-compact');
    await read(`localStorage.removeItem('clip-density')`);
  }
  if (wants('themes')) {
    // 三套风格 × （列表 + 详情 + 外观对话框 + 登录页）
    for (const style of ['coast', 'paper', 'pop']) {
      await read(`localStorage.setItem('clip-style', '${style}')`);
      await goto(`${BASE}/ui/`);
      await shoot(`theme-${style}-list`);
      await read(`document.querySelectorAll('.card')[2].click(); 1`);
      await wait(900);
      await shoot(`theme-${style}-detail`);
      await read(`document.querySelector('.pane__close').click(); document.querySelector('.sidebar .icon-btn[aria-label="外观与主题"]').click(); 1`);
      await wait(700);
      await shoot(`theme-${style}-appearance`);
      await read(`document.querySelector('dialog[open] .modal__head .icon-btn').click(); fetch('/ui/api/logout', { method: 'POST' }).then(() => location.reload()); 1`);
      await wait(1500);
      await shoot(`theme-${style}-login`);
      await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
    }
    await read(`localStorage.removeItem('clip-style')`);
  }
  if (wants('themes-mobile')) {
    await metrics(390, 844, true);
    for (const style of ['coast', 'paper', 'pop']) {
      await read(`localStorage.setItem('clip-style', '${style}')`);
      await goto(`${BASE}/ui/`, 1800);
      await read(`document.querySelectorAll('.card .tile')[1].click(); 1`);
      await wait(400);
      await shoot(`theme-${style}-mobile`);
    }
    await read(`localStorage.removeItem('clip-style')`);
    await metrics(WIDTH, HEIGHT);
  }
  if (wants('check-image')) {
    for (const style of ['default', 'pop']) {
      if (style !== 'default') await read(`localStorage.setItem('clip-style', '${style}')`);
      await goto(`${BASE}/ui/?type=Image`);
      await read(`document.querySelector('.card .tile').click(); 1`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 });
      await wait(500);
      await shoot(`check-image-${style}`);
    }
    await read(`localStorage.removeItem('clip-style')`);
  }
  if (wants('mobile')) {
    await metrics(390, 844, true);
    await goto(`${BASE}/ui/`, 2000);
    await shoot('list-mobile');
  }
  console.log('[shoot] 完成');
} finally {
  close();
}
