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

// V2：应用本体在 `/ui/app/`，所以调用方传的 fallback 与登录页自身路径都是它。
// 本套件因此**显式传 fallback**，而不是依赖默认值 —— 默认值属于调用方的选择，
// 而这里要测的是判定逻辑本身。`LOGIN` 是登录页自己的路径：它必须被判成"回落到默认页"，
// 否则登录成功后会再次落到登录页（死循环）。
const APP = '/ui/app/';
const LOGIN = '/ui/app/login.html';

/** 与 login.js 的调用形态一致：显式传站内默认页。 */
const resolve = (raw: string | null | undefined) => resolveNext(raw, ORIGIN, APP);

describe('resolveNext', () => {
  it('站内路径原样返回（含查询与片段）', () => {
    expect(resolve('/ui/app/?x=1')).toBe('/ui/app/?x=1');
    expect(resolve('/')).toBe('/');
    expect(resolve('/ui/app/?page=2#top')).toBe('/ui/app/?page=2#top');
  });

  it('同源绝对 URL 只取路径部分（不带 origin 漏出）', () => {
    expect(resolve(`${ORIGIN}/ui/app/?x=1`)).toBe('/ui/app/?x=1');
  });

  // 这一组断言的是**安全边界**：拒绝时回落到站内默认页，而不是把外源字符串带出去。
  // 所以判据是"等于 fallback"，不是 null —— 早期版本返回 null，而调用方（登录成功后的
  // `location.replace`）拿到 null 会去 replace(null)，那是一次导航到 `null` 字符串的行为。
  // 现在直接给一个可用的站内地址，调用方不必再判空。
  it('协议相对 URL 被拒——含反斜杠变体', () => {
    expect(resolve('//evil.example')).toBe(APP);
    expect(resolve('/\\evil.example')).toBe(APP);
    expect(resolve('\\/evil.example')).toBe(APP);
  });

  it('跨源绝对 URL 被拒（含同主机不同协议）', () => {
    expect(resolve('https://evil.example')).toBe(APP);
    expect(resolve('http://syncclipboard.example/ui/app/')).toBe(APP);
  });

  it('非 http(s) scheme 被拒', () => {
    expect(resolve('javascript:alert(1)')).toBe(APP);
  });

  it('空值回落', () => {
    expect(resolve('')).toBe(APP);
    expect(resolve(null)).toBe(APP);
    expect(resolve(undefined)).toBe(APP);
  });

  it('指向登录页自身的目标回落（否则登录成功后又回到登录页，死循环）', () => {
    expect(resolve(LOGIN)).toBe(APP);
  });

  it('不传 fallback 时用内置默认值（`/ui/app/`）', () => {
    expect(resolveNext('//evil.example', ORIGIN)).toBe(APP);
    expect(resolveNext(null, ORIGIN)).toBe(APP);
  });
});
