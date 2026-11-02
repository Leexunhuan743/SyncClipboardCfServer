// 顶栏：搜索（最高频的动作，占最大宽度）、时间范围、排序、密度、刷新、新建。
import { debounce, h, icon, setIcon } from '../lib/dom';
import { fromDateInput, RANGES, searchProblem, SORTS, toDateInput } from '../lib/filters';
import type { Filters, RangeKey, SortField } from '../lib/types';
import { openMenu } from '../ui/menu';
import { openModal } from '../ui/dialog';
import type { AppState, Density } from '../state';

export interface TopbarActions {
  onSearch(text: string): void;
  onRange(patch: Partial<Pick<Filters, 'range' | 'after' | 'before'>>): void;
  onSort(sort: SortField, order: 'asc' | 'desc'): void;
  onDensity(density: Density): void;
  onRefresh(): Promise<void>;
  onNew(anchor: HTMLElement): void;
  /** 复制全库最新的一条到本机剪贴板 */
  onCopyLatest(button: HTMLElement): void;
  /** 把本机剪贴板的内容存成最新的一条 */
  onPasteClipboard(button: HTMLElement): void;
  onOpenNav(): void;
}

export function createTopbar(actions: TopbarActions) {
  const input = h('input', {
    class: 'search__input',
    type: 'search',
    placeholder: '搜索剪贴板内容…',
    'aria-label': '搜索剪贴板内容',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  });
  // 「输入了但还没提交」：这段时间里后台刷新触发的渲染不能把输入框改回旧值（会吞掉用户刚打的字）
  let dirty = false;
  const problem = h('p', { class: 'search__error', id: 'search-error', role: 'alert', hidden: true });
  /** 超过服务端上限的搜索词不发请求（发了只会 400），在输入框旁就地说明原因 */
  const submit = (value: string): void => {
    const why = searchProblem(value);
    problem.hidden = why === null;
    problem.textContent = why ?? '';
    if (why) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'search-error');
      return;
    }
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    actions.onSearch(value);
  };
  const emit = debounce(() => {
    dirty = false;
    submit(input.value.trim());
  }, 260);
  const now = (value: string): void => {
    emit.cancel();
    dirty = false;
    submit(value);
  };
  // 输入法组合期间（拼音串）不发请求，`compositionend` 时补一次
  let composing = false;
  input.addEventListener('compositionstart', () => (composing = true));
  input.addEventListener('compositionend', () => {
    composing = false;
    syncClear();
    emit();
  });
  input.addEventListener('input', () => {
    syncClear();
    dirty = true;
    if (!composing) emit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (input.value === '') {
      input.blur();
      return;
    }
    event.stopPropagation();
    input.value = '';
    syncClear();
    now('');
  });
  const clearBtn = h('button', { class: 'search__clear', type: 'button', 'aria-label': '清空搜索', hidden: true, onclick: () => {
    input.value = '';
    syncClear();
    now('');
    input.focus();
  } }, icon('close', { size: 14 }));
  const hint = h('kbd', { class: 'kbd search__hint', 'aria-hidden': 'true', text: '/' });
  const syncClear = (): void => {
    clearBtn.hidden = input.value === '';
    hint.hidden = input.value !== '';
  };
  const search = h('div', { class: 'search' }, h('label', { class: 'search__field' }, icon('search', { size: 18, className: 'search__icon' }), input, clearBtn, hint), problem);

  let rangeLabel = h('span', { class: 'chip-btn__label', text: '全部时间' });
  const rangeBtn = h('button', { class: 'chip-btn', type: 'button', 'aria-haspopup': 'menu' }, icon('calendar', { size: 16 }), rangeLabel, icon('chevronDown', { size: 14 }));
  let latest: AppState | null = null;
  rangeBtn.addEventListener('click', () => {
    const current = latest?.filters.range ?? 'all';
    openMenu(
      rangeBtn,
      RANGES.map(([key, label]) => ({
        label,
        checked: current === key,
        run: () => (key === 'custom' ? askCustomRange(latest?.filters) : actions.onRange({ range: key, after: null, before: null })),
      })),
    );
  });
  const askCustomRange = (filters?: Filters): void => {
    const from = h('input', { class: 'input', type: 'date', 'aria-label': '起始日期', value: toDateInput(filters?.after) });
    const to = h('input', { class: 'input', type: 'date', 'aria-label': '结束日期', value: toDateInput(filters?.before === null || filters?.before === undefined ? null : filters.before - 1) });
    const apply = (): void => {
      const after = fromDateInput(from.value, 'start');
      const before = fromDateInput(to.value, 'end');
      modal.close();
      if (after === null && before === null) actions.onRange({ range: 'all', after: null, before: null });
      else actions.onRange({ range: 'custom', after, before });
    };
    const modal = openModal({
      title: '自定义时间范围',
      size: 'sm',
      content: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', { class: 'field__label', text: '从' }), from), h('label', { class: 'field' }, h('span', { class: 'field__label', text: '到（含当天）' }), to)),
      footer: h('div', { class: 'row row--end' }, h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => modal.close() }), h('button', { class: 'btn btn--primary', type: 'button', text: '应用', onclick: apply })),
    });
    from.focus();
  };

  const sortLabel = h('span', { class: 'chip-btn__label', text: '创建时间' });
  const sortBtn = h('button', { class: 'chip-btn', type: 'button', 'aria-haspopup': 'menu' }, icon('sort', { size: 16 }), sortLabel, icon('chevronDown', { size: 14 }));
  sortBtn.addEventListener('click', () => {
    const f = latest?.filters;
    if (!f) return;
    openMenu(sortBtn, [
      ...SORTS.map(([key, label]) => ({ label, checked: f.sort === key, run: () => actions.onSort(key, f.order) })),
      { label: '从新到旧 / 从大到小', checked: f.order === 'desc', separatorBefore: true, run: () => actions.onSort(f.sort, 'desc') },
      { label: '从旧到新 / 从小到大', checked: f.order === 'asc', run: () => actions.onSort(f.sort, 'asc') },
    ], { minWidth: 230 });
  });

  const densityBtn = h('button', { class: 'icon-btn', type: 'button' }, icon('list'));
  densityBtn.addEventListener('click', () => actions.onDensity(latest?.density === 'compact' ? 'comfortable' : 'compact'));

  const refreshBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '刷新', title: '刷新（r）' }, icon('refresh'));
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.dataset.pending === 'true') return;
    refreshBtn.dataset.pending = 'true';
    try {
      await actions.onRefresh();
    } finally {
      delete refreshBtn.dataset.pending;
    }
  });

  // 一对互为镜像的快捷入口：把服务器上最新的一条拿到本机剪贴板 / 把本机剪贴板的内容送上去。
  // 手机上它们就是这个页面最常用的两个动作（在一台设备上复制、到另一台上取），所以不藏进菜单里。
  const copyLatestBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '复制最近一条', title: '复制最近一条（l）：把最新的一条放进本机剪贴板', onclick: (event: Event) => actions.onCopyLatest(event.currentTarget as HTMLElement) }, icon('copy'));
  const pasteBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '粘贴剪贴板内容', title: '粘贴剪贴板内容（v）：把本机剪贴板存成最新的一条', onclick: (event: Event) => actions.onPasteClipboard(event.currentTarget as HTMLElement) }, icon('paste'));
  const quick = h('div', { class: 'topbar__quick' }, copyLatestBtn, pasteBtn);

  const el = h(
    'header',
    { class: 'topbar' },
    h('button', { class: 'icon-btn topbar__menu', type: 'button', 'aria-label': '打开导航', onclick: () => actions.onOpenNav() }, icon('menu')),
    search,
    h('div', { class: 'topbar__tools' }, rangeBtn, sortBtn, densityBtn, refreshBtn),
    quick,
    h('button', { class: 'btn btn--primary topbar__new', type: 'button', 'aria-haspopup': 'menu', onclick: (event: Event) => actions.onNew(event.currentTarget as HTMLElement), title: '新建文本（n）或上传文件（u）' }, icon('plus', { size: 18 }), h('span', { text: '新建' })),
  );

  return {
    el,
    focusSearch(): void {
      input.focus();
      input.select();
    },
    render(state: AppState): void {
      latest = state;
      const { filters } = state;
      if (!dirty && document.activeElement !== input && input.value !== filters.search) input.value = filters.search;
      syncClear();
      const range = RANGES.find(([key]) => key === filters.range);
      rangeLabel.textContent = filters.range === 'custom' ? `${toDateInput(filters.after) || '…'} → ${toDateInput(filters.before === null ? null : filters.before - 1) || '…'}` : (range?.[1] ?? '全部时间');
      rangeBtn.dataset.active = String(filters.range !== ('all' as RangeKey));
      sortLabel.textContent = SORTS.find(([key]) => key === filters.sort)?.[1] ?? '创建时间';
      setIcon(densityBtn, state.density === 'compact' ? 'grid' : 'list');
      densityBtn.setAttribute('aria-label', state.density === 'compact' ? '切换为舒适密度' : '切换为紧凑密度');
      densityBtn.title = state.density === 'compact' ? '切换为舒适密度' : '切换为紧凑密度';
      refreshBtn.dataset.busy = String(state.busy);
    },
  };
}
