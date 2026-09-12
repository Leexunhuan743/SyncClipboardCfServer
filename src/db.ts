// D1 访问层（docs/design.md §5.1，行为对照上游 HistoryService / HistoryHelper）
import {
  HARD_CODED_USER_ID,
  PAGE_SIZE,
  HISTORY_UPDATE_THRESHOLD_MS,
  HistoryRecordEntity,
  HistoryQueryDto,
  ProfileType,
  ProfileTypeFilter,
  HistoryStatisticsDto,
} from './types';
import { toIso, entityToDto, entityToUpdateDto, fromIso } from './serialization';
import { HistoryRecordUpdateDto } from './types';

interface DbRow {
  ID: number;
  UserId: string;
  Type: number;
  Text: string;
  Size: number;
  TransferDataFile: string;
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

function rowToEntity(r: DbRow): HistoryRecordEntity {
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
  (UserId, Type, Text, Size, TransferDataFile, FilePaths, Hash, CreateTime, LastAccessed, LastModified, Stared, Pinned, Version, IsDeleted)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;

// 仅识别 (UserId,Type,Hash) 唯一约束冲突，避免把其它 INSERT 失败误判成「并发冲突」后静默吞掉（F5 回归）。
// D1 会把底层 SQLite 错误包一层（message 形如 "D1_ERROR: UNIQUE constraint failed: ..."），
// 细节也可能挂在 cause 上，故沿 cause 链取若干层文本再判定。
export function isUniqueConstraintError(err: unknown): boolean {
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

export class HistoryDb {
  constructor(private db: D1Database) {}

  // Type + Hash 查询（大小写不敏感，等价 EF.Functions.Like）
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

  // 全字段更新
  async updateEntity(entity: HistoryRecordEntity): Promise<void> {
    await this.db
      .prepare(
        `UPDATE HistoryRecords SET
           UserId=?1, Type=?2, Text=?3, Size=?4, TransferDataFile=?5, FilePaths=?6, Hash=?7,
           CreateTime=?8, LastAccessed=?9, LastModified=?10, Stared=?11, Pinned=?12, Version=?13, IsDeleted=?14
         WHERE ID=?15`,
      )
      .bind(...entityParams(entity), entity.id!)
      .run();
  }

  // 条件更新：仅当 Version 仍等于读取时的值才写入（乐观并发控制，防止并发 PATCH 丢更新，F5）。
  // 返回 false 表示期间已被其它写入修改，调用方应按冲突处理。
  async updateEntityIfVersion(entity: HistoryRecordEntity, expectedVersion: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE HistoryRecords SET
           UserId=?1, Type=?2, Text=?3, Size=?4, TransferDataFile=?5, FilePaths=?6, Hash=?7,
           CreateTime=?8, LastAccessed=?9, LastModified=?10, Stared=?11, Pinned=?12, Version=?13, IsDeleted=?14
         WHERE ID=?15 AND Version=?16`,
      )
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
      // 上游用 `Enum.GetValues(typeof(ProfileType))` 遍历已定义值并按位测试；
      // ProfileTypeFilter 只定义到 All(15)，故高位（Unknown/None 对应的 16/32）不可达。
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
      where.push(`Text LIKE ?${idx++}`);
      params.push(`%${q.searchText}%`);
    }
    if (q.starred !== null && q.starred !== undefined) {
      where.push(`Stared = ?${idx++}`);
      params.push(q.starred ? 1 : 0);
    }

    // 防御性钳制：越界 Page 由路由层校验并返回 400；这里再保证 offset 是安全整数，
    // 不会以 REAL（如 5e21）绑定到 LIMIT/OFFSET 而触发 SQLite 'datatype mismatch' → 500（F9）
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
  async listTransferFileCandidates(fileName: string): Promise<HistoryRecordEntity[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM HistoryRecords
         WHERE UserId = ?1 AND (TransferDataFile = ?2 OR TransferDataFile LIKE '%/' || ?2)
         ORDER BY LastAccessed DESC`,
      )
      .bind(HARD_CODED_USER_ID, fileName)
      .all<DbRow>();
    return (res.results ?? [])
      .map(rowToEntity)
      .filter((e) => e.transferDataFile !== '' && basename(e.transferDataFile) === fileName);
  }

  // 统计（上游 GetStatisticsAsync；totalFileSizeMB 由调用方传入 R2 合计值）
  async statistics(totalFileSizeMB: number): Promise<HistoryStatisticsDto> {
    const res = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM HistoryRecords WHERE UserId = ?1`)
      .bind(HARD_CODED_USER_ID)
      .first<{ c: number }>();
    const total = res?.c ?? 0;
    let starred = 0;
    let deleted = 0;
    let active = 0;
    const rows = await this.db
      .prepare(`SELECT Stared, IsDeleted FROM HistoryRecords WHERE UserId = ?1`)
      .bind(HARD_CODED_USER_ID)
      .all<{ Stared: number; IsDeleted: number }>();
    for (const r of rows.results ?? []) {
      if (r.Stared !== 0) starred++;
      if (r.IsDeleted !== 0) deleted++;
      else active++;
    }
    return { totalCount: total, starredCount: starred, deletedCount: deleted, activeCount: active, totalFileSizeMB };
  }

  // 清空（上游 ClearAllAsync），返回被删除的记录。
  // 用单条 DELETE ... RETURNING 保证「读到的集合」与「被删除的行」是同一集合：
  // 此前 SELECT + 独立 DELETE 之间有间隙，并发插入的行会被删掉却不在返回列表里，
  // 路由据此只删返回实体的 R2 目录，留下 DB 已删而 R2 残留的孤儿对象（F5）。
  async clearAll(): Promise<HistoryRecordEntity[]> {
    const res = await this.db
      .prepare(`DELETE FROM HistoryRecords WHERE UserId = ?1 RETURNING *`)
      .bind(HARD_CODED_USER_ID)
      .all<DbRow>();
    return (res.results ?? []).map(rowToEntity);
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
    const newLastModified = dto.lastModified ? fromIso(dto.lastModified) : Date.now();

    if (!shouldUpdate(existing.version, newVersion, existing.lastModified, newLastModified)) {
      return { updated: false, entity: existing };
    }

    // 已删除记录不允许被"取消删除"回退（上游 Update：IsDelete==false 且 IsDeleted 且有数据 → 404）
    if (dto.isDelete === false && existing.isDeleted && existing.transferDataFile !== '') {
      return { updated: null, entity: null };
    }

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

  // 保留期过期（未删除、未收藏、未置顶）→ **软删**并返回受影响实体。
  // 上游 RemoveOutOfRetentionRecords → RemoveExpiredInBatchesAsync → MarkForDeletionAsync：
  //   IsDeleted = true、Version++、LastModified = now（行保留，由 30 天硬删任务最终清理），
  //   随后 OnRecordDeletedAsync 删数据目录并广播。排序取上游 QueryDeleteOrderBy（MAX(LastModified, LastAccessed)）。
  async softDeleteExpiredRecords(cutoffMs: number, nowMs: number, limit: number): Promise<HistoryRecordEntity[]> {
    const res = await this.db
      .prepare(
        `UPDATE HistoryRecords SET IsDeleted = 1, Version = Version + 1, LastModified = ?3
         WHERE ID IN (
           SELECT ID FROM HistoryRecords
           WHERE UserId = ?1 AND IsDeleted = 0 AND Stared = 0 AND Pinned = 0
             AND LastModified < ?2 AND LastAccessed < ?2
           ORDER BY MAX(LastModified, LastAccessed) ASC, ID ASC
           LIMIT ?4
         ) RETURNING *`,
      )
      .bind(HARD_CODED_USER_ID, cutoffMs, nowMs, limit)
      .all<DbRow>();
    return (res.results ?? []).map(rowToEntity);
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
    const res = await this.db
      .prepare(
        `UPDATE HistoryRecords SET IsDeleted = 1, Version = Version + 1, LastModified = ?2
         WHERE ID IN (
           SELECT ID FROM HistoryRecords
           WHERE UserId = ?1 AND IsDeleted = 0 AND Stared = 0 AND Pinned = 0
           ORDER BY MAX(LastModified, LastAccessed) ASC, ID ASC
           LIMIT ?3
         ) RETURNING *`,
      )
      .bind(HARD_CODED_USER_ID, nowMs, limit)
      .all<DbRow>();
    return (res.results ?? []).map(rowToEntity);
  }

  // 已删除记录硬删（上游固定 30 天）
  async hardDeleteOldDeletedRecords(cutoffMs: number, limit: number): Promise<HistoryRecordEntity[]> {
    const res = await this.db
      .prepare(
        `DELETE FROM HistoryRecords WHERE ID IN (
           SELECT ID FROM HistoryRecords
           WHERE UserId = ?1 AND IsDeleted = 1 AND LastModified < ?2
           LIMIT ?3
         ) RETURNING *`,
      )
      .bind(HARD_CODED_USER_ID, cutoffMs, limit)
      .all<DbRow>();
    return (res.results ?? []).map(rowToEntity);
  }

  // 活记录的工作目录集合（{Type}_{hash}），用于孤儿对象判定
  async listActiveWorkingDirs(): Promise<Set<string>> {
    const res = await this.db
      .prepare(`SELECT Type, Hash FROM HistoryRecords WHERE UserId = ?1 AND IsDeleted = 0`)
      .bind(HARD_CODED_USER_ID)
      .all<{ Type: number; Hash: string }>();
    return new Set((res.results ?? []).map((r) => `${ProfileType[r.Type as ProfileType]}_${r.Hash}`));
  }

  // ===== Meta（当前剪贴板 Profile）=====

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
}

export function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export { entityToDto, entityToUpdateDto, toIso };
