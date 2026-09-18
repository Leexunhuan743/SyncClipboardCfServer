// 分页：范围文本、上一页/下一页、跳页。
//
// 与 V1 的差别只有一处实质性的：跳页在窄屏被收起（移动端几乎没人用它，而它占地最宽）。
// 其余保留 —— 这一块 V1 的做法没有问题（聚焦全选、回车后清空并交还焦点）。
import { el } from '../dom.js';
import { labelButton } from './button.js';

/**
 * @param {{ onPage: (page: number) => void }} handlers
 */
export function createPager({ onPage }) {
  const status = el('span', { class: 'pager__status' });

  const prev = labelButton({
    label: '上一页',
    icon: 'chevronLeft',
    iconSize: 15,
    className: 'btn btn--sm',
    attrs: { 'aria-label': '上一页' },
    onClick: () => onPage(currentPage - 1),
  });

  const next = labelButton({
    label: '下一页',
    icon: 'chevronRight',
    iconSide: 'end',
    iconSize: 15,
    className: 'btn btn--sm',
    attrs: { 'aria-label': '下一页' },
    onClick: () => onPage(currentPage + 1),
  });

  const input = el('input', {
    class: 'pager__input',
    type: 'number',
    min: '1',
    'aria-label': '跳转到第几页',
    onfocus: (event) => event.target.select(),
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      const value = Number.parseInt(event.target.value, 10);
      event.target.value = '';
      // 这里原来还有一个 `event.target.blur()`：跳页后焦点会掉回 `<body>`，
      // 键盘用户下一次 Tab 从文档开头重来（他要找的那一行离得很远）。
      // 焦点留在输入框里没有副作用：它的内容已清空、`onfocus` 会全选，
      // 再输入一页即可（实测 2026-09-16）。
      if (Number.isFinite(value)) onPage(value);
    },
  });

  const jump = el('span', { class: 'pager__jump' }, [
    el('label', { for: 'pager-jump', text: '跳至' }),
    input,
    el('span', { text: '页' }),
  ]);
  input.id = 'pager-jump';

  const root = el('nav', { class: 'pager', 'aria-label': '分页' }, [
    el('span', { class: 'pager__spacer' }),
    prev,
    status,
    next,
    el('span', { class: 'pager__spacer' }),
    jump,
  ]);

  let currentPage = 1;

  return {
    el: root,

    update({ page, pageSize, total }) {
      const pages = Math.max(1, Math.ceil((total ?? 0) / pageSize));
      currentPage = Math.min(Math.max(1, page), pages);

      const from = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
      const to = Math.min(currentPage * pageSize, total ?? 0);
      // 只有一页时不显示范围（"1–23 / 共 23 条 · 第 1/1 页"是废话，而它占了整条中间的宽度）
      status.textContent =
        pages <= 1 ? `共 ${total ?? 0} 条` : `${from}–${to} · 共 ${total ?? 0} 条 · 第 ${currentPage}/${pages} 页`;

      prev.disabled = currentPage <= 1;
      next.disabled = currentPage >= pages;
      input.max = String(pages);
      input.placeholder = String(currentPage);
    },
  };
}
