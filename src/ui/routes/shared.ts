// `/ui/api/*` 各路由模块共用的解析辅助。
//
// 与官方 `/api/history/*` 的关系：官方那套是**协议契约**（官方客户端在读），`/ui/api/*` 只服务本站页面。
// 两者共用同一张表、同一套行映射与 DTO 序列化，写操作也走同一个实现（historyOps.applyHistoryUpdate），
// 因此不存在「UI 改了但客户端不知道」。
import { parseProfileType } from '../../serialization';
import { isValidProfileHash } from '../../types';
import type { ProfileType } from '../../types';

// 解析 :type/:hash 两个路径参数；不合法时返回 null（调用方据此 400/404）
export function parsePathIds(
  typeRaw: string,
  hash: string,
): { type: ProfileType; hash: string } | null {
  const type = parseProfileType(typeRaw);
  if (type === undefined) return null;
  if (!hash || !isValidProfileHash(hash)) return null;
  return { type, hash };
}
