import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Native browser modules are checked by ESLint.
import { debounce } from '../public/ui_v2/js/dom.js';
// @ts-expect-error Native browser modules are checked by ESLint.
import { api } from '../public/ui_v2/js/api.js';
// @ts-expect-error Native browser modules are checked by ESLint.
import { createOmnibox } from '../public/ui_v2/js/ui/omnibox.js';
// @ts-expect-error Native browser modules are checked by ESLint.
import { emptyStateKind, DEFAULT_FILTERS } from '../public/ui_v2/js/filters.js';
// V1（`public/ui_v1/`，默认界面）的取数封装：`api.fetchData` 是图片复制与文件下载的**唯一**路径
// （2026-09-18 之前那两处在 `main.js` 里裸用 `fetch` —— 既没有超时，也没有 401 统一处理）。
// @ts-expect-error Native browser modules are checked by ESLint.
import { api as v1api } from '../public/ui_v1/js/api.js';

describe('empty result explanations', () => {
  it('distinguishes an empty library from an empty trash', () => {
    expect(emptyStateKind(DEFAULT_FILTERS)).toBe('empty');
    expect(emptyStateKind({ ...DEFAULT_FILTERS, deleted: true })).toBe('trash');
  });
  it('does not call a filtered trash empty', () => {
    expect(emptyStateKind({ ...DEFAULT_FILTERS, deleted: true, search: 'missing' })).toBe('filter');
    expect(emptyStateKind({ ...DEFAULT_FILTERS, deleted: true, types: 'Image' })).toBe('filter');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Minimal DOM adapter for input event/timer behavior; layout is verified in a real browser.
class InputNode extends EventTarget {
  value = '';
  hidden = false;
  className = '';
  dataset = {};
  children: InputNode[] = [];
  attributes = new Map<string, string>();
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  append(child: InputNode) { this.children.push(child); }
  focus() {}
  select() {}
}

describe('search component event ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      createElement: () => new InputNode(),
      createElementNS: () => new InputNode(),
    });
    vi.stubGlobal('navigator', {platform: 'Win32'});
  });

  const input = (node: InputNode, value: string) => {
    node.value = value;
    node.dispatchEvent(new Event('input'));
  };
  const key = (node: InputNode, value: string, isComposing = false) => {
    node.dispatchEvent(Object.assign(new Event('keydown'), {key: value, isComposing}));
  };

  it('clear cannot be undone by a previously queued search', () => {
    const search = vi.fn();
    const box = createOmnibox({onSearch: search});
    input(box.input, '旧搜索');
    box.el.children.find((node: InputNode) => node.className === 'omnibox__clear').dispatchEvent(new Event('click'));
    vi.advanceTimersByTime(1000);
    expect(search.mock.calls).toEqual([['']]);
  });

  it('Enter submits once instead of submitting again after debounce', () => {
    const search = vi.fn();
    const box = createOmnibox({onSearch: search});
    input(box.input, '确定');
    key(box.input, 'Enter');
    vi.advanceTimersByTime(1000);
    expect(search.mock.calls).toEqual([['确定']]);
  });

  it('does not submit an IME draft or consume its Enter key', () => {
    const search = vi.fn();
    const box = createOmnibox({onSearch: search});
    box.input.dispatchEvent(new Event('compositionstart'));
    input(box.input, 'zhong');
    key(box.input, 'Enter', true);
    vi.advanceTimersByTime(1000);
    expect(search).not.toHaveBeenCalled();
    box.input.value = '中文';
    box.input.dispatchEvent(new Event('compositionend'));
    vi.advanceTimersByTime(240);
    expect(search.mock.calls).toEqual([['中文']]);
  });

  it('a background refresh preserves an uncommitted draft', () => {
    const search = vi.fn();
    const box = createOmnibox({onSearch: search});
    box.setValue('原条件');
    input(box.input, '新草稿');
    box.setValue('原条件');
    expect(box.input.value).toBe('新草稿');
    vi.advanceTimersByTime(240);
    expect(search).toHaveBeenCalledWith('新草稿');
  });

  it('reset or browser navigation cancels a draft even if the committed value is unchanged', () => {
    const search = vi.fn();
    const box = createOmnibox({onSearch: search});
    input(box.input, '草稿');
    box.setValue('', {force: true});
    vi.advanceTimersByTime(1000);
    expect(box.input.value).toBe('');
    expect(search).not.toHaveBeenCalled();
  });
});

describe('delayed input commits', () => {
  it('only commits the latest draft', () => {
    vi.useFakeTimers();
    const search = vi.fn();
    const commit = debounce(search, 240);
    commit('旧搜索');
    vi.advanceTimersByTime(120);
    commit('新搜索');
    vi.advanceTimersByTime(240);
    expect(search.mock.calls).toEqual([['新搜索']]);
  });

  it('clearing or submitting immediately cancels the queued draft', () => {
    vi.useFakeTimers();
    const search = vi.fn();
    const commit = debounce(search, 240);
    commit('不应重新出现');
    commit.cancel();
    search('');
    vi.advanceTimersByTime(1000);
    expect(search.mock.calls).toEqual([['']]);
  });

  it('accepts new input after cancelling a composition or navigation', () => {
    vi.useFakeTimers();
    const search = vi.fn();
    const commit = debounce(search, 240);
    commit('zhong');
    commit.cancel();
    commit('中文');
    vi.advanceTimersByTime(240);
    expect(search.mock.calls).toEqual([['中文']]);
  });
});

describe('UI network recovery and full text', () => {
  it('requests trash counts for the trash view instead of relabelling active counts', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetch);
    await api.overview(undefined, { deleted: true });
    expect(new URL(fetch.mock.calls[0]?.[0], 'http://localhost').searchParams.get('deleted')).toBe('true');
  });
  it('loads text attachments from the data endpoint, preserving Unicode and newlines', async () => {
    const text = '完整正文\n中文🙂\n'.repeat(150);
    const fetch = vi.fn().mockResolvedValue(new Response(text));
    vi.stubGlobal('fetch', fetch);
    expect(await api.textData({ type: 'Text', hash: 'ABC' })).toBe(text);
    expect(fetch.mock.calls[0]?.[0]).toContain('/Text/ABC/data');
  });

  it('rejects oversized streamed text even when content-length is missing', async () => {
    const response = new Response(new Uint8Array(8 * 1024 * 1024 + 1));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(api.textData({ type: 'Text', hash: 'ABC' })).rejects.toMatchObject({status: 413});
  });

  it('does not treat an HTML error page with a success status as valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy</html>')));
    await expect(api.session()).rejects.toMatchObject({status: 502});
  });

  it('terminates a stalled request instead of leaving controls busy indefinitely', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    })));
    const request = expect(api.session()).rejects.toThrow('请求超时');
    await vi.advanceTimersByTimeAsync(20_000);
    await request;
  });

  it('preserves cancellation of stale list requests', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    })));
    const controller = new AbortController();
    const request = expect(api.list({}, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    controller.abort();
    await request;
  });

  // 429 的"还要等多久"来自 `Retry-After` 头。这里守的是**接线**：
  // `messages.js` 那侧的精细文案读 `error.retryAfterSeconds`，只测消息侧会让两边各自"正确"
  // 却永远接不上（此前 `ApiError` 根本不带这个字段，那两条文案就是死分支）。
  it('carries Retry-After into retryAfterSeconds so 429 messages can say how long to wait', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '45' } }),
    ));
    await expect(api.session()).rejects.toMatchObject({ status: 429, retryAfterSeconds: 45 });
  });

  it('leaves retryAfterSeconds null when Retry-After is absent or not a positive number', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Too Many Requests', { status: 429 })));
    await expect(api.session()).rejects.toMatchObject({ status: 429, retryAfterSeconds: null });
    // 非法值（HTTP-date 或 0）同样归一为 null —— 界面要显示的是秒数，不能显示 NaN
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Too Many Requests', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
    ));
    await expect(api.session()).rejects.toMatchObject({ status: 429, retryAfterSeconds: null });
  });
});

// `api.fetchData`（V1）是**数据文件**唯一的取回路径：图片复制与文件下载都走它。
// 这两件事此前在这条路径上同时缺失，且都不会报错、只表现为"界面卡住/报错看不懂"：
//   ① 没有超时 —— 连接半开（响应头到了、body 永远不来）时 fetch 永不 settle，调用方的
//      `setPending` 永远清不掉，那个按钮就一直转圈（且 `data-loading` 的
//      `pointer-events: none` 让人点不动它）；
//   ② 没有 401 处理 —— 会话过期时不回登录页，只报一句「读取图片失败」。
// 同时守 `payload` 的透传：界面用它区分"对象确实不在了"（终态、不给重试）
// 与"这次读取失败了"（可重试）—— 只看状态码时 404 同时表示这两种情况。
describe('V1 · 数据文件的取回（api.fetchData）：超时与结构化错误体都不能丢', () => {
  const item = { type: 'Image', hash: 'AB12' };

  it('连接半开时按 30 秒中止，而不是让调用方永远等', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    })));
    const request = expect(v1api.fetchData(item)).rejects.toThrow('请求超时');
    await vi.advanceTimersByTimeAsync(30_000);
    await request;
  });

  it('非 2xx：错误体带进 error.payload，界面据此区分"数据没了"与"这次失败"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Response.json({ error: 'data_missing' }, { status: 404 }),
    ));
    await expect(v1api.fetchData(item)).rejects.toMatchObject({
      status: 404,
      payload: { error: 'data_missing' },
    });
  });

  it('成功时返回 Blob，且地址仍由 api.dataUrl 一处构造（路径逐段编码）', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetch);
    const blob = await v1api.fetchData({ type: 'Image', hash: 'A/B#C' });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
    expect(fetch.mock.calls[0]?.[0]).toBe('/ui/api/history/Image/A%2FB%23C/data');
  });
});
