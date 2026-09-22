// 文档口径守卫：文档里「N 个套件」「N 个资源」这类**可从仓库直接数出来**的数字，
// 必须与实际一致。
//
// ⚠️ 写这一类「读仓库文本 / 统计仓库」的检查前，先问一句：**它会不会把检查器自己算进去？**
// 本轮这个坑以三种形态出现过，都不是理论：
//   1. 检测写库套件时用 `includes('assertWritableTarget')`，而本文件注释里就有这个名字
//      → 文档守卫自己被算成「写库套件」（已改为判据「名字紧跟左括号」）。
//   2. 加了这个守卫文件本身，套件数从 9 变 10，而四处文档还写着 9
//      （守卫第一次运行就红了——这是它该有的行为；按实际改成 10，而不是把它排除在外）。
//   3. 代码规模的快照写进 docs/progress.md 会改变「文档行数」这个被统计量本身
//      （先用占位数字跑一次拿到终值再回填，且显式标注为**带日期的快照**、不做等值断言）。
//   4. 把判据从「字面量」收紧成「调用形态」之后**仍然自命中**：先是本文件的注释里写了一句示例
//      调用（散文含被判定的形状），剥掉注释后，字符串夹具里那句示例调用又命中了。
//      对策（收敛点）：① 判据用**语义**而非形状——「是否 import 了被检查的模块」是检查器自己
//      不具备的性质，无法自命中；② 检查器里**不放内联正例夹具**（演示判据能命中的字符串本身
//      就会命中它，这是同一坑的第五种面孔），正例交给真实文件，命中为零时下游用例直接红；
//      ③ 每加一条这类检查，都补一条「检查器对自己不命中」的断言。
// 共同对策：判据用**形态**（调用/结构）且**先剥注释**；被统计量若包含记录载体，就先写占位
// 再回填，并把数字标注为快照而非实时值；每加一条这类检查，都补一条「检查器对自己不命中」的断言。
//
// 为什么值得一条测试：这类数字的漂移在本仓库真实发生过三次（README 两处、CI 工作流注释一处），
// 而它们的共同点是「只有人去数才会发现」。凡是能从文件系统推导出来的口径，就不该靠人记。
//
// 只检查**可推导**的量：
//   - 套件数 = test/*.test.ts 的数量
//   - 前端资源数 = public/ 下的文件数
// 用例数不可推导（要跑一遍才知道），故不在此校验——由 CI 的实际输出与其记录者负责。
//
// 第二个 describe 做**代码规模统计**（业务 / 测试 / 文档行数）：把数字算出来打印到测试输出
// （CI 日志里可读），并要求 docs/progress.md 保有对应记录节。数字本身不做等值断言——
// 行数每改一行就变，固化成断言只会让每次改动都被迫同步文档。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function countFiles(dir: string, predicate: (name: string) => boolean, recursive = false): number {
  let total = 0;
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (recursive) total += countFiles(join(dir, entry.name), predicate, true);
    } else if (predicate(entry.name)) {
      total += 1;
    }
  }
  return total;
}

// 提取**总数**声明：「全部 N 个套件」「N 个套件」「N 套件」。
//
// 这条正则天然区分总数与子集，靠的是**相邻性**：数字后面只允许跟一个「个」，紧跟「套件」。
// 于是「6 个黑盒套件」「7 个写库套件」这类子集声明不匹配（限定词夹在中间），
// 不会拿子集的 7 去和总数 10 比——那会造出假红。**不要**为了「多覆盖」而放宽它。
// 中文数字（六个/七个）同样不匹配：现状文档的总数一律写阿拉伯数字，子集可以写中文数字。
function suiteClaims(text: string): number[] {
  return [...text.matchAll(/(?:全部\s*)?(\d+)\s*个?套件/g)].map((m) => Number(m[1]));
}

function assetClaims(text: string): number[] {
  return [...text.matchAll(/共\s*(\d+)\s*个资源/g)].map((m) => Number(m[1]));
}

const SUITES = countFiles('test', (name) => name.endsWith('.test.ts'));
const SUITE_NAMES = readdirSync(join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => name.replace(/\.test\.ts$/, ''));
const ASSETS = countFiles('public', () => true, true);

// 扫描名单 = **描述当前状态**的文档与配置。两条边界是刻意的：
//   1. 不含 `docs/progress.md`：它按轮次记录，里面全是**历史快照**（第 12 轮写「6 套件」、
//      第 14 轮写「7 套件」……），守卫无从区分「历史」与「现状」，加进来必然红。
//      那些带日期的数字正是版本曲线可读的原因，不该被抹平。
//   2. 不校验**用例数**：它不能从文件系统推导（要跑一遍才知道），解析 `it(` 计数又会被
//      参数化/条件用例带偏——守出一道假警报比不守更糟。故现状文档一律只写套件数，
//      用例数交给 `npm test` 自己的输出（历史快照里保留）。
//   3. **含根目录 `AGENTS.md`**（2026-09-18 加入）：它是给代理/新人的行为契约，只描述现状
//      （不像 progress.md 混着历史），而且它自己那条「改代码顺手维护文档」正要求人同步这些数字。
//      把它纳入守卫，等于让"它写下的套件数"自动被盯住——契约自己遵守契约，不靠自觉。
const CURRENT_STATE_FILES = [
  'README.md',
  'AGENTS.md',
  'docs/design.md',
  'docs/ui.md',
  '.github/workflows/deploy.yml',
];

describe('文档口径与仓库实际一致', () => {
  it('描述当前状态的文档与 CI 里的「套件数」与实际一致', () => {
    const suites = SUITES;
    expect(suites, '测试套件数不应为 0（守卫自身失效）').toBeGreaterThan(0);

    for (const file of CURRENT_STATE_FILES) {
      if (!existsSync(join(ROOT, file))) continue;
      const claims = suiteClaims(read(file));
      expect(claims.length, `${file} 未声明套件数？`).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim, `${file} 写「${claim} 个套件」，实际是 ${suites} 个（test/*.test.ts）`).toBe(suites);
      }
    }
  });

  // `public/` 下现在有四部分（2026-09-19 改名后）：V1（`public/ui_v1/`，默认界面）、
  // V2（`public/ui_v2/`，开发测试版）、`/ui/` 的跳转壳（`public/ui/`，只有 index.html 与
  // 它的 fragment 中继脚本）、站点根的两个文件。docs/ui.md 的「共 N 个资源」声明的是**这个总数** ——
  // 判据不变（数字必须能从文件系统数出来），分母的含义随三次结构调整（V1→V2→V1→三挂载点）变过三次。
  it('docs/ui.md 里声明的资源数与 public/ 下实际文件数一致', () => {
    const claims = assetClaims(read('docs/ui.md'));
    expect(claims.length, 'docs/ui.md 未声明资源数').toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim, `docs/ui.md 写「${claim} 个资源」，实际是 ${ASSETS} 个（public/ 下全部文件）`).toBe(ASSETS);
    }
  });

  // 「= N 套件」是**数字**，套件清单是**名单**：只校验数字会让两者脱节（真的发生过——清单少一个、
  // 数字却改了，守卫全绿）。这里做**正向**校验：每个实际套件都必须在 design.md 的清单段里出现。
  // 反向（清单里留着已删的套件名）不做：那段的反引号 token 混着 `/ui/api/*`、`node:sqlite` 这类
  // 非套件名，反向匹配要么误报、要么得维护例外表——而这正是本文件反复踩过的「判据越写越脆」。
  it('docs/design.md 的套件清单逐个覆盖实际套件（名单与数字不分家）', () => {
    const text = read('docs/design.md');
    const anchor = text.indexOf('**套件清单**');
    expect(anchor, 'docs/design.md 未找到「套件清单」段').toBeGreaterThan(-1);
    // 段落切到**第一个空行**为止。注意必须用 `\r?\n\s*\r?\n` 而不是 `'\n\n'`：
    // 仓库的文件是 CRLF，`'\n\n'` 永远匹配不到，`slice(anchor, -1)` 会一路切到文件末尾——
    // 那样「名单里有没有这个名字」就变成「全文里有没有」，检查从此没有判别力（变异实验实测过）。
    const rest = text.slice(anchor);
    const end = rest.search(/\r?\n\s*\r?\n/);
    const paragraph = end < 0 ? rest : rest.slice(0, end);
    const listed = [...paragraph.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const missing = SUITE_NAMES.filter((name) => !listed.includes(name));
    expect(missing, `design.md 套件清单缺少：${missing.join(' / ')}`).toEqual([]);
  });

  // 2026-09-22（`progress.md` §151）：目录拆成独立的 `docs/progress-index.md`。
  // 它必须与正文**逐条逐字一致** —— 目录是**能从文件系统推导**的口径（`progress.md` 的 `##` 标题），
  // 按本文件开头的判据（"凡能从文件系统推导出来的口径，就不该靠人记"）它就该被守着。
  // 此前内嵌目录停在 §102 而正文已到 §150，两次都只在 `progress.md` 里记一句"留待单独一轮"。
  // 判据是**列表的每一行**（`- 编号. 标题`）与正文标题逐条相等：数量与文本一起比，
  // 少了/多了/改了标题都会红。`目录` 那一节自身不进目录（否则目录会列出自己）。
  it('docs/progress-index.md 覆盖 progress.md 的全部小节（编号与标题逐字一致）', () => {
    const heads = [...read('docs/progress.md').matchAll(/^## (.+)$/gm)]
      .map((m) => m[1]!.trim())
      .filter((heading) => heading !== '目录');
    expect(heads.length, '正文小节数不该为 0（守卫可能失效）').toBeGreaterThan(0);
    const listed = [...read('docs/progress-index.md').matchAll(/^- (.+)$/gm)].map((m) => m[1]!.trim());
    expect(
      listed,
      'docs/progress-index.md 与 progress.md 的 `##` 标题不一致（新增/改动小节后重跑目录：见 progress.md §151）',
    ).toEqual(heads);
  });
});

// ===== 代码规模统计 =====
//
// 口径（与 docs/progress.md §1.1 的记录一致）：
//   业务代码 = src/**/*.ts
//   测试代码 = test/**/*.{ts,mjs}（含 support/ 与一次性脚本）
//   文档     = README.md + AGENTS.md + docs/*.md（根目录那两份"给人/代理读的入口"都算）
// 只统计行数，不区分空行/注释——「有效代码行」需要语言级解析，而这一层的用途是**规模量级**
// 与增长趋势，精确到行反而制造无谓争议。

interface SizeStat {
  label: string;
  files: number;
  lines: number;
}

function collectFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectFiles(relative, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(relative);
  }
  return out;
}

// 行数口径与 `wc -l` 一致：数换行符，**不把结尾换行额外计一行**。
// （`split('\n').length` 会为每个文件的尾换行多算 1 行，40 个文件就虚增 40 行。）
function countLines(text: string): number {
  const breaks = text.match(/\n/g)?.length ?? 0;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

function measure(label: string, files: string[]): SizeStat {
  let lines = 0;
  for (const file of files) lines += countLines(readFileSync(join(ROOT, file), 'utf8'));
  return { label, files: files.length, lines };
}

// 子集清单用**名字集合**校验，不碰数字：这类清单此前写成「六个」而漏了 `ui`，
// 任何数字式样（阿拉伯或中文）都可能绕过计数守卫，而成员比对绕开数字直接比集合。
const WRITE_GUARD_ANCHOR = '**写库套件默认只允许指向本机**';

// 剥注释：**先剥行注释，再剥块注释**。顺序不能反——行注释里会出现 `/*`（本仓库第一行就写着
// `/ui/api/*`），先剥块注释会让它一路吃到后面任意一个 `*/`（例如测试名里的 `bytes */size`），
// 把中间整段真实代码一起吞掉：实测 `test/ui.test.ts` 的 `import ... from './support/target-guard'`
// 因此被判为「不存在」，写库套件清单随之少一项。
function stripComments(source: string): string {
  return source.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

// 写库套件的判据：**导入**了目标守卫模块（相对路径形式，与本仓库既有写法一致）
const SUITE_IMPORT = /from\s+'\.\/support\/target-guard'/;

function writeGuardedSuites(): string[] {
  return readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    // 判据用**语义**而不是形状：写库套件 = 导入了 target-guard 的文件。
    // 理由（踩了三次才收敛）：形状判据一直在换皮自命中——先是「文件里出现这个名字」（注释命中），
    // 再是「调用形态 + 剥注释」（本文件的字符串夹具命中）。而「是否 import 了守卫模块」这件事，
    // 检查器自己不具备（它只读文件不导入），无法自命中，且语义上正是「用了守卫」的定义。
    .filter((name) => SUITE_IMPORT.test(stripComments(read(`test/${name}`))))
    .map((name) => name.replace(/\.test\.ts$/, ''));
}

describe('口径守卫自身的判据', () => {
  it('套件数提取只认**总数**声明，子集与中文数字不命中（夹具即约定）', () => {
    // 正例：总数声明
    for (const text of ['全部 10 个套件', 'npm test = 10 套件', '10 个套件']) {
      expect(suiteClaims(text), `应识别为总数：${text}`).toEqual([10]);
    }
    // 反例：子集声明（限定词夹在数字与「套件」之间）与中文数字——都不该被当成总数
    for (const text of ['6 个黑盒套件', '7 个写库套件', '七个写库套件', '六个写库套件', '中文十套件']) {
      expect(suiteClaims(text), `不应识别为总数：${text}`).toEqual([]);
    }
    // 已知边界，写在这里以免被当成缺陷：限定词在**数字之前**的写法（「其中 7 个套件会写库」）
    // 会被当作总数；故现状文档里子集一律写成「N 个<限定词>套件」。
  });

  // 注意这里**不放正例夹具**：任何「演示判据能命中」的字符串本身就会命中判据（实测踩到，
  // 这正是自指的第四种面孔）。正例由真实文件提供——下面那条「清单 == 实际集合」的用例，
  // 在判据命中为零时会直接红。
  //
  // **这条断言是承重的，不是装饰**：判据（导入形态）唯一残留的脆弱点是「检查器里出现该导入的
  // 字面量」——夹具、注释里的示例、抄一行真实导入，都会让它成立。断言正是盯着这一点：
  // 谁要是加了那样的字符串，它会立刻红，而不是静默污染下面那条清单比对。别删。
  it('写库套件判据不会命中检查器自己（每加一条这类检查都要有这一条）', () => {
    expect(
      SUITE_IMPORT.test(stripComments(read('test/docs.test.ts'))),
      '检查器自己不应被判为写库套件（判据被改回「形状」或本文件出现了该导入的字面量？）',
    ).toBe(false);
  });
});

describe('写库套件清单与实现一致', () => {
  it('README 列出的写库套件 == 实际调用 assertWritableTarget 的套件', () => {
    const readme = read('README.md');
    const anchor = readme.indexOf(WRITE_GUARD_ANCHOR);
    expect(anchor, `README 未找到「${WRITE_GUARD_ANCHOR}」段落`).toBeGreaterThan(-1);
    const open = readme.indexOf('（', anchor);
    const close = readme.indexOf('）', open);
    expect(open, '锚点后未找到清单的起始括号').toBeGreaterThan(-1);
    expect(close, '清单括号未闭合').toBeGreaterThan(open);

    const listed = [...readme.slice(open, close).matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const actual = writeGuardedSuites();
    expect(actual.length, '实际写库套件不应为空').toBeGreaterThan(0);
    expect(
      [...listed].sort(),
      `README 列出的写库套件（${listed.join('/')}）与实际（${actual.join('/')}）不一致`,
    ).toEqual([...actual].sort());
  });
});

describe('代码规模统计', () => {
  it('计算出业务/测试/文档的行数，并要求 progress.md 保有记录节', () => {
    const business = measure('业务代码', collectFiles('src', ['.ts']));
    const tests = measure('测试代码', collectFiles('test', ['.ts', '.mjs']));
    const docs = measure('文档', ['README.md', 'AGENTS.md', ...collectFiles('docs', ['.md'])]);

    const all = [business, tests, docs];
    const total = all.reduce((n, s) => n + s.lines, 0);
    for (const stat of all) {
      // 打印到测试输出（CI 日志里直接可读）——这是这个用例的主要产出
      console.log(`[规模] ${stat.label.padEnd(4, '　')} ${String(stat.lines).padStart(6)} 行 / ${String(stat.files).padStart(3)} 个文件`);
    }
    console.log(`[规模] 合计   ${String(total).padStart(6)} 行 / ${String(all.reduce((n, s) => n + s.files, 0)).padStart(3)} 个文件`);

    // 断言只保留结构性不变量（不做等值断言，见文件头说明）
    for (const stat of all) {
      expect(stat.lines, `${stat.label}行数不应为 0`).toBeGreaterThan(0);
      expect(stat.files, `${stat.label}文件数不应为 0`).toBeGreaterThan(0);
    }
    // 本项目以协议级测试为主要质量手段：测试规模不应显著低于业务代码（低于则说明套件被削）
    expect(
      tests.lines / business.lines,
      `测试代码仅为业务代码的 ${Math.round((tests.lines / business.lines) * 100)}%，与「协议级测试为主」的定位不符`,
    ).toBeGreaterThan(0.3);

    // 记录必须存在（防止记录节被删掉却无人察觉）
    expect(read('docs/progress.md')).toContain('### 代码规模');
  });
});

// ===== 部署开关的四处清单：`.dev.vars.example` ↔ `deploy.yml`（↔ `README.md` 的开关表）=====
//
// 由来（2026-09-21 复查）：同一批开关散在四处 —— `.dev.vars.example`（本地开发）、`deploy.yml`
// （GitHub 仓库变量 → 绑给 Worker）、`wrangler.toml` 的 `[vars]`（默认值）、`README.md` 的开关表。
// 此前**没有任何判据**看着它们：`.dev.vars.example` 只在四个套件的注释里被提到（"默认与 .dev.vars 示例一致"），
// 于是"新增一个开关、忘了改示例文件或 README"这类漂移只能靠人去数 —— 正是 `AGENTS.md` §1 点名的那类
// （2026-09-21 实测：README 的开关表就漏了 4 个 `AUTH_RATE_LIMIT_*`，而 `deploy.yml` 的注释还写着
// "README 已写明"）。判据只钉**名字集合**：默认值各处已实测一致，范围另有 `src/rateLimit.ts` 的
// `AUTH_RATE_LIMIT_RANGES`、`src/requestLimits.ts` 的 FLOOR/CEILING 与 CI 的校验。
describe('部署开关清单：.dev.vars.example / deploy.yml / README 三处一致', () => {
  // ⚠️ 仓库里的文件是 **CRLF** ⇒ 任何"按行匹配"的抽取都要先归一，否则 `\|\n` 这类模式永远不命中
  // （2026-09-21 加这条守卫时正踩在这里：抽不到 `vars:` 名单，断言先红在"抽取器失效"上）。
  const readText = (relative: string): string => read(relative).replace(/\r\n/g, '\n');

  /** `.dev.vars.example` 里的名字（含被注释掉的**可选**行 —— 注释行同样是这份清单的一部分）。 */
  function exampleNames(): string[] {
    return [...readText('.dev.vars.example').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
  }

  /** `deploy.yml` 里 `Deploy Worker` 步骤的 `vars: |` 名单 —— 即"绑给 Worker"的那批名字。 */
  function workerBoundNames(): string[] {
    const list = /\n\s+vars: \|\n((?:\s+[A-Z][A-Z0-9_]*\n)+)/.exec(readText('.github/workflows/deploy.yml'))?.[1];
    expect(list, '没抽到 deploy.yml 的 vars 名单（守卫可能失效）').toBeTruthy();
    return [...(list ?? '').matchAll(/([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
  }

  /** `README.md` **开关表**里被反引号括起来的变量名（只认表格行，避免把散文里的提及算进来）。 */
  function readmeTableNames(): string[] {
    return [...readText('README.md').matchAll(/^\s*\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!);
  }

  it('.dev.vars.example == CI 绑给 Worker 的名字 + 凭据 + 测试覆盖（双向，且不放空）', () => {
    const example = new Set(exampleNames());
    const bound = new Set(workerBoundNames());
    // 空集合会让下面两条断言永远为真 ⇒ 先钉住"抽取器在工作"
    expect(example.size, '没抽到 .dev.vars.example 的名字（守卫可能失效）').toBeGreaterThan(6);
    expect(bound.size, '没抽到 deploy.yml 的开关名单（守卫可能失效）').toBeGreaterThan(6);
    // 凭据走 secrets（`wrangler secret put`），SYNC_USER/SYNC_PASS 只是测试覆盖 —— 这五个不进 CI 的 vars 名单
    const allowed = new Set([...bound, 'USERNAME', 'PASSWORD', 'SYNC_USER']);
    expect(
      [...example].filter((name) => !allowed.has(name)).sort(),
      '.dev.vars.example 里出现了 CI 不认的名字：要么把它接进 deploy.yml 的 vars 名单，要么从示例删掉',
    ).toEqual([]);
    expect(
      [...bound].filter((name) => !example.has(name)).sort(),
      '.dev.vars.example 缺了 CI 会绑给 Worker 的开关 —— 新增可调项时四处（示例/CI/README/wrangler.toml）都要改',
    ).toEqual([]);
  });

  it('README 的开关表覆盖全部运行期开关 + 两个部署期变量（2026-09-21 曾漏 4 个限速参数）', () => {
    const table = new Set(readmeTableNames());
    expect(table.size, '没抽到 README 开关表（守卫可能失效）').toBeGreaterThan(6);
    const required = new Set([...workerBoundNames(), 'D1_DATABASE_ID', 'D1_BOOTSTRAP']);
    expect(
      [...required].filter((name) => !table.has(name)).sort(),
      'README 的开关表漏了这些变量（用户在 README 里根本看不到它们可配）',
    ).toEqual([]);
    expect(
      [...table].filter((name) => !required.has(name)).sort(),
      'README 开关表里出现了既不是运行期开关、也不是部署期变量的名字（写错了？还是该登记进上面那条判据？）',
    ).toEqual([]);
  });
});
