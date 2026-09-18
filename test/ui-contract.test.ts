// 前端（零构建的原生 ES 模块）的跨文件契约守卫。
// 扫描目标是 **V2**（`public/ui/**`）—— 见下面 `PAGES` 的构造：只列了 `public/ui/app/` 的两个页面。
//
// ⚠️ V1（`public/ui_old/**`）从 **2026-09-17 起重新纳入维护**（此前是冻结存档），
// 但它的契约守卫**不在这个文件**，而在 `test/ui-guard.test.ts`：接口前缀只有一处字面量、
// 两页的提示条键名一致、页面引用的本地资源都存在（死引用 = 一次 404）、文案表与 V2 共用同一份、
// 令牌不空转、可点控件的按下反馈清单。这条分工是刻意的 —— 本文件按页解析 import 闭包与
// modulepreload 清单，而 V1 的页面/资源清单在 `ui-guard` 里已经逐条核对过了。
// （这句话在 2026-09-18 之前写的是"V1 已冻结，不再受本套件约束"，那已经与事实不符。）
//
// 零构建的前端没有编译器帮忙，而它的三类契约都**只存在于两处文本之间**，任何一处改了另一处
// 不会报错——只会静默失效。这个套件把那三类契约变成可复跑的检查：
//
//   1. **每页的 modulepreload 清单 == 该页入口的 import 闭包**（去掉入口自身）。
//      多一个 = 白拉一个文件，少一个 = 留下一段依赖瀑布（实测三层：main → 组件 → icons/format）。
//   2. **BEM 类名双向契约**（按页）：
//      正向——JS/HTML 用到的类必须在**该页加载的样式表**里有定义。
//        真实缺陷：`.auth__note` 定义在只被 login.html 加载的 auth.css 里，而列表页的
//        「部署信息」对话框用了它 → 那段说明在列表页完全没有样式（实测 font-size 14px、padding 0）。
//      反向——CSS 里定义但全站无人使用的类就是死规则。
//        真实缺陷：`.btn--icon`、`.cell-content__name`、`.missing`、`.brand__mark`（已删）。
//   3. **CSS 消费的属性必须有生产者**：每个 `[data-*]` / `[aria-*]` 属性选择器都要能在 JS 或 HTML
//      里找到写它的地方。真实缺陷：`.star-btn[data-pop="true"]` 的动画规则一直在，而没有任何代码
//      写 `data-pop` —— 星标弹出动画从未播放、长期无人发现（同类还有排序指示器）。
//
// 判据一律用**形态**（类名/属性名/import 语句），且先剥注释——本仓库的文档守卫在「检查器把
// 自己算进去」「判据写在注释里被自己命中」这两种坑上真实翻过车（见 test/docs.test.ts 开头的警告）。
// 这里额外补一条「检查器对自己不命中」的断言，以及一条「抽取器确实在工作」的下限断言
// （一个恒空的集合会让方向正确的检查永远通过——那是空转，不是通过）。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
// @ts-expect-error TS7016：`public/ui_old/**` 是零构建的原生 ES 模块，不在 tsconfig 的 include 里（同 clipboard.test.ts）
import { createLatestGate } from '../public/ui/js/latest.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function listFiles(relative: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(ext)) out.push(path);
    }
  };
  walk(relative, '');
  return out.sort();
}

// 剥注释：块注释全剥；行注释只剥「行首或空白后的 `//`」——不能裸替 `//`，
// 否则 `'http://www.w3.org/2000/svg'`（dom.js）这类字符串会被截断。
//
// ⚠️ 2026-09-15 修掉一个**真缺陷**（V2 落地时暴露）：原先的块注释判据是
// `/\/\*[\s\S]*?\*\//g`，即「任何位置的一对 `/*` … `*/`」。而注释里出现**通配写法**
// （`/ui/*`、`public/ui/js/*.js` —— 这个仓库的注释里到处都是）时，那个 `/` 后面的 `*`
// 会被当成块注释的开始，于是它到**下一个** `*/` 之间的全部内容被删掉。
// 后果不是"少剥了一段注释"，而是把**整整一屏的正代码吃掉**：`boot.js` 的 import 全段
// 落在那个区间里，`importClosure` 于是只读到入口自己（1 个模块），
// 「modulepreload == import 闭包」这条断言把 24 条正确清单报成多余。
//
// 修法：块注释的 `/*` 只认**行首**（允许前导空白）。这不是权宜之计 ——
// 合法 JS 里块注释确实几乎总在行首或行尾独立成段，而"文本中间的 `/*`"在注释里
// 恰恰就是通配写法。判据因此从「形状」收紧成「位置」，误判面从"注释内容"缩到"无"。
function stripComments(source: string): string {
  return source
    .replace(/(^|\n)([ \t]*)\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// ===== 模块图 =====
// 扫描目标 = **当前实际发布的那一份界面**。
// 2026-09-15 的 V1→V2 交接：V1 冻结存档到 `public/ui_old/`（挂载点 `/ui_old/`，见该目录的
// README.md），V2 落在 `public/ui/`。本套件现在守 V2 —— 存档目录**不再受约束**（它是冻结的，
// 对它报死规则只会逼人动一份刻意不动的代码）。
//
// V2 的布局与 V1 有两处不同，读下面的常量时要记得：
//   · 两页在 `public/ui/app/` 下（`/ui/` 这个路径留给目录索引，应用本体在 `/ui/app/`）；
//   · 资源（`css/`、`js/`）在 `public/ui/` 下，两页共享。
const JS_FILES = listFiles('public/ui/js', '.js');
const CSS_FILES = listFiles('public/ui/css', '.css');

const IMPORT_RE = /import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

/** 该模块直接 import 的本地模块（相对路径归一化到仓库相对路径）。 */
function importsOf(file: string): string[] {
  const source = stripComments(read(file));
  const dir = file.slice(0, file.lastIndexOf('/'));
  return [...source.matchAll(IMPORT_RE)]
    .map((match) => match[1]!)
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => normalize(`${dir}/${spec}`));
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** 从入口出发的 import 闭包（含入口自身）。 */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...importsOf(file));
  }
  return [...seen].sort();
}

function urlOf(file: string): string {
  return `/${file.replace(/^public\//, '')}`;
}

function fileOf(url: string): string {
  return `public${url}`;
}

type Page = {
  name: string;
  html: string;
  entry: string;
  styles: string[];
  preload: string[];
  modules: string[];
};

const PAGES: Page[] = ['public/ui/app/index.html', 'public/ui/app/login.html'].map((html) => {
  const source = read(html);
  const attr = (rel: string): string[] =>
    [...source.matchAll(new RegExp(`<link[^>]+rel="${rel}"[^>]+href="([^"]+)"`, 'g'))].map(
      (match) => match[1]!,
    );
  const entryUrl = source.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)![1]!;
  const entry = fileOf(entryUrl);
  return {
    name: html,
    html,
    entry,
    styles: attr('stylesheet').map(fileOf),
    preload: attr('modulepreload'),
    modules: importClosure(entry),
  };
});

// ===== 类名与属性名抽取 =====
// BEM 形态（`block__element` / `block--modifier`）——刻意只认这一形态：
// 单段工具类（`.skip`、`.sr-only`、`.mono`）与浏览器/框架自带的词不会混进来，误报为零。
const BEM_TOKEN_RE = /[a-z][a-z0-9]*(?:__|--)[a-z0-9-]+/g;

function bemTokens(source: string): Set<string> {
  return new Set(stripComments(source).match(BEM_TOKEN_RE) ?? []);
}

/** JS 里写出的 data-* 属性名：`dataset.foo` / `dataset: { foo: … }` / `setAttribute('data-foo')`。 */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function normalizeJs(source: string): string {
  return stripComments(source)
    .replace(/\.dataset\.([A-Za-z0-9_]+)/g, (_, key: string) => `data-${kebab(key)}`)
    .replace(/dataset:\s*\{([^}]*)\}/g, (whole, body: string) => {
      const keys = [...body.matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((m) => `data-${kebab(m[1]!)}`);
      return `${whole} ${keys.join(' ')}`;
    })
    .replace(/setAttribute\(\s*'([^']+)'/g, (whole, name: string) => `${whole} ${name}`);
}

const JS_SOURCES = new Map(JS_FILES.map((file) => [file, normalizeJs(read(file))] as const));
const HTML_SOURCES = new Map(
  PAGES.map((page) => [page.html, stripComments(read(page.html))] as const),
);
// base-v2.css 在每页都加载，其中的工具类不进 BEM 检查（见上面的形态说明），但 tokens.css 里的
// 自定义属性名、其它层的类名都会被抽到——这正是想要的范围。
const CSS_TOKENS = new Map(CSS_FILES.map((file) => [file, bemTokens(read(file))] as const));

/** CSS 里消费的 data- 与 aria- 属性名。 */
const CSS_ATTRS = new Set(
  CSS_FILES.flatMap((file) => [
    ...stripComments(read(file)).matchAll(/\[((?:data|aria)-[a-z-]+)/g),
  ]).map((match) => match[1]!),
);

/** 某个模块源码里被用到的 BEM 类名。 */
function usedTokens(file: string): string[] {
  return [...(JS_SOURCES.get(file) ?? '').matchAll(BEM_TOKEN_RE)].map((match) => match[0]);
}

/** 某页 HTML 里被用到的 BEM 类名。 */
function usedTokensInHtml(file: string): string[] {
  return [...(HTML_SOURCES.get(file) ?? '').matchAll(BEM_TOKEN_RE)].map((match) => match[0]);
}

const PRODUCER_TEXT = [...JS_SOURCES.values(), ...HTML_SOURCES.values()].join('\n');

describe('public/ui 的模块图契约', () => {
  it('每页的 modulepreload 清单 == 该页入口的 import 闭包（去掉入口自身）', () => {
    for (const page of PAGES) {
      const required = page.modules.filter((file) => file !== page.entry);
      expect(page.preload.map(fileOf).sort(), `${page.name} 的 modulepreload 清单`).toEqual(required);
    }
  });

  it('抽取器确实在工作（空集不算通过）', () => {
    for (const page of PAGES) {
      expect(page.modules.length, `${page.name} 的闭包`).toBeGreaterThan(3);
      expect(page.preload.length, `${page.name} 的预载清单`).toBeGreaterThan(2);
      expect(page.styles.length, `${page.name} 的样式表`).toBeGreaterThan(2);
    }
  });

  it('检查器对自己不命中：被扫描的集合里没有 test/** 的文件', () => {
    expect([...JS_FILES, ...CSS_FILES].some((file) => file.includes('test/'))).toBe(false);
    expect(importClosure('public/ui/js/boot.js').some((file) => file.includes('test/'))).toBe(false);
  });
});

describe('public/ui 的类名双向契约', () => {
  it('JS/HTML 用到的类必须在**该页加载的样式表**里有定义', () => {
    for (const page of PAGES) {
      const defined = new Set(page.styles.flatMap((file) => [...(CSS_TOKENS.get(file) ?? [])]));
      const used = new Set([
        ...page.modules.flatMap(usedTokens),
        ...usedTokensInHtml(page.html),
      ]);
      const missing = [...used].filter((token) => !defined.has(token)).sort();
      expect(missing, `${page.name} 用到但该页样式表里没有的类`).toEqual([]);
    }
  });

  it('CSS 里定义但全站无人使用的类（死规则）必须为零', () => {
    const used = new Set(
      PAGES.flatMap((page) => [...page.modules.flatMap(usedTokens), ...usedTokensInHtml(page.html)]),
    );
    const dead: string[] = [];
    for (const [file, tokens] of CSS_TOKENS) {
      for (const token of tokens) if (!used.has(token)) dead.push(`${file}: .${token}`);
    }
    expect(dead.sort(), '定义了但没人用的类').toEqual([]);
  });
});

// 性能约定：**列表刷新路径不得使用同文档视图过渡**（`document.startViewTransition`）。
// 依据是一次实测（6× CPU 降速、3 次取中位）：一次「什么都没变」的切换，仅过渡本身就要 ~60ms 主线程
// ——它要对整个结果区做布局/样式快照，成本随页大小上升，而列表现在是一帧落地，没有「换面」需要掩饰。
// 跨文档过渡（登录页 → 列表页）由 `motion.css` 的 `@view-transition { navigation: auto }` 声明，
// 不在这条判据里。判据用形态（是否出现该 API）且先剥注释：注释里的引用不算违规。
describe('public/ui 的性能约定', () => {
  it('列表路径不得引入同文档视图过渡（实测成本 ~60ms/次，见 docs/ui.md 的性能预算）', () => {
    const offenders = [...JS_SOURCES].filter(([, source]) => /startViewTransition/.test(source)).map(([file]) => file);
    expect(offenders, `这些模块用了 document.startViewTransition：${offenders.join(', ')}`).toEqual([]);
  });
});

describe('public/ui 的属性契约', () => {
  it('CSS 消费的 data-*/aria-* 都要有生产者（JS 或 HTML）', () => {
    expect(CSS_ATTRS.size, '抽取到的属性选择器数量').toBeGreaterThan(3);
    const missing = [...CSS_ATTRS].filter((name) => !PRODUCER_TEXT.includes(name)).sort();
    expect(missing, 'CSS 在等一个从来没人写的属性').toEqual([]);
  });
});

describe('public/ui 的模块必须能被浏览器直接解析', () => {
  // 零构建的前端由浏览器直接加载 `.js`：**任何** TypeScript 专属语法（`: void`、`as X`、泛型参数…）
  // 都是 SyntaxError，整个模块图随之解析失败，页面停在骨架屏——而 `tsc --noEmit` 不解析这些文件
  // （它们不在 include 里），本套件自己的正则扫描也看不出来。本轮真写进去过一次（`(): void =>`），
  // 表现是 `booted: null` + 骨架屏常驻 + 无任何报错记录。故这里用 **Node 自己的 ESM 解析器**
  // 过一遍（子进程，不经 Vite/esbuild 转换——被转换过就失去意义了）；只把 SyntaxError 当失败，
  // 顶层访问 DOM 抛的 ReferenceError 属预期（这些模块本来就只跑在浏览器里）。
  it('Node 的 ESM 解析器能逐个解析（不经打包器转换）', async () => {
    const urls = JS_FILES.map((file) => pathToFileURL(join(ROOT, file)).href);
    // 子进程里必须用**动态** import：这里要的正是「原生解析器怎么看这个文件」，
    // 静态 import 会被 Vite/esbuild 先转换一遍（TS 语法在转换期被吃掉，检查就没有意义了）。
    const script = [
      `const files = ${JSON.stringify(urls)};`,
      'const bad = [];',
      'for (const file of files) {',
      '  try { await import(file); } catch (error) {',
      "    if (error instanceof SyntaxError) bad.push(file.split('/ui/js/')[1] + ' → ' + error.message);",
      '  }',
      '}',
      'console.log(JSON.stringify(bad));',
    ].join('\n');
    const { stdout } = await execFile(process.execPath, ['--input-type=module', '-e', script]);
    expect(JSON.parse(stdout.trim()), '被解析器拒绝的模块').toEqual([]);
  });
});

// A1 的竞态守卫是纯逻辑，可以直接测；它在 main.js 里的接线（refresh/refreshStats/pollOnce）
// 由浏览器侧验证，这里钉住的是「哪些结果应该被丢弃」这条判据本身。
describe('createLatestGate（最新请求胜出）', () => {
  it('begin() 让上一个 ticket 失效，并 abort 掉它的 signal', () => {
    const gate = createLatestGate();
    const first = gate.begin();
    expect(gate.isCurrent(first)).toBe(true);
    expect(first.signal.aborted).toBe(false);

    const second = gate.begin();
    expect(first.signal.aborted).toBe(true);
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('乱序完成时只有最新那次的结果能落地', async () => {
    const gate = createLatestGate();
    const applied: string[] = [];
    const staleLanding = Promise.withResolvers<void>();
    const freshLanding = Promise.withResolvers<void>();

    // 两次「请求」各自持有一个 ticket，落地顺序由测试显式控制（不用真实计时器：
    // 用 sleep 表达顺序既慢又会掩盖竞态）。
    const request = async (label: string, landing: Promise<void>): Promise<void> => {
      const ticket = gate.begin();
      await landing;
      if (!gate.isCurrent(ticket)) return; // 与 main.js 里的判据同一形态
      applied.push(label);
    };

    const stale = request('旧筛选的响应', staleLanding.promise);
    await Promise.resolve(); // 让 stale 先把 ticket 拿到手
    const fresh = request('新筛选的响应', freshLanding.promise);

    freshLanding.resolve(); // 新的先到
    await fresh;
    staleLanding.resolve(); // 旧的迟到：必须被丢弃
    await stale;

    expect(applied).toEqual(['新筛选的响应']);
  });
});
