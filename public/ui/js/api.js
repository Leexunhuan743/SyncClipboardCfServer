// `/ui/api` 的调用封装：只负责「发请求 / 解析 / 归一化 / 抛出可判别错误」。
//
// 归一化在这里做（不在组件里）：服务端按上游惯例把 `type` 序列化成**数字**
// （ASP.NET 默认按数字序列化枚举），而前端只认类型名。把这一次转换收在 API 边界上，
// 组件就不必各自记得转换 —— 忘一处就是一处显示错。
import { typeName } from './format.js';
import { dataPath } from './paths.js';

export class ApiError extends Error {
  constructor(status, message, payload = null, retryAfterSeconds = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    // 429 时服务端在 `Retry-After` 头里给出"还要等多久"（`src/auth.ts` 的 tooManyRequests）。
    // **必须带出来**：`messages.js` 的精细文案（"请在 N 秒后重试"）读的就是这个字段，
    // 不带它 → `Number(undefined)` 是 NaN → 那两条文案永远是死分支。
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function request(
  path,
  { method = 'GET', body, signal, textResponse = false, blobResponse = false, timeoutMs = 20_000 } = {},
) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('请求超时，请检查连接后重试。')), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    // 二进制响应（记录的数据文件）：成功时**不读文本** —— 把 8 MiB 的文件读成字符串再转回 Blob
    // 是纯浪费。失败时照旧走下面那条统一路径，好让 404/401/429 的状态码与文案原样保留。
    if (blobResponse && response.ok) return await response.blob();

    const text = textResponse && response.ok ? await readTextBody(response) : await response.text();
    if (textResponse && response.ok) return text;
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) throw new ApiError(502, '服务器返回了无法读取的数据，请刷新后重试。');
        payload = {};
      }
    }

    if (!response.ok) {
      const message = (payload && (payload.detail || payload.error)) || response.statusText || '请求失败';
      // `Retry-After` 是**秒数**（RFC 9110 也允许 HTTP-date，本服务端发的是秒数，见 tooManyRequests）
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        response.status,
        message,
        payload,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    return payload;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** 只为交互读取有限正文；大文本仍可通过下载取回完整原件。 */
async function readTextBody(response) {
  const limit = 8 * 1024 * 1024;
  const tooLarge = () => new ApiError(413, '正文超过 8 MiB，请下载文件后查看完整内容。');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

/** 导出给测试（test/ui-logic.test.ts）：归一化是「界面显示错了」的一个源头，且它不需要 DOM 与网络。 */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = typeName(raw.type);
  return {
    ...raw,
    type,
    // `key` 是记录的身份：**type + hash**（不是行 ID —— ID 是 D1 自增的，跨设备无意义）
    key: `${type}-${raw.hash}`,
    // 服务端在列表里截断正文（一页几百条长文本会有几十 MB）。
    // 需要完整内容时必须先取单条 —— 复制走截断值就是把剪贴板内容砍一半给用户。
    textTruncated: raw.textTruncated === true,
  };
}

/** 查询参数序列化：跳过空值（空串/false/null/undefined 都不该出现在 URL 里）。 */
export function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    query.set(key, String(value));
  }
  return query.toString();
}

/** 本机时区相对 UTC 的偏移（分钟，与 `Date.prototype.getTimezoneOffset` 同号）。 */
export function tzOffset() {
  return new Date().getTimezoneOffset();
}

export const api = {
  session: () => request('/ui/api/session'),

  login: (username, password) => request('/ui/api/login', { method: 'POST', body: { username, password } }),

  logout: () => request('/ui/api/logout', { method: 'POST' }),

  /** 列表。服务端把正文截到 500 字符并置 `textTruncated`。 */
  async list(filters, signal) {
    const raw = await request(`/ui/api/history?${buildQuery(filters)}`, { signal });
    return {
      total: raw.total ?? 0,
      items: (raw.items ?? []).map(normalizeItem).filter(Boolean),
    };
  },

  /** 单条元数据（正文**完整**）。列表里 `textTruncated` 的记录必须先走这里。 */
  async get(item, signal) {
    const raw = await request(
      `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`,
      { signal },
    );
    return normalizeItem(raw);
  },

  textData: (item, signal) => request(api.dataUrl(item), { signal, textResponse: true }),

  /**
   * 记录的数据文件，**二进制**（复制图片用）。
   *
   * 必须走这一层而不是裸 `fetch`：`request()` 带超时、可被 signal 取消，并把 401 交给
   * `handleAuthError`。此前 `boot.js` 的「复制图片」用裸 `fetch`，于是网络半开（响应头/体永不到）时
   * 那条 Promise **永不 settle** ⇒ 上层按钮的 `setPending` 一直是 true（`disabled`），
   * 按钮永久转圈且永久不可点，会话过期也不会回登录页。
   * V1 的 `api.js` 早有这一档（`fetchData`），注释逐字描述过同一个症状；
   * 见 `docs/AUDIT-v1-v2-divergence.md` §1.4。
   */
  blobData: (item, signal) => request(api.dataUrl(item), { signal, blobResponse: true }),

  async patch(item, fields) {
    const raw = await request(
      `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`,
      { method: 'PATCH', body: fields },
    );
    return normalizeItem(raw);
  },

  /**
   * 批量写：`update` 是要应用到每一条的字段集合（收藏/置顶/删除/恢复共用这一条路径）。
   * 服务端逐条走与单条 PATCH **相同的实现**（各自广播、各自清数据目录），单次 100 条封顶 ——
   * 每条 ≈5 次子请求，200 条正好顶到单次调用的 1000 次内部子请求上限，故这里按 100 **分片串行**发。
   * 调用方只管传整批，结果合并成一个合计（分片之间若某片失败，前几片已生效，由调用方刷新对账）。
   */
  async batchUpdate(items, update) {
    const CHUNK = 100;
    let updated = 0;
    let failed = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      const result = await request('/ui/api/history/batch-update', {
        method: 'POST',
        body: {
          items: items.slice(i, i + CHUNK).map((item) => ({ type: item.type, hash: item.hash })),
          update,
        },
      });
      updated += result?.updated ?? 0;
      failed += result?.failed ?? 0;
    }
    return { updated, failed };
  },

  /** 清空历史：`scope='trash'` 只清回收站、`'all'` 清全部。服务端各用一条批量语句，不逐条广播。 */
  clear: (scope) => request('/ui/api/history/clear', { method: 'POST', body: { scope } }),

  /**
   * 数据完整性自检：只在用户点「检查」时调用（服务端要列举一遍 R2，不属于每次加载都该付的成本）。
   * **单独放宽超时**：服务端要把 history 前缀整轮列出来，对象多时实测秒级，默认 20s 偏紧；
   * 而全局调大默认值会让 `test/ui-input.test.ts` 的 20s 超时用例永远等不到 reject。
   */
  integrity: () => request('/ui/api/integrity', { timeoutMs: 60_000 }),

  /** 保留策略写入（Meta 覆盖；`0` = 关闭该阶段，`null` = 回落到部署环境变量）。 */
  updateSettings: (patch) => request('/ui/api/settings', { method: 'PUT', body: patch }),

  info: () => request('/ui/api/info'),

  /**
   * 首屏总览（**合并端点**）：统计 + 部署信息 + 变更标记 + 服务端时间。
   *
   * 为什么要有它：V1 的首屏打三次请求（`history` + `statistics` + `info`），而 `statistics`
   * 内部还要跑三条查询（`docs/backend-gaps.md` §3.1）。V2 的概览带需要的是它们**合并后的
   * 一个快照**，且概览带与列表必须在同一次往返里对齐（否则数字与列表可能来自两个瞬间）。
   *
   * **不发 `tz`**（2026-09-18 修）：这个端点在服务端只读 `deleted`
   * （`src/ui/routes.ts` 的 `readDeletedFlagOr400`），`tz` 从头到尾没人读 ——
   * 一直发它只会制造"好像按本地时区算过"的错觉。（`/ui/api/activity` 的 `tz` 是真的被读的。）
   * 见 `docs/AUDIT-v1-v2-divergence.md` §7.2。
   */
  overview: (signal, { deleted = false } = {}) =>
    request(`/ui/api/overview?${buildQuery({ deleted })}`, { signal }),

  /**
   * 活动趋势：每天有多少条记录（按**客户端时区**切分「一天」）。
   * `day` 的边界错位是这类图表最常见的错 —— UTC+8 的用户在早上 8 点前看到的"今天"会是昨天。
   */
  activity: (signal, { days = 14, tz = tzOffset() } = {}) =>
    request(`/ui/api/activity?${buildQuery({ days, tz })}`, { signal }),

  poll: (signal) => request('/ui/api/poll', { signal }),

  /** 换一张 Hub 连接票据（`{token, path}`）：推送通道用它建立 WebSocket。 */
  hubTicket: () => request('/ui/api/hub-ticket', { method: 'POST' }),

  /**
   * 数据文件地址（图片预览用 `<img src>`、下载用 `<a href>`，两者都自动带同源 Cookie）。
   * 串本身由 `./paths.js` 的纯函数构造 —— 同一个地址还有第二个消费者（`ui/row.js` 的缩略图），
   * 两处各写一份模板就会在改接口前缀时漏掉一处。这里只做转发，不再保留第二份拼法。
   */
  dataUrl: (item, { download = false } = {}) => dataPath(item, { download }),
};

/** 会话过期时统一回登录页（保留当前位置，登录后跳回）。 */
export function redirectToLogin() {
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  location.replace(`/ui/app/login.html?next=${next}`);
}

/** 401 统一处理。返回 true 表示"已经处理掉了"（调用方应直接 return，不要再弹提示）。 */
export function handleAuthError(error) {
  if (error instanceof ApiError && error.status === 401) {
    redirectToLogin();
    return true;
  }
  return false;
}
