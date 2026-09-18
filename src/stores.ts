// 请求级存储句柄：`{ db, storage }`。
//
// 收敛理由（审计 R-04）：这个工厂原先在四个路由模块里各写一份
// （`routes/history.ts`、`routes/webdav.ts` 叫 `handlers`；`ui/routes.ts`、`ui/maintenance.ts` 叫 `stores`），
// 其中一处的注释还专门解释了"与另一处同名局部函数一致"—— 那等于在注释里承认了重复。
// 给这两个对象加参数或换构造方式时，四处漏改一处就会让行为分叉。
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
