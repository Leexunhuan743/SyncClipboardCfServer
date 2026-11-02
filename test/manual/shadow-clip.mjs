// 阴影被裁检查（手动运行，不属于 npm test 套件）：风格里的硬偏移 / 光晕阴影会超出元素盒子，
// 而带 overflow 的祖先（可滚动的侧栏导航、会换行的 chips、对话框正文…）会把超出的部分切成一刀。
// 本脚本在每套风格 × （主界面 / 部署信息 / 详情 / 外观对话框）里，找出「元素整体在祖先裁剪框内、
// 但它的外阴影超出了裁剪框」的情形 —— 被滚出视野的元素不算（那不是阴影的问题）。
//
// 用法（需要本地 dev server，且库里有些记录）：node test/manual/shadow-clip.mjs --pass <密码>
// 发现任何一处就以非 0 退出。
import { launchBrowser, loginAndSetCookie } from './cdp.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:8787');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin');
const { send, read, close } = await launchBrowser({ port: Number(arg('port', '9448')), width: 1440, height: 900 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 浏览器里执行的扫描脚本
const scan = `(() => {
  const out = [];
  const sel = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : '');
  for (const el of (window.__only ? [window.__only] : document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    if (cs.boxShadow === 'none' || cs.display === 'none' || cs.visibility === 'hidden') continue;
    // 悬停态还要看**元素自身**：风格里的按钮悬停时会位移（如 translate(-1px,-1px)），位移后它的边框
    // 本身可能越出带 overflow 的容器 —— 被切掉的是按钮上边 / 左边那一圈线，而不是阴影。
    // 只在悬停扫描里做（静止态的元素本来就贴着容器边也合法；越出 ≤4px 才算"被切"，更多是滚出视野了）。
    if (window.__only) {
      const own = el.getBoundingClientRect();
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (pc.overflowX === 'visible' && pc.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        const bw = (n) => parseFloat(pc['border' + n + 'Width']) || 0;
        const box = { left: pr.left + bw('Left'), right: pr.right - bw('Right'), top: pr.top + bw('Top'), bottom: pr.bottom - bw('Bottom') };
        const hit = [];
        if (pc.overflowX !== 'visible' && own.left < box.left - 0.5 && own.left > box.left - 4) hit.push('左 ' + (box.left - own.left).toFixed(1));
        if (pc.overflowX !== 'visible' && own.right > box.right + 0.5 && own.right < box.right + 4) hit.push('右 ' + (own.right - box.right).toFixed(1));
        if (pc.overflowY !== 'visible' && own.top < box.top - 0.5 && own.top > box.top - 4) hit.push('上 ' + (box.top - own.top).toFixed(1));
        if (pc.overflowY !== 'visible' && own.bottom > box.bottom + 0.5 && own.bottom < box.bottom + 4) hit.push('下 ' + (own.bottom - box.bottom).toFixed(1));
        if (hit.length) out.push(sel(el) + ' 自身被 ' + sel(p) + ' 切到 ' + hit.join('/'));
      }
    }
    // 每段外阴影 → 向外扩出的范围
    const parts = cs.boxShadow.split(/,(?![^(]*\\))/).map((s) => s.trim()).filter((s) => !s.includes('inset'));
    let l = 0, t = 0, r = 0, b = 0;
    for (const p of parts) {
      const nums = [...p.matchAll(/(-?\\d+(?:\\.\\d+)?)px/g)].map((m) => parseFloat(m[1]));
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      l = Math.max(l, spread + blur / 2 - x); r = Math.max(r, spread + blur / 2 + x);
      t = Math.max(t, spread + blur / 2 - y); b = Math.max(b, spread + blur / 2 + y);
    }
    if (l + t + r + b <= 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const sh = { left: rect.left - l, top: rect.top - t, right: rect.right + r, bottom: rect.bottom + b };
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const pc = getComputedStyle(p);
      if (pc.overflowX === 'visible' && pc.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      const bw = (n) => parseFloat(pc['border' + n + 'Width']) || 0;
      const box = { left: pr.left + bw('Left'), right: pr.right - bw('Right'), top: pr.top + bw('Top'), bottom: pr.bottom - bw('Bottom') };
      const clipX = pc.overflowX !== 'visible', clipY = pc.overflowY !== 'visible';
      const cut = [];
      // 裁剪框的边正好贴着视口边缘时，阴影超出去的部分本来就在屏幕外，看不见，不算缺陷
      const vw = window.innerWidth, vh = window.innerHeight;
      if (box.right >= vw - 0.5) sh.right = Math.min(sh.right, box.right);
      if (box.left <= 0.5) sh.left = Math.max(sh.left, box.left);
      if (box.bottom >= vh - 0.5) sh.bottom = Math.min(sh.bottom, box.bottom);
      if (box.top <= 0.5) sh.top = Math.max(sh.top, box.top);
      if (clipX && sh.right > box.right + 0.5 && r > 0) cut.push('右 ' + (sh.right - box.right).toFixed(1));
      if (clipX && sh.left < box.left - 0.5 && l > 0) cut.push('左 ' + (box.left - sh.left).toFixed(1));
      if (clipY && sh.bottom > box.bottom + 0.5 && b > 0) cut.push('下 ' + (sh.bottom - box.bottom).toFixed(1));
      if (clipY && sh.top < box.top - 0.5 && t > 0) cut.push('上 ' + (box.top - sh.top).toFixed(1));
      // 只关心「阴影本体没被父级整体裁掉」的情形：元素自己在容器里、阴影超出
      if (cut.length && rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom) out.push(sel(el) + ' 被 ' + sel(p) + ' 裁掉 ' + cut.join('/'));
    }
  }
  return [...new Set(out)];
})()`;

// 悬停态：风格里的按钮悬停时会位移并加大阴影（如网点俱乐部 translate(-1px,-1px) + 4px 阴影），
// 静止时没被裁、悬停时才被裁的情形只有真的把鼠标放上去才看得到。用真实鼠标逐个悬停，再只扫那一个元素。
const hoverCandidates = (root) => `(() => {
  const seen = new Set();
  const out = [];
  for (const el of document.querySelector(${JSON.stringify(root)}).querySelectorAll('.chip-btn, .btn, .icon-btn, .nav__item, .stat, .card, .pager__page')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    if (el.closest('[hidden]')) continue;
    const key = el.className + '|' + (el.closest('.chips') ? 'chips' : el.closest('.nav') ? 'nav' : el.closest('.settings') ? 'settings' : 'page');
    if (seen.has(key)) continue; // 同一类按钮悬停一个代表即可
    seen.add(key);
    out.push(el);
  }
  window.__cands = out;
  return out.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
})()`;

async function scanHover(root = 'body') {
  const points = await read(hoverCandidates(root));
  const found = [];
  for (let i = 0; i < points.length; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points[i].x, y: points[i].y });
    await wait(260); // 过渡 100ms
    await read(`window.__only = window.__cands[${i}]; 1`);
    for (const hit of await read(scan)) found.push(`悬停 ${hit}`);
    await read(`window.__only = null; 1`);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  return [...new Set(found)];
}

const problems = [];
try {
  await loginAndSetCookie(send, { base: BASE, user: USER, pass: PASS });
  await send('Page.navigate', { url: `${BASE}/ui/` }); // localStorage 需要一个真实的同源文档
  await wait(1200);
  for (const style of ['default', 'coast', 'paper', 'pop']) {
    await read(`localStorage.setItem('clip-style', '${style}'); 1`);
    await send('Page.navigate', { url: `${BASE}/ui/` });
    await wait(1800);
    const views = { 主界面: await read(scan) };
    views['主界面（悬停）'] = await scanHover('.app');
    await read(`document.querySelector('.sidebar__settings').click(); 1`);
    await wait(1500);
    views['部署信息'] = await read(scan);
    views['部署信息（悬停）'] = await scanHover('dialog[open]');
    await read(`document.querySelector('dialog[open] .modal__head .icon-btn').click(); document.querySelectorAll('.card')[2]?.click(); 1`);
    await wait(900);
    views['详情'] = await read(scan);
    await read(`document.querySelector('.pane__close')?.click(); document.querySelector('.sidebar .icon-btn[aria-label="外观与主题"]').click(); 1`);
    await wait(700);
    views['外观'] = await read(scan);
    // 选中一条之后才会出现的批量条（它带硬阴影，且贴着滚动区底部）
    await read(`document.querySelector('dialog[open] .modal__head .icon-btn').click(); document.querySelectorAll('.card .tile')[1]?.click(); 1`);
    await wait(700);
    views['批量条'] = await read(scan);
    // 收藏视图：列表头的类型按钮（全部 / 文本 / 图片…）只在这类视图里出现，主界面扫不到它们
    await send('Page.navigate', { url: `${BASE}/ui/?starred=1` });
    await wait(1800);
    views['收藏视图（悬停）'] = await scanHover('.app');
    for (const [view, list] of Object.entries(views)) for (const item of list) problems.push(`[${style}] ${view}：${item}`);
  }
  await read(`localStorage.removeItem('clip-style'); 1`);
} finally {
  close();
}
if (problems.length > 0) {
  console.error(`阴影被裁 ${problems.length} 处：\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ 四套风格 × 五个视图：没有被裁掉的阴影');
