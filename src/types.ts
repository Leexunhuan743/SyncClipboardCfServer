// DTO 类型定义（协议契约见 docs/protocol.md §3）

// ProfileType 枚举值（上游 Shared/Profiles/ProfileType.cs）
export enum ProfileType {
  Text = 0,
  File = 1,
  Image = 2,
  Group = 3,
  Unknown = 4,
  None = 5,
}

// ProfileTypeFilter 位掩码（上游 Shared/Profiles/ProfileTypeFilter.cs）
export enum ProfileTypeFilter {
  None = 0,
  Text = 1 << ProfileType.Text, // 1
  File = 1 << ProfileType.File, // 2
  Image = 1 << ProfileType.Image, // 4
  Group = 1 << ProfileType.Group, // 8
  FileAndGroup = File | Group, // 10 = 2 | 8
  All = Text | File | Image | Group, // 15
}

// ProfileDto（上游 Shared/ProfileDto.cs）：JSON camelCase，Type 为枚举字符串
export interface ProfileDto {
  type: ProfileType;
  hash: string;
  text: string;
  hasData: boolean;
  dataName?: string | null; // null 时序列化保留 "dataName":null
  size?: number | null; // null 时序列化省略
}

// HistoryRecordDto（上游 Server.Core/Models/HistoryRecordDto.cs）
export interface HistoryRecordDto {
  hash: string;
  text: string;
  type: ProfileType;
  createTime: string; // ISO8601
  lastModified: string; // ISO8601
  lastAccessed: string; // ISO8601
  starred: boolean;
  pinned: boolean;
  size: number;
  hasData: boolean;
  version: number;
  isDeleted: boolean;
}

// HistoryRecordUpdateDto（上游 Server.Core/Models/HistoryRecordUpdateDto.cs）
// 注意 IsDelete 的 camelCase 是 isDelete
export interface HistoryRecordUpdateDto {
  starred?: boolean | null;
  pinned?: boolean | null;
  isDelete?: boolean | null;
  version?: number | null;
  lastModified?: string | null;
  lastAccessed?: string | null;
}

// HistoryQueryDto（multipart 表单，上游 Server.Core/Models/HistoryQueryDto.cs）
export interface HistoryQueryDto {
  page: number; // 默认 1，页大小固定 50
  before?: Date | null; // UTC；按排序字段 < before
  after?: Date | null; // UTC；按排序字段 >= after
  modifiedAfter?: Date | null; // UTC；LastModified >= modifiedAfter
  types: ProfileTypeFilter; // 默认 All
  searchText?: string | null; // LIKE %text%
  starred?: boolean | null;
  sortByLastAccessed: boolean;
}

// HistoryStatisticsDto（上游 Server.Core/Models/HistoryStatisticsDto.cs）
export interface HistoryStatisticsDto {
  totalCount: number;
  starredCount: number;
  deletedCount: number;
  activeCount: number;
  totalFileSizeMB: number;
}

// 历史记录数据库实体（D1 行，镜像 HistoryRecordEntity）
export interface HistoryRecordEntity {
  id?: number;
  userId: string;
  type: ProfileType;
  text: string;
  size: number;
  transferDataFile: string;
  filePaths: string[]; // 存储为 JSON
  hash: string;
  createTime: number; // epoch ms
  lastAccessed: number; // epoch ms
  lastModified: number; // epoch ms
  stared: boolean;
  pinned: boolean;
  version: number;
  isDeleted: boolean;
}

export const HARD_CODED_USER_ID = 'default_user';
export const PAGE_SIZE = 50;
export const HISTORY_UPDATE_THRESHOLD_MS = 5 * 60 * 1000; // ShouldUpdate 5 分钟阈值

// C# int 的范围：用于复刻 `int.TryParse` / `Enum.TryParse` 的绑定语义（超界即绑定失败）。
// **唯一定义处**：此前 src/hub.ts 另有一份私有副本、src/serialization.ts 还有一处裸字面量，
// 三处同值不同源（O1）。消费者一律从这里 import：serialization.ts（DTO 绑定校验）、
// routes/history.ts（`int.TryParse` 复刻）、hub.ts（negotiate 版本解析）。
export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

// 上游 `Profile.GetWorkingDirName(type, hash)`：
//   if (hash.Contains(Path.DirectorySeparatorChar) || hash.Contains(Path.AltDirectorySeparatorChar))
//       throw new ArgumentException("Hash contains invalid path characters.", nameof(hash));
// 即拒绝 `/` 与 `\`（Windows 上两者分别是 Alt 与 Directory 分隔符；Linux 上 Alt 同 Directory）。
//
// 本实现的 hash 参与 R2 key 构造（`history/{Type}_{Hash}/{file}`）与孤儿目录判定
// （`listHistoryWorkingDirs` 按第一个 `/` 截断工作目录名）。含 `/` 的 hash 会让这两处**不同构**：
// 记录侧是 `Text_A/B`，而 R2 侧只会被识别为目录 `Text_A/`。客户端本地也用同一规则构造路径，
// 拿到这种 hash 会抛异常/产生非法路径。故写入拒绝、读取（存储值分类）降级，storage 层另有断言兜底。
export function isValidProfileHash(hash: string): boolean {
  return !hash.includes('/') && !hash.includes('\\');
}
