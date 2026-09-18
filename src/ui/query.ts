// UI 历史查询层。
//
// 为什么不复用官方 `POST /api/history/query`：那是**协议契约**——页大小固定 50、
// 只支持 createTime/lastAccessed 两种排序、没有总数。UI 需要可变页大小、多列排序、
// 总数与批量选择，改动官方语义会破坏与客户端的兼容。故此处单开一层，
// 但仍读写同一张表、复用同一套行映射（db.ts 的 rowToEntity）与 DTO 序列化。
import { DbRow, rowToEntity, basename } from '../db';
import { entityToDto, normalizeSearchText, parseProfileTypeFilter, InvalidQueryValueError } from '../serialization';
import { HistoryRecordDto, HistoryRecordEntity, ProfileType, ProfileTypeFilter } from '../types';

export type UiSortField = 'id' | 'type' | 'size' | 'createTime' | 'lastModified' | 'lastAccessed';
export type UiSortOrder = 'asc' | 'desc';

// 列表项 = 协议 DTO + UI 需要的两个附加信息。
// 沿用 HistoryRecordDto 而不是另立一套字段名：UI 与协议看到的是同一条记录，
// 两套命名只会让对照（以及将来的排查）变难。
export interface UiHistoryItem extends HistoryRecordDto {
  id: number; // D1 行 ID，仅用于前端 key/展示（记录的身份始终是 type + hash）
  dataName: string | null; // 数据文件名（无数据为 null），用于“下载/预览”的展示名
}

export interface UiHistoryQuery {
  page: number;
  pageSize: number;
  types: ProfileTypeFilter;
  search: string | null;
  starred: boolean | null;
  includeDeleted: boolean;
  after: number | null; // CreateTime >= after（epoch ms）
  before: number | null; // CreateTime < before（epoch ms）
  sort: UiSortField;
  order: UiSortOrder;
}

export interface UiHistoryPage {
  total: number;
  page: number;
  pageSize: number;
  items: UiHistoryListItem[];
}

export interface UiTypeCounts {
  Text: number;
  Image: number;
  File: number;
  Group: number;
}

export class UiQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiQueryError';
  }
}

export const UI_DEFAULT_PAGE_SIZE = 50;
export const UI_MAX_PAGE_SIZE = 500;

// 排序字段白名单：SQL 的 ORDER BY 不能参数化，只能靠白名单把用户输入映射成列名
const SORT_COLUMNS: Record<UiSortField, string> = {
  id: 'ID',
  type: 'Type',
  size: 'Size',
  createTime: 'CreateTime',
  lastModified: 'LastModified',
  lastAccessed: 'LastAccessed',
};

function parseIntParam(raw: string | null, fallback: number, min: number, max: number, field: string): number {
  if (raw === null || raw.trim() === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) throw new UiQueryError(`Invalid ${field} value: ${raw}`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) throw new UiQueryError(`Invalid ${field} value: ${raw}`);
  return Math.min(Math.max(n, min), max);
}

function parseBoolParam(raw: string | null, field: string): boolean | null {
  if (raw === null || raw.trim() === '') return null;
  const t = raw.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  throw new UiQueryError(`Invalid ${field} value: ${raw}`);
}

// 时间过滤接受 epoch 毫秒或 ISO 串（前端用 ISO，脚本用毫秒都方便）
function parseTimeParam(raw: string | null, field: string): number | null {
  if (raw === null || raw.trim() === '') return null;
  const trimmed = raw.trim();
  if (/^[+-]?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) throw new UiQueryError(`Invalid ${field} value: ${raw}`);
    return n;
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) throw new UiQueryError(`Invalid ${field} value: ${raw}`);
  return ms;
}

export function parseUiHistoryQuery(params: URLSearchParams): UiHistoryQuery {
  let types: ProfileTypeFilter;
  try {
    types = parseProfileTypeFilter(params.get('types'), 'types');
  } catch (err) {
    if (err instanceof InvalidQueryValueError) throw new UiQueryError(err.message);
    throw err;
  }

  const sortRaw = (params.get('sort') ?? 'createTime').trim();
  // 必须用 hasOwn：`'constructor' in SORT_COLUMNS` 为真（走原型链），
  // 随后 `SORT_COLUMNS['constructor']` 取到原生函数、toString 进 ORDER BY → SQL 语法错误 500。
  // 白名单的意义就是「只有这 6 个字符串能进 SQL」，故不能靠 `in`。
  if (!Object.hasOwn(SORT_COLUMNS, sortRaw)) throw new UiQueryError(`Invalid sort value: ${sortRaw}`);

  const orderRaw = (params.get('order') ?? 'desc').trim().toLowerCase();
  if (orderRaw !== 'asc' && orderRaw !== 'desc') {
    throw new UiQueryError(`Invalid order value: ${params.get('order')}`);
  }

  const search = (params.get('search') ?? '').trim();

  return {
    page: parseIntParam(params.get('page'), 1, 1, Number.MAX_SAFE_INTEGER, 'page'),
    pageSize: parseIntParam(params.get('pageSize'), UI_DEFAULT_PAGE_SIZE, 1, UI_MAX_PAGE_SIZE, 'pageSize'),
    types,
    search: normalizeSearchText(search),
    starred: parseBoolParam(params.get('starred'), 'starred'),
    includeDeleted: parseBoolParam(params.get('includeDeleted'), 'includeDeleted') === true,
    after: parseTimeParam(params.get('after'), 'after'),
    before: parseTimeParam(params.get('before'), 'before'),
    sort: sortRaw as UiSortField,
    order: orderRaw,
  };
}

const USER_ID = 'default_user'; // 与 db.ts 的 HARD_CODED_USER_ID 同义（单用户部署）

function buildWhere(q: UiHistoryQuery): { clause: string; params: (string | number)[] } {
  const where: string[] = ['UserId = ?1'];
  const params: (string | number)[] = [USER_ID];
  let idx = 2;

  if (!q.includeDeleted) where.push('IsDeleted = 0');
  if (q.after !== null) {
    where.push(`CreateTime >= ?${idx++}`);
    params.push(q.after);
  }
  if (q.before !== null) {
    where.push(`CreateTime < ?${idx++}`);
    params.push(q.before);
  }
  if (q.types !== ProfileTypeFilter.All) {
    const included = [ProfileType.Text, ProfileType.File, ProfileType.Image, ProfileType.Group].filter(
      (t) => ((q.types as number) & (1 << t)) !== 0,
    );
    if (included.length === 0) return { clause: where.join(' AND ') + ' AND 0', params };
    const placeholders = included.map((_, i) => `?${idx + i}`).join(',');
    where.push(`Type IN (${placeholders})`);
    params.push(...included);
    idx += included.length;
  }
  if (q.search !== null) {
    // 转义 LIKE 元字符：用户搜「100%」时不该退化成「匹配任意」。
    // 官方 API 未转义（与上游 Contains 的差异见 docs/protocol.md），故这里是**有意**不同。
    const escaped = q.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    where.push(`Text LIKE ?${idx++} ESCAPE '\\'`);
    params.push(`%${escaped}%`);
  }
  if (q.starred !== null) {
    where.push(`Stared = ?${idx++}`);
    params.push(q.starred ? 1 : 0);
  }
  return { clause: where.join(' AND '), params };
}

// 列表项：在 DTO 基础上截断 text。
// 为什么必须截断：粘一段日志/长文进剪贴板是常态，一页 50~500 行 × 每条几十上百 KB
// 就是几 MB~几十 MB 的 JSON，而列表只显示两行。完整文本走单条端点。
// textTruncated 让前端知道「需要复制/预览时必须先取全文」——否则用户复制到的是被砍过的内容。
export interface UiHistoryListItem extends UiHistoryItem {
  textTruncated: boolean;
}

export const UI_LIST_TEXT_LIMIT = 500;

// 代价极小的截断：先用 slice，再处理代理对边界（半截代理对是非法字符串）
function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

// 实体 → UI 列表项。导出给写路径复用：PATCH 成功后直接回传新条目，
// 前端无需为一个字段的变化重拉整页。
export function toUiItem(entity: HistoryRecordEntity): UiHistoryItem {
  const dto = entityToDto(entity);
  return {
    ...dto,
    id: entity.id ?? 0,
    dataName: entity.transferDataFile === '' ? null : basename(entity.transferDataFile),
  };
}

// 列表专用：截断 text 并标记
export function toUiListItem(entity: HistoryRecordEntity): UiHistoryListItem {
  const item = toUiItem(entity);
  return {
    ...item,
    text: truncateText(item.text, UI_LIST_TEXT_LIMIT),
    textTruncated: item.text.length > UI_LIST_TEXT_LIMIT,
  };
}

function toItem(row: DbRow): UiHistoryListItem {
  return toUiListItem(rowToEntity(row));
}

export async function listUiHistory(db: D1Database, q: UiHistoryQuery): Promise<UiHistoryPage> {
  const { clause, params } = buildWhere(q);
  const countRes = await db
    .prepare(`SELECT COUNT(*) AS c FROM HistoryRecords WHERE ${clause}`)
    .bind(...params)
    .first<{ c: number }>();
  const total = countRes?.c ?? 0;

  const column = SORT_COLUMNS[q.sort];
  const direction = q.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (q.page - 1) * q.pageSize;
  const limitIdx = params.length + 1;

  const rows = await db
    .prepare(
      `SELECT * FROM HistoryRecords WHERE ${clause} ` +
        `ORDER BY ${column} ${direction}, ID ${direction} LIMIT ?${limitIdx} OFFSET ?${limitIdx + 1}`,
    )
    .bind(...params, q.pageSize, offset)
    .all<DbRow>();

  return { total, page: q.page, pageSize: q.pageSize, items: (rows.results ?? []).map(toItem) };
}

export async function countByType(db: D1Database): Promise<UiTypeCounts> {
  const rows = await db
    .prepare(
      `SELECT Type, COUNT(*) AS c FROM HistoryRecords WHERE UserId = ?1 AND IsDeleted = 0 GROUP BY Type`,
    )
    .bind(USER_ID)
    .all<{ Type: number; c: number }>();
  const counts: UiTypeCounts = { Text: 0, Image: 0, File: 0, Group: 0 };
  for (const row of rows.results ?? []) {
    if (row.Type === ProfileType.Text) counts.Text = row.c;
    else if (row.Type === ProfileType.Image) counts.Image = row.c;
    else if (row.Type === ProfileType.File) counts.File = row.c;
    else if (row.Type === ProfileType.Group) counts.Group = row.c;
  }
  return counts;
}

// 变更信号：前端的自动刷新用它判断「要不要重新拉列表」。
// 取 (总行数, 最大 LastModified) 两个值——插入/硬删改前者，更新/软删改后者，
// 故任何写路径都会让这个二元组变化。
export interface UiChangeMarker {
  count: number;
  lastModified: number;
}

export async function readChangeMarker(db: D1Database): Promise<UiChangeMarker> {
  const res = await db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(LastModified), 0) AS m FROM HistoryRecords WHERE UserId = ?1`)
    .bind(USER_ID)
    .first<{ c: number; m: number }>();
  return { count: res?.c ?? 0, lastModified: res?.m ?? 0 };
}
