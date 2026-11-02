// 服务端接口封装：只负责「发请求 / 解析 / 归一化 / 抛出可判别错误」。
//
// 归一化在这里做（不在组件里）：服务端按上游惯例把 type 序列化成数字，
// 前端只认类型名 —— 把这一次转换收在 API 边界上，组件就不必各自记得。
import { API_BASE, buildQuery, itemPath, normalizeItem, rateLimitMessage, type ItemRef } from './query';
import type { ActivityDay, DeploymentInfo, Folder, IntegrityReport, Item, Overview, Retention } from './types';

export { API_BASE, buildQuery, itemPath, normalizeItem, rateLimitMessage };

export class ApiError extends Error {
  readonly status: number;
  /** 限速（429）时服务端带 Retry-After：文案才说得出「还要等多久」 */
  readonly retryAfterSeconds: number | null;
  /** 结构化错误体（`{error:"data_missing"}`）：区分"对象确实不在服务器上"（终态）与"这次读取失败了"（可重试） */
  readonly payload: Record<string, unknown> | null;

  constructor(
    status: number,
    message: string,
    options: { retryAfterSeconds?: number | null; payload?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.payload = options.payload ?? null;
  }
}

// 单次请求上限。没有它时半开连接（无响应也无 RST）会让 fetch 永不 settle，按钮永远转圈。
const REQUEST_TIMEOUT_MS = 30_000;

interface Guard {
  signal: AbortSignal;
  done(): void;
}

/** 把"调用方取消"与"超时"合成一个 signal。 */
function withTimeout(signal: AbortSignal | undefined, timeout: number): Guard {
  const controller = new AbortController();
  let timer = 0;
  if (timeout > 0) {
    timer = window.setTimeout(
      () => controller.abort(new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`)),
      timeout,
    );
  }
  const relay = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    },
  };
}

function retryAfter(response: Response): number | null {
  const raw = Number(response.headers.get('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** 原始请求体（上传文件用）：与 `body`（JSON）二选一，必须同时给 `contentType` */
  raw?: Blob;
  contentType?: string;
  signal?: AbortSignal;
  timeout?: number;
}

async function request<T = unknown>(
  path: string,
  { method = 'GET', body, raw, contentType, signal, timeout = REQUEST_TIMEOUT_MS }: RequestOptions = {},
): Promise<T> {
  const guard = withTimeout(signal, timeout);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: raw !== undefined ? { 'content-type': contentType ?? 'application/octet-stream' } : body === undefined ? undefined : { 'content-type': 'application/json' },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      signal: guard.signal,
    });
    // 计时器留到**读完 body** 才清：「响应头到了、body 永远不来」照样能把调用方挂住
    const text = await response.text();
    let payload: unknown = null;
    let unreadable = false;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        unreadable = true;
      }
    }
    if (!response.ok) {
      const record = (payload && typeof payload === 'object' ? payload : null) as Record<string, unknown> | null;
      const message = String(record?.detail ?? record?.error ?? response.statusText ?? '请求失败');
      throw new ApiError(response.status, message || '请求失败', {
        retryAfterSeconds: retryAfter(response),
        payload: record,
      });
    }
    // 「2xx」与「body 是 JSON」是两件事：拦截式代理/门户页会以 200 回 HTML。
    // 宁可报错，也不要让调用方把空对象读成"零条记录"。
    if (unreadable) throw new ApiError(502, '服务器返回了无法读取的数据，请刷新后重试。');
    return payload as T;
  } finally {
    guard.done();
  }
}

/** 取二进制数据（图片 / 附件）：与 `request` 同一套取消 + 超时语义，返回 Blob。 */
async function requestBlob(path: string, { signal, timeout = REQUEST_TIMEOUT_MS }: RequestOptions = {}): Promise<Blob> {
  const guard = withTimeout(signal, timeout);
  try {
    const response = await fetch(path, { credentials: 'same-origin', signal: guard.signal });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      throw new ApiError(response.status, String(payload?.detail ?? payload?.error ?? response.statusText ?? '请求失败'), {
        payload,
      });
    }
    return await response.blob();
  } finally {
    guard.done();
  }
}

const idOf = (item: ItemRef) => ({ type: item.type, hash: item.hash });
const CHUNK = 100; // 服务端单批上限

export interface BatchOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ItemUpdate {
  starred?: boolean;
  pinned?: boolean;
  isDelete?: boolean;
}

export const api = {
  session: () => request<{ authenticated: boolean; username: string | null; version: string }>(`${API_BASE}/session`),
  login: (username: string, password: string) =>
    request<{ authenticated: true; username: string }>(`${API_BASE}/login`, {
      method: 'POST',
      body: { username, password },
    }),
  logout: () => request(`${API_BASE}/logout`, { method: 'POST' }),

  async list(params: Record<string, string | number | boolean>, signal?: AbortSignal) {
    const raw = await request<{ total?: number; items?: unknown[] }>(`${API_BASE}/history?${buildQuery(params)}`, { signal });
    return {
      total: raw.total ?? 0,
      items: (raw.items ?? []).map(normalizeItem).filter((item): item is Item => item !== null),
    };
  },

  /**
   * 全库最新的一条（按创建时间倒序取 1 条）：给「复制最近一条」用。
   * 刻意**不用当前列表的第一行**：列表可能被筛选、换了排序，而「最近一条」指的是全库最新的那条；
   * 也不让置顶抢位（`pinnedFirst=false`），否则「最近」会变成「最近置顶的」。
   */
  async latest(): Promise<Item | null> {
    const raw = await request<{ items?: unknown[] }>(
      `${API_BASE}/history?${buildQuery({ pageSize: 1, sort: 'createTime', order: 'desc', pinnedFirst: 'false' })}`,
    );
    const first = raw.items?.[0];
    return first === undefined ? null : normalizeItem(first);
  },

  /** 单条（含**完整正文**）。 */
  async get(item: ItemRef, signal?: AbortSignal): Promise<Item> {
    const result = normalizeItem(await request(itemPath(item), { signal }));
    if (!result) throw new ApiError(502, '服务器返回了无法读取的数据，请刷新后重试。');
    return result;
  },

  async patch(item: ItemRef, fields: Record<string, unknown>): Promise<Item> {
    const result = normalizeItem(await request(itemPath(item), { method: 'PATCH', body: fields }));
    if (!result) throw new ApiError(502, '服务器返回了无法读取的数据，请刷新后重试。');
    return result;
  },

  /**
   * 「使用了这条记录」：复制/下载成功后推进访问时间。回显 lastModified 与 version 是为了**别动它们**
   * （否则一次"读取"会抬高版本、改掉修改时间，官方客户端随后的同步会被判成冲突）。
   */
  touch(item: Item): Promise<Item> {
    return api.patch(item, {
      lastAccessed: new Date().toISOString(),
      lastModified: item.lastModified,
      version: item.version,
    });
  },

  /**
   * 批量写：`update` 应用到每一条（收藏/置顶/软删/恢复共用）。按 100 分片串行；`signal` 只当
   * **停止旗子**用，不掐断在途那一片（掐断 fetch 并不会让服务端停下，客户端会少报已生效的条数）。
   */
  async batchUpdate(items: ItemRef[], update: ItemUpdate, { onProgress, signal }: BatchOptions = {}) {
    let updated = 0;
    let failed = 0;
    const shards = Math.max(1, Math.ceil(items.length / CHUNK));
    for (let i = 0, n = 1; i < items.length; i += CHUNK, n += 1) {
      if (signal?.aborted) return { updated, failed, aborted: true };
      onProgress?.(n, shards);
      const result = await request<{ updated?: number; failed?: number }>(`${API_BASE}/history/batch-update`, {
        method: 'POST',
        body: { items: items.slice(i, i + CHUNK).map(idOf), update },
      });
      updated += result?.updated ?? 0;
      failed += result?.failed ?? 0;
    }
    return { updated, failed, aborted: false };
  },

  /** 彻底删除（只处理回收站里的记录，判据写在服务端 SQL 里）。 */
  async batchPurge(items: ItemRef[], { onProgress, signal }: BatchOptions = {}) {
    let purged = 0;
    let failed = 0;
    const shards = Math.max(1, Math.ceil(items.length / CHUNK));
    for (let i = 0, n = 1; i < items.length; i += CHUNK, n += 1) {
      if (signal?.aborted) return { purged, failed, aborted: true };
      onProgress?.(n, shards);
      const result = await request<{ purged?: number; failed?: number }>(`${API_BASE}/history/batch-purge`, {
        method: 'POST',
        body: { items: items.slice(i, i + CHUNK).map(idOf) },
      });
      purged += result?.purged ?? 0;
      failed += result?.failed ?? 0;
    }
    return { purged, failed, aborted: false };
  },

  /** 批量取完整记录（含全文）。这是**读**，可以连在途请求一起掐断。 */
  async batchMeta(items: ItemRef[], { signal }: { signal?: AbortSignal } = {}): Promise<Item[]> {
    const out: Item[] = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      if (signal?.aborted) return out;
      const raw = await request<{ items?: unknown[] }>(`${API_BASE}/history/batch-meta`, {
        method: 'POST',
        signal,
        body: { items: items.slice(i, i + CHUNK).map(idOf) },
      });
      for (const entry of raw?.items ?? []) {
        const item = normalizeItem(entry);
        if (item) out.push(item);
      }
    }
    return out;
  },

  /**
   * 新建一条**文本**记录（编辑保存 / 手动新建）。正文一改 hash 就变，所以这永远是另一条记录。
   * 形状不对就抛：调用方要拿 `size` 写"已保存（N 个字符）"，宁可报错也不画一个猜出来的数字。
   */
  async createText(text: string): Promise<Item> {
    const created = normalizeItem(await request(`${API_BASE}/history`, { method: 'POST', body: { text } }));
    if (!created || typeof created.size !== 'number') {
      throw new ApiError(502, '服务器返回了无法读取的数据，请刷新后重试。');
    }
    return created;
  },

  /**
   * 上传一个文件/图片：请求体就是原始字节（浏览器直接把 `File` 流出去，不在内存里拼表单）。
   * 超时放宽到 10 分钟：大文件在慢网络上传不完是常态，30 秒的默认上限会把正常上传掐断。
   */
  async upload(file: File, signal?: AbortSignal): Promise<Item> {
    const created = normalizeItem(
      await request(`${API_BASE}/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        raw: file,
        contentType: 'application/octet-stream',
        signal,
        timeout: 10 * 60_000,
      }),
    );
    if (!created) throw new ApiError(502, '服务器返回了无法读取的数据，请刷新后重试。');
    return created;
  },

  // ---- 收藏夹（本站独有）：每个写操作都返回最新的收藏夹列表，前端直接替换 ----
  createFolder: (name: string) => request<{ id: number; folders: Folder[] }>(`${API_BASE}/folders`, { method: 'POST', body: { name } }),
  renameFolder: (id: number, name: string) =>
    request<{ id: number; folders: Folder[] }>(`${API_BASE}/folders/${id}`, { method: 'PATCH', body: { name } }),
  /** 删除收藏夹：里面的记录移出（不删记录）；`moved` 是被移出的条数 */
  deleteFolder: (id: number) => request<{ moved: number; folders: Folder[] }>(`${API_BASE}/folders/${id}`, { method: 'DELETE' }),
  /** 把一批记录放进收藏夹（`folderId = null` = 移出）。按 100 分片，返回合计与最新的收藏夹列表。 */
  async setFolder(items: ItemRef[], folderId: number | null) {
    let updated = 0;
    let failed = 0;
    let folders: Folder[] = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      const result = await request<{ updated?: number; failed?: number; folders?: Folder[] }>(`${API_BASE}/history/batch-folder`, {
        method: 'POST',
        body: { items: items.slice(i, i + CHUNK).map(idOf), folderId },
      });
      updated += result?.updated ?? 0;
      failed += result?.failed ?? 0;
      folders = result?.folders ?? folders;
    }
    return { updated, failed, folders };
  },

  /** 清空：scope='trash' 只清回收站，'all' 清全部。 */
  clear: (scope: 'trash' | 'all') =>
    request<{ scope: string; deleted: number }>(`${API_BASE}/history/clear`, { method: 'POST', body: { scope } }),

  /** `light`：不让服务端列举 R2（存储体积为 null）。日常刷新用它，体积只在需要时取。 */
  overview: ({ deleted = false, light = false, signal }: { deleted?: boolean; light?: boolean; signal?: AbortSignal } = {}) => {
    const query = buildQuery({ deleted: deleted ? 'true' : '', storage: light ? '0' : '' });
    return request<Overview>(`${API_BASE}/overview${query ? `?${query}` : ''}`, { signal });
  },
  info: () => request<DeploymentInfo>(`${API_BASE}/info`),
  poll: (signal?: AbortSignal) =>
    request<{ count: number; lastModified: number; serverTime: string }>(`${API_BASE}/poll`, { signal }),
  /** 近 N 天每天新增条数。时区必须由调用方给（服务端只知道 UTC）。 */
  activity: (days = 14, signal?: AbortSignal) =>
    request<{ days: ActivityDay[]; max: number }>(
      `${API_BASE}/activity?days=${days}&tz=${new Date().getTimezoneOffset()}`,
      { signal },
    ),
  integrity: () => request<IntegrityReport>(`${API_BASE}/integrity`),
  updateSettings: (patch: { retentionMinutes?: number | null; maxSavedHistoryCount?: number | null }) =>
    request<{ retention: Retention }>(`${API_BASE}/settings`, { method: 'PUT', body: patch }),
  hubTicket: () => request<{ token: string; path: string }>(`${API_BASE}/hub-ticket`, { method: 'POST' }),

  dataUrl: (item: ItemRef, { download = false } = {}) => `${itemPath(item)}/data${download ? '?download=1' : ''}`,
  fetchData: (item: ItemRef, { download = false, signal }: { download?: boolean; signal?: AbortSignal } = {}) =>
    requestBlob(api.dataUrl(item, { download }), { signal }),
};
