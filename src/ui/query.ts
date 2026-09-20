// UI 历史查询层。
//
// 为什么不复用官方 `POST /api/history/query`：那是**协议契约**——页大小固定 50、
// 只支持 createTime/lastAccessed 两种排序、没有总数。UI 需要可变页大小、多列排序、
// 总数与批量选择，改动官方语义会破坏与客户端的兼容。故此处单开一层，
// 但仍读写同一张表、复用同一套行映射（db.ts 的 rowToEntity）与 DTO 序列化。
import { DbRow, rowToEntity, basename } from '../db';
import {
  entityToDto,
  normalizeSearchText,
  assertLikePatternFits,
  parseProfileTypeFilter,
  InvalidQueryValueError,
} from '../serialization';
import { HistoryRecordDto, HistoryRecordEntity, ProfileType, ProfileTypeFilter, HARD_CODED_USER_ID } from '../types';

export type UiSortField = 'id' | 'type' | 'size' | 'createTime' | 'lastModified' | 'lastAccessed';
export type UiSortOrder = 'asc' | 'desc';

// 列表项 = 协议 DTO + UI 需要的两个附加信息。
// 沿用 HistoryRecordDto 而不是另立一套字段名：UI 与协议看到的是同一条记录，
// 两套命名只会让对照（以及将来的排查）变难。
export interface UiHistoryItem extends HistoryRecordDto {
  id: number; // D1 行 ID，仅用于前端 key/展示（记录的身份始终是 type + hash）
  dataName: string | null; // 数据文件名（无数据为 null），用于"下载/预览"的展示名
}

export interface UiHistoryQuery {
  page: number;
  pageSize: number;
  types: ProfileTypeFilter;
  search: string | null;
  starred: boolean | null;
  includeDeleted: boolean;
  /** 只看回收站（已删除的记录）。为真时 includeDeleted 无意义——范围已限定在已删除行 */
  deleted: boolean;
  after: number | null; // CreateTime >= after（epoch ms）
  before: number | null; // CreateTime < before（epoch ms）
  sort: UiSortField;
  order: UiSortOrder;
  /**
   * 置顶优先：`Pinned` 恒排在主排序列之前。默认开。
   *
   * 为什么默认就是开：这个接口**没有"默认排序"这一档** —— 界面上每一列都是显式排序
   * （`sort` 恒有值），若只在某一档里插置顶，"置顶"就会随用户点的列时灵时不灵
   * （同一个动作一半的排序里有用、另一半没用，读起来就是坏掉了）。
   * 唯一的例外是调用方显式传 `pinnedFirst=false` —— 那是给"**全库**最新的那一条"
   * 这类查询用的（V1 的「复制最近一条」）：它问的是时间上的最新，不是"当前列表的第一行"，
   * 让它跟着置顶走会答非所问。
   */
  pinnedFirst: boolean;
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

// `deleted=true` 的解析规则单独导出：列表（`/ui/api/history`）与类型计数（`/ui/api/statistics`）
// 都用它，两处各写一遍迟早出现「列表按 A 解释、计数按 B 解释」的分叉。
export function parseDeletedFlag(params: URLSearchParams): boolean {
  return parseBoolParam(params.get('deleted'), 'deleted') === true;
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

  const searchText = (params.get('search') ?? '').trim();
  // 搜索串的长度上限由 normalizeSearchText 判定（G6，48 字节）：它抛的是 InvalidQueryValueError，
  // 必须在这里翻译成 UiQueryError —— 否则会刺穿上层路由的 `instanceof UiQueryError` 映射，
  // 变成未处理的 500（实测：49 字节的搜索词）。协议侧对同一个错误映射为 400，两边语义必须一致。
  let search: string | null;
  try {
    search = normalizeSearchText(searchText);
    // ⚠️ 预算要按**转义后**的串再校一次：`%`、`_` 与反斜杠各自都会变成 2 个字符，48 字节的入参
    // 最多撑到 96 字节，直接越过 D1 的 LIKE 模式上限（见 serialization.ts 的 MAX_LIKE_PATTERN_BYTES）
    // —— 实测 25 个 `%` 就是一次未处理的 500，而它离 normalizeSearchText 那条线还差一半。
    if (search !== null) assertLikePatternFits(escapeLike(search));
  } catch (err) {
    if (err instanceof InvalidQueryValueError) throw new UiQueryError(err.message);
    throw err;
  }

  return {
    page: parseIntParam(params.get('page'), 1, 1, Number.MAX_SAFE_INTEGER, 'page'),
    pageSize: parseIntParam(params.get('pageSize'), UI_DEFAULT_PAGE_SIZE, 1, UI_MAX_PAGE_SIZE, 'pageSize'),
    types,
    search,
    starred: parseBoolParam(params.get('starred'), 'starred'),
    includeDeleted: parseBoolParam(params.get('includeDeleted'), 'includeDeleted') === true,
    deleted: parseDeletedFlag(params),
    after: parseTimeParam(params.get('after'), 'after'),
    before: parseTimeParam(params.get('before'), 'before'),
    sort: sortRaw as UiSortField,
    order: orderRaw,
    // 缺省为真（`parseBoolParam` 对空值返回 null）：只有显式 `pinnedFirst=false` 才关掉置顶优先
    pinnedFirst: parseBoolParam(params.get('pinnedFirst'), 'pinnedFirst') !== false,
  };
}

// 单用户部署：与协议面共用同一个 UserId 常量（此前这里另写一份字面量 'default_user'，O1）
const USER_ID = HARD_CODED_USER_ID;

// LIKE 元字符转义：**只此一处**（解析期要用它算转义后的长度，拼 SQL 时要用它做替换）。
// 转义符本身是反斜杠 ⇒ 反斜杠必须先被转义，否则「字面反斜杠 + %」会被解释成「字面反斜杠 + 通配符」。
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function buildWhere(q: UiHistoryQuery): { clause: string; params: (string | number)[] } {
  const where: string[] = ['UserId = ?1'];
  const params: (string | number)[] = [USER_ID];
  let idx = 2;

  // 回收站视图只看已删除行；普通视图排除已删除行（includeDeleted 允许两者混排，供脚本用）
  if (q.deleted) where.push('IsDeleted = 1');
  else if (!q.includeDeleted) where.push('IsDeleted = 0');
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
    // 官方 API 未转义（与上游 Contains 的差异见 docs/protocol.md），故这里是**有意**不同；
    // 转义后的长度预算已在 parseUiHistoryQuery 里校过（转义函数与那里共用同一个 escapeLike）。
    where.push(`Text LIKE ?${idx++} ESCAPE '\\'`);
    params.push(`%${escapeLike(q.search)}%`);
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

// 代价极小的截断：先用 slice，再处理代理对边界（半截代理对是非法字符串）。
// 导出给 `src/ui/maintenance.ts` 的自检摘要复用（此前它复制了一份同名实现，见审计 R-03）。
//
// ⚠️ 与前端 `public/ui_v{1,2}/js/format.js` 的 `truncateText` **同名但不同义**，别去"统一"：
// 那一边量的是**用户看到的字符**（`Intl.Segmenter` 字素簇，emoji 算 1 个），这一边量的是
// **UTF-16 码元**——因为这里的 500 是**协议上限**（约束 JSON 体积），不是展示口径。
// 差异的登记处是 `docs/archive/AUDIT-v1-v2-divergence.md` §5.3。
export function truncateText(text: string, limit: number): string {
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
  // 置顶优先（默认，见 UiHistoryQuery.pinnedFirst）恒在最前，其余按主列排序；`ID` 是稳定
  // tiebreaker —— 主列自己就是 ID 时不再重复写一遍。
  const orderBy = [
    ...(q.pinnedFirst ? ['Pinned DESC'] : []),
    `${column} ${direction}`,
    ...(q.sort === 'id' ? [] : [`ID ${direction}`]),
  ].join(', ');

  const rows = await db
    .prepare(
      `SELECT * FROM HistoryRecords WHERE ${clause} ` +
        `ORDER BY ${orderBy} LIMIT ?${limitIdx} OFFSET ?${limitIdx + 1}`,
    )
    .bind(...params, q.pageSize, offset)
    .all<DbRow>();

  return { total, page: q.page, pageSize: q.pageSize, items: (rows.results ?? []).map(toItem) };
}

// 按类型计数（活跃 / 回收站两套视图，一次取回）。
// 为什么一次取两套：`byType` 要随**当前视图**走（回收站里显示活跃数会让列表头与控制条互相矛盾），
// 而统计条「存储占用」的明细恒用活跃口径——两个消费方各要一套，旧实现为此打两条 `COUNT(*) GROUP BY`
// 再加一条全表拉取式的统计（后端能力评估 §3.1）。一条 `GROUP BY Type, IsDeleted` 就够。
export async function countByTypeViews(
  db: D1Database,
): Promise<{ byActive: UiTypeCounts; byDeleted: UiTypeCounts }> {
  const rows = await db
    .prepare(
      `SELECT Type, IsDeleted, COUNT(*) AS c FROM HistoryRecords WHERE UserId = ?1 GROUP BY Type, IsDeleted`,
    )
    .bind(USER_ID)
    .all<{ Type: number; IsDeleted: number; c: number }>();
  const byActive: UiTypeCounts = { Text: 0, Image: 0, File: 0, Group: 0 };
  const byDeleted: UiTypeCounts = { Text: 0, Image: 0, File: 0, Group: 0 };
  for (const row of rows.results ?? []) {
    const bucket = row.IsDeleted !== 0 ? byDeleted : byActive;
    if (row.Type === ProfileType.Text) bucket.Text = row.c;
    else if (row.Type === ProfileType.Image) bucket.Image = row.c;
    else if (row.Type === ProfileType.File) bucket.File = row.c;
    else if (row.Type === ProfileType.Group) bucket.Group = row.c;
  }
  return { byActive, byDeleted };
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

// ===== 活动趋势（docs/ui-v2-design.md §6.2 的 N2）=====

export interface ActivityDay {
  /** `YYYY-MM-DD`，按**调用方给的时区**切分 */
  day: string;
  total: number;
  Text: number;
  Image: number;
  File: number;
  Group: number;
}

export const ACTIVITY_MAX_DAYS = 90;
export const ACTIVITY_DEFAULT_DAYS = 14;

const TYPE_BUCKET: Record<number, 'Text' | 'Image' | 'File' | 'Group' | undefined> = {
  [ProfileType.Text]: 'Text',
  [ProfileType.Image]: 'Image',
  [ProfileType.File]: 'File',
  [ProfileType.Group]: 'Group',
};

/**
 * 「每天有多少条记录」——概览带的趋势图与抽屉里的明细都读它。
 *
 * **时区**：`day` 的边界必须按**客户端**的时区切分。服务端只知道 UTC，而 `CreateTime` 存的是
 * epoch 毫秒；直接按 UTC 切会让 UTC+8 的用户在早上 8 点前看到的"今天"其实是昨天
 * （`2026-09-15T20:00Z` 对用户已经是 09-16 04:00，按 UTC 会被算进 09-15）。
 *
 * 做法：先把每个时间戳按 `-tz` 分钟**平移**，再按平移后的 UTC 日期分组。
 * `tz` 的符号与 `Date.prototype.getTimezoneOffset()` 一致（UTC+8 ⇒ `-480`）。
 *
 * **成本**：1 条聚合查询（`GROUP BY`，不是把行拉进 JS 循环 —— 后者是
 * `docs/backend-gaps.md` §3.1 记的效率欠账，而统计在每次页面加载都会跑）。
 * 代价是 `CreateTime` 上的索引用不上（表达式不是索引列），但候选集先被
 * `CreateTime >= ?` 的范围条件筛过，实际扫描量只与**窗口内的记录数**成正比，与库总量无关。
 *
 * ⚠️ **时间单位**：`strftime(..., 'unixepoch')` 的第二个参数必须是**秒**，而本库的
 * `CreateTime` 存的是**毫秒**（schema.sql 与 types.ts 都写着 epoch ms）。所以 SQL 里必须有
 * `CreateTime / 1000` 这一步。少了它，`strftime` 拿到 13 位数字会返回 **NULL** ——
 * 而下面 `if (!row.day) continue` 会把这些行静静丢掉，于是每一天都是"没有活动"，
 * 接口恒返回 14 个 0（2026-09-17 实测；判别性用例见 test/ui-activity.test.ts）。
 */
export async function readActivity(
  db: D1Database,
  { days = ACTIVITY_DEFAULT_DAYS, tzOffsetMinutes = 0 } = {},
): Promise<{ days: ActivityDay[]; max: number }> {
  const span = Math.min(Math.max(Math.trunc(days) || ACTIVITY_DEFAULT_DAYS, 1), ACTIVITY_MAX_DAYS);
  const tz = Number.isFinite(tzOffsetMinutes) ? Math.trunc(tzOffsetMinutes) : 0;

  // 窗口起点按**客户端本地日界**算：本地今天 00:00 对应 UTC 的 `本地时刻 + tz 分钟`。
  // 先把 `now` 平移到本地，再取当天 00:00，最后平移回 UTC —— 这样"今天"这一格
  // 与用户在界面上看到的日期一致。
  const nowLocalMs = Date.now() - tz * 60_000;
  const startLocalDayMs = Math.floor(nowLocalMs / 86_400_000) * 86_400_000;
  const sinceMs = startLocalDayMs - (span - 1) * 86_400_000 + tz * 60_000;

  const res = await db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', CreateTime / 1000 + ?2, 'unixepoch') AS day,
         Type AS type,
         COUNT(*) AS c
       FROM HistoryRecords
       WHERE UserId = ?1 AND CreateTime >= ?3
       GROUP BY day, Type`,
    )
    // `?2` 是"按 tz 平移"的**秒**数（`-tz 分钟 × 60`）：与 `unixepoch` 的单位一致，
    // 让本地日界落在 UTC 的整日边界上。`?3` 仍是毫秒 —— 它直接和 `CreateTime` 比大小。
    .bind(USER_ID, -tz * 60, sinceMs)
    .all<{ day: string | null; type: number; c: number }>();

  const byDay = new Map<string, ActivityDay>();
  for (const row of res.results ?? []) {
    // `day` 为 null 只可能来自非法 CreateTime（不该发生）；丢掉而不是编一个日期出来
    if (!row.day) continue;
    let entry = byDay.get(row.day);
    if (!entry) {
      entry = { day: row.day, total: 0, Text: 0, Image: 0, File: 0, Group: 0 };
      byDay.set(row.day, entry);
    }
    const bucket = TYPE_BUCKET[row.type];
    if (bucket) entry[bucket] += row.c;
    entry.total += row.c;
  }

  // 补全空白天：**零活动的那天也必须在序列里**，否则趋势图会把两段分开的日子画成相邻，
  // 看起来像"每天都在用"。
  const out: ActivityDay[] = [];
  for (let i = 0; i < span; i += 1) {
    const dayMs = startLocalDayMs - (span - 1 - i) * 86_400_000;
    const label = new Date(dayMs).toISOString().slice(0, 10);
    out.push(byDay.get(label) ?? { day: label, total: 0, Text: 0, Image: 0, File: 0, Group: 0 });
  }

  return { days: out, max: Math.max(0, ...out.map((d) => d.total)) };
}

// ===== 批量取元数据（docs/ui-v2-design.md §6.2 的 N3）=====

export interface BatchMetaItem {
  type: ProfileType;
  hash: string;
}

export const BATCH_META_MAX_ITEMS = 100;

/**
 * 按 `(type, hash)` 批量取记录。用于「选中多条 → 一起复制/下载」这类需要**完整正文**的场景：
 * 列表里的正文被截断到 500 字符（`UI_LIST_TEXT_LIMIT`），而逐条走单条端点是 O(N) 次请求
 * （`docs/backend-gaps.md` §2.8 记的口径）。
 *
 * 实现是**一条** `IN` 查询而不是 N 条：每次 D1 往返都计入平台的子请求配额，
 * 100 条逐条查就是 100 次 —— 那正是这个端点存在的理由。
 */
export async function readBatchMeta(
  db: D1Database,
  items: BatchMetaItem[],
): Promise<HistoryRecordEntity[]> {
  if (items.length === 0) return [];

  // 只对 hash 做一次 IN，type 在应用层过滤：`(type, hash)` 元组 IN 要拼两倍的参数列表，
  // 而这里的候选集本来就极小（≤100 条记录、去重后更少），多筛一次是免费的。
  // 库里存的是大写（`docs/protocol.md` §10：落库 hash 统一 `.toUpperCase()`），而调用方可能发小写 ——
  // 故先把参数统一成大写：否则小写入参在**这一步**就被 `Hash IN (…)` 的等值比较滤掉，
  // 下面那句「大小写不敏感」的过滤根本没机会生效。
  const hashes = [...new Set(items.map((i) => i.hash.toUpperCase()))];
  const placeholders = hashes.map((_, i) => `?${i + 2}`).join(',');
  const res = await db
    .prepare(`SELECT * FROM HistoryRecords WHERE UserId = ?1 AND Hash IN (${placeholders})`)
    .bind(USER_ID, ...hashes)
    .all<DbRow>();

  const wanted = new Set(items.map((i) => `${i.type}\u0000${i.hash.toUpperCase()}`));
  return (res.results ?? [])
    .map(rowToEntity)
    // 哈希比较**大小写不敏感**（与 `getByTypeAndHash` 的 `LOWER(Hash) = LOWER(?3)` 同义）：
    // 上面预取时已把入参统一为大写，这里再按大写比对，兜住 `entity.hash` 的大小写差异。
    .filter((entity) => wanted.has(`${entity.type}\u0000${entity.hash.toUpperCase()}`));
}
