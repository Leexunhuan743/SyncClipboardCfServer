# 全量逐 hunk 核实台账：`6ebcf6e` → 最新（含未提交工作区）

> **审计对象**：`git diff 6ebcf6e`（= 提交树 → **工作区**，含未提交改动）里的**每一处** hunk，
> 覆盖**全部** 157 个文件。逐文件、逐 hunk 列出，逐条给核实结论（代码与注释**一并**核）。
>
> **口径声明**：按用户指令**未运行任何测试**（未起 dev server、未跑 vitest/tsc/eslint、未跑
> `test/manual/*.mjs`）、**未写任何分析脚本**。故本文所有"核实"= **静态核实**（逐字比对源码、
> 注释、配置、提交历史与上游），**不构成"门禁已过"**——未验证的部分按 `AGENTS.md` §1 必须写明。
> 计数一律用 `git` 自身（`--shortstat`、`-U0` 的 `@@` 行数）与读文件，不用分析脚本。
>
> **与 §96–§102 五份台账的关系**：那五份的 scope 是 `6ebcf6e..da1ee44`（146 文件）。
> 后 4 笔提交（`645c2f8` / `1f8069b` / `fdde201` / `4fc8a51`）又动了 **53 个文件 / 123 处**（`-U0`）——
> 其中 **11 个文件**此前**完全没有**被任何台账覆盖（§1.2 逐个点名），另 **42 个文件**属"此前覆盖过、
> 之后又被改"⇒ 它们的**追加 hunk** 同样只由本文覆盖（§4.2 / §5.2 / §6.2 / §7.2 逐处列；
> `src/` 的 32 处已含在 §3 的 87 处里）。本文是**单一、全覆盖**的那一份。

---

## 0. 为什么还要一份新的：五份台账合起来是 146/157

| 台账 | scope | 文件数 |
|---|---|---|
| §96 `src/` | `6ebcf6e..da1ee44` | 19 |
| §97 / §98 `public/` | 同上 | 90 |
| §99 `test/` | 同上 | 14 |
| §100 `docs/` | 同上 | 17 |
| §102（`AUDIT-root-…`）根目录 | 同上 | 6 |
| 合计 | | **146** |

而 `git diff --shortstat 6ebcf6e`（工作区）现在是 **157 files / +10503 / −1438**。
差额 **11** 条 = `comm -13 <(git diff --name-only 6ebcf6e..da1ee44) <(git diff --name-only 6ebcf6e..HEAD)`
的输出（见 §1.2）。**"每份都真"不等于"合起来全"** —— §102 已经立过这条判据，本文负责把它闭合。

---

## 1. 范围与计数（三数对账）

### 1.1 读数

| 口径 | 读数 | 怎么得到 |
|---|---|---|
| 提交数 | **26** | `git log --oneline 6ebcf6e..HEAD`（15 笔 2026-09-19 + 11 笔 2026-09-20） |
| 文件数 | **157** | `git diff --name-status 6ebcf6e \| wc -l`（`HEAD` 与工作区同为 157 —— 工作区只改内容、不增减文件） |
| ±行数（工作区） | **+10503 / −1438** | `git diff --shortstat 6ebcf6e` |
| ±行数（仅提交树） | +10496 / −1438 | `git diff --shortstat 6ebcf6e..HEAD`（差 7 行 = 工作区那 8 个文件） |

### 1.2 五份台账漏掉的 11 个文件（逐个点名）

| # | 文件 | 谁改的 | 性质 |
|---|---|---|---|
| 1 | `docs/AUDIT-src-diff-6ebcf6e.md` | `fdde201` | 新增（台账**自身**） |
| 2 | `docs/AUDIT-public-diff-6ebcf6e.md` | `fdde201` | 新增（同上） |
| 3 | `docs/AUDIT-test-diff-6ebcf6e.md` | `fdde201` | 新增（同上） |
| 4 | `docs/AUDIT-docs-diff-6ebcf6e.md` | `fdde201` | 新增（同上） |
| 5 | `docs/AUDIT-root-diff-6ebcf6e.md` | `fdde201` | 新增（同上） |
| 6 | `src/ui/maintenance.ts` | `645c2f8` | 代码（坏 hash 行的自检降级） |
| 7 | `test/cleanup.test.ts` | `645c2f8` | 测试 |
| 8 | `test/dto-validation.test.ts` | `645c2f8` | 测试 |
| 9 | `test/fix-regressions.test.ts` | `645c2f8` | 测试 |
| 10 | `test/fixes.test.ts` | `645c2f8` | 测试 |
| 11 | `test/hardening.test.ts` | `645c2f8` | 测试 |

§96 的 `src/` 台账自己写着"19 个文件"，而 `src/` 在范围内有 **20** 个 ⇒ 连那份台账的 scope
都少算了 1（正是 `src/ui/maintenance.ts`）。同理 `test/` 台账写 14，范围内实为 **19**。

**但"11 个文件"只回答了一半的问题。** 后 4 笔提交实际动了 **53 个文件**（`git diff --name-only -M da1ee44..HEAD | wc -l`）。
差额 **42** 个文件是"此前覆盖过、之后又被改"——例如 `public/` 有 13 个、`test/` 有 4 个、`docs/` 有 11 个、
`src/` 有 9 个（`src/` 这 9 个的追加 hunk 已含在 §3 的 87 处里）。按目录数：

| 目录 | B 段动的文件 | 其中"从未被覆盖" | "已覆盖过、又有追加 hunk" |
|---|---|---|---|
| `src/` | 10 | 1（`ui/maintenance.ts`） | 9（已在 §3） |
| `public/` | 13 | 0 | **13**（§4.2） |
| `test/` | 9 | 5 | 4（§5.2） |
| `docs/` | 16 | 5（五份台账自身） | 11（§6.2） |
| 根目录 | 5 | 0 | 5（§7.2） |
| **合计** | **53** | **11** | **42** |

⇒ **"五份台账的 scope 之外"有两种形态**：① 从未覆盖的文件（11）；② 已覆盖文件的**追加 hunk**（42 个文件的
123 − 32 = 91 处）。只数①会得出"只差 11 个文件"，而差的是**11 个文件 + 91 处 hunk**。这正是 §102 立下的
那条"**每份都真 ≠ 合起来全**"的进一步形态。

### 1.3 按目录的 hunk 数（`-U0` 口径，含工作区）

| 目录 | 文件 | `-U0` hunk 数 | 本文章节 |
|---|---|---|---|
| `src/**` | 20 | **87** | §3 |
| `public/**` | 90 | **335** | §4 |
| `test/**` | 19 | **180** | §5 |
| `docs/**` | 22 | **171** | §6 |
| 根目录那 6 个文件 | 6 | **47** | §7 |
| 五份台账（`docs/AUDIT-*-6ebcf6e.md`） | 5 | 各 1 处（整份新增）——**已含在 `docs/**` 的 171 里** | §6.2(a) |
| 工作区独有（`HEAD` → worktree） | **10** | **16** | §8 |
| 合计（`git diff -M --shortstat 6ebcf6e`） | **157** | — | 全文 |

> ⚠️ **`-U0` 与 `-U3` 是两种口径**：同一段 diff 能数出差一倍的数字（`src/` 87 vs 91、`docs/` 171 vs 111）。
> 本文一律 `-U0`，除特别标注处。
>
> ⚠️ **读数时点**：上表是三段 scope（A = `6ebcf6e..da1ee44`、B = `da1ee44..HEAD`、C = `HEAD` → 工作区）
> 在**本文件落盘前**的读数。本文自己的编辑会改 `docs/**`（新增本文件、订正 `progress.md` / `ui.md`）
> 与根目录（`README.md` 的索引行）⇒ 那两个数会随之变；`src/**`、`public/**`、`test/**` 不受影响。
> **凡引用这里的数，请连时点一起引**（§11 第 2 条）。

---

## 2. 图例

| 记号 | 含义 |
|---|---|
| ✅ | 正确（代码或注释与事实/上下文一致，无需动作） |
| 🔁 | 等价（纯改名 / 纯空白 / 纯排版，语义零变化） |
| 🩹 | **缺陷（本轮改动或登记）** |
| ⏸ | 登记但本轮未动（写明理由） |
| ⚠️ | **未核实边界**（说明为什么核不了） |

---

## 3. `src/**` —— 20 文件 / 87 处（全部逐条核实）

**结论：87/87 全部成立，未发现缺陷。** 本轮 `src/` 的改动分三类：① 真缺陷修复（6 处代码）；
② 注释与事实对齐（含 4 处"注释里承诺了代码没做的事"这类过强断言）；③ 纯排版（行尾注释吞分号、
多余空行、函数名引用）。下面逐条给判据。

### 3.1 `src/cleanup.ts`（15 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#1 | `:95` | 段头 `===== Meta 键（D→F 契约）=====` → `（清理任务写 / UI 只读的共享键名）` | ✅ | 旧标题引用的是**审计编号**（D/F），读者解不开；新标题给出读写两侧。事实面：写侧只有 `runCleanup` 的 `setMetaValues`，读侧是 `src/ui/routes.ts` 的 `CLEANUP_META_KEY_LIST` 与 `maintenance.ts` 的 `readRetentionSettings` |
| S#2 | `:154` | 注释里的 `parsePositiveInt` → `parseNonNegativeInt` | ✅ | 同文件 `:255` 的函数已同名（S#3）；注释若留旧名就是死引用 |
| S#3 | `:251` | `parsePositiveInt` → `parseNonNegativeInt`（改名）+ 2 行注释「0 是合法值」 | ✅ | 实现是 `Number.isSafeInteger(n) && n >= 0 ? n : fallback`；0 的语义在 `disabledReason` 里是"关闭该阶段" ⇒ "非负"才是准确命名。旧名会让下一个读者把 `0` 当非法值"修"掉 |
| S#4 | `:334`(+5) | 新注释：`keys` 必须按 `R2_DELETE_BATCH` 分块的理由 | ✅ | 判据在 `src/storage.ts`：`deleteHistoryKeys` 对 `keys.length > R2_DELETE_BATCH(1000)` **直接抛**；而 `keys` 是按**目录**收进来的、单目录对象数无上界 |
| S#5 | `:341-349` | `sweepWorkingDirs.flush` 真分块 | ✅ | 逐块 `roomFor` 检查 + `spend` + `slice(i, i+1000)`；正常数据（每目录 1 对象）与改前逐位相同。失败隔离由"每条"变"每块"是**已知代价**，兜底是孤儿阶段的全量差集（同函数上方注释已写明） |
| S#6 | `:480` | 注释同步（理由同上） | ✅ | 与 S#5 同构 |
| S#7 | `:483-491` | `cleanOrphans.flush` 真分块 | ✅ | 同 S#5；`processed` 在提前返回时不计已删目录 ⇒ 只影响展示用的游标，不影响正确性（孤儿阶段本来就是每轮重求差集、不用游标续跑） |
| S#8 | `:532-556` | `disabledReason` 增 `source` 形参 + `DISABLED_KEY` 映射 | ✅ | 键名按**生效值来源**取：`source.retentionSource === 'meta'` ⇒ `settings:retentionMinutes`（正是 `maintenance.ts` 的 `PUT /ui/api/settings` 写下的键）、`'env'` ⇒ `HISTORY_RETENTION_MINUTES`。旧实现恒写 env 名 ⇒ 界面把保留期填 0 后日志指向一个**不是来源**的旋钮 |
| S#9 | `:585` | `settings` 提到 try 外层 | ✅ | `catch` 分支（S#11）同时给出 `retentionSource/maxCountSource`，故类型必需 |
| S#10 | `:589` | try 分支只赋值 `settings` | ✅ | `?? DEFAULT` 的派生移到 S#12（两分支都能走到） |
| S#11 | `:592-599` | catch 分支构造整份 `RetentionSettings` | ✅ | 与 `readRetentionSettings` 的「无 Meta 覆盖」分支**同义**（值走 `parseNonNegativeInt` 回落默认、来源记 `'env'`），注释逐字说明了这一点 |
| S#12 | `:601-602` | `const retentionMinutes/maxCount = settings.… ?? DEFAULT` | ✅ | 放在 try/catch 之后 ⇒ 两条路径都被覆盖；catch 分支的值非 null ⇒ `??` 是空操作 |
| S#13 | `:610` | 游标解析改用 `parseNonNegativeInt` | ✅ | 与 S#3 同名改动同步 |
| S#14 | `:618` | `disabledReason(phase, … , settings)` | ✅ | 第 4 个实参到位（否则 `source` 为 `undefined` ⇒ 运行期 TypeError） |
| S#15 | `:612-613`（旧） | **删掉**重复的 `result.subrequests = run.budget.spent;` + 空行 | ✅ | 旧文件里该句出现在 **612** 与 **629** 两处（`git show 6ebcf6e:src/cleanup.ts \| grep -n result.subrequests`）；612 那处在"收尾落库"之前 ⇒ 少算 1 次子请求，随后被 629 覆盖 ⇒ 是**死赋值**，删除正确 |

### 3.2 `src/db.ts`（8 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#16 | `:261` | 高位不可达的注释订正（补「数字型 `Types` 会落到 Unknown/None」） | ✅ | `parseProfileTypeFilter` 接受数字（int32 内），`queryList` 再按 `1 << t` 遍历 `ProfileType` 的值 ⇒ `Types=16/32` 合法且映射到 `Unknown`/`None`；旧注释断言"高位不可达"只在**按名字**传时成立 |
| S#17 | `:281` | 分面登记处 `docs/protocol.md §10「查询搜索」` → `docs/AUDIT-redundancies.md` 的 C-05 | ✅ | 核过两件事：① `AUDIT-redundancies.md:110` 与 `:354` 就是这条分面；② `protocol.md` §10 表里**没有**搜索转义这一条（`grep -n "转义" docs/protocol.md` 无命中）⇒ 旧指针是死的、新指针成立 |
| S#18 | `:293` | 越界 Page 的注释订正（删"保证 offset 是安全整数"的过强承诺） | ✅ | 代码只有 `Number.isSafeInteger(q.page) && q.page > 0` ⇒ 只钳 `page`；`(2^53-2)*50` 已越过安全整数范围而 JS **丢精度不报错**，故"它会炸"不能当护栏 —— 真正的护栏是路由层的 int32 上界（`parsePage`）。新注释把这件事写全了 |
| S#19 | `:313`(+11) | 新注释：预筛**不能用 LIKE** | ✅ | 算式复算：示例名 59 字节（逐段数过）⇒ `'%/' \|\| ?2` 模式 = 61 > D1 的 50 字节上限 ⇒ 旧查询**必报错**；「48 字节 404 / 49 字节 500」与 `serialization.ts` 的实测口径一致 |
| S#20 | `:325` | `if (fileName === '') return []` | ✅ | 上游 `string.IsNullOrEmpty(fileName)` 直接返回 null；同时避免 `substr(x, -0)`（= 整串）这种边界进 SQL |
| S#21 | `:330` | SQL：`LIKE '%/' \|\| ?2` → `substr(TransferDataFile, -length(?2)) = ?2` | ✅ | 终态由调用方那道 `basename(...) === fileName` 精确过滤定义（与上游 `Path.GetFileName(...) == fileName` 同义）；新注释把与 LIKE 的**双向**偏差（更宽：不锚定 `/`；更严：区分大小写）写明 —— 两个方向都被下游过滤吸收 |
| S#22 | `:456` | 删一个空行 | 🔁 | 纯空白 |
| S#23 | `:523` | `listHistoryWorkingDirs()` → `listHistoryObjectsByDir()` | ✅ | 后者是现行函数名（`src/storage.ts`），旧名已不存在 ⇒ 旧注释是死引用 |

### 3.3 `src/durable/SyncClipboardHub.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#24 | `:52`(+3) | 新注释：`MAX_QUEUED_BYTES` 判的是 **UTF-16 码元数** | ✅ | 代码是 `lp.queuedBytes += message.length` ⇒ 码元数；"1 码元 ≤ 2 字节 ⇒ 实际占用 ≤ 两倍"成立。**"改名字要连测试一起改"这句也成立**：`test/rate-limit.test.ts:26-27` 导入该常量、`:623` 用它构造超限消息 |
| S#25 | `:176` | 删一个空行 | 🔁 | 纯空白 |

### 3.4 `src/env.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#26 | `:6` | 注释：`run_worker_first` 六模式 + 三个界面前缀 | ✅ | 与 `wrangler.toml` 的 `run_worker_first = ["/ui", "/ui/*", "/ui_v1", "/ui_v1/*", "/ui_v2", "/ui_v2/*"]` **逐模式同义**；旧注释只有两个模式（改名前的残留） |

### 3.5 `src/hash.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#27 | `:102` | 注释：`80 MiB < 预算 96 MiB ⇒ 余量 ≥ 16 MiB` → `请求体可调到的上上限 64 MiB ⇒ 余量 ≥ 32 MiB` | ✅ | `MAX_REQUEST_BODY_BYTES_CEILING = 64 MiB`、`ISOLATE_TRANSFER_BUDGET_BYTES = 96 MiB` ⇒ 96−64 = **32** ✓。旧的 80 MiB 是"上限曾经是 80"的化石（该档已被判"名存实亡"并撤掉） |

### 3.6 `src/index.ts`（6 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#28 | `:57` | 行尾注释吞分号 → 注释独立成行 + 补回分号 | ✅🩹 | 旧写法 `const app = new Hono<…>({ strict: false }) // …;` 里，那句 `//` 把**行尾分号**一起注释掉了 —— 语句只是靠 **ASI** 才成立。注释自己写明这件事，属"把隐患消掉" |
| S#29 | `:163` | 全局 Basic 中间件里"跳过 `startsWith('/ui/')`"的真实覆盖面 | ✅ | 三个挂载点的**静态资源**都在外层 `fetch` 就被 `env.ASSETS.fetch()`/404 处理掉、不会进 Hono ⇒ 这条跳过真正覆盖的只有 `/ui/api/*`（含裸 `/ui/api`，`startsWith('/ui/')` 对它为真）。与 `src/ui/routes.ts` 逐条注册的守卫一致 |
| S#30 | `:216-247` | `isUiPath` + `isArchivePath` → **单一** `isUiAsset`（六形状） | ✅ | 六形状与 `wrangler.toml` 的六模式、`public/` 下三个挂载点**一一对应**；两条旧分支（V2/`/ui` 与 V1/`/ui_old`）合并成一条的前提是"它们的形状完全相同（都没有自己的服务端路由）"——今天成立 |
| S#31 | `:233` | 404 回落注释改写 | ✅ | 与 `not_found_handling = "none"` 的语义一致：平台自己不生成 404，Worker 显式调 `notFoundPage(env)` |
| S#32 | `:238-254` | 删掉整段 `isArchivePath` 分支 | ✅ | 合并进 S#30 的分支后逐条等价：`!isUiEnabled ⇒ 404` → `ASSETS.fetch()` → 404 则 404 页。**没有**丢任何 code path（旧分支的"再判一次开关"在新分支里是同一句） |
| S#33 | `:254-259` | `isUiApi` 关闭态判定**后移**，且裸 `/ui/api` 归接口面 | ✅ | ① 两分支互斥（`isUiApi ⊂ isUiAsset`）⇒ 后移不改变任何路径的结果；② 裸 `/ui/api` 的归属**从 Hono 源码坐实**：`node_modules/hono/dist/router/reg-exp-router/node.js:5` 的 `TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)"` ⇒ `/ui/api/*` 编译成 `^/ui/api(?:|/.*)$`，**确实匹配裸 `/ui/api`**（中间件的 `findMiddleware` 用同一套正则）⇒ 交给 Hono 才会拿到 JSON 404 |

### 3.7 `src/pathCase.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#34 | `:13` | 覆盖范围注释：三个界面前缀 + "它们确实会先进 Worker（那是 UI_ENABLED 的需要）" | ✅ | 结论对：`run_worker_first` 覆盖三前缀，但**字面段归一**与界面无关（上游没有对应的字面路由可对齐）⇒ 两件事分开写在注释里是对的 |
| S#35 | `:50` | `switch` 里那句"如 /ui/*" → 三个前缀 | ✅ | 与 `:33-40` 的分支行为一致（不在三前缀里的路径一律 `return null`） |

### 3.8 `src/profile.ts`（7 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#36 | `:3` | 删掉未使用的 `tempKey` 导入 | ✅ | `grep -rn "tempKey" src/ test/`：`src/storage.ts` 自己用（`:14/:57/:61/:65`）+ `test/fixes.test.ts:329/343` 直接用 ⇒ `profile.ts` 里确无引用 |
| S#37 | `:421` | `deleteDataIfNeed(db, storage, existing)` → `(storage, existing)` | ✅ | 与 S#41/S#42 同步；`grep` 显示该函数只有这两个调用点 |
| S#38 | `:454`(+4) | `tranfer` 拼写来由（上游契约，不许"改正"） | ✅ | 三条指针**逐条落地**：`docs/upstream-parity.md:119` 的「状态码/文案」条目含该串；`docs/protocol.md:268/274/416`（§5.1 与 §8.1）含该串；`test/fixes.test.ts:1071` 按 `/Needs tranfer data/` 断言 |
| S#39 | `:463` | 第二个调用点同步 | ✅ | 同 S#37 |
| S#40 | `:618` | 8000 串那行加行内注释指回 S#38 的理由 | ✅ | 两处文案必须一致（同一个上游文案），指回单一定义处是正确做法 |
| S#41 | `:626`(+3) | 注释：`db` 形参**从来没被用过**，本轮删掉 | ✅ | `tsconfig.json` **未开** `noUnusedLocals`、`eslint` 的 `files` 只含 `public/**` ⇒ `src/` 的参数级未使用确实不会被任何门禁发现（这句话可复核） |
| S#42 | `:629` | 删掉 `deleteDataIfNeed` 的 `db: HistoryDb` 形参 | ✅ | 函数体内只用到 `storage` 与 `entity`；两个调用点（S#37/S#39）同批改完 ⇒ 无残留调用方 |

### 3.9 `src/rateLimit.ts`（4 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#43 | `:18` | "第 11 次**失败**起即刻生效" → "第 11 次**请求**起即刻被拦" | ✅🩹 | 旧措辞**自相矛盾**：`AUTH_RATE_LIMIT_MAX_FAILURES = 10` 且 `auth.ts` 的注释写着"阈值本身不封锁" ⇒ 第 10 次失败写入 `blockedUntil`，第 11 次**请求**在预检就被 429（此时**不会**再产生失败）。语序即语义 |
| S#44 | `:93` | 函数内加一个空行 | 🔁 | 纯排版（`}` 与下一条注释之间） |
| S#45 | `:237` | 同一措辞的第二处 | ✅ | 同 S#43 |
| S#46 | `:262-268` | `authLimitKeys(...).filter((key) => cache.limits.delete(key))` → 显式 `for` 循环 | ✅ | 语义**逐位相同**（filter 的返回值就是"删成功的 key"，新循环用 `cleared.push` 收集同一集合），但把副作用从"读起来像筛选"的 `filter` 里挪出来；"只有真删掉了才通知 DO"这条判据也随之显式化 |

### 3.10 `src/requestLimits.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#47 | `:12` | `MaxFileByte` 的口径订正：`默认上限远大于它` → `可调到 GB 级（默认 20 MB，低于这里的默认上限）` | ✅ | 服务端默认 48 MiB、客户端默认 20 MB ⇒ **服务端上限更大**，旧注释说反了（"远大于它"）；"只有客户端调大之后才会出现 413"才是真实因果 |

### 3.11 `src/routes/history.ts`（3 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#48 | `:223` | 同 S#28（分号/注释） | ✅🩹 | 同一形状的第二处 |
| S#49 | `:262`(+7) | **新增**：`GET /api/history/{id}/data` 遇坏 hash 行（含 `/`/`\`）→ 404 | ✅ | ① 方向正确：`notFound.ts:4-5` 逐字写着"例如 `GET /api/history/{id}/data` 缺数据必须 404"，而 `storage` 侧的 `assertHashForPath` 会让这种行**恒 500**；② 与上游对齐（上游在同样数据上是 404，见 `docs/protocol.md` §5 该行 2026-09-20 的登记）；③ 坏行只能带外写入（三条写路径入口都拒） |
| S#50 | `:274` | 引用从行号改为函数名（`contentTypes.ts` 的 `fileHeaders()` / `ui/routes.ts` 的数据端点） | ✅ | `fileHeaders` 确在 `src/contentTypes.ts` 且两处调用（WebDAV 附件 + 界面数据端点）⇒ 按名引用比行号抗震 |

### 3.12 `src/routes/webdav.ts`（4 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#51 | `:22` | 同 S#28 | ✅🩹 | 同一形状的第三处 |
| S#52 | `:29` | `不再把人引到不存在的 /ui/` → `不存在的界面` | ✅ | 关闭态三个前缀全 404 ⇒ "界面"比具体路径更准确（也就不会随下一次改名过期） |
| S#53 | `:31-34` | 跳转目标注释：`/ui_old/` → `/ui_v1/`，并点出"两处必须一致" | ✅ | 两处 = 本函数（`:37` 的 302）与 `public/ui/index.html` 的 meta refresh；守卫是 `test/ui-guard.test.ts` 的「默认界面的入口链一致」 |
| S#54 | `:37` | **代码**：302 目标 `/ui_old/` → `/ui_v1/` | ✅ | 与 `AGENTS.md` §3 的定位（V1 = 默认界面、挂载 `/ui_v1/`）、`docs/ui.md` §3.2、`public/ui/index.html` 三处一致 |

### 3.13 `src/serialization.ts`（6 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#55 | `:203`(+29) | 新增 `readString` / `readBool` + 可空性口径长注释 | ✅🩹 | 旧实现用 `(get('hash') as string) ?? ''` 这类**断言**：`{"hash":123}` 会带着 number 一路走到字符串运算 ⇒ 未处理的 500（PUT 路由只 catch 解析期异常）；`{"hasData":"false"}` 更糟——字符串为真值 ⇒「没有数据」被判成「有数据」。新口径按上游 `ProfileDto` 的**可空性**分两类处理，注释把"值类型 null ⇒ 400 / 引用类型 null ⇒ 缺省"的判据写在同一个地方 |
| S#56 | `:248` | `if (rawType == null)` → `if (rawType === undefined)` | ✅🩹 | 上游 `ProfileType` 是非空值类型 ⇒ 显式 `null` 是**反序列化失败（400）**，不是缺省。旧写法把 `{"type":null}` 静默当 `Text` ⇒ 会覆盖当前 profile（数据污染）。新写法让 `null` 落到 `resolveStrictProfileType` 的抛错分支 |
| S#57 | `:258-261` | 四个字段改走新读取器 | ✅ | `dataName` 不再 `?? null`（`readString` 已把 undefined→null）；`hash`/`text` 保持 `?? ''`；`hasData` 的显式 null 按 S#55 的口径 → 400 |
| S#58 | `:402-416` | 日期字段：非串与**空串**都 400 | ✅ | 与上游 `DateTimeOffset?` 的 `[FromBody]` 绑定一致（STJ 对 `""` 也判反序列化失败）。旧实现把 `{"lastModified":123}` **静默忽略** —— 请求方以为改掉了、服务端没改，是最难查的一类"假成功"。`null`/键缺失仍是"未提供"（上游得到 null） |
| S#59 | `:451-462` | `MAX_SEARCH_BYTES = 48` → `MAX_LIKE_PATTERN_BYTES = 50` + 派生的 `48`，并写明两个 LIKE 站点的实测 | ✅ | 约束是**模式**长度（`%` + 串 + `%`）；48+2 = 50 ⇒ 导出名语义更准、**值不变**（现有消费者的行为零变化）。注释把"转义会把 1 字符变 2"这条二阶约束也写出来了 |
| S#60 | `:473-483` | 新增 `assertLikePatternFits`（转义后的预算校核） | ✅ | 判据：转义后 `escaped + 2 ≤ 50`；不转义那一侧（协议面）用 `normalizeSearchText` 就够 —— 这条分界线与 C-05 登记的分面一致 |

### 3.14 `src/storage.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#61 | `:29` | 函数名引用订正（`listHistoryWorkingDirs()` → `listHistoryObjectsByDir()`；"的键"→"分组后的目录键"） | ✅ | 现行函数返回 `{ groups: Map, pages }`，其键是"截断后的目录名"⇒ "分组后的目录键"是准确描述 |
| S#62 | `:123` | 删一个空行 | 🔁 | 纯空白 |

### 3.15 `src/types.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#63 | `:95`(+3) | 注释：`stared` **不是拼错**（与 D1 列名同形，对外一律 `starred`） | ✅ | `schema.sql` 的列是 `Stared`、`entityParams`/`rowToEntity` 用它、`serialization.ts` 的 `entityToDto*` 输出 `starred` ⇒ 三处口径与注释一致。这类"看起来像笔误的正确代码"必须留一条注释，否则下一个人会去"修"它 |
| S#64 | `:121` | `listHistoryWorkingDirs` → `listHistoryObjectsByDir` | ✅ | 同 S#23/S#61（同一处死引用的第三个副本） |

### 3.16 `src/ui/maintenance.ts`（2 处）—— §1.2 点名文件之一

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#65 | `:16` | 导入 `isValidProfileHash` | ✅ | 与 S#66 配套；`src/types.ts` 有该导出 |
| S#66 | `:79`(+10) | `reachable` 判定：hash 含分隔符的坏行按「取不到」计、不让自检端点 500 | ✅ | 逻辑核过：`reachable && objectKeys.has(historyKey(...))` 才 `continue`；坏行落到下面 `missingCount++` 与清单里（`hash` 原样输出 ⇒ 运维能认出是坏行）。**这是诊断面自身的可用性修复**：坏数据存在时，唯一该工作的端点反而 500 |

### 3.17 `src/ui/notFound.ts`（7 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#67 | `:1` | 两个命名空间 → 三个（`/ui`、`/ui_v1`、`/ui_v2`） | ✅ | 与 `src/index.ts` 的 `isUiAsset` 六形状同源 |
| S#68 | `:3` | "只对 UI 命名空间" → "只对界面前缀" | ✅ | 与 :1 用词统一 |
| S#69 | `:6-8` | 三前缀共用 + 样式取自 `/ui_v2/css/*` + 返回 `/ui_v1/` | ✅ | `/ui/css/*` 已随改名不存在（`public/ui/` 只剩 `index.html` + `js/redirect-hash.js`）⇒ 旧路径会让 404 页**无样式**；`/ui_v2/css/*` 与 `/ui_v2/favicon.svg` 都在 |
| S#70 | `:10` | 同上（第二处 `/ui/css/` → `/ui_v2/css/`） | ✅ | 同 S#69 |
| S#71 | `:28-30` | HTML 里 `icon` 与两张样式表的路径 → `/ui_v2/*` | ✅ | 三个文件逐个存在（`public/ui_v2/favicon.svg`、`css/tokens-v2.css`、`css/base-v2.css`） |
| S#72 | `:68-69` | 正文两个路径：`/ui_old/` → `/ui_v1/`、`/ui/app/` → `/ui_v2/app/` | ✅ | 两个目标都真实存在 |
| S#73 | `:73` | 主链接 `href="/ui_old/"` → `/ui_v1/` | ✅ | 与 `AGENTS.md` 的"默认界面 = V1"一致 |

### 3.18 `src/ui/query.ts`（9 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#74 | `:8-14` | 导入 `assertLikePatternFits` | ✅ | 与 S#76 配套 |
| S#75 | `:25` | 注释里的中文引号 `“下载/预览”` → `"下载/预览"` | 🔁 | 与全仓中文引号用法统一（同文件其余处已是 `""`） |
| S#76 | `:151`(+4) | 新增：解析期按**转义后**的串校预算 | ✅ | 判据链完整：`normalizeSearchText` 只校原文（≤48 字节），而转义会把 `%`/`_`/`\` 各变 2 字符 ⇒ 48 字节入参最多拼出 98 字节模式，越过 D1 上限 ⇒ 未处理的 500。实测口径（25 个 `%`）与 `serialization.ts` 的注释一致 |
| S#77 | `:180`(+6) | 提取 `escapeLike`（唯一定义处，含转义符本身要先转义的理由） | ✅ | 旧实现在 `buildWhere` 里内联 `replace`，解析期要算长度就只能**再写一份** ⇒ 现在两处共用。注释里的顺序问题（先转 `\`）成立：`/[\\%_]/g` 单趟替换天然正确（`\` 与 `%` 都各自变两字符，不会二次转义） |
| S#78 | `:214-215` | 注释同步（转义预算已在解析期校过） | ✅ | 与 S#76 同源；这处注释正是"为什么这里不再校一次"的答案 |
| S#79 | `:217` | 用 `escapeLike(q.search)` | 🔁 | 与旧内联实现逐字相同 |
| S#80 | `:238`(+5) | 注释：服务端 `truncateText` 与前端同名函数**同名不同义** | ✅ | 前端那份确实用 `Intl.Segmenter` 的字素簇（`public/ui_v1/js/format.js:106-133`，且**它自己的注释也反向指回服务端**）；本文引用的 `docs/archive/AUDIT-v1-v2-divergence.md` **§5.3 存在**（该文件里是 `- **5.3 [两版] 按 UTF-16 码元切分…**` 这一条，不是 `###` 标题） |
| S#81 | `:471`(+4) | 预取时把入参 hash 统一大写 | ✅🩹 | 旧实现直接拿入参做 `Hash IN (…)` 的**等值**比较 ⇒ 小写入参在**这一步**就被滤掉，下面那句"大小写不敏感"的过滤永远轮不到执行（真缺陷：小写入参静默返回空） |
| S#82 | `:484-485` | 过滤侧的注释订正（"库里存的是大写"移到预取处） | ✅ | 与 S#81 配套；`wanted` 集合与 IN 参数都走 `.toUpperCase()` ⇒ 两侧一致 |

### 3.19 `src/ui/routes.ts`（3 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#83 | `:301`(+5) | 注释：那句实测的**地名按当时写**，并指出改名会把它变成"从未发生过的事" | ✅ | 可复核：`git cat-file -t 380b5da` → `commit`；`git show 380b5da:src/ui/routes.ts` 的 `:128` 逐字含"未认证访问 /ui/不存在 会得到 401 JSON" ⇒ 引用成立。且今天那条路径到不了这里（`isUiAsset` 已在外层处理）——两句话都对 |
| S#84 | `:556` | `public/ui/js/signalr.js` → `public/ui_v1/js/signalr.js` | ✅ | 该文件存在；V2 的那份叫 `push.js` ⇒ 旧路径在改名后**两个都不是** |
| S#85 | `:706`(+4) | 注释：`app.all('/ui/*')` 与 `app.get('/ui')` 两条兜底**今天到不了** | ✅ | 与 S#30 一致：所有 `isUiAsset` 请求在外层就 return 了。保留它们的理由（"界面命名空间的兜底"这件事本身）也说得通 —— 属有意保留的**第二道网**，不是死代码误留 |

### 3.20 `src/uiEnabled.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| S#86 | `:3-4` | 三面资源 + 协议面不换行 | ✅ | 与 `public/` 下三个 `ui*` 目录一致 |
| S#87 | `:9-11` | 关闭态：三前缀 + 接口命名空间（含裸 `/ui/api`）+ 根路径不再跳转 | ✅ | 与 `src/index.ts` 的实际行为**逐条**对应（S#30/S#33 + 根路径分支在 `routes/webdav.ts`）⇒ 这份"契约注释"与实现同源 |

### 3.21 `src/` 小结

| 类别 | 处数 |
|---|---|
| 真缺陷修复（会改变行为的代码改动） | **6**：S#5/S#7（分块删）、S#8-S#14（reason 键名）、S#21（substr）、S#33（裸 `/ui/api`）、S#49（坏行 404）、S#55-S#58（DTO 类型收紧）、S#66（自检不 500）、S#81（小写 hash 预取） |
| 注释与事实对齐（含 4 处过强断言订正） | **多数**：S#1-S#4、S#9-S#13、S#16-S#19、S#24、S#26-S#27、S#29-S#31、S#34-S#35、S#38、S#41、S#43、S#45、S#47、S#50、S#52-S#53、S#59-S#61、S#63、S#67-S#73、S#75、S#78、S#80、S#82-S#87 |
| 纯排版 / 等价 | **9**：S#15（死赋值）、S#22、S#25、S#44、S#62、S#79 + 三处行尾注释吞分号（S#28/S#48/S#51，兼修隐患） |
| 未核实边界 | **0**（唯一"实测类"措辞都在注释里且已用源码/上游/计数**二次坐实**，见 §10） |
| **缺陷（需修）** | **0** |

---

## 4. `public/**` —— 90 文件（A 330 处 + B 31 处 + C 4 处）

### 4.0 口径（§4–§7 共用）

`public/` 的 **A 段**（`6ebcf6e..da1ee44`）已由 `docs/AUDIT-public-diff-6ebcf6e.md` 逐文件、逐 hunk 列过
（与本文同为基线 `6ebcf6e`）。本文**不复制**那 208 处明细 —— 同一段 diff 列两遍，只会多出一个会腐烂的
事实源，且两处迟早会不一致。本节给：**4.1** A 段的核对结论（含本次独立复算的计数）；
**4.2** B 段的**逐处**（此前无任何台账覆盖）；C 段在 §8。

### 4.1 A 段的核对结论

| 项 | 读数 | 判据 |
|---|---|---|
| 文件 / hunk（台账口径 `-U3`） | 90 / **208**（diff 4708 行，+1706 / −773） | 台账 §1 / §2 |
| 文件 / hunk（本次独立复算 `-U0`） | 90 / **330** | `git diff -M -U0 6ebcf6e..da1ee44 -- public/` |
| 逐字核实 | 205/208 命中直查 + 3 个整文件删除 ⇒ **`MISMATCH = 0`** | 台账 §1 第 2 步 |
| 查出的问题 | **15 条，全部已落地**：F-1…F-12（§4）+ F-13…F-15（§8 的独立复核轮） | 台账 §4 / §8 |
| 未决 | **0 条** —— 曾记的唯一一条（V2「清空筛选」与空态里的「清除筛选」对 `keepView` 取值相反）已于 **2026-09-20 定案（ADR D19）**：统一为**回活跃列表**，`keepView` 形参删除、`states.mjs` 的旧断言同批改掉（见 `progress.md` §103.10） | 台账 §6 |
| 覆盖对账 | 57 个有 hunk 的文件合计 +1706/−773；余 33 条 `similarity index 100%`（29 文本改名 + 4 PNG）⇒ 57+29+4 = **90** ✓ | 台账 §7.1 |

> 那份台账里凡标「实测」的数字（47 / 103 / 117 / 77 / 65 / 125 / 135 / 6642 / 6683.05 / CLS 0.90 / …）
> 在当时**都没有起过浏览器**，只做了内部自洽性核对（台账 §7.5 末已声明）。
> **2026-09-20 补跑探针后**：47 / 103 / 117 / 77 / 125 / 135 **已用真实浏览器量到**
> （读数与判据见 §10 第 2 条）；其余（6642 / 6683.05 / CLS 0.90 / …）仍属未核实边界。

### 4.2 B 段：`da1ee44..HEAD`（31 处 / 13 文件，此前无任何台账覆盖）

| # | 文件 | 处 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|---|
| P-B1 | `ui_v1/css/components.css` | 1 | 卡片档骨架等式里 `var(--sp-1)` 那一项：注明 `tr.row` 用的是**字面量**，与 `--sp-1` **同值不同源** | ✅ | `components.css:1860` 逐字是 `gap: 4px var(--sp-2)`（**字面量 4px**）；`--sp-1: 4px`（`tokens.css`）⇒ 同值不同源成立，改令牌不会牵动这条等式 |
| P-B2 | `ui_v1/js/components/info.js` | 2 | F-6 的落地：把"有快照的调用方在刷新失败时 `open(null)` 覆盖它"拆成两条真实路径（有快照 `cached→fresh`；**无快照**且失败才 `open(null)`，重试再走一遍） | ✅ | `main.js:1106-1107` = `// 首屏就失败（没有任何快照）…` + `if (!cached) info.open(null);` ⇒ 与注释同构；原注释把 `if (!cached)` 上的分支说成了"有快照的调用方" |
| P-B3 | `ui_v1/js/components/list.js` | 1 | F-8 的落地：`if (state.error && items.length === 0) return;`（失败态不许被后续 `render()` 刷成空态） | ✅ | 与 V2 `boardState() === 'error'` 是同一条判据（见 P-B9）⇒ 两版对"现在是不是失败态"同答 |
| P-B4 | `ui_v1/js/components/pagination.js` | 3 | F-8/F-9：`update()` 收 `error`，新增 `unknown` 档（条数未知时**什么都不说**） | ✅ | `const unknown = error && total === 0;`；范围文本 `pending ? '' : unknown ? '' : total===0 ? '没有可显示的记录' : …`；页码文本 `pending \|\| unknown ? '' : …` ⇒ 三档互斥且失败档不说话 |
| P-B5 | `ui_v1/js/main.js` | 10 | store 增 `error` 字段；抽出 `renderPagination()`（分页那一格的**唯一**绘制点，`render()` 与失败路径共用）；成功清 `error`、失败写 `error` 并补一次 `renderPagination()`；F-4 的行号 `:371` 换成**守卫语句原文** | ✅ | `render()` 现在是 5 个 `update` + `renderPagination()`；失败分支 `store.set({ loading: false, error: message })` 后紧跟 `renderPagination()`；`:469` 处已无行号 |
| P-B6 | `ui_v2/css/board-v2.css` | 1 | F-11：`AUDIT-missing-states.md` §6.1 → `archive/AUDIT-v1-v2-divergence.md` §6.1 | ✅ | 同族三处（另两处 P-B10 / P-B12）；判据见 §4.1 台账 F-11（divergence §12 的实施记录表自称落点正是这两个文件） |
| P-B7 | `ui_v2/css/shell-v2.css` | 3 | F-13：断点注释里"≤380：只降字号"那一条**次日已删**，改成"宽度档只有 `max-width: 720px` 一条"（`hover`/`pointer` 类不算宽度档） | ✅ | 该文件现存宽度档只有 `max-width: 720px` ✓；`≤380` 那条随 `--fs-display` 的删除一并消失（见 `tokens-v2.css` 的删除记录） |
| P-B8 | `ui_v2/css/tokens-v2.css` | 1 | F-5/F-12：删掉"V1 有 7 处 coarse 分支"，改成"`pointer: coarse` **媒体块 4 个** + 用 `var(--hit-min)` 的**声明 15 条**（14 条命中区 + 第 15 条是 `.skeleton__row` 的**高度**）" | ✅ | **实测**：`@media … pointer: coarse` 在 `ui_v1/css/components.css` 恰好 **4** 条（`:583`、`:1033`（`,` 组合）、`:1672`、`:1950`（`and` 组合））⇒ 与注释里"另有 `and` / `,` 两种组合写法"逐字对上；15/14 的边界也写明了 |
| P-B9 | `ui_v2/js/boot.js` | 3 | 两处分页调用传 `error: boardState(current) === 'error'`；F-2 的行号改指 `toggleFlag` 里那句 | ✅ | 判据与列表**共用**同一个 `boardState()`（不是各写一份）⇒ 两处不可能打架 |
| P-B10 | `ui_v2/js/ui/board.js` | 1 | F-11 第二处 | ✅ | 同 P-B6 |
| P-B11 | `ui_v2/js/ui/drawer.js` | 1 | F-3：`src/ui/maintenance.ts:102` → 按 `PUT /ui/api/settings` 那段注释指 | ✅ | 行号锚换成可检索锚（§11 第 4 条的纪律） |
| P-B12 | `ui_v2/js/ui/filters.js` | 1 | F-1：`V1 main.js:222` → `onClearFilters`（+ `setFilters({ ...DEFAULT_FILTERS }, …)` 那一行） | ✅ | 同 P-B6 |
| P-B13 | `ui_v2/js/ui/pager.js` | 3 | F-9：`update()` 收 `error` + `unknown` 档（与 V1 同形） | ✅ | `const unknown = error && (total ?? 0) === 0;` ⇒ 与 V1 的 `error && total === 0` 同判据；V2 的 `total` 可为 `null` ⇒ `?? 0` 是必要的差异，不是分叉 |

**C 段**（`ui_v1/js/components/list.js` 1 处、`theme-init.js` 1 处、`theme.js` 2 处）在 §8。

---

## 5. `test/**` —— 19 文件（A 164 处 + B 21 处 + C 1 处）

### 5.1 A 段的核对结论

| 项 | 读数 | 判据 |
|---|---|---|
| 文件 / hunk（台账口径 `-U3`） | 14 / **79**（+1242 / −227） | 台账 §1 |
| 文件 / hunk（本次独立复算 `-U0`） | 14 / **164** | `git diff -M -U0 6ebcf6e..da1ee44 -- test/` |
| 查出的问题 | **T-1…T-4 全在注释里**（断言本身 **0 处缺陷**）+ 对本轮补丁自己的勘误 T-5 ⇒ 全部落地 | 台账 §4 |
| 备注 | 台账 §8 单独读了"工作区未提交的 `test/**`"，与本文 §8 的 1 处相接 | 台账 §8 |

### 5.2 B 段：`da1ee44..HEAD`（21 处 / 9 文件）

| # | 文件 | 处 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|---|
| T-B1 | `cleanup-budget.test.ts` | 1 | 新增"单目录 >1000 个对象"用例：1200 个 key ⇒ `deleteCalls === 2`、failures 空、对象清零 | ✅ | 与 §3 的 S#5/S#7（真分块）互为判据；断言的是**可观察结果**（删了几次、还剩什么），不是实现细节 |
| T-B2 | `cleanup.test.ts` | 4 | `/__scheduled` 与另两处响应体**读掉**（`await res.text()`）+ 一条**不宣称因果**的注释 | ✅ | 注释逐字写着"这不代表已证因果"（隔离跑 7/7、cron→POST 10/10）⇒ 把"缓解"与"结论"分开了，符合 `AGENTS.md` §1 那条"没测 ≠ 测了通过" |
| T-B3 | `dto-validation.test.ts` | 6 | 新增三组：PUT 字段的 JSON 类型、PATCH 日期字段、带外写入的坏行（`FakeD1.exec` 直写一行） | ✅ | 与 §3 的 S#55–S#58（拒绝类型不符）、S#49/S#66（坏行不 500）逐条同源；坏行 INSERT 的列名与 `schema.sql` 的 **14 列逐字一致**；断言钉的是 HTTP 状态 + **版本未被推进**（可观察契约） |
| T-B4 | `fix-regressions.test.ts` | 1 | 新增 D1 LIKE 上限（50 字节）三例：48/49/60 字节与 20 个汉字的名字 ⇒ 404；61 字节名字端到端 PUT→GET→`/data`→PATCH 软删；25 个 `%` ⇒ 400、24 个 `%` ⇒ 200 | ✅ | 与 §3 的 S#21（`substr` 预筛）、S#76（转义预算）同源；用例自带**前提断言**（`byteLength(name) > 48`，否则本用例无判别力）⇒ 判别力可自证 |
| T-B5 | `fixes.test.ts` | 1 | `listHistoryWorkingDirs()` → `listHistoryObjectsByDir()` | ✅ | 旧函数名在 `src/` 已不存在 ⇒ 死引用（与 §3 的 S#23/S#61/S#64 是同一事实的第 4 处副本） |
| T-B6 | `hardening.test.ts` | 1 | 新增：UI 入口按**转义后**长度判预算（25 个 `%` 抛 `/after LIKE escaping/`、24 个 `%` 与 48 字节普通串通过） | ✅ | 与 `src/serialization.ts` 的 `MAX_LIKE_PATTERN_BYTES = 50` 逐位自洽：24×2+2 = 50 ✓、25×2+2 = 52 > 50 ✓ |
| T-B7 | `manual/probe-ui-v1.mjs` | 1 | V1 行高注释：把 V2 的 `--row-h` 指出去，改指 `.table td` 的盒模型 `8+8+1+30 = 47` | ✅ | **实测**：`git grep -c -- "--row-h" public/ui_v1` **零命中** ⇒ 原注释把 V2 的令牌写进了 V1 的探针 |
| T-B8 | `manual/probe.mjs` | 4 | 末行矮多少**按模式分开**（卡片档 125→124；表格档 77→76.5，因为 `border-collapse: collapse` 那条线由相邻两行各担一半）+ 一处"注释里不许出现反引号" | ✅ | `board-v2.css:103` 逐字有 `border-collapse: collapse` ⇒ 0.5px 的归因成立；反引号那条正是 T-5 的形态（那行本身在模板字符串里，`node --check` 能抓） |
| T-B9 | `ui-guard.test.ts` | 2 | 裸 `/ui/api` 两条断言：关闭态同形 JSON 404；开着时未认证 401 / 认证后 `{"error":"not_found"}`，且**不去问静态资源** | ✅ | 与 §3 的 S#33（裸 `/ui/api` 归接口面）互为判据；断言的是可观察响应（状态 + `Content-Type` + 体）✓ |

**C 段**（`manual/probe-ui-v1.mjs` 1 处）在 §8。

---

## 6. `docs/**` —— 22 文件（A 160 处 + B 30 处 + C 5 处）

### 6.1 A 段的核对结论（17 文件 / 101 处，台账口径）

| 项 | 读数 |
|---|---|
| 文件 / `-U3` hunk（台账） | 17 / **101**（+3465 / −203，diff 4592 行） |
| 文件 / `-U0` hunk（本次复算） | 17 / **160** |
| 查出的问题 | **15 处全部是"指代 / 引用"类**：D-1×3、D-2、D-3×2、D-4、D-5、D-6、D-7、D-8、D-9、D-11×2 = **14 处已修** + **D-10 已收口**（归档横幅已按用户决定改成可复算的 53/24/29，口径与检索式写在横幅里；见 §10 第 5 条与 `progress.md` §103.11） |
| 本次独立复核（不是抄台账） | `src/db.ts:157` = `LOWER(Hash) = LOWER(?3)` ✓；`src/hash.ts:239` = `if (seg === '..' \|\| seg === '.')` ✓ ⇒ 协议表那两处行号订正**命中** |

### 6.2 B 段：`da1ee44..HEAD`（30 处 / 16 文件）

**(a) 五份台账 + 两份审计报告（7 文件 / 7 处，+2348 行）**

| # | 文件 | 变更 | 判定 | 判据 |
|---|---|---|---|---|
| D-B1 | `AUDIT-src-diff-6ebcf6e.md` | 新增（+495） | ✅ | 它的"91 处"是**当轮口径**（62 已提交 + 29/31/32 工作区快照）；与本次复算的 **87** 不矛盾但**口径不同**（工作区的 README 行已写成"当轮快照 / 本轮 `-U0` 87"） |
| D-B2 | `AUDIT-public-diff-6ebcf6e.md` | 新增（+787） | ✅ | 见 §4.1 |
| D-B3 | `AUDIT-test-diff-6ebcf6e.md` | 新增（+395） | ✅ | 见 §5.1 |
| D-B4 | `AUDIT-root-diff-6ebcf6e.md` | 新增（+260） | ✅ | 见 §7.1（含它那句"五份台账 100% 覆盖 146"——**只对它自己的 scope 成立**，工作区已补"146/157"） |
| D-B5 | `AUDIT-docs-diff-6ebcf6e.md` | 新增（+377） | ✅ | 见 §6.1 |
| D-B6 | `AUDIT-missing-states.md` | +21 | ✅ | 第一轮"缺失状态"审计的收尾，与 §94 的落地记录一致 |
| D-B7 | `archive/AUDIT-v1-v2-divergence.md` | +13（归档横幅补一段） | ⏸ | 与 D-10 同一处上下文（数字未决）⇒ **未动** |

**(b) `progress.md`（3 处 / +928 −1）：§95–§102 共 8 节**

| # | 变更 | 判定 |
|---|---|---|
| D-B8 | 四轮审计的**过程与落地记录**（§95 `src/` 台账的落地、§96 通读、§97/§98 `public/`、§99 `test/`、§100 `docs/`、§101 根目录、§102 独立复核与五份台账的覆盖率对账） | ✅（**部分复核**）—— 本轮**逐节读过**，并在"与本文 scope 重叠"处做了交叉复核（**0 处矛盾**）；但节内的当轮读数**没有逐条复算**（§10 第 4 条）。其口径自省（"判据取自当时的未提交工作区"之类）与本文 §11 第 2 条同一条纪律 |

**(c) 九个小订正文件（9 文件 / 10 处，±1~5 行）：fdde201 的"全文档事实订正"**

| # | 文件 | 处 | 判定 | 判据 |
|---|---|---|---|---|
| D-B9 | `AUDIT-redundancies.md` | 2 | ✅ | C-05 的指针（§3 的 S#17 引它）+ `N-01③` 的行名，与 D-5 同批 |
| D-B10 | `backend-gaps.md` | 2 | ✅ | D-11 的两处（文件头 + §1.6）已按"快照期叫 `public/ui/js`"写回 |
| D-B11 | `design.md` | 2 | ✅ | D-3（ADR D16 补成三个前缀）/ D-9（目录树空格） |
| D-B12 | `frontend-checklist.md` | 2 | ✅ | D-1（`/ui_v2/` → `/ui/` 跳转壳）/ D-2（`probe-ui-old.mjs` → `probe-ui-v1.mjs`） |
| D-B13 | `protocol.md` | 4 | ✅ | 行号订正（§6.1 已复核命中）+ **新增一行差异**（负数 `type` / `profileId`）——**上游半边本次坐实**：`../SyncClipboard/src/SyncClipboard.Shared/Profiles/Profile.cs:99` 是 `if (!Enum.TryParse(parts[0], out type))`，`Enum.TryParse` 对**任何整数串（含 `-1`）**都成功 ⇒ 上游确实接受，本实现 400 ⇒ 这条登记**成立** |
| D-B14 | `ui-v2-audit.md` | 1 | ✅ | D-6（"实测在 `/ui_v2/` 上也带全套安全头"改写 + 警示：今天 `/ui_v2/` 回的是 `notFoundPage` 那套头） |
| D-B15 | `ui-v2-design.md` | 4 | ✅ | D-1×2 / D-5 / D-7（词汇表 `data-tone` 只留 `"warn"` 与两个真实生产者） |
| D-B16 | `ui.md` | 2 | ✅ | D-1 的第三处 + 第 24 条（`search` 也要清选择集）+ §3 资源数 **88** 的四段分表 —— **本席复算**：`git ls-files public/ \| wc -l` = **88**，且 37+47+2+2 = 88 ✓ |
| D-B17 | `AUDIT-v1-v2-drift-2026-09-19.md` / `ui-rename-v1-v2.md` | 0 | — | 两文件**不在** B 段（它们在 `da1ee44` 之前就已存在）⇒ 由 §6.1 的 17 文件口径覆盖 |

**C 段**（`design.md` 1 处、`progress.md` 1 处、`ui-v2-design.md` 3 处）在 §8。

---

## 7. 根目录那 6 个文件（A 45 处 + B 9 处 + C 5 处）

### 7.1 A 段的核对结论

| 项 | 读数 |
|---|---|
| 文件 / hunk | 6 / **45**（`-U0`；`-U3` 口径是 26 —— 同一段 diff 的两种数），+106 / −65 |
| 查出的问题 | **R-1…R-6 已全部落地** + **R-7**（不在任何 hunk 上：横幅数字的口径） |
| 全仓对账 | 146 = 19+90+14+17+6，±行数逐位吻合 ✓ —— 但**"146/146 覆盖"只对它自己的 scope 成立**；本文 §0/§1.2 的差额（11 文件 + 91 处）在它的边界之外，工作区的 README 行已改成 146/157 ✓ |

### 7.2 B 段：`da1ee44..HEAD`（9 处 / 5 文件）

| # | 文件 | 处 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|---|
| R-B1 | `.github/workflows/deploy.yml` | 3 | ① `# ⑤` 那段注释的缩进回到 YAML 顶层；② "五条路径"→"**六条**"；③ **新增**一条冒烟断言 `check_asset '/ui/js/redirect-hash.js' …` | ✅ | **实测**：`git grep -c "check_asset " .github/workflows/deploy.yml` = **6** ⇒ 与"六条"逐位一致；新断言的对象 `public/ui/js/redirect-hash.js` 存在（跳转壳脚本）✓ |
| R-B2 | `AGENTS.md` | 1 | 那行"改文档里写死的数字"补细节：套件数 **5 处** = `CURRENT_STATE_FILES` 那 5 个文件、`public/` 资源数 **2 处**（都在 `docs/ui.md` §3）、目录树 **3 处** | ✅ | **实测**：`test/docs.test.ts:84-90` 的 `CURRENT_STATE_FILES` 逐字 5 个（README / AGENTS / design / ui / deploy.yml）✓；§3 的"总数 + 分表"2 处 ✓；三处目录树（`design.md` §4、`ui-v2-design.md` §7、README 的 `public/` 行）✓ |
| R-B3 | `README.md` | 3 | ① `UI_ENABLED` 关闭态路径补全成**六模式**；② `_headers` 描述写明图标/manifest 的**具体**缓存值；③ 新增 4 行台账索引 | ✅ | **实测**：六模式与 `wrangler.toml` 的 `run_worker_first` 逐模式相同 ✓；`public/_headers` 图标行 = `max-age=86400, stale-while-revalidate=604800`、manifest 行 = `max-age=3600`（无 SWR）✓ 与描述逐字一致 |
| R-B4 | `eslint.config.js` | 1 | 注释补"两处必须一起改"（本文件的 `files` 与 `package.json` 的 `lint`）+ 两处失败模式的差异 | ✅ | `package.json` 的 `lint` 脚本确实是第二个消费者（`eslint public/ui_v2/js public/ui_v1/js`）✓ |
| R-B5 | `wrangler.toml` | 1 | `UI_ENABLED` 的注释补成六模式 | ✅ | 与 R-B3① 是同一事实的两个副本，**两处口径一致** ✓ |

**C 段**（`AGENTS.md` 3 处、`README.md` 2 处）在 §8。

---

## 8. 工作区独有：`HEAD` → worktree（10 文件 / 16 处，逐处）

> ⚠️ **读数时点**：本轮开始时 `git status` 是 **8** 个文件（§1.3 初稿写的就是 8），收尾时是 **10** ——
> 多出的两个是 `public/ui_v1/js/components/list.js` 与 `test/manual/probe-ui-v1.mjs`。
> 本文按**收尾时**的 10 文件 / 16 处为准，两个读数都留在这里（§11 第 2 条）。

| # | 文件 | 处 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|---|
| W-1 | `AGENTS.md` | 3 | 引文说明改成**两类**（`motion-web` 技能的两份 = **要求来源**，引用处必须就地写全；`v4.1.md` = **证据来源**，只需写明"不在本仓库"）；`d32631b` 的惯例改成**引原文**（提交信息里的原话） | ✅ | **实测**：`git log --all -- v4.1.md` 空输出 + 工作区无此文件 ⇒ "不在本仓库"成立 ✓；`git log --format=%B -1 d32631b` 与注释里引的那段**逐字相同**（含"**不得当作已通过引用**"）✓ |
| W-2 | `README.md` | 2 | 五份台账行补**口径**（src 91→本轮 87、test 19 条/90 处、docs 22 条/111 处、root 的 146/157 差额）；`ui-rename` 那行"八个坑"→"**十个**坑" | ✅ | **实测**：`-U0 src` = 87 ✓、`-U3 test` = 90（19 条）✓、`-U3 docs` = 111（22 条）✓、root 差额 11 条 ✓（§1.2）；`ui-rename-v1-v2.md` §3 的坑**逐条数 = 10** ✓ |
| W-3 | `docs/design.md` | 1 | D17 里"资源前缀写死的 `/ui_v1/*`"→「`/ui_old/*`（**当时叫这个名**）」 | ✅ | 与 D-5 同一条判据（用当时的名字叙述当时的事）；`ui_old` 是 2026-09-19 才改的名 ✓ |
| W-4 | `docs/progress.md` | 1 | §96 那行的订正**又重写了一遍**（加"逐版复核"与 `v4.1.md` 的出处） | 🩹 **W#1**：新写的三句**都不成立**（§9）⇒ 本席已就地订正 |
| W-5 | `docs/ui-v2-design.md` | 3 | 三处**行号锚**换成标识符锚（`main.js` 的 `refreshStats()`；`src/db.ts` 的 `statistics()`；`boot.js` 里那条 `api.poll`） | ✅ | **实测**：`api.statistics` 在 V1 **只有 1 处调用**（`main.js:431`，在 `refreshStats()` 内）✓；`db.statistics()` 存在（`src/db.ts:382`）✓；`boot.js` 里 `api.poll` 只有 1 处（`:658`）✓ |
| W-6 | `public/ui_v1/js/components/list.js` | 1 | 级联尾巴 `480ms` → **`440ms`** | ✅（值对）+ 🩹 **W#2**（同一事实的两个副本没跟上，§9） | 实现在 `motion.css:41`：`animation-delay: calc(var(--row-index, 0) * 40ms)`，而 `--row-index` 只给 `index < ENTER_STAGGER_LIMIT(12)` 的行设成 `String(index)`（`list.js:478`）⇒ 下标 **0…11** ⇒ 尾巴 = **11 × 40 = 440ms** ✓ |
| W-7 | `public/ui_v2/js/theme-init.js` | 1 | 深色 `--bg` 读数的出处写明"取自 **V1 的探针**"，并给出**本文件这一版**（V2）的两个值 `#15191a` / `#f5f2ee` | ✅ | **实测**：`tokens-v2.css:221` = `--bg: #15191a`、`:57` = `--bg: var(--c-warm-100)` = `#f5f2ee`（`:25`）✓；`tokens.css`（V1）`:156` = `#191817`、`:17` = `#faf8f5` ✓ ⇒ 两版四个值都与注释一致 |
| W-8 | `public/ui_v2/js/theme.js` | 2 | 同 W-7 的出处订正 + 把两个值与 `--c-warm-100` 对齐 | ✅ | 同 W-7 的实测（`#f5f2ee` = `--c-warm-100` ✓） |
| W-9 | `src/db.ts` | 1 | `substr` 与 LIKE 的偏差写成**两个方向都有**（更宽 = 不锚定前一个分隔符；**更严** = 大小写，`=` 对 TEXT 是 BINARY 而 LIKE 对 ASCII 不区分大小写） | ✅ | SQLite 语义成立（`LIKE` 默认 ASCII 不分大小写；`=` 用列的排序规则，TEXT 默认 BINARY）；且终态由调用方 `basename(...) === fileName`（JS 大小写敏感）定义 ⇒ "更严"那半**不会**漏候选（否则就是新缺陷，此处不是） |
| W-10 | `test/manual/probe-ui-v1.mjs` | 1 | `noticeVisible: q('.notice-bar') ? !q('.notice-bar').hidden : null` → `noticeBarRemoved: q('.notice-bar') === null` | ✅（**修好后实跑通过**，读出 `noticeBarRemoved: true`）＋ 🩹 **W#5**（同一处编辑把 6 个反引号写进了模板字面量 ⇒ 整份探针不可运行；`node --check`：HEAD 版 exit 0 / 工作区版 exit 1。已修，见 §9） | 缺席断言成立（有人把提示条加回来就变 `false`）；原式的 `null` 确实**既不可判别、也无变化空间**（提示条已整条移除）✓。⏸ **观察（W#3）**：键名变了，而两份文档里的**当轮读数**（`progress.md:5740`、`ui-rename-v1-v2.md:146`）仍写着 `noticeVisible=null` —— 那是带日期的历史读数（可接受），但照它复跑今天找不到这个键 |

---

## 9. 本轮查出的问题（5 条：4 条已修，1 条记为观察）

### W#1 `docs/progress.md:7452` 的"逐版复核"三句**都不成立**（🩹 已修）

原文（工作区写入的）：

> 该 `\"` 在**任何已提交版本里都不存在**（基线 `6ebcf6e` 甚至没有那一行；`645c2f8` / `fdde201` / `HEAD`
> 三版都已是直角引号「大小写不敏感」）—— 原判据取自**当时的未提交工作区**……

实测（一条命令即可复算）：

| 说法 | 真值 | 判据 |
|---|---|---|
| "在任何已提交版本里都不存在" | **假** —— `e559b4c`（本范围内第 17 笔）的 `src/ui/query.ts:457` 逐字是 ``  // 下面那句\"大小写不敏感\"的过滤根本没机会生效。 `` | `git show e559b4c:src/ui/query.ts \| sed -n '457p'` |
| "基线 `6ebcf6e` 甚至没有那一行" | **误导** —— `6ebcf6e:460` 有一句"哈希比较**大小写不敏感**…"（是**另一句**，本来就没有 `\"`）；带 `\"` 的那一行是 `e559b4c` **引入**、`645c2f8` 收成直角引号的 | `git show e559b4c^:src/ui/query.ts \| sed -n '/\\\\"/='` → 空（引入者 = `e559b4c`） |
| "原判据取自当时的未提交工作区" | **假** —— 原判据的行号 `:457` 正是 `e559b4c` 里那一行；它量的是一棵**已提交**的树 | 同上两行 |

⇒ **原判据（":457（今 :473）有 `\"`、只有一处"）本来是对的**，错的是这次"订正"。已按实测改写
（并保留"凡这类结论都要写明在哪棵树上数的"那条纪律 —— 它本身是对的）。教训见 §11 第 6 条。

### W#2 级联尾巴 440 / 480 的**三个副本口径打架**（🩹 已修）

- **真值**：`motion.css:41` 的 `animation-delay: calc(var(--row-index, 0) * 40ms)` + `list.js:478` 只给
  `index < 12` 的行设 `--row-index = String(index)` ⇒ 下标 **0…11** ⇒ 尾巴 = **11 × 40 = 440ms**。
- **改动落盘前的三处**：
  1. `list.js:752`（工作区已改）= **440** ✓ —— 值是对的；
  2. `docs/progress.md:6137` = 把 440 判成**错**、把 `12 × 40ms = 480ms` 当"实测值"⇒ **结论错**
     （把 12 行的**下标**当成了 12 个**步长**）；
  3. `docs/ui.md` 三处（`:221` / `:489` / `:777`）= 数是 440，但算式写成"**12 行 × 40ms = 440ms**"
     ⇒ **算式不成立**（12×40 = 480）。
- **处置**：① `ui.md` 三处的算式改成 `(12 − 1) × 40ms = 440ms` 并写明"下标 0–11"；② `progress.md:6137`
  加一条带日期的订正（指向 §103）；③ `list.js` 的值**不动**（它是对的）。
- 理由：这正是 F-12 立下的那条 —— **数字要连范围/口径一起写**。算式错了，下一个照它算的人就会得出 480。

### W#3（观察，未动）探针键名改了，两份文档的**当轮读数**没跟

`noticeVisible` → `noticeBarRemoved`（W-10）。`progress.md:5740` 与 `ui-rename-v1-v2.md:146` 里
"`noticeVisible=null`（提示条确已移除）"是**带日期的当轮读数**，按本仓判定规则可接受；
但读者若照它复跑，会发现输出里没有这个键。**记为观察**：要么那两处补一句"键名已于 2026-09-20 改名"，
要么保持现状（历史读数不追改）。本轮选择**不动**（理由：它是历史读数，动它反而制造"当时就写了新键名"的假象）。

### W#4 本文自己的两处口径写错（🩹 已修）

| 处 | 初稿 | 真值 |
|---|---|---|
| §1 头部/§1.2 | "后 4 笔提交又动了 **11 个文件**" | **53 个文件 / 123 处**；11 是"**从未被覆盖**"的那部分（§1.2 已补 11 vs 42 的分表） |
| §1.3 | "工作区独有（`HEAD` → worktree）｜**8**" | **10**（收尾时；多出的两个是 `ui_v1/js/components/list.js` 与 `test/manual/probe-ui-v1.mjs`） |

### W#5 工作区编辑让 `test/manual/probe-ui-v1.mjs` **整份不可运行**（🩹 已修，**由跑门禁抓出**）

- **现象**：`node --check test/manual/probe-ui-v1.mjs` → `SyntaxError: missing ) after argument list`（`:269`）；
  `node test/manual/probe-ui-v1.mjs` 同样直接退出（exit 1）—— **整份探针一行都跑不了**。
- **根因**：给 `noticeBarRemoved` 补的三行注释里有 **6 个反引号**，而那一整段是**模板字面量**
  （`read(\`(() => { … }\`)`）⇒ 反引号提前终止模板。这正是本仓记过的 **N-14 形态**
  （`progress.md:6301`：`states.mjs` 的"模板字符串内裸反引号 ⇒ 整份文件不可运行"，2026-09-18 修过一次）。
- **证据**：`git show HEAD:test/manual/probe-ui-v1.mjs` 写出到临时文件后 `node --check` = **exit 0**；
  工作区版 = **exit 1** ⇒ 由这次**未提交**编辑引入。而同一文件**下方两行**就写着"本条注释里不能出现反引号：
  整段是模板字面量"（`overflowers` 那条）—— 规则就在眼前，仍然踩了第二次。
- **处置**：去掉反引号（内容保留）；并把"四个 `test/manual/*.mjs` 各跑一次 `node --check`"写进
  `AGENTS.md` §2 的 DoD（它们既不在 `tsc` 的 include 里、也不进任何套件，**没有任何门禁盯着**）。
- **验证**：`node --check` ×15 全绿；V1 探针实跑 `findings=0`、零 console 错误、零失败请求，读出 `noticeBarRemoved: true`。
- **教训**：**静态核实读不出语法错误**。本文上一版把这处标成 ✅（只审了断言语义），漏掉的正是"这份文件还能不能跑"。

---

## 10. 未核实边界（本文的"✅"**不能**读成"跑过了"）

1. **门禁**（2026-09-20 **补跑**，用户放开口径后）：`tsc --noEmit` **0 错**（exit 0）、
   `eslint public/ui_v2/js public/ui_v1/js` **0 告警**（exit 0）、
   **22 套件 / 433 用例全过**（`vitest run --no-file-parallelism`，exit 0；dev server 8787）、
   `node --check` ×15（本轮改过的前端 JS + 四个 `manual/*.mjs`）**全绿**、
   浏览器探针 **V1 与 V2 各跑 4 次**（1440 / 390 / 390+`--touch`|`--coarse`）：**`findings=0` / `problems=0`、
   零 console 错误、零失败请求**（exit 0）。
   ⇒ 这一条**从"未跑"变成了"跑过并通过"**；下一条里的数字随之被**实测**替换。
2. **原先"未起浏览器"的实测数字，现已量到 5 个档**（4 次探针运行）：V1 表格档骨架 **47**
   （`SKELETON{realMin:47,realMax:47,skeleton:47,skPitch:59,gap:0}`、`rowHeights:[47]`）、
   V1 卡片档 **103**（`mode:card, skeleton:103, gap:0`）、V1 卡片粗指针 **117**（`--coarse`，
   `coarseMatches:true, SKELETON.skeleton:117`、`COARSE{size:[44,44],gap:10px}`）、
   V2 表格档 **77** 与卡片档 **125** / 粗指针 **135**（`ghostH/rowModeH` = 77 / 125 / 135，
   `controlHSm` = 28px / 28px / **44px**）⇒ **`AGENTS.md` §1 那两条骨架行高等式（47 与 103/117）实测成立**。
   另实测命中：V1 `THEMECOLOR.meta=#faf8f5`、`THEMESWITCH{light→dark: #faf8f5→#191817}`（W-7/W-8 的归属得到证实）、
   `noticeBarRemoved:true`（W-10）、V2 `PRVCLOSE` 三段形状与 `EMPTY{blank:"filter"}` ✓。
   **A-02 那族数（CLS 0.90 / 804 / 4454 …）已从"不可复核"变成"每次可复核"**（2026-09-20 晚）：
   两版探针各新增 `PERF` 组（`layout-shift` 非输入位移之和 + 加载各阶段高度快照），并断言
   「首屏 CLS ≤ 0.01」与「首帧页脚在折线以下」；**并借此查出两条真缺陷**（见 `progress.md` §103.9）：
   V2 的 `70vh` 只在矮视口成立（1306px 视口 CLS 0.8548）⇒ 改构造性的 `100vh`；
   V1 从未量过的首屏 CLS = **0.928** ⇒ 同修 + 按实测高度预留 `.stats`/`.toolbar`（0.928 → 0.0057）。
   **两族都收口了（2026-09-20 晚）**：`6642 / 6683.05` 已用**构造数据集**实测（注入 50 张同形卡片 +
   1 条分组标题、不写库）：`49×125 + 1×124 + 34.05 + 50×8 = 6683.05` ⇒ **逐位复现当年读数（差 0）**，
   差 **41.05 = 34.05 + 8 − 1**；
   `384 / 3930 / 804 / 4454` 是**修前**读数 —— 同位置的今日实测值已由 `PERF` 组给出。
   顺带量到一条**新残留**并登记（不在本轮修）：V2 @390 首屏 CLS = 0.0936（< 0.1 的 "good" 阈值）。
3. **四份台账里的"逐字一致"是脚本跑的**（`.audits/_hunkverify.mjs` / `_coverage2.mjs` / `_docrefs.mjs` /
   `_preload.mjs` / `_claims.mjs` / `_arith.mjs` …），本轮**未复跑那些脚本**；本轮改跑了一份**新的**
   断言级复核（`.audits/_r103_check2.mjs`：从 `6ebcf6e..da1ee44 -- docs/` 的 17 个文件里抽出
   **213 处 `文件:行` + 256 处 `docs/*.md` + 203 处 `§N`** 逐条对树核）⇒ **硬问题 0 条**；
   62→12 条报警全部落在三类**已知噪点**上：快照期历史名（27 条，按 D-5/D-11 判据**应当**保留）、
   §归属的同行启发式（24 条）、以及把**引文复述**当成引用（1 条）。
   ⚠️ 这条经验本身值得记：**机械复核在"改名过的仓库"上会大面积误报**，判据必须带豁免名单
   （同 `progress.md` §102.6/§93.5 第 5 条）。
4. **`docs/progress.md` §95–§102 里的当轮读数未逐条复算**（只在"与本文 scope 重叠"处交叉复核，0 处矛盾）。
5. **D-10（归档横幅的「44 处 / 23 文件 / 28 编号」）—— 已从"未决"推进到"差额有精确账"**：
   横幅落地那棵树（`da1ee44`）上按"同一行含文档名与 `§x.y`、排除文档自身"的口径复算得
   **53 处 / 24 文件 / 29 编号**；分组里 **`public/ui_v2/**` 16、`public/ui_v1/**` 10、`test/**` 3、
   `src/**` 1 —— 四组与横幅逐位相同**（正是横幅记的"源码 27 + 探针 3"），
   差额**全部**在"文档与记忆"那一组（我数 21+2 = 23，横幅记 14）。
   ⇒ **2026-09-20 用户决定：横幅正文已改成可复算的 53 / 24 / 29**（旧值保留在其补记供对照，
   口径与检索式写在横幅里）；本文把口径、读数与差额根因登记在此，复算过程见 `progress.md` §103.11。
   另：`HEAD` 上同口径是 71/31/36，`ui_v2` 由 16 变 **19** 恰好 = **F-11 那三处修复**
   （`board-v2.css:747` §6.1、`tokens-v2.css:293` §6.2、`board.js:35` §6.3）⇒ 又一次印证 §102.6
   "先确认自己在哪棵树上数"。
6. **本文自身会改变自己量的东西**：新增 `docs/` 行、订正 `README.md` / `progress.md` / `ui.md` ⇒
   `docs/**`、根目录的计数会变。**末次读数在 §1.3 的表下注明**（`docs` 171 → 落盘后 **174**；
   `public` 335 / `test` 180 / `src` 87 不受影响）。
7. **`git status` 会在评审期间再变**：本轮实测到一次（8 → 10 个文件）。⇒ 任何"工作区有 N 个文件"的
   断言都要连时点。

---

## 11. 方法与教训（本文自用，也可给下一轮照用）

1. **"每份都真" ≠ "合起来全"**：五份台账各自 100% 覆盖自己的 scope，合起来仍是 **146/157**；
   而 157 之外还有"已覆盖文件的追加 hunk"（91 处）—— 只数文件会漏掉这一层。
   ⇒ 证明"全覆盖"必须**从一个口径（`git diff 6ebcf6e`）倒推**，不能把几份的覆盖相加。
2. **口径要连"时点"一起写**：同一段 diff 有四种读法（`-U0`/`-U3` × `..HEAD`/工作区），四种都能数出
   不同的数（`src/` 87 vs 91、`docs/` 171 vs 111 都是这一条）。**数字不写口径与时点，就是噪声** ——
   本节自己的两处笔误（W#4）就是被这条抓出来的。
3. **"当轮快照"与"本轮实测"要分栏**：91↔87、208↔330、79↔164、101↔160 都不是谁错了，是**口径不同**。
   工作区的 README 行已示范正确写法（"当轮 `-U3` 口径；本轮实测 87"）。
4. **行号是注释里最先腐烂的东西**：B/C 两段查出的缺陷**全是引用类**（F-1…F-4、F-3 的第二形态、
   `ui-v2-design` 三处）——修法一致：**换成可检索的标识符锚**（函数名 / 那条 `if` / 端点名）。
5. **数字对 ≠ 算式对**（W#2）：`12 行 × 40ms = 440ms` 与 `12 × 40ms = 480ms` 是同一事实的两个副本，
   一个算式错、一个结论错。**写算式就是给下一个人的复核留判据 —— 算式错了，判据就是反向的。**
6. **"订正"本身也要复核**（W#1）："该 `\"` 在任何已提交版本里都不存在"一句，一条
   `git show <rev>:<file> | sed -n 'Np'` 就能证伪；而它要否定的原判据**本来是对的**。
   ⇒ 凡"订正 / 已修 / 已复核"这类**自述**，必须与原始证据对一遍（§102.6 已立过同一纪律）。
7. **引用外部文档要分"要求来源"与"证据来源"**（W-1 的固化）：前者必须就地写全（照做不必找原文件），
   后者只需写明"不在本仓库"。这两类混为一谈会让读者去找一份根本不存在的文件。

8. **"能读懂" ≠ "能运行"**（W#5）：本文上一版把 `probe-ui-v1.mjs` 那处编辑判成 ✅ —— 语义层面确实没错，
   而当时那份文件**语法都不合法、一行都跑不了**。⇒ 对"不在任何门禁射程内"的文件（`test/manual/*.mjs`、
   零构建的前端模块），**最便宜的门是 `node --check`**（一条命令）；本轮已把它写进 `AGENTS.md` §2。
9. **门禁跑不跑，结论强度差一个数量级**：同一份台账，"读过"给的是 ✅，实跑给的是"22 套件 / 433 用例全过 +
   两版探针 findings=0"以及 47/103/117/77/125/135 六个**实测**读数。**能跑就该跑**（本轮教训的直接来源）。

**本轮的实际动作**：修 `docs/progress.md` 的两处（W#1 的订正、`:6137` 的带日期订正）+ `docs/ui.md`
三处的算式（W#2）+ `README.md` 的文档表补一行指向本文 + 在 `docs/progress.md` 追加 §103（含 §103.6–§103.8：
门禁结果、W#5、D-10 收口）+ **修 `test/manual/probe-ui-v1.mjs` 的模板字面量反引号**（W#5）+
把四个 manual 脚本的 `node --check` 写进 `AGENTS.md` §2 的 DoD。
**本文自身未进版本库**（`?? docs/AUDIT-full-diff-6ebcf6e.md`）—— 是否提交由用户决定。
**未动**：`list.js` 的值（它对）、探针键名的历史读数（W#3）。归档横幅的数字已按用户决定改成可复算的 53/24/29。
