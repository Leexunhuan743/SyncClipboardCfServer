// 与 DOM / 网络无关的纯逻辑：归一化、查询串、路径、限速文案。
// 单独成模块是为了能被 Node 下的单元测试直接覆盖（web/test/query.test.ts）——
// 「界面显示错了」常见的两个源头（归一化与查询串构造）不需要浏览器就能验证。
import { typeName } from './format';
import type { Item } from './types';

// 页面在 `/ui/`，接口在 `/ui/api/`：同一个前缀下的两个命名空间。字面量只在这里出现一次。
export const API_BASE = '/ui/api';

export function rateLimitMessage(error: { retryAfterSeconds?: number | null } | null | undefined): string {
  const seconds = error?.retryAfterSeconds ?? null;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '尝试次数过多，请稍后再试。';
  if (seconds < 60) return `尝试次数过多，请在 ${seconds} 秒后重试。`;
  return `尝试次数过多，请在约 ${Math.ceil(seconds / 60)} 分钟后重试。`;
}

export function normalizeItem(raw: unknown): Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const type = typeName(source.type);
  return {
    ...(source as unknown as Item),
    type,
    key: `${type}-${String(source.hash)}`,
    // 列表里正文被服务端截断到 500 字符：要完整内容必须先取单条，复制走截断值就是把内容砍一半
    textTruncated: source.textTruncated === true,
    // 服务端总会带 folderId；缺省按「不在任何收藏夹」处理，别让一个 undefined 流进视图
    folderId: typeof source.folderId === 'number' ? source.folderId : 0,
  };
}

export function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    query.set(key, String(value));
  }
  return query.toString();
}

export type ItemRef = Pick<Item, 'type' | 'hash'>;

/** 单条记录的接口路径。逐段 encodeURIComponent：hash 里 `#`、`?`、`%` 都合法，裸拼会从那里截断。 */
export function itemPath(item: ItemRef): string {
  return `${API_BASE}/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}`;
}

