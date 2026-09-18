// 历史记录「改一条」的共享实现（官方 PATCH 路由与 UI 路由共用）。
//
// 抽出来的理由：这条链路上有三件必须一致的事——版本/时间戳判定、广播、R2 数据目录清理。
// 官方 `PATCH /api/history/{type}/{hash}` 与 UI 的收藏/置顶/删除都改同一条记录，
// 若各写一份，UI 侧删掉记录却不广播（或不清数据目录）就会与官方语义分叉。
import { Bindings } from './env';
import { HistoryDb } from './db';
import { R2Storage } from './storage';
import { entityToDtoWire } from './serialization';
import { broadcast } from './hub';
import type { HistoryRecordEntity, HistoryRecordUpdateDto, ProfileType } from './types';

// 清空全部历史：协议 `DELETE /api/history/clear` 与 UI `POST /ui/api/history/clear`（scope=all）
// **共用这一份实现** —— 两份实现里只有一份会随下次改动更新，另一份静默分叉（复核发现的重复面）。
// 顺序是先删行再整棵 `history/` 前缀清理：`clearAll` 删掉的就是全部记录，其数据目录也就是全部；
// 逐条 deleteHistoryWorkingDir 是 2 次子请求/记录（1000 条约 2000 次，**超过单次调用 1000 次内部
// 子请求的上限**，饱和时会在中途失败），deletePrefix 内部按页 list + 批量 delete，同规模只需个位数。
// 窄竞态已知并接受：清空与并发写入之间有一个窗口，后写的那条记录的行会留下、数据目录被前缀清掉
// （表现为该条 hasData 但对象缺失，正是 `/ui/api/integrity` 能查出来的形态）。
export async function clearAllHistory(env: Bindings): Promise<number> {
  const entities = await new HistoryDb(env.DB).clearAll();
  await new R2Storage(env.R2).clearHistoryData();
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
