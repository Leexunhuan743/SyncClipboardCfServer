// 记录流：列表头（全选 / 计数 / 筛选摘要）+ 按日分组的记录卡 + 各种空状态。
//
// 三条性能/正确性纪律：
//   1. **按 key 对账**：同一个 key 的卡片在内容签名没变时原样复用，不重建 DOM ——
//      避免缩略图重载、焦点丢失和无意义的 DOM 写入（轮询每 10 秒就会触发一次渲染）。
//   2. **事件委托**：整个列表只挂一个 click / keydown，动作按钮靠 `data-act` 分派，
//      并且分派时读**当前**的 item（`state.items` 里最新的那一份），不读构建时的闭包快照。
//   3. 用户内容只经 textContent，缩略图只用同源 `/ui/api/.../data`。
import { clear, h, icon } from '../lib/dom';
import { iconForKind } from '../lib/icons';
import { itemIsImage } from '../lib/clipboard';
import { api } from '../lib/api';
import { dayLabel, formatAbsolute, formatClock, formatRelative, formatSize, previewIsEmpty, previewText, typeLabel } from '../lib/format';
import { isFiltered, isTimeSort } from '../lib/filters';
import { excerptAround, highlightSegments } from '../lib/highlight';
import { writeText } from '../lib/clipboard';
import { toast } from '../ui/toast';
import type { Filters, Item, ItemType, SortField, TypeFilter } from '../lib/types';
import type { AppState } from '../state';

export type CardAct = 'copy' | 'download' | 'star' | 'pin' | 'restore' | 'purge' | 'trash';

export interface FeedActions {
  onOpen(item: Item): void;
  onToggleSelect(item: Item, range: boolean): void;
  onSelectAll(select: boolean): void;
  onClearSelection(): void;
  onAct(act: CardAct, item: Item, button: HTMLElement): void;
  onFocusKey(key: string): void;
  onClearFilters(): void;
  onEmptyTrash(): void;
  onRenameFolder(): void;
  onDeleteFolder(): void;
  onType(type: TypeFilter): void;
  onNew(): void;
  onRetry(): void;
}

// 缩略图只对「小图」直接取原图：数据端点不做缩放（R2 透传），一条 32 MiB 的图片记录
// 就是一整张 32 MiB 的下载 —— `loading="lazy"` 只推迟它，不减少它。大图改用占位，看原图走详情。
const THUMB_MAX_BYTES = 512 * 1024;

const TIME_FIELD: Record<SortField, 'createTime' | 'lastModified' | 'lastAccessed'> = {
  createTime: 'createTime',
  lastModified: 'lastModified',
  lastAccessed: 'lastAccessed',
  size: 'createTime',
  type: 'createTime',
};

interface CardRef {
  el: HTMLElement;
  sig: string;
  time: HTMLElement;
}

function signature(item: Item, state: AppState, folderName: string): string {
  return [
    item.type, item.starred, item.pinned, item.folderId, folderName, state.filters.folder, item.isDeleted, item.size, item.hasData, item.textTruncated,
    item.dataName ?? '', item.text, item.lastModified, item.lastAccessed, state.density, state.filters.sort, state.filters.search,
  ].join('\u0001');
}

/** 能"复制"的记录：文本，或图片。其余类型的主动作是下载。 */
export function isCopyable(item: Item): boolean {
  return item.type === 'Text' || itemIsImage(item);
}

function typeTile(item: Item): HTMLElement {
  return h('div', { class: 'tile', dataset: { type: item.type } }, icon(iconForKind(item.type), { size: 20 }));
}

function lead(item: Item): HTMLElement {
  if (!itemIsImage(item) || !item.hasData || item.size > THUMB_MAX_BYTES) return typeTile(item);
  const wrap = h('div', { class: 'tile tile--thumb', dataset: { type: item.type } });
  const img = h('img', { class: 'thumb', alt: '', loading: 'lazy', decoding: 'async', src: api.dataUrl(item) });
  // 取不到（对象已被清理 / 文件名像图片其实不是）：退回类型图标
  img.addEventListener('error', () => {
    wrap.replaceChildren(icon('warning', { size: 20 }));
    wrap.title = '缩略图加载失败：数据可能已不在服务器上，或该文件不是可显示的图片';
  }, { once: true });
  wrap.append(img);
  return wrap;
}

function iconButton(act: CardAct, name: Parameters<typeof icon>[0], label: string, extra: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, dataset: { act }, ...extra }, icon(name, { filled: extra['aria-pressed'] === 'true' }));
}

function actions(item: Item): HTMLElement {
  if (item.isDeleted) {
    return h('div', { class: 'card__actions' }, iconButton('restore', 'undo', '恢复'), iconButton('purge', 'trash', '彻底删除', { class: 'icon-btn icon-btn--danger' }));
  }
  const copyable = isCopyable(item);
  return h(
    'div',
    { class: 'card__actions' },
    copyable ? iconButton('copy', 'copy', item.type === 'Text' ? '复制文本' : '复制图片') : iconButton('download', 'download', '下载'),
    iconButton('star', 'star', item.starred ? '取消收藏' : '收藏', { 'aria-pressed': String(item.starred) }),
    iconButton('pin', 'pin', item.pinned ? '取消置顶' : '置顶', { 'aria-pressed': String(item.pinned) }),
    iconButton('trash', 'trash', '移到回收站', { class: 'icon-btn icon-btn--danger' }),
  );
}

function flags(item: Item, folderName: string, inFolderView: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  // 收藏夹标记：在收藏夹视图里不画（整页都是它，重复）；紧凑模式只留图标（名字在 title 里）
  if (item.folderId !== 0 && folderName !== '' && !inFolderView) {
    out.push(h('span', { class: 'flag flag--folder', title: `收藏夹「${folderName}」· 不会被自动清理` }, icon('folder', { size: 13 }), h('span', { class: 'flag__name', text: folderName })));
  }
  if (item.pinned) out.push(h('span', { class: 'flag flag--pin', title: '已置顶' }, icon('pin', { size: 13, filled: true }), '置顶'));
  if (item.starred) out.push(h('span', { class: 'flag flag--star', title: '已收藏' }, icon('star', { size: 13, filled: true })));
  if (item.type !== 'Text' && !item.hasData) out.push(h('span', { class: 'flag flag--warn', title: '服务器上没有这条记录的数据文件' }, '数据不可用'));
  if (item.textTruncated) out.push(h('span', { class: 'flag', title: '正文较长，列表里只显示开头' }, '长文本'));
  return out;
}

/** 卡片正文：有搜索词时命中处用 <mark> 标出（其余仍走 textContent），且保证命中在可见的前几行里。 */
function textNodes(item: Item, search: string): (Node | string)[] {
  const text = previewText(item);
  if (search === '') return [text];
  return highlightSegments(excerptAround(text, search), search).map((seg) => (seg.hit ? h('mark', { class: 'hit', text: seg.text }) : seg.text));
}

function buildCard(item: Item, search: string, folderName: string, inFolderView: boolean): CardRef {
  const empty = previewIsEmpty(item);
  const time = h('time', { class: 'card__time' });
  const check = h('button', { class: 'card__check', type: 'button', role: 'checkbox', 'aria-checked': 'false', 'aria-label': '选择这条记录' }, icon('check', { size: 14 }));
  const el = h(
    'article',
    { class: 'card', role: 'listitem', tabindex: '-1', dataset: { key: item.key, type: item.type, deleted: String(item.isDeleted) } },
    check,
    lead(item),
    h(
      'div',
      { class: 'card__main' },
      h('p', { class: `card__text${empty ? ' card__text--empty' : ''}${item.type === 'Text' ? '' : ' card__text--name'}` }, textNodes(item, search)),
      h('div', { class: 'card__meta' }, h('span', { class: 'tag', dataset: { type: item.type }, text: typeLabel(item.type) }), h('span', { class: 'card__size', text: formatSize(item.size) }), time, h('span', { class: 'card__flags' }, flags(item, folderName, inFolderView))),
    ),
    actions(item),
  );
  return { el, sig: '', time };
}

export function createFeed(actionsCtx: FeedActions) {
  const cards = new Map<string, CardRef>();
  // 每张卡片元素一个递增 id：卡片被重建（签名变了）时 id 变，分组结构的比较据此知道"DOM 必须换"
  const elementIds = new WeakMap<HTMLElement, number>();
  let nextElementId = 1;
  let structure = '';
  let latest: AppState | null = null;

  // ---- 列表头 ----
  const selectAll = h('button', { class: 'check', type: 'button', role: 'checkbox', 'aria-checked': 'false', 'aria-label': '全选本页', title: '全选本页' }, icon('check', { size: 14 }));
  selectAll.addEventListener('click', () => {
    if (!latest) return;
    actionsCtx.onSelectAll(latest.selection.size < latest.items.length);
  });
  const count = h('span', { class: 'feedhead__count' });
  const typeChips = h('div', { class: 'chips', role: 'group', 'aria-label': '按类型筛选', hidden: true });
  const clearBtn = h('button', { class: 'chip-btn chip-btn--accent', type: 'button', hidden: true, onclick: () => actionsCtx.onClearFilters() }, icon('close', { size: 14 }), '清除筛选');
  const doneBtn = h('button', { class: 'chip-btn', type: 'button', hidden: true, onclick: () => actionsCtx.onClearSelection() }, '取消选择');
  const trashBtn = h('button', { class: 'btn btn--danger-ghost', type: 'button', hidden: true, onclick: () => actionsCtx.onEmptyTrash() }, icon('trash', { size: 16 }), '清空回收站');
  const renameBtn = h('button', { class: 'chip-btn', type: 'button', hidden: true, onclick: () => actionsCtx.onRenameFolder() }, icon('edit', { size: 14 }), '重命名');
  const deleteFolderBtn = h('button', { class: 'chip-btn', type: 'button', hidden: true, title: '里面的记录会移出收藏夹，记录本身不会被删除', onclick: () => actionsCtx.onDeleteFolder() }, icon('trash', { size: 14 }), '删除收藏夹');
  const head = h('div', { class: 'feedhead' }, selectAll, count, typeChips, h('span', { class: 'spacer' }), doneBtn, clearBtn, renameBtn, deleteFolderBtn, trashBtn);
  const trashNote = h('p', { class: 'note', hidden: true, text: '回收站里的记录会在 30 天后彻底清除；图片和文件的数据在此之前仍然保留，可以恢复。' });
  const folderNote = h('p', { class: 'note', hidden: true, text: '放进收藏夹的记录不会被自动清理（保留时长和最多条数都跳过它们），除非你把它们移出或移到回收站。' });

  const list = h('div', { class: 'feed__list', role: 'list', 'aria-label': '剪贴板记录' });
  const stateBox = h('div', { class: 'feed__state', hidden: true });
  const el = h('section', { class: 'feed', 'aria-label': '剪贴板历史' }, head, trashNote, folderNote, list, stateBox);

  // ---- 事件委托 ----
  const itemOf = (node: Element | null): Item | undefined => {
    const key = node?.closest<HTMLElement>('.card')?.dataset.key;
    return key ? latest?.items.find((item) => item.key === key) : undefined;
  };

  list.addEventListener('click', (event) => {
    const target = event.target as Element;
    const item = itemOf(target);
    if (!item || !latest) return;
    const act = target.closest<HTMLElement>('[data-act]');
    if (act) {
      actionsCtx.onAct(act.dataset.act as CardAct, item, act);
      return;
    }
    // 长按刚触发过选择：紧随其后的那次 click 不能再当成"打开详情"
    if (longPressed) {
      longPressed = false;
      return;
    }
    // 勾选框、图标块（头像位）都是"选择"的入口：点图标就是勾选，不必先找到那个小方框
    if (target.closest('.card__check, .tile')) {
      actionsCtx.onToggleSelect(item, event.shiftKey);
      return;
    }
    // 用户正在划选文字：不要把这次点击当成"打开/选择"
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    if (latest.selection.size > 0 || event.shiftKey || event.ctrlKey || event.metaKey) actionsCtx.onToggleSelect(item, event.shiftKey);
    else actionsCtx.onOpen(item);
  });

  // 触屏长按 = 进入多选并选中这一条（和相册、邮件、文件管理器一致）。
  // 只认触摸/笔：鼠标长按是在划选文字；移动超过 8px 或手指抬起/取消就放弃（那是在滚动）。
  let pressTimer = 0;
  let pressOrigin: { x: number; y: number } | null = null;
  let longPressed = false;
  const cancelPress = (): void => {
    clearTimeout(pressTimer);
    pressTimer = 0;
    pressOrigin = null;
  };
  list.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    const target = event.target as Element;
    if (target.closest('[data-act], .card__check')) return;
    const item = itemOf(target);
    if (!item) return;
    cancelPress();
    longPressed = false;
    pressOrigin = { x: event.clientX, y: event.clientY };
    pressTimer = window.setTimeout(() => {
      pressTimer = 0;
      longPressed = true;
      navigator.vibrate?.(12);
      actionsCtx.onToggleSelect(item, false);
    }, 450);
  });
  list.addEventListener('pointermove', (event) => {
    if (pressOrigin && Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > 8) cancelPress();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) list.addEventListener(type, cancelPress);
  // 长按会弹系统的"复制/分享"菜单：卡片上不要它（复制有专门的按钮）
  list.addEventListener('contextmenu', (event) => {
    if (longPressed || pressTimer) event.preventDefault();
  });

  const siblings = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('.card')];
  list.addEventListener('keydown', (event) => {
    const card = (event.target as Element).closest<HTMLElement>('.card');
    if (!card || event.target !== card) return;
    const all = siblings();
    const index = all.indexOf(card);
    const go = (target: HTMLElement | undefined): void => {
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    if (event.key === 'ArrowDown') go(all[index + 1]);
    else if (event.key === 'ArrowUp') go(all[index - 1]);
    else if (event.key === 'Home') go(all[0]);
    else if (event.key === 'End') go(all[all.length - 1]);
    else if (event.key === 'Enter') {
      const item = itemOf(card);
      if (item) {
        event.preventDefault();
        actionsCtx.onOpen(item);
      }
    } else if (event.key === ' ') {
      const item = itemOf(card);
      if (item) {
        event.preventDefault();
        actionsCtx.onToggleSelect(item, event.shiftKey);
      }
    }
  });
  list.addEventListener('focusin', (event) => {
    const key = (event.target as Element).closest<HTMLElement>('.card')?.dataset.key;
    if (key) actionsCtx.onFocusKey(key);
  });

  // ---- 渲染 ----
  function renderHead(state: AppState): void {
    const { filters, items, selection, total } = state;
    const selected = selection.size;
    selectAll.setAttribute('aria-checked', selected === 0 ? 'false' : selected >= items.length ? 'true' : 'mixed');
    selectAll.hidden = items.length === 0;
    const folder = filters.folder === null ? undefined : state.overview?.folders.find((f) => f.id === filters.folder);
    count.textContent = selected > 0 ? `已选 ${selected} 项` : filters.deleted ? `回收站 · ${total} 条` : folder ? `收藏夹「${folder.name}」· ${total} 条` : filters.starred ? `收藏 · ${total} 条` : `共 ${total} 条`;
    const onlyView = !filters.search && filters.range === 'all' && filters.types === 'All'; // 除了「视图」本身没有叠加别的条件
    clearBtn.hidden = !isFiltered(filters) || ((filters.starred || filters.folder !== null) && onlyView);
    renameBtn.hidden = !folder || selected > 0;
    deleteFolderBtn.hidden = !folder || selected > 0;
    folderNote.hidden = !folder;
    trashBtn.hidden = !filters.deleted || total === 0 || selected > 0;
    doneBtn.hidden = selected === 0;
    if (selected > 0) clearBtn.hidden = true;
    trashNote.hidden = !filters.deleted;
    // 收藏 / 收藏夹 / 回收站视图里，类型可以叠加筛选（类型库视图里类型就是导航本身）
    const showChips = filters.deleted || filters.starred || filters.folder !== null;
    typeChips.hidden = !showChips;
    if (showChips) {
      clear(typeChips);
      const by = (filters.deleted ? state.overview?.byType : undefined) ?? undefined;
      for (const type of ['All', 'Text', 'Image', 'File', 'Group'] as TypeFilter[]) {
        const n = type === 'All' ? undefined : by?.[type as ItemType];
        typeChips.append(
          h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(filters.types === type), onclick: () => actionsCtx.onType(type) }, type === 'All' ? '全部' : typeLabel(type), n !== undefined && n > 0 ? h('span', { class: 'chip-btn__count', text: String(n) }) : null),
        );
      }
    }
  }

  function showState(kind: 'loading' | 'error' | 'empty' | null, state: AppState): void {
    stateBox.hidden = kind === null;
    list.hidden = kind !== null;
    if (kind === null) return;
    clear(stateBox);
    stateBox.dataset.kind = kind;
    const { filters } = state;
    if (kind === 'loading') {
      stateBox.setAttribute('role', 'status');
      stateBox.setAttribute('aria-label', '正在加载');
      for (let i = 0; i < Math.min(8, filters.pageSize); i += 1) stateBox.append(h('div', { class: 'skeleton' }, h('span', { class: 'skeleton__tile' }), h('span', { class: 'skeleton__lines' }, h('span'), h('span'))));
      return;
    }
    stateBox.removeAttribute('role');
    stateBox.removeAttribute('aria-label');
    if (kind === 'error') {
      stateBox.append(
        h('div', { class: 'empty' }, h('div', { class: 'empty__art empty__art--error' }, icon('warning', { size: 28 })), h('h2', { class: 'empty__title', text: '加载失败' }), h('p', { class: 'empty__text', text: state.error ?? '请求没有成功。' }), h('button', { class: 'btn btn--primary', type: 'button', onclick: () => actionsCtx.onRetry() }, icon('refresh', { size: 16 }), '重试')),
      );
      return;
    }
    const filtered = isFiltered(filters);
    let title = '还没有任何记录';
    let text = '在任意设备上复制一段内容，几秒后它会出现在这里；也可以直接新建一条。';
    let art: Parameters<typeof icon>[0] = 'clipboard';
    if (filters.deleted) {
      title = '回收站是空的';
      text = '移到回收站的记录会先留在这里 30 天，随时可以恢复。';
      art = 'trash';
    } else if (filters.search) {
      title = '没有找到匹配的记录';
      text = `没有记录包含「${filters.search}」。检查一下拼写，或者放宽时间范围和类型。`;
      art = 'search';
    } else if (filters.folder !== null && !filters.search && filters.range === 'all' && filters.types === 'All') {
      title = '这个收藏夹是空的';
      text = '打开一条记录点底部的「收藏夹」，或者多选后用底部的「放入收藏夹」。放进来的记录不会被自动清理。';
      art = 'folder';
    } else if (filters.starred && !filtered) {
      title = '还没有收藏';
      text = '把常用的记录点亮星标，它们会固定出现在这里。';
      art = 'star';
    } else if (filtered) {
      title = '没有符合条件的记录';
      text = '试试放宽筛选条件。';
      art = 'inbox';
    }
    stateBox.append(
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty__art' }, icon(art, { size: 28 })),
        h('h2', { class: 'empty__title', text: title }),
        h('p', { class: 'empty__text', text }),
        !filtered && !filters.deleted && !filters.starred ? onboarding() : null,
        h('div', { class: 'row' }, (isFiltered(filters) && !(filters.folder !== null && !filters.search && filters.range === 'all' && filters.types === 'All')) || filters.starred ? h('button', { class: 'btn', type: 'button', onclick: () => actionsCtx.onClearFilters() }, '清除筛选') : null, !filters.deleted && filters.folder === null ? h('button', { class: 'btn btn--primary', type: 'button', onclick: () => actionsCtx.onNew() }, icon('plus', { size: 16 }), '新建文本') : null),
      ),
    );
  }

  /** 第一次打开、库是空的：告诉用户客户端该填什么地址（这是最常见的"为什么没有记录"）。 */
  function onboarding(): HTMLElement {
    const url = `${location.origin}/`;
    return h(
      'div',
      { class: 'onboard' },
      h('p', { class: 'onboard__title', text: '在 SyncClipboard 客户端里这样填：' }),
      h('div', { class: 'row' }, h('code', { class: 'onboard__url', text: url }), h('button', { class: 'btn', type: 'button', onclick: async () => {
        const ok = await writeText(url);
        toast(ok ? '已复制服务器地址' : '复制失败：浏览器拒绝了写入剪贴板', { tone: ok ? 'success' : 'error' });
      } }, icon('copy', { size: 16 }), '复制')),
      h('p', { class: 'note', text: '类型选「SyncClipboard」（不要选 WebDAV），用户名和密码就是你现在登录用的这一组。' }),
    );
  }

  function groupLabel(item: Item, filters: Filters): string {
    return dayLabel(item[TIME_FIELD[filters.sort]]);
  }

  return {
    el,
    /** 键盘焦点移到某张卡片（快捷键 j/k 用） */
    focusKey(key: string): void {
      cards.get(key)?.el.focus();
    },
    scrollToKey(key: string): void {
      cards.get(key)?.el.scrollIntoView({ block: 'nearest' });
    },
    render(state: AppState): void {
      latest = state;
      renderHead(state);
      el.dataset.density = state.density;
      el.dataset.selecting = String(state.selection.size > 0);
      el.dataset.busy = String(state.busy);

      if (state.items.length === 0) {
        const kind = state.status === 'loading' ? 'loading' : state.status === 'error' ? 'error' : 'empty';
        list.replaceChildren();
        cards.clear();
        showState(kind, state);
        return;
      }
      showState(null, state);

      const hadFocus = list.contains(document.activeElement);
      const focusedKey = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('.card')?.dataset.key;
      const keep = new Set<string>();
      const folderNames = new Map((state.overview?.folders ?? []).map((f) => [f.id, f.name]));
      const inFolderView = state.filters.folder !== null;
      const grouped = isTimeSort(state.filters.sort);
      const groups: { label: string; cards: HTMLElement[] }[] = [];
      const now = Date.now();
      const field = TIME_FIELD[state.filters.sort];
      const prefix = state.filters.sort === 'lastModified' ? '修改于 ' : state.filters.sort === 'lastAccessed' ? '访问于 ' : '';

      for (const item of state.items) {
        keep.add(item.key);
        const folderName = folderNames.get(item.folderId) ?? '';
        const sig = signature(item, state, folderName);
        let ref = cards.get(item.key);
        if (!ref || ref.sig !== sig) {
          ref = buildCard(item, state.filters.search, folderName, inFolderView);
          ref.sig = sig;
          cards.set(item.key, ref);
        }
        const selected = state.selection.has(item.key);
        ref.el.dataset.selected = String(selected);
        ref.el.querySelector('.card__check')?.setAttribute('aria-checked', String(selected));
        ref.el.dataset.open = String(state.openKey === item.key);
        ref.el.tabIndex = (state.activeKey ?? state.items[0]?.key) === item.key ? 0 : -1;
        // 相对时间随时间流逝：每次渲染都刷新（不进签名）；分组内用时刻，不分组用相对时间
        const value = item[field];
        ref.time.textContent = `${prefix}${grouped ? formatClock(value, now) : formatRelative(value, now)}`;
        ref.time.title = formatAbsolute(value);
        const label = grouped ? groupLabel(item, state.filters) : '';
        const last = groups[groups.length - 1];
        if (last && last.label === label) last.cards.push(ref.el);
        else groups.push({ label, cards: [ref.el] });
      }
      for (const key of [...cards.keys()]) if (!keep.has(key)) cards.delete(key);

      // 分组结构（标签 + 每张卡片元素的 id，按顺序）没变时**不碰 DOM**：选择/收藏这类只改属性的渲染
      // 占绝大多数，而"挪动一张正拿着焦点的卡片"会让浏览器把滚动位置重置到顶部（实测：列表滚到
      // 900px，点一张卡去多选 → scrollTop 变 0）。属性已经在上面就地更新过了。
      const nextStructure = groups
        .map((g) => `${g.label}\u0001${g.cards.map((c) => elementIds.get(c) ?? (elementIds.set(c, nextElementId), nextElementId++)).join(',')}`)
        .join('\u0002');
      if (nextStructure !== structure || list.childElementCount === 0) {
        structure = nextStructure;
        // 必须重排时：先让焦点离开、重排、再把焦点放回去（preventScroll），并兜底保住滚动位置
        const scroller = el.closest<HTMLElement>('.scroller');
        const top = scroller?.scrollTop ?? 0;
        if (hadFocus) (document.activeElement as HTMLElement | null)?.blur();
        list.replaceChildren(
          ...groups.map((group) =>
            h('section', { class: 'group' }, group.label ? h('h3', { class: 'group__title', text: group.label }) : null, group.cards),
          ),
        );
        if (hadFocus && focusedKey) cards.get(focusedKey)?.el.focus({ preventScroll: true });
        if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
      }
    },
  };
}
