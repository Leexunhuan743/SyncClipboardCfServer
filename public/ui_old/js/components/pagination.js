// 分页：范围文本 + 上一页/下一页 + 跳页。
// 范围文本用 tabular-nums 对齐；只有一页时不给跳页控件（它此刻没有任何可做的事）。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';

export function createPagination({ onPage }) {
  const range = el('span', { class: 'pagination__range' });
  const pageLabel = el('span', { class: 'pagination__range' });

  const prev = el(
    'button',
    { class: 'btn', type: 'button', disabled: true, onclick: () => onPage(currentPage - 1) },
    [svg(iconPaths('chevronLeft'), { size: 16 }), el('span', { class: 'btn__label', text: '上一页' })],
  );

  const next = el(
    'button',
    { class: 'btn', type: 'button', disabled: true, onclick: () => onPage(currentPage + 1) },
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
    const target = Number.parseInt(jump.value, 10);
    // 跳完就清空并交还焦点：留在输入框里会让人以为「还没跳」，也可能被下一次回车重复触发。
    jump.value = '';
    jump.blur();
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
    update({ page, pageSize, total }) {
      currentPage = page;
      totalPages = Math.max(1, Math.ceil(total / pageSize));
      const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
      const to = Math.min(page * pageSize, total);

      // 防御性夹取：真正的修法在 main.js（fetch 落地后把越界页码夹回末页，见那里的注释）。
      // 这一条是第二道保险 —— 万一将来有别的路径把越界页码送进来，也不该渲染出
      // 「第 101–100 条」这种起点大于终点的区间。取值只是让文案自洽，不代表该页真有数据。
      const safeFrom = total === 0 ? 0 : Math.min(from, total);
      range.textContent = total === 0 ? '没有可显示的记录' : `第 ${safeFrom}–${to} 条，共 ${total} 条`;
      pageLabel.textContent = `第 ${page} / ${totalPages} 页`;
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
