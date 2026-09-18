// 装配点：只有这里知道「谁是谁」，组件之间互不认识。
//
// 数据流：actions（用户意图）→ store（状态）→ 组件 update（渲染）。
// 网络请求只发生在 actions 与轮询里，组件不碰 fetch。
//
// 约定：**actions 返回结果，组件呈现结果**。行内按钮的「进行中 → 成功」状态由组件自己管，
// 靠的是 action 的返回值（`true` 才算做成）——「发过请求」不等于「做成了」。
import { api, handleAuthError, redirectToLogin } from './api.js';
import { createStore } from './store.js';
import { filtersFromUrl, filtersToApi, syncUrl, DEFAULT_FILTERS } from './filters.js';
import { writeText, writeImage } from './clipboard.js';
import { debounce } from './dom.js';
import { createLatestGate } from './latest.js';
import { createPushChannel } from './signalr.js';
import { createHeader } from './components/header.js';
import { createStats } from './components/stats.js';
import { createToolbar } from './components/toolbar.js';
import { createList } from './components/list.js';
import { createPagination } from './components/pagination.js';
import { createPreview } from './components/preview.js';
import { createConfirm } from './components/confirm.js';
import { createToasts } from './components/toast.js';
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

// ===== 剪贴板 =====
// 写入机制（含安全上下文与降级）都在 js/clipboard.js；这里只决定「失败时怎么呈现」。
async function copyPlainText(text, label = '内容') {
  const ok = await writeText(text);
  if (ok) toasts.info(`已复制${label}`);
  else toasts.error('浏览器拒绝了剪贴板访问，请手动选择复制');
  return ok;
}

// 列表里的正文是截断过的：要复制/预览全文必须先取单条，否则用户拿到的是被砍掉一半的内容。
// 取不到（网络/401）返回 null，由调用方决定降级路径。
async function fetchFull(item) {
  if (!item.textTruncated) return item;
  try {
    return await api.get(item);
  } catch (error) {
    if (handleAuthError(error)) return null;
    toasts.error(`取全文失败：${error.message}`);
    return null;
  }
}

// ===== 动作 =====
function setFilters(patch, { push = false, scroll = false } = {}) {
  const state = store.get();
  const next = { ...state.filters, ...patch };
  // 类型计数与视图同源：回收站与活跃列表是**两套**计数，切视图时必须重取，
  // 否则分段控件显示的是另一套（列表头「回收站 · 共 938 条」、控件仍写「全部 1009」）。
  const viewChanged = Boolean(next.deleted) !== Boolean(state.filters.deleted);
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
  // 回收站是范围切换：进出都清空选择集（回收站里没有选择列），并回到第 1 页
  onToggleDeleted: () => {
    store.set({ selection: new Map() });
    list.updateSelection(store.get().selection);
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
  onBatchDelete: batchDelete,
  onBatchFlag: batchFlag,
  onBatchRestore: batchRestore,
  onEmptyTrash: emptyTrash,
};

const header = createHeader({
  onToggleTheme: toggleTheme,
  onLogout: logout,
  onInfo: openInfo,
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
  });
}

function render() {
  const state = store.get();
  syncHeader();
  stats.update(state.stats);
  toolbar.update({ filters: state.filters, byType: countsForView(state) });
  list.update(state);
  pagination.update({ page: state.filters.page, pageSize: state.filters.pageSize, total: state.total });
}

// ===== 数据 =====
// 三个独立的守卫：列表、统计、变更信号各自「最新请求胜出」——它们互相之间没有依赖，
// 共用一个守卫会让统计请求把列表请求 abort 掉（那是两件不同的事）。
const listGate = createLatestGate();
const statsGate = createLatestGate();
const pollGate = createLatestGate();

async function refresh({ silent = false, flash = false, announce = false } = {}) {
  const state = store.get();
  const previousKeys = new Set(state.items.map((item) => item.key));
  const ticket = listGate.begin();

  if (!silent) list.el.setAttribute('data-busy', 'true');

  try {
    const page = await api.list(filtersToApi(state.filters), ticket.signal);
    // 已有更新的请求在飞：这次的结果作废，**绝不能**写回 store
    // （写回就是「列表显示的内容与筛选控件不一致」——实测复现过的缺陷）。
    if (!listGate.isCurrent(ticket)) return;
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
    store.set({ items: page.items, total: page.total, flashKeys });
    render();

    if (announce) toasts.info(`已刷新，共 ${page.total} 条记录`);
  } catch (error) {
    // 被更新的请求 abort 掉不是失败：静默退出，由那次请求负责呈现
    if (ticket.signal.aborted) return;
    if (handleAuthError(error)) return;
    setStale(true);
    // 400 基本只有一个来源：搜索词超过服务端上限（48 字节，约 16 个汉字；协议与界面共用同一判定）。
    // 把服务端的校验串翻译成用户能懂的话，否则会看到「无法读取历史记录：SearchText must be at most 48 bytes」。
    const message =
      error.status === 400 && store.get().filters.search !== ''
        ? '搜索词过长：服务端上限 48 字节（约 16 个汉字），缩短后再试'
        : `无法读取历史记录：${error.message}`;
    if (store.get().items.length === 0) {
      // 首屏失败：给出可操作的错误态，而不是把骨架屏永远留在那里
      list.showError(message, () => refresh());
    } else {
      toasts.error(message);
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
    setStale(true);
    return;
  }
  if (!statsGate.isCurrent(ticket)) return;
  if (view !== store.get().filters.deleted) return; // 视图已切换：这份计数不属于当前视图
  setStale(false);
  // 绘制放在 fetch 的 try 之外：真出渲染异常时不该被当成网络失败（那正是遮蔽 bug 的藏身处）
  store.set({ stats: { ...data, view } });
  const current = store.get();
  stats.update(current.stats);
  toolbar.update({ filters: current.filters, byType: countsForView(current) });
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
    list.patchItem(adoptPatch(item, updated), { pop: field === 'starred' ? 'star' : 'pin' });
    void refreshStats();
    return true;
  } catch (error) {
    if (handleAuthError(error)) return false;
    toasts.error(error.status === 409 ? '记录已被其他设备修改，请刷新后重试' : `操作失败：${error.message}`);
    return false;
  }
}

async function deleteItem(item) {
  // 文案口径（与实现逐条对齐，见 docs/ui.md §5 第 4 条）：
  //   带数据文件 → 软删**立即清掉 R2 数据文件**（不可恢复），只有 D1 元数据保留 30 天；
  //   无数据文件（内联文本）→ 内容就在这一行里，30 天内可从回收站恢复。
  // 两者写成同一句话会骗人：说「30 天后才彻底清除」让人以为内容还在（对前者是错的），
  // 而说「不可恢复」又会让后者的用户白白放弃一次可用的恢复。
  const what =
    item.type === 'Text'
      ? `「${(item.text ?? '').slice(0, 40)}…」`
      : `「${item.dataName ?? item.type}」`;
  const after =
    item.hasData
      ? '服务端会立即清除数据文件（不可恢复），仅元数据保留 30 天后彻底清除。'
      : '这条记录没有数据文件，30 天内还能从回收站恢复。';
  const ok = await confirm.ask({
    title: '删除这条记录？',
    message: `将删除 ${what}。所有同步设备上的这条记录也会被删除；${after}`,
    // 删除在对话框内完成：请求期间按钮转圈，失败留在原地显示原因（不必重新确认一遍）
    action: async () => {
      await api.patch(item, { isDelete: true });
      const selection = new Map(store.get().selection);
      selection.delete(item.key);
      store.set({ selection });
      list.updateSelection(selection);
      list.removeItem(item.key); // 立刻收掉这一行，而不是等下一次整页刷新
      await refreshStats();
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
      toasts.error('这条记录的数据文件已被清除，服务端不再允许恢复');
      return false;
    }
    toasts.error(error.status === 409 ? '记录已被其他设备修改，请刷新后重试' : `恢复失败：${error.message}`);
    return false;
  }
}

// ===== 批量操作 =====
// 四个批量动作（收藏 / 置顶 / 删除 / 恢复）共用这一条骨架：确认 → 一次请求 → 就地更新界面。
// 差别只在确认文案与「成功后怎么收行」，故不各写一遍请求与失败处理。
async function runBatch({ update, title, message, confirmLabel, applyLocally }) {
  const items = [...store.get().selection.values()];
  if (items.length === 0) return false;
  const ok = await confirm.ask({
    title,
    message,
    confirmLabel,
    action: async () => {
      const result = await api.batchUpdate(items, update);
      // 失败项留在对话框里报出数量：静默跳过会让用户以为全部做成了
      if (result.failed) {
        throw new Error(`有 ${result.failed} 条未生效（可能已被其他设备修改），请刷新后重试`);
      }
      applyLocally(items);
      store.set({ selection: new Map() });
      list.updateSelection(new Map());
      await refreshStats();
    },
  });
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
    // 服务端只对「数据文件已清空」的记录放开恢复：带数据的记录在软删时数据已删，回不来。
    // 这句话必须说在前面——否则用户会以为失败是 bug，而不是服务端的既定语义。
    message: '没有数据文件的记录会回到历史列表；数据文件已随删除清除的会被服务端拒绝（未生效条数会如实显示）。',
    confirmLabel: `恢复 ${chosen.length} 条`,
    applyLocally: (items) => {
      for (const item of items) list.removeItem(item.key);
    },
  });
  if (ok) toasts.info(`已恢复 ${chosen.length} 条`);
  return ok;
}

async function batchDelete() {
  const chosen = [...store.get().selection.values()];
  if (chosen.length === 0) return false;
  const ok = await runBatch({
    update: { isDelete: true },
    title: `删除选中的 ${chosen.length} 条记录？`,
    message:
      '这些记录会从所有同步设备上消失；带数据文件的会立即清除数据文件（不可恢复），无数据文件的（内联文本）30 天内可从回收站恢复。仅元数据保留 30 天后彻底清除。',
    confirmLabel: `删除 ${chosen.length} 条`,
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
  const ok = await confirm.ask({
    title: '清空回收站？',
    message: '回收站里的记录会被彻底删除（元数据不再保留，无法恢复）。活跃记录不受影响。',
    confirmLabel: '彻底删除',
    action: async () => {
      await api.clear('trash');
      store.set({ selection: new Map() });
      list.updateSelection(new Map());
      await refreshStats();
    },
  });
  if (!ok) return false;
  toasts.info('回收站已清空');
  await refresh({ silent: true });
  return true;
}

// 清空全部历史（活跃 + 回收站 + 数据文件）：部署信息对话框里的危险区调它。
async function clearAll() {
  const total = store.get().stats?.totalCount ?? 0;
  const ok = await confirm.ask({
    title: '清空全部历史？',
    message: `将删除全部 ${total} 条记录及其数据文件（含回收站），无法恢复；各设备上的官方客户端会在下一次同步时同步这次清空。`,
    confirmLabel: '清空全部',
    action: async () => {
      const result = await api.clear('all');
      store.set({ selection: new Map() });
      list.updateSelection(new Map());
      await refreshStats();
      toasts.info(`已清空 ${result.deleted} 条记录`);
    },
  });
  if (!ok) return false;
  await refresh({ silent: true });
  return true;
}

// 打开预览时把这一条写进 URL 的 hash：链接可以直接分享或收藏（`/ui_old/#Text-<hash>`）。
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
  const full = await fetchFull(item);
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
      const full = await fetchFull(item);
      if (!full) return false;
      text = full.text;
    }
    if (await writeText(text)) {
      toasts.info(`已复制 ${text.length} 个字符`);
      return true;
    }
    toasts.error('浏览器拒绝了剪贴板访问，已打开预览供手动复制');
    preview.open(item, { text });
    return false;
  } catch {
    return false; // 401 已跳转
  }
}

// 图片复制：clipserver 的行内复制按类型分发，图片走 ClipboardItem。
// 失败路径与文本一致——降级到预览，而不是静默。
async function copyImage(item) {
  try {
    const response = await fetch(api.dataUrl(item), { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      toasts.error(
        payload?.error === 'data_missing'
          ? '数据不可用：服务器上已找不到这张图片'
          : `读取图片失败（${response.status}）`,
      );
      return false;
    }
    const result = await writeImage(await response.blob());
    if (result.status === 'ok') {
      toasts.info('已复制图片');
      return true;
    }
    toasts.error(
      result.status === 'unsupported'
        ? '当前环境不支持复制图片（剪贴板写入需要 https 或 localhost），已打开预览'
        : `复制图片失败：${result.reason ?? '浏览器拒绝写入'}，已打开预览`,
    );
    preview.open(item);
    return false;
  } catch (error) {
    toasts.error(`复制图片失败：${error.message}`);
    return false;
  }
}

async function downloadItem(item) {
  try {
    const response = await fetch(api.dataUrl(item), { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      toasts.error(
        payload?.error === 'data_missing'
          ? '数据不可用：服务器上已找不到这个文件'
          : `下载失败（${response.status}）`,
      );
      return false;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = item.dataName ?? `${item.type}-${item.hash.slice(0, 8)}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch (error) {
    toasts.error(`下载失败：${error.message}`);
    return false;
  }
}

async function openInfo() {
  const state = store.get();
  if (!state.info) {
    try {
      store.set({ info: await api.info() });
    } catch (error) {
      handleAuthError(error);
    }
  }
  info.open(store.get().info);
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
  location.replace('/ui_old/login.html');
}

// ===== 轮询 =====
// 只取一个 (行数, 最大 LastModified) 的变更信号，比每次拉整页便宜得多。
let marker = null;
let pollTimer = 0;

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
    const signature = `${next.count}:${next.lastModified}`;
    const changed = marker !== null && signature !== marker;
    marker = signature;
    if (changed && document.visibilityState === 'visible') {
      await refresh({ silent: true, flash: true });
      // 有写入才可能改变某根柱子的高度（见 refreshActivity 的说明）
      void refreshActivity();
    }
  } catch (error) {
    if (ticket.signal.aborted) return;
    if (handleAuthError(error)) return;
    setStale(true);
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
// 顶部提示条（"备用界面 · 默认界面在 /ui/"）是否已被关掉。
// 键名与登录页（js/login.js）共用：两处必须一致，否则在登录页关掉之后进列表页又会冒出来。
// 实现刻意各写一份（各约 10 行）而不是抽公共模块：为一个"关掉一条提示"的按钮新增
// `public/ui_old/js/*.js` 会同时牵动两页的 modulepreload 清单与 `docs/ui.md` 的资源计数守卫，
// 而这段逻辑没有会漂移的判据（读写同一个键、失败就静默保留提示条）。
const NOTICE_KEY = 'sb-ui-notice-dismissed';

function initNoticeBar() {
  const bar = document.getElementById('notice-bar');
  const close = document.getElementById('notice-bar-close');
  if (!bar || !close) return;
  try {
    if (localStorage.getItem(NOTICE_KEY) === '1') {
      bar.hidden = true;
      return;
    }
  } catch {
    /* 隐私模式读不到 localStorage：当作从没关过，继续显示提示条 */
  }
  close.addEventListener('click', () => {
    bar.hidden = true;
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      /* 写不了就只是"下次还显示"，不值得打断页面 */
    }
  });
}

async function boot() {
  // 提示条的接线在会话判定**之前**：未登录会被重定向，但那一下也该是可关闭的
  initNoticeBar();

  // 同一文档里被重复求值（例如应用被以 /ui 与 /ui_old/ 两个 URL 同时加载时，
  // 模块图会出现两份）会让第二次 boot 找不到已被替换掉的挂载点，得到半渲染的页面。
  // 实测触发过，故此处在文档上留一个标记。
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

  render();
  await Promise.all([refresh(), refreshStats()]);
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
