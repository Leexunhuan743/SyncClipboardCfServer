# 根目录变更审计：`6ebcf6e` → `da1ee44`（`.github/` + `AGENTS.md` + `README.md` + `eslint.config.js` + `package.json` + `wrangler.toml`）

> **审计对象**：仓库根目录下那 6 个在 `6ebcf6e..HEAD` 里被改过的文件，**每一处** diff。
> **产出**：本文档。逐文件、逐 hunk 列出，逐条给核实结论。
>
> **口径声明**：本轮**按用户要求未运行任何测试、未写任何分析脚本**（未起 dev server、未跑 vitest、
> 未跑 tsc/eslint、未跑 `test/manual/*.mjs`）。因此本文里所有"核实"都指**静态核实**
> （逐字比对源码/注释/配置/提交历史），**不构成"门禁已过"**——按 `AGENTS.md` §1 的惯例，
> 未验证的部分在提交信息里也必须写明"未验证"。
>
> 这是第五份同族台账（§96 `src/` 91 处、§97 `public/` 208 处、§99 `test/` 79 处、§100 `docs/` 101 处），
> 同一句用户指令、同一套口径，对象换成**前四份都没覆盖的根目录**。

---

## 0. 为什么还有第五份：前四份台账的**覆盖边界**正好把根目录留在了外面

| 台账 | 目录 | 文件数 |
|---|---|---|
| §96 | `src/**` | 19 |
| §97 / §98 | `public/**` | 90 |
| §99 | `test/**` | 14 |
| §100 | `docs/**` | 17 |
| **本文** | **仓库根目录的 6 个配置/文档文件** | **6** |

四份台账合计 140 个文件，**不是** `6ebcf6e..HEAD` 的全部 146 个 —— 差额正是根目录这 6 个。
`git diff --name-status 6ebcf6e HEAD` 里的 `M  AGENTS.md` / `M  README.md` /
`M  wrangler.toml` / `M  package.json` / `M  eslint.config.js` / `M  .github/workflows/deploy.yml`
这六行，在前四份台账里都只作为**判据来源**出现过，谁都没有把它们当成**审查对象**。
「一处没漏」这句话，只有在把这条差额说出来之后才成立。

## 1. 范围与计数（三数对账 ⇒ 一处没漏）

| 口径 | 读数 | 怎么得到 |
|---|---|---|
| 文件数（本台账） | **6** | `git diff --shortstat 6ebcf6e HEAD -- .github/ AGENTS.md README.md eslint.config.js package.json wrangler.toml` → `6 files changed` |
| ±行数（本台账） | **+106 / −65** | 同上 |
| hunk 数 | **45** | 数 `.audits/root-u0.diff` 里的 `@@` 行（`git diff -U0` 的重定向产物，不是脚本） |
| 文件头数 | **6** | 数同一文件的 `diff --git` 行 |
| §2 表逐文件 hunk 数**相加** | 7+12+13+5+1+7 = **45** | 与 `@@` 行数**相等** |
| 同一段按 `-U3` 数 | 26 | 数 `.audits/root.diff` 的 `@@` 行 —— **口径不同，数字不同，别混用**（见 §7 第 1 条） |

**全仓对账（这是"一份没漏"的证明）**：

| 目录 | 文件 | +行 | −行 |
|---|---|---|---|
| `src/` | 19 | 177 | 111 |
| `public/` | 90 | 1706 | 773 |
| `test/` | 14 | 1242 | 227 |
| `docs/` | 17 | 3465 | 203 |
| **根目录（本文）** | **6** | **106** | **65** |
| 合计 | **146** | **6696** | **1379** |

与 `git diff --shortstat 6ebcf6e HEAD` 的 `146 files changed, 6696 insertions(+), 1379 deletions(-)`
**逐位吻合**，且文件数 146 已由四份台账 + 本文 **100% 覆盖**（无"结构上不可能有 hunk"的例外项：
本范围内没有二进制文件，5 个 `R100` 纯改名全在 `public/`，已在 §97 记账）。

## 2. 按文件总览（6 项 / 45 个 hunk）

| 文件 | 变更性质 | hunk | 结果 |
|---|---|---|---|
| `.github/workflows/deploy.yml` | 改名跟随（界面路径与冒烟断言） | 7 | ⚠️ 3 处（R-1 排版 / R-3 注释与代码不符 / R-6 措辞） |
| `AGENTS.md` | 改名跟随 + 新增两行/两段 | 12 | ✅ 12/12 成立（1 处口径偏松已登记，见 §4 末） |
| `README.md` | 改名跟随 + 事实订正 + 新增文档表 4 行 | 13 | ⚠️ 2 处（R-2 关闭态路径清单 / R-4 头部与 404 页前缀） |
| `eslint.config.js` | 改名跟随 | 5 | ⚠️ 1 处（R-5 自相矛盾） |
| `package.json` | 改名跟随 | 1 | ✅ 1/1 成立 |
| `wrangler.toml` | 改名跟随 + 版本号订正 | 7 | ✅ 7/7 成立 |
| 合计 | | **45** | ✅ 39 · 🩹 6（**另加 1 条不在 hunk 上**：R#38 引出的横幅数字口径 —— R-7，见 §4） |

**图例**：✅ 正确｜🔁 等价（纯改名/纯空白）｜🩹 **缺陷（已在本轮修）**｜⏸ 登记但本轮未动（写明了理由）

## 3. 逐处台账

位置 = `HEAD` 内容里的行号。变更列里的 `−a/+b` 是 `-U0` 该 hunk 的删/增行数。

### 3.1 `.github/workflows/deploy.yml`（7 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| R#1 | `deploy.yml:76` | Lint 步骤名 `public/ui/js` → `public/ui_v*/js` −1/+1 | ✅ 正确 | `tsconfig.json:17` 的 `include` 只有 `["src","test"]` ⇒ `public/**` 确实不在 tsc 射程内；`ui_v*` 一次覆盖 `public/ui_v1/js` 与 `public/ui_v2/js`（两目录都在） |
| R#2 | `deploy.yml:352` | ⑤ 段头改写（两个挂载点 → 三个）−4/+4 | 🩹 **R-1**：文字正确，但**四行整体多缩进 2 格** | 同段落其余 6 行（348-351、356-357）都是 **8 空格**，这 4 行改成了 **10 空格**。这是**改名那次编辑的意外**（像编辑器自动缩进）：该块是 YAML 的 step 映射注释（`env:` 在 :358、`run: \|` 在 :365），YAML 注释缩进随意 ⇒ **语义不变**，但视觉上会让读者误以为这 4 行属于下面的 shell 脚本 |
| R#3 | `deploy.yml:421` | 「两个挂载点各一对」→「每个挂载点各一对」 −1/+1 | 🩹 **R-3**：改后**与代码不符** | 注释承诺"页面 + 入口 JS **成对**"，改后说的是**三个**挂载点 ⇒ 3 对 = **6 条**；而该处只有 **5 条** `check_asset`（`/ui/` 只查了页面，没查它的入口 JS）。`/ui/js/redirect-hash.js` 是真实存在的代码资源（`_headers` 还专门为它保留 `/ui/js/*` 规则），漏查意味着它坏掉时冒烟仍绿 |
| R#4 | `deploy.yml:427` | 历史叙述改写（V1 那一对 + 2026-09-19 改名）−4/+3 | 🩹 **R-6**：事实成立，一行内两个「它」 | 事实面逐条核过：V1 那一对是 2026-09-17 补的（`git show 6ebcf6e:.github/workflows/deploy.yml` 里那两条已在）；2026-09-18 V1 成为默认界面并补进 `run_worker_first`（`docs/progress.md` §70）。措辞面："它重新纳入维护后，／它同样要有"两个「它」连读指代混乱 |
| R#5 | `deploy.yml:449` | 「两个挂载点都必须 404」→「三个」 −1/+1 | ✅ 正确 | 与 :451 的 `for p in /ui/ /ui_v1/ /ui_v2/` 一致 |
| R#6 | `deploy.yml:451` | `for p in /ui/ /ui_old/` → `/ui/ /ui_v1/ /ui_v2/` −1/+1 | ✅ 正确 | 三个前缀正是 `wrangler.toml` 的 `run_worker_first` 六模式与 `src/index.ts:237-243` 的 `isUiAsset` 所覆盖的集合；且 `test/ui-guard.test.ts:189-272` 有关闭态逐一 404 的同名断言 |
| R#7 | `deploy.yml:461` | 五条 `check_asset` 重排 + 改名 −5/+5 | ✅ 正确 | 五个路径逐条落到真实文件：`/ui/`→`public/ui/index.html`、`/ui_v1/`→`public/ui_v1/index.html`、`/ui_v1/js/main.js`→存在、`/ui_v2/app/`→`public/ui_v2/app/index.html`、`/ui_v2/js/boot.js`→存在（`public/ui_v2/app/index.html:41-72` 的 `modulepreload` 清单里就有 `/ui_v2/js/boot.js` 的兄弟，入口名对得上）。`/ui/*`、`/ui_v1/*`、`/ui_v2/*` 都在 `run_worker_first` 里 ⇒ 都会先进 Worker |

### 3.2 `AGENTS.md`（12 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| R#8 | `AGENTS.md:9` | **新增**「引文说明」10 行 −0/+10 | ✅ 正确 | 三处引用都能落到实物：`docs/design.md:53` 的 D14 逐字是「限于设计系统与打磨层，不走它的页面蓝图路径」；`docs/ui.md:273` 是硬约束第 **19** 条（表单错误挂到字段上）；`docs/progress.md:4741` 是 §69.1（状态矩阵九格）。九格枚举（rest/hover/`:active`/`:focus-visible`/disabled/loading/error/empty/success）与 `docs/progress.md` §69.1 一致 |
| R#9 | `AGENTS.md:31` | `public/` 行：三行分表 → V1 / V2 / 跳转壳 / 站点根分表 −1/+1 | ✅ 正确 | `docs/ui.md:142`「`public/` 下共 88 个资源，分四部分」；§100 台账实测该分表为 37/47/2/2 = 88，且 `public/` 实际就是这四个部分 |
| R#10 | `AGENTS.md:32` | V2 模块行 `public/ui/app/` → `public/ui_v2/app/` −1/+1 | ✅ 正确 | 两个页面都在且都有 `modulepreload`：`public/ui_v2/app/index.html:41-72`（32 项）、`public/ui_v2/app/login.html:25-28`（4 项） |
| R#11 | `AGENTS.md:34` | 套件数位置补上 `AGENTS.md` −1/+1 | ✅ 正确 | `test/docs.test.ts:84-90` 的 `CURRENT_STATE_FILES` 逐字是 `README.md` / `AGENTS.md` / `docs/design.md` / `docs/ui.md` / `.github/workflows/deploy.yml` —— **5 个文件** |
| R#12 | `AGENTS.md:35` | messages.js 行改写 −1/+1 | ✅ 正确 | `test/ui-guard.test.ts:485-486` 明写「锚点 = **第一条 import 语句**」，`:497-499` 比对两份正文；两份 `messages.js` 的文件头确实不同（V1 那份解释"为什么自己有一份"） |
| R#13 | `AGENTS.md:36` | **新增**行：截断 / 字符数 −0/+1 | ✅ 正确 | 两版各有一份 `format.js`：`public/ui_v1/js/format.js:112` 与 `public/ui_v2/js/format.js:136` 都写着「见 `docs/archive/AUDIT-v1-v2-divergence.md` §5.3」，即 `truncateText()`/`charCount()` 的出处；两处同名实现**不共享**（各在自己目录内） |
| R#14 | `AGENTS.md:37` | **新增**行：V1 结果区形态 / 行高 −0/+1 | ✅ 正确（数字逐个复算） | ①「`setView()` 是唯一开关」：`public/ui_v1/js/components/list.js` 里 `table.hidden`/`empty.hidden` 的**写**只出现在 `:346-347`（`setView` 函数体内），`:917` 是**读**；②「`8+8+1+30 = 47px`」：`public/ui_v1/css/components.css:684` 与 `:1571-1572` 两处同式，`.skeleton__row { height: 47px }`（`:1591`）；③「卡片档 ≤860px / 103px / 粗指针 117px」：`:1578` 与 `:1912-1948` 那一块（`2*10 + 1 + var(--sp-1) + 48 + 30 = 103`，粗指针 `103 + (44 − 30) = 117`）；④ `public/ui_v1/index.html` 里那份静态骨架确实存在（`docs/progress.md:7094` 记有 `index.html:88-89`）；⑤ 2026-09-18 那个"只给 `update()` 加了骨架档"的实测在 `docs/AUDIT-missing-states.md:67` 与 `:420`（`showError()` 只 `setView('empty')`）；⑥ 同哨兵值另写一份在 `docs/AUDIT-missing-states.md` 内（分页、统计条各自的判据） |
| R#15 | `AGENTS.md:41` | 「3~4 处（套件数 4 处…）」→「3~5 处（套件数 5 处…）」 −1/+1 | ✅ 正确（本轮把同句三个数字的**边界**补全） | 「套件数 5 处」逐位成立：`README.md:135/208/468`、`AGENTS.md:53/76`、`docs/design.md:495/548`、`docs/ui.md:655`、`deploy.yml:56` ⇒ **5 个文件**，与 `docs.test.ts` 的名单完全一致。同句后半「资源数 2 处」「V2 目录树 3 处」是**未改动**的旧数字，两个都需要读者猜边界（本仓自己的判据：「只要一个数字需要读者猜它的边界，它就已经错了」）⇒ **本轮把三处边界都写进句子里**：套件数 = `docs.test.ts` 的 `CURRENT_STATE_FILES` 那 5 个文件；资源数 2 处 = `docs/ui.md` §3 的总数 + 分表；目录树 3 处 = `docs/design.md` §4 + `docs/ui-v2-design.md` §7 + `README.md` 的 `public/` 行（三处都逐字核到） |
| R#16 | `AGENTS.md:43` | `docs.test.ts` 只校验 4 个文件 → 5 个 −2/+2 | ✅ 正确 | `test/docs.test.ts:84-90`（同上 R#11） |
| R#17 | `AGENTS.md:50` | **新增**两条流程惯例 + 失败形态 16 行 −0/+16 | ✅ 正确 | 逐条有据：① `git log -1 --format=%B d32631b` 的正文逐字含「**vitest 未跑完**（按用户指示"别跑测试"时中断于 `transports.test.ts`，日志无汇总行）⇒ "22 套件全过"这一条**本次未验证**，不得当作已通过引用」；② `d0c58bd` 的 33 个文件**全在** `public/**` 与 `test/**`（代码 + 它的断言），`796a3b8` 的 9 个文件**全在** `AGENTS.md`/`README.md`/`docs/**`（纯文档）——「只改代码 / 只改文档」成立；③ `e3858cd` 的文件清单是 **121 项**（`git diff --shortstat e3858cd~1 e3858cd` → `121 files changed`），其中**确实没有** `public/_headers`，`test/manual/*.mjs` 那 4 个文件被它改过但漏了 17 处死路径（`d32631b` 的提交信息自己写了「还有 **17 处死路径**：`states.mjs`(15) 与 `shoot.mjs`(2)」）；④ `7f4de45`(09:45) → `d32631b`(10:19) → `1149af0`(11:24) 三笔的**时间序**确为升序；⑤ `c4a9b93`(11:24) + `60c510f`(11:32) 两轮收敛，且「**仍有漏网**」在本轮**被再次证实**（见 R-2 / R-4 —— 两处都是同一类残留） |
| R#18 | `AGENTS.md:72` | DoD 第 2 条 lint 命令 −1/+1 | ✅ 正确 | `package.json:12` 的 `lint` 逐字相同：`eslint public/ui_v2/js public/ui_v1/js` |
| R#19 | `AGENTS.md:79` | DoD 第 5 条 V2 探针 url + V1 探针文件名 −2/+2 | ✅ 正确 | `test/manual/probe.mjs` 与 `test/manual/probe-ui-v1.mjs` 都存在（后者是 `e3858cd` 里由 `probe-ui-old.mjs` 改名而来） |
| R#20 | `AGENTS.md:88` | §3 表头两版路径 −1/+1 | ✅ 正确 | `public/ui_v1/`、`public/ui_v2/` 都是真实目录 |
| R#21 | `AGENTS.md:90` | 定位行改写（根路径 302 + 挂载点） −1/+1 | ✅ 正确 | `src/routes/webdav.ts:37`：`if (accept.includes('text/html') && isUiEnabled(c.env)) return c.redirect('/ui_v1/', 302);` ⇒ "根路径 302 到这里"成立；"V2 应用本体在 `/ui_v2/app/`"与 `public/ui_v2/app/index.html` 一致 |
| R#22 | `AGENTS.md:93` | **新增**跳转壳说明 4 行 −0/+4 | ✅ 正确 | `public/ui/` 下**只有 2 个文件**（`index.html` + `js/redirect-hash.js`），与括号里的枚举逐字一致；接口命名空间的理由与 `src/ui/routes.ts` 的 `guarded.use('/ui/api/*', …)` 一致；「2026-09-15 翻过一次车」与 `docs/ui-rename-v1-v2.md` §0「为什么这不是一次 sed」及 `test/ui-guard.test.ts:502-503` 的说明同源 |
| R#23 | `AGENTS.md:98` | V1 自包含 + messages.js 两条 −2/+3 | ✅ 正确 | `test/ui-guard.test.ts:458-479`：判据是**结构性**的「`resolveFrom(id, spec).startsWith('..')`」⇒ 注释说的「禁止它引用 `../../ui_v2/`」正是这条判据要拦的形状（`:468-471` 明写"以前要拦的是跨到 `/ui/`，现在是跨到 `/ui_v2/`"） |
| R#24 | `AGENTS.md:127` | qf-* 夹具的引用改指 §52/§20 −1/+1 | ✅ 正确 | `git show 6ebcf6e:AGENTS.md` 原文是 §16.8，而全仓**没有** §16.8；现状确在 `docs/progress.md:3318`（§52 的"**仍未做**"小节）与 `:980`（§20）。改动理由逐字记在 `docs/progress.md:5997`（§93 的表格行） |

### 3.3 `README.md`（13 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| R#25 | `README.md:41` | 默认界面 `/ui_old/` → `/ui_v1/` −1/+1 | ✅ 正确 | 与 `src/routes/webdav.ts:37` 的 302 目标一致 |
| R#26 | `README.md:86` | 静态资源行重写（三个面 + run_worker_first） −1/+1 | ✅ 正确 | 括号里的「覆盖 `/ui`、`/ui_v1`、`/ui_v2` 及各自的 `/*`」与 `wrangler.toml` 的六模式**逐字同义**；「开着转回 `env.ASSETS.fetch()`、关着一律 404」与 `src/index.ts:249-256` 一致 |
| R#27 | `README.md:98` | 端点表 `GET /` 的 302 目标 −1/+1 | ✅ 正确 | 同 R#25 |
| R#28 | `README.md:203` | 部署触发白名单补 `eslint.config.js` −1/+1 | ✅ 正确 | `deploy.yml:46`：`- 'eslint.config.js'       # 前端静态检查的配置（改坏了 lint 门禁就失效）` |
| R#29 | `README.md:251` | `UI_ENABLED` 行整行改写 −1/+1 | 🩹 **R-2**：关闭态的路径清单漏了两项 | 原文（`6ebcf6e`）是 `/ui`、`/ui/*`、`/ui_old`、`/ui_old/*` —— 正好是**当时 `run_worker_first` 的四个模式**。改后成了 `/ui`、`/ui_v2/*`、`/ui_v1`、`/ui_v1/*`：**`/ui/*` 被 `/ui_v2/*` 顶掉了**，且裸 `/ui_v2` 从未补上。而真实行为是 `src/index.ts:237-243` 的 `isUiAsset` 六个形状全 404，`src/uiEnabled.ts:9-11` 也逐字写着「三个界面前缀（`/ui/...`、`/ui_v1/...`、`/ui_v2/...`，含静态资源）…一律 **404**」。同一事实的第三处副本（`wrangler.toml` 的 UI_ENABLED 注释）在**工作区**里已经写对了（见 §5）—— 只有 README 这处漏了 |
| R#30 | `README.md:325` | Web 界面章节的入口 −1/+1 | ✅ 正确 | 同 R#25 |
| R#31 | `README.md:338` | 深链接两条 + 新增一行 −2/+3 | ✅ 正确 | 三句逐条核过：`/ui_v1/#Text-<hash>` 直达（V1 有页面）；`/ui/#Text-<hash>` 由壳带 fragment（`public/ui/js/redirect-hash.js` 就是这个用途）；「`/ui_v2/` 本身没有页面，落到 404 页」成立 —— `public/ui_v2/` 下**没有** `index.html`（只有 `app/`、`css/`、`js/` 与图标/manifest），且 `/ui_v2/*` 在 `run_worker_first` 里 ⇒ 进 Worker ⇒ `ASSETS.fetch` 404 ⇒ `notFoundPage`（`src/index.ts:254-256`） |
| R#32 | `README.md:373` | `[cleanup]` 行补 `reason=` 的口径 −1/+1 | ✅ 正确 | `src/cleanup.ts:534-537` 的 `DISABLED_KEY`：`retention: { meta: SETTINGS_META_KEYS.retentionMinutes, env: 'HISTORY_RETENTION_MINUTES' }`，而 `:132` 的 `SETTINGS_META_KEYS.retentionMinutes = 'settings:retentionMinutes'` ⇒ 注释举的两个串**逐字命中**；`:547` 还写明「第三种来源（内置默认 10080 / 1000）不可能是 0」 |
| R#33 | `README.md:378` | `console.*` 调用点 12 → 14 −1/+1 | ✅ 正确（**本轮可机械复算**） | 全仓 `console.(log\|warn\|error\|info\|debug)` 命中 **16 行**，其中 2 行在**注释**里（`src/index.ts:197`、`src/rateLimit.ts:31`）⇒ 调用点 = **14**：`auth.ts:128`、`cleanup.ts:264/646/672`、`durable/SyncClipboardHub.ts:142/429`、`index.ts:293/298`、`rateLimit.ts:91/340`、`requestLimits.ts:49`、`routes/history.ts:217/328/351` |
| R#34 | `README.md:412` | 弱凭据行的出处 `src/auth.ts` / `src/requestLimits.ts` → `src/auth.ts` −1/+1 | ✅ 正确 | 弱凭据那一条链**全在** `src/auth.ts`：`hasWeakCredentials`（:107）、`warnWeakCredentials`（:124）、`MIN_CREDENTIAL_LENGTH`、`WEAK_CREDENTIAL_VALUES`；`src/requestLimits.ts:49` 打的是**另一条**日志（`[limits] MAX_REQUEST_BODY_BYTES 取值无效…`），与弱凭据无关 ⇒ 删掉它是对的 |
| R#35 | `README.md:413` | `_headers` 行改写（缓存口径 + 404 页前缀） −1/+1 | 🩹 **R-4**：两处不精确 | ① 「只有图标/manifest 走长缓存 + `stale-while-revalidate`」——`public/_headers` 里图标是 `max-age=86400, stale-while-revalidate=604800`，而 manifest 是 `max-age=3600`**且没有** `stale-while-revalidate` ⇒ 半句不成立。② 「Worker 自出的 `/ui_v2/*` 404 页」——`src/ui/notFound.ts:1` 逐字是「界面命名空间（`/ui`、`/ui_v1`、`/ui_v2`）下未匹配路径的 404 页」，`:6` 又写「三个前缀共用这一张」；`src/index.ts:253` 的注释也说「三面共用这条链」。改名前的原文是 `/ui/*`（当时也不完整：`6ebcf6e:src/ui/notFound.ts:1` 写的是「两个界面命名空间（`/ui/*` 与 `/ui_old/*`）」），改名把不完整的写法换成了**更窄**的写法 |
| R#36 | `README.md:466` | `public/` 目录树行 −1/+1 | ✅ 正确 | 与 `public/` 实际三部分一致，且保留「文件清单以 `docs/ui.md` §3 为准」的单一事实源指向 |
| R#37 | `README.md:490` | upstream-defects 行 −1/+1 | ✅ 正确 | `docs/upstream-defects.md:1` 逐字为「21 条候选：A 必须复刻 10 / B 有意偏离 5 / C 结构性消除 2 / D 待办 2 / 不改但需知 2」；算术 10+5+2+2+2 = **21** ✓；`docs/upstream-parity.md:278` 与 `docs/upstream-issues.md:8` 同口径 |
| R#38 | `README.md:497` | **新增** 4 行文档表 −0/+4 | ✅ 3 行成立｜⚠️ 1 处：**数字已复算，横幅已补口径** | 四个被引文件都存在，且三处数字可复算：`AUDIT-missing-states.md` 的"约 18,000 行"属**带日期的估计**（原文自述口径）；`AUDIT-v1-v2-drift` 的"F1–F8"与该文件 §4 的表格行数一致；`ui-rename-v1-v2.md` 的"踩到的八个坑"与该文件 §3 的条目数一致。**归档横幅那组数字（44 / 23 / 28）本轮复算了**：口径 = 「同一行同时含本文档路径与 `§x.y`」，判据 = `git grep -o -h -E 'AUDIT-v1-v2-divergence.*§[0-9]+\.[0-9]+' HEAD -- <范围>` ⇒ `ui_v1/js` **10** ✓、`ui_v2/js` **16** ✓、`src/ui/query.ts` **1** ✓、`test/manual` **3** ✓（四组逐位吻合），但**文档与记忆 17**（原写 14）、**文件数 22**（原写 23）⇒ 整组**不可自洽复原**（`.workbuddy/**` 与未跟踪的 `docs/AUDIT-*-diff-6ebcf6e.md` 不在 `git grep` 视野里）。处置见 §4 的 **R-7** |

### 3.4 `eslint.config.js`（5 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| R#39 | `eslint.config.js:1` | 文件头覆盖范围 −1/+1 | ✅ 正确 | 配置实际覆盖 `public/ui_v2/js/**` 与 `public/ui_v1/js/**`（`:20` 的 `files`） |
| R#40 | `eslint.config.js:4` | `public/ui/**` → `public/ui_v*/*` −1/+1 | ✅ 正确 | `tsconfig.json:17` 的 `include = ["src","test"]` ⇒ 零构建的 `public/**` 真的不在 tsc 里 |
| R#41 | `eslint.config.js:15` | 覆盖说明行改写 −1/+1 | ✅ 正确 | 与 `:20` 的 `files` 两目录一致（V2 是开发测试版、V1 是默认界面，与 `AGENTS.md:88-90` 同口径） |
| R#42 | `eslint.config.js:19` | 「将来 V2 落地或再改名也不会重演」→「将来再改名也不会重演（…就是这么改过来的）」 −2/+2 | 🩹 **R-5**：改后**自相矛盾** | 同一条注释里，前半句断言「将来再改名也**不会重演**」，括号里同一次改动补上的却是「2026-09-19 的 ui_old→ui_v1 / ui→ui_v2 **就是这么改过来的**」—— 后者说的是**确实需要改**（本段的 diff 就是证据：`:20` 的 `files` 与 `package.json:12` 的 `lint` 两处一起改）。"不会重演"是**假的**：这两处仍是**写死的目录名字面量** |
| R#43 | `eslint.config.js:44` | `theme-init` 的 `files` −1/+1 | ✅ 正确 | `public/ui_v1/js/theme-init.js` 与 `public/ui_v2/js/theme-init.js` 都存在，且都是经典脚本（`:45` 给它们单独关掉 `no-var`） |

### 3.5 `package.json`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| R#44 | `package.json:12` | `lint` 脚本的目录参数 −1/+1 | ✅ 正确 | 两个目录都存在；与 `AGENTS.md:72` 的 DoD 第 2 条**必须同步**（`eslint.config.js:19-22` 现在明写了这条要求） |

### 3.6 `wrangler.toml`（7 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| R#45 | `wrangler.toml:35` | 迁移项目版本号 1.21.3 → 1.25.2 −1/+1 | ✅ 正确 | `package.json:3` 的 `"version": "1.25.2"`（`git show 6ebcf6e:package.json` 里早就是 1.25.2，旧注释只是没跟上）；上方两行说明"版本唯一事实源另在上游"仍成立 |
| R#46 | `wrangler.toml:70` | 静态资源段头重写（三个挂载点） −3/+8 | ✅ 正确 | 三个映射逐条核对：`/ui_v1/ ← public/ui_v1/`、`/ui_v2/ ← public/ui_v2/`（本体在 `/ui_v2/app/`）、`/ui/ ← public/ui/`（只有 `index.html` + `js/redirect-hash.js`）；`/ui/api/*` 的命名空间理由与 `src/ui/routes.ts` 一致 |
| R#47 | `wrangler.toml:76` | `run_worker_first` 说明行 −1/+1 | ✅ 正确 | 与六模式一致 |
| R#48 | `wrangler.toml:79` | 「只有这两个模式进 Worker」→「只有这几个模式」 −1/+1 | ✅ 正确 | 4 → 6 个模式，"这几个"是合适的模糊量词（写成"六个"反而会成为新的漂移点） |
| R#49 | `wrangler.toml:82` | `ui_old` 段头 → 「为什么 V1 这一面**必须**在名单里」 −2/+1 | ✅ 正确 | 这段叙述的是 **2026-09-18 那次**（当时真名确实是 `/ui_old`），新写法用**今天的标签** V1 + 明确的时间点，符合本仓判据（「可接受 = 用今天的名字指代今天的实体 + 给出某状态起始的日期」）。删掉历史路径名但不留错误指代 |
| R#50 | `wrangler.toml:84` | 代价行 −1/+1 | ✅ 正确 | 与上文同源 |
| R#51 | `wrangler.toml:86` | `/ui_old/` → V1，并删掉"代价"那一行 −3/+2 | ✅ 正确 | 行为面：关闭态 V1 确实整个服务不出去（`test/ui-guard.test.ts:275-298` 逐路径断言）；`run_worker_first` 里 `/ui_v1`、`/ui_v1/*` 都在 ⇒ 那条"边缘直出、开关管不住"的旧结论今天不成立。**新加的守卫指针**（"守卫见 test/ui-guard.test.ts"）确指 §3 的挂载点判据组 |

---

## 4. 查出的问题（7 条，全部已处置）

| 编号 | 位置 | 问题 | 处置（本轮） |
|---|---|---|---|
| **R-1** | `deploy.yml:352-355` | 改名那次的编辑意外多缩进 2 格：同段落其余 6 行是 8 空格，这 4 行是 10 空格（YAML 注释缩进随意 ⇒ **语义不变**，但会被读成 shell 脚本的一部分） | 改回 8 空格（内容一个字未动） |
| **R-2** | `README.md:251` | `UI_ENABLED=false` 的路径清单把 `/ui/*` 换成了 `/ui_v2/*`，并漏掉裸 `/ui_v2` —— 与 `src/index.ts:237-243`、`src/uiEnabled.ts:9-11`、`wrangler.toml` 的 UI_ENABLED 注释**三处**都不一致 | 改为六个形状：`/ui`、`/ui/*`、`/ui_v1`、`/ui_v1/*`、`/ui_v2`、`/ui_v2/*` |
| **R-3** | `deploy.yml:421` + `:461` | 注释说「每个挂载点各一对（页面 + 入口 JS）」，实际只有 5 条 —— `/ui/` 的入口 JS 从未被断言；`/ui/js/redirect-hash.js` 坏掉时冒烟仍绿，而"老书签跳不过去"是用户能感知的 | **补第 6 条断言**（该路径已被 `test/ui-guard.test.ts` 的 `_headers` 判据①钉住"规则必须落在真实路径上"），并把 `:429` 的「五条路径」改成「六条」 |
| **R-4** | `README.md:413` | ①「只有图标/manifest 走长缓存 + `stale-while-revalidate`」不成立（manifest 是 `max-age=3600`，无 SWR）；②「Worker 自出的 `/ui_v2/*` 404 页」把三个前缀共用的那张页说成只有 V2 有 | 两处都改准：图标与 manifest 分别写清 TTL；404 页写成「`/ui`、`/ui_v1`、`/ui_v2` 三个前缀共用同一张」 |
| **R-5** | `eslint.config.js:18-19` | 同一条注释自相矛盾：断言"将来再改名也不会重演"，括号里却说"就是这么改过来的"（而本段 diff 正是"必须改"的证据） | 改写为**真话**：改名时 `files` 与 `package.json` 的 `lint` **两处必须一起改**；只改一处时脚本那半会直接失败、配置这半不一定会被人发现 ⇒ 「改完跑一次没红」不能替代逐处核对 |
| **R-6** | `deploy.yml:427` | 一行内两个「它」（「它重新纳入维护后，／它同样要有…」），指代连读混乱 | 合并为一个主语，事实一字未改 |
| **R-7** | `README.md:497` 所引的**归档横幅**（`docs/archive/AUDIT-v1-v2-divergence.md:10-12`） | 横幅那组数字（**44 处 / 23 文件 / 28 编号**）**没有写复算口径**，且与它所在这棵树的实数**已差 3**（写完之后，同一笔提交又补了 `progress.md` §94 的第 18/19 行，而那两行本身在引用本文）⇒ 读者无从复算、也无从发现这个偏差 | **两件事**：① 把**口径**写进横幅（`git grep -o -h -E 'AUDIT-v1-v2-divergence.*§[0-9]+\.[0-9]+' HEAD -- <范围>`，即"同一行同时含本文档路径与 `§x.y`"）；② 给出**按该口径量出来的实数**：四组逐位吻合（10 / 16 / 1 / 3），文档与记忆 **17**（原写 14）、文件数 **22**（原写 23）。**原数字一律保留不回填**（回填会让"当时抽出几处"永远消失，也会造出第三版数字），横幅里明写"要引用请用补记的实数" |

**登记但本轮仍未动的（明确写出来，别当成漏改）**：

| 处 | 内容 | 为什么不动 |
|---|---|---|
| `docs/archive/AUDIT-v1-v2-divergence.md` 横幅的 `28 个编号` | 去重后的 `§x.y` 编号个数 | 已把**口径**写进横幅（见 R-7），但**去重计数本轮没做** —— 复算需要一个"每行只取一次 § 值"的步骤，而本机 `sort`/`uniq` 不可用、用户又明令禁脚本。⇒ 把它标成"未复算"，而不是猜一个数 |

## 5. 工作区未提交段（`HEAD` → worktree）的根目录部分

| 文件 | 变更 | 判定 | 判据 |
|---|---|---|---|
| `README.md` | **新增** 4 行文档表（五份台账里的四份） −0/+4 | ✅ 正确 | 四个文件都在；三处数字已复算（见 R#38）。**注意**：这 4 行写的是"四份台账"，本轮新增的第五份（本文）尚未登记 ⇒ 已在本轮补上（见 §6 末的落地清单） |
| `wrangler.toml` | `UI_ENABLED` 注释补「三个挂载点（`/ui`、`/ui_v1`、`/ui_v2` 及各自的 `/*`，含静态资源）」 −1/+2 | ✅ 正确 | 这正是 R-2 那条事实的**正确写法** —— README 那处漏掉的正是它写对的东西（同一事实在两处的这一对不一致，是 R-2 找出来的方式） |
| `.github/workflows/deploy.yml` | **本轮自己的修复**：R-1 缩进 + R-6 措辞 + R-3 第 6 条断言 | 🩹（已修，见 §4） | 每一处都改在"被别人引用的注释/断言"上，故必须与本文同批落地 |
| `eslint.config.js` | **本轮自己的修复**：R-5 注释改写 | 🩹（已修，见 §4） | 同上 |

工作区段的规模读数**有两个**，两个都留下（历史快照 + 落地实数）：

| 时点 | 范围 | 读数 |
|---|---|---|
| 本轮**动手前**（这一栏的原始值） | `README.md` + `wrangler.toml` | `2 files changed, 6 insertions(+), 1 deletion(-)` |
| 本轮**收尾后**（落笔时） | 上面两个 + 本轮自己的两处修复（`deploy.yml`、`eslint.config.js`） | `4 files changed, 22 insertions(+), 12 deletions(-)` |

> ⚠️ 「工作区段」的数字**天然会腐烂**：它是未提交改动的快照，凡在本台账落笔之后**再改一次这几个文件**，
> 第二行就过期。故这一栏一律带「落笔时」——**本轮的两处修复（R-1 / R-5）自己也进了这一栏**，
> 这正是 §101 那条教训的第三次发作：**台账一边记录工作区段、一边修改工作区，两个动作互相改变对方**。

## 6. 落地清单（本轮改了哪些文件）

| 文件 | 处 | 内容 |
|---|---|---|
| `.github/workflows/deploy.yml` | 3 | R-1 缩进退格（4 行）、R-6 措辞（3 行）、R-3 补第 6 条 `check_asset` + 「五条」→「六条」 |
| `README.md` | 2 | R-2 关闭态六形状（1 行）、R-4 缓存与 404 页两处（1 行） |
| `eslint.config.js` | 1 | R-5 注释改写（18-22 行） |
| `AGENTS.md` | 1 | R#15 的三处数字补**边界**（套件数 / 资源数 / 目录树各写清"数的是哪几处"） |
| `docs/archive/AUDIT-v1-v2-divergence.md` | 1 | **R-7**：横幅加 2026-09-20 补记（口径 + 可复算的实数；原数字保留不回填），只动横幅不动报告正文 |
| `README.md`（文档表） | 1 | 补本文这一行（与本轮四份台账同惯例） |
| `docs/progress.md` | 2 | 追加 §102；**并修回一处自己造成的结构缺陷** —— 上一轮追加 §102 时把 §101「教训」的第 3 条挤到了 §102 末尾（列表被拆成两半），本轮移回 §101 项内 |
| `docs/AUDIT-root-diff-6ebcf6e.md` | — | 本文 |

## 7. 未核实边界（必须与 `✅` 一起读）

1. **门禁一条都没跑**（用户明令「禁止跑测试」）：`tsc --noEmit`、`eslint`、22 个套件、
   四个手动探针全部未运行。本轮新增的那条冒烟断言（R-3）**没有在线上或本地跑过** ——
   它的路径合法性由已有守卫（`_headers` 判据①）与 `run_worker_first` 的模式覆盖共同担保，
   但"线上真的返回 200 且 `Content-Type` 以 `text/javascript` 开头"这句话**本轮未验证**。
2. **`.audits/` 下的分析脚本一个都没跑**（用户明令「禁止脚本」）。本文的范围与计数用的是
   `git`（`--shortstat` / `-U0` 的 `@@` 行数）与读文件，**不是**分析脚本。
3. **`eslint.config.js:16-18` 那三行是上下文行，不在本段 diff 内**，其中「脚本此前写死
   `public/ui/js`」与「以退出码 1 结束」两点本轮**未能核实**：那段历史落在**另一条线上**
   —— `2afb465`（"lint 覆盖两份前端"，2026-09-17）**不是** `0c0a49d`（`public/ui_old/**` 的引入提交，
   2026-09-18）的祖先（`git merge-base --is-ancestor` 非零）。按本仓纪律，**没有证据就不改**，
   登记在此。
4. **`-U3` 与 `-U0` 是两种口径**：同一段 diff 在 26 与 45 之间跳。凡引用本文的处数，
   默认口径是 **`-U0` 的 45**（与 §96 同口径）。
5. **「实测」类数字一个都没复跑**：本文里所有`47px / 103px / 117px / 88 / 37-47-2-2 / 14 处 console`
   都是**读文件读出来的**（源码 + 文档 + `grep -c`），不是跑出来的。其中 `console.*` 的 14 处
   是本轮**唯一**能完全机械复算的一类（分母与分子都数得出来）。
6. **归档横幅那组数字（R-7）**：四组处数已按写明的口径复算且逐位吻合，
   **文档与记忆 17（原写 14）与文件数 22（原写 23）不可自洽复原**；横幅里的 **28 个编号（去重）
   本轮未复算**（本机 `sort`/`uniq` 不可用，用户又禁脚本）。原数字保留不回填。
7. **数"全仓引用"必须说清在哪种"全仓"上数**：`git grep` 只看**已跟踪**文件，
   `.workbuddy/**`（未跟踪）与未跟踪的 `docs/AUDIT-*-diff-6ebcf6e.md` 都不在视野里 ——
   R-7 那两栏复原不了，根因就是这个。同族陷阱本轮自己也踩了一次：先按**工作区**数出
   `ui_v2/js` = 17（横幅写 16），差点报成"横幅少算 1"，换 `git grep` 数 **HEAD 树**才是 16
   —— 那多出来的 1 是**未提交**的 `ui/board.js:35`。

## 8. 教训

1. **"四处台账都说自己覆盖 146 个文件里的 140 个"这种话，只有把差额点名才算对账**。
   前四份台账每一份的范围声明都是真的，合起来却漏了根目录 6 个文件——
   与 §100 那句教训同族：**"每份都真"不等于"合起来全"**。
2. **同一事实的多处副本，改一处就会在另一处留下"更窄的错"**。R-2 / R-4 都是改名类残留的
   同一个形状：机械替换把 `/ui/*` 换成 `/ui_v2/*` 之后，句子**语法仍然通顺、路径仍然存在**，
   只是**范围变窄了**——`/ui/*` 从清单里消失、三个前缀共用的 404 页变成"只有 V2 有"。
   `grep 'ui_v2'` 查不出这一类；只有问"**这半句在说谁、说全了没有**"才能。
3. **"不会重演"是最容易写下、也最容易是假的注释**（R-5）。判据很朴素：
   这句话依赖的那个**机制**（glob？变量？动态发现？）在文件里**找不找得到** ——
   找不到，那它就是一句祝愿。同族的正确写法就在同一个仓库里：
   `test/ui-guard.test.ts:709-712` 那一段解释了为什么把写死的清单改成"从 `public/` 动态发现"。
4. **排版回退值得记一笔，因为它骗过审阅**（R-1）。4 行多缩进 2 格不影响任何行为，
   但它让一段 YAML 注释在 diff 里看起来像 shell 代码——审阅者会因此**跳过**这段，
   而这段正是"冒烟该断言哪几条路径"的唯一说明。
5. **加一条断言，先问"它的路径谁在守"**（R-3）。补 `/ui/js/redirect-hash.js` 之前，
   先用 `test/ui-guard.test.ts` 的 `_headers` 判据①确认那条规则必须落在真实路径上——
   于是在**没跑测试**的前提下，新断言的路径合法性也不是靠"我觉得它对"。
6. **核一个"快照数字"之前，先确认自己在哪棵树上数**。R-7 的两次反转都出在这里：
   ① 按**工作区**数 → `ui_v2/js` = 17，比横幅多 1，差点报成"横幅漏算"；换成 `git grep … HEAD`
   （**已提交树**）→ 16，与横幅逐位吻合，多出来的 1 是**未提交**的 `ui/board.js:35`。
   ② 横幅自己那 3 处的偏差，根因**相反**：它是在写完之后、同一笔提交又补了引用行 ⇒ 数字比树**小**。
   ⇒ 数字与树的对应关系有三种（快照/工作区/文件系统），**不写明是哪一种，核出来的差就是噪声**。
