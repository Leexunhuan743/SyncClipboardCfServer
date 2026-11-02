// 界面里流动的数据形状。服务端 DTO 在 `src/types.ts` / `src/ui/query.ts`；
// 这里是**归一化之后**的前端视角（见 api.ts 的 normalizeItem）。

export type ItemType = 'Text' | 'Image' | 'File' | 'Group';

export interface Item {
  id: number;
  type: ItemType;
  hash: string;
  /** `Type-hash`：行对账与选择集的稳定标识 */
  key: string;
  /** 列表里被服务端截断到 500 字符；完整正文要 `api.get` */
  text: string;
  textTruncated: boolean;
  size: number;
  hasData: boolean;
  dataName: string | null;
  starred: boolean;
  pinned: boolean;
  /** 所在收藏夹的 id；0 = 不在任何收藏夹（放进收藏夹的记录不会被自动清理） */
  folderId: number;
  isDeleted: boolean;
  version: number;
  createTime: string;
  lastModified: string;
  lastAccessed: string;
}

/** 收藏夹（本站独有）：用户自定义名字；`count` 是活跃（不在回收站）成员条数 */
export interface Folder {
  id: number;
  name: string;
  sortOrder: number;
  count: number;
}

export type SortField = 'createTime' | 'lastModified' | 'lastAccessed' | 'size' | 'type';
export type RangeKey = 'all' | 'today' | '7d' | '30d' | 'custom';
export type TypeFilter = 'All' | ItemType;

export interface Filters {
  page: number;
  pageSize: number;
  types: TypeFilter;
  starred: boolean;
  /** 只看某个收藏夹（id）；null = 不按收藏夹筛 */
  folder: number | null;
  deleted: boolean;
  search: string;
  range: RangeKey;
  after: number | null;
  before: number | null;
  sort: SortField;
  order: 'asc' | 'desc';
}

export type ByType = Partial<Record<ItemType, number>>;

export interface Retention {
  maxSavedHistoryCount: number;
  retentionMinutes: number;
  maxCountSource: 'meta' | 'env' | 'default';
  retentionSource: 'meta' | 'env' | 'default';
}

export interface DeploymentInfo {
  version: string;
  serverUrl: string;
  hubTransports: { transport: string; transferFormats: string[] }[];
  retention: Retention;
  /** 轻量概览（`?storage=0`）里为 null：沿用上一次取到的值 */
  storage: { totalBytes: number | null; totalFileSizeMB: number | null };
  limits: { maxUploadBytes: number };
  counts: { total: number; active: number; starred: number; deleted: number; byType: ByType };
  cleanup: {
    lastRunAt: string | null;
    lastCompletedAt: string | null;
    lastError: string | null;
    cursors: Record<string, number>;
  };
}

export interface Overview {
  stats: {
    totalCount: number;
    activeCount: number;
    starredCount: number;
    deletedCount: number;
    totalFileSizeMB: number | null;
  };
  byType: ByType;
  byTypeActive: ByType;
  starredCountActive: number;
  starredCountDeleted: number;
  /** 变更信号：只有 lastModified 一个值（与 /ui/api/poll 同口径；以前还有 count，需要扫全表） */
  marker: { lastModified: number };
  folders: Folder[];
  info: DeploymentInfo;
  serverTime: string;
}

export interface ActivityDay {
  day: string;
  total: number;
  Text: number;
  Image: number;
  File: number;
  Group: number;
}

export interface IntegrityReport {
  checkedAt: string;
  recordsWithData: number;
  historyObjects: number;
  missingCount: number;
  missingTruncated: boolean;
  missing: { type: string; hash: string; text: string; createTime: string; size: number }[];
}

export type PushState = 'offline' | 'connecting' | 'live';
