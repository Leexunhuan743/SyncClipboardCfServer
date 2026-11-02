-- SyncClipboard CfServer D1 schema（镜像上游 HistoryRecordEntity，见 docs/design.md §5.1）

CREATE TABLE IF NOT EXISTS HistoryRecords (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  UserId TEXT NOT NULL DEFAULT 'default_user',
  Type INTEGER NOT NULL,                -- ProfileType 枚举值 Text=0 File=1 Image=2 Group=3 Unknown=4 None=5
  Text TEXT NOT NULL DEFAULT '',
  Size INTEGER NOT NULL DEFAULT 0,
  TransferDataFile TEXT NOT NULL DEFAULT '',
  TransferDataHash TEXT NOT NULL DEFAULT '', -- 传输数据文件的 SHA-256（上游 3.3.0 新增列；'' = 未知）
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
  IsDeleted INTEGER NOT NULL DEFAULT 0,
  FolderId INTEGER NOT NULL DEFAULT 0   -- 收藏夹（本站独有，不进协议 DTO）：0 = 不在任何收藏夹；非 0 的记录不会被自动清理
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

-- 界面列表用的复合索引（本站独有，上游没有）：`WHERE UserId=? AND IsDeleted=? ORDER BY Pinned DESC, CreateTime DESC, ID DESC`。
-- 没有它时，每次列表 / 计数都是**全表扫描**，而回收站里的行（软删保留 30 天）也一并被扫：线上曾因回收站占到 70% 的行数，
-- 一次列表加载读 ~9,000 行；有了它，活跃视图只读活跃行、一页只读一页（~30 行），回收站再大也不影响。
-- 索引条目隐含 rowid（= ID），所以倒序扫描正好满足 `ID DESC` 的 tiebreak，不需要临时排序。
-- ⚠️ 只用已存在的老列：部署先跑本文件、再跑 tools/migrate-d1.mjs 加新列，索引里不能出现新列（见文末 Folders 的说明）。
CREATE INDEX IF NOT EXISTS idx_h_user_list ON HistoryRecords(UserId, IsDeleted, Pinned, CreateTime);

-- 哈希查找的表达式索引：`getByTypeAndHash` 与批量放入收藏夹都写成 `LOWER(Hash) = LOWER(?)`（哈希比较大小写不敏感），
-- 而函数包着列时上面那个 (UserId, Type, Hash) 唯一索引**用不上**，只能用 (UserId, Type) 前缀把该类型的行逐行扫一遍
-- （线上实测 ~540 行/次）。官方客户端的每次同步、每次 `GET /api/history/{id}` 都会走它：两台客户端一小时 ~700 次，
-- 一天就能把 D1 免费额度（500 万行读/天）单独烧光 —— 线上因此真的被 D1 拒绝过服务。
-- 索引表达式必须与查询里的 `LOWER(Hash)` 逐字一致，规划器才会选它；语义不变（大小写不敏感）。
-- 同样只引用老列（部署先跑本文件、再跑迁移）。
-- 列序是 (UserId, LOWER(Hash), Type)：哈希点查的三个等值条件照样全用上；而 Type 放最后，按类型筛选的列表就不会被这个索引的
-- (UserId, Type) 前缀抢走（那会让列表重新扫该类型的全部行、含回收站），仍然走上面的 idx_h_user_list。
CREATE INDEX IF NOT EXISTS idx_h_user_type_lhash ON HistoryRecords(UserId, LOWER(Hash), Type);

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

-- 收藏夹（本站独有的界面功能，官方协议不感知）：用户自定义名字的分组，一条记录至多放进一个。
-- 放进收藏夹的记录**不会被自动清理**（保留期 / 条数上限都跳过它们，见 src/db.ts 的 softDeleteOldest），
-- 且独立于星标：官方客户端写 `starred` / 重传同一条记录都改不了它（FolderId 不在协议写入的列里）。
-- 注意：这里**不**给 HistoryRecords.FolderId 建索引 —— 部署时先跑本文件、再跑 tools/migrate-d1.mjs 给老库加列，
-- 老库在跑到这里时还没有这一列，建索引会让整个 schema 步骤失败。
CREATE TABLE IF NOT EXISTS Folders (
  Id INTEGER PRIMARY KEY AUTOINCREMENT,
  UserId TEXT NOT NULL DEFAULT 'default_user',
  Name TEXT NOT NULL,
  SortOrder INTEGER NOT NULL DEFAULT 0,
  CreateTime INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_folders_user_name ON Folders(UserId, Name);
