// Web 界面的构建脚本：`web/` → `public/ui/`（后者是构建产物，不进仓库）。
//
//   node web/build.mjs            一次性构建（wrangler 的 [build] 钩子与 CI 用）
//   node web/build.mjs --watch    监听源码变化（本地开发）
//
// 做三件事：
//   1. esbuild 把 `src/main.ts` 打成一个 ES module、把 `src/styles/app.css` 展开成一张样式表，
//      文件名带**内容哈希** —— 因此 `/ui/assets/*` 可以放心长缓存（见 public/_headers），
//      而 `index.html` 每次重验证，部署后用户立刻拿到指向新哈希的入口；
//   2. 把 `static/`（品牌图标、manifest、首帧主题脚本）原样拷进输出目录；
//   3. 把 `index.html` 里的 `%APP_JS%` / `%APP_CSS%` 换成带哈希的真实路径。
// 脚本只用 node 内置模块与 esbuild；不引入任何运行时依赖，浏览器拿到的就是纯静态文件。
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const out = join(root, 'public', 'ui');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    app: join(web, 'src/main.ts'),
    'app-style': join(web, 'src/styles/app.css'),
  },
  outdir: join(out, 'assets'),
  entryNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari15', 'firefox100'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  metafile: true,
  legalComments: 'none',
  logLevel: 'info',
  // CSP 是 `style-src 'self'`：样式只能来自外链样式表，字体/图片只允许同源或 data:
  loader: { '.svg': 'dataurl', '.png': 'dataurl' },
};

async function assemble(metafile) {
  const outputs = Object.keys(metafile.outputs).map((file) => relative(out, resolve(root, file)).replaceAll('\\', '/'));
  const js = outputs.find((file) => /^assets\/app-[^/]+\.js$/.test(file));
  const css = outputs.find((file) => /^assets\/app-style-[^/]+\.css$/.test(file));
  if (!js || !css) throw new Error(`构建产物里找不到入口：js=${js} css=${css}`);
  await cp(join(web, 'static'), out, { recursive: true });
  const html = (await readFile(join(web, 'index.html'), 'utf8'))
    .replaceAll('%APP_JS%', `/ui/${js}`)
    .replaceAll('%APP_CSS%', `/ui/${css}`);
  await writeFile(join(out, 'index.html'), html);
  console.log(`[web] ${js}  ${css}`);
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'assets'), { recursive: true });

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{ name: 'assemble', setup: (b) => b.onEnd(async (r) => r.metafile && (await assemble(r.metafile))) }],
  });
  await ctx.watch();
  console.log('[web] 监听中…');
} else {
  const result = await build(options);
  await assemble(result.metafile);
}
