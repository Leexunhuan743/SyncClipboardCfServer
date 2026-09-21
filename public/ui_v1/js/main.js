// 装配点：只有这里知道「谁是谁」，组件之间互不认识。
//
// 数据流：actions（用户意图）→ store（状态）→ 组件 update（渲染）。
// 网络请求只发生在 actions 与轮询里，组件不碰 fetch。
//
// 约定：**actions 返回结果，组件呈现结果**。行内按钮的「进行中 → 成功」状态由组件自己管，
// 靠的是 action 的返回值（`true` 才算做成）——「发过请求」不等于「做成了」。
import { api, ApiError, handleAuthError, redirectToLogin, PAGE_BASE } from './api.js';
import { createStore } from './store.js';
import { filtersFromUrl, filtersToApi, syncUrl, DEFAULT_FILTERS } from './filters.js';
import { writeText, writeImage, itemIsImage } from './clipboard.js';
import { typeLabel, downloadNameForText, safeFileName, charCount } from './format.js';
import { debounce } from './dom.js';
import { createLatestGate } from './latest.js';
import { createPushChannel } from './signalr.js';
// 文案（删除/批量删除/清空/列表错误/剪贴板失败）在 V1 自己的 `./messages.js` 里：
// 产品面必须自包含，不得跨目录依赖开发测试版 V2（见该文件头的说明与对等守卫）。
import {
  deleteConfirmSpec,
  batchDeleteConfirmSpec,
  purgeConfirmSpec,
  batchPurgeConfirmSpec,
  batchProgressText,
  batchPartialText,
  batchAbortedText,
  clearHistorySpec,
  describeListError,
  clipboardFailureHint,
} from './messages.js';
import { createHeader } from './components/header.js';
import { createStats } from './components/stats.js';
import { createToolbar } from './components/toolbar.js';
import { createList } from './components/list.js';
import { createPagination } from './components/pagination.js';
import { createPreview } from './components/preview.js';
import { createConfirm } from './components/confirm.js';
import { createToasts, setPending, flashSuccess, isPending } from './components/toast.js';
import { createInfo } from './components/info.js';

// 可见 10s / 隐藏 30s：一次轮询是一次 D1 读 + 一次 Workers 请求，
// 5s 间隔意味着「一个标签开一天」≈ 17k 请求，接近免费版日额度的两成（见 README 容量提示）。
// 看历史这件事不需要 5 秒级的新鲜度，10s 已经足够「刚复制的内容马上能看到」。
const POLL_INTERVAL_VISIBLE = 10000;
const POLL_INTERVAL_HIDDEN = 30000;
// 推送在线时的轮询间隔：**轮询不会被关掉**，它降级成看门狗——万一某条广播没到（休眠、代理掐连接、
// 推送通道刚断还在退避），界面仍能在 1 分钟内收敛。10 秒轮询与它相比只是「更早发现」。
const POLL_INTERVAL_WATCHDOG = 60000;

const store = createStore({
  filters: filtersFromUrl(),
  items: [],
  total: 0,
  // 首屏数据还没落地。列表组件据此画骨架、而不是画空状态 —— 没有这一位时，
  // 「还没到」会被读成「一条都没有」，于是页面一打开就断言「还没有任何记录」（2026-09-18 修）。
  // 初始为 true：组件被建出来的那一刻，数据必然还没到。
  loading: true,
  // 最近一次列表请求失败的原因（成功即清空）。**它和 loading 是两件事**：失败路径不调
  // `render()`（那会把刚画好的错误态换成空状态），所以列表与分页各自要有一个"此刻不该表态"
  // 的判据 —— 那两个组件读的就是这一位（对应 V2 `boot.js` 的 `state.error` / `boardState()`）。
  error: null,
  stats: null,
  info: null,
  username: null,
  version: null,
  selection: new Map(), // key → item（跨页保留选择）
  flashKeys: new Set(),
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
});

const toasts = createToasts(document.getElementById('toasts'));
const confirm = createConfirm();
const preview = createPreview({
  onCopy: copyItem,
  onCopyImage: copyImage,
  onDownload: downloadItem,
  onDownloadText: downloadTextItem,
  // 预览打开时把这一条写进 URL 的 hash（链接可分享），关闭时清掉——
  // 否则刷新页面会突然弹出上一次看过的记录。`#Text-<hash>` 也是深链接的入口（见 openDeepLink）。
  onClose: () => {
    if (DEEP_LINK.test(location.hash)) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
  },
});
const info = createInfo({
  onCopyText: copyPlainText,
  onClearAll: clearAll,
  getClockOffsetMs: () => clockOffsetMs,
  getLastChangeMs: () => lastChangeMs,
  getPushState: () => pushChannel.state,
  // 首屏取不到部署信息时的「重试」：再走一次同一条路径（成功就用新数据重绘对话框）
  onRetry: () => openInfo(),
});

// 实时推送（后端能力评估 §2.1）：连上后把轮询降到看门狗间隔，断线自动回到 10 秒轮询。
// 这条链路的意义是把「一个开着的标签 ≈ 8.6k 请求/天」（10 秒轮询，见 README 容量提示）压到
// ≈1.4k（60 秒看门狗），同时让别的设备的改动**立即**可见；代价是前台开着标签时那条连接会让
// DO 常驻（Hub 本来就会用到的同一个对象），标签切到后台即断开。
// 它**不替代**轮询——降级路径必须一直在（见 POLL_INTERVAL_WATCHDOG 的说明）。
const pushChannel = createPushChannel({
  acquireTicket: async () => (await api.hubTicket()).path,
  // 收到任何广播都走与轮询完全相同的那一次刷新：增量对账（哪一行变了、要不要补行）只有一份实现。
  // **必须去抖**：批量操作是**逐条广播**的（删 200 条 = 200 次广播），不合并的话一次批量写会让
  // 界面连打两百次列表请求。300ms 的尾沿足够把一串广播收敛成一次刷新，人眼也看不出差别。
  onSignal: debounce(() => void refresh({ silent: true, flash: true }), 300),
  onState: () => {
    // 顶栏那枚状态点直接读 pushChannel.state，故状态一变就重画一次表头
    syncHeader();
    // 通道状态决定轮询间隔（live 时降到看门狗），故也要重排定时器
    schedulePoll();
  },
});

// 两个由轮询顺带观测的量（不在每次请求上重复计算）：
//   · 时钟差 —— 官方客户端在 |差| > 5 分钟时中止历史同步，是「同步不动」的常见根因；
//   · 最近一次变更时间 —— 服务端最新一条记录的 LastModified，近似「最近一次同步」。
let clockOffsetMs = null;
let lastChangeMs = null;

// 离线/失联提示：轮询与统计是**静默**发生的，它们的失败此前没有任何迹象——
// 页面会一直显示旧数据，用户以为「服务器上没有新内容」。这条横幅只在恢复前可见，
// 成功的那次请求把它收掉（比一闪而过的 toast 更合适：它描述的是一个持续状态）。
const notice = document.getElementById('notice');

function setStale(stale) {
  if (!notice) return;
  notice.hidden = !stale;
  notice.textContent = stale ? '与服务器暂时失去联系，页面上的内容可能不是最新的；恢复后会自动刷新。' : '';
}

/**
 * 这次失败是否意味着「**连不上**服务器」——横幅只在真的连不上时点亮。
 *
 * 判据（与 V2 `boot.js` 同构）：不是 `ApiError`（DNS / 断网 / CORS 这类 fetch 层的失败），
 * 或者状态码 ≥ 500。**4xx 是服务端正常回答了**：搜索词超过 48 字节触发的 400、429 限速、
 * 404 —— 它们都不会让「恢复后会自动刷新」成真，而横幅里那句"暂时失去联系"会让用户去
 * **重启服务**（V2 的注释逐字记着这次实测）。V1 此前是任何失败都无地点亮，
 * 于是搜索词过长时屏幕上同时出现「搜索词过长…」与「与服务器暂时失去联系」两种说法
 * （`docs/archive/AUDIT-v1-v2-divergence.md` §2.1）。
 */
function serverUnreachable(error) {
  return !(error instanceof ApiError) || error.status >= 500;
}

// ===== 剪贴板 =====
// 写入机制（含安全上下文与降级）都在 js/clipboard.js；这里只决定「失败时怎么呈现」。
async function copyPlainText(text, label = '内容') {
  const ok = await writeText(text);
  if (ok) toasts.info(`已复制${label}`);
  else toasts.error(clipboardFailureHint(window.isSecureContext, '可以手动选中文本后复制。'));
  return ok;
}

// 列表里的正文是截断过的：要复制/预览全文必须先取单条，否则用户拿到的是被砍掉一半的内容。
// 取不到（网络/401）返回 null，由调用方决定降级路径。
// `retry`（可选 thunk）：失败时把"重试刚才那一步"放进提示条 —— 调用方知道自己要做的是什么
// （复制那一条 / 预览那一条），这个函数不知道。
async function fetchFull(item, retry = null) {
  if (!item.textTruncated) return item;
  try {
    return await api.get(item);
  } catch (error) {
    if (handleAuthError(error)) return null;
    toasts.error(`取全文失败：${error.message}`, retry ? { action: { label: '重试', run: retry } } : {});
    return null;
  }
}

// ===== 动作 =====
// 哪些筛选字段会**改变结果集的成员资格**：变了它们，选择集里的旧快照可能已不在新结果里，
// 而批量删除/收藏仍按选择集逐条在服务端执行 —— 那等于对"看不见的行"动手（F3）。
// 排序 / 翻页 / 页大小**不在列**：它们不改变集合。
// ⚠️ **搜索在列**（2026-09-19 复查补入）：它是筛选，不是"高亮"—— 服务端为它生成
// `Text LIKE ? ESCAPE '\'`（`src/ui/query.ts`：UI 面转义、协议面不转义），被它滤掉的行
// 看不见、却仍留在选择集里 ⇒ 与 F3 同型。
const MEMBERSHIP_KEYS = ['types', 'starred', 'deleted', 'range', 'after', 'before', 'search'];

function setFilters(patch, { push = false, scroll = false } = {}) {
  const state = store.get();
  const next = { ...state.filters, ...patch };
  // 类型计数与视图同源：回收站与活跃列表是**两套**计数，切视图时必须重取，
  // 否则分段控件显示的是另一套（列表头「回收站 · 共 938 条」、控件仍写「全部 1009」）。
  const viewChanged = Boolean(next.deleted) !== Boolean(state.filters.deleted);
  // 成员资格变了就清选择集（F3）：残留的旧快照会让"删除选中"落到当前筛选看不见的行上。
  // 进出回收站原有的一处（onToggleDeleted）由这里一并覆盖。
  if (MEMBERSHIP_KEYS.some((key) => patch[key] !== undefined)) {
    store.set({ selection: new Map() });
    list.updateSelection(store.get().selection);
  }
  store.set({ filters: next });
  syncUrl(next, { push });
  // 立刻把**筛选控件**画成新状态，不等响应：store 不触发绘制，而 render() 只在 refresh() 落地后跑 ——
  // 于是从点击到响应这段时间里，被点的那一段控件毫无变化（真实网络上就是几百毫秒的「点下去没反应」，
  // 响应一到整块换掉，读起来正是卡顿）。列表本身仍是旧行 + `data-busy` 变淡，等响应回来再对账。
  render();
  // 结果区在首屏之外（用户滚下去看过）时，换页/改筛选要把它带回视野，
  // 否则「点了下一页」只换了脚下看不见的内容。
  refresh().finally(() => {
    if (scroll) scrollToResults();
  });
  if (viewChanged) void refreshStats();
}

function scrollToResults() {
  const headerHeight =
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 60;
  if (list.el.getBoundingClientRect().top >= headerHeight + 8) return; // 已经在视野里
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  list.el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

const actions = {
  onTypes: (types) => setFilters({ types, page: 1 }, { push: true, scroll: true }),
  onToggleStarred: () =>
    setFilters({ starred: !store.get().filters.starred, page: 1 }, { push: true, scroll: true }),
  // 回收站是范围切换：进出都回到第 1 页。选择集由 `setFilters` 统一清（`deleted` 在
  // `MEMBERSHIP_KEYS` 里）—— 这里不再各清一份，两处同一件事必然漂移（F3）。
  onToggleDeleted: () => {
    setFilters({ deleted: !store.get().filters.deleted, page: 1 }, { push: true, scroll: true });
  },
  onRange: (patch) => setFilters({ ...patch, page: 1 }, { push: true, scroll: true }),
  onRestore: (item) => restoreItem(item),
  onSearch: (search) => setFilters({ search, page: 1 }),
  onPageSize: (pageSize) => setFilters({ pageSize, page: 1 }, { push: true, scroll: true }),
  onPage: (page) => setFilters({ page }, { push: true, scroll: true }),
  onSort(field) {
    const { filters } = store.get();
    const order = filters.sort === field ? (filters.order === 'desc' ? 'asc' : 'desc') : 'desc';
    setFilters({ sort: field, order, page: 1 }, { push: true, scroll: true });
  },
  onRefresh: () => refresh({ announce: true }),
  onClearFilters: () => setFilters({ ...DEFAULT_FILTERS }, { push: true, scroll: true }),
  onInfo: openInfo,
  onPreview: previewItem,
  onCopy: copyItem,
  onCopyImage: copyImage,
  onDownload: downloadItem,
  onDownloadText: downloadTextItem,
  onStar: (item, starred) => toggleFlag(item, 'starred', starred),
  onPin: (item, pinned) => toggleFlag(item, 'pinned', pinned),
  onDelete: deleteItem,
  onSelect(item, checked) {
    const selection = new Map(store.get().selection);
    if (checked) selection.set(item.key, item);
    else selection.delete(item.key);
    store.set({ selection });
    list.updateSelection(selection);
  },
  // Shift+点击：整段选中（锚点与目标之间的全部行）
  onSelectRange(items) {
    const selection = new Map(store.get().selection);
    for (const item of items) selection.set(item.key, item);
    store.set({ selection });
    list.updateSelection(selection);
  },
  onSelectAll(checked) {
    const selection = new Map(store.get().selection);
    for (const item of store.get().items) {
      if (checked) selection.set(item.key, item);
      else selection.delete(item.key);
    }
    store.set({ selection });
    list.updateSelection(selection);
  },
  // 清空**全部**选区（跨页）：空态退出（点空白处）用。与 onSelectAll(false) 的区别——
  // 后者只清当前页（`store.items` 是本页）；跨页选中的行只有这个动作能一次清掉。
  onClearSelection() {
    store.set({ selection: new Map() });
    list.updateSelection(new Map());
  },
  onBatchDelete: batchDelete,
  onBatchFlag: batchFlag,
  onBatchRestore: batchRestore,
  onBatchCopy: batchCopy,
  onPurge: purgeItem,
  onBatchPurge: batchPurge,
  onEmptyTrash: emptyTrash,
};

const header = createHeader({
  onToggleTheme: toggleTheme,
  onLogout: logout,
  onInfo: openInfo,
  onCopyLatest: copyLatest,
});
const stats = createStats();
const toolbar = createToolbar({
  onTypes: actions.onTypes,
  onToggleStarred: actions.onToggleStarred,
  onToggleDeleted: actions.onToggleDeleted,
  onRange: actions.onRange,
  onSearch: actions.onSearch,
  onPageSize: actions.onPageSize,
  onRefresh: actions.onRefresh,
});
const list = createList(actions);
const pagination = createPagination({ onPage: actions.onPage });

// 类型计数的归属：`state.stats.view` 记录这份计数是**为哪个视图**取的。
// 守卫放在**绘制点**而不是只放在取数点——因为重绘可能来自任何路径（列表刷新、轮询、动作后的静默刷新），
// 只守 fetch 挡不住「迟到的响应 + 之后的一次 render」这种组合。不一致时按「暂无计数」处理（不显示数字），
// 而不是显示另一个视图的数字。
function countsForView(state) {
  return state.stats && state.stats.view === state.filters.deleted ? state.stats.byType : undefined;
}

// ===== 渲染 =====
// 表头的唯一绘制点：用户名/版本来自会话，主题来自本地开关，推送状态来自 signalr 通道。
// 单独成函数是因为它们来自三个不同的时机（render / toggleTheme / onState），
// 各写一次 header.update(...) 就会漏掉其中的字段。
function syncHeader() {
  const state = store.get();
  header.update({
    username: state.username,
    version: state.version,
    theme: state.theme,
    pushState: pushChannel.state,
    // 「复制最近一条」在没有记录时隐藏：那时它没有任何可做的事（不是"禁用"，是不存在）
    canCopyLatest: state.total > 0,
  });
}

// 分页那一格的**唯一**绘制点：`render()` 与失败路径共用它 —— 失败路径不能整块 `render()`
// （`list.update()` 会把刚画好的错误态换成空状态），但分页照样要跟着从加载档落下来。
function renderPagination() {
  const state = store.get();
  pagination.update({
    page: state.filters.page,
    pageSize: state.filters.pageSize,
    total: state.total,
    // 分页也要能区分「还没到」与「真的没有」（见 components/pagination.js）——
    // 首屏那一帧它此前写的是「没有可显示的记录」，与列表刚修掉的那句是同一个谎，
    // 只是换了个控件（2026-09-18 补）。
    loading: state.loading,
    // 失败时条数**未知**：加载档那句（正在加载…）与空档那句（没有可显示的记录）都不成立，
    // 分页这时什么都不说 —— 说明由列表的错误态正文承担（`serverUnreachable` 那条横幅只管连通性）。
    error: Boolean(state.error) && state.total === 0,
  });
}

function render() {
  const state = store.get();
  syncHeader();
  stats.update(state.stats, state.filters.deleted);
  toolbar.update({ filters: state.filters, byType: countsForView(state) });
  list.update(state);
  renderPagination();
}

// ===== 数据 =====
// 四个独立的守卫：列表、统计、概览快照、变更信号各自「最新请求胜出」——它们互相之间没有依赖，
// 共用一个守卫会让统计请求把列表请求 abort 掉（那是两件不同的事）。
const listGate = createLatestGate();
const statsGate = createLatestGate();
const overviewGate = createLatestGate();
const pollGate = createLatestGate();

async function refresh({ silent = false, flash = false, announce = false } = {}) {
  const state = store.get();
  const previousKeys = new Set(state.items.map((item) => item.key));
  const ticket = listGate.begin();

  // 取数期间列表画什么，取决于"手上有没有旧内容"：
  //   · 有 → 旧行原样留着 + 整块降对比（`data-busy`）。背景刷新（轮询/推送）也走这条；
  //   · 没有 → 骨架（由 list 的 loading 档画）。这一档此前缺失，见 store 里 loading 的说明。
  // `silent`（轮询 / 推送广播 / popstate）**不动** loading：那种刷新是"背景里补一下"，
  // 把用户正在看的内容换成骨架是倒退；它只负责把新数据对账进去。
  if (!silent) store.set({ loading: true });
  if (!silent && state.items.length > 0) list.el.setAttribute('data-busy', 'true');

  try {
    const page = await api.list(filtersToApi(state.filters), ticket.signal);
    // 已有更新的请求在飞：这次的结果作废，**绝不能**写回 store
    // （写回就是「列表显示的内容与筛选控件不一致」——实测复现过的缺陷）。
    if (!listGate.isCurrent(ticket)) return;
    // 越界页：删掉一整页、清空回收站、把每页条数调大之后，当前页码可能已经超过总页数。
    // 服务端不夹取（`src/ui/query.ts` 直接 offset=(page-1)*pageSize），于是这里会拿到
    // 一页空数据，而分页条仍按旧页码渲染 —— 实测文案是「第 101–100 条，共 70 条」
    // 「第 3 / 2 页」，同时列表显示空状态。夹回最后一页重新取一次即可。
    // 用 replace 而不是 push：这是界面的自我修正，不该进浏览器的后退历史。
    const lastPage = Math.max(1, Math.ceil(page.total / state.filters.pageSize));
    if (state.filters.page > lastPage) {
      setFilters({ page: lastPage }, { push: false });
      return;
    }
    setStale(false);
    const flashKeys = flash
      ? new Set(page.items.filter((item) => !previousKeys.has(item.key)).map((item) => item.key))
      : new Set();

    // 新视图（换页/改筛选）才做入场错峰；轮询刷新不做，否则每次刷新整页闪一遍。
    // 同一视图内的刷新走 list 内部的按行对账：内容没变的行不重建。
    // 列表更新**不再走同文档视图过渡**：实测（6× CPU 降速）一次「什么都没变」的切换里，
    // 过渡本身就要 ~60ms 主线程（布局与样式各上百毫秒级——它要对 `.results` 整块做快照，
    // 成本随页大小上升），换来的只是一个数据表上的交叉淡入；而列表现在是一帧落地，
    // 本就没有「换面」需要掩饰。跨文档过渡（登录页 → 列表页）保留，那条由 CSS 声明、不走这里。
    store.set({ items: page.items, total: page.total, flashKeys, loading: false, error: null });
    // 取到数据了 ⇒ 上一次那条"搜索词过长"不再成立（用户可能刚好删掉了几个字）。
    // 清在这里而不是"输入一变化就清"：请求成功才是"这个查询真的被服务端接受了"的证据。
    toolbar.setSearchError(null);
    render();

    if (announce) toasts.info(`已刷新，共 ${page.total} 条记录`);
  } catch (error) {
    // 被更新的请求 abort 掉不是失败：静默退出，由那次请求负责呈现
    if (ticket.signal.aborted) return;
    if (handleAuthError(error)) return;
    // 翻译成人话的那几条（400 搜索词过长 / 429 限速 / 其余原样）在**两版共用**的文案表里：
    // 此前 V1 与 V2 各写一份，症状是"同一件事两个界面说不同的话"。
    const message = describeListError(error, store.get().filters.search);
    // 失败也要把 loading 收掉：否则「加载失败 + 重试」之上还压着一层骨架，
    // 那个可操作的错误态根本露不出来。
    // `error` 一并进 store：失败时条数**未知**，列表与分页都不该把「取不到」画成「真的没有」
    // （`list.update` 与 `renderPagination` 都读这一位）。
    store.set({ loading: false, error: message });
    if (serverUnreachable(error)) setStale(true);
    // 400 + 搜索词非空 ⇒ 只可能是"搜索词超过服务端上限"（`messages.js` 的 describeListError
    // 里那一支就是按这个判据分的，两边必须一致）。这条错误属于**搜索框**：此刻列表里留着的是
    // 上一次查询的结果，用户的眼睛在搜索框上，错误就该说在它下面（`components.md` §2 的 error 格）。
    const searchFieldError = error.status === 400 && store.get().filters.search !== '';
    if (store.get().items.length === 0) {
      // 首屏失败：给出可操作的错误态，而不是把骨架屏永远留在那里。
      // 结果区这时本来就是空的、整块都是错误面，够显眼 —— 不再往工具栏里重复说一遍同一句话；
      // 但**不留「重试」**：输入问题重试必然再失败（提示条那条路径一直就是这么判的）。
      list.showError(message, searchFieldError ? null : () => refresh());
      // 分页那一格也要跟着落到失败档 —— 失败路径不整块 `render()`（理由见上面的 store 说明），
      // 少了这一句它会**永远**停在加载档写下的「正在加载…」，与正下方的「加载失败」互相矛盾。
      renderPagination();
    } else if (searchFieldError) {
      toolbar.setSearchError(message);
    } else {
      // 已经有内容时保留旧数据 + 一条提示。带上「重试」：网络抖动这类瞬时故障占多数，
      // 而重试的成本正好是刚刚失败的那一次列表请求 —— 此前只能让用户自己再点一次刷新。
      // 400（搜索词过长 / 筛选值非法）不给重试：那是输入问题，重试必然再失败。
      toasts.error(message, error.status === 400 ? {} : { action: { label: '重试', run: () => void refresh() } });
    }
  } finally {
    // 已被取代时不要清 busy：那面“正在取”的旗子归更新的那次请求管
    if (listGate.isCurrent(ticket)) list.el.removeAttribute('data-busy');
  }
}

async function refreshStats() {
  const ticket = statsGate.begin();
  // 这次请求是**为哪个视图**取数。latest-gate 只保证「最新的一次请求胜出」，
  // 它管不了「这份响应属于哪个视图」——首屏那次统计若在用户切到回收站之后才落地，
  // 它会带着活跃记录的数把回收站的计数盖掉。
  const view = store.get().filters.deleted;
  let data;
  try {
    // 变量名**不能**叫 `stats`：那会遮蔽模块级的组件实例（`const stats = createStats(...)`），
    // 于是 `stats.update(...)` 变成在响应对象上找方法 → TypeError → 被 catch 吞掉：
    // 统计的绘制整段失效（只有 render() 顺带画）、而且（自本轮起）会把「失联」横幅误打开。
    // 这类遮蔽 `no-undef` 抓不到，故在 eslint 配置里另开了 `no-shadow`。
    data = await api.statistics(ticket.signal, { deleted: view });
  } catch (error) {
    if (ticket.signal.aborted) return;
    if (handleAuthError(error)) return;
    if (serverUnreachable(error)) setStale(true);
    return;
  }
  if (!statsGate.isCurrent(ticket)) return;
  if (view !== store.get().filters.deleted) return; // 视图已切换：这份计数不属于当前视图
  setStale(false);
  // 绘制放在 fetch 的 try 之外：真出渲染异常时不该被当成网络失败（那正是遮蔽 bug 的藏身处）
  store.set({ stats: { ...data, view } });
  const current = store.get();
  stats.update(current.stats, current.filters.deleted);
  toolbar.update({ filters: current.filters, byType: countsForView(current) });
}

// ===== 首屏合成快照（`/ui/api/overview`，2026-09-18）=====
// 一次往返拿到：存量统计 + 类型计数 + 变更标记 + 部署信息（含清理状态/保留策略）+ 服务端时间。
// 它取代了首屏的 `refreshStats()` 与"第一次 poll 的顺带观测"，于是首屏从三次请求（list +
// statistics + poll）变成两次（list + overview）；而「时钟差 / 最近一次同步 / 清理状态」
// 这三样排障要看的东西也随它一起到手 —— 否则它们只在用户主动打开部署信息时才取。
//
// 失败**不阻断首屏**：列表那一份是单独取的，统计条与排障条留空即可；也不打开失联横幅 ——
// 那件事由列表与轮询自己报，不该由一张锦上添花的快照把整页标成"可能不是最新"。
//
// **但"留空"必须能自愈**（2026-09-18 修）：此前这里写着"下一次轮询会把后两样补齐"，
// 而 `pollOnce()` 从不重取这份快照 —— 于是首屏那一次失败（一次网络抖动即可）会让统计条
// **永久空着**，用户分不清"库里是 0"还是"坏了"，而注释还在替它担保。
// 现在那句话成真了：`pollOnce` 在**轮询成功之后**若发现 `stats === null`（= 快照一次都没
// 落地）就补取一次；成功后 `stats` 非空，这条分支自然关掉。见
// `docs/AUDIT-missing-states.md` §2.1 / §4.1。
//
// 快照与 `refreshStats()` 写的是 store 里**同一个** `stats`，而它们是两条独立的取数路径
// （首屏走快照、此后走 statistics）。故这里也有两条与 refreshStats 同源的纪律：
//   ① 走 `overviewGate`：有更新的快照在飞时，这次的结果不许落地（latest-gate）；
//   ② `view` 在**请求时定格**并原样盖章 —— 落地时再读 `filters.deleted` 的话，
//      一份"活跃视图"的快照会被标成"回收站视图"，而 `countsForView` 会因此认为归属一致、
//      把活跃记录的计数当回收站的计数画出来（同一类缺陷 refreshStats 里有
//      `if (view !== store.get().filters.deleted) return;` 这条显式守卫）。
async function refreshOverview() {
  const view = store.get().filters.deleted;
  const ticket = overviewGate.begin();
  try {
    const snapshot = await api.overview({ deleted: view, signal: ticket.signal });
    if (!overviewGate.isCurrent(ticket)) return;
    store.set({
      stats: {
        ...(snapshot.stats ?? {}),
        view,
        // 这四个计数在快照里是**顶层**字段（`/ui/api/overview` 与 `/ui/api/statistics` 的形状差
        // 就在这里）：快照把 stats 与"随视图的计数"并排放，而 statistics 是铺平的一个对象。
        // 漏搬任何一个的后果是那一格静默回落成 0（`stats.update` 的 `?? 0`）—— 卡片上写着
        // 「已收藏 0 条」而接口里是 3。2026-09-21 实测踩过。
        byType: snapshot.byType ?? null,
        byTypeActive: snapshot.byTypeActive ?? null,
        starredCountActive: snapshot.starredCountActive ?? null,
        starredCountDeleted: snapshot.starredCountDeleted ?? null,
      },
      info: snapshot.info ?? store.get().info,
    });
    if (typeof snapshot.serverTime === 'string') {
      const server = Date.parse(snapshot.serverTime);
      if (!Number.isNaN(server)) clockOffsetMs = server - Date.now();
    }
    const changeMs = Number(snapshot.marker?.lastModified);
    if (Number.isFinite(changeMs) && changeMs > 0) lastChangeMs = changeMs;
    // 变更标记也一起种下：否则第一次 poll 会把「首屏已经看过的这一份」当成一次新变更，白刷一遍列表
    if (snapshot.marker) marker = `${snapshot.marker.count}:${snapshot.marker.lastModified}`;

    setStale(false);
    const current = store.get();
    stats.update(current.stats, current.filters.deleted);
    stats.setHealth(healthSnapshot());
    toolbar.update({ filters: current.filters, byType: countsForView(current) });
  } catch (error) {
    // 被更新的快照 abort 掉不是失败：静默退出（与 refreshStats / refresh 同一个判据）。
    // 少了这一句，每次"用户在加载中途又触发一次刷新"都会在控制台留一行无谓告警。
    if (ticket.signal.aborted) return;
    if (handleAuthError(error)) return;
    console.warn(`[ui] overview 快照获取失败：${error.message}`);
  }
}

// 排障面的三个数（首屏与轮询都要刷新）：最近一次同步、本机与服务端的时钟差、
// 清理任务的最近一次运行与失败。前两样来自 poll/overview 的顺带观测，第三样来自
// 同一个快照里的部署信息（`info.cleanup`）。
function healthSnapshot() {
  // 变量名不能叫 `info`：那会遮蔽模块级的**部署信息对话框组件**（`const info = createInfo(...)`），
  // 正是 eslint 的 `no-shadow` 在守的那类事故（refreshStats 的注释里记过一次同源的坑）。
  const deployment = store.get().info;
  return {
    lastChangeMs,
    clockOffsetMs,
    cleanup: deployment?.cleanup ?? null,
  };
}

// ===== 活动趋势（借自 V2 的 `/ui/api/activity`）=====
// 近 14 天每天新增多少条，画成统计条右侧那一小排柱子。
//
// 三条纪律：
//   · **附加信息**，取不到就不画：不弹提示、不打开"失去联系"横幅 —— 那两件事属于列表数据本身，
//     让一张趋势图把整页标成"可能不是最新"是过度反应；
//   · **只在数据变了时重取**（挂在 poll 的 changed 分支上，而不是每次轮询都拉）：
//     它是按天聚合的查询，一天之内只有写入才会改变某根柱子的高度；
//   · 不阻塞首屏：列表与统计先落地，趋势晚一拍出现（它是"锦上添花"，不该拖慢第一行）。
async function refreshActivity() {
  try {
    stats.setActivity(await api.activity());
  } catch (error) {
    if (handleAuthError(error)) return;
    /* 静默：趋势图不是关键路径（理由见上） */
  }
}

// ===== 单项操作 =====
// PATCH 的响应是服务端归一化后的**新条目**（带新 version / lastModified）。采纳它，而不是只在本地
// 改一个字段：服务端算出的版本是后续写操作的判定依据（并发冲突用它），本地不采纳就会在下一次
// 操作里发出过期版本。只取元数据字段——响应里的 text 是**未截断**的全文，整行状态不该被它撑大。
const PATCH_META_FIELDS = ['starred', 'pinned', 'isDeleted', 'version', 'lastModified', 'lastAccessed'];

function adoptPatch(item, updated) {
  if (!updated) return item;
  const next = { ...item };
  for (const field of PATCH_META_FIELDS) {
    if (updated[field] !== undefined) next[field] = updated[field];
  }
  return next;
}

// 收藏 / 置顶：同一个实现，只有字段不同。结果就地反映在那一行（不重拉整页），并按方向播一次动画。
async function toggleFlag(item, field, value) {
  try {
    const updated = await api.patch(item, { [field]: value });
    const next = adoptPatch(item, updated);
    list.patchItem(next, { pop: field === 'starred' ? 'star' : 'pin' });
    // `store.items` 这份也要跟着走：它是「全选」与批量方向判定的输入（`onSelectAll` 从这里取对象）。
    // 只改 list 的内部副本时，"先点行内置顶、再全选 → 置顶"会按**旧快照**算方向，
    // 于是对那几条本来就没变的记录也各发一次写（服务端照样 Version++ 并广播）。
    store.set({
      items: store.get().items.map((entry) => (entry.key === next.key ? next : entry)),
    });
    // 这一行如果在选择集里，选择集里那份也要换成新对象：选择条的方向与文案（置顶 / 取消置顶、
    // 收藏 / 取消收藏）读的正是选择集里的对象。只更新列表而不更新它，就会出现
    // 「这一行已经置顶了，选择条上的按钮却还写着『置顶』」—— 它按的是旧快照，方向是反的。
    const selection = store.get().selection;
    if (selection.has(next.key)) {
      const synced = new Map(selection);
      synced.set(next.key, next);
      store.set({ selection: synced });
      list.updateSelection(synced);
    }
    void refreshStats();
    // 这次改动会改变**当前列表里的位置或成员资格**时要立刻对账：
    //   · 置顶：列表现在是置顶优先（`src/ui/query.ts`），这一行要挪到最前——不立刻对齐的话，
    //     它会在下一次轮询（≤10 秒）时自己跳走，那时用户已经不知道是谁动的；
    //   · 「收藏」那枚筛选开着时取消收藏：这一行已不符合筛选条件，却还留在列表里。
    // 不是重拉整页：对账按行签名复用节点，变的只有那一行的位置（见 list.js 的落位注释）。
    if (field === 'pinned' || store.get().filters.starred) await refresh({ silent: true });
    return true;
  } catch (error) {
    if (handleAuthError(error)) return false;
    if (error.status === 409) {
      // 冲突说明这条已被别的设备改过。只提示"请刷新"等于把对账推给用户，而此刻页面上的
      // 版本号、徽标、开关都可能已经过期 —— 就地重取一次，让这一行显示真实状态。
      toasts.error('记录已被其他设备修改，已刷新为最新状态');
      await refresh({ silent: true });
      return false;
    }
    toasts.error(`操作失败：${error.message}`);
    return false;
  }
}

async function deleteItem(item) {
  // 文案口径与实现逐条对齐，且由 `messages.js` 单点承载（V1 自己那份，可与 V2 的对等守卫比对）：
  // 2026-09-22（ADR D29）起**删除不再销毁数据** —— 记录（连同数据文件）在回收站留 30 天、期间可恢复；
  // 想立刻清掉字节要用回收站里的「彻底删除」。此前那句"带数据文件 → 立即清除、不可恢复"
  // 描述的是上游语义，已经不成立，别再写回去。
  const spec = deleteConfirmSpec(item);
  const ok = await confirm.ask({
    title: spec.title,
    message: spec.message,
    confirmLabel: spec.confirmLabel,
    // 删除在对话框内完成：请求期间按钮转圈，失败留在原地显示原因（不必重新确认一遍）
    action: async () => {
      await api.patch(item, { isDelete: true });
      const selection = new Map(store.get().selection);
      selection.delete(item.key);
      store.set({ selection });
      list.updateSelection(selection);
      list.removeItem(item.key); // 立刻收掉这一行，而不是等下一次整页刷新
      // **不等**统计：对话框的退场绝不能再拴一次网络往返 —— 那会把「行已经没了」与「框开始
      // 淡出」隔开一整个往返（真机实测：统计接口慢 500ms 时，行 25ms 开始淡出、对话框 578ms
      // 才 close ⇒ 读起来就是"明明已经关了，过一会儿才动画关闭"）。计数晚 ~200ms 落地没关系，
      // 列表由对话框关闭后的 `refresh({silent:true})` 对账。**这条对下面每一处都成立。**
      void refreshStats();
    },
  });
  if (!ok) return false;
  list.restoreFocus(); // 对话框已关闭：把焦点交给邻居行（触发它的按钮随行一起没了）
  toasts.info('已删除');
  await refresh({ silent: true }); // 补齐本页缺的那一条并对账其余行
  return true;
}

// 恢复：回收站里唯一的写操作。服务端只对「已删除且数据文件名为空」的记录放开（db.ts 的守卫），
// 带数据文件的行在列表里已禁用按钮，这里再兜一次错误——用户可能用旧页面点它。
async function restoreItem(item) {
  try {
    await api.patch(item, { isDelete: false });
    const selection = new Map(store.get().selection);
    selection.delete(item.key);
    store.set({ selection });
    list.removeItem(item.key); // 恢复后它不再属于回收站，就地收行
    list.restoreFocus(); // 没有对话框，焦点直接交给邻居行
    await refreshStats();
    toasts.info('已恢复');
    await refresh({ silent: true });
    return true;
  } catch (error) {
    if (handleAuthError(error)) return false;
    if (error.status === 404) {
      toasts.error('这条记录已经不在服务器上了（可能已被「彻底删除」或由清理任务删除）');
      return false;
    }
    if (error.status === 409) {
      // 同上：恢复的 409 只提示不刷新，会让回收站里那一行继续显示过期状态
      toasts.error('记录已被其他设备修改，已刷新为最新状态');
      await refresh({ silent: true });
      return false;
    }
    toasts.error(`恢复失败：${error.message}`);
    return false;
  }
}

// ===== 批量操作 =====
// 四个批量动作（收藏 / 置顶 / 删除 / 恢复）共用这一条骨架：一次请求 → 就地更新界面。
// 差别只在"要不要先问一句"与"成功后怎么收行"，故不各写一遍请求与失败处理。
//
// 2026-09-18：**只有销毁性的两个（删除、清空回收站）过确认框**。收藏/置顶/恢复是可逆的
// 低风险动作，让用户为"收藏这 12 条"再确认一次是纯多出来的一步（评审结论）；
// 而删除要付出的代价（数据文件立即清除）必须当面说清，那条摩擦保留。
async function runBatch({
  update,
  title,
  message,
  confirmLabel,
  applyLocally,
  destructive = true,
  items: explicitItems = null,
}) {
  // `items` 可由调用方预筛（批量恢复会剔掉带数据文件的那几条）；默认就是整个选区。
  const items = explicitItems ?? [...store.get().selection.values()];
  if (items.length === 0) return false;

  const apply = async (context) => {
    const result = await api.batchUpdate(items, update, {
      onProgress: context?.setMessage
        ? (done, total) => context.setMessage(batchProgressText(done, total))
        : undefined,
      signal: context?.signal,
    });
    // 用户在途按了「中止」：已发出去的那一批跑完了、后面的没发。这不是失败，如实报"停下之前
    // 生效了多少"，界面对账一次即可（服务端的每一批都是原子的，不会有半条）。
    if (result.aborted) {
      await refresh({ silent: true });
      throw new Error(batchAbortedText(result.updated));
    }
    // 服务端是**逐条**判定的：落空通常只是少数几条（被别的设备改过、或已经不在服务器上了），
    // 而其余几十条已经生效。故先把界面拉回事实，再如实报出条数 —— 原文案「有 N 条未生效，
    // 请刷新后重试」读起来像整体失败，会让用户白重做一遍（2026-09-21 实测后改）。
    // 报在哪里由**有没有对话框**决定：销毁性动作在框里说（用户按下的地方），其余走提示条。
    if (result.failed) {
      await refresh({ silent: true });
      const text = batchPartialText(result.updated, result.failed);
      if (destructive) throw new Error(text);
      toasts.error(text);
      return false; // 没有全部生效：调用方据此不要再报"已收藏 N 条"
    }
    applyLocally(items);
    store.set({ selection: new Map() });
    list.updateSelection(new Map());
    void refreshStats();
    return true;
  };

  if (!destructive) {
    let allApplied = false;
    try {
      allApplied = (await apply()) !== false;
    } catch (error) {
      if (handleAuthError(error)) return false;
      // 这里只剩**请求本身**失败（部分未生效那条路已在 apply 内用提示条报过）
      toasts.error(`批量操作失败：${error.message}`);
      await refresh({ silent: true });
      return false;
    }
    await refresh({ silent: true });
    list.restoreFocus();
    return allApplied;
  }

  const ok = await confirm.ask({ title, message, confirmLabel, action: apply });
  // 无论成败都对账一次：批量是服务端**逐条**判定的，失败时也可能有一部分已经生效，
  // 界面停在旧状态比慢一点更糟。
  await refresh({ silent: true });
  if (!ok) return false;
  list.restoreFocus(); // 来源是选择条上的按钮，它会被隐藏——别让焦点落到 <body>
  return true;
}

// 批量收藏 / 置顶：方向由选区**当前状态**决定（选中的都已是「已收藏」→ 取消收藏），
// 与选择条按钮的文案同源（list.js 用同一判据算标签）。
async function batchFlag(action) {
  const chosen = [...store.get().selection.values()];
  if (chosen.length === 0) return false;
  const field = action === 'star' ? 'starred' : 'pinned';
  const label = field === 'starred' ? '收藏' : '置顶';
  const value = !chosen.every((item) => item[field]);
  const verb = value ? label : `取消${label}`;
  const ok = await runBatch({
    update: { [field]: value },
    title: `${verb}选中的 ${chosen.length} 条？`,
    message: '这个状态会同步到所有设备，并在当前列表里就地更新。',
    confirmLabel: `${verb} ${chosen.length} 条`,
    // 可逆、无数据损失：不问，直接做（错了再点一次即可反向）
    destructive: false,
    applyLocally: (items) => {
      for (const item of items) list.patchItem({ ...item, [field]: value });
    },
  });
  if (ok) toasts.info(`已${verb} ${chosen.length} 条`);
  return ok;
}

async function batchRestore() {
  const chosen = [...store.get().selection.values()];
  if (chosen.length === 0) return false;
  const ok = await runBatch({
    update: { isDelete: false },
    title: `恢复选中的 ${chosen.length} 条？`,
    // 2026-09-22（ADR D29）：**不再预筛 `hasData`** —— 真回收站保留了数据，带数据文件的记录
    // 恢复时会连数据一起回来（服务端那条"有数据就不许恢复"的守卫已经去掉）。
    message: '这些记录会回到历史列表，数据文件一并恢复。',
    confirmLabel: `恢复 ${chosen.length} 条`,
    // 恢复同样可逆（再删一次即可），且失败条数会在提示条里如实报出
    destructive: false,
    applyLocally: (items) => {
      for (const item of items) list.removeItem(item.key);
    },
  });
  if (ok) toasts.info(`已恢复 ${chosen.length} 条`);
  return ok;
}

// 彻底删除（回收站）：**不可恢复**，故过确认框；服务端只删已删除的行（判据写在 SQL 里，
// 活跃记录走不到这条路径）。与软删相比它更便宜（每条 1 次 D1 子请求，不广播、不碰 R2），
// 所以批量时进度通常一闪而过 —— 但 300 条仍是 3 批，进度照样写进框里。
async function purgeItem(item) {
  const spec = purgeConfirmSpec(item);
  const ok = await confirm.ask({
    title: spec.title,
    message: spec.message,
    confirmLabel: spec.confirmLabel,
    action: async () => {
      const result = await api.batchPurge([item]);
      if (result.failed) {
        // 唯一可能的落空：它已经不在回收站里了（别的标签页清空过、或清理任务硬删了）
        await refresh({ silent: true });
        throw new Error('这条记录已经不在回收站里了（可能已被清空或由清理任务删除），列表已刷新。');
      }
      const selection = new Map(store.get().selection);
      selection.delete(item.key);
      store.set({ selection });
      list.updateSelection(selection);
      list.removeItem(item.key); // 立刻收行，不等下一次整页刷新
      void refreshStats();
    },
  });
  if (!ok) return false;
  list.restoreFocus();
  toasts.info('已彻底删除');
  await refresh({ silent: true }); // 补齐本页缺的那一条并对账其余行
  return true;
}

// 批量彻底删除：就是"移除少量/中量/大量"的那个出口 —— 没有它只能整罐倒（清空回收站）。
async function batchPurge() {
  const chosen = [...store.get().selection.values()];
  if (chosen.length === 0) return false;
  const spec = batchPurgeConfirmSpec(chosen.length);
  const ok = await confirm.ask({
    title: spec.title,
    message: spec.message,
    confirmLabel: spec.confirmLabel,
    action: async (context) => {
      const result = await api.batchPurge(chosen, {
        onProgress: (done, total) => context?.setMessage?.(batchProgressText(done, total)),
        signal: context?.signal,
      });
      if (result.aborted) {
        await refresh({ silent: true });
        throw new Error(batchAbortedText(result.purged));
      }
      if (result.failed) {
        await refresh({ silent: true });
        throw new Error(batchPartialText(result.purged, result.failed));
      }
      for (const item of chosen) list.removeItem(item.key);
      store.set({ selection: new Map() });
      list.updateSelection(new Map());
      void refreshStats();
    },
  });
  await refresh({ silent: true });
  if (!ok) return false;
  list.restoreFocus();
  toasts.info(`已彻底删除 ${chosen.length} 条`);
  return true;
}

// 批量复制（2026-09-18）：一次 batch-meta 拿到**完整正文**（列表里的正文被服务端截断到
// 500 字符，直接拼列表值等于把几条剪贴板各砍一半），单次 100 条的上限由 api.batchMeta 分片。
// 只复制**文本**记录：非文本记录的 text 是文件名，拼进去只会得到一串 .bin；
// 跳过的条数在提示里如实报出，而不是静默少给几条。
async function batchCopy() {
  const chosen = [...store.get().selection.values()];
  if (chosen.length === 0) return false;

  let full;
  try {
    full = await api.batchMeta(chosen);
  } catch (error) {
    if (handleAuthError(error)) return false;
    toasts.error(`取全文失败：${error.message}`, {
      action: { label: '重试', run: () => void batchCopy() },
    });
    return false;
  }

  // 服务端按 D1 的行序返回（`readBatchMeta` 没有 ORDER BY），这里按**选中顺序**重排 ——
  // 用户拼出来的选择顺序就是他要粘贴的顺序。
  const byKey = new Map(full.map((item) => [item.key, item]));
  const texts = [];
  let skipped = 0;
  for (const picked of chosen) {
    const item = byKey.get(picked.key);
    // 取全文的这段时间里被别的设备删了：少给这一条，不计入"跳过"（那不是类型问题）
    if (!item) continue;
    if (item.type === 'Text' && (item.text ?? '') !== '') texts.push(item.text);
    else skipped += 1;
  }
  if (texts.length === 0) {
    toasts.error(`选中的 ${chosen.length} 条里没有可复制的文本内容`);
    return false;
  }

  // 多条之间空一行：粘到聊天框/编辑器里还分得开，而不是连成一句
  const payload = texts.join('\n\n');
  if (!(await writeText(payload))) {
    toasts.error(clipboardFailureHint(window.isSecureContext, '可以在预览里逐条复制。'));
    return false;
  }
  toasts.info(
    `已复制 ${texts.length} 条文本（${charCount(payload)} 个字符` +
      `${skipped > 0 ? `，跳过 ${skipped} 条非文本` : ''}）`,
  );
  return true;
}

async function batchDelete() {
  const chosen = [...store.get().selection.values()];
  if (chosen.length === 0) return false;
  // 逐条差异（哪些带数据文件）在批量场景下列举不过来，故共用文案把两种后果**都说出来**
  const spec = batchDeleteConfirmSpec(chosen.length);
  const ok = await runBatch({
    update: { isDelete: true },
    title: spec.title,
    message: spec.message,
    confirmLabel: spec.confirmLabel,
    applyLocally: (items) => {
      for (const item of items) list.removeItem(item.key);
    },
  });
  if (ok) toasts.info(`已删除 ${chosen.length} 条`);
  return ok;
}

// 清空回收站：服务端用一条 DELETE 批量清掉全部已删除记录（不是逐条走写路径）。
// 这**不可逆**——回收站的前提就是「30 天内还能恢复」，所以文案必须把代价说清。
async function emptyTrash() {
  const spec = clearHistorySpec('trash');
  const ok = await confirm.ask({
    title: spec.title,
    message: spec.message,
    confirmLabel: spec.confirmLabel,
    action: async () => {
      await api.clear('trash');
      store.set({ selection: new Map() });
      list.updateSelection(new Map());
      void refreshStats();
    },
  });
  if (!ok) return false;
  toasts.info('回收站已清空');
  await refresh({ silent: true });
  return true;
}

// 清空全部历史（活跃 + 回收站 + 数据文件）：部署信息对话框里的危险区调它。
async function clearAll() {
  const spec = clearHistorySpec('all');
  const ok = await confirm.ask({
    title: spec.title,
    message: spec.message,
    confirmLabel: spec.confirmLabel,
    action: async () => {
      const result = await api.clear('all');
      store.set({ selection: new Map() });
      list.updateSelection(new Map());
      void refreshStats();
      toasts.info(`已清空 ${result.deleted} 条记录`);
    },
  });
  if (!ok) return false;
  await refresh({ silent: true });
  return true;
}

// 打开预览时把这一条写进 URL 的 hash：链接可以直接分享或收藏（`/ui_v1/#Text-<hash>`）。
// 用 replaceState 而不是 pushState——它不该在后退历史里塞一条记录。
function syncDeepLink(item) {
  history.replaceState(null, '', `${location.pathname}${location.search}#${item.type}-${item.hash}`);
}

async function previewItem(item) {
  if (item.type !== 'Text' || !item.textTruncated) {
    preview.open(item);
    syncDeepLink(item);
    return true;
  }
  // 长文本要一次额外往返：先把壳打开并说明在做什么，避免「点了没反应」
  preview.open(item, { loading: true });
  const full = await fetchFull(item, () => void previewItem(item));
  if (!full) {
    preview.close();
    return false;
  }
  preview.open(full);
  syncDeepLink(full);
  return true;
}

// ===== 深链接 =====
// `#Text-<hash>`：打开页面即预览那一条，跨设备贴一条链接就能定位到同一份内容。
// 用 hash 而不是 query string：筛选状态已经占了 query（见 filters.js），两者互不干扰。
const DEEP_LINK = /^#([A-Za-z]+)-([0-9A-Fa-f]{8,128})$/;

async function openDeepLink() {
  const match = DEEP_LINK.exec(location.hash);
  if (!match) return;
  const [, type, hash] = match;
  try {
    const item = await api.get({ type, hash });
    if (item) await previewItem(item);
  } catch (error) {
    if (handleAuthError(error)) return;
    // 记录已被删除或被清理时说清原因，而不是静默什么都不发生
    if (error.status === 404) toasts.error('链接指向的记录已不存在');
  }
}

async function copyItem(item, knownText) {
  try {
    let text = knownText;
    if (text === undefined) {
      const full = await fetchFull(item, () => void copyItem(item));
      if (!full) return false;
      text = full.text;
    }
    if (await writeText(text)) {
      toasts.info(`已复制 ${charCount(text)} 个字符`);
      return true;
    }
    // 带"重试"：剪贴板写入失败多半是权限/焦点这类瞬时原因，让用户能在原地再来一次，
    // 而不是先关掉预览、再去列表里找那一行（那正是刚刚失败的那一步）。
    toasts.error(clipboardFailureHint(window.isSecureContext, '已打开预览，可手动选中复制。'), {
      action: { label: '重试', run: () => void copyItem(item, text) },
    });
    preview.open(item, { text });
    return false;
  } catch {
    return false; // 401 已跳转
  }
}

// 图片复制：clipserver 的行内复制按类型分发，图片走 ClipboardItem。
// 失败路径与文本一致——降级到预览，而不是静默。
async function copyImage(item) {
  let blob;
  try {
    // 走 `api.fetchData` 而**不是裸 `fetch`**（这条路此前两件事同时缺失）：没有超时 —— 连接半开时
    // fetch 永不 settle，调用方的 `setPending` 永远清不掉，那个按钮就一直转圈、且
    // `data-loading` 的 `pointer-events: none` 让人点不动它；也没有 401 处理 —— 会话过期时只报一句
    // 「读取图片失败」而不回登录页。理由见 `api.js` 的 `requestBlob`。
    blob = await api.fetchData(item);
  } catch (error) {
    if (handleAuthError(error)) return false;
    // `data_missing` 是终态（对象确实不在服务器上了）→ 不给重试；其余是瞬时故障 → 给
    const missing = error?.payload?.error === 'data_missing';
    toasts.error(
      missing ? '数据不可用：服务器上已找不到这张图片' : `读取图片失败：${error?.message ?? error}`,
      missing ? {} : { action: { label: '重试', run: () => void copyImage(item) } },
    );
    return false;
  }

  try {
    const result = await writeImage(blob);
    if (result.status === 'ok') {
      toasts.info('已复制图片');
      return true;
    }
    toasts.error(
      result.status === 'unsupported'
        ? '当前环境不支持复制图片（剪贴板写入需要 https 或 localhost），已打开预览'
        : `${clipboardFailureHint(window.isSecureContext, '已打开预览。')}（${result.reason ?? '浏览器拒绝写入'}）`,
      // 环境不支持重试也没用；"被拒绝"（权限/焦点）值得再来一次
      result.status === 'unsupported' ? {} : { action: { label: '重试', run: () => void copyImage(item) } },
    );
    preview.open(item);
    return false;
  } catch (error) {
    toasts.error(`复制图片失败：${error.message}`);
    return false;
  }
}

// 「复制最近一条」（2026-09-18）：网页端最需要的一条捷径 —— 真实场景是"我在手机上复制了东西，
// 现在想在电脑上粘出来"。此前要先找到那一行（还得知道排序是创建时间倒序）再点它的复制键；
// 这个入口把那条路径压成一次点击，且**不受当前筛选/排序影响**（取的是全库最新的一条）。
// 非文本的记录分两种处置：图片走同一套「复制图片」实现（复用它的权限/降级分支），
// 文件与文件夹则说清"该用行内下载" —— 不发明一个"复制文件"的动作。
async function copyLatest(button) {
  if (isPending(button)) return false;
  setPending(button, true);
  try {
    const item = await api.latest();
    if (!item) {
      toasts.error('服务器上还没有任何记录');
      return false;
    }
    if (item.type !== 'Text') {
      if (itemIsImage(item)) return await copyImage(item);
      toasts.error(
        `最近一条是${typeLabel(item.type)}（${item.dataName ?? '无文件名'}），请在列表里用行内的「下载」取回。`,
      );
      return false;
    }
    // 列表端点会把正文截断，故先补一次单条取全文（与行内复制走的是同一条路径）
    const full = item.textTruncated ? await api.get(item) : item;
    const text = full?.text ?? '';
    if (text === '') {
      toasts.error('最近一条是空文本，没有可复制的内容');
      return false;
    }
    if (await writeText(text)) {
      flashSuccess(button, { label: '已复制' });
      toasts.info(`已复制最近一条（${charCount(text)} 个字符）`);
      return true;
    }
    toasts.error(clipboardFailureHint(window.isSecureContext, '可以在列表里打开那一行手动复制。'), {
      action: { label: '重试', run: () => void copyLatest(button) },
    });
    return false;
  } catch (error) {
    if (handleAuthError(error)) return false;
    toasts.error(`取最近一条失败：${error.message}`, {
      action: { label: '重试', run: () => void copyLatest(button) },
    });
    return false;
  } finally {
    setPending(button, false);
  }
}

// 把一段 Blob 落到磁盘（文件下载与文本下载共用）。单独成函数是因为它有一段**必须成对**的
// 资源管理：object URL 要在点击之后延迟回收（立刻 revoke 会让部分浏览器取消下载）。
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function downloadItem(item) {
  let blob;
  try {
    // 同 `copyImage`：走 `api.fetchData`（超时 + 401 统一处理），而不是裸 `fetch`。
    blob = await api.fetchData(item);
  } catch (error) {
    if (handleAuthError(error)) return false;
    // 对象确实不在了就不给重试（终态）；其余按瞬时故障处理
    const missing = error?.payload?.error === 'data_missing';
    toasts.error(
      missing ? '数据不可用：服务器上已找不到这个文件' : `下载失败：${error?.message ?? error}`,
      missing ? {} : { action: { label: '重试', run: () => void downloadItem(item) } },
    );
    return false;
  }

  try {
    // 名字走同一个安全化入口（服务端给的是 basename，但那是客户端上传时带来的，不可信）
    saveBlob(blob, safeFileName(item.dataName ?? '', `${item.type}-${item.hash.slice(0, 8)}`));
    return true;
  } catch (error) {
    toasts.error(`下载失败：${error.message}`);
    return false;
  }
}

// 文本下载（2026-09-18，用户要求："文本也可以下载"；同日追加："有原文件时保留原扩展名"）。
//
// 两条分支，判据是**服务端到底有没有这个文件**：
//   · 有（`hasData`）→ 走文件那条路：取回**原字节**、用**原名**（`notes.md` 就叫 `notes.md`）。
//     这时"下载文本"和"下载文件"是同一件事，分成两套实现只会让同一条记录两次下载内容不同。
//   · 没有（内联文本，对象存储里根本没有它）→ 把**正文**包成 `text/plain` 存成
//     `<type>-<hash 前 8 位>.txt`。列表里的正文被截断到 500 字符，故 `textTruncated` 时必须先取全文
//     （与复制、预览走同一条 `fetchFull`），否则会存下一个半截文件。
async function downloadTextItem(item) {
  try {
    if (item.hasData) return await downloadItem(item);
    const full = item.textTruncated ? await api.get(item) : item;
    if (!full) return false;
    const text = full.text ?? '';
    if (text === '') {
      // 空文本存成空文件没有意义，说清原因比给一个 0 字节的 .txt 好
      toasts.error('这条记录是空文本，没有可下载的内容');
      return false;
    }
    const name = downloadNameForText(item);
    saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), name);
    toasts.info(`已下载 ${name}（${charCount(text)} 个字符）`);
    return true;
  } catch (error) {
    if (handleAuthError(error)) return false;
    toasts.error(`下载文本失败：${error.message}`, {
      action: { label: '重试', run: () => void downloadTextItem(item) },
    });
    return false;
  }
}

async function openInfo() {
  // 这个对话框里**全是会变的状态**：清理任务的最近一次运行 / 上次失败 / 续跑游标、
  // 服务端时间与本机时钟差、存储占用。此前只在 `!state.info` 时取一次 —— 于是第二次
  // 打开看到的是首屏那一刻的快照（打开两次的间隔里清理可能已经跑过一轮）。
  // 现在的顺序是：有快照就先开壳（不必等一次往返），拿到新数据再覆盖重绘。
  const cached = store.get().info;
  if (cached) info.open(cached);
  try {
    const fresh = await api.info();
    store.set({ info: fresh });
    // 清理状态/上次失败就在这份 info 里，顺手把排障条刷新一次（用户正在填表单时不重绘对话框）
    stats.setHealth(healthSnapshot());
    // 这一次往返（本地 ~10ms，线上可能上百毫秒）里用户可能已经在填「保留策略」那两个输入框：
    // 重绘会整块 replaceChildren，把刚敲进去的值清掉。正在输入时不覆盖，下次打开自然会是最新的。
    const editing = document.activeElement instanceof HTMLInputElement;
    if (!editing) info.open(fresh);
  } catch (error) {
    if (handleAuthError(error)) return;
    // 首屏就失败（没有任何快照）：仍然开壳，open(null) 会指出「暂时取不到部署信息」
    if (!cached) info.open(null);
  }
}

// theme-color 要跟随**生效**主题（应用内开关），不能只靠 media 查询跟随系统
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
}

function toggleTheme() {
  const next = store.get().theme === 'dark' ? 'light' : 'dark';
  store.set({ theme: next });
  document.documentElement.dataset.theme = next;
  syncThemeColor();
  try {
    localStorage.setItem('sb-ui-theme', next);
  } catch {
    /* 隐私模式下写不了 localStorage：本次会话内仍生效 */
  }
  syncHeader();
}

async function logout() {
  try {
    await api.logout();
  } catch {
    /* 即便请求失败也要回登录页 */
  }
  location.replace(`${PAGE_BASE}/login.html`);
}

// ===== 轮询 =====
// 只取一个 (行数, 最大 LastModified) 的变更信号，比每次拉整页便宜得多。
let marker = null;
let pollTimer = 0;
// 后台标签里"错过了变更"的旗子（2026-09-18）：后台轮询照样在跑，但刷新被 visibility 挡住
// （省一次 D1 读 + 一次渲染）。此前只是**照样推进 marker** —— 于是切回前台时比较结果是
// "没变"，列表就停在离开时的样子，直到下一次写入或手动刷新。现在把"错过"记下来，
// 回前台补一次刷新；没变化时不多发任何请求。
let missedWhileHidden = false;

async function pollOnce() {
  const ticket = pollGate.begin();
  try {
    const next = await api.poll(ticket.signal);
    // 迟到的旧信号不能改写 marker：marker 被旧值覆盖后，下一次比较会误判
    // （要么漏掉一次真正的变更，要么把同一变更重复当成新变更）。
    if (!pollGate.isCurrent(ticket)) return;
    setStale(false);
    // 服务端时间 → 时钟差；最新一条记录的 LastModified → 「最近一次变更」。
    // 两者都由这一次轮询顺带带回（服务端在 /ui/api/poll 里一起给），不额外发请求。
    if (typeof next.serverTime === 'string') {
      const server = Date.parse(next.serverTime);
      if (!Number.isNaN(server)) clockOffsetMs = server - Date.now();
    }
    if (typeof next.lastModified === 'number') lastChangeMs = next.lastModified;
    // 这两个数就是排障条上「最近同步 / 时钟差」的来源，故每次轮询顺手重画一次
    // （只改文本，不发请求；失联时它们保持不变，横幅负责说明为什么）。
    stats.setHealth(healthSnapshot());
    // 首屏合成快照一次都没落地时补一次（`refreshOverview` 的注释里原本就承诺了这件事，
    // 但此前没有任何代码实现它 ⇒ 统计条会永久空着）。**只在这次轮询成功之后**补，
    // 所以服务端不可达时不会叠加请求；成功一次后 `stats` 非空，这条分支自然关掉。
    if (store.get().stats === null) void refreshOverview();
    const signature = `${next.count}:${next.lastModified}`;
    const changed = marker !== null && signature !== marker;
    marker = signature;
    if (changed) {
      if (document.visibilityState === 'visible') {
        await refresh({ silent: true, flash: true });
        // 有写入才可能改变某根柱子的高度（见 refreshActivity 的说明）
        void refreshActivity();
      } else {
        missedWhileHidden = true;
      }
    }
  } catch (error) {
    if (ticket.signal.aborted) return;
    if (handleAuthError(error)) return;
    if (serverUnreachable(error)) setStale(true);
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const base = document.visibilityState === 'visible' ? POLL_INTERVAL_VISIBLE : POLL_INTERVAL_HIDDEN;
  // 推送在线时降为看门狗（间隔取两者较大者）：它不是「可以不刷新」，而是「不必刷得那么勤」
  const delay = pushChannel.state === 'live' ? Math.max(base, POLL_INTERVAL_WATCHDOG) : base;
  pollTimer = setTimeout(async () => {
    await pollOnce();
    schedulePoll();
  }, delay);
}

// ===== 快捷键 =====
// 只加一个 `/`（聚焦搜索）：功能页面的快捷键贵在少而稳，多了就是和浏览器抢键。
// 输入框内、对话框打开时、带修饰键时一律让路。
function installShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== '/') return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    ) {
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    toolbar.focusSearch();
  });
}

// ===== 启动 =====

async function boot() {
  // 同一文档里被重复求值（例如应用被以 `/ui_v1` 与 `/ui_v1/` 两个 URL 同时加载时，
  // 模块图会出现两份）会让第二次求值再做一遍**模块级的副作用**、并让第二次 boot 找不到
  // 已被替换掉的挂载点，得到半渲染的页面。实测触发过，故在文档上留一个标记。
  //
  // ⚠️ 守卫必须是**这个函数的第一句**（2026-09-18 修）：此前它排在 `initNoticeBar()` 之后，
  // 于是重复求值的那一份仍会多做一遍模块级的接线 —— 守卫管不到它本该管的东西。
  // （提示条那一处已在 2026-09-19 随提示条一起删除，见 `docs/ui-rename-v1-v2.md`。）
  // 模块级那几行（`createToasts` / `createConfirm` / …）在**模块求值时**就往 body 里塞
  // 常驻 `<dialog>`，那一段这里管不到，见 `docs/archive/AUDIT-v1-v2-divergence.md` §4.1
  // （V2 的解法是把这些创建搬进守卫之后）。
  const root = document.documentElement;
  if (root.dataset.appBooted === '1') return;
  root.dataset.appBooted = '1';

  const session = await api.session();
  if (!session.authenticated) {
    redirectToLogin();
    return;
  }

  store.set({ username: session.username, version: session.version });

  document.getElementById('app-header').append(header.el);
  document.getElementById('stats').replaceWith(stats.el);
  // 必须 replaceWith：挂载点本身已经是 <div class="toolbar">，
  // 用 append 会套出双层工具栏（外层成了只含一个子项的 flex 容器，
  // padding/换行/收缩都作用在错误的那一层）
  document.getElementById('toolbar').replaceWith(toolbar.el);
  document.getElementById('results-mount').replaceChildren(list.el);
  document.getElementById('pagination').replaceWith(pagination.el);

  // 这一帧画的是**骨架**，不是空状态：store 的 `loading` 初始为 true，列表据此走加载档。
  // 此前这里画的是一句确定的「还没有任何记录」——而数据请求还没发出去，
  // 于是首屏的等待被读成"库里一条都没有"（2026-09-18 修）。
  render();
  // 首屏两次请求：列表 + 合成快照（见 refreshOverview 的说明）。
  // 快照落地后统计条、变更标记与排障面一起就位，故这里不再单独调 refreshStats()。
  //
  // 为什么**不**把 `refresh()` 提到 `await api.session()` 之前并发出去（那能省一个往返）：
  // ① 未登录时两条路会各自跳一次登录页，多一个必然 401 的请求；
  // ② V2 的 `boot.js` 也是这个次序（它同样写了"未登录直接跳登录页，不把骨架屏留给用户"），
  //    两版的分歧要能解释得清——省下的那一次往返换不来这个代价。
  await Promise.all([refresh(), refreshOverview()]);
  // 趋势晚一拍：先让列表落地，再补这张锦上添花的图
  void refreshActivity();
  await pollOnce();
  schedulePoll();
  // 只在**可见**时起推送：后台开的标签页里心跳会被节流到 1 分钟以上，连上也是反复断开重连
  // （每次重连 = 一次票据 POST + 一次 WS + 一次 DO 唤醒），比它省下的轮询还贵。转前台时再连。
  if (document.visibilityState === 'visible') pushChannel.start();
  installShortcuts();
  // 深链接在首屏数据到位之后再打开：`#Text-<hash>` 要预览的那条可能不在当前页，
  // 走单条端点取（api.get），与列表是否包含它无关。
  await openDeepLink();
  window.addEventListener('hashchange', () => void openDeepLink());

  window.addEventListener('popstate', () => {
    const before = store.get().filters.deleted;
    const filters = filtersFromUrl();
    store.set({ filters });
    refresh({ silent: true });
    // 后退/前进也可能在活跃列表与回收站之间切换，计数同样要跟上
    if (Boolean(filters.deleted) !== Boolean(before)) void refreshStats();
  });

  // 前后台切换时开关推送通道，而不是让它带着半死连接硬撑：
  // 隐藏页的定时器会被浏览器节流到 ≥1 分钟，30 秒心跳必然漏掉 DO 的 60 秒静默窗口 ——
  // 那条路会退化成「断开 → 退避重连」的抖动，每次重连都要一次票据 POST + 一次 WS + 一次 DO 唤醒，
  // 比省下来的轮询还贵，而且连接不断时 DO 永不休眠（计费）。
  // 隐藏期间交给既有的 30 秒轮询兜着，回前台再重连。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // 后台期间错过的变更在这里补上（见 missedWhileHidden 的说明）。顺序放在 pollOnce 之前：
      // 先让列表追上，轮询那一次只是刷新 marker 与"最近同步"显示。
      if (missedWhileHidden) {
        missedWhileHidden = false;
        void refresh({ silent: true, flash: true });
        void refreshActivity();
      }
      void pollOnce();
      pushChannel.start();
      schedulePoll();
    } else {
      pushChannel.stop();
      schedulePoll();
    }
  });
}

boot().catch((error) => {
  if (!handleAuthError(error)) toasts.error(`初始化失败：${error.message}`);
});
