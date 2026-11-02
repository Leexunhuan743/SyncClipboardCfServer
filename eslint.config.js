// 前端静态检查（`public/ui/js/**`）。
//
// 为什么只有这一块：`src/**` 与 `test/**` 由 `tsc --noEmit` 把关（类型 + 拼写），
// 而零构建的 `public/ui/js/*` **不在 tsconfig 的 include 里** —— 「拼错变量名」「import 了却没用」
// 「用了没定义的东西」这类问题没有任何工具能拦，只能靠打开浏览器看。这一层把它们前移到 `npm run lint`。
//
// 刻意保持极小：这不是风格警察（缩进/引号/分号都不管）。只开「可能真的是缺陷」的规则。
import globals from 'globals';

export default [
  {
    // ⚠️ 这一份的 `files` 与 `package.json` 的 `lint` 脚本必须一起改：只改一处时，
    // 脚本那半会以「No files matching the pattern」失败。
    files: ['public/ui/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-undef': 'error', // 用了没声明的东西（模块里最常见的低级错误）
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
      'no-implicit-globals': 'error', // 模块里意外漏写 const/let
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-throw-literal': 'error', // throw '字符串' 会丢掉栈
      'no-constant-condition': ['error', { checkLoops: false }],
      // 本轮真实踩到：`refreshStats` 里 `const stats = await api.statistics(...)` 遮蔽了模块级的
      // 组件实例 `const stats = createStats(...)`，于是 `stats.update(...)` 抛 TypeError 被 catch 吞掉
      // （绘制失效 + 失联横幅误报）。`no-undef` 抓不到这种遮蔽，`no-shadow` 能。
      'no-shadow': ['error', { builtinGlobals: false, hoist: 'functions' }],
    },
  },
  {
    // 手动探针（`test/manual/*.mjs`）：它们**既不在 `tsc` 的 include 里、也不进任何套件**，
    // 此前唯一一道门是 `node --check`（只管语法）。2026-09-21 的教训正是这条缝：
    // `probe-ui-v1.mjs` 调了一个**从未定义**的 `check()` —— 语法完全合法，`node --check` 永远绿，
    // 而探针一跑到那里就 `ReferenceError` 退出（整份探针自 `fee8078` 起就没跑完过，见
    // Git history）。`no-undef` 一行就能拦下它，成本是零。
    //
    // ⚠️ 与上面那条同理：这里的 `files` 与 `package.json` 的 `lint` 脚本必须**一起**改
    // （只改一处时，脚本那半会以「No files matching the pattern」失败，配置这半失配不一定有人报到）。
    files: ['test/manual/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // 这些脚本是 **Node** 侧驱动器（spawn 浏览器、连 CDP、写截图）；
      // 页面里跑的那段是模板字符串，不参与这里的静态检查。
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
      'no-shadow': ['error', { builtinGlobals: false, hoist: 'functions' }],
      'no-throw-literal': 'error',
      eqeqeq: ['error', 'smart'],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // 首帧主题脚本是**经典脚本**（不是模块，见文件头）：它要在 <head> 里阻塞执行，
    // 故保留 var 写法（不经过任何转换，最小依赖的语言特性）。
    files: ['public/ui/js/theme-init.js'],
    languageOptions: { sourceType: 'script' },
    rules: { 'no-var': 'off' },
  },
];
