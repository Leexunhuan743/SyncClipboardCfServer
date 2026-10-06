// 请求级存储句柄：`{ db, storage }`。
//
// 收敛理由：这个工厂原先在四个路由模块里各写一份（命名还不一致），给这两个对象加参数或换
// 构造方式时，四处漏改一处就会让行为分叉。
//
// 语义保持不变：两个都是**无状态薄封装**，每次请求新建，不缓存绑定。
import { Bindings } from './env';
import { HistoryDb } from './db';
import { R2Storage } from './storage';

export function stores(c: { env: Bindings }): { db: HistoryDb; storage: R2Storage } {
  return {
    db: new HistoryDb(c.env.DB),
    storage: new R2Storage(c.env.R2),
  };
}
