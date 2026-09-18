// `?next=` 的解析是登录页唯一的跳转来源（login.js 的两处 location.replace），判错一次即开放重定向。
// 这里只测纯函数：origin 相等语义不依赖 DOM，也不需要真起服务。
//
// 覆盖的拒绝项：`//evil.example` 与反斜杠变体 `/\evil.example`（浏览器把 `\` 视同 `/`，
// 两者都是协议相对 URL——F3 的原始缺陷就是只挡了前者）、跨源绝对 URL、非 http(s) scheme、空值。
import { describe, it, expect } from 'vitest';

// `public/ui/**` 是零构建的原生 ES 模块：不在 tsconfig 的 include 里，也没有 .d.ts，
// 于是 tsc 把这个静态 import 判成 TS7016（模块视为 any）。这是有意的取舍——
// 前端保持无构建，本模块的契约改由下面的用例逐条验证（错误路径比 any 更能说明问题）。
// 若将来 tsconfig 打开 allowJs，这行 directive 会变成「未使用」而报错，正好提示可以删掉。
// @ts-expect-error TS7016：见上
import { resolveNext } from '../public/ui/js/next-target.js';

const ORIGIN = 'https://syncclipboard.example';

describe('resolveNext', () => {
  it('站内路径原样返回（含查询与片段）', () => {
    expect(resolveNext('/ui/?x=1', ORIGIN)).toBe('/ui/?x=1');
    expect(resolveNext('/', ORIGIN)).toBe('/');
    expect(resolveNext('/ui/history?page=2#top', ORIGIN)).toBe('/ui/history?page=2#top');
  });

  it('同源绝对 URL 只取路径部分（不带 origin 漏出）', () => {
    expect(resolveNext(`${ORIGIN}/ui/?x=1`, ORIGIN)).toBe('/ui/?x=1');
  });

  it('协议相对 URL 被拒——含反斜杠变体', () => {
    expect(resolveNext('//evil.example', ORIGIN)).toBeNull();
    expect(resolveNext('/\\evil.example', ORIGIN)).toBeNull();
    expect(resolveNext('\\/evil.example', ORIGIN)).toBeNull();
  });

  it('跨源绝对 URL 被拒（含同主机不同协议）', () => {
    expect(resolveNext('https://evil.example', ORIGIN)).toBeNull();
    expect(resolveNext('http://syncclipboard.example/ui/', ORIGIN)).toBeNull();
  });

  it('非 http(s) scheme 被拒', () => {
    expect(resolveNext('javascript:alert(1)', ORIGIN)).toBeNull();
  });

  it('空值回落', () => {
    expect(resolveNext('', ORIGIN)).toBeNull();
    expect(resolveNext(null, ORIGIN)).toBeNull();
    expect(resolveNext(undefined, ORIGIN)).toBeNull();
  });
});
