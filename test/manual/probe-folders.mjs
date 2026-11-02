// 收藏夹端到端探针（手动运行，不属于 npm test 套件）：真实浏览器里走一遍
// 新建 → 重名提示 → 详情里放入 → 收藏夹视图 → 重命名 → 移出 → 批量放入 → 菜单里新建并放入 → 删除（确认）。
// 每一步都读真实 DOM；失败以非 0 退出。会在库里留下的东西：结束时会删掉它建的收藏夹（记录不动）。
//
// 用法（需要本地 dev server，库里至少有 6 条记录）：node test/manual/probe-folders.mjs --pass <密码>
import { launchBrowser, loginAndSetCookie } from './cdp.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const { send, read, close } = await launchBrowser({ port: Number(arg('port', '9451')), width: 1440, height: 900 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, ok, detail = '') => {
  if (!ok) problems.push(`${name} ${detail}`);
};
const type = (value) => read(`(() => { const i = document.querySelector('dialog[open] input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
const folders = () => read(`[...document.querySelectorAll('.nav__group .nav__item')].map(b => b.querySelector('.nav__label').textContent + ':' + b.querySelector('.nav__count').textContent)`);
try {
  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
  await send('Page.navigate', { url: `${BASE}/ui/` }); await wait(2000);
  // 0. 清理上次可能残留的同名收藏夹
  await read(`fetch('/ui/api/overview').then(r=>r.json()).then(o=>Promise.all(o.folders.map(f=>fetch('/ui/api/folders/'+f.id,{method:'DELETE'}))))`);
  await send('Page.reload'); await wait(1800);

  // 1. 新建收藏夹（侧栏入口）
  await read(`document.querySelector('.nav__item--add').click(); 1`); await wait(400);
  await type('工作资料'); await wait(900);
  check('新建后侧栏出现收藏夹', JSON.stringify(await folders()) === '["工作资料:0"]', JSON.stringify(await folders()));

  // 2. 重名：对话框不关，显示原因
  await read(`document.querySelector('.nav__item--add').click(); 1`); await wait(400);
  await type('工作资料'); await wait(700);
  check('重名时对话框保持打开并提示', await read(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open] .form-error').textContent.includes('已经有一个')`));
  await read(`document.querySelector('dialog[open] .modal__head .icon-btn').click(); 1`); await wait(300);

  // 3. 详情里放入：点第 2 条 → 底部「收藏夹」→ 菜单里选
  await read(`document.querySelectorAll('.card')[1].click(); 1`); await wait(800);
  const label0 = await read(`[...document.querySelectorAll('.pane__foot-side .btn')].map(b=>b.textContent.trim()).join('|')`);
  check('详情底部有「收藏夹」按钮', label0.includes('收藏夹'), label0);
  await read(`[...document.querySelectorAll('.pane__foot-side .btn')].find(b=>b.textContent.includes('收藏夹')).click(); 1`); await wait(400);
  await read(`[...document.querySelectorAll('.menu__item')].find(b=>b.textContent.includes('工作资料')).click(); 1`); await wait(1200);
  check('放入后侧栏计数为 1', JSON.stringify(await folders()) === '["工作资料:1"]', JSON.stringify(await folders()));
  const label1 = await read(`[...document.querySelectorAll('.pane__foot-side .btn')].map(b=>b.textContent.trim()).join('|')`);
  check('详情按钮变成收藏夹名字', label1.includes('工作资料'), label1);
  check('卡片上有收藏夹标记', await read(`!!document.querySelector('.card .flag--folder')`));
  await read(`document.querySelector('.pane__close').click(); 1`); await wait(300);

  // 4. 打开收藏夹视图
  await read(`document.querySelector('.nav__group .nav__item').click(); 1`); await wait(1200);
  const view = await read(`({ url: location.search, count: document.querySelector('.feedhead__count').textContent, cards: document.querySelectorAll('.card').length, buttons: [...document.querySelectorAll('.feedhead button:not([hidden])')].map(b=>b.textContent.trim()).filter(Boolean).join('|'), note: !document.querySelector('.feed .note:not([hidden])') ? '' : [...document.querySelectorAll('.feed .note:not([hidden])')].map(n=>n.textContent.slice(0,12)).join('|'), title: document.title, flagInView: !!document.querySelector('.card .flag--folder') })`);
    check('收藏夹视图：URL / 条数 / 按钮', view.url.includes('folder=') && view.count.includes('工作资料') && view.cards === 1 && view.buttons.includes('重命名') && view.buttons.includes('删除收藏夹'), JSON.stringify(view));
  check('收藏夹视图：标题与不重复画标记', view.title.startsWith('工作资料') && !view.flagInView, JSON.stringify(view));

  // 5. 重命名
  await read(`[...document.querySelectorAll('.feedhead button')].find(b=>b.textContent.includes('重命名')).click(); 1`); await wait(400);
  await type('学习资料'); await wait(900);
  check('重命名生效', JSON.stringify(await folders()) === '["学习资料:1"]', JSON.stringify(await folders()));

  // 6. 在收藏夹视图里把唯一一条移出 → 它离开列表
  await read(`document.querySelectorAll('.card')[0].click(); 1`); await wait(700);
  await read(`[...document.querySelectorAll('.pane__foot-side .btn')].find(b=>b.textContent.includes('学习资料')).click(); 1`); await wait(400);
  await read(`[...document.querySelectorAll('.menu__item')].find(b=>b.textContent.includes('移出收藏夹')).click(); 1`); await wait(1400);
  const after = await read(`({ cards: document.querySelectorAll('.card').length, empty: document.querySelector('.empty__title')?.textContent, side: [...document.querySelectorAll('.nav__group .nav__item .nav__count')].map(n=>n.textContent).join(), pane: document.querySelector('.app').dataset.pane })`);
  check('移出后记录离开收藏夹视图、计数归零、空状态', after.cards === 0 && after.empty === '这个收藏夹是空的' && after.side === '0', JSON.stringify(after));

  // 7. 批量放入：回到全部 → 选 2 条 → 批量条「放入收藏夹」
  await read(`document.querySelector('.nav__item').click(); 1`); await wait(1200);
  await read(`document.querySelectorAll('.card .tile')[2].click(); document.querySelectorAll('.card .tile')[3].click(); 1`); await wait(500);
  await read(`[...document.querySelectorAll('.batch__actions .btn')].find(b=>b.textContent.includes('放入收藏夹')).click(); 1`); await wait(400);
  await read(`[...document.querySelectorAll('.menu__item')].find(b=>b.textContent.includes('学习资料')).click(); 1`); await wait(1400);
  check('批量放入 2 条、选择被清空', JSON.stringify(await folders()) === '["学习资料:2"]' && await read(`document.querySelector('.batch').hidden`), JSON.stringify(await folders()));

  // 8. 从菜单里新建并放入
  await read(`document.querySelectorAll('.card .tile')[5].click(); 1`); await wait(400);
  await read(`[...document.querySelectorAll('.batch__actions .btn')].find(b=>b.textContent.includes('放入收藏夹')).click(); 1`); await wait(400);
  await read(`[...document.querySelectorAll('.menu__item')].find(b=>b.textContent.includes('新建收藏夹')).click(); 1`); await wait(500);
  await type('临时'); await wait(1500);
  check('菜单里新建并放入', JSON.stringify(await folders()) === '["学习资料:2","临时:1"]', JSON.stringify(await folders()));

  // 9. 删除收藏夹（要确认）：记录保留
  const total0 = await read(`document.querySelector('.feedhead__count').textContent`);
  await read(`document.querySelectorAll('.nav__group .nav__item')[0].click(); 1`); await wait(1000);
  await read(`[...document.querySelectorAll('.feedhead button')].find(b=>b.textContent.includes('删除收藏夹')).click(); 1`); await wait(400);
  const confirmText = await read(`document.querySelector('dialog[open] .confirm__message')?.textContent`);
  check('删除前有确认且说明记录不会被删', !!confirmText && confirmText.includes('不会被删除') && confirmText.includes('2'), String(confirmText));
  await read(`[...document.querySelectorAll('dialog[open] .btn')].find(b=>b.textContent.includes('删除收藏夹')).click(); 1`); await wait(1600);
  const gone = await read(`({ url: location.search, side: [...document.querySelectorAll('.nav__group .nav__item')].map(b=>b.textContent.trim()).join('|'), total: document.querySelector('.feedhead__count').textContent })`);
  check('删除后回到全部、只剩另一个收藏夹、记录总数不变', gone.url === '' && gone.side.includes('临时') && !gone.side.includes('学习资料') && gone.total === total0, JSON.stringify({ gone, total0 }));

  // 10. 清理
  await read(`fetch('/ui/api/overview').then(r=>r.json()).then(o=>Promise.all(o.folders.map(f=>fetch('/ui/api/folders/'+f.id,{method:'DELETE'}))))`);
} finally { close(); }

if (problems.length > 0) {
  console.error(`收藏夹探针失败 ${problems.length} 项：\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ 收藏夹探针全部通过');
