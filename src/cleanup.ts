// 历史保留与清理（对齐上游 HistoryCleaner.cs + HistoryService 的清理方法）
// 上游三个后台任务：
//   LimitHistoryCountTask  每 10 分钟 → RemoveOutOfRetentionRecords(HistoryRetentionMinutes) + SetRecordsMaxCount(MaxSavedHistoryCount)
//   CleanDeletedHistoryTask 每 12 小时 → RemoveOutOfDateDeletedRecords（硬删 IsDeleted 且 LastModified < now-30d）
//   CleanOrphanedFoldersTask 每 12 小时 → CleanOrphanedFolders（删无活记录的 {Type}_{hash} 目录）
// CF 侧由 Cron Trigger 触发（wrangler.toml [triggers]），一次批量执行全部三类。
import { HistoryDb } from './db';
import { R2Storage } from './storage';
import { entityToDtoWire } from './serialization';
import { Bindings } from './env';
import { broadcast } from './hub';

const BATCH_LIMIT = 200;
// 单次清理的批次上限，避免单次 Cron 超时/超子请求限制
const MAX_BATCHES = 20;
// 已删除记录保留期（上游 RemoveOutOfDateDeletedRecords 固定 30 天）
const DELETED_RETENTION_DAYS = 30;

export interface CleanupResult {
  expired: number;
  trimmed: number;
  hardDeleted: number;
  orphans: number;
  batches: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export async function runCleanup(env: Bindings): Promise<CleanupResult> {
  const db = new HistoryDb(env.DB);
  const storage = new R2Storage(env.R2);
  const retentionMinutes = parsePositiveInt(env.HISTORY_RETENTION_MINUTES, 10080);
  const maxCount = parsePositiveInt(env.MAX_SAVED_HISTORY_COUNT, 1000);

  const result: CleanupResult = { expired: 0, trimmed: 0, hardDeleted: 0, orphans: 0, batches: 0 };

  // 1) 保留期：过期且未收藏/未置顶/未删除 → 软删（IsDeleted/Version++/LastModified=now）
  //    + 删数据目录 + 广播（上游 MarkForDeletionAsync → OnRecordDeletedAsync）
  if (retentionMinutes > 0) {
    const cutoff = Date.now() - retentionMinutes * 60_000;
    for (let i = 0; i < MAX_BATCHES; i++) {
      result.batches++;
      const removed = await db.softDeleteExpiredRecords(cutoff, Date.now(), BATCH_LIMIT);
      for (const e of removed) {
        await storage.deleteHistoryWorkingDir(e.type, e.hash);
        await broadcast(env, 'RemoteHistoryChanged', entityToDtoWire(e));
      }
      result.expired += removed.length;
      if (removed.length < BATCH_LIMIT) break;
    }
  }

  // 2) 条数上限：超量时软删最旧（非收藏/非置顶）（上游 SetRecordsMaxCount → MarkForDeletion）
  if (maxCount > 0) {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const active = await db.countActiveRecords();
      const overage = active - maxCount;
      if (overage <= 0) break;
      result.batches++;
      const trimmed = await db.trimToMaxCount(Math.min(overage, BATCH_LIMIT), Date.now());
      for (const e of trimmed) {
        await storage.deleteHistoryWorkingDir(e.type, e.hash);
        await broadcast(env, 'RemoteHistoryChanged', entityToDtoWire(e));
      }
      result.trimmed += trimmed.length;
      if (trimmed.length === 0) break;
    }
  }

  // 3) 已删除记录硬删（>30 天）+ 删数据目录（上游 RemoveOutOfDateDeletedRecords，不广播）
  const cutoff = Date.now() - DELETED_RETENTION_DAYS * 24 * 60 * 60_000;
  const hardDeleted = await db.hardDeleteOldDeletedRecords(cutoff, BATCH_LIMIT);
  for (const e of hardDeleted) {
    await storage.deleteHistoryWorkingDir(e.type, e.hash);
  }
  result.hardDeleted = hardDeleted.length;

  // 4) 孤儿对象清理：history/ 下存在目录但 DB 无活记录引用。
  // 比较双方**必须同为带尾斜杠的目录名**（本函数从 R2 key 截取得 `Text_ABC/`，
  // `db.listActiveWorkingDirs` 也返回带斜杠形式）。形式不一致会让 `active.has(dir)` 恒为 false，
  // 从而把**所有**历史数据目录当成孤儿删除 —— 曾因此每小时清空一次 history/（见 F33）。
  const workingDirs = await storage.listHistoryWorkingDirs();
  if (workingDirs.length > 0) {
    const active = await db.listActiveWorkingDirs();
    for (const dir of workingDirs) {
      if (!active.has(dir)) {
        await storage.deleteHistoryPrefix(dir);
        result.orphans++;
      }
    }
  }

  return result;
}
