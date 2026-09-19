# 界面改名：ui_old → ui_v1 / ui → ui_v2（2026-09-19）

> 操作记录。用户三条原话（2026-09-19）：
> ① `ui_old` 全部切换成 `ui_v1`；② 现在的 `ui`（V2）全部换成 `ui_v2`；
> ③ 删掉「默认界面（V1）。开发测试版在 /ui/app/。」这一行。
>
> 追问确认过边界：**"连 URL 挂载点一起改"**（用户选项 B）—— 不只是改仓库里的目录名。

## 0. 为什么这不是一次 sed

`AGENTS.md` 与 `public/ui_old/js/api.js` 都记着 2026-09-15 那次改名事故：把 V1 搬进
`public/ui_old/` 时，`/ui/` → `/ui_old/` 的批量改写把 **17 处接口前缀**一起改了，界面从此去打
`/ui_old/api/*`（服务端没有这个命名空间），症状是"HTML/CSS/JS 全 200、页面停在骨架屏"，
线上存活两天。**这次是同型操作**，故先做影响面测绘再动手。

测绘结论（`grep` 全库）：`ui_old` 出现在 **33 个文件**；`/ui/` 这个前缀在 V2 里同时扮演
**两个角色**，必须分开处理：

| 角色 | 例子 | 处置 |
|---|---|---|
| 页面 / 静态资源 | `/ui/js/boot.js`、`/ui/css/*`、`/ui/app/` | → `/ui_v2/...` |
| **服务端接口命名空间** | `/ui/api/*`（`src/ui/routes.ts` 的路由，两版共用） | **保持 `/ui/api` 不动** |

## 1. 方案（关键决策）

改名后三个挂载点：

| 挂载点 | 目录 | 角色 |
|---|---|---|
| `/ui_v1/` | `public/ui_v1/` | **V1，默认界面**（产品面） |
| `/ui_v2/` | `public/ui_v2/` | V2，开发测试版；应用本体在 `/ui_v2/app/` |
| `/ui/` | `public/ui/` | **只留一层跳转壳**（`index.html` + `js/redirect-hash.js`），送到 `/ui_v1/` |

**为什么保留 `/ui/` 而不是让它彻底消失**（两条硬理由，都不是审美）：

1. **接口前缀压着它**：`/ui/api/*` 是 V2 与 V1 **共用**的服务端接口（`src/ui/routes.ts`），
   它在 `src/index.ts` 里靠 `pathname.startsWith('/ui/')` 一类判据与"界面资源"区分。
   把 V2 的资源整体挪到 `/ui_v2/` 之后，`/ui/` 这个前缀仍必须存在 —— 它承载接口。
2. **老书签**：`/ui/` 是真实存在过的用户可见地址（V2 旧入口），留一层壳比 404 好。

**其次**：`src/index.ts` 原来的判定是三岔（`isUiPath` / `isUiApi` / `isArchivePath`），
其中两个界面面的处理**形状相同**（先问静态资源、未命中回落到 404 页）。改名时合并成一条
`isUiAsset` 链（三个前缀共用），少一份会漂移的重复。

## 2. 执行清单与状态

| # | 动作 | 状态 |
|---|---|---|
| 1 | `wrangler.toml`：`run_worker_first` 覆盖 `/ui`、`/ui_v1`、`/ui_v2` 三前缀 | ✅ |
| 2 | `src/index.ts`：`isUiAsset` 合并三前缀 + `isUiApi` 保持优先 | ✅ |
| 3 | `src/routes/webdav.ts`：站点根 302 → `/ui_v1/` | ✅ |
| 4 | `src/ui/notFound.ts`：样式/图标 → `/ui_v2/...`，入口 → `/ui_v1/` | ✅ |
| 5 | 目录改名 `public/ui_old` → `public/ui_v1`、`public/ui` → `public/ui_v2`，并重建 `/ui/` 壳 | ✅ |
| 6 | V1 内部引用 `/ui_old` → `/ui_v1`（`PAGE_BASE`、`modulepreload`、manifest、两页） | ✅ |
| 7 | V2 内部引用 `/ui/` → `/ui_v2/`（**避开 `/ui/api`**） | ✅ |
| 8 | 删提示条那一行（原话③，V1 `index.html` + `login.html`）→ 连带删整条提示条与 `archive.css` | ✅ |
| 9 | 守卫同步：`ui-guard` / `ui-contract` / `docs.test` / `next-target` / `rate-limit` / `ui-input` / `ui-logic` / `clipboard` | ✅ |
| 10 | 门禁与工具链：`package.json` 的 `lint`、`eslint.config.js` 的 glob、`.github/workflows/deploy.yml`（lint 名 + 冒烟五条路径）、`AGENTS.md`（DoD 命令 + 两张表） | ✅ |
| 11 | 文档：`README.md` / `docs/*.md`（现状类）/ `public/ui_v1/README.md` / `docs/ui.md` 资源数 89 → 88 | ✅ |
| 12 | 全量套件 + 探针 | ⏳ 见 §5 |

### 2.1 替换的实际做法（为什么不是一把 `sed`）

三类字面量，**误伤面完全不同**，因此分三轮、各自带保护：

| 轮次 | 模式 | 保护措施 | 命中 |
|---|---|---|---|
| ① V2 的 URL | `(["'`(])\/ui\/(?!api)` | 要求前面是引号/反引号/括号 ⇒ 避开相对导入 `./ui/`、`../ui/` 与仓库路径 `src/ui/`；`(?!api)` 保住接口前缀 | 69 处（`public/ui_v2`） |
| ② V1 的整词 | `ui_old` | 无保护需求：目录名与 URL 前缀**同时**变了，整词替换在语义上恒等 | 69 处（`public/ui_v1`）+ 51 处（`test/`） |
| ③ 仓库路径 | `public\/ui\/` | 尾部带 `/` ⇒ 不会误伤 `public/ui_v1/`（`ui` 后是 `_` 不是 `/`） | 两版 + test + 现状类文档 |

**刻意不做批量替换的地方**：`src/**`（里面有 `app.all('/ui/*', …)` 这种**代码**，一把扫会把路由
改成 `/ui_v2/*`）、`docs/progress.md` 与 `docs/AUDIT-*.md`（按轮次的历史记录，改了就是篡改历史）、
`docs/ui-rename-v1-v2.md`（本文件，叙述改名本身、必须保留旧名）。这些全部手工逐条改。

## 3. 过程中踩到的坑（逐条记）

- **`wrangler.toml` 不能写 `//` 注释**：首次编辑时按 JS 习惯写了 `//`，那是**非法 TOML**，
  整个配置文件会解析失败（部署直接挂）。已改回 `#`。教训：TOML/INI 类配置的注释语法要在动手前确认。
- **大段中文 `old_text` 匹配易错**：`src/index.ts` 的替换文本里含 `⚠️`（U+26A0 U+FE0F），
  手写时漏了变体选择符 ⇒ 匹配失败。改为「写临时文件 + 按行号拼接 + 删临时文件」。
- **行尾**：仓库 `core.autocrlf=true`（索引 LF、工作区 CRLF）。脚本拼接引入的 LF 行会让
  工作区出现混合行尾，已统一回 CRLF。（`git diff --numstat` 是判据：若某文件显示"整文件重写"，
  就是行尾被改了。）
- **`package.json` 的 `"type": "module"` 会影响临时脚本**：写成 `.js` 的 CommonJS 辅助脚本
  会被当 ESM 解析，`require` 直接报错 ⇒ 辅助脚本一律用 `.cjs`。
- **只替换"一半"比不替换更危险**：`/ui/__missing__` 这类**出现在 URL 字符串里但前面不是引号**的
  写法（`https://sync.example.com/ui/__missing__`）不会被引号锚定的规则命中，而同一行的
  **期望值**（`['/ui/__missing__']`）会被命中 —— 结果测试里请求与期望值不一致。
  教训：替换后必须**逐个文件复核**，不能只看"总命中数下降"。
- **V1 的 `README.md` 与 `api.js` 注释是历史叙述**：整词替换把「`/ui/` → `/ui_old/` 的批量改写」
  改成了「`/ui/` → `/ui_v1/`」，读起来自相矛盾（实况是**当时**用旧名）。手工改成不写具体字面量的
  叙述（"它自己的目录"），既保留教训又不写错。
- **删一个 UI 元素要连带清三处**：删掉提示条那一行文字后，`#notice-bar` 的 HTML、两处 JS 接线
  （`NOTICE_KEY` / `initNoticeBar`）、`archive.css` 整份样式、`ui-guard` 的 `PRESSABLE` 条目与
  "两页 NOTICE_KEY 一致"用例全部失去目标 —— 少清任何一处都会留下死代码或让守卫红。

## 4. 原话③的读法与处置（重要，请复核）

用户原话是「**第3　默认界面（V1）。开发测试版在 /ui/app/。 这一行删除掉，**」。

那一行是 V1 顶部**提示条**（`#notice-bar`）的**唯一内容**：只删文字会留下一条只有图标 + 关闭按钮的
空条 —— 显然不是想要的。故按"**整条提示条移除**"处置，连带清掉：

| 位置 | 处理 |
|---|---|
| `public/ui_v1/index.html` | 删提示条 HTML 与其说明注释 |
| `public/ui_v1/login.html` | 同上（两页共用同一条） |
| `public/ui_v1/js/main.js` / `login.js` | 删 `NOTICE_KEY` 常量与 `initNoticeBar()` 及其调用 |
| `public/ui_v1/css/archive.css` | **整份文件删除**（文件头自述"顶部提示条（V1 专用）"，它只为这条提示存在）—— 同时也是两页 `<link>` 的移除 |
| `test/ui-guard.test.ts` | 删「两页的提示条键名一致」用例；`PRESSABLE` 里去掉 `notice-bar__close` |
| `docs/ui.md` | §3 资源数 89 → 88，V1 分表 38 → 37，并记一句原因 |

**若原意只是删掉那句文字、保留提示条外壳**：把上面六处按本文件末尾的"回滚点"恢复即可
（`git show HEAD:public/ui_old/css/archive.css` 能取回整个样式文件）。

## 5. 验证（本机实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `node node_modules/typescript/bin/tsc --noEmit` | **0 错** |
| 静态检查 | `node node_modules/eslint/bin/eslint.js public/ui_v2/js public/ui_v1/js` | **0 告警** |
| 全量套件 | 先 `wrangler dev --test-scheduled --port 8787`，再 `vitest run --no-file-parallelism` | **22 套件 / 404 用例 全过** |
| V2 浏览器探针 | `node test/manual/probe.mjs --width 1440 --height 900 --url /ui_v2/app/` | `booted=1`、50 行、零 console 错误、**零失败请求** |
| V1 浏览器探针 | `node test/manual/probe-ui-v1.mjs --width 1440 --height 900` | `booted=1`、行高 47、`AUDIT findings=0`、`noticeVisible=null`（提示条确已移除）、零 console 错误、**零失败请求** |

> 探针文件也在本轮改了名：`test/manual/probe-ui-old.mjs` → `probe-ui-v1.mjs`（"old" 正是要清掉的
> 命名），引用它的四处现状文档（`AGENTS.md` / `docs/frontend-checklist.md` /
> `public/ui_v1/README.md` / `test/manual/shoot.mjs`）同步更新。`docs/progress.md` 与
> `docs/AUDIT-*.md` 里的旧名**保持原样**（历史记录不改）。

## 6. 没做 / 待确认

- **`src/ui/routes.ts` 的 `/ui/*` 兜底 404 与 `/ui` 302 现在是死代码**：改造后 `src/index.ts`
  在更外层就把三个界面前缀全部处理掉了，这两个路由永远命不中。本轮**刻意不删**（属范围外的收敛，
  且它们对 `/ui/` 这个仍然存在的命名空间来说是自洽的）。要清就单开一轮。
- **`/ui_v2/` 本身没有目录索引**：访问 `/ui_v2/` 会落到那张设计过的 404 页（页内有指向
  `/ui_v1/` 与 `/ui_v2/app/` 的说明）。旧结构里 `/ui/` 是有索引壳的；本轮没有为 V2 新建一个
  （新建 = 加文件 = 动资源数与目录树）。若希望 `/ui_v2/` 直接进 V2 应用，说一句就加。
- **历史文档未改**：`docs/progress.md`（按轮次的历史快照）与 `docs/AUDIT-*.md`（审计证据）里仍写着
  `ui_old` / `public/ui/`。这是**有意**的 —— 改它们等于篡改历史，且 `docs.test.ts` 刻意豁免
  `progress.md`。