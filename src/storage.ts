// R2 访问层（docs/design.md §5.2）
import { ProfileType, isValidProfileHash } from './types';

// key 布局：
//   暂存:   file/{dataName}
//   持久:   history/{Type}_{hash}/{transferDataName}
const TEMP_PREFIX = 'file/';
const HISTORY_PREFIX = 'history/';

// R2 单次 delete 调用可带的 key 上限（与列举的 1000 键/页同量级）。清理任务据此分块，
// 而 storage 层只做断言 —— 分块与子请求记账属于调用方的职责（它才知道预算还剩多少）。
export const R2_DELETE_BATCH = 1000;

export function tempKey(name: string): string {
  return `${TEMP_PREFIX}${name}`;
}

// 最后防线（对齐上游 `Profile.GetWorkingDirName` 在 key 构造处抛 ArgumentException）：
// 路由层已把含路径分隔符的 hash 拒为 400，此处断言确保将来新增写路径若漏校验会**快速失败**，
// 而不是静默产生跨目录的 R2 key（那会让孤儿清理的目录判定与实际 key 结构不同构）。
// 判据复用 `types.ts` 的 `isValidProfileHash`：**分层保留**（路由层给 400、这里抛错），
// 但判据表达式只应有一处（审计 R-07）。
function assertHashForPath(hash: string): void {
  if (!isValidProfileHash(hash)) {
    throw new Error(`Hash contains invalid path characters: ${hash}`);
  }
}

// 工作目录名（`{Type}_{hash}/`）的**纯格式化**（不带断言、不带前缀）。
// 孤儿判定的参照集（`db.listReferencedWorkingDirs`）也用它拼目录名 —— 几处集合比较必须同构，
// 形式不一致会让比较恒不命中（历史上正是这类不一致导致每小时清空一次 history/，见 F33），
// 所以目录名格式只此一份。
export function formatWorkingDirName(type: ProfileType, hash: string): string {
  return `${ProfileType[type]}_${hash}/`;
}

// 工作目录名（`{Type}_{hash}/`）。**不带 `history/` 前缀** —— 与 `listHistoryObjectsByDir()` 分组后的
// 目录键、`db.listReferencedWorkingDirs()` 的产物保持同一形式（见 formatWorkingDirName 的说明）。
// 需要构造完整 key/前缀时用 `workingDirPrefix()`（= `history/` + 本函数）。
export function workingDirName(type: ProfileType, hash: string): string {
  assertHashForPath(hash);
  return formatWorkingDirName(type, hash);
}

// 带 `history/` 前缀的完整工作目录前缀（R2 key 构造与前缀清理用）
export function workingDirPrefix(type: ProfileType, hash: string): string {
  return `${HISTORY_PREFIX}${workingDirName(type, hash)}`;
}

export function historyKey(type: ProfileType, hash: string, fileName: string): string {
  return `${workingDirPrefix(type, hash)}${fileName}`;
}

// 注意：R2 put 接受 ArrayBuffer | ArrayBufferView | ReadableStream | Blob，直接把 upload 内容透传，
// **不做防御性拷贝**。此前 `body.slice().buffer` 会为每次上传再复制一份；叠加 multipart 解析期的
// 切片拷贝，POST /api/history 的峰值内存约为文件大小的 3 倍（40MB ≈ 120MB，逼近 Workers 128MB 上限）。

export class R2Storage {
  constructor(private bucket: R2Bucket) {}

  // ===== 暂存区（file/）=====

  async putTemp(name: string, body: ArrayBuffer | Uint8Array | ReadableStream, contentType?: string): Promise<void> {
    await this.bucket.put(tempKey(name), body, contentType ? { httpMetadata: { contentType } } : undefined);
  }

  async getTemp(name: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(tempKey(name));
  }

  async deleteTemp(name: string): Promise<void> {
    await this.bucket.delete(tempKey(name));
  }

  // DELETE /file：删除整个暂存区（上游 SafeDeleteFolder —— **吞掉所有删除异常**并返回 200）
  async clearTempFolder(): Promise<void> {
    try {
      await this.deletePrefix(TEMP_PREFIX);
    } catch {
      // 上游 `SafeDeleteFolder` 用 `catch { }` 忽略删除失败：清理是尽力而为的操作，
      // 失败不应让客户端的 CleanupTempFilesAsync 报错（那只是每次上传前的可选清理）。
      // R2 的强一致删除极少失败；此处对齐上游语义，不把清理失败升级为 5xx。
    }
  }

  // 列出暂存区对象（供 PROPFIND 生成 WebDAV multistatus）
  async listTempObjects(): Promise<{ name: string; size: number }[]> {
    const out: { name: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: TEMP_PREFIX, cursor });
      for (const obj of listed.objects) {
        out.push({ name: obj.key.slice(TEMP_PREFIX.length), size: obj.size });
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return out;
  }

  // ===== 持久区（history/{Type}_{hash}/）=====

  async putHistory(type: ProfileType, hash: string, fileName: string, body: ArrayBuffer | Uint8Array | ReadableStream, contentType?: string): Promise<void> {
    await this.bucket.put(historyKey(type, hash, fileName), body, contentType ? { httpMetadata: { contentType } } : undefined);
  }

  // range 直接透传给 R2 的区间读（由 R2 切片段，不把整个对象读进 Workers 内存再截断）。
  // 目前只有 UI 数据端点（`GET /ui/api/history/:type/:hash/data`）会传：协议侧忽略 Range
  // 是对齐上游的**有意**行为（F29b，docs/backend-gaps.md §2.3），那边不应改。
  async getHistory(
    type: ProfileType,
    hash: string,
    fileName: string,
    range?: { offset: number; length: number },
  ): Promise<R2ObjectBody | null> {
    return this.bucket.get(historyKey(type, hash, fileName), range ? { range } : undefined);
  }

  // 只取元数据、不下载对象体：调用方要先知道 size 才能判断 Range 是否可满足。
  // 不把「起点 ≥ 对象大小」的区间直接交给 R2——文档只承诺「请求的字节数多于对象存在时会少返回」，
  // 越界区间（按 HTTP 语义应当 416）的行为未定义，拿 size 自行判定更稳。
  async headHistory(type: ProfileType, hash: string, fileName: string): Promise<R2Object | null> {
    return this.bucket.head(historyKey(type, hash, fileName));
  }

  // 删除单个历史工作目录（上游 DeleteProfileData 语义）
  async deleteHistoryWorkingDir(type: ProfileType, hash: string): Promise<void> {
    await this.deletePrefix(workingDirPrefix(type, hash));
  }

  // 列出 history/ 下的**全部对象 key**（数据完整性自检的 R2 一侧；期望 key 由 DB 记录算出后求差集）。
  // 分页列举而不是逐条 HEAD：Free 计划单次调用的内部服务子请求上限是 1000（本仓库按它设了
  // SUBREQUEST_BUDGET = 800，见 src/cleanup.ts:28-31），本机记录总数 2000+ 逐条 HEAD 一次调用即触顶；
  // 列举是 1000 键/页，成本 = ceil(对象数 / 1000) 次子请求（本机实测 305 个对象 ⇒ 1 轮）。
  async listHistoryObjectKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: HISTORY_PREFIX, cursor });
      for (const obj of listed.objects) keys.add(obj.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return keys;
  }

  // 列出 history/ 下的全部对象并**按工作目录分组**（`{Type}_{hash}/` → 该目录下的 key）。
  // 清理任务用它把「逐条记录删自己的目录」换成「每批一次批量删」—— 成本从**每条 2 次 R2 调用**
  // （列举 + 删除，见 deletePrefix）降到**每轮一次列举 + 每批一次删除**，这是清理吞吐的关键：
  // 逐条删除时每条记录 3 次子请求，500 条/批就是 1500 次，已经超过平台单次调用 1000 的上限。
  // 返回 pages：列举的分页数（1000 键/页），供调用方按**实际**调用数记账（不靠猜页数）。
  async listHistoryObjectsByDir(): Promise<{ groups: Map<string, string[]>; pages: number }> {
    const groups = new Map<string, string[]>();
    let pages = 0;
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: HISTORY_PREFIX, cursor });
      pages++;
      for (const obj of listed.objects) {
        const rest = obj.key.slice(HISTORY_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) continue;
        const dir = rest.slice(0, slash + 1);
        const owned = groups.get(dir);
        if (owned) owned.push(obj.key);
        else groups.set(dir, [obj.key]);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return { groups, pages };
  }

  // 删掉**一批** key。R2 单次 delete 调用上限是 1000 个 key（与列举同量级），故分块；
  // 调用方保证一次传入不超过 1000 个（清理任务自己分块，以便在块与块之间检查子请求预算）。
  async deleteHistoryKeys(keys: string[]): Promise<void> {
    if (keys.length > R2_DELETE_BATCH) {
      throw new Error(`deleteHistoryKeys: 一次最多 ${R2_DELETE_BATCH} 个 key，收到 ${keys.length}`);
    }
    await this.bucket.delete(keys);
  }

  // 只删**给定集合**里的工作目录（传入 `workingDirPrefix()` 的产物，即 `history/Type_hash/`）：
  // 一次列举 + 每个匹配页一次批量删，成本与整棵前缀清理同量级（约 3 次子请求/1000 对象）。
  //
  // 为什么不直接按整棵 `history/` 前缀清理：清空与并发上传之间有一个窗口，
  // 前缀清理会把窗口里**新写入**那条记录的数据目录一起抹掉，而它的行还在 —— 那是数据损坏
  // （表现为 hasData 但对象缺失，正是 /ui/api/integrity 能查出来的形态）。按集合删则只漏删
  // （新记录不在集合里，其数据保留），最坏留下孤儿目录，由清理任务的孤儿阶段兜底。
  // 注意不能反过来「先清前缀再删行」：那样 DELETE 一旦失败就是整库悬空。
  async deleteHistoryDirs(dirs: string[]): Promise<void> {
    if (dirs.length === 0) return;
    const wanted = new Set(dirs.map((dir) => dir.slice(HISTORY_PREFIX.length)));
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: HISTORY_PREFIX, cursor });
      const keys = listed.objects
        .map((object) => object.key)
        .filter((key) => {
          const rest = key.slice(HISTORY_PREFIX.length);
          const slash = rest.indexOf('/');
          return slash > 0 && wanted.has(rest.slice(0, slash + 1));
        });
      if (keys.length > 0) await this.bucket.delete(keys);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  // 历史数据总字节数（statistics.totalFileSizeMB 用）
  async totalHistorySize(): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: HISTORY_PREFIX, cursor });
      for (const obj of listed.objects) {
        total += obj.size;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return total;
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await this.bucket.delete(listed.objects.map((o) => o.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}
