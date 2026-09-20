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
| 12 | 全量套件 + 探针 | ✅ 见 §5 |

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
- **同一个坑还漏了 `test/ui-guard.test.ts`**（**独立审计发现，2026-09-19 补**）：那一节的注释
  叙述「把 V1 存档到 `X/` 时 `/ui/` → `X/` 的批量改写把 17 处接口前缀也一起改了」，整词替换把
  `X` 换成了 `ui_v1`、却把「`/ui/`」那半边留成 `/ui_v2/` ⇒ 读起来成了「`public/ui_v1/` 时
  `/ui_v2/` → `/ui_v1/`」，一件 2026-09-15 **从未发生过**的事（当时既无 `ui_v1` 也无 `ui_v2`）。
  教训：**测试文件与代码注释里的历史叙述同样在替换范围内**，而它此前不在 §3 任何一条清单里。
  这一处按「写回旧名 + 注明'当时叫 `ui_old`'」处理（可对照 `git show e3858cd^:test/ui-guard.test.ts`），
  与 `docs/ui.md:67` 的可考写法一致。
- **删一个 UI 元素要连带清三处**：删掉提示条那一行文字后，`#notice-bar` 的 HTML、两处 JS 接线
  （`NOTICE_KEY` / `initNoticeBar`）、`archive.css` 整份样式、`ui-guard` 的 `PRESSABLE` 条目与
  "两页 NOTICE_KEY 一致"用例全部失去目标 —— 少清任何一处都会留下死代码或让守卫红。
- **按目录批量替换会漏掉"含死路径的配置文件"**（**本次审查发现，见 §7**）：`public/_headers` 的
  路径规则是按挂载点写死的，而它既不在 `public/ui_v1`、也不在 `test/`、也不在 `public/ui/`
  这三轮替换的范围里 ⇒ 规则全留在 `/ui_old/*`，两版前端**同时**退回平台默认的 `max-age=0`，
  而当时**没有任何守卫读它**（`docs.test.ts` 只数文件总数）。教训：按目录替换时，要单独列一份
  「含路径字面量的配置文件」清单（`_headers` / `robots.txt` / `wrangler.toml` / `deploy.yml`）逐个过。
- **「快照文档」要按段落切，不能按文件名切**（**独立审计发现，2026-09-19 补**）：`docs/backend-gaps.md` 是
  「**活的正文 + 冻结的 `文件:行` 证据**」的混合体（文件头明写「`文件:行` 取自 `master`（`509bdef`）」，
  以及「§1–§3 里引用的 V2 路径按快照保留原样，改了就篡改历史」），而第 ①／③ 轮那次 `public/ui/` →
  `public/ui_v2/` 把它一起改了 ⇒ 快照里出现了**在快照那一天并不存在**的名字，且与它自己的声明矛盾。
  `e559b4c` 只改回 2 处（文件头示例、§1.2），漏了 §2.1 / §2.9 / §6 三处 —— 同一个文件里
  **一半旧名一半新名**，比两种极端都更糟。教训：**「哪一段是快照」要逐段判**，不能按文件名判：
  `docs/AUDIT-*.md` 整体是快照；`docs/progress.md` 的 §1–§92 是历史段、§94.x 是活的工作记录；
  `docs/backend-gaps.md` 的 §1–§6 是快照、§8 是现状口径。判据与落地见 `docs/progress.md` §94.8。

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
（`git show 796a3b8:public/ui_old/css/archive.css` 能取回整个样式文件 —— **不能用 `HEAD`**：
改名之后 `public/ui_old/` 在 HEAD 里已不存在，那条命令会以 exit 128 失败）。

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
## 7. 事后修正（2026-09-19 审查轮）

`e3858cd` / `9357f59` 推送后做了一次逐文件审查，抓出**一处功能性漏改**与一批机械替换打偏的
文档句子。原因分析见 §3 的倒数第二条。

**① `public/_headers` 整份没跟着改名（唯一影响运行的一处）**

| | |
|---|---|
| 症状 | 规则仍挂在 `/ui_old/js/*`、`/ui_old/css/*` 与 `/ui_old/` 的四个图标/manifest 上 —— 这些路径改名后都不存在了 |
| 线上实测 | `/ui/js/redirect-hash.js` 拿到 `public, no-cache, must-revalidate`；而 `/ui_v1/js/format.js`、`/ui_v2/js/boot.js`、`/ui_v1/favicon.svg` 全部只剩 `public, max-age=0, must-revalidate`（平台默认） |
| 影响 | 两版**同时**丢掉"每次回源验证"的纪律（该文件自己的注释写着"靠平台默认值正是明确不要的东西"），图标/manifest 的长缓存也丢了；而 `docs/frontend-checklist.md` 的 P0-3 还写着"✅ 已完成" |
| 修法 | 按三个挂载点重写规则：`/ui/js/*` 保留（跳转壳的 `redirect-hash.js` 也是代码资源）、`/ui_v1` 与 `/ui_v2` 各一条 js/css 禁令 + 各自的图标/manifest 长缓存、`/ui/` **不写**图标规则（那一面根本没有图标文件） |
| 防复发 | `test/ui-guard.test.ts` 新增两条结构判据：规则路径必须在 `public/` 下真实存在；三个挂载点里**有** js/css 目录的都必须有 `no-cache, must-revalidate` 规则 |

**② 机械替换打偏的文档句子**（`/ui/` → `/ui_v2/` 那一轮打到了"主语是 `/ui/` 跳转壳"和
"历史叙述"的句子上）：

| 文件 | 修前（错） | 修后 |
|---|---|---|
| `AGENTS.md` §3 | 「`/ui_v2/`（`public/ui_v2/`）只剩一层跳转壳」「`/ui/api/*` 必须以 `/ui_v2/` 为前缀」 | 两处都改回 `/ui/`。原句后面紧跟着"别把接口前缀跟着改名"的警告，等于自己演示了那个错误 |
| `AGENTS.md` §2 | V2 探针 `--url /ui/app/` | `--url /ui_v2/app/` |
| `AGENTS.md` §3 | 「`ui-guard` 禁止它引用 `../../ui/`」 | `../../ui_v2/`（守卫实际拦的就是它） |
| `docs/design.md` §4 | 目录树**没重建**：`ui/` 被当成 V2 的家、没有 `ui_v2/` 条目、`ui_v1/css` 里还列着已删的 `archive` | 重建成 `ui_v1/` + `ui_v2/` + `ui/`（跳转壳）三条；`_headers` 那句"短 TTL 与 stale-while-revalidate"也订正（那是 2026-09-17 就删掉的取值） |
| `docs/ui-v2-design.md` §7 | 同上；且 `redirect-hash.js` 被放在 V2 的 `js/` 下（**实际只在 `public/ui/js/`**）；`ui_v1/` 被写成"冻结存档，加弃用横幅"；样式表数写 7 | 重建成三条；`redirect-hash.js` 归到 `ui/`；`ui_v1/` 改成"默认界面 V1（**产品面**）"；6 张样式表 |
| `docs/ui.md` §3.2 / §7 | V1 文件清单仍列着**已删除**的 `css/archive.css`（同一文件 §3 的计数表已写"38 → 37"）；§7 的 `:active` 小节仍把 `archive.css` 与 `.notice-bar__close` 当现存目标 | 删掉那一行；两处清单里的 `archive.css` / `.notice-bar__close` 一并移除 |
| `docs/frontend-checklist.md` §2 | 历史叙述被改成「2026-09-15 的 `/ui_v2/` → `/ui_v1/` 批量改写」（真事件是 `/ui/` → `/ui_old/`，而这两个名字 2026-09-19 才存在） | 改回 `/ui/` → `/ui_old/` |
| `docs/frontend-checklist.md` P0-3 | 「`/ui_v1/*` 的缓存策略 ✅ 2026-09-17 完成」 | 「2026-09-17 完成、2026-09-19 改名后**补回**」，并写明这次漏改与现在的守卫 |
| `docs/protocol.md` | 「省去一次从 `/ui_v2/` 的跳跃」（应为 `/ui/`）；「`/ui_v2/*`（静态资源 + `/ui/api/*`）」把接口也算进了 `/ui_v2/` | 两处订正 |
| 本文件 §4 | 回滚命令写 `git show HEAD:public/ui_old/css/archive.css` —— HEAD 里没有这个路径（实测 exit 128） | 改为 `796a3b8`，并注明不能用 `HEAD` |

**③ 审查里核过、确认无误的部分**（记下来免得下次重复劳动）：三个挂载点的配置与路由全同步正确
（`wrangler.toml` 的六模式、`src/index.ts` 的 `isUiApi` 优先 + `isUiAsset` 三前缀、
`deploy.yml` 的冒烟五条路径与关闭态三前缀、`package.json` / `eslint.config.js`）；
图标与 manifest **没有被两版互换**（用提交对象哈希逐对比对）；`ui-guard` 改名后**守卫没被改瞎**
（`checked>20`、`selectors.length>5`、`files.length>15/20`、`hits>0` 这些反空转断言都在）；
`docs/ui.md` 的资源数 89 → 88 与实测一致（37 + 47 + 2 + 2）；V1 提示条移除干净（`archive.css` 的
`<link>` 已删、无悬挂引用）；F1/F2/F5 三条实现正确（**F3 在第二轮复审里被推翻** —— 它漏了 `search`，见 §8）；其余 17 处小改动逐行核对全是纯路径替换。

## 8. 第二轮复审的补正（2026-09-19，同日）

用户要求"审查最近的 3 个提交"时做的第二轮复审，补出 §7 漏掉的两处 —— 所以 §7 虽然题为"事后修正"，
它并**没有**把改名的遗留清空。逐条记载见 `progress.md` §91。

| # | 补正内容 |
|---|---|
| ① | 新增的判据 ② 里，挂载点前缀是**硬编码**的（`['/ui', '/ui_v1', '/ui_v2']`）⇒ **只防改名、不防新增**：将来加 `/ui_v3` 而忘了给 `_headers` 加规则时两条判据都不会红。已改为从 `public/` **动态发现** `ui*` 目录 |
| ② | `test/manual/states.mjs`（15 处）与 `shoot.mjs`（2 处）仍是 `${BASE}/ui/app/` **死路径** —— 这是同一次替换的另一个**字符类盲区**：`${BASE}` 后面是 `}`，不在替换模式的 `(["'`(]` 字符类里；且它们**不进门禁**（`manual/*.mjs` 不匹配 `*.test.*`），所以 CI 不会红。已全部改为 `/ui_v2/app/` |
| ③ | `shoot.mjs` 的注释被替换打偏：「`/ui_v2/` 是只做跳转的目录索引」—— **语义反了**，跳转壳在 `/ui/`。已订正 |

> **§7 为什么会漏**：它的残留检查覆盖的是"被引用的文件路径"与"配置/测试里的路径字面量"，
> 而 `test/manual/**` 里的是**运行时导航 URL**（`Page.navigate` / `goto` 的模板字符串）——
> 这是另一类判据。教训见 `progress.md` §91.5。

## 9. 第三轮：散文里的"地名"（2026-09-19，同日；详见 `progress.md` §92）

§8 那一轮把补正收在**路径 / 配置字面量 / 运行时 URL** 三类上，仍漏了第四类残留 ——
**句子里的地名**：`docs/ui.md` §2（架构与边界）与 `docs/design.md` §5 里有一批句子把"哪一面"说错了。
它们不是路径引用，所以前两轮的逐文件审查与 `grep` 都扫不到。

典型几条（全表见 `progress.md` §92.1）：`GET /ui/**` 被说成 `public/ui_v2/**`（它是跳转壳）；
`run_worker_first` 列成 `["/ui", "/ui_v2/*", "/ui_v1", "/ui_v1/*"]`（缺 `/ui/*` 与 `/ui_v2`）；
「`/ui_v2/` 的目录索引（`public/ui_v2/index.html`）」——**该文件根本不存在**（真身是
`public/ui/index.html`）；「`/ui` 由静态资源层重定向到 `/ui_v2/`」；「eslint 只覆盖 `public/ui_v2/js`」。

| # | 内容 |
|---|---|
| ① | 改动量按 `git diff --numstat`：`docs/ui.md` +23/−22、`docs/design.md` +3/−3、`docs/ui-v2-design.md` +1/−1；归并为 **19 类**地名/计数订正（逐类明细见 `progress.md` §92.1 的表） |
| ② | 守卫的"防新增"只改了一半：§8 已把 `_headers` 判据②改成动态发现，而 `run_worker_first` 的断言与 `src/index.ts` 的 `isUiAsset` 仍是**硬编码三前缀** ⇒ 本轮三处统一为"从 `public/` 动态发现"，各补反向断言（死模式 / 集合相等）；三条判据另从「V1 的样式层契约」describe 里**摘出来单独成组**（原先失败信息会指向样式层）。变异实验 4/4 见 `progress.md` §92.2 |
| ③ | `test/manual/probe.mjs` 的 `kinds` 读 `.kinds__item`（**无生产者**）⇒ 探针在空转，改读筛选条 chips |

> **四类残留的排查顺序（改名 / 搬目录通用）**：① 被引用的文件路径 → ② 配置与测试里的路径字面量
> → ③ 运行时导航 URL（`Page.navigate` / `goto` 的模板字符串）→ ④ **散文里的地名**
> （`grep -n '/ui_v2/'` 之后逐行问"它到底指哪一面"）。§7 补了 ①②、§8 补了 ③、本节补 ④。