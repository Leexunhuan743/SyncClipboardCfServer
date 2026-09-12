// R2 访问层（docs/design.md §5.2）
import { ProfileType } from './types';

// key 布局：
//   暂存:   file/{dataName}
//   持久:   history/{Type}_{hash}/{transferDataName}
const TEMP_PREFIX = 'file/';
const HISTORY_PREFIX = 'history/';

export function tempKey(name: string): string {
  return `${TEMP_PREFIX}${name}`;
}

export function workingDirPrefix(type: ProfileType, hash: string): string {
  return `${HISTORY_PREFIX}${ProfileType[type]}_${hash}/`;
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

  async getHistory(type: ProfileType, hash: string, fileName: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(historyKey(type, hash, fileName));
  }

  // 删除单个历史工作目录（上游 DeleteProfileData 语义）
  async deleteHistoryWorkingDir(type: ProfileType, hash: string): Promise<void> {
    await this.deletePrefix(workingDirPrefix(type, hash));
  }

  // 删除全部历史数据（ClearAllAsync 语义）
  async clearHistoryData(): Promise<void> {
    await this.deletePrefix(HISTORY_PREFIX);
  }


  // 列出 history/ 下的工作目录前缀（{Type}_{hash}/），用于孤儿对象清理
  async listHistoryWorkingDirs(): Promise<string[]> {
    const dirs = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: HISTORY_PREFIX, cursor });
      for (const obj of listed.objects) {
        const rest = obj.key.slice(HISTORY_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash > 0) dirs.add(rest.slice(0, slash + 1));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return [...dirs];
  }

  // 删除指定工作目录前缀（传入 "Type_hash/" 形式）
  async deleteHistoryPrefix(workingDir: string): Promise<void> {
    await this.deletePrefix(`${HISTORY_PREFIX}${workingDir}`);
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
