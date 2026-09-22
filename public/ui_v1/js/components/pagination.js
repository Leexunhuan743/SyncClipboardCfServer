// 分页：范围文本 + 上一页/下一页 + 跳页。
// 范围文本用 tabular-nums 对齐；只有一页时不给跳页控件（它此刻没有任何可做的事）。
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';

export function createPagination({ onPage }) {
  const range = el('span', { class: 'pagination__range' });
  // 「第 X / Y 页」**不能**复用 `pagination__range`：窄屏那条 `@media (max-width:480px)` 会给
  // `.pagination__range` 加 `width: 100%`（让长范围文本独占一行），两个元素共用同一个类时
  // 页码标签也独占一行 —— 分页于是在 390px 上折成"范围 / 上一页 / 页码 / 下一页"四行
  // （2026-09-18 用户截图）。两者需要的排版契约不同：范围可以整行，页码必须和按钮同一行。
  const pageLabel = el('span', { class: 'pagination__page' });

  const prev = el(
    'button',
    // `pagination__prev` 只为一件事存在：`margin-left: auto`（见 components.css）—— 它把
    // 「上一页 / 第 X/Y 页 / 下一页」这一组推到行尾。桌面靠 spacer 推；窄屏 spacer 被隐藏、
    // 且这一组经常换行到第二行，那时只有 auto margin 还能把它们贴到右边（2026-09-18 用户要求）。
    { class: 'btn pagination__prev', type: 'button', disabled: true, title: '上一页（p）', onclick: () => onPage(currentPage - 1) },
    [svg(iconPaths('chevronLeft'), { size: 16 }), el('span', { class: 'btn__label', text: '上一页' })],
  );

  const next = el(
    'button',
    { class: 'btn', type: 'button', disabled: true, title: '下一页（n）', onclick: () => onPage(currentPage + 1) },
    [el('span', { class: 'btn__label', text: '下一页' }), svg(iconPaths('chevronRight'), { size: 16 })],
  );

  const jump = el('input', {
    class: 'select pagination__jump',
    type: 'number',
    min: '1',
    'aria-label': '跳转到页码',
    placeholder: '页',
  });
  // 聚焦即全选：跳页输入框的既有内容对下一次输入没有意义，留着只会被追加。
  jump.addEventListener('focus', () => jump.select());
  jump.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // 只认**纯整数**：`parseInt('2abc')` 会得到 2，而"打错的页码被猜成另一页"比不跳更难解释
    const raw = jump.value.trim();
    const target = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    // 清空输入框（留着会让人以为「还没跳」），但**不 `blur()`**（2026-09-18 修）：
    // 此前这里 `jump.blur()`，注释写的是"交还焦点"，而那只是把焦点丢回 `<body>` ——
    // 键盘用户下一次 Tab 要从文档开头重来。V2 的 `ui/pager.js` 已删掉同一个 `blur()`，
    // 注释逐字记着症状；见 `docs/archive/AUDIT-v1-v2-divergence.md` §1.7 / §2.3。
    // 焦点留在输入框里是安全的：分页条是常驻节点，翻页只改它的文本与服务端数据。
    jump.value = '';
    if (!Number.isFinite(target)) return;
    const clamped = Math.min(Math.max(target, 1), totalPages);
    if (clamped !== currentPage) onPage(clamped);
  });

  const node = el('nav', { class: 'pagination', 'aria-label': '分页导航' }, [
    range,
    el('span', { class: 'toolbar__spacer' }),
    prev,
    pageLabel,
    next,
    jump,
  ]);

  let currentPage = 1;
  let totalPages = 1;

  return {
    el: node,
    update({ page, pageSize, total, loading = false, error = false }) {
      currentPage = page;
      totalPages = Math.max(1, Math.ceil(total / pageSize));
      const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
      const to = Math.min(page * pageSize, total);
      // 「还没到」与「真的没有」在这里也要分开（2026-09-18 补）：
      // `total === 0` 在首屏那一刻只表示"还不知道"，而它会**同时**把范围文本与页码标签
      // 写成两个确定的结论（「没有可显示的记录」「第 1 / 1 页」）—— 库里有记录时两句都是假的。
      // 列表补了骨架档（见 components/list.js），分页没有骨架可画，故这里只把两处断言
      // 换成一句不表态的等待文案（同一时刻列表与分页说的必须是同一件事）。
      const pending = loading && total === 0;
      // 失败档：**条数未知**。它既不是"正在取"，也不是"一条都没有" —— 后两句都是确定的断言，
      // 而失败这一刻我们并不知道库里有几条。故这一档什么都不说（错误态正文在上面那块里）。
      const unknown = error && total === 0;

      // 防御性夹取：真正的修法在 main.js（fetch 落地后把越界页码夹回末页，见那里的注释）。
      // 这一条是第二道保险 —— 万一将来有别的路径把越界页码送进来，也不该渲染出
      // 「第 101–100 条」这种起点大于终点的区间。取值只是让文案自洽，不代表该页真有数据。
      const safeFrom = total === 0 ? 0 : Math.min(from, total);
      range.textContent = pending
        ? '正在加载…'
        : unknown
          ? ''
          : total === 0
            ? '没有可显示的记录'
            : `第 ${safeFrom}–${to} 条，共 ${total} 条`;
      pageLabel.textContent = pending || unknown ? '' : `第 ${page} / ${totalPages} 页`;
      prev.disabled = page <= 1;
      next.disabled = page >= totalPages;
      jump.max = String(totalPages);
      jump.placeholder = String(page);
      // 只有一页时藏掉跳页控件：它此刻唯一能做的就是跳到当前页
      jump.hidden = totalPages <= 1;
      if (document.activeElement !== jump) jump.value = '';
    },
  };
}
