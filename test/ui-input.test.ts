import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Native browser modules are checked by ESLint.
import { debounce } from '../public/ui/js/dom.js';
// @ts-expect-error Native browser modules are checked by ESLint.
import { api } from '../public/ui/js/api.js';
// @ts-expect-error Native browser modules are checked by ESLint.
import { createOmnibox } from '../public/ui/js/ui/omnibox.js';

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
});
