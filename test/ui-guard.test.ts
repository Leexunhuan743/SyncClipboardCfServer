// Web 界面（`web/` 源码 → `public/ui/` 构建产物）的结构守卫。
//
// 这些判据读的是**仓库里的文件**，不依赖服务器；它们守的是"改一处、漏另一处"的那类静默漂移：
//   · 挂载点前缀有三处副本（src/index.ts、wrangler.toml 的 run_worker_first、public/_headers），必须一致；
//   · CSP 是 `script-src 'self'; style-src 'self'`：页面和脚本里不能有内联脚本/内联样式属性；
//   · 前端不用 innerHTML 注入用户内容（剪贴板正文、文件名都是不可信输入）；
//   · 前端调用的每个 `/ui/api/*` 接口，服务端都真实注册了；
//   · 构建脚本能跑通，产物里入口 HTML 引用的带哈希资源确实存在。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel, filter));
    else if (filter(rel)) out.push(rel);
  }
  return out;
}

const WEB_SRC = walk('web/src', (f) => /\.(ts|css)$/.test(f));
const WEB_TS = WEB_SRC.filter((f) => f.endsWith('.ts'));

describe('挂载点：三处副本一致', () => {
  it('src/index.ts 只把 /ui 当界面前缀', () => {
    const source = read('src/index.ts');
    expect(source).toMatch(/const isUiAsset = path === '\/ui' \|\| path\.startsWith\('\/ui\/'\);/);
  });

  it('wrangler.toml 的 run_worker_first 恰好是 ["/ui", "/ui/*"]（否则界面开关对已存在的资源静默失效）', () => {
    const toml = read('wrangler.toml');
    const match = /run_worker_first\s*=\s*\[([^\]]*)\]/.exec(toml);
    expect(match, '找不到 run_worker_first').not.toBeNull();
    const patterns = [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(patterns).toEqual(['/ui', '/ui/*']);
  });

  it('界面里"下一次清理"用的分钟位与 wrangler.toml 的 cron 一致', () => {
    const cron = /crons\s*=\s*\[\s*"([^"]+)"/.exec(read('wrangler.toml'))?.[1] ?? '';
    const minutes = cron.split(' ')[0]!.split(',').map(Number);
    const ui = /CLEANUP_MINUTES: readonly number\[\] = \[([^\]]+)\]/.exec(read('web/src/lib/format.ts'))?.[1] ?? '';
    expect(ui.split(',').map((n) => Number(n.trim()))).toEqual(minutes);
  });

  it('wrangler.toml 在部署/开发前先构建界面', () => {
    const toml = read('wrangler.toml');
    expect(toml).toMatch(/\[build\]\s*\ncommand\s*=\s*"node web\/build\.mjs"/);
    // watch_dir 取代默认值（main 所在目录）：漏了 src 本地改服务端代码就不再热重载
    expect(toml).toMatch(/watch_dir\s*=\s*\[\s*"web"\s*,\s*"src"\s*\]/);
    expect(existsSync(join(ROOT, 'web/build.mjs'))).toBe(true);
  });

  it('public/_headers：哈希资源长缓存、入口与无哈希文件必须重验证、全站安全头', () => {
    const headers = read('public/_headers');
    expect(headers).toMatch(/\/ui\/assets\/\*\s*\n\s*Cache-Control: public, max-age=31536000, immutable/);
    for (const path of ['/ui/', '/ui/index.html', '/ui/theme-init.js']) {
      const escaped = path.replaceAll('/', '\\/').replaceAll('.', '\\.');
      expect(headers, path).toMatch(new RegExp(`${escaped}\\s*\\n\\s*Cache-Control: public, no-cache, must-revalidate`));
    }
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("style-src 'self'");
    expect(headers).toContain('X-Frame-Options: DENY');
  });

  it('旧界面的挂载点与路径不再出现在任何源码 / 配置 / 脚本里', () => {
    const files = [
      ...walk('src', (f) => f.endsWith('.ts')),
      ...walk('web', (f) => /\.(ts|css|html|mjs|json|webmanifest)$/.test(f)),
      ...walk('tools', (f) => /\.(sh|mjs|ps1)$/.test(f)),
      'wrangler.toml', 'public/_headers', 'package.json', 'eslint.config.js', '.github/workflows/deploy.yml',
    ];
    for (const file of files) {
      expect(read(file), file).not.toMatch(/ui_v1|ui_v2|ui_shared/);
    }
  });

  it('源码目录里没有混入构建产物', () => {
    expect(WEB_SRC.every((f) => !f.includes('/assets/'))).toBe(true);
  });
});

describe('CSP 友好：脚本和样式都只来自本站外链', () => {
  const html = read('web/index.html');

  it('index.html 没有内联脚本、内联样式、内联事件处理器', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('index.html 里有两个构建占位符，首帧主题脚本是外链经典脚本', () => {
    expect(html).toContain('%APP_JS%');
    expect(html).toContain('%APP_CSS%');
    expect(html).toMatch(/<script src="\/ui\/theme-init\.js"><\/script>/);
  });

  it('前端代码不用 innerHTML / outerHTML / insertAdjacentHTML / eval / new Function', () => {
    for (const file of WEB_TS) {
      const source = read(file).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(source, file).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
      expect(source, file).not.toMatch(/\beval\s*\(|new Function\s*\(/);
      expect(source, file).not.toMatch(/setAttribute\(\s*['"]style['"]/);
    }
  });

  it('样式表里没有 @import 外部地址、没有外部字体', () => {
    for (const file of WEB_SRC.filter((f) => f.endsWith('.css'))) {
      // 内联 SVG（data:）里的 xmlns 地址不是外部请求，先剔除再查
      expect(read(file).replace(/url\("data:[^"]*"\)/g, ''), file).not.toMatch(/https?:\/\//);
    }
  });
});

describe('前端调用的接口都真实存在', () => {
  const serverSource = [
    ...walk('src/ui', (f) => f.endsWith('.ts')),
  ].map(read).join('\n');
  const routes = new Set(
    [...serverSource.matchAll(/app\.(?:get|post|put|patch|delete|all)\(\s*'(\/ui\/api\/[^']*)'/g)].map((m) => m[1]!),
  );

  it('服务端路由表不为空（正则没有失效）', () => {
    expect(routes.size).toBeGreaterThan(10);
    expect(routes.has('/ui/api/history')).toBe(true);
  });

  it('api.ts 里的每个 `${API_BASE}/xxx` 都对应一条已注册的路由', () => {
    const client = read('web/src/lib/api.ts');
    const used = new Set(
      [...client.matchAll(/\$\{API_BASE\}\/([a-z][a-z/-]*)/g)].map((m) => `/ui/api/${m[1]!.replace(/\/$/, '')}`),
    );
    expect(used.size).toBeGreaterThan(10);
    for (const path of used) {
      const known = routes.has(path) || [...routes].some((route) => route.startsWith(`${path}/:`));
      expect(known, `前端调用了 ${path}，但服务端没有注册它`).toBe(true);
    }
  });

  it('接口前缀字面量只在 query.ts 里出现一次（改前缀不会改漏）', () => {
    const code = (f: string): string => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = WEB_TS.filter((f) => /['"`]\/ui\/api/.test(code(f)));
    expect(hits).toEqual(['web/src/lib/query.ts']);
  });
});

describe('构建', () => {
  it('node web/build.mjs 产出入口、带哈希的资源与静态文件，并替换占位符', () => {
    execFileSync(process.execPath, ['web/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
    const out = join(ROOT, 'public/ui');
    const index = readFileSync(join(out, 'index.html'), 'utf8');
    expect(index).not.toContain('%APP_JS%');
    expect(index).not.toContain('%APP_CSS%');
    const js = /src="(\/ui\/assets\/app-[A-Za-z0-9_-]+\.js)"/.exec(index)?.[1];
    const css = /href="(\/ui\/assets\/app-style-[A-Za-z0-9_-]+\.css)"/.exec(index)?.[1];
    expect(js, '入口里没有带哈希的脚本').toBeDefined();
    expect(css, '入口里没有带哈希的样式').toBeDefined();
    expect(existsSync(join(ROOT, 'public', js!.slice(1)))).toBe(true);
    expect(existsSync(join(ROOT, 'public', css!.slice(1)))).toBe(true);
    for (const file of ['theme-init.js', 'manifest.webmanifest', 'brand/favicon.svg', 'brand/favicon-32.png', 'brand/apple-touch-icon.png']) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    // 产物是纯静态文件：不应再出现 TypeScript 源码
    expect(walk('public/ui', (f) => f.endsWith('.ts'))).toEqual([]);
  });

  it('manifest 的入口与图标路径都落在 /ui/ 下且文件存在', () => {
    const manifest = JSON.parse(read('web/static/manifest.webmanifest')) as { start_url: string; scope: string; icons: { src: string }[] };
    expect(manifest.start_url).toBe('/ui/');
    expect(manifest.scope).toBe('/ui/');
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/ui/')).toBe(true);
      expect(existsSync(join(ROOT, 'web/static', icon.src.slice('/ui/'.length))), icon.src).toBe(true);
    }
  });
});

// ======================================================================
// 主题风格：颜色令牌必须成套、文字对比度必须达标、风格表三处一致
// ======================================================================
describe('主题风格', () => {
  const tokensCss = read('web/src/styles/tokens.css');
  const themesCss = read('web/src/styles/themes.css');
  const themeTs = read('web/src/theme.ts');
  const themeInit = read('web/static/theme-init.js');

  /** 取一个选择器块里的全部自定义属性（只认十六进制/简单值，足够做对比度判断） */
  function tokensOf(css: string, selectorStart: RegExp): Map<string, string> {
    const start = css.search(selectorStart);
    expect(start, String(selectorStart)).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
    return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  }

  const STYLE_IDS = [...themeTs.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]!);
  const SPECIAL = STYLE_IDS.filter((id) => id !== 'default');

  const defaultLight = tokensOf(tokensCss, /^:root \{/m);
  const defaultDark = tokensOf(tokensCss, /^:root\[data-theme="dark"\] \{/m);
  const palettes: Record<string, Map<string, string>> = {
    default: defaultLight,
    'default-dark': new Map([...defaultLight, ...defaultDark]),
    ...Object.fromEntries(SPECIAL.map((id) => [id, tokensOf(themesCss, new RegExp(`^:root\\[data-style="${id}"\\], \\.style-preview\\[data-style="${id}"\\] \\{`, 'm'))])),
  };

  it('风格 id 在 theme.ts、theme-init.js、themes.css 三处一致', () => {
    expect(STYLE_IDS).toEqual(['default', 'coast', 'paper', 'pop']);
    for (const id of SPECIAL) {
      expect(themeInit, `theme-init.js 缺 ${id}`).toContain(`${id}:`);
      expect(themesCss, `themes.css 缺 ${id}`).toContain(`:root[data-style="${id}"]`);
    }
    // 固定明暗与首帧脚本一致（coast 是 dark，其余 light）
    for (const id of SPECIAL) {
      const inTs = new RegExp(`id: '${id}'[^}]*scheme: '(dark|light)'`).exec(themeTs)?.[1];
      const inInit = new RegExp(`${id}: \\['(dark|light)'`).exec(themeInit)?.[1];
      expect(inInit, id).toBe(inTs);
    }
  });

  it('每套风格都覆盖默认风格的全部颜色令牌（漏一个就会混进默认风格的颜色）', () => {
    const required = [...defaultLight.keys()].filter((k) => /^--(bg|surface|ink|line|accent|danger|warn|ok|star|t-|shadow|overlay)/.test(k));
    expect(required.length).toBeGreaterThan(25);
    for (const id of SPECIAL) {
      const missing = required.filter((k) => !palettes[id]!.has(k));
      expect(missing, `${id} 缺少令牌`).toEqual([]);
    }
  });

  // WCAG 相对亮度 / 对比度（只解析 #rgb / #rrggbb，令牌里的文字色与底色都是十六进制）
  const channel = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  }
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  // [前景令牌, 背景令牌, 最低对比度]：文字用 4.5；图标/大号字用 3
  const PAIRS: [string, string, number][] = [
    ['--ink', '--bg', 4.5], ['--ink', '--surface', 4.5], ['--ink', '--surface-2', 4.5],
    ['--ink-2', '--surface', 4.5], ['--ink-2', '--surface-2', 4.5],
    ['--ink-3', '--bg', 4.5], ['--ink-3', '--surface', 4.5], ['--ink-3', '--surface-2', 4.5],
    ['--accent-ink', '--accent', 4.5], ['--accent', '--surface', 4.5], ['--accent', '--accent-soft', 4.5],
    ['--danger', '--surface', 4.5], ['--danger-ink', '--danger', 4.5], ['--danger', '--danger-soft', 4.5],
    ['--warn', '--warn-soft', 4.5], ['--ok', '--ok-soft', 4.5],
    ['--t-text', '--t-text-bg', 4.5], ['--t-image', '--t-image-bg', 4.5], ['--t-file', '--t-file-bg', 4.5], ['--t-group', '--t-group-bg', 4.5],
  ];

  for (const [name, palette] of Object.entries(palettes)) {
    it(`${name}：文字与底色的对比度达标`, () => {
      const bad: string[] = [];
      for (const [fg, bg, min] of PAIRS) {
        const f = palette.get(fg);
        const b = palette.get(bg);
        if (!f || !b || !/^#[0-9a-f]{3,6}$/i.test(f) || !/^#[0-9a-f]{3,6}$/i.test(b)) continue;
        const ratio = contrast(f, b);
        if (ratio < min) bad.push(`${fg} ${f} / ${bg} ${b} = ${ratio.toFixed(2)} < ${min}`);
      }
      expect(bad).toEqual([]);
    });
  }
});
