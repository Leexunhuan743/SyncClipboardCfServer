// 分页：上一页 / 页码窗口 / 下一页 + 每页条数。页码窗口是纯函数（`pageWindow`），有单元测试。
import { clear, h, icon } from '../lib/dom';
import { PAGE_SIZES } from '../lib/filters';
import { pageWindow } from '../lib/pagination';
import type { AppState } from '../state';

export interface PagerActions {
  onPage(page: number): void;
  onPageSize(size: number): void;
}

export function createPager(actions: PagerActions) {
  const nav = h('nav', { class: 'pager__nav', 'aria-label': '分页' });
  const select = h('select', { class: 'select', 'aria-label': '每页条数', onchange: () => actions.onPageSize(Number(select.value)) });
  for (const size of PAGE_SIZES) select.append(h('option', { value: String(size), text: `${size} 条/页` }));
  const el = h('div', { class: 'pager', hidden: true }, nav, select);

  return {
    el,
    render(state: AppState): void {
      const { filters, total } = state;
      const pages = Math.max(1, Math.ceil(total / filters.pageSize));
      el.hidden = total === 0;
      select.value = String(filters.pageSize);
      clear(nav);
      const step = (label: string, to: number, disabled: boolean, name: 'chevronLeft' | 'chevronRight') =>
        h('button', { class: 'pager__step', type: 'button', 'aria-label': label, disabled, onclick: () => actions.onPage(to) }, icon(name, { size: 18 }));
      nav.append(step('上一页', filters.page - 1, filters.page <= 1, 'chevronLeft'));
      for (const n of pageWindow(filters.page, pages)) {
        if (n === '…') nav.append(h('span', { class: 'pager__gap', 'aria-hidden': 'true', text: '…' }));
        else nav.append(h('button', { class: 'pager__page', type: 'button', text: String(n), 'aria-label': `第 ${n} 页`, 'aria-current': n === filters.page ? 'page' : undefined, onclick: () => actions.onPage(n) }));
      }
      nav.append(step('下一页', filters.page + 1, filters.page >= pages, 'chevronRight'));
    },
  };
}
