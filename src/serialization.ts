// DTO 序列化 / 反序列化（协议契约 docs/protocol.md §2-§3）
import {
  ProfileType,
  ProfileTypeFilter,
  ProfileDto,
  HistoryRecordDto,
  HistoryRecordEntity,
  HistoryRecordUpdateDto,
} from './types';

// ===== 时间 =====

// epoch ms → ISO8601（UTC，Z 后缀；客户端 DateTimeOffset.TryParse RoundtripKind 可解析）
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
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
    if (Number.isSafeInteger(n) && n >= 0 && n <= 2147483647) return n as ProfileType;
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
  if (dto.size != null) {
    obj.size = dto.size;
  }
  return JSON.stringify(obj);
}

// 解析：大小写不敏感取值（客户端总发 camelCase，防御性容忍其他大小写）
// type 处理与上游一致：键缺失 → Text；非法枚举名 → 抛错（上游 JsonException → 400）；
// Unknown/None → 抛错（上游 Profile.Create 抛 NotSupportedException）。
// 禁止静默降级为 Text —— 否则畸形输入会覆盖当前 profile 并写入历史（F8）。
export function parseProfileDto(json: string): ProfileDto {
  const raw = JSON.parse(json) as Record<string, unknown>;
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
  if (rawType == null) {
    type = ProfileType.Text;
  } else {
    type = resolveStrictProfileType(rawType);
  }
  const size = get('size');
  const dto: ProfileDto = {
    type,
    hash: (get('hash') as string) ?? '',
    text: (get('text') as string) ?? '',
    hasData: (get('hasData') as boolean) ?? false,
    dataName: (get('dataName') as string | null) ?? null,
  };
  if (typeof size === 'number') dto.size = size;
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
  const raw = JSON.parse(json) as Record<string, unknown>;
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
  if (typeof version === 'number') dto.version = version;
  // 日期字段在解析期就校验：上游是 DateTimeOffset? 模型绑定，非法串在反序列化阶段失败并返回 400；
  // 若放行到 fromIso 才抛错，路由无 catch-all → 500（F7）。
  if (typeof lastModified === 'string' && lastModified !== '') {
    assertParsableDate(lastModified);
    dto.lastModified = lastModified;
  }
  if (typeof lastAccessed === 'string' && lastAccessed !== '') {
    assertParsableDate(lastAccessed);
    dto.lastAccessed = lastAccessed;
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
