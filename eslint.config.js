// 前端静态检查（`public/ui_v2/js/**` 与 `public/ui_v1/js/**`）。
//
// 为什么只有这一块：`src/**` 与 `test/**` 由 `tsc --noEmit` 把关（类型 + 拼写），
// 而零构建的 `public/ui_v*/*` **不在 tsconfig 的 include 里**——它此前只有
// `test/ui-contract.test.ts` 的四类跨文件契约与「能否被 Node 原生解析」，
// 于是「拼错变量名」「import 了却没用」「用了没定义的东西」这类问题没有任何工具能拦，
// 只能靠打开浏览器看。这一层把那些问题前移到 `npm run lint`。
//
// 刻意保持极小：这不是风格警察（缩进/引号/分号都不管——仓库的既有写法已经一致，
// 引入格式化规则只会制造无意义 diff）。只开「可能真的是缺陷」的规则。
import globals from 'globals';

export default [
  {
    // 覆盖两版前端：V2（`public/ui_v2/`，开发测试版）与 V1（`public/ui_v1/`，默认界面）。
    // 顺带修掉一个过渡期的**真缺陷**：脚本此前写死 `public/ui/js`，V1 一被改名，`npm run lint`
    // 就报 `No files matching the pattern` 并以退出码 1 结束（= `npm run check` 与 CI quality 步骤
    // 全红）——而那是"配置引用了不存在的路径"，不是"代码有问题"。glob 式写法对两个目录都成立。
    // ⚠️ 但**改名时两处必须一起改**：这一份的 `files` 与 `package.json` 的 `lint` 脚本 ——
    // 2026-09-19 的 ui_old→ui_v1 / ui→ui_v2 就是两处一起改过来的。只改一处时，脚本那半会直接以
    // 「No files matching the pattern」失败（即上方那个缺陷），而配置这半失配**不一定会有人替你报到** ——
    // 故「改完跑一次没红」不能替代逐处核对（见 AGENTS.md §1 最后一行）。
    files: ['public/ui_v2/js/**/*.js', 'public/ui_v1/js/**/*.js'],
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
    // 首帧主题脚本是**经典脚本**（不是模块，见文件头）：它要在 <head> 里阻塞执行，
    // 故保留 var 写法（不经过任何转换，最小依赖的语言特性）。
    files: ['public/ui_v2/js/theme-init.js', 'public/ui_v1/js/theme-init.js'],
    languageOptions: { sourceType: 'script' },
    rules: { 'no-var': 'off' },
  },
];
