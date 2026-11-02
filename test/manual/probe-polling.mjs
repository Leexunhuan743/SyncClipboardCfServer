// 轮询与读量探针（手动运行，不属于 npm test 套件）：真实浏览器里数网络请求。
// 钉住的是「别白读 D1」这条线：推送在线时不多余轮询、页面隐藏时一次都不轮询、切回立即补查一次、
// 变更信号只剩 lastModified 后「别处新增」仍能被发现、手机不取看不见的趋势图。
//
// 用法（需要本地 dev server）：node test/manual/probe-polling.mjs --pass <密码>
import { launchBrowser, loginAndSetCookie } from './cdp.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const { cdp, send, read, close } = await launchBrowser({ port: Number(arg('port', '9460')), width: 1440, height: 900 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = [];
cdp.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Network.requestWillBeSent') { const u = new URL(m.params.request.url); if (u.pathname.startsWith('/ui/api/')) hits.push({ t: Date.now(), path: u.pathname }); } });
const count = (path, since) => hits.filter((h) => h.path === path && h.t >= since).length;
const problems = [];
const check = (n, ok, d = '') => {
  if (!ok) problems.push(`${n} ${d}`);
};
try {
  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
  await send('Page.navigate', { url: `${BASE}/ui/` }); await wait(3500);
  check('桌面首屏取了趋势图', count('/ui/api/activity', 0) >= 1, JSON.stringify(hits.filter(h => h.path.includes('activity'))));

  // 1) 推送连着 ⇒ 看门狗 2 分钟；25 秒内不该有轮询
  const pushState = await read(`document.querySelector('.status').dataset.state`);
  let t0 = Date.now(); await wait(25000);
  check(`推送在线（${pushState}）时 25 秒内没有多余轮询`, pushState !== 'live' || count('/ui/api/poll', t0) === 0, String(count('/ui/api/poll', t0)));

  // 2) 页面隐藏：不轮询（即使推送已停、本该每 10 秒一次）
  await read(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); 1`);
  await wait(500); t0 = Date.now(); await wait(26000);
  check('页面隐藏 26 秒：0 次轮询', count('/ui/api/poll', t0) === 0, String(count('/ui/api/poll', t0)));
  // 3) 切回：立刻补查一次
  t0 = Date.now();
  await read(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); 1`);
  await wait(1500);
  check('切回可见：立即查一次', count('/ui/api/poll', t0) >= 1, String(count('/ui/api/poll', t0)));

  // 4) 别处新增一条 ⇒ 页面发现（LastModified 推进）并刷新列表
  const text = `converge-${Date.now()}`;
  const before = await read(`document.querySelector('.card .card__text')?.textContent`);
  await read(`fetch('/ui/api/history', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text: ${JSON.stringify(text)} }) }).then(r => r.status)`);
  let seen = false; for (let i = 0; i < 25 && !seen; i++) { await wait(1000); seen = (await read(`[...document.querySelectorAll('.card .card__text')].some(e => e.textContent === ${JSON.stringify(text)})`)); }
  check('新记录被自动发现并显示（收敛没有因去掉 count 而失效）', seen, `top before: ${before}`);
  // 清理
  await read(`(async () => { const c = [...document.querySelectorAll('.card')].find(c => c.querySelector('.card__text')?.textContent === ${JSON.stringify(text)}); if (c) await fetch('/ui/api/history/batch-update', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ items:[{ type: c.dataset.type, hash: c.dataset.key.split('-').slice(1).join('-') }], update:{ isDelete:true } }) }); return 1; })()`);

  // 5) 手机：不取趋势图；变宽后补取
  hits.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/ui/` }); await wait(3500);
  check('手机首屏没有取趋势图', count('/ui/api/activity', 0) === 0, JSON.stringify(hits.map(h => h.path)));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await wait(2000);
  check('窗口变宽后补取趋势图', count('/ui/api/activity', 0) >= 1);
} finally { close(); }
if (problems.length > 0) {
  console.error(`轮询探针失败 ${problems.length} 项：\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ 轮询探针全部通过');
