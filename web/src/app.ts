// 应用控制器：持有状态，把用户意图翻译成请求，把结果交给各视图渲染。
//
// 异步纪律（贯穿本文件）：
//   · 列表请求带 ticket + AbortController：迟到的响应不能覆盖新状态，被取代的请求不算失败；
//   · action 返回结果，视图呈现结果 —— 请求发出不等于成功，成功态只由真实结果驱动；
//   · 推送是轮询的加速器，不是替代品：WS 在线时轮询退为 60 秒看门狗，失联回 10 秒，页面隐藏 30 秒。
import { api, ApiError } from './lib/api';
import { canWriteImage, itemIsImage, writeImage, writeText } from './lib/clipboard';
import { clear, h, setIcon } from './lib/dom';
import { charCount, downloadNameForText, formatSize, safeFileName, typeLabel } from './lib/format';
import { deepLinkFor, DEFAULT_FILTERS, membershipChanged, parseDeepLink, parseFilters, serializeFilters, toApiParams } from './lib/filters';
import { createPushChannel } from './lib/push';
import type { Filters, Item } from './lib/types';
import { createState, currentNav, findItem, type AppState, type Density, type NavView } from './state';
import { confirmDialog } from './ui/dialog';
import { clearShortcuts, installShortcutDispatcher, registerShortcuts, showShortcutHelp } from './ui/shortcuts';
import { toast } from './ui/toast';
import { createBatchBar } from './views/batchbar';
import { openCompose } from './views/compose';
import { createDetail, type DetailAct } from './views/detail';
import { createFeed, type CardAct } from './views/feed';
import { createPager } from './views/pager';
import { openSettings } from './views/settings';
import { openAppearance } from './views/appearance';
import { createSidebar } from './views/sidebar';
import { createSummary } from './views/summary';
import { createTopbar } from './views/topbar';
import { createTabbar } from './views/tabbar';
import { icon } from './lib/dom';
import { closeMenu, openMenu } from './ui/menu';

const DENSITY_KEY = 'clip-density';
const POLL_VISIBLE_MS = 10_000;
const POLL_PUSH_MS = 60_000;
const POLL_HIDDEN_MS = 30_000;

function loadDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** 会话结束的原因：用户主动退出 / 请求返回 401（过期） */
export type SessionEnd = 'logout' | 'expired';

const MAX_UPLOAD_BATCH = 20;

export interface AppHandle {
  stop(): void;
}

export function startApp(root: HTMLElement, user: string, onSessionEnd: (reason: SessionEnd) => void): AppHandle {
  const state: AppState = createState(parseFilters(location.search), loadDensity());
  state.user = user;
  let listTicket = 0;
  let listAbort: AbortController | null = null;
  let lastMarker = { count: -1, lastModified: -1 };
  let pollTimer = 0;
  let pollFailures = 0;
  let anchorKey: string | null = null; // Shift 范围选择的锚点
  let lastQuery = '';
  let batchAbort: AbortController | null = null;
  let stopped = false;

  // ---------- 视图装配 ----------
  const sidebar = createSidebar({
    onNav: (view) => navigate(view),
    onSettings: () => openSettings({
      push: state.push,
      skewMs: state.skewMs,
      copyText: async (text, done) => {
        if (await writeText(text)) toast(done, { tone: 'success' });
        else toast('复制失败：浏览器拒绝了写入剪贴板', { tone: 'error' });
      },
      onEmptyTrash: () => emptyTrash(),
      onClearAll: () => clearAll(),
      onShortcuts: () => showShortcutHelp(),
    }),
    onHelp: () => showShortcutHelp(),
    onLogout: () => void logout(),
    onCloseDrawer: () => setNav(false),
  });
  const topbar = createTopbar({
    onSearch: (text) => applyFilters({ search: text }),
    onRange: (patch) => applyFilters(patch),
    onSort: (sort, order) => applyFilters({ sort, order }),
    onDensity: (density) => {
      state.density = density;
      try {
        localStorage.setItem(DENSITY_KEY, density);
      } catch {
        /* 隐私模式：仅本次生效 */
      }
      render();
    },
    onRefresh: async () => {
      await refreshAll(false, true);
    },
    onNew: (anchor) => newMenu(anchor),
    onOpenNav: () => setNav(true),
  });
  const tabbar = createTabbar({
    onNav: (view) => navigate(view),
    onMore: () => setNav(!state.navOpen),
  });
  const summary = createSummary();
  const feed = createFeed({
    onOpen: (item) => openItem(item),
    onToggleSelect: (item, range) => toggleSelect(item, range),
    onSelectAll: (select) => selectAll(select),
    onClearSelection: () => clearSelection(),
    onAct: (act, item, button) => void cardAct(act, item, button),
    onFocusKey: (key) => {
      state.activeKey = key;
    },
    onClearFilters: () => applyFilters({ ...clearedFilters(), page: 1 }),
    onEmptyTrash: () => void emptyTrash(),
    onType: (types) => applyFilters({ types }),
    onNew: () => newText(),
    onRetry: () => void refreshAll(false),
  });
  const pager = createPager({
    onPage: (page) => {
      applyFilters({ page });
      scroller.scrollTo({ top: 0 });
    },
    onPageSize: (pageSize) => applyFilters({ pageSize }),
  });
  const batch = createBatchBar({
    onCopy: () => void batchCopy(),
    onStar: (on) => void batchUpdate({ starred: on }, on ? '已收藏' : '已取消收藏'),
    onPin: (on) => void batchUpdate({ pinned: on }, on ? '已置顶' : '已取消置顶'),
    onTrash: () => void trashItems(selectedItems()),
    onRestore: () => void restoreItems(selectedItems()),
    onPurge: () => void purgeItems(selectedItems()),
    onClear: () => clearSelection(),
    onCancelRun: () => batchAbort?.abort(),
  });
  const detail = createDetail({
    onClose: () => closeDetail(),
    onStep: (delta) => stepDetail(delta),
    onAct: (act, item, button) => void detailAct(act, item, button),
    onSaveText: (text) => saveText(text),
    onCopyHash: async (hash) => {
      const ok = await writeText(hash);
      toast(ok ? '已复制哈希' : '复制失败', { tone: ok ? 'success' : 'error' });
    },
  });

  const scroller = h('div', { class: 'scroller', id: 'scroller', tabindex: '-1' }, summary.notices, summary.el, feed.el, pager.el);
  const scrim = h('div', { class: 'scrim', onclick: () => setNav(false) });
  const fresh = h('button', { class: 'fresh', type: 'button', hidden: true, onclick: () => {
    state.fresh = 0;
    scroller.scrollTo({ top: 0, behavior: 'smooth' });
    render();
  } }, icon('chevronDown', { size: 16, className: 'fresh__arrow' }), h('span'));
  const picker = h('input', { class: 'sr-only', type: 'file', multiple: true, tabindex: '-1', 'aria-hidden': 'true' });
  picker.addEventListener('change', () => {
    const files = [...(picker.files ?? [])];
    picker.value = '';
    void uploadFiles(files);
  });
  const dropzone = h('div', { class: 'dropzone', hidden: true, 'aria-hidden': 'true' }, icon('upload', { size: 36 }), h('strong', { text: '松开鼠标，上传到剪贴板历史' }), h('span', { text: '图片会存成图片记录，其它文件存成文件记录' }));
  const skip = h('a', { class: 'skip', href: '#', onclick: (event: Event) => {
    event.preventDefault();
    scroller.focus();
  } }, '跳到记录列表');
  const app = h('div', { class: 'app', dataset: { pane: 'closed' } }, skip, sidebar.el, scrim, h('main', { class: 'main' }, topbar.el, scroller, fresh, batch.el), detail.el, tabbar.el, dropzone, picker);
  clear(root).append(app);
  scroller.addEventListener('scroll', () => {
    if (state.fresh > 0 && scroller.scrollTop < 80) {
      state.fresh = 0;
      render();
    }
  }, { passive: true });

  // ---------- 渲染 ----------
  let queued = false;
  function render(): void {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (stopped) return;
      sidebar.render(state);
      topbar.render(state);
      summary.render(state);
      feed.render(state);
      pager.render(state);
      batch.render(state);
      tabbar.render(state);
      fresh.hidden = state.fresh === 0;
      if (state.fresh > 0) fresh.lastElementChild!.textContent = `${state.fresh} 条新记录`;
      document.title = pageTitle();
      const open = findItem(state, state.openKey);
      if (open) detail.update(open);
      const at = state.items.findIndex((i) => i.key === state.openKey);
      detail.setSteps(at > 0, at >= 0 && at < state.items.length - 1);
      app.dataset.pane = state.openKey ? 'open' : 'closed';
      app.dataset.nav = String(state.navOpen);
    });
  }

  function setNav(open: boolean): void {
    state.navOpen = open;
    render();
  }

  // ---------- 数据加载 ----------
  function guard(error: unknown, fallback: string): string {
    if (error instanceof ApiError && error.status === 401) {
      endSession('expired');
      return '登录已过期';
    }
    return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback;
  }

  async function loadList(silent: boolean): Promise<void> {
    const ticket = ++listTicket;
    listAbort?.abort();
    const abort = (listAbort = new AbortController());
    state.busy = true;
    if (!silent && state.items.length === 0) state.status = 'loading';
    render();
    try {
      const result = await api.list(toApiParams(state.filters), abort.signal);
      if (ticket !== listTicket) return;
      const pages = Math.max(1, Math.ceil(result.total / state.filters.pageSize));
      if (state.filters.page > pages) {
        // 翻到了不存在的页（删光了最后一页 / 手改 URL）：回到最后一页重取
        state.filters = { ...state.filters, page: pages };
        syncUrl(false);
        await loadList(true);
        return;
      }
      // 后台刷新带进来的新记录：用户已经滚离顶部时给一个「↑ N 条新记录」，而不是悄悄把列表顶下去。
      // 只在**同一个查询**的两次相邻结果之间比较（换了筛选/页就是另一份列表，不算"新"）。
      const query = JSON.stringify(toApiParams(state.filters));
      if (silent && query === lastQuery && state.items.length > 0 && state.filters.page === 1 && scroller.scrollTop > 240) {
        const known = new Set(state.items.map((i) => i.key));
        state.fresh += result.items.filter((i) => !known.has(i.key)).length;
      }
      lastQuery = query;
      state.items = result.items;
      state.total = result.total;
      state.status = 'ready';
      state.error = null;
      state.stale = false;
      const present = new Set(result.items.map((i) => i.key));
      state.selection = new Set([...state.selection].filter((key) => present.has(key)));
      if (state.activeKey && !present.has(state.activeKey)) state.activeKey = null;
    } catch (error) {
      if (ticket !== listTicket || abort.signal.aborted) return; // 被新请求取代不算失败
      const message = guard(error, '请求失败');
      // 400 = 服务端认为**查询条件**不合法（不是连接问题）：就地说明，不要显示成"连接中断"
      if (error instanceof ApiError && error.status === 400) {
        toast(`查询条件不被接受：${message}`, { tone: 'error' });
      } else if (state.items.length === 0) {
        state.status = 'error';
        state.error = message;
      } else state.stale = true;
    } finally {
      if (ticket === listTicket) {
        state.busy = false;
        render();
      }
    }
  }

  // 概览分「完整」和「轻量」：完整会让服务端列举整个 R2 桶（收费的 Class A 操作）来算存储体积，
  // 而日常刷新（收藏、移到回收站、轮询发现变化…）只需要计数。所以默认走轻量、沿用上一次的体积，
  // 只在这几种情况取完整的：第一次、距上次完整取已超过 10 分钟、以及会真正改变存储体积的操作之后
  // （上传、彻底删除、清空），或用户主动点刷新。
  const OVERVIEW_FULL_EVERY_MS = 10 * 60_000;
  let lastFullOverview = 0;

  async function loadOverview(forceFull = false): Promise<void> {
    const full = forceFull || !state.overview || Date.now() - lastFullOverview > OVERVIEW_FULL_EVERY_MS;
    try {
      const overview = await api.overview({ deleted: state.filters.deleted, light: !full });
      const previous = state.overview;
      if (!full && previous) {
        overview.info.storage = previous.info.storage;
        overview.stats.totalFileSizeMB = previous.stats.totalFileSizeMB;
      } else if (full) lastFullOverview = Date.now();
      state.overview = overview;
      state.skewMs = Date.parse(overview.serverTime) - Date.now();
      lastMarker = { ...overview.marker };
      state.stale = false;
    } catch (error) {
      guard(error, '');
      state.stale = true;
    }
    render();
  }

  async function loadActivity(): Promise<void> {
    try {
      state.activity = (await api.activity(14)).days;
      render();
    } catch {
      /* 趋势图是装饰性的：取不到就不画，不报错 */
    }
  }

  /** `full`：同时重算存储体积（见 loadOverview 的说明）。 */
  async function refreshAll(silent: boolean, full = false): Promise<void> {
    await Promise.all([loadList(silent), loadOverview(full)]);
  }

  // ---------- 筛选与导航 ----------
  function clearedFilters(): Partial<Filters> {
    const f = state.filters;
    // 在收藏 / 回收站视图里，"清除筛选"清的是叠加的条件，视图本身保留
    return { types: 'All', search: '', range: 'all', after: null, before: null, starred: f.starred, deleted: f.deleted };
  }

  function syncUrl(push: boolean): void {
    const url = `${location.pathname}${serializeFilters(state.filters)}${state.openKey ? location.hash : ''}`;
    if (url === `${location.pathname}${location.search}${location.hash}`) return;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  function applyFilters(patch: Partial<Filters>): void {
    const prev = state.filters;
    let next: Filters = { ...prev, ...patch };
    // 除"翻页"以外的任何变化都回到第 1 页
    if (patch.page === undefined) next = { ...next, page: 1 };
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    const members = membershipChanged(prev, next);
    state.filters = next;
    if (members) {
      state.selection = new Set();
      anchorKey = null;
      state.activeKey = null;
      // 不弹历史：紧接着 syncUrl 会写入新的一格，异步的 history.back() 会弹错那一格
      if (state.openKey) closeDetail(false);
    }
    syncUrl(members && patch.search === undefined);
    // 视图（回收站）变了，类型计数的口径也变了：概览要重取
    if (prev.deleted !== next.deleted) void loadOverview();
    void loadList(true);
    render();
  }

  function navigate(view: NavView): void {
    const base = { types: 'All' as const, starred: false, deleted: false };
    if (view.kind === 'type') applyFilters({ ...base, types: view.type });
    else if (view.kind === 'starred') applyFilters({ ...base, starred: true });
    else applyFilters({ ...base, deleted: true });
    scroller.scrollTo({ top: 0 });
  }

  window.addEventListener('popstate', onPop);
  function onPop(): void {
    // 系统返回键 / 浏览器后退：筛选变了就重取列表；详情开关跟着 hash 走（手机上返回键就是"关闭详情"）
    const next = parseFilters(location.search);
    if (JSON.stringify(next) !== JSON.stringify(state.filters)) {
      state.filters = next;
      state.selection = new Set();
      void refreshAll(true);
    }
    const link = parseDeepLink(location.hash);
    if (link && state.openKey !== `${link.type}-${link.hash}`) void openByRef(link);
    else if (!link && state.openKey) closeDetail(false);
    render();
  }

  // ---------- 选择 ----------
  function selectedItems(): Item[] {
    return state.items.filter((item) => state.selection.has(item.key));
  }

  function toggleSelect(item: Item, range: boolean): void {
    const next = new Set(state.selection);
    if (range && anchorKey) {
      // Shift：从锚点到当前点之间（含两端）一并选中
      const a = state.items.findIndex((i) => i.key === anchorKey);
      const b = state.items.findIndex((i) => i.key === item.key);
      if (a >= 0 && b >= 0) {
        for (const i of state.items.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(i.key);
        state.selection = next;
        render();
        return;
      }
    }
    if (next.has(item.key)) next.delete(item.key);
    else next.add(item.key);
    anchorKey = item.key;
    state.selection = next;
    render();
  }

  function selectAll(select: boolean): void {
    state.selection = select ? new Set(state.items.map((i) => i.key)) : new Set();
    render();
  }

  function clearSelection(): void {
    state.selection = new Set();
    anchorKey = null;
    render();
  }

  // ---------- 详情 ----------
  // 窄屏上详情是全屏的：它必须在历史栈里占一格，系统返回键/侧滑返回才会是"关闭详情"而不是"退出页面"。
  // 宽屏并排显示，不需要（切换记录也不再压栈，只替换当前这格）。
  const isOverlayLayout = (): boolean => window.matchMedia('(max-width: 1180px)').matches;

  function openItem(item: Item): void {
    const wasOpen = state.openKey !== null;
    state.openKey = item.key;
    state.activeKey = item.key;
    const url = `${location.pathname}${location.search}${deepLinkFor(item)}`;
    if (!wasOpen && isOverlayLayout()) history.pushState({ detail: true }, '', url);
    else history.replaceState(history.state, '', url);
    detail.show(item);
    render();
  }

  /** `unwind`：这次关闭是否要把详情占的那一格历史弹掉（返回键触发的关闭已经弹过了，传 false）。 */
  function closeDetail(unwind = true): void {
    const key = state.openKey;
    state.openKey = null;
    detail.close();
    if (unwind && (history.state as { detail?: boolean } | null)?.detail) history.back();
    else history.replaceState(null, '', `${location.pathname}${location.search}`);
    render();
    if (key) queueMicrotask(() => feed.focusKey(key));
  }

  /** 详情打开时在列表里上一条 / 下一条：直接换内容，不用先关面板再点下一张卡。 */
  function stepDetail(delta: -1 | 1): void {
    const at = state.items.findIndex((i) => i.key === state.openKey);
    const next = at < 0 ? undefined : state.items[at + delta];
    if (!next) return;
    openItem(next);
    feed.scrollToKey(next.key);
  }

  async function openByRef(ref: { type: Item['type']; hash: string }): Promise<void> {
    try {
      openItem(await api.get(ref));
    } catch (error) {
      toast(error instanceof ApiError && error.status === 404 ? '这条记录不存在或已被清理' : guard(error, '读取失败'), { tone: 'error' });
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
  }

  // ---------- 单条动作 ----------
  async function withPending<T>(button: HTMLElement | null, run: () => Promise<T>): Promise<T | undefined> {
    if (button?.dataset.pending === 'true') return undefined;
    if (button) button.dataset.pending = 'true';
    try {
      return await run();
    } finally {
      if (button) delete button.dataset.pending;
    }
  }

  /** 就地反馈：按钮自己变成对勾 1.4 秒（toast 只负责补充说明）。 */
  function flashOk(button: HTMLElement | null): void {
    if (!button?.isConnected) return;
    const original = button.querySelector('svg.icon');
    if (!original) return;
    button.dataset.state = 'ok';
    setIcon(button, 'check', { size: Number(original.getAttribute('width') ?? 18) });
    window.setTimeout(() => {
      delete button.dataset.state;
      if (button.isConnected) button.replaceChildren(original, ...[...button.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE || (n as Element).tagName === 'SPAN'));
    }, 1400);
  }

  function merge(updated: Item): void {
    const view = state.filters;
    // 在收藏 / 回收站视图里，改完不再属于当前视图的记录要立刻离开列表
    const leaves = (view.starred && !updated.starred) || view.deleted !== updated.isDeleted;
    const index = state.items.findIndex((i) => i.key === updated.key);
    if (index >= 0) {
      if (leaves) {
        state.items = state.items.filter((i) => i.key !== updated.key);
        state.total = Math.max(0, state.total - 1);
        const selection = new Set(state.selection);
        selection.delete(updated.key);
        state.selection = selection;
      } else state.items = state.items.map((i) => (i.key === updated.key ? updated : i));
    }
    // 记录离开了当前列表（例如在「收藏」视图里取消收藏）时，render 里按列表查不到它，
    // 详情面板会停在旧状态（星标仍是实心）——所以详情自己的这一条在这里直接同步。
    if (state.openKey === updated.key) detail.update(updated);
    render();
  }

  async function fullText(item: Item): Promise<string> {
    return item.textTruncated ? (await api.get(item)).text : item.text;
  }

  async function copyItem(item: Item, button: HTMLElement | null): Promise<void> {
    await withPending(button, async () => {
      try {
        if (item.type === 'Text') {
          const text = await fullText(item);
          if (!(await writeText(text))) {
            toast('浏览器拒绝了写入剪贴板。已为你打开详情，可以手动选中复制。', { tone: 'warn' });
            openItem(item);
            return;
          }
          toast(`已复制 ${charCount(text)} 个字符`, { tone: 'success' });
        } else if (itemIsImage(item)) {
          if (!item.hasData) {
            toast('这条记录的图片数据不在服务器上', { tone: 'error' });
            return;
          }
          if (!canWriteImage()) {
            toast('当前环境不支持复制图片（需要 HTTPS 页面与较新的浏览器）', { tone: 'warn', action: { label: '改为下载', run: () => void downloadItem(item, null) } });
            return;
          }
          const result = await writeImage(await api.fetchData(item));
          if (result.status !== 'ok') {
            toast(`复制图片失败${result.reason ? `：${result.reason}` : ''}`, { tone: 'error', action: { label: '改为下载', run: () => void downloadItem(item, null) } });
            return;
          }
          toast('已复制图片', { tone: 'success' });
        } else {
          await downloadItem(item, null);
          return;
        }
        flashOk(button);
        // 「使用了这条记录」：推进访问时间（静默，失败不打扰）
        api.touch(item).then(merge, () => {});
      } catch (error) {
        toast(`复制失败：${guard(error, '未知错误')}`, { tone: 'error' });
      }
    });
  }

  async function downloadItem(item: Item, button: HTMLElement | null): Promise<void> {
    await withPending(button, async () => {
      try {
        const link = h('a', { class: 'sr-only' });
        if (item.hasData) {
          // 有数据文件：直接走同源下载链接（服务端给 attachment 与文件名，流式落盘，不进内存）
          link.href = api.dataUrl(item, { download: true });
          link.download = safeFileName(item.dataName, `${item.type}-${item.hash.slice(0, 8)}`);
          document.body.append(link);
          link.click();
          link.remove();
        } else if (item.type === 'Text') {
          const text = await fullText(item);
          const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
          link.href = url;
          link.download = downloadNameForText(item);
          document.body.append(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } else {
          toast('这条记录没有可下载的数据文件', { tone: 'error' });
          return;
        }
        api.touch(item).then(merge, () => {});
      } catch (error) {
        toast(`下载失败：${guard(error, '未知错误')}`, { tone: 'error' });
      }
    });
  }

  async function toggleFlag(item: Item, field: 'starred' | 'pinned', button: HTMLElement | null): Promise<void> {
    await withPending(button, async () => {
      // 目标值取**按下那一刻**的最新数据：连点两次的第二次必须反向
      const current = state.items.find((i) => i.key === item.key) ?? item;
      try {
        const updated = await api.patch(current, { [field]: !current[field] });
        merge(updated);
        // 收藏数就地 ±1，不重取概览：概览接口要统计存储体积，会列举整个 R2 桶（Class A 操作），
        // 为一个星标去列一遍桶不值得。置顶不影响任何计数。
        if (field === 'starred' && state.overview && !current.isDeleted) {
          state.overview = { ...state.overview, starredCountActive: Math.max(0, state.overview.starredCountActive + (updated.starred ? 1 : -1)) };
          render();
        }
      } catch (error) {
        toast(`操作失败：${guard(error, '未知错误')}`, { tone: 'error' });
      }
    });
  }

  async function cardAct(act: CardAct, item: Item, button: HTMLElement): Promise<void> {
    const current = state.items.find((i) => i.key === item.key) ?? item;
    switch (act) {
      case 'copy': return copyItem(current, button);
      case 'download': return downloadItem(current, button);
      case 'star': return toggleFlag(current, 'starred', button);
      case 'pin': return toggleFlag(current, 'pinned', button);
      case 'restore': return restoreItems([current]);
      case 'purge': return purgeItems([current]);
      case 'trash': return trashItems([current]);
    }
  }

  async function detailAct(act: DetailAct, item: Item, button: HTMLElement): Promise<void> {
    switch (act) {
      case 'copy': return copyItem(item, button);
      case 'download': return downloadItem(item, button);
      case 'star': return toggleFlag(item, 'starred', button);
      case 'pin': return toggleFlag(item, 'pinned', button);
      case 'trash': return trashItems([item]);
      case 'restore': return restoreItems([item]);
      case 'purge': return purgeItems([item]);
    }
  }

  // ---------- 回收站相关 ----------
  /** 删除/恢复之后，把键盘焦点交给"同一位置"的下一张卡片，不让它掉回 <body>。 */
  function handoffFocus(removed: Item[]): void {
    const keys = new Set(removed.map((i) => i.key));
    const index = state.items.findIndex((i) => keys.has(i.key));
    const survivors = state.items.filter((i) => !keys.has(i.key));
    const target = survivors[Math.min(Math.max(index, 0), survivors.length - 1)];
    state.activeKey = target?.key ?? null;
    queueMicrotask(() => target && feed.focusKey(target.key));
  }

  async function runBatch(items: Item[], label: string, run: (signal: AbortSignal, progress: (n: number, total: number) => void) => Promise<{ done: number; failed: number; aborted: boolean }>): Promise<{ done: number; failed: number; aborted: boolean } | null> {
    if (items.length === 0) return null;
    batchAbort = new AbortController();
    const signal = batchAbort.signal;
    const long = items.length > 100;
    if (long) {
      batch.setProgress(`${label}…`);
      batch.render(state);
    }
    try {
      return await run(signal, (n, total) => long && batch.setProgress(`${label}（第 ${n} / ${total} 批）…`));
    } catch (error) {
      toast(`${label}失败：${guard(error, '未知错误')}`, { tone: 'error' });
      return null;
    } finally {
      batchAbort = null;
      batch.setProgress(null);
    }
  }

  async function trashItems(items: Item[]): Promise<void> {
    const result = await runBatch(items, '移到回收站', async (signal, onProgress) => {
      const r = await api.batchUpdate(items, { isDelete: true }, { signal, onProgress });
      return { done: r.updated, failed: r.failed, aborted: r.aborted };
    });
    if (!result) return;
    handoffFocus(items);
    state.items = state.items.filter((i) => !items.some((x) => x.key === i.key));
    state.total = Math.max(0, state.total - result.done);
    state.selection = new Set();
    if (state.openKey && items.some((i) => i.key === state.openKey)) closeDetail();
    render();
    const undo = { label: '撤销', run: () => void restoreItems(items, true) };
    if (result.failed > 0) toast(`${result.done} 条已移到回收站，${result.failed} 条失败`, { tone: 'warn' });
    else if (result.aborted) toast(`已中止：${result.done} 条已移到回收站`, { tone: 'info', action: undo });
    else toast(items.length === 1 ? '已移到回收站' : `已将 ${result.done} 条移到回收站`, { tone: 'success', action: undo });
    void refreshAll(true);
  }

  async function restoreItems(items: Item[], fromUndo = false): Promise<void> {
    const result = await runBatch(items, '恢复', async (signal, onProgress) => {
      const r = await api.batchUpdate(items, { isDelete: false }, { signal, onProgress });
      return { done: r.updated, failed: r.failed, aborted: r.aborted };
    });
    if (!result) return;
    if (state.filters.deleted) {
      handoffFocus(items);
      state.items = state.items.filter((i) => !items.some((x) => x.key === i.key));
      state.total = Math.max(0, state.total - result.done);
      state.selection = new Set();
      if (state.openKey && items.some((i) => i.key === state.openKey)) closeDetail();
    }
    render();
    toast(result.failed > 0 ? `${result.done} 条已恢复，${result.failed} 条失败` : fromUndo ? '已撤销' : `已恢复 ${result.done} 条`, { tone: result.failed > 0 ? 'warn' : 'success' });
    void refreshAll(true);
  }

  async function purgeItems(items: Item[]): Promise<void> {
    if (items.length === 0) return;
    const sample = items[0];
    const ok = await confirmDialog({
      title: items.length === 1 ? '彻底删除这条记录？' : `彻底删除 ${items.length} 条记录？`,
      message: `${items.length === 1 && sample ? `「${typeLabel(sample.type)}」记录` : '这些记录'}及其数据文件会从服务器上永久移除，无法恢复。`,
      confirmLabel: '彻底删除',
      tone: 'danger',
    });
    if (!ok) return;
    const result = await runBatch(items, '彻底删除', async (signal, onProgress) => {
      const r = await api.batchPurge(items, { signal, onProgress });
      return { done: r.purged, failed: r.failed, aborted: r.aborted };
    });
    if (!result) return;
    handoffFocus(items);
    state.items = state.items.filter((i) => !items.some((x) => x.key === i.key));
    state.total = Math.max(0, state.total - result.done);
    state.selection = new Set();
    if (state.openKey && items.some((i) => i.key === state.openKey)) closeDetail();
    render();
    toast(result.failed > 0 ? `${result.done} 条已删除，${result.failed} 条失败` : `已彻底删除 ${result.done} 条`, { tone: result.failed > 0 ? 'warn' : 'success' });
    void refreshAll(true, true);
  }

  async function emptyTrash(): Promise<void> {
    const ok = await confirmDialog({ title: '清空回收站？', message: '回收站里的全部记录及其数据文件会被永久删除，无法恢复。', confirmLabel: '清空回收站', tone: 'danger' });
    if (!ok) return;
    try {
      const { deleted } = await api.clear('trash');
      toast(`已清空回收站（${deleted} 条）`, { tone: 'success' });
      state.selection = new Set();
      if (state.openKey && state.filters.deleted) closeDetail();
      await refreshAll(true, true);
    } catch (error) {
      toast(`清空失败：${guard(error, '未知错误')}`, { tone: 'error' });
    }
  }

  async function clearAll(): Promise<void> {
    const ok = await confirmDialog({ title: '清空全部记录？', message: '所有记录（包括收藏和置顶的）以及全部数据文件都会被永久删除，无法恢复。其它设备上的客户端会随后同步为空。', confirmLabel: '清空全部', tone: 'danger', requireText: '清空' });
    if (!ok) return;
    try {
      const { deleted } = await api.clear('all');
      toast(`已清空全部记录（${deleted} 条）`, { tone: 'success' });
      state.selection = new Set();
      if (state.openKey) closeDetail();
      await refreshAll(true, true);
    } catch (error) {
      toast(`清空失败：${guard(error, '未知错误')}`, { tone: 'error' });
    }
  }

  // ---------- 批量 ----------
  async function batchUpdate(update: { starred?: boolean; pinned?: boolean }, done: string): Promise<void> {
    const items = selectedItems();
    const result = await runBatch(items, '批量更新', async (signal, onProgress) => {
      const r = await api.batchUpdate(items, update, { signal, onProgress });
      return { done: r.updated, failed: r.failed, aborted: r.aborted };
    });
    if (!result) return;
    toast(result.failed > 0 ? `${result.done} 条成功，${result.failed} 条失败` : `${done}（${result.done} 条）`, { tone: result.failed > 0 ? 'warn' : 'success' });
    clearSelection();
    void refreshAll(true);
  }

  async function batchCopy(): Promise<void> {
    const items = selectedItems().filter((i) => i.type === 'Text');
    if (items.length === 0) return;
    batchAbort = new AbortController();
    batch.setProgress('正在取回全文…');
    batch.render(state);
    try {
      // 列表里的正文被截断到 500 字符：批量复制必须取全文，否则就是把几条剪贴板各砍一半
      const full = await api.batchMeta(items, { signal: batchAbort.signal });
      if (batchAbort.signal.aborted) return;
      const order = new Map(items.map((item, index) => [item.key, index]));
      full.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
      const text = full.map((i) => i.text).join('\n\n');
      if (await writeText(text)) toast(`已复制 ${full.length} 条文本（共 ${charCount(text)} 个字符）`, { tone: 'success' });
      else toast('浏览器拒绝了写入剪贴板', { tone: 'error' });
    } catch (error) {
      toast(`复制失败：${guard(error, '未知错误')}`, { tone: 'error' });
    } finally {
      batchAbort = null;
      batch.setProgress(null);
      render();
    }
  }

  // ---------- 新建 / 编辑保存 ----------
  /** 新记录排在默认排序的最前面：回到第 1 页、清掉可能把它筛掉的条件（保留排序与页大小）。 */
  function showNewest(): void {
    const f = state.filters;
    if (f.deleted || f.starred || f.search || f.types !== 'All' || f.range !== 'all' || f.page !== 1 || f.sort !== 'createTime' || f.order !== 'desc') {
      state.filters = { ...DEFAULT_FILTERS, pageSize: f.pageSize };
      state.selection = new Set();
      syncUrl(false);
    }
    scroller.scrollTo({ top: 0 });
  }

  async function saveText(text: string): Promise<void> {
    const created = await api.createText(text);
    toast(`已保存为新记录（${charCount(text)} 个字符）`, { tone: 'success' });
    showNewest();
    openItem(created);
    await refreshAll(true);
  }

  function newText(initial = ''): void {
    openCompose((text) => saveText(text), initial);
  }

  function newMenu(anchor: HTMLElement): void {
    openMenu(anchor, [
      { label: '新建文本', icon: 'edit', hint: 'n', run: () => newText() },
      { label: '上传文件或图片…', icon: 'upload', hint: 'u', run: () => picker.click() },
    ], { align: 'end' });
  }

  // ---------- 上传（选择 / 拖拽 / 粘贴 三个入口，一条路径） ----------
  let uploading = false;

  async function uploadFiles(input: File[]): Promise<void> {
    if (input.length === 0) return;
    if (uploading) {
      toast('上一批文件还在上传，请稍候。', { tone: 'warn' });
      return;
    }
    const limit = state.overview?.info.limits.maxUploadBytes ?? 48 * 1024 * 1024;
    const files = input.slice(0, MAX_UPLOAD_BATCH);
    if (input.length > files.length) toast(`一次最多上传 ${MAX_UPLOAD_BATCH} 个文件，其余 ${input.length - files.length} 个已忽略。`, { tone: 'warn' });
    const abort = new AbortController();
    uploading = true;
    let stopProgress = (): void => {};
    const done: Item[] = [];
    const problems: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (abort.signal.aborted) break;
        if (file.size === 0) {
          problems.push(`「${file.name}」是空文件`);
          continue;
        }
        if (file.size > limit) {
          problems.push(`「${file.name}」${formatSize(file.size)} 超过上限 ${formatSize(limit)}`);
          continue;
        }
        stopProgress();
        stopProgress = toast(`正在上传 ${file.name}（${formatSize(file.size)}）${files.length > 1 ? ` · ${index + 1}/${files.length}` : ''}…`, {
          duration: 0,
          action: { label: '取消', run: () => abort.abort() },
        });
        try {
          done.push(await api.upload(file, abort.signal));
        } catch (error) {
          if (abort.signal.aborted) break;
          if (error instanceof ApiError && error.status === 413) problems.push(`「${file.name}」超过服务器上限`);
          else problems.push(`「${file.name}」${guard(error, '上传失败')}`);
        }
      }
    } finally {
      stopProgress();
      uploading = false;
    }
    if (done.length > 0) {
      showNewest();
      if (done.length === 1 && done[0]) openItem(done[0]);
      await refreshAll(true, true);
    }
    if (abort.signal.aborted) toast(done.length > 0 ? `已取消，已上传 ${done.length} 个` : '已取消上传', { tone: 'info' });
    else if (done.length > 0) toast(done.length === 1 ? '已上传' : `已上传 ${done.length} 个文件`, { tone: 'success' });
    if (problems.length > 0) toast(`${problems.length} 个文件没有上传：${problems.join('；')}`, { tone: 'error' });
  }

  // 拖拽：文件拖进窗口时出现整页遮罩；计数器处理 dragenter/dragleave 在子元素间的成对触发
  let dragDepth = 0;
  const hasFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files');
  const onDragEnter = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropzone.hidden = false;
  };
  const onDragOver = (event: DragEvent): void => {
    if (hasFiles(event)) event.preventDefault();
  };
  const onDragLeave = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.hidden = true;
  };
  const onDrop = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropzone.hidden = true;
    void uploadFiles([...(event.dataTransfer?.files ?? [])]);
  };
  // 粘贴：有文件（截图、复制的文件）就上传；只有文字就打开"新建文本"并预填。输入框里的粘贴不拦。
  const onPaste = (event: ClipboardEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length > 0) {
      event.preventDefault();
      void uploadFiles(files);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.trim() !== '') {
      event.preventDefault();
      newText(text);
    }
  };
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);
  // Ctrl/⌘+A：全选本页（输入框/对话框里保持浏览器原有的"全选文字"）
  const onSelectAllKey = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'a') return;
    const t = event.target;
    if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    if (document.querySelector('dialog[open], .menu:popover-open') || state.items.length === 0) return;
    event.preventDefault();
    selectAll(true);
  };
  document.addEventListener('keydown', onSelectAllKey);

  function pageTitle(): string {
    const f = state.filters;
    const view = currentNav(f);
    const name = f.search ? `搜索「${f.search}」` : view.kind === 'trash' ? '回收站' : view.kind === 'starred' ? '收藏' : view.type !== 'All' ? typeLabel(view.type) : '';
    return name ? `${name} · 剪贴板` : '剪贴板 · SyncClipboard';
  }

  // ---------- 会话 ----------
  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      /* 清 Cookie 失败也照样回登录页：服务端会话是无状态签名，过期自然失效 */
    }
    endSession('logout');
  }

  function endSession(reason: SessionEnd): void {
    if (stopped) return;
    stop();
    onSessionEnd(reason);
  }

  // ---------- 推送 + 轮询 ----------
  const push = createPushChannel({
    acquireTicket: async () => (await api.hubTicket()).path,
    onSignal: () => void checkChanges(),
    onState: (s) => {
      state.push = s;
      schedulePoll();
      render();
    },
  });

  async function checkChanges(): Promise<void> {
    try {
      const marker = await api.poll();
      state.skewMs = Date.parse(marker.serverTime) - Date.now();
      pollFailures = 0;
      const recovered = state.stale;
      state.stale = false;
      if (recovered || marker.count !== lastMarker.count || marker.lastModified !== lastMarker.lastModified) {
        lastMarker = { count: marker.count, lastModified: marker.lastModified };
        await refreshAll(true);
      } else render();
    } catch (error) {
      guard(error, '');
      pollFailures += 1;
      if (pollFailures >= 2) {
        state.stale = true;
        render();
      }
    }
  }

  function schedulePoll(): void {
    clearTimeout(pollTimer);
    if (stopped) return;
    const interval = document.hidden ? POLL_HIDDEN_MS : state.push === 'live' ? POLL_PUSH_MS : POLL_VISIBLE_MS;
    pollTimer = window.setTimeout(async () => {
      await checkChanges();
      schedulePoll();
    }, interval);
  }

  function onVisibility(): void {
    if (document.hidden) {
      push.stop(); // 后台标签页不占着 Durable Object
    } else {
      push.start();
      void checkChanges();
    }
    schedulePoll();
  }
  document.addEventListener('visibilitychange', onVisibility);

  // ---------- 快捷键 ----------
  const active = (): Item | undefined => findItem(state, state.activeKey) ?? state.items[0];
  const move = (delta: number): void => {
    if (state.items.length === 0) return;
    const index = state.items.findIndex((i) => i.key === state.activeKey);
    const next = state.items[Math.min(Math.max(index + delta, 0), state.items.length - 1)];
    if (next) {
      // 详情开着时 j/k 是「翻看」：直接换成相邻那条的内容（焦点留在原处，不抢）
      if (state.openKey !== null) {
        openItem(next);
        feed.scrollToKey(next.key);
        return;
      }
      feed.focusKey(next.key);
      feed.scrollToKey(next.key);
    }
  };
  const pageCount = (): number => Math.max(1, Math.ceil(state.total / state.filters.pageSize));
  registerShortcuts([
    { keys: ['/'], label: '聚焦搜索', group: '全局', run: () => topbar.focusSearch() },
    { keys: ['n'], label: '新建文本', group: '全局', run: () => newText() },
    { keys: ['u'], label: '上传文件或图片', group: '全局', run: () => picker.click(), when: () => !state.filters.deleted },
    { keys: ['r'], label: '刷新', group: '全局', run: () => void refreshAll(false, true) },
    { keys: ['?'], label: '显示快捷键', group: '全局', run: () => showShortcutHelp() },
    { keys: ['t'], label: '外观与主题', group: '全局', run: () => openAppearance() },
    { keys: ['Escape'], label: '取消选择 / 关闭详情', group: '全局', run: () => (state.selection.size > 0 ? clearSelection() : state.openKey ? closeDetail() : undefined), when: () => state.selection.size > 0 || state.openKey !== null },
    { keys: ['j'], caps: ['j', '↓'], label: '下一条（详情打开时直接预览）', group: '浏览', run: () => move(1) },
    { keys: ['k'], caps: ['k', '↑'], label: '上一条（详情打开时直接预览）', group: '浏览', run: () => move(-1) },
    { keys: ['Enter'], label: '打开详情', group: '浏览', run: () => { const i = active(); if (i) openItem(i); }, when: () => active() !== undefined && !(document.activeElement instanceof HTMLButtonElement) },
    { keys: [']'], caps: [']'], label: '下一页', group: '浏览', run: () => applyFilters({ page: state.filters.page + 1 }), when: () => state.filters.page < pageCount() },
    { keys: ['['], caps: ['['], label: '上一页', group: '浏览', run: () => applyFilters({ page: state.filters.page - 1 }), when: () => state.filters.page > 1 },
    { keys: ['x'], label: '选择 / 取消选择当前条', group: '操作', run: () => { const i = active(); if (i) toggleSelect(i, false); } },
    { keys: ['c'], label: '复制当前条', group: '操作', run: () => { const i = active(); if (i) void copyItem(i, null); }, when: () => !state.filters.deleted && active() !== undefined },
    { keys: ['s'], label: '收藏 / 取消收藏', group: '操作', run: () => { const i = active(); if (i) void toggleFlag(i, 'starred', null); }, when: () => !state.filters.deleted && active() !== undefined },
    { keys: ['p'], label: '置顶 / 取消置顶', group: '操作', run: () => { const i = active(); if (i) void toggleFlag(i, 'pinned', null); }, when: () => !state.filters.deleted && active() !== undefined },
    { keys: ['d', 'Delete'], caps: ['d'], label: '移到回收站', group: '操作', run: () => { const sel = selectedItems(); const i = active(); void trashItems(sel.length > 0 ? sel : i ? [i] : []); }, when: () => !state.filters.deleted && (state.selection.size > 0 || active() !== undefined) },
    { keys: ['z'], label: '恢复（回收站）', group: '操作', run: () => { const sel = selectedItems(); const i = active(); void restoreItems(sel.length > 0 ? sel : i ? [i] : []); }, when: () => state.filters.deleted && (state.selection.size > 0 || active() !== undefined) },
    { keys: ['g'], caps: ['g'], label: '回到顶部', group: '浏览', run: () => scroller.scrollTo({ top: 0, behavior: 'smooth' }) },
  ]);
  installShortcutDispatcher();

  // ---------- 启动 ----------
  syncUrl(false);
  render();
  void refreshAll(false).then(() => void loadActivity());
  push.start();
  schedulePoll();
  const link = parseDeepLink(location.hash);
  if (link) void openByRef(link);

  function stop(): void {
    stopped = true;
    clearTimeout(pollTimer);
    push.stop();
    listAbort?.abort();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('dragenter', onDragEnter);
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
    document.removeEventListener('paste', onPaste);
    document.removeEventListener('keydown', onSelectAllKey);
    clearShortcuts();
    // 会话结束时可能还开着菜单 / 对话框：它们属于已销毁的应用，不该盖在登录页上
    closeMenu();
    for (const dialog of document.querySelectorAll('dialog[open]')) (dialog as HTMLDialogElement).close();
  }

  return { stop };
}
