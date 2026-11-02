// 筛选状态 ⇄ URL ⇄ 服务端查询参数。纯逻辑：解析、校验、序列化。
//
// 为什么筛选要进 URL：能被链接、能被后退按钮还原、刷新后不丢。
// 时间范围预设（今天/近 7 天…）**不把边界写进 URL**，每次请求时按"现在"重算 ——
// 否则分享出去的链接会随对方打开的时间而语义漂移，页面开一整天也会停在旧窗口。

import type { Filters, Item, RangeKey, SortField, TypeFilter } from './types';

export const DEFAULT_FILTERS: Readonly<Filters> = Object.freeze({
  page: 1,
  pageSize: 30,
  types: 'All' as TypeFilter, // All | Text | Image | File | Group
  starred: false,
  deleted: false, // 回收站视图
  search: '',
  range: 'all' as RangeKey, // all | today | 7d | 30d | custom
  after: null, // epoch ms；仅 custom
  before: null, // epoch ms（开区间上界）；仅 custom
  sort: 'createTime' as SortField,
  order: 'desc' as const,
});

export const PAGE_SIZES = [30, 60, 120, 240, 500]; // 上限 500 来自服务端白名单
export const TYPES: readonly TypeFilter[] = ['All', 'Text', 'Image', 'File', 'Group'];
export const RANGES: readonly (readonly [RangeKey, string])[] = [
  ['all', '全部时间'],
  ['today', '今天'],
  ['7d', '近 7 天'],
  ['30d', '近 30 天'],
  ['custom', '自定义'],
];
export const SORTS: readonly (readonly [SortField, string])[] = [
  ['createTime', '创建时间'],
  ['lastModified', '修改时间'],
  ['lastAccessed', '访问时间'],
  ['size', '大小'],
  ['type', '类型'],
];
const SORT_KEYS = new Set<string>(SORTS.map(([key]) => key));
const RANGE_KEYS = new Set<string>(RANGES.map(([key]) => key));

/** 按时间排序时，列表才分"今天 / 昨天"组（按大小/类型排序时分组没有意义）。 */
export function isTimeSort(sort: SortField): boolean {
  return sort === 'createTime' || sort === 'lastModified' || sort === 'lastAccessed';
}

function clampInt(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 把页大小吸附到最近的档位：手写 `?size=37` 也能落在下拉里有的选项上。 */
function nearestPageSize(raw: string | null): number {
  const n = clampInt(raw, DEFAULT_FILTERS.pageSize, 1, 500);
  return PAGE_SIZES.reduce((best, size) => (Math.abs(size - n) < Math.abs(best - n) ? size : best), PAGE_SIZES[0]);
}

function parseTime(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 从 `location.search` 解析筛选。未知/非法值一律回落默认，不抛。 */
export function parseFilters(search: string): Filters {
  const q = new URLSearchParams(search);
  const type = q.get('type') ?? 'All';
  const sort = q.get('sort') ?? DEFAULT_FILTERS.sort;
  const range = q.get('range') ?? 'all';
  const filters: Filters = {
    ...DEFAULT_FILTERS,
    page: clampInt(q.get('page'), 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: nearestPageSize(q.get('size')),
    types: TYPES.includes(type as TypeFilter) ? (type as TypeFilter) : 'All',
    starred: q.get('starred') === '1',
    deleted: q.get('trash') === '1',
    search: (q.get('q') ?? '').slice(0, 200),
    range: RANGE_KEYS.has(range) ? (range as RangeKey) : 'all',
    sort: SORT_KEYS.has(sort) ? (sort as SortField) : DEFAULT_FILTERS.sort,
    order: q.get('order') === 'asc' ? 'asc' : 'desc',
  };
  if (filters.range === 'custom') {
    filters.after = parseTime(q.get('from'));
    filters.before = parseTime(q.get('to'));
    if (filters.after === null && filters.before === null) filters.range = 'all';
  }
  return filters;
}

/** 序列化成 URL 查询串：只写和默认值不同的项（URL 越短越好读、越好分享）。 */
export function serializeFilters(filters: Filters): string {
  const q = new URLSearchParams();
  const d = DEFAULT_FILTERS;
  if (filters.types !== d.types) q.set('type', filters.types);
  if (filters.search) q.set('q', filters.search);
  if (filters.starred) q.set('starred', '1');
  if (filters.deleted) q.set('trash', '1');
  if (filters.range !== d.range) q.set('range', filters.range);
  if (filters.range === 'custom') {
    if (filters.after !== null) q.set('from', String(filters.after));
    if (filters.before !== null) q.set('to', String(filters.before));
  }
  if (filters.sort !== d.sort) q.set('sort', filters.sort);
  if (filters.order !== d.order) q.set('order', filters.order);
  if (filters.pageSize !== d.pageSize) q.set('size', String(filters.pageSize));
  if (filters.page !== d.page) q.set('page', String(filters.page));
  const text = q.toString();
  return text ? `?${text}` : '';
}

export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 按**日历日**偏移，不是 ±n×86400000：后者在夏令时切换的时区里会落偏一小时。 */
function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** 范围 → [after, before) 的毫秒边界；null 表示该侧不设限。 */
export function rangeBounds(
  filters: Pick<Filters, 'range' | 'after' | 'before'>,
  now = Date.now(),
): { after: number | null; before: number | null } {
  switch (filters.range) {
    case 'today':
      return { after: startOfDay(now), before: null };
    case '7d':
      return { after: addDays(startOfDay(now), -6), before: null };
    case '30d':
      return { after: addDays(startOfDay(now), -29), before: null };
    case 'custom':
      return { after: filters.after, before: filters.before };
    default:
      return { after: null, before: null };
  }
}

/** 筛选状态 → `/ui/api/history` 的查询参数。 */
export function toApiParams(filters: Filters, now = Date.now()): Record<string, string | number> {
  const { after, before } = rangeBounds(filters, now);
  return {
    page: filters.page,
    pageSize: filters.pageSize,
    types: filters.types === 'All' ? '' : filters.types,
    starred: filters.starred ? 'true' : '',
    deleted: filters.deleted ? 'true' : '',
    search: filters.search,
    after: after ?? '',
    before: before ?? '',
    sort: filters.sort,
    order: filters.order,
  };
}

/** 是否带有会缩小结果集的筛选（排序/翻页/页大小不算）。 */
export function isFiltered(filters: Filters): boolean {
  return (
    filters.types !== 'All' ||
    filters.starred ||
    filters.search !== '' ||
    filters.range !== 'all'
  );
}

/**
 * 两组筛选是否改变了**结果集的成员资格**。排序/翻页/页大小不改变，其余都改变。
 * 成员资格变了就必须清空选择集：否则批量操作会作用到用户已经看不见的记录上。
 */
export function membershipChanged(a: Filters, b: Filters): boolean {
  return (
    a.types !== b.types ||
    a.starred !== b.starred ||
    a.deleted !== b.deleted ||
    a.search !== b.search ||
    a.range !== b.range ||
    a.after !== b.after ||
    a.before !== b.before
  );
}

/** 本地日期输入（`YYYY-MM-DD`）⇄ 毫秒。`end` 取次日 00:00（开区间上界）。 */
export function fromDateInput(value: string, edge: 'start' | 'end'): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d + (edge === 'end' ? 1 : 0));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function toDateInput(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 深链接：`#Type-hash`。解码后拒绝含路径分隔符的 hash。 */
export function parseDeepLink(hash: string | null | undefined): { type: Item['type']; hash: string } | null {
  const m = /^#(Text|Image|File|Group)-(.+)$/.exec(hash ?? '');
  if (!m || m[2] === undefined) return null;
  let value: string;
  try {
    value = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (value === '' || /[\\/]/.test(value)) return null;
  return { type: m[1] as Item['type'], hash: value };
}

export function deepLinkFor(item: Pick<Item, 'type' | 'hash'>): string {
  return `#${item.type}-${encodeURIComponent(item.hash)}`;
}

/** 服务端对搜索词的上限：D1 的 LIKE 模式最长 50 字节，`%词%` 要占 2 个，所以词本身（转义后）最多 48 字节。 */
export const SEARCH_MAX_BYTES = 48;

/**
 * 搜索词是否会被服务端拒绝（400）：返回给用户看的原因，合法返回 null。
 * 转义规则与服务端一致：`%`、`_`、`\` 各占 2 个字符（它们在 LIKE 里是通配符，要加反斜杠）。
 * 前端先拦下，用户就能在输入框旁看到原因，而不是对着一次失败的请求猜。
 */
export function searchProblem(term: string): string | null {
  const bytes = new TextEncoder().encode(term.replace(/[\\%_]/g, (ch) => `\\${ch}`)).length;
  if (bytes <= SEARCH_MAX_BYTES) return null;
  return `搜索词太长：最多 ${SEARCH_MAX_BYTES} 字节（约 16 个汉字，或 48 个英文字母；% _ \\ 各算 2 个）`;
}
