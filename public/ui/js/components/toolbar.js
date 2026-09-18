// 工具栏：类型分段筛选、收藏筛选、搜索、每页条数、刷新。
// 筛选状态由 URL 承载（见 filters.js），这里只负责「把状态画出来 + 把用户意图报上去」。
//
// 搜索框的三处交互细节（都不是装饰）：
//   · 有内容时出现清空按钮 —— 靠全选删除清空搜索是多余的步骤；
//   · Esc 清空（空时移开焦点），与系统搜索框一致；
//   · 暴露 focusSearch()，让 `/` 这类快捷键不必知道输入框在哪。
import { el, svg, debounce } from '../dom.js';
import { iconPaths } from '../icons.js';
import { PAGE_SIZES } from '../filters.js';
import { setPending } from './toast.js';

const TYPE_OPTIONS = [
  ['All', '全部'],
  ['Text', '文本'],
  ['Image', '图片'],
  ['File', '文件'],
  ['Group', '组合'],
];

export function createToolbar({ onTypes, onToggleStarred, onSearch, onPageSize, onRefresh }) {
  const typeButtons = new Map();
  const counts = new Map();

  const segmented = el('div', { class: 'segmented', role: 'group', 'aria-label': '按类型筛选' });
  for (const [value, label] of TYPE_OPTIONS) {
    const count = el('span', { class: 'segmented__count' });
    const button = el(
      'button',
      {
        class: 'segmented__item',
        type: 'button',
        'aria-pressed': 'false',
        onclick: () => onTypes(value),
      },
      [el('span', { text: label }), count],
    );
    typeButtons.set(value, button);
    counts.set(value, count);
    segmented.append(button);
  }

  const starredButton = el(
    'button',
    {
      class: 'segmented__item',
      type: 'button',
      'aria-pressed': 'false',
      onclick: () => onToggleStarred(),
    },
    [svg(iconPaths('star'), { size: 14 }), el('span', { text: '仅收藏' })],
  );

  const searchInput = el('input', {
    class: 'input input--search',
    type: 'search',
    id: 'search',
    placeholder: '搜索记录内容…',
    'aria-label': '搜索记录内容',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const emitSearch = debounce(() => onSearch(searchInput.value.trim()), 260);
  searchInput.addEventListener('input', () => {
    syncClear();
    emitSearch();
  });
  searchInput.addEventListener('search', () => {
    // 原生「清除」按钮（部分浏览器提供）走的也是这条路
    syncClear();
    onSearch(searchInput.value.trim());
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (searchInput.value === '') return; // 已经是空：让 Esc 冒泡（交给对话框/浏览器）
    event.stopPropagation();
    searchInput.value = '';
    syncClear();
    onSearch('');
  });

  const clearButton = el(
    'button',
    {
      class: 'search__clear',
      type: 'button',
      'aria-label': '清空搜索',
      title: '清空搜索（Esc）',
      hidden: true,
      onclick: () => {
        searchInput.value = '';
        syncClear();
        onSearch('');
        searchInput.focus();
      },
    },
    [svg(iconPaths('close'), { size: 14 })],
  );

  function syncClear() {
    clearButton.hidden = searchInput.value === '';
  }

  const pageSizeSelect = el('select', {
    class: 'select',
    'aria-label': '每页条数',
    onchange: () => onPageSize(Number(pageSizeSelect.value)),
  });
  for (const size of PAGE_SIZES) {
    pageSizeSelect.append(el('option', { value: String(size), text: `${size} 条/页` }));
  }

  const refreshButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '刷新',
      title: '刷新',
      // 刷新期间按钮自己转起来：整块列表只是变淡，光靠它读不出「正在取」还是「卡住了」
      onclick: async (event) => {
        const button = event.currentTarget;
        setPending(button, true);
        try {
          await onRefresh();
        } finally {
          setPending(button, false);
        }
      },
    },
    [svg(iconPaths('refresh'))],
  );

  const node = el('div', { class: 'toolbar' }, [
    el('div', { class: 'toolbar__group' }, [segmented, starredButton]),
    el('span', { class: 'toolbar__spacer' }),
    el('div', { class: 'toolbar__group' }, [
      el('div', { class: 'search' }, [
        svg(iconPaths('search'), { size: 15, class: 'search__icon' }),
        searchInput,
        clearButton,
      ]),
      pageSizeSelect,
      refreshButton,
    ]),
  ]);

  return {
    el: node,

    /** 把焦点送到搜索框（快捷键 `/` 用） */
    focusSearch() {
      searchInput.focus();
      searchInput.select();
    },

    update({ filters, byType }) {
      for (const [value, button] of typeButtons) {
        button.setAttribute('aria-pressed', String(filters.types === value));
        const count = counts.get(value);
        if (!count) continue;
        if (value === 'All') {
          const total = Object.values(byType ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
          count.textContent = total > 0 ? String(total) : '';
        } else {
          const n = byType?.[value] ?? 0;
          count.textContent = n > 0 ? String(n) : '';
        }
      }
      starredButton.setAttribute('aria-pressed', String(filters.starred));
      if (document.activeElement !== searchInput && searchInput.value !== filters.search) {
        searchInput.value = filters.search;
      }
      syncClear();
      if (pageSizeSelect.value !== String(filters.pageSize)) pageSizeSelect.value = String(filters.pageSize);
    },
  };
}
