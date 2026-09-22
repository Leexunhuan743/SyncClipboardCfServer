// D1 访问层（docs/design.md §5.1，行为对照上游 HistoryService / HistoryHelper）
import {
  HARD_CODED_USER_ID,
  PAGE_SIZE,
  HISTORY_UPDATE_THRESHOLD_MS,
  HistoryRecordEntity,
  HistoryQueryDto,
  HistoryRecordUpdateDto,
  ProfileType,
  ProfileTypeFilter,
  HistoryStatisticsDto,
} from './types';
import { fromIso } from './serialization';
import { formatWorkingDirName } from './storage';

// ===== 本模块负责的共享原语 =====
// （`INT32_MIN/MAX` 不是其中之一：它们留在 src/types.ts，与其它领域常量同处 —— 见那里的注。）

// 取路径末段。**协议面所有"从 dto 里取文件名"的地方都必须走它**：
// 上游 `Path.GetFileName(dataName)` 在 PUT 与 PATCH 两条路径上都这么做，两处若各写一份，
// 迟早对"含 `/` 的 dataName"给出不同解释（此前 src/profile.ts 就有一份逐字复制品 basenameOf，O1）。
export function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

// 400 语义的**唯一**错误类型。此前 src/profile.ts 另有一份同名类，逼得两个路由要写
// `BadRequestError as DbBadRequestError` 再分别 catch 两次（O1）。合并后两边 `instanceof` 同源。
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

// D1 行形状与映射对 UI 查询层开放：UI 需要按自己的排序/分页读同一张表，
// 若另写一份映射，两处对 NULL / 布尔列的解释迟早分叉。
export interface DbRow {
  ID: number;
  UserId: string;
  Type: number;
  Text: string;
  Size: number;
  TransferDataFile: string;
  TransferDataHash: string;
  FilePaths: string;
  Hash: string;
  CreateTime: number;
  LastAccessed: number;
  LastModified: number;
  Stared: number;
  Pinned: number;
  Version: number;
  IsDeleted: number;
}

export function rowToEntity(r: DbRow): HistoryRecordEntity {
  let filePaths: string[] = [];
  try {
    const parsed = JSON.parse(r.FilePaths);
    if (Array.isArray(parsed)) filePaths = parsed as string[];
  } catch {
    /* 保留空数组 */
  }
  return {
    id: r.ID,
    userId: r.UserId,
    type: r.Type as ProfileType,
    text: r.Text,
    size: r.Size,
    transferDataFile: r.TransferDataFile,
    transferDataHash: r.TransferDataHash ?? '',
    filePaths,
    hash: r.Hash,
    createTime: r.CreateTime,
    lastAccessed: r.LastAccessed,
    lastModified: r.LastModified,
    stared: r.Stared !== 0,
    pinned: r.Pinned !== 0,
    version: r.Version,
    isDeleted: r.IsDeleted !== 0,
  };
}

function entityParams(e: HistoryRecordEntity): (string | number)[] {
  return [
    e.userId,
    e.type,
    e.text,
    e.size,
    e.transferDataFile,
    e.transferDataHash ?? '',
    JSON.stringify(e.filePaths),
    e.hash,
    e.createTime,
    e.lastAccessed,
    e.lastModified,
    e.stared ? 1 : 0,
    e.pinned ? 1 : 0,
    e.version,
    e.isDeleted ? 1 : 0,
  ];
}

const INSERT_SQL = `INSERT INTO HistoryRecords
  (UserId, Type, Text, Size, TransferDataFile, TransferDataHash, FilePaths, Hash, CreateTime, LastAccessed, LastModified, Stared, Pinned, Version, IsDeleted)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`;

const UPDATE_ALL_SQL = `UPDATE HistoryRecords SET
  UserId=?1, Type=?2, Text=?3, Size=?4, TransferDataFile=?5, TransferDataHash=?6, FilePaths=?7, Hash=?8,
  CreateTime=?9, LastAccessed=?10, LastModified=?11, Stared=?12, Pinned=?13, Version=?14, IsDeleted=?15`;

// 仅识别 (UserId,Type,Hash) 唯一约束冲突，避免把其它 INSERT 失败误判成「并发冲突」后静默吞掉（F5 回归）。
// D1 会把底层 SQLite 错误包一层（message 形如 "D1_ERROR: UNIQUE constraint failed: ..."），
// 细节也可能挂在 cause 上，故沿 cause 链取若干层文本再判定。
function isUniqueConstraintError(err: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const m = (cur as { message?: unknown }).message;
    if (typeof m === 'string') parts.push(m);
    cur = (cur as { cause?: unknown }).cause;
  }
  const text = parts.join(' | ');
  return /unique constraint failed/i.test(text) && /(historyrecords|ux_h_user_type_hash)/i.test(text);
}

// 更新判定（上游 HistoryHelper.ShouldUpdate）：
// gap <= 5 分钟 → newVersion >= oldVersion；否则 → newLastModified >= oldLastModified
export function shouldUpdate(
  oldVersion: number,
  newVersion: number,
  oldLastModified: number,
  newLastModified: number,
): boolean {
  const gap = Math.abs(newLastModified - oldLastModified);
  if (gap <= HISTORY_UPDATE_THRESHOLD_MS) {
    return newVersion >= oldVersion;
  }
  return newLastModified >= oldLastModified;
}

// `listActiveRecordsWithData` 的行形状：数据完整性自检的输入（只取这 6 列，不是整行）。
export interface DataRecordRow {
  type: ProfileType;
  hash: string;
  /** DB 里的 TransferDataFile 原文（可能含目录部分，期望的 R2 key 取 basename） */
  transferDataFile: string;
  text: string;
  createTime: number;
  size: number;
}

export class HistoryDb {
  constructor(private db: D1Database) {}

  // Type + Hash 查询。**大小写不敏感**（对齐上游 EF.Functions.Like 对 ASCII 的大小写行为），
  // 但**只对齐这一半**：上游 `HistoryService.cs:255` 把 hash 当 LIKE 的**模式**，`%` 与 `_` 在那里是
  // 通配符（`GET /api/history/Text-<前 8 位>%` 会在上游命中该记录，本实现返回 404）。这里用等值比较，
  // 既更严格、也能走 ux_h_user_type_hash 的索引。完整对照与 A/B 实测见 docs/protocol.md §10
  // 「hash 的匹配方式」，处置决定见 docs/upstream-defects.md 的 D1。
  async getByTypeAndHash(type: ProfileType, hash: string): Promise<HistoryRecordEntity | null> {
    const res = await this.db
      .prepare(
        `SELECT * FROM HistoryRecords WHERE UserId = ?1 AND Type = ?2 AND LOWER(Hash) = LOWER(?3) LIMIT 1`,
      )
      .bind(HARD_CODED_USER_ID, type, hash)
      .first<DbRow>();
    return res ? rowToEntity(res) : null;
  }

  // 插入新记录，返回带 ID 的实体。
  // 若因 (UserId,Type,Hash) 唯一约束（schema.sql: ux_h_user_type_hash）失败，说明在
  // 「查无 → 插入」之间被并发写入抢先建了同 hash 行（F5）。此时不裸覆盖，而是复刻上游
  // HistoryService.AddRecordDto.UpdateExistingRecordDto 的判定：
  //   - 仅当 existing.IsDeleted，或 ShouldUpdate(existing.Version, incoming.Version, …) 为真才合并；
  //   - 合并时 Version = Math.Max(incoming.Version, existing.Version + 1)，绝不倒退；
  //   - 内容字段（Text/Size/TransferDataFile/FilePaths/Hash）沿用既有行，只拷元数据
  //     （上游 UpdateEntityFields 语义）；incoming 更旧时直接 no-op 返回既有行。
  // 其它原因的 INSERT 失败（瞬时故障 / NOT NULL / datatype 等）必须原样抛出——否则真实错误被
  // 静默吞掉、并被误当作冲突去覆盖既有行。调用方可传 onConflict 覆盖默认合并策略
  // （PUT /SyncClipboard.json 的 AddProfile 已存在分支语义不同）。
  async insert(
    entity: HistoryRecordEntity,
    onConflict?: (existing: HistoryRecordEntity) => Promise<HistoryRecordEntity>,
  ): Promise<HistoryRecordEntity> {
    try {
      const res = await this.db.prepare(INSERT_SQL).bind(...entityParams(entity)).run();
      return { ...entity, id: Number(res.meta.last_row_id) };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const existing = await this.getByTypeAndHash(entity.type, entity.hash);
      if (!existing) throw err; // 唯一冲突却查不到同 key 行 → 不是预期冲突，原样抛
      if (onConflict) return await onConflict(existing);
      if (
        existing.isDeleted ||
        shouldUpdate(existing.version, entity.version, existing.lastModified, entity.lastModified)
      ) {
        const merged: HistoryRecordEntity = {
          ...existing, // 保留既有行的内容字段
          createTime: entity.createTime,
          lastAccessed: entity.lastAccessed,
          lastModified: entity.lastModified,
          stared: entity.stared,
          pinned: entity.pinned,
          version: Math.max(entity.version, existing.version + 1),
          isDeleted: entity.isDeleted,
        };
        await this.updateEntity(merged);
        return merged;
      }
      return existing; // incoming 更旧 → 保留既有行，不写入
    }
  }

  // 全字段更新。15 列清单与 `entityParams` 逐位对位（位置绑定，编号错会静默写错列）；
  // 只此一份，updateEntity 与 updateEntityIfVersion 共用，加列/调序时不会漏改一处。
  async updateEntity(entity: HistoryRecordEntity): Promise<void> {
    await this.db
      .prepare(`${UPDATE_ALL_SQL} WHERE ID=?16`)
      .bind(...entityParams(entity), entity.id!)
      .run();
  }

  // 条件更新：仅当 Version 仍等于读取时的值才写入（乐观并发控制，防止并发 PATCH 丢更新，F5）。
  // 返回 false 表示期间已被其它写入修改，调用方应按冲突处理。
  async updateEntityIfVersion(entity: HistoryRecordEntity, expectedVersion: number): Promise<boolean> {
    const res = await this.db
      .prepare(`${UPDATE_ALL_SQL} WHERE ID=?16 AND Version=?17`)
      .bind(...entityParams(entity), entity.id!, expectedVersion)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  // 分页查询（上游 GetListAsync：过滤 + 排序 + 分页 50）
  // after >= before → 抛 BadRequestError（上游 400 "after must be less than before"）
  async queryList(q: HistoryQueryDto): Promise<HistoryRecordEntity[]> {
    if (q.after && q.before && q.after.getTime() >= q.before.getTime()) {
      throw new BadRequestError('after must be less than before');
    }

    const where: string[] = ['UserId = ?1'];
    const params: (string | number)[] = [HARD_CODED_USER_ID];
    let idx = 2;

    const sortCol = q.sortByLastAccessed ? 'LastAccessed' : 'CreateTime';
    if (q.after) {
      where.push(`${sortCol} >= ?${idx++}`);
      params.push(q.after.getTime());
    }
    if (q.before) {
      where.push(`${sortCol} < ?${idx++}`);
      params.push(q.before.getTime());
    }
    if (q.modifiedAfter) {
      where.push(`LastModified >= ?${idx++}`);
      params.push(q.modifiedAfter.getTime());
    }
    if (q.types !== ProfileTypeFilter.All) {
      // 上游用 `Enum.GetValues(typeof(ProfileType))` 遍历已定义值并按位测试。
      // 按**名字**传 `Types` 时走不到高位（`ProfileTypeFilter` 只定义到 `All=15`）；但 `Types`
      // 也接受**数字**（`Types=16` 合法），此时高位会落到 `Unknown`/`None` 上（`1 << 4` / `1 << 5`）
      // —— 与上游的 `Enum.GetValues` 行为一致，不是缺陷。
      const included = (Object.values(ProfileType) as number[])
        .filter((t) => Number.isInteger(t))
        .filter((t) => ((q.types as number) & (1 << t)) !== 0);
      if (included.length === 0) {
        return [];
      }
      const placeholders = included.map((_, i) => `?${idx + i}`).join(',');
      where.push(`Type IN (${placeholders})`);
      params.push(...included);
      idx += included.length;
    }
    if (q.searchText) {
      // **有意不转义 LIKE 元字符**：`%` 与 `_` 在这里是通配符，即搜索 `100%` 等价于"匹配任意"。
      // 这是**对齐上游**（`HistoryService.cs:153` 同样 `EF.Functions.Like(r.Text, $"%{searchText}%")`），
      // 属协议面行为，不能单方面收紧——改了会让"上游能搜到、这里搜不到"。
      // 对照实现：UI 面**转义**（src/ui/query.ts 的 `LIKE … ESCAPE '\'`），那是本站自己的面，
      // 用户搜 `100%` 不该退化成匹配任意。这处分面登记在 docs/AUDIT-redundancies.md 的 C-05
      // （它**不是**协议差异 —— 协议面这边就是照上游做的，故不在 protocol.md §10 里）。
      // 上限另有约束：超长搜索串会让 D1 的 LIKE 直接报错，故入口按 48 字节校验
      // （src/serialization.ts 的 normalizeSearchText）。
      where.push(`Text LIKE ?${idx++}`);
      params.push(`%${q.searchText}%`);
    }
    if (q.starred !== null && q.starred !== undefined) {
      where.push(`Stared = ?${idx++}`);
      params.push(q.starred ? 1 : 0);
    }

    // 防御性钳制：越界 Page 由**路由层**校验（`src/routes/history.ts` 把 page 限进 int32）并返回
    // 400；这里只兜住 `page` 不是正安全整数的情形，避免以 REAL（如 5e21）绑定到 LIMIT/OFFSET 而
    // 触发 SQLite 'datatype mismatch' → 500（F9）。offset 的安全性由上面那道 int32 上界保证 ——
    // 只判 `page` 是不是安全整数**不够**：`(2^53-1 - 1) * 50` 已经越过安全整数范围，而 JS 在那里是
    // **丢精度**（不报错、也不变成 Infinity）⇒ 不能指望"它会炸"来兜底（2026-09-20 措辞订正）。
    const page = Number.isSafeInteger(q.page) && q.page > 0 ? q.page : 1;
    const offset = (page - 1) * PAGE_SIZE;
    const sql =
      `SELECT * FROM HistoryRecords WHERE ${where.join(' AND ')} ` +
      `ORDER BY ${sortCol} DESC, ID DESC LIMIT ?${idx} OFFSET ?${idx + 1}`;
    params.push(PAGE_SIZE, offset);

    const res = await this.db.prepare(sql).bind(...params).all<DbRow>();
    return (res.results ?? []).map(rowToEntity);
  }

  // 同名传输文件的**全部候选**，按 LastAccessed 倒序（上游 GetRecentTransferFile）。
  // 上游的过滤条件是 `basename(TransferDataFile) == fileName && File.Exists(...)`，即
  // **文件不存在时会继续回退到更旧的同名记录**；存在性依赖存储层，故这里只返回候选，
  // 由调用方逐个探测（本实现存储的 TransferDataFile 即文件名，与上游 GetPersistentPath 结果一致）。
  //
  // ⚠️ 这里的预筛**不能用 LIKE**（2026-09-20 修）：D1 的 LIKE 模式上限是 50 字节
  // （见 serialization.ts 的 MAX_LIKE_PATTERN_BYTES），而文件名由客户端给 ——
  // 「Invoice_2026-08_ACME-Corporation_final-signed-version-2.pdf」就 59 字节（`%/` + 名字 = 61 > 50）。名字 ≥49 字节时
  // 这条查询**直接报错**，`GET /file/{name}` 恒 500（实测：48 字节 404、49 字节 500；
  // CJK 20 字 = 60 字节同样 500），而「下载」正是客户端唯一的取数据路径。
  // 改用 `substr(…, -length(?2))`：没有通配符、没有模式长度限制。它与 LIKE 的偏差**两个方向都有**：
  // 更宽的地方是"不锚定前一个分隔符"，**更严**的地方是大小写（`=` 对 TEXT 是 BINARY，而 LIKE 对 ASCII
  // 不区分大小写）。两者对最终候选集的影响都会被调用方那道精确过滤吸收，所以终态与改前逐条相同 ——
  // 候选集的**语义由调用方的 `basename(...) === fileName` 定义**（与上游 `Path.GetFileName(...) == fileName` 同义）
  // —— 预筛只要不漏候选即可，多给的会被滤掉。
  async listTransferFileCandidates(fileName: string): Promise<HistoryRecordEntity[]> {
    // 空名：上游 `string.IsNullOrEmpty(fileName)` 直接返回 null（也让 SQL 不碰 substr 的 0 边界）
    if (fileName === '') return [];
    const res = await this.db
      .prepare(
        `SELECT * FROM HistoryRecords
         WHERE UserId = ?1 AND (TransferDataFile = ?2 OR substr(TransferDataFile, -length(?2)) = ?2)
         ORDER BY LastAccessed DESC`,
      )
      .bind(HARD_CODED_USER_ID, fileName)
      .all<DbRow>();
    return (res.results ?? [])
      .map(rowToEntity)
      .filter((e) => e.transferDataFile !== '' && basename(e.transferDataFile) === fileName);
  }

  // 数据完整性自检（docs/backend-gaps.md §2.4）的候选集：`TransferDataFile != ''` 的**活跃**记录，
  // 一次查询取回期望 R2 key 的全部组成部分（Type/Hash/文件名 + 汇报用的 Text/CreateTime/Size）。
  // 两个刻意的取舍：
  //   · 不走 SELECT * / rowToEntity —— 自检只用这 6 列，而记录数上千（本机总数 2000+ 条），
  //     逐行解析 FilePaths 的收益为零、成本不为零。
  //   · **排除软删记录** —— 软删路径会立即删除其数据目录（historyOps），它们的对象不存在是设计如此；
  //     不排除会把回收站整批（本机 1155 条）算成「缺数据」，清单全是假阳性。
  async listActiveRecordsWithData(): Promise<DataRecordRow[]> {
    const res = await this.db
      .prepare(
        `SELECT Type, Hash, TransferDataFile, Text, CreateTime, Size FROM HistoryRecords
         WHERE UserId = ?1 AND IsDeleted = 0 AND TransferDataFile != ''
         ORDER BY CreateTime DESC, ID DESC`,
      )
      .bind(HARD_CODED_USER_ID)
      .all<{ Type: number; Hash: string; TransferDataFile: string; Text: string; CreateTime: number; Size: number }>();
    return (res.results ?? []).map((r) => ({
      type: r.Type as ProfileType,
      hash: r.Hash,
      transferDataFile: r.TransferDataFile,
      text: r.Text,
      createTime: r.CreateTime,
      size: r.Size,
    }));
  }

  // 清空回收站（删行）。**同时返回被删记录的 (Type, Hash)** —— 调用方（historyOps.purgeTrash）
  // 要用它去清扫 R2 目录。
  //
  // 2026-09-22（ADR D29）之前这里只删行就够：软删时数据目录已经清掉了。改成真回收站之后，
  // 回收站里躺的是**真的数据**，不扫就是"把行抹掉、字节留在 R2 里等孤儿阶段"（最长 20 分钟，
  // 而且用户点「清空回收站」的期待就是立刻腾空间）。
  //
  // 形态与 `clearAll()` **同一条纪律（F5）**：单条 `DELETE ... RETURNING` 保证"读到的集合"与
  // "被删的行"是**同一集合**。2026-09-22 审核：此处一度写成 SELECT + 独立 DELETE，而那个间隙
  // 在这条路径上正好会**多删** —— 期间有设备把某条恢复成活跃（`IsDeleted = 0`）⇒ 它躲过了 DELETE
  // （行还在），却仍在 SELECT 的名单里 ⇒ 调用方照单清扫 R2，把一条**活跃记录**的数据删掉
  // （行在、字节没了，且不可恢复）。单语句没有这个间隙，顺带还省一次 D1 子请求。
  //
  // 只 RETURNING 两列而不是整行：原注释里"不 RETURNING 整批行"的顾虑是 FilePaths/Text 会进
  // isolate 内存（本机回收站 1000+ 行），而 (Type, Hash) 两列加起来的体积可以忽略。
  async purgeDeletedRecords(): Promise<{
    deleted: number;
    entries: { type: ProfileType; hash: string }[];
  }> {
    const res = await this.db
      .prepare(`DELETE FROM HistoryRecords WHERE UserId = ?1 AND IsDeleted != 0 RETURNING Type, Hash`)
      .bind(HARD_CODED_USER_ID)
      .all<{ Type: number; Hash: string }>();
    const rows = res.results ?? [];
    return {
      deleted: rows.length,
      entries: rows.map((r) => ({ type: r.Type as ProfileType, hash: r.Hash })),
    };
  }

  // 彻底删除**一条已删除的记录**（回收站每行的「彻底删除」）。2026-09-21 新增。
  //
  // 判据全在 SQL 里，且是这个接口的**安全前提**：只删 `IsDeleted != 0` 的行 ⇒
  //   · 活跃记录删不掉（想真删必须先软删 —— 不允许绕过回收站）；
  //   · 不存在 / 已被清掉的返回 false，由调用方计进"未生效"。
  // 成本 = **1 次 D1 子请求**（无预读、不广播、不碰 R2）。**R2 目录由调用方清扫**：
  // 2026-09-22（ADR D29）起回收站里是真数据，删行不清目录就是把字节留给孤儿阶段（最长 20 分钟）——
  // 路由那侧在删成功后调 `deleteHistoryWorkingDir`（与 `purgeTrash` 同一条判据）。
  // 对照：软删每条要 1 读 + 1 写 + 1 广播（现在**不再**清目录），所以"彻底删除"仍略贵一点（多一次列举）。
  async purgeDeletedRecord(type: ProfileType, hash: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `DELETE FROM HistoryRecords WHERE UserId = ?1 AND Type = ?2 AND Hash = ?3 AND IsDeleted != 0`,
      )
      .bind(HARD_CODED_USER_ID, type, hash)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  // 统计（上游 GetStatisticsAsync；totalFileSizeMB 由调用方传入 R2 合计值）。
  // 四个计数**一条聚合查询**出齐：旧实现先把全部行的 Stared/IsDeleted 拉回 JS 再循环，
  // 而统计在每次页面加载、星标、删除、切视图时都会跑（后端能力评估 §3.1）。
  // 语义与原实现逐条对齐：starred 在**整个结果集**上累加，不区分已删/活跃。
  async statistics(totalFileSizeMB: number): Promise<HistoryStatisticsDto> {
    const res = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN Stared != 0 THEN 1 ELSE 0 END), 0) AS starred,
           COALESCE(SUM(CASE WHEN IsDeleted != 0 THEN 1 ELSE 0 END), 0) AS deleted,
           COALESCE(SUM(CASE WHEN IsDeleted = 0 THEN 1 ELSE 0 END), 0) AS active
         FROM HistoryRecords WHERE UserId = ?1`,
      )
      .bind(HARD_CODED_USER_ID)
      .first<{ total: number; starred: number; deleted: number; active: number }>();
    return {
      totalCount: res?.total ?? 0,
      starredCount: res?.starred ?? 0,
      deletedCount: res?.deleted ?? 0,
      activeCount: res?.active ?? 0,
      totalFileSizeMB,
    };
  }

  // 清空（上游 ClearAllAsync），返回被删除的记录。
  // 用单条 DELETE ... RETURNING 保证「读到的集合」与「被删除的行」是同一集合：
  // 此前 SELECT + 独立 DELETE 之间有间隙，并发插入的行会被删掉却不在返回列表里，
  // 路由据此只删返回实体的 R2 目录，留下 DB 已删而 R2 残留的孤儿对象（F5）。
  // 只 RETURNING Type/Hash（调用方只需要目录名与条数）：整行返回会把每行的大块 Text
  // 一起读进 isolate，大库上清空一次就是数百 MB（同 `purgeDeletedRecords` 的口径）。
  async clearAll(): Promise<{ type: ProfileType; hash: string }[]> {
    const res = await this.db
      .prepare(`DELETE FROM HistoryRecords WHERE UserId = ?1 RETURNING Type, Hash`)
      .bind(HARD_CODED_USER_ID)
      .all<{ Type: number; Hash: string }>();
    return (res.results ?? []).map((r) => ({ type: r.Type as ProfileType, hash: r.Hash }));
  }

  // PATCH 更新（上游 HistoryService.Update）
  // 返回 { updated: true } → 200 空体；{ updated: false } → 409；{ updated: null } → 404
  async updateHistory(
    type: ProfileType,
    hash: string,
    dto: HistoryRecordUpdateDto,
  ): Promise<{ updated: boolean | null; entity: HistoryRecordEntity | null }> {
    const existing = await this.getByTypeAndHash(type, hash);
    if (!existing) {
      return { updated: null, entity: null };
    }

    const newVersion = dto.version ?? existing.version + 1;
    // 缺省时间戳**单调**（`max(now, 已有+1)`），不是裸 `Date.now()`：`shouldUpdate` 在时间差
    // 超过 5 分钟时要求 `newLastModified >= oldLastModified`，而客户端时钟偏快会让记录的
    // lastModified 落在未来 ⇒ 用裸 now 的调用方（本站 UI 的 PATCH / batch-update）会拿到
    // 伪冲突、删不掉。**放在这里而不是各调用点**：调用方因此不必先自己读一遍来算这两个值
    // （2026-09-21 之前路由层正是这么干的：每条记录多一次 D1 读 ⇒ 批量里白花 100 次子请求）。
    // 协议写路径（`PATCH /api/history`）恒自带 lastModified，故不受这条缺省影响。
    const newLastModified = dto.lastModified ? fromIso(dto.lastModified) : Math.max(Date.now(), existing.lastModified + 1);

    if (!shouldUpdate(existing.version, newVersion, existing.lastModified, newLastModified)) {
      return { updated: false, entity: existing };
    }

    // 上游这里有一条守卫：「已删除 + 有数据文件 + IsDelete=false」→ 拒绝（上游 `HistoryService.Update`
    // 返回 (null,null)，本实现原样移植为 notFound）。**2026-09-22 去掉**（ADR D29）：既然软删不再
    // 毁掉数据（见 historyOps.ts），恢复就该连数据一起回来 —— 否则"回收站"对图片/文件仍然是个
    // 单向门。协议面的这条偏离登记在 `docs/protocol.md` §10。

    const versionBeforeUpdate = existing.version;

    if (dto.starred !== null && dto.starred !== undefined) existing.stared = dto.starred;
    if (dto.pinned !== null && dto.pinned !== undefined) existing.pinned = dto.pinned;
    if (dto.isDelete !== null && dto.isDelete !== undefined) existing.isDeleted = dto.isDelete;
    existing.lastModified = newLastModified;
    if (dto.lastAccessed) existing.lastAccessed = fromIso(dto.lastAccessed);
    existing.version = newVersion;

    // 乐观并发：若期间已有其它写入（Version 已变），按冲突返回，避免静默覆盖对方的更新（F5）
    const applied = await this.updateEntityIfVersion(existing, versionBeforeUpdate);
    if (!applied) {
      const current = await this.getByTypeAndHash(type, hash);
      return { updated: false, entity: current ?? existing };
    }
    return { updated: true, entity: existing };
  }

  // ===== 保留与清理（对齐上游 HistoryService 的 RemoveOutOfRetentionRecords /
  //       SetRecordsMaxCount / RemoveOutOfDateDeletedRecords / CleanOrphanedFolders）=====

  // 软删最旧的一批非收藏/非置顶记录（上游 RemoveOutOfRetentionRecords / SetRecordsMaxCount 共用
  // 同一个 `QueryDeleteOrderBy` = MAX(LastModified, LastAccessed)）。**单份 SQL 两种形态**：
  // `?2 IS NULL` 时不做保留期过滤（trim），否则按过期时间过滤（retention）—— 占位符编号因此
  // 不随形态漂移，软删判据（豁免列 + 排序键）只此一份，将来加豁免列不会漏改一条路径。
  private async softDeleteOldest(
    userId: string,
    cutoffMs: number | null,
    nowMs: number,
    limit: number,
  ): Promise<HistoryRecordEntity[]> {
    const res = await this.db
      .prepare(
        `UPDATE HistoryRecords SET IsDeleted = 1, Version = Version + 1, LastModified = ?3
         WHERE ID IN (
           SELECT ID FROM HistoryRecords
           WHERE UserId = ?1 AND IsDeleted = 0 AND Stared = 0 AND Pinned = 0
             AND (?2 IS NULL OR (LastModified < ?2 AND LastAccessed < ?2))
           ORDER BY MAX(LastModified, LastAccessed) ASC, ID ASC
           LIMIT ?4
         ) RETURNING *`,
      )
      .bind(userId, cutoffMs, nowMs, limit)
      .all<DbRow>();
    return (res.results ?? []).map(rowToEntity);
  }

  // 保留期过期（未删除、未收藏、未置顶）→ **软删**并返回受影响实体。
  // 上游 RemoveOutOfRetentionRecords → RemoveExpiredInBatchesAsync → MarkForDeletionAsync：
  //   IsDeleted = true、Version++、LastModified = now（行保留，由 30 天硬删任务最终清理），
  //   随后 OnRecordDeletedAsync 删数据目录并广播。**本实现不删数据目录**（ADR D29：回收站要能
  //   连数据拿回来），只广播；目录由 30 天硬删阶段批量清扫。差异登记在 docs/protocol.md §10。
  async softDeleteExpiredRecords(cutoffMs: number, nowMs: number, limit: number): Promise<HistoryRecordEntity[]> {
    return this.softDeleteOldest(HARD_CODED_USER_ID, cutoffMs, nowMs, limit);
  }

  // 活跃记录数（未删除）
  async countActiveRecords(): Promise<number> {
    const res = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM HistoryRecords WHERE UserId = ?1 AND IsDeleted = 0`)
      .bind(HARD_CODED_USER_ID)
      .first<{ c: number }>();
    return res?.c ?? 0;
  }

  // 超量裁剪：软删最旧的非收藏/非置顶记录（上游 SetRecordsMaxCount → QueryDeleteOrderBy = MAX(LastModified, LastAccessed)）
  async trimToMaxCount(limit: number, nowMs: number): Promise<HistoryRecordEntity[]> {
    return this.softDeleteOldest(HARD_CODED_USER_ID, null, nowMs, limit);
  }

  // 已删除记录硬删（上游固定 30 天）。
  // 只 RETURNING Type/Hash：硬删阶段不广播，行只需要用来拼数据目录名做清扫 ——
  // 全行返回会把每条记录的大块 Text 一起读进 isolate（1000 行/批，真 OOM 风险），
  // `purgeDeletedRecords`（用户清空回收站）已经是这个口径。
  async hardDeleteOldDeletedRecords(cutoffMs: number, limit: number): Promise<{ type: ProfileType; hash: string }[]> {
    const res = await this.db
      .prepare(
        `DELETE FROM HistoryRecords WHERE ID IN (
           SELECT ID FROM HistoryRecords
           WHERE UserId = ?1 AND IsDeleted = 1 AND LastModified < ?2
           LIMIT ?3
         ) RETURNING Type, Hash`,
      )
      .bind(HARD_CODED_USER_ID, cutoffMs, limit)
      .all<{ Type: number; Hash: string }>();
    return (res.results ?? []).map((r) => ({ type: r.Type as ProfileType, hash: r.Hash }));
  }

  // 活记录的工作目录集合，用于孤儿对象判定。
  // **必须带尾斜杠**：调用方（cleanup.ts）把它与 `R2Storage.listHistoryObjectsByDir()` 的结果比较，
  // 而后者由 R2 key 截取得来、形如 `Text_ABC/`（尾斜杠是 deletePrefix 的语义所需 —— 少了它，
  // `history/Text_AB` 会误匹配 `history/Text_ABC/…`）。
  // 此前这里返回的是不带斜杠的 `Text_ABC`，导致 cleanup 的 `active.has(dir)` **恒为 false**：
  // 每小时 Cron 把 history/ 下**所有**工作目录（含活跃记录的数据文件）全部删除。
  // 列举**所有**记录（含已删除）的工作目录名 —— 孤儿阶段的"被引用"参照集。
  //
  // ⚠️ 名字与查询在 2026-09-22 一起改（ADR D29）：此前是 `listActiveWorkingDirs` + `IsDeleted = 0`，
  // 那是因为软删时数据目录已被清掉、已删记录不可能有目录。改成真回收站（软删保留数据）之后，
  // **已删记录的目录必须算"有人引用"** —— 否则孤儿阶段会把整个回收站的数据每 20 分钟删一次，
  // 而且看不出来（回收站里那行还在，只是点恢复/预览时数据不见了）。
  async listReferencedWorkingDirs(): Promise<Set<string>> {
    const res = await this.db
      .prepare(`SELECT Type, Hash FROM HistoryRecords WHERE UserId = ?1`)
      .bind(HARD_CODED_USER_ID)
      .all<{ Type: number; Hash: string }>();
    // 目录名格式与 storage.ts 的 `formatWorkingDirName` 同源（F33：形式不一致 = 每小时清空一次 history/）
    return new Set((res.results ?? []).map((r) => formatWorkingDirName(r.Type as ProfileType, r.Hash)));
  }

  // ===== Meta（当前剪贴板 Profile / 清理进度）=====

  async getCurrentProfileJson(): Promise<string | null> {
    const res = await this.db
      .prepare(`SELECT Value FROM Meta WHERE Key = 'current_profile'`)
      .first<{ Value: string }>();
    return res?.Value ?? null;
  }

  async setCurrentProfileJson(json: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO Meta (Key, Value) VALUES ('current_profile', ?1)
                ON CONFLICT(Key) DO UPDATE SET Value = ?1`)
      .bind(json)
      .run();
  }

  // 通用 KV 读写（清理任务用它落进度/失败，UI 只读展示同一批键）。
  // 键名由调用方给定：db.ts 不掌握清理阶段的命名，避免两处各写一份字面量。

  // 批量读：**缺键不出现在 Map 里**（调用方自行取默认值）；D1 报错按常态抛出。
  async getMetaValues(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    const placeholders = keys.map((_, i) => `?${i + 1}`).join(', ');
    const res = await this.db
      .prepare(`SELECT Key, Value FROM Meta WHERE Key IN (${placeholders})`)
      .bind(...keys)
      .all<{ Key: string; Value: string }>();
    for (const row of res.results ?? []) out.set(row.Key, row.Value);
    return out;
  }

  // 批量写：一条多行 UPSERT（1 次子请求）。键与值都走占位符绑定（SQL 里只出现 `?N`）。
  async setMetaValues(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) return;
    const rows = entries.map((_, i) => `(?${i * 2 + 1}, ?${i * 2 + 2})`).join(', ');
    await this.db
      .prepare(
        `INSERT INTO Meta (Key, Value) VALUES ${rows}
         ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value`,
      )
      .bind(...entries.flat())
      .run();
  }

  // 批量删键（一条 DELETE，1 次子请求）：PUT /ui/api/settings 传 null 即「清除覆盖」。
  // 必须是**真删**而不是写空串 —— 空串经 `Number('')` 会解析成 0，而 0 的语义是「关闭该阶段」，
  // 与「清除覆盖、回落到 env」正好相反（src/cleanup.ts 的 SETTINGS_META_KEYS 注释同此）。
  async deleteMetaValues(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const placeholders = keys.map((_, i) => `?${i + 1}`).join(', ');
    await this.db.prepare(`DELETE FROM Meta WHERE Key IN (${placeholders})`).bind(...keys).run();
  }
}
