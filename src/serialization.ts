// DTO 序列化 / 反序列化（协议契约 docs/protocol.md §2-§3）
import {
  ProfileType,
  ProfileTypeFilter,
  ProfileDto,
  HistoryRecordDto,
  HistoryRecordEntity,
  HistoryRecordUpdateDto,
  INT32_MIN,
  INT32_MAX,
  isValidProfileHash,
} from './types';

// ===== 时间 =====

// epoch ms → ISO8601（UTC，Z 后缀；客户端 DateTimeOffset.TryParse RoundtripKind 可解析）
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

// 历史数据体积（字节 → 上游口径的 MB）。
// 口径来自上游 `GetStatisticsAsync`：保留两位小数；**有数据但不足 0.01MB 时取 0.01**，
// 让「非零体积」在界面上不会显示成 0。
// 单独成函数是因为它出现在三处（官方 statistics、UI statistics、UI info），
// 此前 UI info 用了整数四舍五入，同一个数在统计页显示 0.48、在 info 里显示 0。
export function historySizeMB(bytes: number): number {
  let mb = bytes / (1024.0 * 1024.0);
  mb = Math.round(mb * 100) / 100;
  if (bytes > 0 && mb === 0) mb = 0.01;
  return mb;
}

// ISO8601 → epoch ms。兼容 C# 输出（+00:00 后缀、7 位小数）与 JS toISOString（Z）。
export function fromIso(s: string): number {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date string: ${s}`);
  }
  return ms;
}

// 解析失败回退当前时间（上游 ParseDateTimeOffset → DateTimeOffset.UtcNow）
export function parseDateOrNow(s: string | null | undefined): number {
  if (s == null || s === '') return Date.now();
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? Date.now() : ms;
}

// ===== 枚举 =====

const PROFILE_TYPE_NAMES: Record<string, ProfileType> = {
  TEXT: ProfileType.Text,
  FILE: ProfileType.File,
  IMAGE: ProfileType.Image,
  GROUP: ProfileType.Group,
  UNKNOWN: ProfileType.Unknown,
  NONE: ProfileType.None,
};

export function profileTypeToString(t: ProfileType): string {
  switch (t) {
    case ProfileType.Text: return 'Text';
    case ProfileType.File: return 'File';
    case ProfileType.Image: return 'Image';
    case ProfileType.Group: return 'Group';
    case ProfileType.Unknown: return 'Unknown';
    default: return 'None';
  }
}

// 解析枚举名（大小写不敏感）或数字枚举串；非法/空 → undefined。
// 上游 `Enum.TryParse<ProfileType>(s)` **接受数字**（`"0-HASH"` 解析为 Text），
// 且对未定义值也返回成功——因此越界数字（如 "6"）解析后查询不到记录 → 404，
// 而不是在解析阶段被拒为 400。数字超出 0..5 时按原值返回，交由上层查询自然落空。
export function parseProfileType(s: string | null | undefined): ProfileType | undefined {
  if (s == null) return undefined;
  const trimmed = s.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    // Enum.TryParse 接受任意整数；这里限制在 int32 内避免 Number 精度问题
    if (Number.isSafeInteger(n) && n >= 0 && n <= INT32_MAX) return n as ProfileType;
    return undefined;
  }
  return PROFILE_TYPE_NAMES[trimmed.toUpperCase()];
}

// ProfileTypeFilter 位掩码解析：支持 "All"、"Text,Image"、"FileAndGroup"、"None"，大小写不敏感。
// 与上游模型绑定一致：字段缺失或空白 → 默认 All（DTO 初始化值）；
// **非法名称 → 抛 InvalidQueryValueError**（上游 [ApiController] 对枚举绑定失败自动 400），
// 此前静默回退 All 会把「拼错的过滤条件」变成「返回全部记录」。
const FILTER_FLAG_NAMES: Record<string, number> = {
  NONE: ProfileTypeFilter.None,
  TEXT: ProfileTypeFilter.Text,
  FILE: ProfileTypeFilter.File,
  IMAGE: ProfileTypeFilter.Image,
  GROUP: ProfileTypeFilter.Group,
  FILEANDGROUP: ProfileTypeFilter.FileAndGroup,
  ALL: ProfileTypeFilter.All,
};

// 查询参数非法（上游模型绑定失败语义）→ 路由映射为 400
export class InvalidQueryValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQueryValueError';
  }
}

export function parseProfileTypeFilter(
  s: string | null | undefined,
  fieldName = 'Types',
): ProfileTypeFilter {
  if (s == null || s.trim() === '') return ProfileTypeFilter.All;
  const trimmed = s.trim();
  // 上游 `Enum.TryParse<ProfileTypeFilter>(value)` **接受数字**（如 "5" = Text|Image）；
  // 数字与名称不能混用（TryParse("Text,5") 失败）。此前数字一律 400，与上游相左（F27）。
  if (/^[+-]?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n < INT32_MIN || n > INT32_MAX) {
      throw new InvalidQueryValueError(`Invalid ${fieldName} value: ${trimmed}`);
    }
    return n as ProfileTypeFilter;
  }
  let value = 0;
  for (const part of s.split(',')) {
    const name = part.trim();
    if (name === '') continue;
    const v = FILTER_FLAG_NAMES[name.toUpperCase()];
    if (v === undefined) {
      throw new InvalidQueryValueError(`Invalid ${fieldName} value: ${name}`);
    }
    value |= v;
  }
  return value as ProfileTypeFilter;
}

// ===== ProfileDto =====

// 序列化规则：camelCase；type 枚举字符串；size 为 null 时整键省略（上游 WhenWritingNull），dataName 为 null 时保留 null
export function profileDtoToJson(dto: ProfileDto): string {
  const obj: Record<string, unknown> = {
    type: profileTypeToString(dto.type),
    hash: dto.hash,
    text: dto.text,
    hasData: dto.hasData,
  };
  // 上游 ProfileDto.DataName 无 JsonIgnore → 为 null 时输出 "dataName":null（仅 Size 有 WhenWritingNull）
  obj.dataName = dto.dataName ?? null;
  // 上游 3.3.0：TransferDataHash 有 `JsonIgnore(WhenWritingNull)` ⇒ 非 null 才输出（与 size 同规则）
  if (dto.transferDataHash != null) {
    obj.transferDataHash = dto.transferDataHash;
  }
  if (dto.size != null) {
    obj.size = dto.size;
  }
  return JSON.stringify(obj);
}

// 请求体必须是 JSON **对象**：上游是 `[FromBody] ProfileDto`，反序列化失败即 400。
// 此前 `[]` / `null` / `123` 会被当成「字段全缺失的 DTO」继续处理，最终写入一条空文本历史
// 记录并把它设为当前 profile——客户端发错 body 会静默污染数据（PUT /SyncClipboard.json）。
export function requireJsonObject(json: string, what: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// 存储的「当前 profile」JSON 的可用性判定（对齐上游 `GetSyncProfile` 的降级分支）。
// 上游读文件后 `JsonSerializer.Deserialize<ProfileDto>(text) ?? new ProfileDto()`，有两个降级出口：
//   - 反序列化**抛错**（含 `[]`、非法枚举名、非对象）→ catch → `new TextProfile("").ToProfileDto()`
//     （hash = SHA256("")、size = 0）
//   - 反序列化得到 **null**（文本为 `null`）→ `new ProfileDto()`
//     （hash = ""、size 为 null 故序列化时省略）
// 本实现把当前 profile 存在 D1 的 Meta 表里，正常路径写入的必为合法 JSON；此判定用于
// 「存储值被外部改坏 / 未来写入路径出错」时仍能像上游一样优雅降级，而不是把坏 JSON 发给客户端
// （客户端 `ReadFromJsonAsync` 会抛异常 → 剪贴板同步中断）。
export type StoredProfileHealth = 'ok' | 'corrupt' | 'null-dto';

export function classifyStoredProfile(raw: string): StoredProfileHealth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'corrupt';
  }
  if (parsed === null) return 'null-dto';
  // 数组 / 标量：`Deserialize<ProfileDto>` 抛 JsonException → catch 分支
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return 'corrupt';
  const type = (parsed as Record<string, unknown>).type;
  // 键缺失 → Type 取默认 Text（不抛错）；数字 → JsonStringEnumConverter 接受整数枚举值
  if (type === undefined) return 'ok';
  if (typeof type === 'number') return Number.isInteger(type) ? 'ok' : 'corrupt';
  // 字符串必须是合法枚举名（大小写不敏感，与 JsonStringEnumConverter 一致；数字串亦可）
  if (typeof type !== 'string') return 'corrupt';
  if (parseProfileType(type) === undefined) return 'corrupt';
  // Hash 同样要能安全使用：它参与 R2 key 构造（见 types.isValidProfileHash）。含路径分隔符的
  // 存储值若原样返回，客户端会用同一规则构造本地路径 → 抛异常/产生非法路径。视同损坏并降级。
  const hash = (parsed as Record<string, unknown>).hash;
  if (hash === undefined || hash === null) return 'ok';
  if (typeof hash !== 'string') return 'corrupt';
  return isValidProfileHash(hash) ? 'ok' : 'corrupt';
}

// 字段的 JSON 类型必须与上游 `[FromBody] ProfileDto` 的模型绑定同口径：类型不符在
// System.Text.Json 里是**反序列化失败 ⇒ 400**。
// 此前四个字段一律 `as string` / `as boolean` 强转，于是 `{"hash":123}`、`{"text":[1,2]}`、
// `{"dataName":123,"hasData":true}` 会一路走到字符串运算里抛 TypeError ⇒ 未处理的 **500**
// （2026-09-20 实测 5 例；`{"hasData":"false"}` 更糟：字符串被当真值，于是「没有数据」被判成
// 「有数据」，只是恰好被后面那条 400 文案掩盖了）。F6 已按同一口径收紧 size / version，
// 这里补齐其余四个字段。
//
// ⚠️ `null` 的处置**按字段的可空性分两类**（判据就是上游 `ProfileDto` 的声明）：
//   · 非空**引用**类型 —— `Hash` / `Text`（`string`）、`DataName`（`string?`）：STJ 允许 null
//     （运行时不做 NRT 校验）⇒ null 与缺省同义，本实现回落成 `''` / `null`；
//   · 非空**值**类型 —— `Type`（`ProfileType`）、`HasData`（`bool`）：STJ 把 null 判成
//     反序列化失败 ⇒ **400**，故这两个字段的显式 null 一律拒绝；而**键缺失**仍是缺省
//     （`Type` → Text、`HasData` → false）。
//     （对照：`HistoryRecordUpdateDto` 的字段全是 `bool?` / `int?` / `DateTimeOffset?`，
//     那边 null 就是「未提供」—— 两处口径不同，是因为上游的声明不同。）
function readString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

// `undefined` = 键缺失（缺省）；显式 `null` 落到下面的类型判定 ⇒ 抛错（`bool` 是非空值类型）。
function readBool(value: unknown, field: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

// 解析：大小写不敏感取值（客户端总发 camelCase，防御性容忍其他大小写）
// type 处理与上游一致：键缺失 → Text；非法枚举名 → 抛错（上游 JsonException → 400）；
// Unknown/None → 抛错（上游 Profile.Create 抛 NotSupportedException）。
// 禁止静默降级为 Text —— 否则畸形输入会覆盖当前 profile 并写入历史（F8）。
export function parseProfileDto(json: string): ProfileDto {
  const raw = requireJsonObject(json, 'ProfileDto');
  const get = (key: string): unknown => {
    if (raw[key] !== undefined) return raw[key];
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(raw)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  };
  const rawType = get('type');
  let type: ProfileType;
  // ⚠️ 只把**键缺失**当缺省（→ Text）：`ProfileType` 是非空值类型，`null` 在上游是反序列化
  // 失败 ⇒ 400。从前写成 `== null`，于是 `{"type":null}` 被静默当成 Text 并覆盖当前 profile。
  if (rawType === undefined) {
    type = ProfileType.Text;
  } else {
    type = resolveStrictProfileType(rawType);
  }
  const size = get('size');
  const dto: ProfileDto = {
    type,
    hash: readString(get('hash'), 'hash') ?? '',
    text: readString(get('text'), 'text') ?? '',
    hasData: readBool(get('hasData'), 'hasData') ?? false,
    dataName: readString(get('dataName'), 'dataName'),
  };
  // 上游 3.3.0 #413：`TransferDataHash`（`string?`）声明传输数据文件的 SHA-256。非 null 必须是
  // 64 位十六进制（大小写不限），统一存大写（`Utility.NormalizeSHA256` 的语义，非法即
  // ArgumentException → 400）。null 与缺省同义（WhenWritingNull）。
  const transferDataHash = readString(get('transferDataHash'), 'transferDataHash');
  if (transferDataHash !== null) {
    if (!/^[0-9a-fA-F]{64}$/.test(transferDataHash)) {
      throw new Error(`Hash must be a 64-character SHA-256 hex string. (Parameter 'hash')`);
    }
    dto.transferDataHash = transferDataHash.toUpperCase();
  }
  // size 对齐上游 `ProfileDto.Size`（`long?`）的模型绑定：非空值必须是**整数**（且 JS 能精确
  // 表示 ⇒ Number.isSafeInteger），否则绑定失败 → 400。此前只判 `typeof === 'number'`：
  // `1.5` / `1e400`（Infinity）都会被当成合法体积写进记录（F6）。符号不限（上游 long 可为负）。
  if (size !== undefined && size !== null) {
    if (typeof size !== 'number' || !Number.isSafeInteger(size)) {
      throw new Error(`size must be a long: ${String(size)}`);
    }
    dto.size = size;
  }
  return dto;
}

// 严格解析 DTO 的 type：枚举名（大小写不敏感）或数字枚举串（0..3），其余一律抛错。
function resolveStrictProfileType(rawType: unknown): ProfileType {
  const s = String(rawType).trim();
  const byName = parseProfileType(s);
  if (byName !== undefined && byName !== ProfileType.Unknown && byName !== ProfileType.None) {
    return byName;
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n === ProfileType.Text || n === ProfileType.File || n === ProfileType.Image || n === ProfileType.Group) {
      return n;
    }
  }
  throw new Error(`Unsupported profile type: ${s}`);
}

// ===== HistoryRecordDto / Entity =====

export function entityToDto(e: HistoryRecordEntity): HistoryRecordDto {
  return {
    hash: e.hash,
    text: e.text,
    type: e.type,
    createTime: toIso(e.createTime),
    lastModified: toIso(e.lastModified),
    lastAccessed: toIso(e.lastAccessed),
    starred: e.stared,
    pinned: e.pinned,
    size: e.size,
    hasData: e.filePaths.length > 0 || e.transferDataFile !== '',
    version: e.version,
    isDeleted: e.isDeleted,
  };
}

// SignalR 广播 / HTTP 响应用的协议 wire 格式（type 为枚举字符串）
export function entityToDtoWire(e: HistoryRecordEntity): Record<string, unknown> {
  return {
    hash: e.hash,
    text: e.text,
    type: profileTypeToString(e.type),
    createTime: toIso(e.createTime),
    lastModified: toIso(e.lastModified),
    lastAccessed: toIso(e.lastAccessed),
    starred: e.stared,
    pinned: e.pinned,
    size: e.size,
    hasData: e.filePaths.length > 0 || e.transferDataFile !== '',
    version: e.version,
    isDeleted: e.isDeleted,
  };
}

// ProfileDto 广播 wire 格式（type 字符串、dataName/size null 时整键省略）
export function profileDtoToWire(dto: ProfileDto): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    type: profileTypeToString(dto.type),
    hash: dto.hash,
    text: dto.text,
    hasData: dto.hasData,
  };
  // 上游 ProfileDto.DataName 无 JsonIgnore → 为 null 时输出 "dataName":null（仅 Size 有 WhenWritingNull）
  obj.dataName = dto.dataName ?? null;
  // 上游 3.3.0：TransferDataHash 有 WhenWritingNull ⇒ 非 null 才输出
  if (dto.transferDataHash != null) {
    obj.transferDataHash = dto.transferDataHash;
  }
  if (dto.size != null) {
    obj.size = dto.size;
  }
  return obj;
}

export function historyDtoToJson(dto: HistoryRecordDto): string {
  return JSON.stringify({
    hash: dto.hash,
    text: dto.text,
    type: profileTypeToString(dto.type),
    createTime: dto.createTime,
    lastModified: dto.lastModified,
    lastAccessed: dto.lastAccessed,
    starred: dto.starred,
    pinned: dto.pinned,
    size: dto.size,
    hasData: dto.hasData,
    version: dto.version,
    isDeleted: dto.isDeleted,
  });
}

export function historyListToJson(list: HistoryRecordDto[]): string {
  return `[${list.map(historyDtoToJson).join(',')}]`;
}

// HistoryRecordUpdateDto 解析（camelCase；注意 IsDelete → isDelete）；大小写不敏感
export function parseHistoryRecordUpdateDto(json: string): HistoryRecordUpdateDto {
  // 同上：`[]` 曾被当作「空 dto」→ 走 ShouldUpdate 分支推进版本/时间戳，静默改动了记录（PATCH）
  const raw = requireJsonObject(json, 'HistoryRecordUpdateDto');
  const get = (key: string): unknown => {
    if (raw[key] !== undefined) return raw[key];
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(raw)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  };
  const dto: HistoryRecordUpdateDto = {};
  const starred = get('starred');
  const pinned = get('pinned');
  const isDelete = get('isDelete');
  const version = get('version');
  const lastModified = get('lastModified');
  const lastAccessed = get('lastAccessed');
  if (typeof starred === 'boolean') dto.starred = starred;
  if (typeof pinned === 'boolean') dto.pinned = pinned;
  if (typeof isDelete === 'boolean') dto.isDelete = isDelete;
  // version 对齐上游 `HistoryRecordUpdateDto.Version`（`int?`）的模型绑定：非空值必须是
  // 落在 int32 内的**有限整数**，否则绑定失败 → 400。此前只判 `typeof === 'number'`：
  // `1.5` 被原样持久化（污染该记录的版本语义）、`1e400` 解析为 Infinity 后落库触发 500（F6）。
  // 符号不限（上游 int? 不限制负数；负值由 shouldUpdate 自然判成 409/不更新）。
  if (version !== undefined && version !== null) {
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < INT32_MIN ||
      version > INT32_MAX
    ) {
      throw new Error(`version must be an int32: ${String(version)}`);
    }
    dto.version = version;
  }
  // 日期字段在解析期就校验，口径与上游 `DateTimeOffset?` 的 `[FromBody]` 绑定一致：
  //   · `null` / 键缺失 → 「未提供」（上游得到 null，该字段不参与更新）
  //   · 其余取值**必须**是能解析的日期串 —— 类型不符（数字/对象/数组）与**空串**
  //     在 System.Text.Json 里都是反序列化失败 ⇒ **400**
  // 此前只判 `typeof === 'string' && !== ''`，于是 `{"lastModified":123}` 被**静默忽略**：
  // 请求方以为改掉了、服务端没改（F6 给 version 收紧类型时是同一条口径，这里补齐）。
  // F7 的原有作用保持不变：非法串在解析期抛错，不会拖到 fromIso 才炸成 500。
  for (const [field, value] of [
    ['lastModified', lastModified],
    ['lastAccessed', lastAccessed],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new Error(`${field} must be a date string`);
    assertParsableDate(value);
    dto[field] = value;
  }
  return dto;
}

function assertParsableDate(value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid date string: ${value}`);
  }
}

// 409 冲突响应体（服务器当前值，HistoryRecordUpdateDto）
export function updateDtoToJson(dto: HistoryRecordUpdateDto): string {
  const obj: Record<string, unknown> = {
    starred: dto.starred ?? null,
    pinned: dto.pinned ?? null,
    isDelete: dto.isDelete ?? null,
    version: dto.version ?? null,
    lastModified: dto.lastModified ?? null,
    lastAccessed: dto.lastAccessed ?? null,
  };
  return JSON.stringify(obj);
}

export function entityToUpdateDto(e: HistoryRecordEntity): HistoryRecordUpdateDto {
  return {
    starred: e.stared,
    pinned: e.pinned,
    isDelete: e.isDeleted,
    version: e.version,
    lastModified: toIso(e.lastModified),
    lastAccessed: toIso(e.lastAccessed),
  };
}

// ===== LIKE 模式上限（G6）=====
// 约束不是「搜索串有多长」，而是**拼出来的 LIKE 模式**有多长：D1 上越过它的查询直接报错，
// 表现为未处理的 500（非资源类缺陷）。实测（2026-09-20 本地 dev server，两个 LIKE 站点各测一次）：
//   · `Text LIKE '%…%'`                 —— 搜索串 48 字节 ⇒ 模式 50 字节 **通过**；49 字节 ⇒ 51 **报错**
//   · `TransferDataFile LIKE '%/' || ?` —— 名字   48 字节 ⇒ 模式 50 字节 **通过**；49 字节 ⇒ 51 **报错**
// 即引擎口径是「模式 ≤ MAX_LIKE_PATTERN_BYTES」，下面的「搜索串预算」由它减掉前后两个 % 推出。
// 以**字节**而非字符计，避免 CJK/emoji（一字 3~4 字节）搜到一半才炸。
//
// ⚠️ 消费者必须保证**送进 SQL 的最终模式**不超上限：LIKE 转义会把 `%`、`_` 与反斜杠各自变成
// 两个字符，那一步之后要**再校一次**（`assertLikePatternFits`）—— 否则 48 字节的入参能拼出
// 98 字节的模式。
export const MAX_LIKE_PATTERN_BYTES = 50;
export const MAX_SEARCH_BYTES = MAX_LIKE_PATTERN_BYTES - 2;
const SEARCH_ENCODER = new TextEncoder();

export function normalizeSearchText(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  if (SEARCH_ENCODER.encode(raw).length > MAX_SEARCH_BYTES) {
    throw new InvalidQueryValueError(`SearchText must be at most ${MAX_SEARCH_BYTES} bytes`);
  }
  return raw;
}

// **转义之后**的预算校核（LIKE 元字符转义会把一个字符变成两个）。不转义的那一侧（协议面）
// 用 normalizeSearchText 就够了；转义的那一侧（UI 面）必须再校这一道 —— 实测 25 个 %（25 字节，
// 离上面那条线还差一半）在真 D1 上正是 500。
export function assertLikePatternFits(escapedText: string): void {
  if (SEARCH_ENCODER.encode(escapedText).length > MAX_SEARCH_BYTES) {
    throw new InvalidQueryValueError(
      `SearchText must be at most ${MAX_SEARCH_BYTES} bytes after LIKE escaping (each of % _ \\ counts as 2)`,
    );
  }
}
