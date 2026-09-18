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
import { withViewTransition } from './dom.js';
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
  viewToken: 0,
  loading: true,
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
});

const toasts = createToasts(document.getElementById('toasts'));
const confirm = createConfirm();
const preview = createPreview({ onCopy: copyItem, onCopyImage: copyImage, onDownload: downloadItem });
const info = createInfo({ onCopyText: copyPlainText });

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
  const next = { ...store.get().filters, ...patch };
  store.set({ filters: next, viewToken: store.get().viewToken + 1 });
  syncUrl(next, { push });
  // 结果区在首屏之外（用户滚下去看过）时，换页/改筛选要把它带回视野，
  // 否则「点了下一页」只换了脚下看不见的内容。
  refresh().finally(() => {
    if (scroll) scrollToResults();
  });
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
  onStar: starItem,
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
  onSearch: actions.onSearch,
  onPageSize: actions.onPageSize,
  onRefresh: actions.onRefresh,
});
const list = createList(actions);
const pagination = createPagination({ onPage: actions.onPage });

// ===== 渲染 =====
function render() {
  const state = store.get();
  header.update({ username: state.username, version: state.version, theme: state.theme });
  stats.update(state.stats);
  toolbar.update({ filters: state.filters, byType: state.stats?.byType });
  list.update(state);
  pagination.update({ page: state.filters.page, pageSize: state.filters.pageSize, total: state.total });
}

// ===== 数据 =====
async function refresh({ silent = false, flash = false, announce = false } = {}) {
  const state = store.get();
  const previousKeys = new Set(state.items.map((item) => item.key));

  if (!silent) list.el.setAttribute('data-busy', 'true');

  try {
    const page = await api.list(filtersToApi(state.filters));
    const flashKeys = flash
      ? new Set(page.items.filter((item) => !previousKeys.has(item.key)).map((item) => item.key))
      : new Set();

    // 新视图（换页/改筛选）才做入场错峰；轮询刷新不做，否则每次刷新整页闪一遍。
    // 同一视图内的刷新走 list 内部的按行对账：内容没变的行不重建。
    const mutate = () => {
      store.set({ items: page.items, total: page.total, flashKeys, loading: false });
      render();
    };
    // 翻页/改筛选走视图过渡，让结果区看起来是同一个面在换内容
    const shouldTransition = !silent && !flash;
    if (shouldTransition) withViewTransition(mutate);
    else mutate();

    if (announce) toasts.info(`已刷新，共 ${page.total} 条记录`);
  } catch (error) {
    if (handleAuthError(error)) return;
    const message = `无法读取历史记录：${error.message}`;
    if (store.get().items.length === 0) {
      // 首屏失败：给出可操作的错误态，而不是把骨架屏永远留在那里
      list.showError(message, () => refresh());
    } else {
      toasts.error(message);
    }
  } finally {
    list.el.removeAttribute('data-busy');
  }
}

async function refreshStats() {
  try {
    store.set({ stats: await api.statistics() });
    stats.update(store.get().stats);
    toolbar.update({ filters: store.get().filters, byType: store.get().stats?.byType });
  } catch (error) {
    handleAuthError(error);
  }
}

// ===== 单项操作 =====
// 收藏：结果就地反映在那一行（不重拉整页），并按方向播一次星标动画。
async function starItem(item, starred) {
  try {
    await api.patch(item, { starred });
    list.patchItem({ ...item, starred }, { pop: starred });
    void refreshStats();
    return true;
  } catch (error) {
    if (handleAuthError(error)) return false;
    toasts.error(error.status === 409 ? '记录已被其他设备修改，请刷新后重试' : `操作失败：${error.message}`);
    return false;
  }
}

async function deleteItem(item) {
  const ok = await confirm.ask({
    title: '删除这条记录？',
    message:
      item.type === 'Text'
        ? `将删除「${(item.text ?? '').slice(0, 40)}…」。所有同步设备上的这条记录也会被删除；服务端仍保留该记录（软删），30 天后才彻底清除。`
        : `将删除「${item.dataName ?? item.type}」。所有同步设备上的这条记录也会被删除；服务端仍保留该记录（软删），30 天后才彻底清除。`,
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
  toasts.info('已删除');
  await refresh({ silent: true }); // 补齐本页缺的那一条并对账其余行
  return true;
}

async function batchDelete() {
  const items = [...store.get().selection.values()];
  if (items.length === 0) return false;
  const ok = await confirm.ask({
    title: `删除选中的 ${items.length} 条记录？`,
    message: '这些记录会从所有同步设备上消失；服务端仍保留它们（软删），30 天后才彻底清除。',
    confirmLabel: `删除 ${items.length} 条`,
    action: async () => {
      const result = await api.batchDelete(items);
      if (result.failed) {
        // 留在对话框里报出原因：这里静默跳过失败项会让用户以为全删了
        throw new Error(`有 ${result.failed} 条删除失败（可能已被其他设备修改），请刷新后重试`);
      }
      store.set({ selection: new Map() });
      for (const item of items) list.removeItem(item.key);
      list.updateSelection(new Map());
      await refreshStats();
    },
  });
  if (!ok) return false;
  toasts.info(`已删除 ${items.length} 条`);
  await refresh({ silent: true });
  return true;
}

async function previewItem(item) {
  if (item.type !== 'Text' || !item.textTruncated) {
    preview.open(item);
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
  return true;
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
  header.update({ username: store.get().username, version: store.get().version, theme: next });
}

async function logout() {
  try {
    await api.logout();
  } catch {
    /* 即便请求失败也要回登录页 */
  }
  location.replace('/ui/login.html');
}

// ===== 轮询 =====
// 只取一个 (行数, 最大 LastModified) 的变更信号，比每次拉整页便宜得多。
let marker = null;
let pollTimer = 0;

async function pollOnce() {
  try {
    const next = await api.poll();
    const signature = `${next.count}:${next.lastModified}`;
    const changed = marker !== null && signature !== marker;
    marker = signature;
    if (changed && document.visibilityState === 'visible') await refresh({ silent: true, flash: true });
  } catch (error) {
    if (handleAuthError(error)) return;
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = document.visibilityState === 'visible' ? POLL_INTERVAL_VISIBLE : POLL_INTERVAL_HIDDEN;
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
  // 同一文档里被重复求值（例如应用被以 /ui 与 /ui/ 两个 URL 同时加载时，
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
  await pollOnce();
  schedulePoll();
  installShortcuts();

  window.addEventListener('popstate', () => {
    store.set({ filters: filtersFromUrl(), viewToken: store.get().viewToken + 1 });
    refresh({ silent: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void pollOnce();
      schedulePoll();
    }
  });
}

boot().catch((error) => {
  if (!handleAuthError(error)) toasts.error(`初始化失败：${error.message}`);
});
