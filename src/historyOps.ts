// 历史记录「改一条」的共享实现（官方 PATCH 路由与 UI 路由共用）。
//
// 抽出来的理由：这条链路上有三件必须一致的事——版本/时间戳判定、广播、R2 数据目录清理。
// 官方 `PATCH /api/history/{type}/{hash}` 与 UI 的收藏/置顶/删除都改同一条记录，
// 若各写一份，UI 侧删掉记录却不广播（或不清数据目录）就会与官方语义分叉。
import { Bindings } from './env';
import { HistoryDb } from './db';
import { R2Storage, workingDirPrefix } from './storage';
import { entityToDtoWire } from './serialization';
import { broadcast } from './hub';
import type { HistoryRecordEntity, HistoryRecordUpdateDto, ProfileType } from './types';

// 清空全部历史：协议 `DELETE /api/history/clear` 与 UI `POST /ui/api/history/clear`（scope=all）
// **共用这一份实现** —— 两份实现里只有一份会随下次改动更新，另一份静默分叉（复核发现的重复面）。
//
// 两条纪律：
//   ① 先删行、再删数据目录（反过来一旦 DELETE 失败就是整库悬空）；
//   ② 数据侧只删**这次删掉的那些记录**的目录（按 `clearAll` 返回的实体集合），不做整棵前缀清理 ——
//      前缀清理会把两次调用之间并发写入的那条记录的数据一起抹掉（行还在、对象没了 = 数据损坏）；
//      按集合删最坏只是漏删（留孤儿目录，由清理任务的孤儿阶段兜底）。
// 成本：1 次 D1 + 1 次列举/1000 对象 + 1 次批量删/页，与整棵前缀清理同量级（逐条删目录则是
// 2 次子请求/记录，1000 条约 2000 次，**超过单次调用 1000 次内部子请求的上限**，饱和时中途失败）。
export async function clearAllHistory(env: Bindings): Promise<number> {
  const entities = await new HistoryDb(env.DB).clearAll();
  const storage = new R2Storage(env.R2);
  await storage.deleteHistoryDirs(entities.map((entity) => workingDirPrefix(entity.type, entity.hash)));
  return entities.length;
}

export type HistoryUpdateResult =
  | { kind: 'notFound' }
  | { kind: 'conflict'; entity: HistoryRecordEntity } // 版本判定未通过（上游语义为 409）
  | { kind: 'updated'; entity: HistoryRecordEntity };

export async function applyHistoryUpdate(
  env: Bindings,
  type: ProfileType,
  hash: string,
  dto: HistoryRecordUpdateDto,
): Promise<HistoryUpdateResult> {
  const db = new HistoryDb(env.DB);
  const result = await db.updateHistory(type, hash, dto);
  if (result.updated === null || result.entity === null) return { kind: 'notFound' };
  if (result.updated === false) return { kind: 'conflict', entity: result.entity };

  // 与 PUT /SyncClipboard.json、POST /api/history 一致：广播在响应返回前 await 完成。
  // 裸调用是 floating promise，Workers 不保证响应后继续执行，推送会非确定性丢失（F6）。
  await broadcast(env, 'RemoteHistoryChanged', entityToDtoWire(result.entity));
  if (result.entity.isDeleted) {
    await new R2Storage(env.R2).deleteHistoryWorkingDir(result.entity.type, result.entity.hash);
  }
  return { kind: 'updated', entity: result.entity };
}
