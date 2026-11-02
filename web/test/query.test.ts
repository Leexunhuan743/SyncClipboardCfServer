// API 边界的纯逻辑：归一化、查询串、路径编码、限速文案、SignalR 帧、分页窗口。
import { describe, expect, it } from 'vitest';
import { API_BASE, buildQuery, itemPath, normalizeItem, rateLimitMessage } from '../src/lib/query';
import { classifyMessage, parseFrames, RS } from '../src/lib/frames';
import { pageWindow } from '../src/lib/pagination';

describe('normalizeItem', () => {
  it('数字枚举 → 类型名；key = Type-hash；textTruncated 缺省为 false', () => {
    const item = normalizeItem({ type: 2, hash: 'ABC', size: 3 });
    expect(item).toMatchObject({ type: 'Image', key: 'Image-ABC', textTruncated: false });
    expect(normalizeItem({ type: 'File', hash: 'X', textTruncated: true })?.textTruncated).toBe(true);
  });
  it('不是对象就返回 null', () => {
    expect(normalizeItem(null)).toBeNull();
    expect(normalizeItem('x')).toBeNull();
  });
});

describe('buildQuery', () => {
  it('跳过空值、false、undefined；其余转字符串并编码', () => {
    expect(buildQuery({ a: 1, b: '', c: false, d: null, e: undefined, f: 'x y', g: true })).toBe('a=1&f=x+y&g=true');
    expect(buildQuery({ page: 0 })).toBe('page=0');
  });
});

describe('itemPath', () => {
  it('逐段编码：# ? % 都是合法 hash 字符，裸拼会从那里截断', () => {
    expect(itemPath({ type: 'Text', hash: 'a#b?c%d' })).toBe(`${API_BASE}/history/Text/a%23b%3Fc%25d`);
  });
});

describe('rateLimitMessage', () => {
  it('秒 / 分钟两档，缺省给通用文案', () => {
    expect(rateLimitMessage({ retryAfterSeconds: 30 })).toBe('尝试次数过多，请在 30 秒后重试。');
    expect(rateLimitMessage({ retryAfterSeconds: 61 })).toBe('尝试次数过多，请在约 2 分钟后重试。');
    expect(rateLimitMessage({ retryAfterSeconds: null })).toBe('尝试次数过多，请稍后再试。');
    expect(rateLimitMessage(undefined)).toBe('尝试次数过多，请稍后再试。');
  });
});

describe('SignalR 帧', () => {
  it('一个 WebSocket 帧里可有多条消息，按 RS 拆；尾部与连续分隔符不算消息', () => {
    expect(parseFrames(`{}${RS}{"type":6}${RS}`)).toEqual(['{}', '{"type":6}']);
    expect(parseFrames(`${RS}${RS}`)).toEqual([]);
  });
  it('分类：握手响应 / 广播 / 心跳 / 关闭 / 垃圾', () => {
    expect(classifyMessage('{}')).toBe('handshake');
    expect(classifyMessage('{"type":1,"target":"x","arguments":[]}')).toBe(1);
    expect(classifyMessage('{"type":6}')).toBe(6);
    expect(classifyMessage('{"type":7}')).toBe(7);
    expect(classifyMessage('not json')).toBe('unknown');
  });
});

describe('pageWindow', () => {
  it('页数少时全列出', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('页数多时保留前 3 页、后 2 页与当前页前后各一页，中间折叠', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, '…', 19, 20]);
    expect(pageWindow(10, 20)).toEqual([1, 2, 3, '…', 9, 10, 11, '…', 19, 20]);
    expect(pageWindow(20, 20)).toEqual([1, 2, 3, '…', 19, 20]);
    expect(pageWindow(2, 100)).toEqual([1, 2, 3, '…', 99, 100]);
  });
  it('被折叠的只有一页时直接显示它，不放一个什么都没说的 …', () => {
    expect(pageWindow(1, 8)).toEqual([1, 2, 3, '…', 7, 8]); // 折叠的是 4、5、6 三页：照常用 …
    expect(pageWindow(5, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 6 与 8 之间只隔一个 7：显示 7
    expect(pageWindow(6, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, '…', 11, 12]); // 3 与 5 之间只隔 4
  });
});
