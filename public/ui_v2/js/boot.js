// 装配点：只有这里知道「谁是谁」。组件之间互不认识，也**不碰网络** ——
// 网络只发生在这一层（`js/ui/*` 不 import `api.js`，这条分层纪律让组件可以纯函数化）。
//
// 数据流：actions（用户意图）→ store（状态）→ 组件 update（渲染）
//
// 三条全局约定（从 V1 继承，都是实测换来的）：
//   ① **actions 返回结果，组件呈现结果**：`true` 才算做成 —— 只看"请求发出去了"
//      会把失败显示成成功。
//   ② **每次往返过 `latest.js` 的守卫**：列表与概览各持一个 gate，`isCurrent` 通过才写回。
//      少了它就是"陈旧响应覆盖新状态"（V1 实测复现过：URL 说 Text、列表里是 46 行图片）。
//   ③ **推送是轮询的加速器，不是替代品**：连上时轮询降为 60 秒看门狗，断线回到 10 秒。
//      看门狗存在的意义正是"广播没到"（DO 休眠、代理掐连接）。
import { api, ApiError, handleAuthError, redirectToLogin } from './api.js';
import { createStore } from './state.js';
import {
  filtersFromUrl,
  filtersToApi,
  syncUrl,
  isDefaultFilters,
  DEFAULT_FILTERS,
  SORT_FIELDS,
  viewOf,
} from './filters.js';
import { debounce, el, svg } from './dom.js';
import { iconPaths } from './icons.js';
import { bindShortcuts } from './keys.js';
import { createLatestGate } from './latest.js';
import { createPushChannel } from './push.js';
import { writeText, writeImage, itemIsImage } from './clipboard.js';
import { currentDensity, setDensity, currentTheme, setTheme } from './theme.js';
import { typeLabel, formatRelative, formatSize, charCount } from './format.js';
import { rowMenuItems, sortMenuItems } from './menus.js';
import {
  batchDeleteConfirmSpec,
  clearHistorySpec,
  clipboardFailureHint,
  deleteConfirmSpec,
  describeListError,
} from './messages.js';

import { createAppbar } from './ui/appbar.js';
import { createOverview } from './ui/overview.js';
import { createOmnibox } from './ui/omnibox.js';
import { createFilters } from './ui/filters.js';
import { createBoard } from './ui/board.js';
import { createBatchbar } from './ui/batchbar.js';
import { createPager } from './ui/pager.js';
import { createDrawer } from './ui/drawer.js';
import { createConfirm, createSheet } from './ui/dialog.js';
import { createMenu } from './ui/menu.js';
import { createToasts } from './ui/toast.js';

// 轮询间隔。可见 10s / 隐藏 30s / 推送在线 60s。
// 依据（README 的容量提示）：V1 的 5s 间隔意味着"一个标签开一天"≈17k 请求，接近免费版日额度两成。
// 看历史不需要 5 秒级的新鲜度；而推送连上后 60 秒只是**看门狗**，不是主要更新来源。
const POLL_VISIBLE = 10_000;
const POLL_HIDDEN = 30_000;
const POLL_WATCHDOG = 60_000;

// 广播去抖：批量操作是**逐条广播**的（删 200 条 = 200 次广播），不去抖会让一次批量写
// 连打两百次列表请求。300ms 的尾沿足够把一串广播收敛成一次刷新。
const SIGNAL_DEBOUNCE = 300;

function boot() {
  // 同一文档重复初始化保护：应用若被以 `/ui_v2/app` 与 `/ui_v2/app/` 两个 URL 同时加载，
  // 模块图会出现两份，第二次求值时挂载点已被上一次替换掉（`getElementById` 返回 null）→
  // 半渲染 + 报错。V1 实测拦过这个（docs/ui.md §6.1）。
  if (document.documentElement.dataset.appBooted === '1') return;
  document.documentElement.dataset.appBooted = '1';

  // ===== 挂载点 =====
  const mounts = {
    appbar: document.getElementById('appbar'),
    overview: document.getElementById('overview'),
    notice: document.getElementById('notice'),
    omnibox: document.getElementById('omnibox'),
    filters: document.getElementById('filters'),
    board: document.getElementById('board-area'),
    pager: document.getElementById('pager'),
    batchbar: document.getElementById('batchbar'),
    toasts: document.getElementById('toasts'),
  };

  const toasts = createToasts(mounts.toasts);
  const confirm = createConfirm();
  const menu = createMenu();

  const store = createStore({
    filters: filtersFromUrl(),
    items: [],
    resultsFilterKey: null,
    total: 0,
    stats: null,
    info: null,
    activity: null,
    marker: null,
    clockOffsetMs: null,
    lastSyncMs: null,
    username: null,
    version: null,
    selection: new Map(),
    flashKeys: new Set(),
    loading: true,
    error: null,
    density: currentDensity(),
    theme: currentTheme(),
  });

  const state = () => store.get();

  let pushChannel = null;
  let pollTimer = 0;
  let previewRequest = null;
  let startup = null;
  /** 后台标签里"错过了变更"的旗子：标记被照常推进，但刷新被 visibility 挡住，
   *  回前台时据此补一次。V1 同名（`ui_v1/js/main.js` 的 `missedWhileHidden`）。 */
  let missedWhileHidden = false;
  /** Shift 范围选择的锚点：**最后一次点过的行**（Shift 本身不携带锚点信息）。 */
  let anchorKey = null;
  /**
   * 最后一次**真正生效**的时间范围。
   *
   * 为什么需要它：`<select>` 里的「自定义…」是一个**入口**而不是筛选值（选了它要先去填日期），
   * 所以用户选它的那一刻，下拉框必须退回这个值 —— 否则控件显示"自定义"而列表根本没筛，
   * 用户会以为自己已经筛过了（实测踩过，用户也报告了）。
   */
  let lastAppliedRange = state().filters.range;

  // ===== 三个独立的竞态守卫 =====
  // 列表与概览各有一次往返，互相之间没有依赖 —— 共用一个守卫会让概览请求把列表请求 abort 掉。
  const listGate = createLatestGate();
  const overviewGate = createLatestGate();
  const pollGate = createLatestGate();

  // ===== 组件 =====
  const appbar = createAppbar({
    onToggleTheme: () => {
      store.patch({ theme: setTheme(state().theme === 'dark' ? 'light' : 'dark') });
      render();
    },
    onLogout: logout,
    onOpenDrawer: () => drawer.open(),
    onFocusSearch: () => omnibox.focus(),
    // 窄屏的刷新入口（宽屏由筛选条里那个按钮承担 —— ≤720px 时它被隐藏，
    // 而抽屉里没有替身；见 `ui/appbar.js` 的说明）
    onRefresh: () => void refresh({ announce: true }),
  });

  const overview = createOverview({ onOpenDrawer: () => drawer.open() });

  const omnibox = createOmnibox({
    // 搜索走 replace 而不是 push：不要为每个字都塞一条历史记录
    onSearch: (value) => setFilters({ search: value, page: 1 }),
  });

  const filtersBar = createFilters({
    onTypes: (types) => setFilters({ types, page: 1 }, { push: true, scroll: true }),
    onToggleStarred: () => setFilters({ starred: !state().filters.starred, page: 1 }, { push: true, scroll: true }),
    // 回收站是范围切换：选择集由 `setFilters` 统一清（`deleted` 在 `MEMBERSHIP_KEYS` 里，
    // 见下），这里不再各清一份 —— 两处同一件事必然漂移（F3）。
    onToggleDeleted: () => {
      setFilters({ deleted: !state().filters.deleted, page: 1 }, { push: true, scroll: true });
    },
    onRange: (range) => {
      if (range === 'custom') {
        // 「自定义…」不是一个筛选值，而是一个**入口**：打开抽屉让用户填日期。
        //
        // 这里必须把下拉框**退回上一个有效值**：`<select>` 被用户改成了 `custom`，
        // 若就这么留着，界面会显示"自定义"而列表其实一条都没筛（服务端按 `after=null` 处理）
        // —— 用户以为筛过了，于是对着没筛过的列表找东西（实测踩过，用户也报告了）。
        // 只有在抽屉里真的点了「应用」并且填了日期时，`range` 才会变成 `custom`。
        filtersBar.updateRangeValue(lastAppliedRange);
        drawer.open();
        drawer.focusRange();
        return;
      }
      lastAppliedRange = range;
      setFilters({ range, after: null, before: null, page: 1 }, { push: true, scroll: true });
    },
    onRefresh: () => refresh({ announce: true }),
    onClearFilters: resetFilters,
    onOpenDrawer: () => drawer.open(),
    isDefault: () => isDefaultFilters(state().filters),
  });

  const board = createBoard({
    onSelect: onSelectRow,
    onSelectAll: (checked) => {
      const selection = new Map(state().selection);
      for (const item of state().items) {
        if (checked) selection.set(item.key, item);
        else selection.delete(item.key);
      }
      store.patch({ selection });
      board.syncSelection(selection, state().items);
      renderChrome();
    },
    onOpen: (item) => void openPreview(item),
    onCopy: copyItem,
    onDownload: downloadItem,
    onStar: (item, next) => toggleFlag(item, 'starred', next),
    // 回收站视图里行的**主操作**（`rowops.js` 按 `item.isDeleted` 决定），
    // 与 `⋯` 菜单里的「恢复到历史记录」走同一个实现
    onRestore: restoreItem,
    onMenu: openRowMenu,
    onSortMenu: openSortMenu,
    onToggleOrder: () => {
      const { filters } = state();
      setFilters({ order: filters.order === 'desc' ? 'asc' : 'desc', page: 1 }, { push: true, scroll: true });
    },
    onPageSize: (pageSize) => setFilters({ pageSize, page: 1 }, { push: true, scroll: true }),
    // 紧凑模式：**只影响这一屏的行高**，不进筛选状态（它不该被写进 URL ——
    // 分享一条链接时不该把对方的行高也改掉；它是显示偏好，跟着 localStorage 走）。
    //
    // 下一个值由**这里**算，不由按钮算：`theme-init.js` 会在首帧前从 localStorage 恢复
    // 用户上次的选择，所以"当前是紧凑还是宽松"的唯一事实源是 store（它在启动时由
    // `currentDensity()` 读了一次真实状态），而不是组件自己记的一个初值。
    onDensity: () => {
      const next = state().density === 'compact' ? 'comfortable' : 'compact';
      setDensity(next);
      store.patch({ density: next });
      renderChrome();
    },
    onClearFilters: resetFilters,
    onExitTrash: () => setFilters({ deleted: false, page: 1 }, { push: true, scroll: true }),
    onOpenDrawer: () => drawer.open(),
    onRetry: () => state().username ? refresh({ announce: true }) : start(),
  });

  const batchbar = createBatchbar({ onClose: clearSelection, onAction: batchAction });

  const pager = createPager({
    onPage: (page) => setFilters({ page: Math.max(1, page) }, { push: true, scroll: true }),
  });

  const drawer = createDrawer({
    onSetPageSize: (pageSize) => setFilters({ pageSize, page: 1 }, { push: true }),
    onSort: (sort, order) => setFilters({ sort, order, page: 1 }, { push: true, scroll: true }),
    onCustomRange: (after, before) =>
      setFilters({ range: 'custom', after, before, page: 1 }, { push: true, scroll: true }),
    onSaveSettings: async (patch) => {
      try {
        await api.updateSettings(patch);
        toasts.ok('保留策略已更新');
        await refreshInfo();
        return true;
      } catch (error) {
        if (handleAuthError(error)) return false;
        toasts.error(`保存失败：${error.message}`);
        return false;
      }
    },
    onCheckIntegrity: async () => {
      try {
        return await api.integrity();
      } catch (error) {
        if (handleAuthError(error)) return null;
        toasts.error(`检查失败：${error.message}`);
        return null;
      }
    },
    onClear: clearHistory,
    onCopyServerUrl: async (url) => {
      const ok = await writeText(url);
      if (ok) toasts.ok('服务器地址已复制');
      else toasts.error(clipboardFailureHint(window.isSecureContext, '服务器地址就在抽屉的「部署信息」里，可手动选中复制。'));
      return ok;
    },
  });

  const sheet = createSheet({
    onClose: () => {
      previewRequest?.abort();
      previewRequest = null;
      // 关闭预览时清掉 hash，否则刷新页面会突然弹出上一次看过的记录。
      // 用 `replaceState` 而不是 `location.hash = ''`：后者会留下历史记录、也会触发 `hashchange`。
      if (/^#[A-Za-z]+-.+$/.test(location.hash)) {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
      }
    },
  });

  // 挂载：概览带与批量条是 `<button>` / `<div>` 占位，用 `replaceWith` 换成真实节点
  mounts.appbar.append(appbar.el);
  mounts.overview.replaceWith(overview.el);
  mounts.omnibox.append(omnibox.el);
  mounts.filters.append(filtersBar.el);
  mounts.board.append(board.el);
  mounts.pager.append(pager.el);
  mounts.batchbar.replaceWith(batchbar.el);

  // ===== 渲染 =====

  /**
   * 列表要的那一份 spec。`render()` 与"首屏骨架"共用同一处定义 ——
   * 两处各写一遍字段正是"加了字段忘改另一边"的来源。
   */
  function boardSpec(current, override = {}) {
    return {
      items: current.items,
      total: current.total,
      filters: current.filters,
      selection: current.selection,
      flashKeys: current.flashKeys,
      state: boardState(current),
      error: current.error,
      busy: current.loading,
      density: current.density,
      ...override,
    };
  }

  /** 全量绘制（列表也重画）。用于换页/换筛选/首屏。 */
  function render() {
    renderChrome();

    const current = state();
    board.update(boardSpec(current));
    pager.update({
      page: current.filters.page,
      pageSize: current.filters.pageSize,
      total: current.total,
      // 分页也要能区分「还没到」与「真的没有」（见 ui/pager.js）
      loading: current.loading,
    });
  }

  /**
   * 只画**列表之外**的部分（顶栏、概览带、筛选条、批量条、分页）。
   *
   * 为什么不复用 `render()`：行内开关（收藏/置顶）成功后要保留 DOM ——
   * 重画列表会把"正在显示对勾的那个按钮"连同行一起换掉，用户在动画中途看到的是新节点，
   * 反馈就断了。这一层只关心"哪些数字变了"。
   */
  function renderChrome() {
    const current = state();
    appbar.update({
      username: current.username,
      version: current.version,
      theme: current.theme,
      pushState: pushChannel?.state ?? 'offline',
      lastSyncMs: current.lastSyncMs,
      now: Date.now(),
    });

    overview.update({
      // 概览带的主数字给**活跃**记录数（= 当前视图口径，与列表的"共 N 条"一致），
      // 而不是 `totalCount`（那个含回收站里的已删除行）。两者都从同一次
      // `/ui/api/overview` 的响应里取，所以不会出现"数字与列表差一条"。
      total: current.stats?.activeCount ?? null,
      deletedCount: current.stats?.deletedCount ?? null,
      sizeBytes: current.info?.storage?.totalBytes ?? null,
      lastSyncMs: current.lastSyncMs,
      activity: current.activity,
    });

    omnibox.setValue(current.filters.search);
    omnibox.setBusy(current.loading);
    filtersBar.update({
      filters: current.filters,
      counts: countsForView(current),
      // 「全部」上的数字用**当前视图**的总数：
      // 活跃视图 = `activeCount`，回收站视图 = `deletedCount`。用 `totalCount`（含已删除）
      // 会让「全部」上的数字比它下面列表的总数大（实测截图里就是 2191 vs 1009）。
      total: current.filters.deleted
        ? current.stats?.deletedCount
        : current.stats?.activeCount,
      busy: current.loading,
    });
    batchbar.update({ selection: current.selection, deleted: current.filters.deleted });
    pager.update({
      page: current.filters.page,
      pageSize: current.filters.pageSize,
      total: current.total,
      loading: current.loading,
    });

    // 列表**头**也要在这里刷（只刷头，不碰行 —— 行由 `render()` 的对账负责）。
    // 少了这一句，只改"显示偏好"的操作（紧凑模式）会**生效但不更新反馈**：
    // 行高变了（CSS 变量切换）、`localStorage` 也写了，但开关自己的样子永远不变。
    // 实测踩过这个坑，见 `board.js` 的 `updateChrome` 注释。
    board.updateChrome({ filters: current.filters, density: current.density });

    // 抽屉的内容也在这里刷：它读的是同一份 state（概览、活动、保留策略、清理状态），
    // 而 `update()` 只是重填已有的 DOM 节点 —— 抽屉没打开时这次调用是几毫秒的空转，
    // 换来的是"打开就能看到最新值"，不必在打开的那一刻再补一次数据。
    drawer.update({
      info: current.info,
      activity: current.activity,
      filters: current.filters,
      density: current.density,
      clockOffsetMs: current.clockOffsetMs,
    });
  }

  function boardState(current) {
    if (current.error && current.items.length === 0) return 'error';
    if (current.loading && current.items.length === 0) return 'loading';
    if (current.items.length === 0) return 'empty';
    return 'ready';
  }

  /**
   * 类型计数必须与**当前视图**同源。
   *
   * `state.stats.view` 记录这份计数是为哪个视图取的。守卫放在**绘制点**而不是只放在取数点 ——
   * 重绘可能来自任何路径（列表刷新、轮询、动作后的静默刷新），只守 fetch 挡不住
   * "迟到的响应 + 之后的一次渲染"这种组合。不一致时按"暂无计数"处理（不显示数字），
   * 而不是显示另一个视图的数字 —— 显示错的数字比不显示更糟。
   */
  function countsForView(current) {
    const view = viewOf(current.filters);
    return current.stats && current.stats.view === view ? current.stats.byType : undefined;
  }

  // ===== 选择 =====

  function onSelectRow(item, checked, event) {
    const selection = new Map(state().selection);

    // Shift+点击：整段选中（锚点与目标之间的全部行）
    if (event?.shiftKey && anchorKey && anchorKey !== item.key) {
      const keys = state().items.map((i) => i.key);
      const from = keys.indexOf(anchorKey);
      const to = keys.indexOf(item.key);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        for (let i = lo; i <= hi; i += 1) {
          const target = state().items[i];
          if (checked) selection.set(target.key, target);
          else selection.delete(target.key);
        }
      }
    } else if (checked) {
      selection.set(item.key, item);
    } else {
      selection.delete(item.key);
    }
    anchorKey = item.key;

    store.patch({ selection });
    // 就地同步复选框（不重画列表 —— 重画会让用户刚按住 Shift 的那一行失去焦点）
    board.syncSelection(selection, state().items);
    renderChrome();
  }

  function clearSelection() {
    store.patch({ selection: new Map() });
    board.syncSelection(new Map(), state().items);
    renderChrome();
  }

  // ===== 筛选 =====

  // 哪些筛选字段会**改变结果集的成员资格**（F3）：变了它们，选择集里的旧快照可能已不在
  // 新结果里，而批量删除/收藏仍按选择集逐条在服务端执行 —— 那等于对"看不见的行"动手。
  // 排序 / 翻页 / 页大小 / 搜索**不在列**：它们不改变集合（搜索只是高亮过滤）。
  const MEMBERSHIP_KEYS = ['types', 'starred', 'deleted', 'range', 'after', 'before'];

  function setFilters(patch, { push = false, scroll = false } = {}) {
    const before = state().filters;
    const next = { ...before, ...patch };
    const viewChanged = Boolean(next.deleted) !== Boolean(before.deleted);

    // 成员资格变了就清选择集（F3）：残留的旧快照会让批量动作落到当前筛选看不见的行上。
    if (MEMBERSHIP_KEYS.some((key) => patch[key] !== undefined)) {
      store.patch({ selection: new Map() });
      board.syncSelection(store.get().selection, state().items);
    }

    store.patch({ filters: next });
    if (patch.search !== undefined) omnibox.setValue(next.search, { force: true });
    syncUrl(next, { push });

    // 时间范围只有**真的生效**时才记进 `lastAppliedRange`（见它的声明处）：
    // 抽屉里点了「应用」→ `range` 变成 `custom`，那才是"生效过的自定义范围"。
    if (patch.range !== undefined) lastAppliedRange = next.range;

    // 立刻把**筛选控件**画成新状态，不等响应：store 不触发绘制，而 `render()` 只在
    // refresh 落地后跑 —— 于是从点击到响应这段时间里被点的那一段毫无变化（真实网络上是
    // 几百毫秒的"点下去没反应"，响应一到整块换掉，读起来正是卡顿）。
    renderChrome();

    // 结果区在首屏之外时，换页/改筛选要把它带回视野，否则"点了下一页"只换了脚下看不见的内容
    void refresh().finally(() => {
      if (scroll) scrollToResults();
    });

    // 切视图（活跃 ↔ 回收站）时类型计数是**另一套**，必须重取
    if (viewChanged) void refreshOverview();
  }

  function resetFilters({ keepView = false } = {}) {
    store.patch({ selection: new Map() });
    setFilters({ ...DEFAULT_FILTERS, deleted: keepView && state().filters.deleted }, { push: true, scroll: true });
  }

  function scrollToResults() {
    const headerHeight =
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--appbar-h')) || 56;
    const box = mounts.board;
    if (!box) return;
    if (box.getBoundingClientRect().top >= headerHeight) return; // 已经在视野里
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }

  // ===== 取数 =====

  async function refresh({ silent = false, flash = false, announce = false } = {}) {
    const current = state();
    const previousKeys = new Set(current.items.map((item) => item.key));
    const ticket = listGate.begin();

    if (!silent) store.patch({ loading: true });
    renderChrome();

    try {
      const page = await api.list(filtersToApi(current.filters), ticket.signal);
      // 已有更新的请求在飞：这次的结果作废，**绝不能**写回 store
      // （写回就是"列表显示的内容与筛选控件不一致"）
      if (!listGate.isCurrent(ticket)) return;

      // 越界页码兜底（2026-09-16 修）：`?page=999999` 这种可以分享/手改的链接会让服务端
      // 返回 `total` + **空列表**，而界面会把它渲染成"还没有任何剪贴板记录" ——
      // 记录明明有 1009 条，解释却是错的，而且空状态里那个按钮（清除筛选）连 page 都不重置，
      // 点了没反应。判据取"这一页为空、但总数不为零、且页码确实越界"，夹回最后一页重发一次。
      const lastPage = Math.max(1, Math.ceil((page.total ?? 0) / current.filters.pageSize));
      if (page.items.length === 0 && (page.total ?? 0) > 0 && current.filters.page > lastPage) {
        // `push: false`：这是界面的**自我修正**，不该进浏览器的后退历史 ——
        // 用 push 的话，打开 `?page=999` 会多压一条记录，用户按后退又回到越界页、再自校正一次，
        // 形成后退循环。V1 在同一处写着"用 replace 而不是 push"（`docs/AUDIT-v1-v2-divergence.md` §1.2）。
        setFilters({ page: lastPage }, { push: false });
        return;
      }

      const flashKeys = flash
        ? new Set(page.items.filter((item) => !previousKeys.has(item.key)).map((item) => item.key))
        : new Set();

      setStale(false);
      store.patch({
        items: page.items, total: page.total, flashKeys, loading: false, error: null,
        resultsFilterKey: JSON.stringify(current.filters),
      });
      render();

      if (announce) toasts.ok(`已刷新，共 ${page.total} 条记录`);
    } catch (error) {
      if (ticket.signal.aborted) return; // 被更新的请求 abort 掉不是失败
      if (!listGate.isCurrent(ticket)) return;
      if (handleAuthError(error)) return;
      // **只有连不上/服务端出错**才算"失去联系"（2026-09-16 修）。
      // 原来任何非 2xx 都会点亮那条横幅：搜索词超过 48 字节触发的 400 会让用户看到
      // "与服务器暂时失去联系，页面上的内容可能不是最新的" —— 服务器好好的，
      // 那条横幅把"你的搜索词太长"说成了网络问题，用户会去重启服务（实测抓到）。
      if (!(error instanceof ApiError) || error.status >= 500) setStale(true);
      const differentQuery = state().resultsFilterKey !== JSON.stringify(current.filters);
      store.patch({
        loading: false,
        error: describeListError(error, current.filters.search),
        ...(differentQuery ? { items: [], total: 0 } : {}),
      });
      render();
      // 已有内容时保留旧数据只给一条提示（比清空更正确）；首屏失败由 board 的错误态承担
      if (state().items.length > 0) toasts.error(describeListError(error, current.filters.search));
    }
  }

  /** 概览（合并端点）：统计 + 部署信息 + 变更标记 + 服务端时间 + 活动趋势。 */
  async function refreshOverview() {
    const ticket = overviewGate.begin();
    const view = viewOf(state().filters);
    try {
      const data = await api.overview(ticket.signal, { deleted: state().filters.deleted });
      if (!overviewGate.isCurrent(ticket)) return;

      // 服务端时间与本机的差：官方客户端在 |差| > 5 分钟时**中止历史同步**，
      // 而这是"同步不动"最常见的根因之一 —— 此前界面上任何地方都看不到它。
      const skew = data.serverTime ? Date.now() - Date.parse(data.serverTime) : state().clockOffsetMs;

      store.patch({
        stats: {
          ...(data.stats ?? {}),
          byType: data.byType ?? null,
          // `view` 是这份计数的**归属标记**，绘制时用它判断能不能显示（见 countsForView）
          view,
        },
        info: data.info ?? state().info,
        marker: data.marker ?? state().marker,
        // 这里**不设** `activity`：`/ui/api/overview` 的响应里没有这个键（返回的是
        // stats/byType/byTypeActive/marker/info/serverTime），原先那句
        // `data.activity ?? state().activity` 是一次恒为 undefined 的死读取。
        // 活动数据由列表落地后的那次独立请求写入（见本文件的 fetchActivity）。
        clockOffsetMs: skew,
        version: data.info?.version ?? state().version,
        lastSyncMs: markerToMs(data.marker) ?? state().lastSyncMs,
      });
      renderChrome();
    } catch (error) {
      if (ticket.signal.aborted) return;
      if (handleAuthError(error)) return;
      setStale(true);
    }
  }

  /** 单独的 info 刷新（保存保留策略之后要回读生效值）。返回是否回读成功。 */
  async function refreshInfo() {
    try {
      store.patch({ info: await api.info() });
      renderChrome();
      return true;
    } catch (error) {
      if (handleAuthError(error)) return false;
      // info 是诊断面，平时失败不该影响主流程（那正是它静默的理由）。
      // 但**保存之后**的回读失败必须说出来：否则用户看到的是保存前的旧值，
      // 无法判断是自己没点成功还是界面没刷新。
      toasts.error('设置已保存，但没能回读最新值，这里显示的数字可能不是最新的');
      return false;
    }
  }

  /** 活动趋势。失败时静默 —— 它只影响概览带上的那张缩略图。 */
  async function refreshActivity() {
    try {
      const data = await api.activity(undefined, { days: 14 });
      store.patch({ activity: data.days ?? [] });
      renderChrome();
    } catch {
      /* 静默：趋势图缺失不影响任何操作 */
    }
  }

  function markerToMs(marker) {
    const value = Number(marker?.lastModified);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // ===== 轮询 =====

  function schedulePoll() {
    clearTimeout(pollTimer);
    const hidden = document.visibilityState === 'hidden';
    const interval = hidden ? POLL_HIDDEN : pushChannel?.state === 'live' ? POLL_WATCHDOG : POLL_VISIBLE;
    pollTimer = setTimeout(() => void pollOnce(), interval);
  }

  async function pollOnce() {
    const ticket = pollGate.begin();
    try {
      const data = await api.poll(ticket.signal);
      if (!pollGate.isCurrent(ticket)) return;
      setStale(false);

      if (data.serverTime) store.patch({ clockOffsetMs: Date.now() - Date.parse(data.serverTime) });

      const previous = state().marker;
      const unchanged =
        previous && previous.count === data.count && previous.lastModified === data.lastModified;

      if (!unchanged) {
        // 变更标记变了：说明别处写了数据。**可见时**整页刷新 + 给新行闪一次；
        // 后台标签只把"错过"记下来，回前台再补 —— 隐藏页的整页刷新会被浏览器节流白跑，
        // 而标记已推进，回前台那一刻比较结果是"没变"，列表就停在离开时的样子（F1）。
        store.patch({ marker: { count: data.count, lastModified: data.lastModified } });
        if (document.visibilityState === 'visible') {
          void refresh({ silent: true, flash: true });
          void refreshOverview();
        } else {
          missedWhileHidden = true;
        }
        return;
      }

      // 标记没变：只更新"最近同步"的显示，不重拉列表（省一次 D1 读 + 一次渲染）
      if (data.lastModified) store.patch({ lastSyncMs: Number(data.lastModified) });
      renderChrome();
    } catch (error) {
      if (ticket.signal.aborted) return;
      if (handleAuthError(error)) return;
      // 轮询失败是**静默**的（没有 UI 事件），不给它提示条 ——
      // 每 10 秒飘一次的提示条比"暂时没更新"更烦人。失联横幅承担这件事。
      setStale(true);
    } finally {
      schedulePoll();
    }
  }

  /**
   * 失联横幅：它描述的是一个**持续状态**，比一闪而过的提示条更合适。
   * 成功的那次请求把它收掉。
   */
  function setStale(stale) {
    if (!mounts.notice) return;
    mounts.notice.hidden = !stale;
    mounts.notice.textContent = stale
      ? '与服务器暂时失去联系，页面上的内容可能不是最新的；恢复后会自动刷新。'
      : '';
  }

  // ===== 单项操作 =====

  /**
   * PATCH 的响应是服务端归一化后的**新条目**（带新 `version` / `lastModified`）。
   * 采纳它而不是只在本地改一个字段：服务端算出的版本是后续写操作的判定依据，
   * 本地不采纳就会在下一次操作里发出过期的版本。
   *
   * 只取元数据字段 —— 响应里的 `text` 是**未截断**的全文，整行状态不该被它撑大
   * （那会让一个 50 行的列表在内存里变成几 MB）。
   */
  const PATCH_META_FIELDS = ['starred', 'pinned', 'isDeleted', 'version', 'lastModified', 'lastAccessed'];

  function adoptPatch(item, updated) {
    if (!updated) return item;
    const next = { ...item };
    for (const field of PATCH_META_FIELDS) {
      if (updated[field] !== undefined) next[field] = updated[field];
    }
    return next;
  }

  async function toggleFlag(item, field, value) {
    try {
      const updated = await api.patch(item, { [field]: value });
      const next = adoptPatch(item, updated);
      store.patch({ items: state().items.map((i) => (i.key === item.key ? next : i)) });
      // 就地更新那一行（不重拉整页），并按方向播一次动画
      board.patchItem(next, { pop: field === 'starred' ? 'star' : null });
      // 这一行若在选择集里，选择集里那份也要换成新对象（F5）：批量条的方向与文案
      // （置顶/取消置顶、收藏/取消收藏）读的正是选择集里的对象 —— 只更新列表而不更新它，
      // 批量操作会按**旧快照**算方向（"已置顶的记录选择条还说置顶"）。V1 `main.js:538-544` 同源。
      const selection = state().selection;
      if (selection.has(next.key)) {
        const synced = new Map(selection);
        synced.set(next.key, next);
        store.patch({ selection: synced });
        board.syncSelection(synced, state().items);
      }
      // 位置/成员资格变了的两种情形立刻对账（与 V1 同一条判据，见 `public/ui_v1/js/main.js`）：
      // 置顶会把它挪到列表最前（`src/ui/query.ts` 的 pinnedFirst），「仅收藏」开着时取消收藏
      // 会让它不再符合筛选 —— 不立刻对齐就是"按完没反应，十秒后它自己跳走"。
      // `board` 在重排时会 captureFocus/restoreFocus，故焦点不会掉到 <body>。
      if (field === 'pinned' || state().filters.starred) void refresh({ silent: true });
      void refreshOverview();
      return true;
    } catch (error) {
      if (handleAuthError(error)) return false;
      toasts.error(error.status === 409 ? '记录已被其他设备修改，请刷新后重试' : `操作失败：${error.message}`);
      return false;
    }
  }

  async function deleteItem(item) {
    // 文案口径在 `messages.js` 的 `deleteConfirmSpec`（那里写了为什么两种记录必须分开说）。
    const ok = await confirm.ask({
      ...deleteConfirmSpec(item),
      // 删除在对话框内完成：请求期间按钮转圈，失败留在原地显示原因（不必重新确认一遍）
      action: async () => {
        await api.patch(item, { isDelete: true });
      },
    });
    if (!ok) return false;

    const selection = new Map(state().selection);
    selection.delete(item.key);
    store.patch({ items: state().items.filter((i) => i.key !== item.key), selection });
    // 就地收掉这一行（等下一次整页刷新才消失会读成"点了没反应"）
    // 第二个参数是**邻居行里要找的那个图标名**，不是动作名：删除的发起控件是 `⋯` 菜单，
    // 而行的图标集只有 undo/copy/download/star/dots（见 ui/board.js 的 neighborButton）。
    board.removeItem(item, 'dots');
    renderChrome();

    // 静默刷新补齐：删掉一行后当前页会缺一条，下一页的第一条应该顶上来
    void refresh({ silent: true });
    void refreshOverview();
    return true;
  }

  async function restoreItem(item) {
    // 已删除且**有数据文件**的记录不能恢复：软删时数据文件已清除，
    // 服务端会返回 404（`db.ts` 的守卫）。列表侧已禁用按钮并给出原因，
    // 这里再判一次是防御（批量路径也会走到）。
    if (item.hasData) {
      toasts.error('这条记录的数据文件在删除时已清除，无法恢复');
      return false;
    }
    try {
      await api.patch(item, { isDelete: false });
      store.patch({ items: state().items.filter((i) => i.key !== item.key) });
      // 同上：恢复的发起控件是行内的「恢复」（图标名就是 `undo`）
      board.removeItem(item, 'undo');
      renderChrome();
      void refresh({ silent: true });
      void refreshOverview();
      return true;
    } catch (error) {
      if (handleAuthError(error)) return false;
      toasts.error(`恢复失败：${error.message}`);
      return false;
    }
  }

  // ===== 剪贴板与下载 =====

  /**
   * 列表里的正文是**截断过的**：要复制全文必须先取单条，
   * 否则用户拿到的是被砍掉一半的剪贴板内容。
   */
  async function fetchFull(item) {
    try {
      return await readFullText(item);
    } catch (error) {
      if (handleAuthError(error)) return null;
      toasts.error(`取全文失败：${error.message}`);
      return null;
    }
  }

  async function readFullText(item, signal) {
    const full = item.textTruncated ? await api.get(item, signal) : item;
    if (full.type === 'Text' && full.hasData && !full.textLoaded) {
      const text = await api.textData(full, signal);
      return { ...full, text, textTruncated: false, textLoaded: true };
    }
    return full;
  }

  async function copyItem(item) {
    const full = await fetchFull(item);
    if (!full) return false;
    const ok = await writeText(full.text ?? '');
    if (ok) {
      toasts.ok(`已复制 ${charCount(full.text)} 个字符`);
      return true;
    }

    // 失败时**必须说清"为什么"并给出一条走得到的退路**。
    // 原来说的是"浏览器拒绝了剪贴板访问，请打开预览手动复制"，两个问题：
    //   ① 没说什么叫"拒绝" —— 真实原因只有一个：不是安全上下文（站点跑在 http 上，
    //      而不是 https / localhost）。用户不知道这一点就只能反复点；
    //   ② 没给出口 —— "打开预览"是哪个按钮？用户得自己去找。
    // 现在：原因说清 + **直接替用户打开预览**（既然只有这一条退路，就别让他自己找）。
    // 预览里本来就有一个「复制内容」按钮，它在 https 与 http 下**都**能用：它是把文本
    // 呈现出来让用户用系统快捷键/右键复制，不依赖 Clipboard API。
    const hasText = Boolean(full.text);
    toasts.error(
      clipboardFailureHint(window.isSecureContext, hasText ? '已在预览里打开内容，选中后按 Ctrl/Cmd+C 复制。' : '这条记录没有可取回的正文。'),
    );
    if (hasText) void openPreview(full);
    return false;
  }

  async function copyImage(item) {
    if (!item.hasData) {
      toasts.error('这条记录的数据文件已被清除，无法复制');
      return false;
    }
    try {
      // 走 `api` 层而不是裸 `fetch`：带超时、可取消、401 会跳登录（见 `api.blobData` 的说明）。
      // 裸 fetch 在"网络半开"时会永不 settle，而本按钮走 `setPending`（disabled）⇒ 永久转圈。
      const result = await writeImage(await api.blobData(item));
      if (result.status === 'ok') {
        toasts.ok('图片已复制到剪贴板');
        return true;
      }
      if (result.status === 'unsupported') {
        toasts.error('当前环境不支持写图片到剪贴板（需要 https + 较新的浏览器），可改用预览后保存');
        return false;
      }
      toasts.error(`复制图片失败：${result.reason ?? '未知原因'}`);
      return false;
    } catch (error) {
      if (handleAuthError(error)) return false;
      if (error instanceof ApiError && error.status === 404) {
        toasts.error('数据文件不在了（可能已被清理任务删除）');
        return false;
      }
      toasts.error(`复制图片失败：${error.message}`);
      return false;
    }
  }

  /** 下载：直接触发浏览器下载（同源 Cookie 自动带上），不做 fetch —— 省一次内存拷贝。 */
  async function downloadItem(item) {
    const link = el('a', { href: api.dataUrl(item, { download: true }), rel: 'noopener' });
    document.body.append(link);
    link.click();
    link.remove();
    return true;
  }

  // ===== 预览 =====

  async function openPreview(item) {
    if (sheet.isOpen) return;
    // 打开预览时把这一条写进 hash（链接可分享）。关闭时由 sheet 的 onClose 清掉。
    if (item?.type && item?.hash) {
      history.replaceState(null, '', `${location.pathname}${location.search}#${item.type}-${item.hash}`);
    }

    // 有数据文件的（图片/文件/组合）：直接给 `<img>`，不走 fetch（预览要看全，不裁切）
    //
    // ⚠️ 但**文本记录也可能带数据文件**（线上真有：11000 字节的 `Text_….txt`）。
    // 那种记录必须走文本分支：否则"复制失败 → 已替你打开预览"这条路会把用户送到一个
    // 只会渲染 `<img src=….txt>`（必然加载失败）且只提供「下载/复制图片」的对话框里，
    // 正文在界面上**永远看不到**、也复制不出来（2026-09-16 实测抓到）。
    const hasText = item.type === 'Text';
    if (item.dataName && !hasText) {
      openMediaPreview(item);
      return;
    }

    previewRequest?.abort();
    const controller = new AbortController();
    previewRequest = controller;
    let full = null;
    const load = async () => {
      sheet.updateContent(el('p', { class: 'note', role: 'status', text: '正在读取完整内容…' }));
      try {
        const result = await readFullText(item, controller.signal);
        if (controller.signal.aborted || !sheet.isOpen) return;
        full = result;
        sheet.updateContent(
          el('pre', { class: 'readout', tabindex: '0', text: full.text ?? '' }),
          `${charCount(full.text)} 个字符 · ${formatRelative(full.lastAccessed ?? full.createTime)}`,
        );
      } catch (error) {
        if (controller.signal.aborted || handleAuthError(error)) return;
        sheet.updateContent(el('div', {}, [
          el('p', { class: 'note', role: 'alert', text: `无法读取正文：${error.message}` }),
          el('button', { class: 'btn', type: 'button', text: '重新加载', onclick: () => void load() }),
        ]));
      }
    };
    void sheet.open({
      title: '文本记录',
      sub: item.hash.slice(0, 12),
      content: el('p', { class: 'note', role: 'status', text: '正在读取完整内容…' }),
      actions: [
        {
          label: '复制内容',
          icon: 'copy',
          primary: true,
          run: async () => {
            if (!full) {
              toasts.error('正文尚未加载完成，请稍后重试。');
              return false;
            }
            return copyItem(full);
          },
        },
        ...(item.hasData ? [{ label: '下载原文', icon: 'download', run: () => downloadItem(item) }] : []),
      ],
    });
    await load();
  }

  function openMediaPreview(item) {
    const figure = el('div', { class: 'figure' });
    const isImage = itemIsImage(item);
    if (!item.hasData) {
      // `hasData` 是**元数据推导**，不代表 R2 里真的在 —— 线上真有这种记录
      // （数据被已修复的孤儿清理事故误删过）。故这里与"记录不存在"分开：
      // 记录在、数据不在，文案要说清这一点。
      figure.setAttribute('data-missing', '');
      figure.textContent = '这条记录的元数据说有数据，但服务器上找不到对应文件（可能已被清理）。';
    } else if (isImage) {
      const img = el('img', { src: api.dataUrl(item), alt: item.dataName ?? '记录数据' });
      img.addEventListener('error', () => {
        figure.setAttribute('data-missing', '');
        img.remove();
        figure.textContent = '数据文件无法加载（可能已被清理任务删除）。';
      });
      figure.append(img);
    } else {
      figure.append(el('div', { class: 'file-preview' }, [
        svg(iconPaths('file'), { size: 40 }),
        el('p', { class: 'file-preview__name', text: item.dataName ?? item.text ?? '文件' }),
        el('p', { class: 'file-preview__detail', text: `${typeLabel(item.type)} · ${formatSize(item.size)}` }),
        el('p', { class: 'file-preview__detail', text: '下载到设备后，使用对应的应用打开。' }),
      ]));
    }

    const actions = item.hasData
      ? [{ label: '下载', icon: 'download', primary: true, run: async () => downloadItem(item) }]
      : [];
    // 位图可以复制到系统剪贴板；SVG 之类不行（`itemIsImage` 已排除 svg）
    if (item.hasData && isImage) {
      actions.unshift({ label: '复制图片', icon: 'copy', run: async () => copyImage(item) });
    }

    void sheet.open({
      title: item.dataName ?? typeLabel(item.type),
      sub: `${typeLabel(item.type)} · ${formatRelative(item.lastAccessed ?? item.createTime)}`,
      content: figure,
      actions,
    });
  }

  // ===== 菜单 =====

  /** 行的 `⋯` 菜单。项的构造在 `menus.js`（纯函数，可断言），这里只提供回调与开菜单。 */
  function openRowMenu(item, anchor) {
    const items = rowMenuItems(item, {
      onPreview: (target) => void openPreview(target),
      onCopy: (target) => void copyItem(target),
      onDownload: (target) => void downloadItem(target),
      onRestore: (target) => void restoreItem(target),
      onTogglePin: (target) => void toggleFlag(target, 'pinned', !target.pinned),
      onDelete: (target) => void deleteItem(target),
    });
    void menu.open({ anchor, items });
  }

  function openSortMenu(anchor) {
    const items = sortMenuItems(state().filters, SORT_FIELDS, (patch) =>
      setFilters(patch, { push: true, scroll: true }),
    );
    void menu.open({ anchor, items });
  }

  // ===== 批量操作 =====

  async function batchAction(name, items) {
    if (items.length === 0) return false;

    if (name === 'delete') {
      // 服务端的返回值必须**接出来**：`confirm.ask` 的 `action` 只关心成败，而批量写会回
      // `{ updated, failed }`（`src/ui/routes.ts`）。此前这个分支完全不读它，直接报
      // 「已删除 N 条」⇒ 部分失败被报成**全成功**（某条已被别处删除/恢复时就会发生）。
      // 同文件的通用分支（下面 star/pin/restore 那一段）一直读了它，V1 的 `runBatch` 更会在
      // `failed` 非零时直接抛错 —— 只有这里漏了。见 `docs/AUDIT-v1-v2-divergence.md` §7.1。
      let outcome = null;
      const ok = await confirm.ask({
        ...batchDeleteConfirmSpec(items.length),
        action: async () => {
          outcome = await api.batchUpdate(items, { isDelete: true });
        },
      });
      if (!ok) return false;
      clearSelection();
      await refresh({ silent: true });
      void refreshOverview();
      const failed = Number(outcome?.failed) || 0;
      if (failed > 0) {
        toasts.info(`已删除 ${outcome.updated} 条，${failed} 条未生效（可能已被别处改过）`);
      } else {
        toasts.ok(`已删除 ${items.length} 条`);
      }
      return true;
    }

    if (name === 'download') {
      // 批量下载 = 逐条触发浏览器下载。浏览器会对同源连续下载做节流，
      // 不加间隔的话多数浏览器只保存前几个。
      const targets = items.filter((item) => item.type !== 'Text');
      for (let i = 0; i < targets.length; i += 1) {
        void downloadItem(targets[i]);
        if (i < targets.length - 1) await sleep(250);
      }
      toasts.ok(`已开始下载 ${targets.length} 个文件`);
      return true;
    }

    const field = name === 'star' ? 'starred' : name === 'pin' ? 'pinned' : 'isDelete';
    const value = name === 'restore' ? false : true;

    // 恢复只对"无数据文件"的记录有效：带数据文件的软删记录恢复不了（服务端 404）
    const usable = name === 'restore' ? items.filter((item) => !item.hasData) : items;
    if (usable.length === 0) {
      toasts.error('选中的记录都带数据文件，删除时数据已清除，无法恢复');
      return false;
    }

    try {
      const result = await api.batchUpdate(usable, { [field]: value });
      clearSelection();
      await refresh({ silent: true });
      void refreshOverview();
      if (result.failed > 0) {
        toasts.info(`完成 ${result.updated} 条，${result.failed} 条未生效（可能已被别处修改）`);
      } else {
        toasts.ok(`已更新 ${result.updated} 条`);
      }
      return true;
    } catch (error) {
      if (handleAuthError(error)) return false;
      toasts.error(`批量操作失败：${error.message}`);
      return false;
    }
  }

  async function clearHistory(scope) {
    const spec = clearHistorySpec(scope);
    const ok = await confirm.ask({
      title: spec.title,
      message: spec.message,
      confirmLabel: spec.confirmLabel,
      action: async () => {
        await api.clear(scope);
      },
    });
    if (!ok) return false;

    clearSelection();
    await refresh({ silent: true });
    void refreshOverview();
    toasts.ok(`${spec.label}完成`);
    return true;
  }

  // ===== 会话 =====

  async function logout() {
    try {
      await api.logout();
    } catch {
      /* 清本机 Cookie 失败也要跳走：留在页面上只会让用户反复点 */
    }
    redirectToLogin();
  }

  // 注：选择集**刻意不做自动清理**。
  //   · 跨页选择是功能（用户可能在第 1 页选了几条、翻到第 3 页继续选）；
  //   · "把已经不存在的项摘掉"需要一次额外请求才能判定（当前页没有 ≠ 记录不存在），不值得；
  //   · 于是选择集只由用户显式清空（批量条上的 ✕ / Esc）或视图切换时重置。
  // 这里原来有一个 `pruneSelection()` 空函数，每轮刷新都会被调用一次 —— 它不做任何事，
  // 却让人以为"选择集会被自动对账"。注释留下，空壳删掉。

  // ===== 键盘 =====

  /**
   * 全局快捷键：实现与判据在 `keys.js`（那里写了两个"不能想当然"的判据）。
   * 这里只把回调接上 —— 判据属于那个模块，接线属于装配点。
   */
  function bindKeys() {
    bindShortcuts({
      onFocusSearch: () => omnibox.focus(),
      onEscapeSelection: () => {
        if (state().selection.size === 0) return false;
        clearSelection();
        return true;
      },
      onRefresh: () => void refresh({ announce: true }),
      isModalOpen: () => Boolean(document.querySelector('dialog[open]')),
    });
  }

  // ===== 启动 =====

  function start() {
    if (!startup) startup = initialize().finally(() => { startup = null; });
    return startup;
  }

  async function initialize() {
    store.patch({ loading: true, error: null });
    render();
    // 1. 会话探测（未登录直接跳登录页，不把骨架屏留给用户）
    let session;
    try {
      session = await api.session();
    } catch {
      store.patch({ loading: false, error: '无法连接服务器' });
      render();
      return;
    }
    if (!session?.authenticated) {
      redirectToLogin();
      return;
    }
    store.patch({ username: session.username, version: session.version });
    renderChrome();

    // 1.5 首屏骨架：**必须在这里画**（2026-09-16 实测）。
    // `render()` 只在数据落地后才跑，而它之前 `.board-area` 一直是空的 —— 于是骨架屏
    // 那套"保留布局、CLS = 0"的说法在真实首屏里从未成立：实测骨架行数 0、
    // 文档高度 804px，页脚与分页都停在视口内；数据一到高度涨到 4454px，
    // 页脚（在 736px 处，可见）与分页被整段顶出屏幕 —— **CLS 0.90**。
    // 这里先把骨架画出来（`board.update` 的 loading 分支就是干这个的），
    // 数据到达后由 `render()` 正常替换。
    board.update(boardSpec(state(), { state: 'loading', busy: true }));

    // 2. 首屏：一次合并请求（概览）+ 一次列表。**并发**，不串行 —— 两者互不依赖。
    await Promise.all([refresh(), refreshOverview()]);

    // 3. 活动趋势（首屏之后补，不阻塞列表可见）
    void refreshActivity();

    // 4. 推送通道
    pushChannel = createPushChannel({
      acquireTicket: async () => (await api.hubTicket()).path,
      // 收到任何广播都走与轮询**完全相同**的那次刷新：增量对账只有一份实现
      onSignal: debounce(() => {
        void refresh({ silent: true, flash: true });
        void refreshOverview();
      }, SIGNAL_DEBOUNCE),
      onState: () => {
        renderChrome();
        schedulePoll();
      },
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // 后台标签主动断开推送：隐藏页的定时器被浏览器节流到 ≥1 分钟，
        // 30 秒心跳必然漏掉 60 秒静默窗口，那条路会退化成"断开→退避重连"的抖动
        // （每次重连 = 一次票据 POST + 一次 WS + 一次 DO 唤醒），比它省下的轮询还贵，
        // 且连接不断时 DO 永不休眠（计费）。隐藏期间交给 30 秒轮询兜底。
        pushChannel?.stop();
      } else {
        // 回前台先补后台错过的变更（见 missedWhileHidden），再重连推送、再轮询。
        if (missedWhileHidden) {
          missedWhileHidden = false;
          void refresh({ silent: true, flash: true });
          void refreshOverview();
        }
        // 回前台重新尝试（同时清零连续失败计数，避免"坏环境里永久放弃"）
        pushChannel?.start();
        void pollOnce();
      }
      schedulePoll();
    });

    pushChannel.start();
    schedulePoll();

    // 5. 键盘与深链接
    bindKeys();
    void openDeepLink();
    window.addEventListener('hashchange', () => void openDeepLink());

    // 6. 浏览器前进/后退（2026-09-16 修的缺陷）
    //
    // 筛选状态写在查询串里，而 `setFilters` 用的是 `pushState` —— 也就是说**每一级筛选都在
    // 历史里有一条记录**。但此前没有任何 `popstate` 监听：点返回时 URL 变回了上一级，
    // 页面却纹丝不动（列表、chips、分页数字全停在新的那一级）。实测：图片 chip → 28 行，
    // `history.back()` 后 URL 是 `?`，列表仍是 28 行图片、chip 仍是按下态。
    // 比"没反应"更糟的是它**看起来成功了**（地址栏确实回退了），而后面每一次 URL 写入
    // 都会因为"查询串与上次写入的不同"而被 `syncUrl` 判为无需写 —— 状态从此三方不一致。
    //
    // 判据：URL 是唯一事实源，回来就按 URL 重建筛选状态（`filtersFromUrl` 已经做了白名单与夹取）。
    window.addEventListener('popstate', () => {
      const next = filtersFromUrl();
      omnibox.setValue(next.search, { force: true });
      const viewChanged = viewOf(next) !== viewOf(state().filters);
      // 返回/前进可能跨视图（活跃 ↔ 回收站），选择集在那种情况下必须清空
      store.patch({ filters: next, selection: new Map() });
      lastAppliedRange = next.range;
      renderChrome();
      void refresh();
      if (viewChanged) void refreshOverview();
    });
  }

  /**
   * 深链接 `#Type-<hash>`：hash 空闲（筛选状态走 query string），打开即预览那一条。
   */
  async function openDeepLink() {
    const match = /^#([A-Za-z]+)-(.+)$/.exec(location.hash);
    if (!match) return;
    const type = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    const hash = match[2];

    // 先在当前页里找（省一次请求）；找不到再问服务端。
    // 服务端返回的正文是**完整**的，故这条路径不受列表截断影响。
    const local = state().items.find((item) => item.type === type && item.hash === hash);
    if (local) {
      await openPreview(local);
      return;
    }
    try {
      const item = await api.get({ type, hash });
      if (item) await openPreview(item);
    } catch (error) {
      if (handleAuthError(error)) return;
      toasts.error('链接指向的记录不存在（可能已被删除）');
    }
  }

  void start();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
