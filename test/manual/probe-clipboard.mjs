// 「复制最近一条 / 粘贴剪贴板内容 / 同步时间 / 手机顶栏收起」探针（手动运行，不属于 npm test 套件）。
// 真实浏览器里读真实剪贴板（先授予 clipboard 权限）、点真实按钮、读真实 DOM；失败以非 0 退出。
// 会在库里留下的东西：它造的几条记录结束时会移到回收站。
//
// 用法（需要本地 dev server，库里至少有几十条记录，手机部分要求列表够长能滚动）：
//   node test/manual/probe-clipboard.mjs --pass <密码>
import { launchBrowser, loginAndSetCookie } from './cdp.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, ok, detail = '') => {
  if (!ok) problems.push(`${name} ${detail}`);
};

// ---------- 桌面 ----------
{
  const { cdp, send, read, close } = await launchBrowser({ port: Number(arg('port', '9454')), width: 1440, height: 900 });
  const toasts = () => read(`[...document.querySelectorAll('.toast__text')].map(t => t.textContent)`);
  try {
  await cdp.send('Browser.grantPermissions', { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
  await send('Page.navigate', { url: `${BASE}/ui/` }); await wait(2000);

  // 1. 复制最近一条：先让服务器上有一条确定的"最新"（经界面保存），再点按钮，读回剪贴板
  const marker = `latest-probe-${Date.now()}`;
  await read(`fetch('/ui/api/history', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text: ${JSON.stringify(marker)} }) }).then(r => r.status)`);
  await read(`navigator.clipboard.writeText('旧内容'); 1`);
  await read(`document.querySelector('[aria-label="复制最近一条"]').click(); 1`); await wait(1200);
  const clip = await read(`navigator.clipboard.readText()`);
  check('复制最近一条：本机剪贴板 = 服务器最新一条', clip === marker, JSON.stringify(clip));
  check('复制最近一条：提示里说明是最近一条', (await toasts()).some((t) => t.includes('最近一条')), JSON.stringify(await toasts()));
  // 回收站视图 / 搜索筛选下也应是全库最新
  await read(`document.querySelector('.nav__item[aria-current]') && 1`);
  await send('Page.navigate', { url: `${BASE}/ui/?type=File&q=zzzz-no-match` }); await wait(1600);
  await read(`navigator.clipboard.writeText('旧内容2'); 1`);
  await read(`document.querySelector('[aria-label="复制最近一条"]').click(); 1`); await wait(1200);
  check('复制最近一条：不受当前筛选影响', (await read(`navigator.clipboard.readText()`)) === marker);
  await send('Page.navigate', { url: `${BASE}/ui/` }); await wait(1600);

  // 2. 粘贴剪贴板内容（文字）
  const pasted = `pasted-probe-${Date.now()}`;
  await read(`navigator.clipboard.writeText(${JSON.stringify(pasted)}); 1`);
  await read(`document.querySelector('[aria-label="粘贴剪贴板内容"]').click(); 1`); await wait(1800);
  const top = await read(`document.querySelector('.card .card__text')?.textContent`);
  check('粘贴：新记录排在最前面', top === pasted, JSON.stringify(top));
  check('粘贴：没有弹出详情', await read(`document.querySelector('.app').dataset.pane === 'closed'`));
  check('粘贴：提示', (await toasts()).some((t) => t.includes('存为最新一条')), JSON.stringify(await toasts()));

  // 3. 粘贴（图片）
  await read(`(async () => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; c.getContext('2d').fillStyle = '#c33'; c.getContext('2d').fillRect(0,0,8,8); const blob = await new Promise(r => c.toBlob(r, 'image/png')); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); return 1; })()`);
  await read(`document.querySelector('[aria-label="粘贴剪贴板内容"]').click(); 1`); await wait(2200);
  check('粘贴图片：生成一条图片记录且不弹详情', await read(`document.querySelector('.card[data-type="Image"] .card__text')?.textContent.startsWith('剪贴板-') && document.querySelector('.app').dataset.pane === 'closed'`), JSON.stringify(await read(`document.querySelector('.card .card__text')?.textContent`)));

  // 4. 空剪贴板与被拒
  await read(`navigator.clipboard.writeText(' '); 1`);
  await read(`document.querySelector('[aria-label="粘贴剪贴板内容"]').click(); 1`); await wait(900);
  check('空 / 纯空白剪贴板：提示而不是存一条空记录', (await toasts()).some((t) => t.includes('剪贴板是空的')), JSON.stringify(await toasts()));
  await cdp.send('Browser.resetPermissions', {});
  await send('Page.reload'); await wait(1800);
  await read(`document.querySelector('[aria-label="粘贴剪贴板内容"]').click(); 1`); await wait(1200);
  check('权限被拒：说清原因并给 Ctrl+V 的退路', (await toasts()).some((t) => t.includes('没有允许读取') || t.includes('不能直接读取')), JSON.stringify(await toasts()));
  await cdp.send('Browser.grantPermissions', { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });

  // 5. 侧栏最近同步
  const ago = await read(`document.querySelector('.status__ago')?.textContent`);
  check('侧栏显示最近同步时间', ago === '刚刚' || /分钟前/.test(ago), JSON.stringify(ago));
  check('同步时间有悬停说明', (await read(`document.querySelector('.status').title`)).includes('最近一次与服务器同步'));

  // 6. 快捷键 l（v 会读剪贴板，与上面的粘贴用例重复，不再单测）
  await read(`navigator.clipboard.writeText('x'); document.activeElement.blur(); 1`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', text: 'l' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l' }); await wait(1000);
  check('快捷键 l 复制最近一条', (await read(`navigator.clipboard.readText()`)) !== 'x');

  // 7. 新建菜单里也有
  await read(`document.activeElement.blur(); document.querySelector('.topbar__new').click(); 1`); await wait(300);
  check('新建菜单里有「粘贴剪贴板内容」「复制最近一条」', await read(`['粘贴剪贴板内容','复制最近一条'].every(t => [...document.querySelectorAll('.menu__item')].some(b => b.textContent.includes(t)))`));
  await read(`document.body.click(); 1`);

  // 清理本次造的记录
  await read(`fetch('/ui/api/history/batch-update', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ items: [...document.querySelectorAll('.card')].slice(0,3).map(c => ({ type: c.dataset.type, hash: c.dataset.key.split('-').slice(1).join('-') })), update: { isDelete: true } }) }).then(r=>r.status)`);
  } finally {
    close();
  }
}

// ---------- 手机 ----------
{
  const { send, read, close } = await launchBrowser({ port: Number(arg('port', '9454')) + 1, width: 390, height: 844, touch: true });
  const state = `(() => { const t = document.querySelector('.topbar'); const sc = document.querySelector('.scroller'); const r = t.getBoundingClientRect(); return { marginTop: t.style.marginTop, topbarBottom: Math.round(r.bottom), scrollerTop: Math.round(sc.getBoundingClientRect().top), scrollTop: Math.round(sc.scrollTop), data: document.querySelector('.app').dataset.topbar, scrollable: sc.scrollHeight > sc.clientHeight + 200 } })()`;
  try {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
  await send('Page.navigate', { url: `${BASE}/ui/?size=120` }); await wait(2200);
  const layout = await read(`(() => { const q = (s) => document.querySelector(s); const b = (e) => e && Math.round(e.getBoundingClientRect().width); return { menu: getComputedStyle(q('.topbar__menu')).display, search: b(q('.search')), quick: [...document.querySelectorAll('.topbar__quick button')].map(x => b(x)), newBtn: b(q('.topbar__new')), overflowX: document.documentElement.scrollWidth > innerWidth } })()`);
  check('手机：顶栏菜单键让位、搜索框仍有足够宽度', layout.menu === 'none' && layout.search >= 150 && !layout.overflowX, JSON.stringify(layout));
  check('手机：两个快捷按钮命中区 ≥ 36（粗指针下由全局规则放大）', layout.quick.every((w) => w >= 36));
  const s0 = await read(state);
  check('页面足够长可滚动', s0.scrollable, JSON.stringify(s0));
  // 向下滚：收起
  await read(`document.querySelector('.scroller').scrollTo({ top: 120 }); 1`); await wait(150);
  await read(`document.querySelector('.scroller').scrollTo({ top: 420 }); 1`); await wait(600);
  const s1 = await read(state);
  check('向下滚：顶栏收起并让出布局高度', s1.data === 'hidden' && s1.marginTop.startsWith('-') && s1.scrollerTop < s0.scrollerTop, JSON.stringify({ s0, s1 }));
  // 向上滚：恢复
  await read(`document.querySelector('.scroller').scrollTo({ top: 300 }); 1`); await wait(600);
  const s2 = await read(state);
  check('向上滚：顶栏恢复', s2.data === 'shown' && s2.marginTop === '' && s2.scrollerTop === s0.scrollerTop, JSON.stringify(s2));
  // 滚到很下面再回到顶部：恢复
  await read(`document.querySelector('.scroller').scrollTo({ top: 800 }); 1`); await wait(500);
  await read(`document.querySelector('.scroller').scrollTo({ top: 0 }); 1`); await wait(600);
  const s3 = await read(state);
  check('回到顶部：顶栏恢复', s3.data === 'shown' && s3.scrollerTop === s0.scrollerTop, JSON.stringify(s3));
  // 点搜索框（聚焦）也恢复
  await read(`document.querySelector('.scroller').scrollTo({ top: 120 }); 1`); await wait(100);
  await read(`document.querySelector('.scroller').scrollTo({ top: 500 }); 1`); await wait(500);
  const hidden = (await read(state)).data;
  await read(`document.querySelector('.search__input').focus(); 1`); await wait(400);
  check('聚焦搜索框：顶栏恢复', hidden === 'hidden' && (await read(state)).data === 'shown');
  // 桌面宽度下永不收起
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ui/?size=120` }); await wait(2000);
  await read(`document.querySelector('.scroller').scrollTo({ top: 600 }); 1`); await wait(500);
  check('桌面宽度：顶栏不会收起', (await read(state)).data !== 'hidden');
  } finally {
    close();
  }
}

if (problems.length > 0) {
  console.error(`剪贴板探针失败 ${problems.length} 项：\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ 剪贴板探针全部通过');
