// 工具栏：类型分段筛选、收藏筛选、回收站、时间范围、搜索、每页条数、刷新。
// 筛选状态由 URL 承载（见 filters.js），这里只负责「把状态画出来 + 把用户意图报上去」。
//
// 搜索框的三处交互细节（都不是装饰）：
//   · 有内容时出现清空按钮 —— 靠全选删除清空搜索是多余的步骤；
//   · Esc 清空（空时移开焦点），与系统搜索框一致；
//   · 暴露 focusSearch()，让 `/` 这类快捷键不必知道输入框在哪。
import { el, svg, debounce } from '../dom.js';
import { iconPaths } from '../icons.js';
import { PAGE_SIZES, toDateInput, fromDateInput } from '../filters.js';
import { setPending } from './toast.js';

const TYPE_OPTIONS = [
  ['All', '全部'],
  ['Text', '文本'],
  ['Image', '图片'],
  ['File', '文件'],
  ['Group', '组合'],
];

const RANGE_OPTIONS = [
  ['all', '全部时间'],
  ['today', '今天'],
  ['7d', '近 7 天'],
  ['30d', '近 30 天'],
  ['custom', '自定义…'],
];

export function createToolbar({
  onTypes,
  onToggleStarred,
  onToggleDeleted,
  onRange,
  onSearch,
  onPageSize,
  onRefresh,
}) {
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

  // 回收站是**范围**切换（替换整个列表内容），用与类型筛选同一套分段控件表达。
  // **不带计数**：统计条那条「回收站 N 条」已按用户要求删掉（同一个入口不需要两处），
  // 但计数**不回填到这个按钮上** —— 带计数的按钮会随计数变宽窄，切换视图时工具栏会跳一下；
  // 要知道回收站里有多少条，进回收站看结果区头栏的「回收站 · 共 N 条」。
  const recycleButton = el(
    'button',
    {
      class: 'segmented__item',
      type: 'button',
      'aria-pressed': 'false',
      title: '回收站：已删除的记录（30 天后彻底清除）',
      onclick: () => onToggleDeleted(),
    },
    [svg(iconPaths('trash'), { size: 14 }), el('span', { text: '回收站' })],
  );

  // 时间范围：预设走 range，自定义才用两个日期输入。
  // 日期输入是**本地**日界（用户说「今天」指自己时区），转换见 filters.js 的 fromDateInput。
  const rangeSelect = el('select', {
    class: 'select',
    'aria-label': '时间范围',
    onchange: () => {
      const value = rangeSelect.value;
      // 切回预设时清掉自定义边界，避免 URL 里留着用不上的 after/before
      onRange(value === 'custom' ? { range: 'custom' } : { range: value, after: null, before: null });
    },
  });
  for (const [value, label] of RANGE_OPTIONS) {
    rangeSelect.append(el('option', { value, text: label }));
  }

  const fromInput = el('input', {
    class: 'input input--date',
    type: 'date',
    'aria-label': '起始日期',
    onchange: () => onRange({ range: 'custom', after: fromDateInput(fromInput.value, 'start') }),
  });
  const toInput = el('input', {
    class: 'input input--date',
    type: 'date',
    'aria-label': '结束日期',
    onchange: () => onRange({ range: 'custom', before: fromDateInput(toInput.value, 'end') }),
  });
  const dateRange = el('div', { class: 'date-range', hidden: true }, [
    el('span', { class: 'date-range__label', text: '从' }),
    fromInput,
    el('span', { class: 'date-range__label', text: '到' }),
    toInput,
  ]);

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
  // 输入法组合（中文/日文）：compositionstart 到 compositionend 之间，Chrome 会在**每次按键**上
  // 派发 `input` —— 于是「zhongwen」这种拼音串会被逐段当成搜索词发出去（打 8 个字母 = 8 次请求 +
  // 8 次列表重排），用户在选词时看到的列表则是按拼音乱跳的。
  // 纪律：组合期间不发，`compositionend` 时补一次（此时 value 才是真正的汉字）。
  // 与 V2 的同名处理对齐（`public/ui/js/ui/omnibox.js`），两版界面的搜索手感必须一致。
  let composing = false;
  searchInput.addEventListener('compositionstart', () => {
    composing = true;
  });
  searchInput.addEventListener('compositionend', () => {
    composing = false;
    syncClear();
    emitSearch();
  });
  searchInput.addEventListener('input', () => {
    syncClear();
    if (composing) return;
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

  // `/` 快捷键的提示：这条快捷键此前只写在 docs 与代码注释里，界面上没有任何线索
  // （用户不会去按一个自己不知道存在的键）。做成搜索框内右侧的一枚键帽，
  // 有内容时让位给清空按钮（两者占同一个位置），触屏下隐藏（`pointer: coarse`）。
  const keyHint = el('kbd', { class: 'search__key', 'aria-hidden': 'true', text: '/' });

  function syncClear() {
    clearButton.hidden = searchInput.value === '';
    keyHint.hidden = searchInput.value !== '';
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
    // 顺序 = 主次（2026-09-17 重排）：搜索在最前且可伸展，因为它是这个页面最高频的动作；
    // 旧版把它夹在「50 条/页」「刷新」之间，8 个控件同权，用户得先找到它。
    // 窄屏下这一组整行独占（layout.css 的窄屏块），顺序因此同时也是移动端的阅读顺序。
    el('div', { class: 'toolbar__group toolbar__group--search' }, [
      el('div', { class: 'search' }, [
        svg(iconPaths('search'), { size: 15, class: 'search__icon' }),
        searchInput,
        clearButton,
        keyHint,
      ]),
    ]),
    // 类型分段这一组在窄屏要整行独占（它自身横向滚动），故与搜索组一样带一个可寻址的类
    el('div', { class: 'toolbar__group toolbar__group--types' }, [segmented]),
    el('div', { class: 'toolbar__group' }, [starredButton, recycleButton, rangeSelect]),
    el('span', { class: 'toolbar__spacer' }),
    el('div', { class: 'toolbar__group' }, [
      pageSizeSelect,
      refreshButton,
    ]),
    // 日期行单独占一行（CSS 里 flex-basis: 100%）：塞进上面那组会把整条工具栏挤成三行，
    // 中间那行还会只剩一个被压扁的 spacer。
    dateRange,
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
      recycleButton.setAttribute('aria-pressed', String(filters.deleted));

      if (rangeSelect.value !== filters.range) rangeSelect.value = filters.range;
      dateRange.hidden = filters.range !== 'custom';
      // before 是开区间上界（次日 00:00），回显成日期时要减回去，否则「到 9-13」会显示成 9-14
      const fromValue = toDateInput(filters.after);
      const toValue = toDateInput(filters.before === null ? null : filters.before - 1);
      if (document.activeElement !== fromInput && fromInput.value !== fromValue) fromInput.value = fromValue;
      if (document.activeElement !== toInput && toInput.value !== toValue) toInput.value = toValue;

      if (document.activeElement !== searchInput && searchInput.value !== filters.search) {
        searchInput.value = filters.search;
      }
      syncClear();
      if (pageSizeSelect.value !== String(filters.pageSize)) pageSizeSelect.value = String(filters.pageSize);
    },
  };
}
