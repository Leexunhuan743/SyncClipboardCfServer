// Web 界面的真实浏览器探针（手动运行，不属于 npm test 套件）。
//
// 为什么需要它：单元测试读不到「用户看得见什么」—— DOM 存在不等于可见，焦点环不等于键盘可达，
// 代码里写了 flex 不等于窄屏没溢出。本探针在真实 Chromium 里量几何、按真实按键、读控制台，
// 并且**判据影响退出码**（只 console.log 不算验证；"跳过"与"通过"必须区分）。
//
// 用法（需要本地 dev server 已启动，且库里至少有 3 条记录）：
//   node test/manual/probe-ui.mjs
//   node test/manual/probe-ui.mjs --base http://127.0.0.1:8787 --user admin --pass admin
//
// ⚠️ 它会对库里的**第一条记录**做「收藏 → 取消收藏」「移到回收站 → 恢复」各一次（状态最终还原），
// 并上传一张探针用的小 PNG（结束时软删再彻底删除，不留痕迹）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectErrors, createRecorder, launchBrowser, loginAndSetCookie } from './cdp.mjs';

// 1×1 PNG（探针上传用）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:8787');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = createRecorder();
const skipped = [];

async function run({ width, height, touch, label }) {
  const { cdp, send, read, close } = await launchBrowser({ port: 9444 + (touch ? 1 : 0), width, height, touch });
  const errors = collectErrors(cdp);
  try {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await loginAndSetCookie(send, { base: BASE, user: arg('user', 'admin'), pass: arg('pass', 'admin') });
    await send('Page.navigate', { url: `${BASE}/ui/` });
    await read(`new Promise((resolve) => { const t = Date.now(); const tick = () => document.querySelector('.card') || Date.now() - t > 15000 ? resolve(1) : setTimeout(tick, 100); tick(); })`);
    await wait(500);

    // ① 渲染：列表有卡片、没有横向溢出、顶栏的搜索框没被挤没
    const cards = await read(`document.querySelectorAll('.card').length`);
    rec.check(`${label} 列表渲染出记录卡`, cards >= 3, String(cards));
    const overflow = await read(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    rec.check(`${label} 页面没有横向溢出`, overflow <= 0, `${overflow}px`);
    const searchWidth = await read(`Math.round(document.querySelector('.search').getBoundingClientRect().width)`);
    rec.check(`${label} 搜索框宽度 ≥ 180px`, searchWidth >= 180, `${searchWidth}px`);

    // ② 可点控件的命中区（粗指针 ≥ 44px）
    if (touch) {
      const small = await read(`[...document.querySelectorAll('.card__actions .icon-btn, .topbar .icon-btn, .nav__item')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && Math.min(r.width, r.height) < 40; }).length`);
      rec.check(`${label} 粗指针下可点控件 ≥ 40px`, small === 0, `${small} 个偏小`);
    }

    if (width >= 1200 && !touch) {
      // ③ 键盘：j 移动焦点、Enter 打开详情、Esc 关闭详情并把焦点还回卡片
      await read(`document.querySelector('.card').focus(); 1`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', text: 'j' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j' });
      const moved = await read(`document.activeElement?.classList.contains('card') && document.activeElement !== document.querySelector('.card')`);
      rec.check(`${label} j 把焦点移到下一张卡片`, moved === true, String(moved));
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
      await wait(500);
      const opened = await read(`document.querySelector('.app').dataset.pane === 'open' && !document.querySelector('.pane').hidden`);
      rec.check(`${label} Enter 打开详情面板`, opened === true, String(opened));
      const hash = await read(`location.hash`);
      rec.check(`${label} 详情写入深链接 #Type-hash`, /^#(Text|Image|File|Group)-/.test(hash), hash);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
      await wait(300);
      const closed = await read(`document.querySelector('.app').dataset.pane === 'closed' && document.activeElement?.classList.contains('card')`);
      rec.check(`${label} Esc 关闭详情并把焦点还给卡片`, closed === true, String(closed));

      // ④ 收藏往返：点亮 → 复原
      const key = await read(`document.querySelector('.card').dataset.key`);
      const star = `document.querySelector('.card[data-key="${key}"] [data-act="star"]')`;
      const before = await read(`${star}.getAttribute('aria-pressed')`);
      await read(`${star}.click(); 1`);
      await wait(900);
      const after = await read(`${star}.getAttribute('aria-pressed')`);
      rec.check(`${label} 点星标后状态翻转`, before !== after, `${before}→${after}`);
      await read(`${star}.click(); 1`);
      await wait(900);
      rec.check(`${label} 再点一次复原`, (await read(`${star}.getAttribute('aria-pressed')`)) === before);

      // ⑤ 移到回收站 → 撤销：行立刻消失、toast 里有「撤销」、撤销后回来
      await read(`document.querySelector('.card[data-key="${key}"] [data-act="trash"]').click(); 1`);
      await wait(900);
      const gone = await read(`!document.querySelector('.card[data-key="${key}"]')`);
      rec.check(`${label} 移到回收站后行立即消失`, gone === true, String(gone));
      const undo = await read(`!![...document.querySelectorAll('.toast__action')].find((b) => b.textContent === '撤销')`);
      rec.check(`${label} toast 里有「撤销」`, undo === true, String(undo));
      await read(`[...document.querySelectorAll('.toast__action')].find((b) => b.textContent === '撤销')?.click(); 1`);
      await wait(1200);
      const back = await read(`!!document.querySelector('.card[data-key="${key}"]')`);
      rec.check(`${label} 撤销后记录回到列表`, back === true, String(back));

      // ⑤b 上传：通过文件选择器上传一张 PNG → 记录出现（带缩略图）→ 清理
      const dir = mkdtempSync(join(tmpdir(), 'probe-upload-'));
      const fileName = `probe-${Date.now().toString(36)}.png`;
      const filePath = join(dir, fileName);
      writeFileSync(filePath, PNG);
      try {
        const { root } = await send('DOM.getDocument', { depth: 1 });
        const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
        await send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
        await wait(1800);
        const uploaded = await read(`(() => { const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('.card__text')?.textContent === ${JSON.stringify(fileName)}); return c ? { key: c.dataset.key, thumb: !!c.querySelector('.tile--thumb img') } : null; })()`);
        rec.check(`${label} 上传的图片出现在列表顶部`, uploaded !== null, 'null');
        if (uploaded) {
          rec.check(`${label} 上传的图片带缩略图`, uploaded.thumb === true, String(uploaded.thumb));
          // 清理：软删 + 彻底删除（走同源接口，会话 Cookie 已在页面里）
          await read(`(async () => { const [type, ...rest] = ${JSON.stringify(uploaded.key)}.split('-'); const items = [{ type, hash: rest.join('-') }]; const h = { 'content-type': 'application/json' }; await fetch('/ui/api/history/batch-update', { method: 'POST', headers: h, body: JSON.stringify({ items, update: { isDelete: true } }) }); await fetch('/ui/api/history/batch-purge', { method: 'POST', headers: h, body: JSON.stringify({ items }) }); return 1; })()`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      await wait(600);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
      await read(`document.querySelector('.app').dataset.pane === 'open' ? (document.querySelector('.pane__close')?.click(), 1) : 1`);

      // ⑤c 粘贴文字 → 打开「新建文本」并预填（不直接落库）
      await read(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'probe-paste-text'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
      await wait(400);
      const prefilled = await read(`document.querySelector('dialog[open] textarea')?.value ?? null`);
      rec.check(`${label} 粘贴文字后打开新建文本并预填`, prefilled === 'probe-paste-text', String(prefilled));
      await read(`document.querySelector('dialog[open] .modal__head .icon-btn')?.click(); 1`);
      await wait(300);

      // ⑥a 搜索命中高亮：搜第一张文本卡的前几个字符 → 出现 <mark>
      const needle = await read(`(() => { const t = [...document.querySelectorAll('.card[data-type="Text"] .card__text')][0]?.textContent ?? ''; return t.slice(0, 4); })()`);
      if (needle.length >= 2) {
        await read(`(() => { const i = document.querySelector('.search__input'); i.value = ${JSON.stringify(needle)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        await wait(1000);
        const marks = await read(`document.querySelectorAll('.card__text mark.hit').length`);
        rec.check(`${label} 搜索命中处有高亮`, marks > 0, String(marks));
        await read(`document.querySelector('.search__clear')?.click(); 1`);
        await wait(800);
      } else skipped.push(`${label} 搜索高亮：库里没有文本记录，已跳过`);

      // ⑤d 多选：点图标块 = 选中（不打开详情）→ Ctrl+A 全选本页 → Esc 清空
      await read(`document.activeElement?.blur(); 1`); // 上一步搜索把焦点留在输入框里，按键在输入框内是输入，不是快捷键
      // 滚到列表中间再选：选择不能让列表跳回顶部（卡片被挪动时浏览器会重置滚动位置，见 views/feed.ts 的 structure）
      await read(`document.querySelector('.scroller').scrollTop = 600; 1`);
      await wait(300);
      const scrolledBefore = await read(`Math.round(document.querySelector('.scroller').scrollTop)`);
      const topBefore = await read(`Math.round(document.querySelector('.card').getBoundingClientRect().top * 10) / 10`);
      await read(`document.querySelector('.card .tile').click(); 1`);
      await wait(250);
      const topAfter = await read(`Math.round(document.querySelector('.card').getBoundingClientRect().top * 10) / 10`);
      rec.check(`${label} 选中前后列表位置不变（「取消选择」出现不顶动下面）`, topBefore === topAfter, `${topBefore} → ${topAfter}`);
      if (scrolledBefore > 0) {
        const scrolledAfter = await read(`Math.round(document.querySelector('.scroller').scrollTop)`);
        rec.check(`${label} 滚到中间再选中，不会跳回顶部`, scrolledAfter === scrolledBefore, `${scrolledBefore} → ${scrolledAfter}`);
      } else skipped.push(`${label} 滚动不跳顶：这一档一屏放得下整页（多列），没有可滚动的距离`);
      const one = await read(`({ selected: document.querySelectorAll('.card[data-selected="true"]').length, pane: document.querySelector('.app').dataset.pane, batch: !document.querySelector('.batch').hidden })`);
      rec.check(`${label} 点图标块选中一条且不打开详情`, one.selected === 1 && one.pane === 'closed' && one.batch === true, JSON.stringify(one));
      // Ctrl 组合键要走 rawKeyDown 并带上虚拟键码，否则 Chromium 把它当编辑命令吞掉、页面收不到 keydown
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await wait(250);
      const all = await read(`({ selected: document.querySelectorAll('.card[data-selected="true"]').length, cards: document.querySelectorAll('.card').length })`);
      rec.check(`${label} Ctrl+A 全选本页`, all.selected === all.cards && all.cards > 1, JSON.stringify(all));
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
      await wait(250);
      rec.check(`${label} Esc 清空选择`, (await read(`document.querySelectorAll('.card[data-selected="true"]').length`)) === 0);

      // ⑤e 主题风格：按 t 打开「外观」→ 点卡片切换 → 立即生效、刷新后仍在、固定明暗的风格禁用明暗开关
      await read(`document.activeElement?.blur(); 1`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', text: 't' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't' });
      await wait(500);
      rec.check(`${label} 按 t 打开外观对话框`, (await read(`!!document.querySelector('dialog[open] .style-grid')`)) === true);
      const styleCards = await read(`document.querySelectorAll('dialog[open] .style-card').length`);
      rec.check(`${label} 外观里有 4 张风格卡`, styleCards === 4, String(styleCards));
      for (const [name, id, scheme] of [['海岸暮色', 'coast', 'dark'], ['暖纸田园', 'paper', 'light'], ['网点俱乐部', 'pop', 'light']]) {
        await read(`[...document.querySelectorAll('dialog[open] .style-card')].find((c) => c.textContent.includes(${JSON.stringify(name)})).click(); 1`);
        await wait(300);
        const st = await read(`({ style: document.documentElement.dataset.style, theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), modeDisabled: [...document.querySelectorAll('dialog[open] .mode-row .chip-btn')].every((b) => b.disabled), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth })`);
        rec.check(`${label} 切到「${name}」立即生效`, st.style === id && st.theme === scheme, JSON.stringify(st));
        rec.check(`${label} 「${name}」下明暗开关不可用`, st.modeDisabled === true, String(st.modeDisabled));
        rec.check(`${label} 「${name}」没有横向溢出`, st.overflow <= 0, `${st.overflow}px`);
      }
      // 刷新后仍是最后选的那套（pop），再切回默认
      await send('Page.navigate', { url: `${BASE}/ui/` });
      await read(`new Promise((resolve) => { const t = Date.now(); const tick = () => document.querySelector('.card') || Date.now() - t > 15000 ? resolve(1) : setTimeout(tick, 100); tick(); })`);
      rec.check(`${label} 刷新后风格仍保留（首帧脚本）`, (await read(`document.documentElement.dataset.style`)) === 'pop');
      await read(`localStorage.removeItem('clip-style'); localStorage.removeItem('clip-theme'); 1`);
      await send('Page.navigate', { url: `${BASE}/ui/` });
      await read(`new Promise((resolve) => { const t = Date.now(); const tick = () => document.querySelector('.card') || Date.now() - t > 15000 ? resolve(1) : setTimeout(tick, 100); tick(); })`);
      rec.check(`${label} 清除后回到默认风格`, (await read(`document.documentElement.dataset.style`)) === 'default');

      // ⑥ 搜索：一个不可能命中的词 → 空状态与「清除筛选」
      await read(`(() => { const i = document.querySelector('.search__input'); i.focus(); i.value = 'zzz-no-such-record-zzz'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
      // 等到空状态出现（最多 6 秒）：固定睡眠在服务端忙时会误报
      await read(`new Promise((resolve) => { const t = Date.now(); const tick = () => document.querySelector('.empty__title') || Date.now() - t > 6000 ? resolve(1) : setTimeout(tick, 100); tick(); })`);
      const emptyTitle = await read(`document.querySelector('.empty__title')?.textContent ?? ''`);
      rec.check(`${label} 搜不到时给出空状态`, emptyTitle.includes('没有找到'), emptyTitle);
      await read(`document.querySelector('.search__clear').click(); 1`);
      await wait(900);
      rec.check(`${label} 清空搜索后列表回来`, (await read(`document.querySelectorAll('.card').length`)) >= 3);
    } else if (width < 860) {
      // ⑦a 手机：底部标签栏贴底、四个入口、当前页高亮；字号 ≥16px（iOS 聚焦输入框不放大）
      const bar = await read(`(() => { const b = document.querySelector('.tabbar'); const r = b.getBoundingClientRect(); return { display: getComputedStyle(b).display, bottom: Math.round(r.bottom), items: b.querySelectorAll('.tabbar__item').length, current: b.querySelector('[aria-current="page"]')?.textContent ?? '' }; })()`);
      rec.check(`${label} 底部标签栏贴着视口底部`, bar.display === 'grid' && Math.abs(bar.bottom - height) <= 1, JSON.stringify(bar));
      rec.check(`${label} 标签栏有四个入口且当前页高亮`, bar.items === 4 && bar.current === '记录', JSON.stringify(bar));
      const fontSize = await read(`parseFloat(getComputedStyle(document.querySelector('.search__input')).fontSize)`);
      rec.check(`${label} 搜索框字号 ≥ 16px（防 iOS 缩放）`, fontSize >= 16, `${fontSize}px`);
      // ⑦b 系统返回键关闭详情：打开详情 → history.back() → 仍在列表页、详情已关
      const lengthBefore = await read(`history.length`);
      await read(`document.querySelector('.card').click(); 1`);
      await wait(600);
      rec.check(`${label} 打开详情占一格历史`, (await read(`history.length`)) === lengthBefore + 1, `${lengthBefore}→${await read('history.length')}`);
      await read(`history.back(); 1`);
      await wait(600);
      const afterBack = await read(`({ pane: document.querySelector('.app').dataset.pane, path: location.pathname, hash: location.hash })`);
      rec.check(`${label} 返回键关闭详情且留在应用内`, afterBack.pane === 'closed' && afterBack.path === '/ui/' && afterBack.hash === '', JSON.stringify(afterBack));
      // ⑦b2 触屏长按进入多选：长按 → 选中该条、出现批量条、不打开详情
      const point = await read(`(() => { const r = document.querySelector('.card__text').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
      const mTopBefore = await read(`Math.round(document.querySelector('.card').getBoundingClientRect().top * 10) / 10`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await wait(650);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(350);
      const mTopAfter = await read(`Math.round(document.querySelector('.card').getBoundingClientRect().top * 10) / 10`);
      rec.check(`${label} 长按选中前后列表位置不变`, mTopBefore === mTopAfter, `${mTopBefore} → ${mTopAfter}`);
      const pressed = await read(`({ selected: document.querySelectorAll('.card[data-selected="true"]').length, pane: document.querySelector('.app').dataset.pane, batch: !document.querySelector('.batch').hidden, check: getComputedStyle(document.querySelector('.card__check')).opacity })`);
      rec.check(`${label} 长按进入多选`, pressed.selected === 1 && pressed.pane === 'closed' && pressed.batch === true && pressed.check === '1', JSON.stringify(pressed));
      const batchBox = await read(`(() => { const b = document.querySelector('.batch').getBoundingClientRect(); const t = document.querySelector('.tabbar').getBoundingClientRect(); return { inside: b.left >= 0 && b.right <= innerWidth, aboveTabbar: b.bottom <= t.top + 1, count: getComputedStyle(document.querySelector('.batch__count')).display }; })()`);
      rec.check(`${label} 批量条在屏幕内、在底栏上方、显示数量`, batchBox.inside && batchBox.aboveTabbar && batchBox.count !== 'none', JSON.stringify(batchBox));
      await read(`document.querySelector('.feedhead .chip-btn:not([hidden])').click(); 1`);
      await wait(250);
      rec.check(`${label} 「取消选择」清空选择`, (await read(`document.querySelectorAll('.card[data-selected="true"]').length`)) === 0);
      // ⑦c 对话框是底部抽屉：全宽、贴底
      await read(`document.querySelector('.topbar__new').click(); 1`);
      await wait(300);
      await read(`[...document.querySelectorAll('.menu__item')].find((b) => b.textContent.includes('新建文本'))?.click(); 1`);
      await wait(500);
      const sheet = await read(`(() => { const d = document.querySelector('dialog[open]'); if (!d) return null; const r = d.getBoundingClientRect(); return { width: Math.round(r.width), bottom: Math.round(r.bottom) }; })()`);
      rec.check(`${label} 对话框是贴底的全宽抽屉`, sheet !== null && sheet.width === width && Math.abs(sheet.bottom - height) <= 1, JSON.stringify(sheet));
      await read(`document.querySelector('dialog[open] .modal__head .icon-btn')?.click(); 1`);
      await wait(300);

      // ⑦ 窄屏：侧栏是抽屉，打开后能看到导航，点遮罩关闭
      const hidden = await read(`document.querySelector('.sidebar').getBoundingClientRect().right <= 0`);
      rec.check(`${label} 侧栏默认收起为抽屉`, hidden === true, String(hidden));
      await read(`[...document.querySelectorAll('.tabbar__item')].find((b) => b.textContent === '更多').click(); 1`);
      await wait(500);
      const shown = await read(`document.querySelector('.sidebar').getBoundingClientRect().left >= 0`);
      rec.check(`${label} 点「更多」后抽屉滑出`, shown === true, String(shown));
    }

    // ⑦d 紧凑密度：桌面上信息列右缘对齐、手机上操作不溢出卡片，且比舒适密度更矮
    const cozyHeight = await read(`Math.round(document.querySelector('.card').getBoundingClientRect().height)`);
    await read(`localStorage.setItem('clip-density', 'compact'); 1`);
    await send('Page.navigate', { url: `${BASE}/ui/` });
    await read(`new Promise((resolve) => { const t = Date.now(); const tick = () => document.querySelector('.card') || Date.now() - t > 15000 ? resolve(1) : setTimeout(tick, 100); tick(); })`);
    await wait(400);
    const compact = await read(`(() => {
      const cards = [...document.querySelectorAll('.card')].slice(0, 12);
      const rights = new Set(cards.map((c) => Math.round(c.querySelector('.card__meta').getBoundingClientRect().right)));
      const columns = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size;
      const outside = cards.filter((c) => { const r = c.getBoundingClientRect(); return [...c.querySelectorAll('.card__actions, .card__actions .icon-btn')].some((e) => { const q = e.getBoundingClientRect(); return q.width > 0 && getComputedStyle(e).display !== 'none' && (q.right > r.right + 1 || q.left < r.left - 1); }); }).length;
      return { height: Math.round(cards[0].getBoundingClientRect().height), rights: rights.size, columns, outside, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    rec.check(`${label} 紧凑密度比舒适密度矮`, compact.height < cozyHeight, `${compact.height} vs ${cozyHeight}`);
    // 每一列各有一条对齐的右缘：右缘种数不能超过列数（多列时每列一条）
    if (!touch) rec.check(`${label} 紧凑密度的信息列右缘对齐`, compact.rights <= compact.columns, `${compact.rights} 种右缘 / ${compact.columns} 列`);
    rec.check(`${label} 紧凑密度下操作不溢出卡片`, compact.outside === 0, `${compact.outside} 张`);
    rec.check(`${label} 紧凑密度下没有横向溢出`, compact.overflow <= 0, `${compact.overflow}px`);
    await read(`localStorage.removeItem('clip-density'); 1`);

    // ⑨ 带鱼屏：卡片排成多列、内容区撑满大部分宽度、详情面板放宽、部署信息是多栏
    if (width >= 3000) {
      await read(`localStorage.removeItem('clip-density'); 1`);
      const wide = await read(`(() => {
        const cards = [...document.querySelectorAll('.feed__list .card')].slice(0, 40);
        const columns = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size;
        const feed = document.querySelector('.feed').getBoundingClientRect();
        const main = document.querySelector('.scroller').getBoundingClientRect();
        return { columns, fill: Math.round((feed.width / main.width) * 100), tiles: document.querySelectorAll('.summary .stat').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()`);
      rec.check(`${label} 卡片至少排 4 列`, wide.columns >= 4, JSON.stringify(wide));
      rec.check(`${label} 内容区撑满滚动区宽度的 85% 以上`, wide.fill >= 85, `${wide.fill}%`);
      rec.check(`${label} 概览多出「回收站」与「类型构成」`, wide.tiles >= 6, `${wide.tiles} 张`);
      rec.check(`${label} 带鱼屏上没有横向溢出`, wide.overflow <= 0, `${wide.overflow}px`);
      await read(`document.querySelector('.card').click(); 1`);
      await wait(700);
      const paneWidth = await read(`Math.round(document.querySelector('.pane').getBoundingClientRect().width)`);
      rec.check(`${label} 详情面板随屏宽放大（≥ 600px）`, paneWidth >= 600, `${paneWidth}px`);
      await read(`document.querySelector('.pane__close').click(); document.querySelector('.sidebar__settings').click(); 1`);
      await wait(1500);
      const dash = await read(`(() => { const s = document.querySelector('.settings'); const cols = Number(getComputedStyle(s).columnCount); const d = document.querySelector('dialog[open]').getBoundingClientRect(); return { cols, width: Math.round(d.width), health: !!document.querySelector('.health'), bar: !!document.querySelector('.typebar__seg') }; })()`);
      rec.check(`${label} 部署信息在带鱼屏上是三栏`, dash.cols === 3 && dash.width >= 1400, JSON.stringify(dash));
      rec.check(`${label} 部署信息有状态总览与类型构成条`, dash.health && dash.bar, JSON.stringify(dash));
      await read(`document.querySelector('dialog[open] .modal__head .icon-btn')?.click(); 1`);
    }

    // ⑧ 零控制台错误、零失败请求
    rec.check(`${label} 零控制台错误`, errors.consoleErrors.length === 0, errors.consoleErrors.join(' | '));
    // ERR_ABORTED 是"被新请求取代而主动取消"的列表请求（见 app.ts 的 listTicket），按设计不算失败
    const failed = errors.failedRequests.filter((line) => !line.includes('ERR_ABORTED'));
    rec.check(`${label} 零失败请求`, failed.length === 0, failed.join(' | '));
  } finally {
    close();
  }
}

await run({ width: 1440, height: 900, touch: false, label: '[桌面 1440]' });
await run({ width: 390, height: 844, touch: true, label: '[手机 390]' });
await run({ width: 3440, height: 1440, touch: false, label: '[带鱼屏 3440]' });

if (skipped.length) console.log(`跳过 ${skipped.length} 项：\n  ${skipped.join('\n  ')}`);
if (rec.problems.length) {
  console.error(`✗ ${rec.problems.length} 项不通过：\n  ${rec.problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ 探针全部通过');
