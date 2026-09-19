// 筛选状态 ⇄ URL。只做这一件事：解析、校验、序列化。
//
// 为什么筛选一定要进 URL：能被链接、能被后退按钮还原、刷新后不丢。这是功能型界面的基本要求，
// 也是「筛选看起来能用但一刷新就回到初始页」这类不完善感的来源。
//
// 时间范围有三种形态，URL 里都以**用户可读**的形式保存：
//   range=all|today|7d|30d   —— 预设，边界在每次请求时按"现在"重算（页面开一整天也不会停在旧窗口）
//   range=custom&after=&before= —— 自定义，毫秒时间戳；before 是**开区间上界**（对齐服务端 `CreateTime < before`）
// 预设不写死边界进 URL：否则分享出去的链接会随对方打开的时间而语义漂移。

// 本地日界：用户说「今天」指的是自己时区里的今天。实现与 `format.js` 的 `startOfDay` 同一条，
// 这里**转出**它而不是自己再实现一遍：它是"时间范围"这个概念的组成部分，
// 读 `filters.js` 的人不该为了理解范围边界再去翻另一个模块；
// 同时它保持 V1 的导出面（`test/ui-logic.test.ts` 直接测它，测的是边界语义，
// 与它在哪个模块里无关）。
export { startOfDay } from './format.js';
import { startOfDay } from './format.js';

/** 空结果先解释筛选条件，再解释所在视图。 */
export function emptyStateKind(filters) {
  const filtered = filters.types !== 'All' || filters.starred || filters.search !== '' || filters.range !== 'all';
  return filtered ? 'filter' : filters.deleted ? 'trash' : 'empty';
}

export const DEFAULT_FILTERS = {
  page: 1,
  pageSize: 50,
  types: 'All', // All | Text | Image | File | Group | 逗号组合（服务端收位掩码名或数字）
  starred: false,
  search: '',
  range: 'all',
  after: null, // epoch ms；仅 range === 'custom' 时使用
  before: null, // epoch ms（开区间上界）
  deleted: false, // 回收站视图：只看已删除的记录
  sort: 'createTime',
  order: 'desc',
};

// 页大小档位。**上限 500 必须出现在档位里** —— 它来自服务端白名单
// （`src/ui/query.ts` 的 `UI_MAX_PAGE_SIZE`），URL 手写 `pageSize=500` 时
// 下拉若能落到空选，读起来就像缺陷（V1 的 backend-gaps §1.5 记过这个坑）。
export const PAGE_SIZES = [20, 50, 100, 200, 500];

// 六个可排序字段与服务端 `SORT_COLUMNS` 白名单一一对应。V1 只把其中三个做成了可点表头，
// 另外三个只能手改 URL（backend-gaps §1.4）；V2 把它们全放进排序菜单。
export const SORT_FIELDS = [
  { value: 'createTime', label: '创建时间' },
  { value: 'lastModified', label: '修改时间' },
  { value: 'lastAccessed', label: '访问时间' },
  { value: 'size', label: '大小' },
  { value: 'type', label: '类型' },
  { value: 'id', label: '记录序号' },
];

export const RANGE_PRESETS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'custom', label: '自定义…' },
];

const TYPES = new Set(['All', 'Text', 'Image', 'File', 'Group']);
const SORTS = new Set(SORT_FIELDS.map((f) => f.value));
const RANGES = new Set(RANGE_PRESETS.map((r) => r.value));
function clampInt(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * 按**日历日**偏移，而不是 `± n × 86400000`（2026-09-18 修，对齐 V1 的 `addDays`）。
 *
 * 为什么：常数 24 小时在跨夏令时切换的时区里会落偏一小时 —— `startOfDay(now) - 6 * 86400000`
 * 可能指向前一天的 23:00，于是「近 7 天」从半天中间开始、两端各差一小时。`setDate()` 是
 * 日历运算，时区规则交给运行时。V1 在 `ui_v1/js/filters.js` 里早就改成了这条，注释逐字写着
 * "没有理由留一个**只在别人的时区里错**的算法" —— V2 漏了（`docs/AUDIT-v1-v2-divergence.md` §1.9）。
 */
function addDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** 预设范围 → `[after, before)` 的毫秒边界；`null` 表示该侧不设限。 */
export function rangeBounds(filters, now = Date.now()) {
  switch (filters.range) {
    case 'today':
      return { after: startOfDay(now), before: null };
    case '7d':
      return { after: addDays(startOfDay(now), -6), before: null };
    case '30d':
      return { after: addDays(startOfDay(now), -29), before: null };
    case 'custom':
      return { after: filters.after ?? null, before: filters.before ?? null };
    default:
      return { after: null, before: null };
  }
}

/** epoch ms → `<input type="date">` 的**本地**日期串。 */
export function toDateInput(ms) {
  if (ms === null || ms === undefined) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * `<input type="date">` 的值 → 毫秒边界。
 * `edge='start'`：该日 00:00（含）；`edge='end'`：次日 00:00（不含）—— 与服务端
 * `CreateTime < before` 对齐，否则「截止到今天」会把今天 00:00 之后的记录全部漏掉。
 */
export function fromDateInput(value, edge) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  // Date 构造函数对越界分量是**滚动**而不是报错（`2026-13-99` → 2027-04-09），
  // 故必须回读校验：解析出的年月日与输入一致才算合法日期。
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  // `edge='end'` 交的是**次日 00:00**，同样走日历运算（跨夏令时的那一天不是 24 小时）
  return edge === 'end' ? addDays(date.getTime(), 1) : date.getTime();
}

export function filtersFromUrl(search = location.search) {
  const params = new URLSearchParams(search);
  const typesRaw = params.get('types') ?? '';
  const sortRaw = params.get('sort') ?? '';
  const rangeRaw = params.get('range') ?? '';
  const after = clampInt(params.get('after'), null, 0, Number.MAX_SAFE_INTEGER);
  const before = clampInt(params.get('before'), null, 0, Number.MAX_SAFE_INTEGER);
  // 只带 after/before 的旧链接（它们早于 range 参数）也要能用：按自定义范围还原
  const range = RANGES.has(rangeRaw)
    ? rangeRaw
    : after !== null || before !== null
      ? 'custom'
      : DEFAULT_FILTERS.range;
  const pageSizeRaw = clampInt(params.get('pageSize'), DEFAULT_FILTERS.pageSize, 1, 500);
  return {
    page: clampInt(params.get('page'), 1, 1, 1_000_000),
    // 页大小吸附到最近的档位：URL 里手写的 37 会让下拉落到空选，看起来像缺陷。
    pageSize: nearest(PAGE_SIZES, pageSizeRaw),
    types: TYPES.has(typesRaw) ? typesRaw : DEFAULT_FILTERS.types,
    starred: params.get('starred') === '1',
    // 搜索串本地也截一下（服务端上限是 48 字节，那里会给出 400 的明确错误）。
    // 本地截到 200 字符是为了不让一条畸形 URL 把输入框撑爆。
    search: (params.get('search') ?? '').slice(0, 200),
    range,
    after,
    before,
    deleted: params.get('deleted') === '1',
    sort: SORTS.has(sortRaw) ? sortRaw : DEFAULT_FILTERS.sort,
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
}

function nearest(list, value) {
  if (list.includes(value)) return value;
  return list.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), list[0]);
}

/** 传给 `/ui/api/history` 的查询参数（只放非默认值，便于读日志）。 */
export function filtersToApi(filters, now = Date.now()) {
  const query = {
    page: filters.page,
    pageSize: filters.pageSize,
    sort: filters.sort,
    order: filters.order,
  };
  if (filters.types !== 'All') query.types = filters.types;
  if (filters.starred) query.starred = 'true';
  if (filters.deleted) query.deleted = 'true';
  if (filters.search) query.search = filters.search;
  const { after, before } = rangeBounds(filters, now);
  if (after !== null) query.after = String(after);
  if (before !== null) query.before = String(before);
  return query;
}

export function filtersToSearch(filters) {
  const params = new URLSearchParams();
  if (filters.page !== DEFAULT_FILTERS.page) params.set('page', String(filters.page));
  if (filters.pageSize !== DEFAULT_FILTERS.pageSize) params.set('pageSize', String(filters.pageSize));
  if (filters.types !== DEFAULT_FILTERS.types) params.set('types', filters.types);
  if (filters.starred) params.set('starred', '1');
  if (filters.search) params.set('search', filters.search);
  if (filters.range !== DEFAULT_FILTERS.range) params.set('range', filters.range);
  // 自定义范围的边界才进 URL；预设的边界每次请求重算，写进链接反而会语义漂移
  if (filters.range === 'custom') {
    if (filters.after !== null) params.set('after', String(filters.after));
    if (filters.before !== null) params.set('before', String(filters.before));
  }
  if (filters.deleted) params.set('deleted', '1');
  if (filters.sort !== DEFAULT_FILTERS.sort) params.set('sort', filters.sort);
  if (filters.order !== DEFAULT_FILTERS.order) params.set('order', filters.order);
  const query = params.toString();
  return query ? `?${query}` : '';
}

// 用户显式操作（改筛选/翻页）走 push：后退按钮能回上一步；
// 输入类（搜索框）走 replace：不要为每个字都塞一条历史记录。
export function syncUrl(filters, { push = false } = {}) {
  const url = `${location.pathname}${filtersToSearch(filters)}`;
  if (`${location.pathname}${location.search}` === url) return;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

export function isDefaultFilters(filters) {
  return (
    filters.types === DEFAULT_FILTERS.types &&
    !filters.starred &&
    filters.search === '' &&
    filters.range === DEFAULT_FILTERS.range &&
    !filters.deleted &&
    filters.sort === DEFAULT_FILTERS.sort &&
    filters.order === DEFAULT_FILTERS.order
  );
}

/** 视图是"回收站"还是"活跃列表"——类型计数与统计都要按它分流，故单独暴露一个判据。 */
export function viewOf(filters) {
  return filters.deleted ? 'trash' : 'active';
}
