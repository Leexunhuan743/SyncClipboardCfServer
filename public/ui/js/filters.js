// 筛选状态 ⇄ URL。只做这一件事：解析、校验、序列化。
//
// 为什么筛选一定要进 URL：能被链接、能被后退按钮还原、刷新后不丢。这是功能型界面的基本要求，
// 也是「筛选看起来能用但一刷新就回到初始页」这类不完善感的来源。

export const DEFAULT_FILTERS = {
  page: 1,
  pageSize: 50,
  types: 'All', // All | Text | Image | File | Group | 逗号组合
  starred: false,
  search: '',
  sort: 'createTime', // createTime | lastModified | lastAccessed | size | type | id
  order: 'desc',
};

export const PAGE_SIZES = [20, 50, 100, 200];

const TYPES = new Set(['All', 'Text', 'Image', 'File', 'Group']);
const SORTS = new Set(['createTime', 'lastModified', 'lastAccessed', 'size', 'type', 'id']);

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function filtersFromUrl(search = location.search) {
  const params = new URLSearchParams(search);
  const typesRaw = params.get('types') ?? '';
  const types = TYPES.has(typesRaw) ? typesRaw : DEFAULT_FILTERS.types;
  const sortRaw = params.get('sort') ?? '';
  return {
    page: clampInt(params.get('page'), 1, 1, 1_000_000),
    pageSize: clampInt(params.get('pageSize'), DEFAULT_FILTERS.pageSize, 1, 500),
    types,
    starred: params.get('starred') === '1',
    search: (params.get('search') ?? '').slice(0, 200),
    sort: SORTS.has(sortRaw) ? sortRaw : DEFAULT_FILTERS.sort,
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
}

// 传给 /ui/api/history 的查询参数（只放非默认值，便于阅读日志）
export function filtersToApi(filters) {
  const query = {
    page: filters.page,
    pageSize: filters.pageSize,
    sort: filters.sort,
    order: filters.order,
  };
  if (filters.types !== 'All') query.types = filters.types;
  if (filters.starred) query.starred = 'true';
  if (filters.search) query.search = filters.search;
  return query;
}

export function filtersToSearch(filters) {
  const params = new URLSearchParams();
  if (filters.page !== DEFAULT_FILTERS.page) params.set('page', String(filters.page));
  if (filters.pageSize !== DEFAULT_FILTERS.pageSize) params.set('pageSize', String(filters.pageSize));
  if (filters.types !== DEFAULT_FILTERS.types) params.set('types', filters.types);
  if (filters.starred) params.set('starred', '1');
  if (filters.search) params.set('search', filters.search);
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
    filters.sort === DEFAULT_FILTERS.sort &&
    filters.order === DEFAULT_FILTERS.order
  );
}
