// 筛选状态 ⇄ URL。只做这一件事：解析、校验、序列化。
//
// 为什么筛选一定要进 URL：能被链接、能被后退按钮还原、刷新后不丢。这是功能型界面的基本要求，
// 也是「筛选看起来能用但一刷新就回到初始页」这类不完善感的来源。
//
// 时间范围有三种形态，URL 里都以**用户可读**的形式保存：
//   range=all|today|7d|30d   —— 预设，边界在每次请求时按"现在"重算（页面开一整天也不会停在旧窗口）
//   range=custom&after=&before= —— 自定义，毫秒时间戳；before 是**开区间上界**（对齐服务的 CreateTime < before）
// 预设不写死边界进 URL：否则分享出去的链接会随着对方打开的时间而语义漂移。

export const DEFAULT_FILTERS = {
  page: 1,
  pageSize: 50,
  types: 'All', // All | Text | Image | File | Group | 逗号组合
  starred: false,
  search: '',
  range: 'all', // all | today | 7d | 30d | custom
  after: null, // epoch ms；仅 range === 'custom' 时使用
  before: null, // epoch ms（开区间上界）
  deleted: false, // 回收站视图：只看已删除的记录
  sort: 'createTime', // createTime | lastModified | lastAccessed | size | type | id
  order: 'desc',
};

// 页大小档位。上限 500 来自服务端白名单（`src/ui/query.ts` 的 UI_MAX_PAGE_SIZE）。
export const PAGE_SIZES = [20, 50, 100, 200, 500];

const TYPES = new Set(['All', 'Text', 'Image', 'File', 'Group']);
const SORTS = new Set(['createTime', 'lastModified', 'lastAccessed', 'size', 'type', 'id']);
const RANGES = new Set(['all', 'today', '7d', '30d', 'custom']);

function clampInt(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * 把 `pageSize` **吸附到最近的档位**（V2 的 `filters.js` 用同一个 `nearest` 策略）。
 *
 * `pageSize` 是手写可达的（`?pageSize=37`），而工具栏的下拉只有 `PAGE_SIZES` 那几个档位 ——
 * 不吸附时下拉会遇到"值不在选项里"，于是**落到空选**（下拉显示空白），读起来像缺陷。
 * 这里只保证"URL 里的档位是合法档位"，不做别的解释（`?pageSize=500` 仍然合法）。
 */
function nearestPageSize(raw) {
  const n = clampInt(raw, DEFAULT_FILTERS.pageSize, 1, 500);
  let best = PAGE_SIZES[0];
  for (const size of PAGE_SIZES) {
    if (Math.abs(size - n) < Math.abs(best - n)) best = size;
  }
  return best;
}

// 本地日界：用户说「今天」指的是自己时区里的今天，不是 UTC 的今天。
export function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 按**日历日**偏移，而不是 `± n × 86400000`。
 * 为什么：常数 24 小时在跨夏令时切换的时区里会落偏一小时 —— `startOfDay(now) - 6 * 86400000`
 * 可能指向前一天的 23:00，于是「近 7 天」从半天中间开始、两端各差一小时。`setDate()` 是
 * 日历运算，时区规则交给运行时。本项目的目标用户所在时区没有夏令时，但这里没有理由
 * 留一个"只在别人的时区里错"的算法。
 */
function addDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** 预设范围 → [after, before) 的毫秒边界；null 表示该侧不设限。 */
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

/** epoch ms → `<input type="date">` 的本地日期串。 */
export function toDateInput(ms) {
  if (ms === null || ms === undefined) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * `<input type="date">` 的值 → 毫秒边界。
 * edge='start'：该日 00:00（含）；edge='end'：次日 00:00（不含）——与服务端 `CreateTime < before` 对齐，
 * 否则「截止到今天」会把今天 00:00 之后的记录全部漏掉。
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
  return edge === 'end' ? addDays(date.getTime(), 1) : date.getTime();
}

export function filtersFromUrl(search = location.search) {
  const params = new URLSearchParams(search);
  const typesRaw = params.get('types') ?? '';
  const types = TYPES.has(typesRaw) ? typesRaw : DEFAULT_FILTERS.types;
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
  return {
    page: clampInt(params.get('page'), 1, 1, 1_000_000),
    pageSize: nearestPageSize(params.get('pageSize')),
    types,
    starred: params.get('starred') === '1',
    search: (params.get('search') ?? '').slice(0, 200),
    range,
    after,
    before,
    deleted: params.get('deleted') === '1',
    sort: SORTS.has(sortRaw) ? sortRaw : DEFAULT_FILTERS.sort,
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
}

// 传给 /ui/api/history 的查询参数（只放非默认值，便于阅读日志）
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
