// /ui/api 的调用封装：只负责「发请求 / 解析 / 归一化 / 抛出可判别错误」。
//
// 归一化在这里做（不在组件里）：服务端按上游惯例把 type 序列化成数字，
// 前端只认类型名——把这一次转换收在 API 边界上，组件就不必各自记得转换。
import { typeName } from './format.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? null;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const code = payload && typeof payload.error === 'string' ? payload.error : null;
    const message = (payload && (payload.detail || payload.error)) || response.statusText || '请求失败';
    throw new ApiError(response.status, code, message);
  }
  return payload;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = typeName(raw.type);
  return {
    ...raw,
    type,
    key: `${type}-${raw.hash}`,
    // 服务端在列表里截断正文（一页几百条长文本会有几十 MB）。
    // 需要完整内容时必须先取单条——复制走截断值就是把剪贴板内容砍一半给用户。
    textTruncated: raw.textTruncated === true,
  };
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    query.set(key, String(value));
  }
  return query.toString();
}

export const api = {
  session: () => request('/ui/api/session'),

  login: (username, password) => request('/ui/api/login', { method: 'POST', body: { username, password } }),

  logout: () => request('/ui/api/logout', { method: 'POST' }),

  async list(filters, signal) {
    const raw = await request(`/ui/api/history?${buildQuery(filters)}`, { signal });
    return {
      total: raw.total ?? 0,
      page: raw.page ?? 1,
      pageSize: raw.pageSize ?? 50,
      items: (raw.items ?? []).map(normalizeItem).filter(Boolean),
    };
  },

  async get(item) {
    const raw = await request(`/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`);
    return normalizeItem(raw);
  },

  async patch(item, fields) {
    const raw = await request(
      `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`,
      { method: 'PATCH', body: fields },
    );
    return normalizeItem(raw);
  },

  batchDelete: (items) =>
    request('/ui/api/history/batch-delete', {
      method: 'POST',
      body: { items: items.map((item) => ({ type: item.type, hash: item.hash })) },
    }),

  statistics: () => request('/ui/api/statistics'),
  info: () => request('/ui/api/info'),
  poll: () => request('/ui/api/poll'),

  // 数据文件地址（图片预览用 <img src>、下载用 <a href>，两者都自动带同源 Cookie）
  dataUrl: (item, { download = false } = {}) =>
    `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}/data${
      download ? '?download=1' : ''
    }`,
};

// 会话过期时统一回登录页（保留当前位置，登录后跳回）
export function redirectToLogin() {
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  location.replace(`/ui/login.html?next=${next}`);
}

export function handleAuthError(error) {
  if (error instanceof ApiError && error.status === 401) {
    redirectToLogin();
    return true;
  }
  return false;
}
