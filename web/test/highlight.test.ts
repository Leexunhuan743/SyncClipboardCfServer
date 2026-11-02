// 搜索高亮的切段与摘录、整段链接识别。
import { describe, expect, it } from 'vitest';
import { excerptAround, highlightSegments } from '../src/lib/highlight';
import { singleUrl } from '../src/lib/format';

describe('highlightSegments', () => {
  it('空搜索词 / 空文本 → 单个未命中段', () => {
    expect(highlightSegments('hello', '')).toEqual([{ text: 'hello', hit: false }]);
    expect(highlightSegments('hello', '   ')).toEqual([{ text: 'hello', hit: false }]);
    expect(highlightSegments('', 'x')).toEqual([{ text: '', hit: false }]);
  });

  it('大小写不敏感，命中段保留原文的大小写', () => {
    expect(highlightSegments('Hello hello HELLO', 'hello')).toEqual([
      { text: 'Hello', hit: true },
      { text: ' ', hit: false },
      { text: 'hello', hit: true },
      { text: ' ', hit: false },
      { text: 'HELLO', hit: true },
    ]);
  });

  it('正则元字符按字面量处理（搜 "a.b" 不能当通配）', () => {
    expect(highlightSegments('a.b axb', 'a.b')).toEqual([
      { text: 'a.b', hit: true },
      { text: ' axb', hit: false },
    ]);
    expect(highlightSegments('100% (done)', '(done)').map((s) => s.hit)).toEqual([false, true]);
  });

  it('中文与 emoji 正常切分，段拼回去等于原文', () => {
    const text = '会议记录：剪贴板 😀 同步';
    const segments = highlightSegments(text, '剪贴板');
    expect(segments.filter((s) => s.hit).map((s) => s.text)).toEqual(['剪贴板']);
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('命中段数封顶，剩下的当普通文本（拼回去仍等于原文）', () => {
    const text = 'a'.repeat(100);
    const segments = highlightSegments(text, 'a', 5);
    expect(segments.filter((s) => s.hit)).toHaveLength(5);
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });
});

describe('excerptAround', () => {
  it('命中靠前：原样返回', () => {
    expect(excerptAround('hello world', 'world')).toBe('hello world');
    expect(excerptAround('abc', '')).toBe('abc');
  });
  it('命中很靠后：从命中前 lead 个字符处截取并加省略号，保证命中在可见范围内', () => {
    const text = `${'x'.repeat(300)}NEEDLE${'y'.repeat(50)}`;
    const cut = excerptAround(text, 'needle', 40);
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.indexOf('NEEDLE')).toBe(1 + 40);
  });
  it('截取起点落在代理对中间时后移一位，不留孤立代理', () => {
    // 起点 = index - lead = 61，正好是 😀（位置 60、61）的低位代理
    const cut = excerptAround(`${'x'.repeat(60)}😀${'y'.repeat(47)}NEEDLE`, 'needle', 48);
    expect(cut.startsWith(`…${'y'.repeat(47)}`)).toBe(true);
  });
  it('没有命中：原样返回', () => {
    expect(excerptAround('abc', 'zzz')).toBe('abc');
  });
});

describe('singleUrl', () => {
  it('整段就是一个 http(s) 链接才算（首尾空白忽略）', () => {
    expect(singleUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(singleUrl('  http://localhost:8787/ui/  \n')).toBe('http://localhost:8787/ui/');
  });
  it('夹在文字里的链接、多个词、其它协议、超长、空值都不算', () => {
    expect(singleUrl('看这个 https://example.com')).toBeNull();
    expect(singleUrl('https://a.com https://b.com')).toBeNull();
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://x.com', 'example.com', '', '   ']) {
      expect(singleUrl(bad), bad).toBeNull();
    }
    expect(singleUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
    expect(singleUrl(null)).toBeNull();
  });
});
