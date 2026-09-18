-- SyncClipboard CfServer D1 schema（镜像上游 HistoryRecordEntity，见 docs/design.md §5.1）

CREATE TABLE IF NOT EXISTS HistoryRecords (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  UserId TEXT NOT NULL DEFAULT 'default_user',
  Type INTEGER NOT NULL,                -- ProfileType 枚举值 Text=0 File=1 Image=2 Group=3 Unknown=4 None=5
  Text TEXT NOT NULL DEFAULT '',
  Size INTEGER NOT NULL DEFAULT 0,
  TransferDataFile TEXT NOT NULL DEFAULT '',
  TransferDataSha256 TEXT NOT NULL DEFAULT '',
  TransferDataMd5 TEXT NOT NULL DEFAULT '',
  FilePaths TEXT NOT NULL DEFAULT '[]', -- JSON 数组（保留镜像列）
  Hash TEXT NOT NULL,
  CreateTime INTEGER NOT NULL,          -- epoch 毫秒 UTC
  LastAccessed INTEGER NOT NULL,        -- epoch 毫秒 UTC
  LastModified INTEGER NOT NULL,        -- epoch 毫秒 UTC
  Stared INTEGER NOT NULL DEFAULT 0,
  Pinned INTEGER NOT NULL DEFAULT 0,
  "From" TEXT NOT NULL DEFAULT '',      -- 保留列（SQLite 关键字须引号）
  Tags TEXT NOT NULL DEFAULT '[]',
  ExtraData TEXT,
  Version INTEGER NOT NULL DEFAULT 0,
  IsDeleted INTEGER NOT NULL DEFAULT 0
);

-- 先清理历史遗留的重复行（同一 UserId+Type+Hash 只保留 ID 最小的一行），
-- 否则紧接着的 UNIQUE 索引会因既有数据而创建失败。
DELETE FROM HistoryRecords
WHERE ID NOT IN (
  SELECT MIN(ID) FROM HistoryRecords GROUP BY UserId, Type, Hash
);

-- (UserId, Type, Hash) 唯一：数据库层阻止并发写产生重复记录（F5）。
-- 应用层的 exists-then-insert 无法在并发下保证唯一性。
CREATE UNIQUE INDEX IF NOT EXISTS ux_h_user_type_hash ON HistoryRecords(UserId, Type, Hash);
CREATE INDEX IF NOT EXISTS idx_h_user_type_hash ON HistoryRecords(UserId, Type, Hash);
CREATE INDEX IF NOT EXISTS idx_h_user_create   ON HistoryRecords(UserId, CreateTime);
CREATE INDEX IF NOT EXISTS idx_h_user_access   ON HistoryRecords(UserId, LastAccessed);
CREATE INDEX IF NOT EXISTS idx_h_user_modify   ON HistoryRecords(UserId, LastModified);

-- 收藏（Stared）维度的复合索引：对齐上游 EF 的 IX_History_User_Stared_CreateTime_ID /
-- IX_History_User_Stared_Type_CreateTime_ID（HistoryDbContext.OnModelCreating）。上游加这两个索引
-- 是为了让「收藏 + 时间范围 + 翻页」「收藏 + 类型 + 翻页」这类查询走索引；官方客户端的收藏筛选
-- 与统计页会用上，D1 同为 SQLite，故这张表也不该缺。
-- 上游第三个索引 IX_History_User_CreateTime_ID 不必单独建：SQLite 的索引条目隐含 rowid，
-- 而这里的 ID 就是 INTEGER PRIMARY KEY（rowid 别名），故 idx_h_user_create 已是同一形态。
CREATE INDEX IF NOT EXISTS idx_h_user_stared_create      ON HistoryRecords(UserId, Stared, CreateTime);
CREATE INDEX IF NOT EXISTS idx_h_user_stared_type_create ON HistoryRecords(UserId, Stared, Type, CreateTime);

-- 元信息表：Key='current_profile' → ProfileDto JSON（camelCase）
CREATE TABLE IF NOT EXISTS Meta (
  Key TEXT PRIMARY KEY,
  Value TEXT NOT NULL
);
