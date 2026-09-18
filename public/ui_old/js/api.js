// 服务端接口的调用封装：只负责「发请求 / 解析 / 归一化 / 抛出可判别错误」。
//
// 归一化在这里做（不在组件里）：服务端按上游惯例把 type 序列化成数字，
// 前端只认类型名——把这一次转换收在 API 边界上，组件就不必各自记得转换。
//
import { typeName } from './format.js';

// ===== 挂载点：页面在 `/ui_old/`、接口在 `/ui/api/`，两者不是同一个前缀 =====
//
// 这个区别必须有唯一的字面量（下面这个 `API_BASE`）。教训有据可查：2026-09-15 把 V1 存档进
// `public/ui_old/` 时，`/ui/` → `/ui_old/` 的批量改写**把接口前缀也一起改了** —— 接口请求被
// 打到界面自己的挂载点下面（`…ui_old` 后面接 `api/`），而服务端从不提供那个命名空间
// （`src/index.ts` 把 `/ui_old/*` 整体当静态存档交给 `env.ASSETS`）。症状极具迷惑性：
// HTML/CSS/JS 全部 200，列表却永远停在骨架屏上，只有一个「初始化失败：Not Found」的提示。
//
// （上面这段说明刻意不写出那个错前缀的字面量：`test/ui-guard.test.ts` 有一节断言
//  "V1 源码里不出现它"，把正确答案与错误答案并列写在同一个文件里只会让守卫自相矛盾。）
export const API_BASE = '/ui/api';

// 挂载点前缀（**本目录里唯一允许出现 `/ui_old` 字面量的地方**）。
//
// 上面那条历史事故还有另一半：接口前缀被批量改写的时候，界面里的**挂载点**引用
// （回登录页、登录成功后的默认落点）同样是写死的字面量。接口前缀后来收成了 `API_BASE` 并配了守卫，
// 挂载点却一直散在三处 —— 同一次改名照样能改错，而且症状更难查（跳到一个 404）。
// 三处引用：本文件的 `redirectToLogin`、`js/login.js` 的默认落点、`js/main.js` 的登出跳转。
// 守卫见 `test/ui-guard.test.ts` 的「挂载点字面量只有一处」。
export const PAGE_BASE = '/ui_old';

export class ApiError extends Error {
  constructor(status, message, { retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // 限速（429）时服务端会带 Retry-After（见 src/auth.ts 的 tooManyRequests）：
    // 把它带出来，文案才说得出「还要等多久」。其余错误为 null。
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// 单次请求的默认上限。为什么需要它：此前只有列表/统计/轮询带 signal，而
// info / integrity / settings / hubTicket / login 都没有取消路径 —— 连接半开
// （既无响应、也无 RST）时 fetch 永不 settle，调用方的 `setPending` 便永远清不掉：
// 按钮一直转圈，而 `.btn[data-loading="true"]` 的 `pointer-events: none` 让人点不动它。
// 30 秒远高于最慢的合法请求（integrity 要列举一遍 R2，实测秒级）。
const REQUEST_TIMEOUT_MS = 30_000;

async function request(path, { method = 'GET', body, signal, timeout = REQUEST_TIMEOUT_MS } = {}) {
  // 内部 controller：把「调用方取消」与「超时」合成一个 signal 交给 fetch。
  // 不用 `AbortSignal.any` —— 那要求较新的内核，而这里是零构建、要能跑在旧浏览器上。
  const controller = new AbortController();
  let timer = 0;
  if (timeout > 0) {
    timer = setTimeout(
      () => controller.abort(new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`)),
      timeout,
    );
  }
  const relayAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', relayAbort, { once: true });
  }

  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    // 计时器要留到**读完 body** 才清：否则「响应头到了、body 永远不来」这种半开连接
    // 照样能把调用方挂住，而那正是这条超时要防的东西。
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }

    if (!response.ok) {
      const message = (payload && (payload.detail || payload.error)) || response.statusText || '请求失败';
      const raw = Number(response.headers.get('retry-after'));
      throw new ApiError(response.status, message, {
        retryAfterSeconds: Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null,
      });
    }
    return payload;
  } finally {
    clearTimeout(timer);
    // 一次性的监听器在正常路径上不会自己摘掉（只 abort 时才触发），故这里显式移除：
    // 轮询每 10 秒一次，不摘就是在 signal 上挂一辈子的闭包。
    signal?.removeEventListener('abort', relayAbort);
  }
}

// 限速（429）的用户可见文案。服务端的响应体是纯文本（`Too Many Requests`）、
// 真正有用的信息在 Retry-After 头里，故这里统一成一句中文，登录页与列表页共用。
export function rateLimitMessage(error) {
  const seconds = error?.retryAfterSeconds ?? null;
  if (!Number.isFinite(seconds) || seconds <= 0) return '尝试次数过多，请稍后再试。';
  if (seconds < 60) return `尝试次数过多，请在 ${seconds} 秒后重试。`;
  return `尝试次数过多，请在约 ${Math.ceil(seconds / 60)} 分钟后重试。`;
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

// 活动趋势的默认窗口（天）。上限 90 由服务端白名单决定（`src/ui/routes.ts` 的 /ui/api/activity）。
export const ACTIVITY_DAYS = 14;

export const api = {
  session: () => request(`${API_BASE}/session`),

  login: (username, password) =>
    request(`${API_BASE}/login`, { method: 'POST', body: { username, password } }),

  logout: () => request(`${API_BASE}/logout`, { method: 'POST' }),

  async list(filters, signal) {
    const raw = await request(`${API_BASE}/history?${buildQuery(filters)}`, { signal });
    return {
      total: raw.total ?? 0,
      items: (raw.items ?? []).map(normalizeItem).filter(Boolean),
    };
  },

  async get(item, signal) {
    const raw = await request(itemPath(item), { signal });
    return normalizeItem(raw);
  },

  // 全库最新的一条（按创建时间倒序取 1 条）：给「复制最近一条」这个入口用。
  // 刻意**不用当前列表的第一行** —— 列表可能被筛选或改过排序，而"最近一条"指的是全库最新的那条。
  // 同理要显式带 `pinnedFirst=false`：列表默认置顶优先（`src/ui/query.ts`），
  // 不带这一条的话"最近一条"会变成"最新的那条置顶记录"——答非所问。
  async latest(signal) {
    const raw = await request(
      `${API_BASE}/history?${buildQuery({
        page: 1,
        pageSize: 1,
        sort: 'createTime',
        order: 'desc',
        pinnedFirst: 'false',
      })}`,
      { signal },
    );
    return (raw?.items ?? []).map(normalizeItem).filter(Boolean)[0] ?? null;
  },

  async patch(item, fields) {
    const raw = await request(itemPath(item), { method: 'PATCH', body: fields });
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
      const result = await request(`${API_BASE}/history/batch-update`, {
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
  clear: (scope) => request(`${API_BASE}/history/clear`, { method: 'POST', body: { scope } }),

  // 数据完整性自检：只在用户点「检查」时调用（服务端要列举一遍 R2，不属于每次加载都该付的成本）
  integrity: () => request(`${API_BASE}/integrity`),

  // 保留策略的写入（服务端 Meta 覆盖，0 = 关闭该阶段，null = 回落到部署时的环境变量）。
  // 读侧没有单独接口：生效值与来源都随 `/ui/api/info` 返回（同一份 readRetentionSettings）。
  updateSettings: (patch) => request(`${API_BASE}/settings`, { method: 'PUT', body: patch }),

  statistics: (signal, { deleted = false } = {}) => {
    // 类型计数随视图走：回收站视图要的是「已删除里各类型多少」，不是活跃记录的数
    const query = buildQuery({ deleted: deleted ? 'true' : '' });
    return request(`${API_BASE}/statistics${query ? `?${query}` : ''}`, { signal });
  },

  // 首屏的**合成快照**（2026-09-18）：一次往返拿到 存量统计 + 类型计数 + 变更标记 +
  // 部署信息 + 服务端时间。此前首屏要发 list + statistics + poll 三次请求，现在是两次
  // （overview 里没有列表项），而且「时钟差 / 最近一次同步 / 清理状态」这三样**排障时要看的**
  // 东西随它一起到手 —— 否则它们只在用户主动打开部署信息（`/ui/api/info`）时才取。
  overview: ({ deleted = false, signal } = {}) =>
    request(`${API_BASE}/overview${deleted ? '?deleted=true' : ''}`, { signal }),

  // 批量取记录（含**完整正文**）：列表里的正文被服务端截断到 500 字符，
  // 「选中多条 → 一起复制」必须拿全文，而逐条走单条端点是 O(N) 次请求。
  // 服务端单次上限 100 条（`BATCH_META_MAX_ITEMS`），超出部分在这里分片串行。
  async batchMeta(items) {
    const CHUNK = 100;
    const out = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      const raw = await request(`${API_BASE}/history/batch-meta`, {
        method: 'POST',
        body: {
          items: items.slice(i, i + CHUNK).map((item) => ({ type: item.type, hash: item.hash })),
        },
      });
      for (const entry of raw?.items ?? []) {
        const item = normalizeItem(entry);
        if (item) out.push(item);
      }
    }
    return out;
  },

  info: () => request(`${API_BASE}/info`),
  poll: (signal) => request(`${API_BASE}/poll`, { signal }),

  // 近 N 天每天新增多少条记录（借自 V2 的 `/ui/api/activity`）。
  //
  // 时区必须由**调用方**给：服务端只知道 UTC，直接按 UTC 切会让 UTC+8 的用户在早上 8 点前
  // 看到的"今天"其实是昨天（2026-09-15T20:00Z 对用户已经是 09-16 04:00）。
  // `getTimezoneOffset()` 的符号与服务端的 `tz` 参数一致（UTC+8 ⇒ -480）。
  activity: (days = ACTIVITY_DAYS, signal) =>
    request(`${API_BASE}/activity?days=${days}&tz=${new Date().getTimezoneOffset()}`, { signal }),

  // 换一张 Hub 连接票据（`{ token, path }`）：推送通道用它建立 WebSocket。
  // DO 不可达时服务端返回 503，调用方据此继续用轮询。
  hubTicket: () => request(`${API_BASE}/hub-ticket`, { method: 'POST' }),

  // 数据文件地址（图片预览用 <img src>、下载用 <a href>，两者都自动带同源 Cookie）
  dataUrl: (item, { download = false } = {}) =>
    `${itemPath(item)}/data${
      download ? '?download=1' : ''
    }`,
};

// 单条记录的接口路径。逐段 encodeURIComponent 而不是拼原始串：协议只禁止 hash 里出现路径
// 分隔符，`#`、`?`、`%` 都是合法字符，裸拼会把查询串或片段从那里截断。
export function itemPath(item) {
  return `${API_BASE}/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`;
}

// 会话过期时统一回登录页（保留当前位置，登录后跳回）
export function redirectToLogin() {
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  location.replace(`${PAGE_BASE}/login.html?next=${next}`);
}

export function handleAuthError(error) {
  if (error instanceof ApiError && error.status === 401) {
    redirectToLogin();
    return true;
  }
  return false;
}
