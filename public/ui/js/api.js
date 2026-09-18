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

// 导出给测试（test/ui-logic.test.ts）：归一化与查询串构造是「界面显示错了」的两个源头，
// 它们不需要 DOM 也不需要网络，属于纯逻辑——放在这里被直接覆盖，而不是只能靠浏览器端到端。
export function normalizeItem(raw) {
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

export function buildQuery(params) {
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

  async get(item, signal) {
    const raw = await request(
      `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`,
      { signal },
    );
    return normalizeItem(raw);
  },

  async patch(item, fields) {
    const raw = await request(
      `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`,
      { method: 'PATCH', body: fields },
    );
    return normalizeItem(raw);
  },

  // 批量写：`update` 是要应用到每一条的字段集合（收藏/置顶/删除/恢复共用这一条路径）。
  // 服务端逐条走与单条 PATCH 相同的实现（各自广播、各自清数据目录），单次 100 条封顶 ——
  // 每条 ≈5 次子请求，200 条正好顶到单次调用的 1000 次内部子请求上限，故这里按 100 **分片串行**发，
  // 调用方只管传整批，结果合并成一个合计（分片之间若某片失败，前几片已生效，由调用方刷新对账）。
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

  // 清空历史：scope='trash' 只清回收站、'all' 清全部。
  // 服务端各用一条批量语句（不是逐条删除），也不逐条广播——见 src/ui/routes.ts 里该路由的注释。
  clear: (scope) => request('/ui/api/history/clear', { method: 'POST', body: { scope } }),

  // 数据完整性自检：只在用户点「检查」时调用（服务端要列举一遍 R2，不属于每次加载都该付的成本）
  integrity: () => request('/ui/api/integrity'),

  // 保留策略的写入（服务端 Meta 覆盖，0 = 关闭该阶段，null = 回落到部署时的环境变量）。
  // 读侧没有单独接口：生效值与来源都随 `/ui/api/info` 返回（同一份 readRetentionSettings）。
  updateSettings: (patch) => request('/ui/api/settings', { method: 'PUT', body: patch }),

  statistics: (signal, { deleted = false } = {}) => {
    // 类型计数随视图走：回收站视图要的是「已删除里各类型多少」，不是活跃记录的数
    const query = buildQuery({ deleted: deleted ? 'true' : '' });
    return request(`/ui/api/statistics${query ? `?${query}` : ''}`, { signal });
  },
  info: () => request('/ui/api/info'),
  poll: (signal) => request('/ui/api/poll', { signal }),

  // 换一张 Hub 连接票据（`{ token, path }`）：推送通道用它建立 WebSocket。
  // DO 不可达时服务端返回 503，调用方据此继续用轮询。
  hubTicket: () => request('/ui/api/hub-ticket', { method: 'POST' }),

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
