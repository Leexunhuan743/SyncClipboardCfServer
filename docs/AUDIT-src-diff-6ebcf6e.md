# 逐处核实台账：`6ebcf6e` → 最新，`src/` 的**每一处** diff

> 生成：2026-09-20 · 基线 `6ebcf6e` · 已提交段 `6ebcf6e..HEAD`（HEAD = `da1ee44`）· 工作区未提交段 HEAD→worktree
> 规模（脚本从 `git diff -U0` 数出来，非手写）：**91 处 hunk / 20 个文件**，其中
> 已提交段 62 处（19 文件，+177 −111）—— **2026-09-20 复核：逐位吻合**；
> 工作区段落笔时 29 处（10 文件，+160 −48），复核时 **31 处 / +174 −50**，本轮收尾改完 `db.ts` 那处措辞后
> **32 处 / +176 −51** —— 三个读数都列出来是因为**这一栏会随每次 `src/` 改动腐烂**（逐处见 **§8**）。

**核查方式**：全部为**静态判据** —— 读当前代码、读 `git show <基线>:文件` 的旧文（按字节核）、读上游 C# 源码与 `docs/`、跑可机械复算的脚本；一处一处过，
每过一处就在下表写一行判定与判据。**本轮按用户要求未运行任何测试**（`tsc` / `eslint` / `vitest` / 浏览器探针均未跑），
凡引用「实测」的地方都注明是**哪一轮的读数**（§95 等），没有本轮复跑的读数混进来。

**图例**：✅ 正确｜🔁 **等价**（改动前后行为逐位相同）｜🩹 **缺陷（已在本轮或前轮修）**｜⬜ 待核实

---

## 0. 结论

| 判定 | 处数 |
|---|---|
| ✅ 正确（逻辑与注释都与事实一致） | 73 |
| ✅ 正确，但有口径备注（含「有意行为改变」） | 4 |
| 🔁 等价（死赋值 / 纯空白 / 纯改名 / 同引号） | 8 |
| 🩹 查出问题（含前轮已修的改名残留） | 6 |

**查出的问题（6 条，全部已处置，见 §4）**：

D 编号与 hunk 的对应：D1→A#57；D2→B#67；D3→A#47；D4→**不在某个 `src/` hunk 上**（问题在 `docs/AUDIT-redundancies.md` 的两行）；D5→B#77 与 B#78；D6→A#59。

| 编号 | 问题 | 处置 |
|---|---|---|
| D1 | `src/ui/query.ts` 的 `\"` 转义残留（A#57 引入）+ `docs/progress.md` §95.3 第 2 行**记录了从未落地的修复** | 改代码 + 订正记录（本轮） |
| D2 | `src/db.ts` 例句「就 60 字节」实测 **59**（两法一致） | 订正数字，并补「模式 = `%/` + 名字 = 61 > 50」（本轮） |
| D3 | `docs/protocol.md:230`、`test/fixes.test.ts:827` 仍写**不存在**的 `listHistoryWorkingDirs`（A#16/A#44/A#47 只改了 3 处 src 注释，同一事实的另两处漏改） | 按实际方法名改回（本轮） |
| D4 | `docs/AUDIT-redundancies.md` 的 C-05 两处声称「已登记在 `docs/protocol.md` §10」，而 §10 没有这一条（A#13 的新注释恰好相反） | 订正为按节名指向 `SearchText` 口径（本轮） |
| D5 | `src/serialization.ts` 把「null 等价缺省」用到了**非空值类型**上：`{"type":null}` 与 `{"hasData":null}` 上游是 STJ 反序列化失败 ⇒ **400**，本实现按缺省处理 | 对齐 400 + 同步唯一钉住旧行为的用例（本轮） |
| D6 | **改名残留**（A#59）：`/ui_v2/不存在` 是改名**之后**才有的名字，却用来叙述改名前的实测（`git show 380b5da` 原文是 `/ui/不存在`） | 前轮已按 §94.4 判据写回旧名 + 注明「当时叫…」（B#89） |

> A#23/A#25/A#26 那组「三岔 → 两岔」的重写含 **2 处有意行为改变**（裸 `/ui/api` 的形态、以及关闭态下它的响应），
> 这不是等价项，但**是修缺陷**（B#70/B#91 落实，理由见对应行）。

---

## 1. A 段 —— 已提交 `6ebcf6e..HEAD`（62 处 / 19 文件）

行号 = **HEAD 内容**（`git show HEAD:文件`）里的行号；该段的每一处都已提交（`+177 −111`）。

### 1.1 `src/cleanup.ts`（11 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#1 | `src/cleanup.ts:95` | 段头改写（D→F 契约 → 清理任务写 / UI 只读的共享键名） −1/+1 | ✅ 正确 | 全仓已无 `D→F` 字样（0 处）；新措辞与**承载者**一致 —— 该头下面就是 `CLEANUP_META_KEYS`（cleanup 写、`/ui/api/info` 只读），而「UI 写、cleanup 读」的 `SETTINGS_META_KEYS` 另有自己的段落头（:125） |
| A#2 | `src/cleanup.ts:154` | 注释同步改名（parsePositiveInt → parseNonNegativeInt） −1/+1 | ✅ 正确 | `parseSettingValue`（:157-161）确实**没有**复用 `parseNonNegativeInt`：它要能表达 null（未配置） |
| A#3 | `src/cleanup.ts:251` | 函数改名 + 补「0 是合法值」注释 −1/+3 | ✅ 正确 | `git diff -U0` 该 hunk 只换签名行（−1/+3），函数体 `Number.isSafeInteger(n) && n >= 0` 未动 ⇒ 纯改名；旧名与「0 合法」的矛盾由新注释写明 |
| A#4 | `src/cleanup.ts:522` | 新增 DISABLED_KEY + disabledReason 收第 4 个形参 −4/+25 | ✅ 正确 | `SETTINGS_META_KEYS.retentionMinutes === 'settings:retentionMinutes'` ⇒ 关闭成因串正是 `settings:retentionMinutes=0`（与 §95 真机读数一致）；env 分支写 `HISTORY_RETENTION_MINUTES`。内置默认 10080 / 1000 不可能是 0 ⇒ 「只有两种形态」成立 |
| A#5 | `src/cleanup.ts:575` | settings 提到外层（let settings: RetentionSettings） −2/+2 | ✅ 正确 | 两个分支（try / catch）都赋整份值，类型确定赋值成立 |
| A#6 | `src/cleanup.ts:579` | try 分支改为整份赋值 −3/+1 | ✅ 正确 | 生效值算法未变：`?? DEFAULT_*` 仍在 :601-602 |
| A#7 | `src/cleanup.ts:582` | catch 分支补 retentionSource / maxCountSource = env −2/+8 | ✅ 正确 | 与 `readRetentionSettings` 的「无覆盖」分支同义（读 Meta 失败 = 没有覆盖），取值仍 `parseNonNegativeInt(env…)` |
| A#8 | `src/cleanup.ts:591` | 两个派生常量移到 try/catch 之后 −0/+2 | ✅ 正确 | 值仍 `settings.X ?? DEFAULT_*`；try 内无读者 ⇒ 等价 |
| A#9 | `src/cleanup.ts:600` | 游标解析改用改名后的函数 −1/+1 | ✅ 正确 | 同 A#3 的函数 |
| A#10 | `src/cleanup.ts:608` | disabledReason 传参与 settings 对齐 −1/+1 | ✅ 正确 | 形参是 `Pick<RetentionSettings, 'retentionSource' | 'maxCountSource'>`，索引 `[source.retentionSource]` 键名匹配 `DISABLED_KEY` 的两键 |
| A#11 | `src/cleanup.ts:640` | 删掉 result.subrequests 的一次赋值 −2/+0 | 🔁 等价 | `git show 6ebcf6e` 显示旧 :612 与旧 :629 两次赋值，中间只有「自带 try/catch 的收尾落库」⇒ 后者无条件覆盖前者；删掉后留下的那次**含收尾成本**，更准 |

### 1.2 `src/db.ts`（5 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#12 | `src/db.ts:261` | 按位测试的注释改准（Types 接受数字） −2/+4 | ✅ 正确 | 上游 `ProfileType`（Text=0…Unknown=4、None=5）与 `ProfileTypeFilter.All = Text|File|Image|Group = 15`；上游 `HistoryService.cs:138-140` 正是 `Enum.GetValues(typeof(ProfileType)).Where(t => (types & (ProfileTypeFilter)(1 << (int)t)) != 0)` ⇒ `Types=16` 落到 Unknown 与上游同形 |
| A#13 | `src/db.ts:281` | 分面登记处改指 C-05 −1/+2 | ✅ 正确 | `docs/AUDIT-redundancies.md:110` 与 `:354` 的 C-05 就是这条分面；`docs/protocol.md` §10 共 49 行里**没有**搜索转义这一条（只有 :497 的 hash LIKE、:502 的 hash 大小写）⇒ 新注释两句话都成立 |
| A#14 | `src/db.ts:293` | 防御性钳制的注释改准（谁负责 int32） −2/+4 | ✅ 正确 | `src/routes/history.ts:76-91` 的 `parseCSharpInt32` 把 Page 限进 int32、越界抛 400 ⇒ 「路由层校验」成立。（括号里「溢出」是口径不严的措辞：JS 里越过安全整数范围是**丢精度**而非报错 —— 记在 §96 的措辞项，未改） |
| A#15 | `src/db.ts:442` | 删一个空行 −1/+0 | 🔁 等价 | 空白改动 |
| A#16 | `src/db.ts:509` | 注释里的函数名改成 listHistoryObjectsByDir −1/+1 | ✅ 正确 | `listHistoryObjectsByDir` 存在于 `src/storage.ts:143`。⚠️ 同一句话的另外两处（`docs/protocol.md:230`、`test/fixes.test.ts:827`）当时漏改 ⇒ 见缺陷 D3 |

### 1.3 `src/durable/SyncClipboardHub.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#17 | `src/durable/SyncClipboardHub.ts:52` | MAX_QUEUED_BYTES 的口径注释 −0/+3 | ✅ 正确（措辞可更严谨） | `lp.queuedBytes += message.length`（:425）= UTF-16 码元数；常量 `1_000_000` 与 `test/rate-limit.test.ts` 的引用都在。「1 码元 ≤ 2 字节」的前提是 **V8 字符串内存**（队列持 JS 串）；按 UTF-8 线格式读，CJK 是 1 码元 3 字节 —— 界仍成立，故未改（与 §95 同判定） |
| A#18 | `src/durable/SyncClipboardHub.ts:178` | 删一个空行 −1/+0 | 🔁 等价 | 空白改动 |

### 1.4 `src/env.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#19 | `src/env.ts:6` | env 注释补三界面前缀与 run_worker_first 清单 −2/+4 | ✅ 正确 | `wrangler.toml` 的 `run_worker_first` 实测为那六个模式，与注释逐字一致 |

### 1.5 `src/hash.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#20 | `src/hash.ts:102` | hash.ts 的余量数字随上限改（80→64 MiB） −1/+1 | ✅ 正确 | `MAX_REQUEST_BODY_BYTES_CEILING = 64 MiB`、`ISOLATE_TRANSFER_BUDGET_BYTES = 96 MiB`（`requestLimits.ts:18/25`）⇒ 96−64 = 32 MiB，注释可复算（旧文写 80 MiB / 16 MiB，是上一版上限） |

### 1.6 `src/index.ts`（6 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#21 | `src/index.ts:57` | Hono 声明行的注释移到上方 + 补回分号 −1/+3 | ✅ 正确 | 旧行按字节核：`…({ strict: false }) // 尾斜杠容忍…）;` —— **分号在行尾注释之后**，确实被注释掉、语句只靠 ASI 成立 ⇒ 注释所述属实 |
| A#22 | `src/index.ts:163` | 全局守卫注释改写（跳过真正覆盖谁） −1/+4 | ✅ 正确 | 跳过判据在 `src/index.ts:176` 的 `c.req.path.startsWith('/ui/')`；「真正覆盖的只有 `/ui/api/*`」成立，因为三个挂载点的页面与资源在入口就被 A#23 那条分支返回/收口 |
| A#23 | `src/index.ts:221` | 三岔界面分支改写为 isUiAsset + isUiApi −16/+24 | ✅ 正确（含 2 处有意行为改变） | 逐路径核过：`/ui/x`、`/ui`（裸）、`/ui_v1/*`、`/ui_v2/*` 在「开关两态」下与旧三岔同码同体（旧 `/ui/x` 未命中资源后经 Hono 的 `app.all('/ui/*')` 回**同一张** 404 页，状态码同为 404）；有意的改变只有「裸 `/ui/api`」（见 B#70 与 D 表） |
| A#24 | `src/index.ts:246` | 三面共用回落链的注释改写 −3/+4 | ✅ 正确 | 三面都是「ASSETS.fetch → 非 404 直接返回 → 否则 notFoundPage」（`notFound.ts:83-84` 的状态码为 404） |
| A#25 | `src/index.ts:251` | 删掉旧三岔中的 isArchivePath 分支 −14/+0 | 🔁 等价 | 旧分支与新的合并分支逐路径等价；旧文里的 `/ui_old` 是**改名前的真名**，本次随改名一并收敛 |
| A#26 | `src/index.ts:255` | 把 isUiApi 关闭态判断提成独立语句 −0/+4 | ✅ 正确 | 与原 `else if (isUiApi && !isUiEnabled(env))` 同条件、同响应（`uiDisabledResponse(true)`） |

### 1.7 `src/pathCase.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#27 | `src/pathCase.ts:13` | pathCase 注释补界面前缀与「确实先进 Worker」 −3/+4 | ✅ 正确 | `SEGMENT_1 = ['api', 'file', 'SyncClipboard.json', 'SyncClipboardHub']` 只有协议面；「界面前缀确实会先进 Worker」由 run_worker_first 的六模式证实 |
| A#28 | `src/pathCase.ts:51` | 同一句里的地名补全 −1/+1 | ✅ 正确 | 与 A#27 同源 |

### 1.8 `src/profile.ts`（3 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#29 | `src/profile.ts:3` | profile.ts 删掉 tempKey 的 import −1/+1 | ✅ 正确 | `tempKey` 全仓只在 `src/storage.ts` 内使用（:14 定义、:57/:61/:65 三处调用）⇒ profile.ts 那处是死引用 |
| A#30 | `src/profile.ts:454` | tranfer 拼写的来由注释 −0/+3 | ✅ 正确 | `docs/upstream-parity.md:119` 的「状态码/文案」条目逐字含 `"Needs tranfer data."`；`docs/protocol.md` §5.1 与 §8.1 也有该串；`test/fixes.test.ts` 按它断言 |
| A#31 | `src/profile.ts:621` | addRecordDto 那处 400 加同行注释 −1/+1 | ✅ 正确 | 第 622 行的注释确实指向 `addRecordDto` 函数体内那条（同文件 :454） |

### 1.9 `src/rateLimit.ts`（4 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#32 | `src/rateLimit.ts:18` | 限速注释：失败 → 请求 −1/+1 | ✅ 正确 | `AUTH_RATE_LIMIT_MAX_FAILURES = 10`（:28）⇒ 计数满 10 之后**第 11 次请求**即被拦，旧措辞「第 11 次失败起」不准确 |
| A#33 | `src/rateLimit.ts:93` | 加一个空行 −0/+1 | 🔁 等价 | 空白改动 |
| A#34 | `src/rateLimit.ts:237` | 与 A#32 同款的措辞订正 −1/+1 | ✅ 正确 | 同上 |
| A#35 | `src/rateLimit.ts:262` | filter 里藏副作用 → 显式循环 −2/+8 | ✅ 正确（逐位等价） | 新代码用 `cleared` 收集「真的删掉了」的键，与原 `filter(k => cache.limits.delete(k))` 的返回值同长 ⇒ 是否通知 DO 的判据不变（正常同步路径仍零 I/O） |

### 1.10 `src/requestLimits.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#36 | `src/requestLimits.ts:12` | 请求体上限注释的场景改准 −2/+3 | ✅ 正确 | 上游 `SyncConfig.cs:23` `MaxFileByte { get; set; } = 1024 * 1024 * 20; // 20MB`；本仓 `MAX_REQUEST_BODY_BYTES = 48 MiB`、`CEILING = 64 MiB` ⇒ 「默认 20 MB 低于这里的默认上限」成立 |

### 1.11 `src/routes/history.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#37 | `src/routes/history.ts:223` | routes/history.ts 的分号与注释（同 A#21） −1/+3 | ✅ 正确 | 按字节核旧行：分号在行尾注释之后 ⇒ 注释所述属实 |
| A#38 | `src/routes/history.ts:267` | 把「同款实现」的引用从行号改成名字 −1/+2 | ✅ 正确 | `fileHeaders()` 存在于 `src/contentTypes.ts`；改按**名字**引用正是「行号会漂」的修法 |

### 1.12 `src/routes/webdav.ts`（4 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#39 | `src/routes/webdav.ts:22` | routes/webdav.ts 的分号与注释（同 A#21） −1/+3 | ✅ 正确 | 按字节核旧行：分号在行尾注释之后 |
| A#40 | `src/routes/webdav.ts:29` | 关闭态不再指向具体界面前缀 −1/+1 | ✅ 正确 | `src/routes/webdav.ts:37` 的 `&& isUiEnabled(c.env)` ⇒ 关闭态回落 `Server is running.`，不再把人引向任何界面 |
| A#41 | `src/routes/webdav.ts:31` | 跳转目标注释改准（/ui_v1/ + 两处一致 + 守卫名） −4/+4 | ✅ 正确 | 实测 `src/routes/webdav.ts` 的 302 目标是 `/ui_v1/`、`public/ui/index.html` 的 meta refresh 目标也是 `/ui_v1/`；`test/ui-guard.test.ts` 的「默认界面的入口链一致」把 302 / meta refresh / canonical 三处都抽出来钉住（空集合会先失败） |
| A#42 | `src/routes/webdav.ts:37` | 302 目标 /ui_old/ → /ui_v1/ −1/+1 | ✅ 正确 | 与 A#41 的承诺一致 |

### 1.13 `src/serialization.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#43 | `src/serialization.ts:413` | 删一个空行 −1/+0 | 🔁 等价 | 空白改动 |

### 1.14 `src/storage.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#44 | `src/storage.ts:29` | storage 注释里的函数名（listHistoryObjectsByDir） −2/+2 | ✅ 正确 | `src/storage.ts:143` 确实返回「按目录分组的 Map + 页数」，与注释描述一致 |
| A#45 | `src/storage.ts:122` | 删一个空行 −1/+0 | 🔁 等价 | 空白改动 |

### 1.15 `src/types.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#46 | `src/types.ts:95` | stared 字段名的来由注释 −0/+3 | ✅ 正确 | `schema.sql` 有 `Stared` 列、`src/db.ts` 读写 `Stared`、对外 DTO 用 `starred`（`serialization.ts`） |
| A#47 | `src/types.ts:121` | 同句函数名订正（types.ts） −1/+1 | ✅ 正确，但同事实另两处漏改 | 函数名订正本身对；⚠️ `docs/protocol.md:230` 与 `test/fixes.test.ts:827` 仍写不存在的旧名 ⇒ 见缺陷 D3 |

### 1.16 `src/ui/notFound.ts`（7 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#48 | `src/ui/notFound.ts:1` | notFound.ts 头部：两个命名空间 → 三个前缀 −1/+1 | ✅ 正确 | 承载者是 `isUiAsset` 的三前缀（`src/index.ts:237-243`） |
| A#49 | `src/ui/notFound.ts:3` | 「UI 命名空间」→「界面前缀」 −1/+1 | ✅ 正确 | 同上 |
| A#50 | `src/ui/notFound.ts:6` | 共用页的说明与链接目标改准 −3/+3 | ✅ 正确 | 样式取自 `/ui_v2/css/*`（实测 `public/ui_v2/css/tokens-v2.css`、`base-v2.css` 存在）；链接指向默认界面 `/ui_v1/` |
| A#51 | `src/ui/notFound.ts:10` | 样式托管路径改写 −1/+1 | ✅ 正确 | 路径实测存在 |
| A#52 | `src/ui/notFound.ts:28` | 页内三个资源路径 /ui/ → /ui_v2/ −3/+3 | ✅ 正确 | 三个文件实测存在（favicon.svg、css/tokens-v2.css、css/base-v2.css） |
| A#53 | `src/ui/notFound.ts:68` | 正文里的两处地名与代码块 −2/+2 | ✅ 正确 | 页内已无 `href="/ui/` 残留，链接为 `/ui_v1/` 与代码块 `/ui_v2/app/` |
| A#54 | `src/ui/notFound.ts:73` | 「返回剪贴板历史」链接目标 −1/+1 | ✅ 正确 | `href="/ui_v1/"` |

### 1.17 `src/ui/query.ts`（4 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#55 | `src/ui/query.ts:19` | 中文引号换直引号 −1/+1 | 🔁 等价 | 同一句，仅引号形态 |
| A#56 | `src/ui/query.ts:222` | truncateText 的同名不同义说明 −0/+5 | ✅ 正确 | `public/ui_v{1,2}/js/format.js` 各有一份 `truncateText`（字素簇口径）；`docs/archive/AUDIT-v1-v2-divergence.md` §5.3 存在，且该文件 :361 明确写着「服务端 `src/ui/query.ts` 的 `truncateText` … 不要合并这两个函数」⇒ 登记处指的属实 |
| A#57 | `src/ui/query.ts:455` | readBatchMeta 入参统一大写（+ 注释） −1/+4 | 🩹 逻辑正确，注释有缺陷（已修） | `hash.toUpperCase()` 是必要的（库里存大写，小写入参会被 `Hash IN (…)` 的等值比较先滤掉）；但同一 hunk 新增的注释里 `\"` 是**文件里真实存在的两个字符**（按字节核）⇒ 违反「注释即事实」。更重的是：`docs/progress.md` §95.3 第 2 行记着「已改成「大小写不敏感」」，而**没有任何 spec 改过这一行** ⇒ 那是**记录了未落地的修复**（硬约束 7 的形态）。本轮改代码 + 订正记录（见 D1） |
| A#58 | `src/ui/query.ts:468` | 「大小写不敏感」比较的注释补准 −2/+2 | ✅ 正确 | 与 A#57 的实现一致（预取统一大写、再按大写比对） |

### 1.18 `src/ui/routes.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#59 | `src/ui/routes.ts:301` | 未认证访问路径的地名（/ui_v2/不存在） −1/+1 | 🩹 改名残留（已在 B#89 修） | `git show 380b5da:src/ui/routes.ts` 原文是 `/ui/不存在` —— 那次实测发生在 2026-09-19 改名**之前**；改成 `/ui_v2/不存在` 等于用改名后才有的名字叙述从未按该名字发生的事。且该路径今天到不了本文件（入口 `isUiAsset` 分支已处理）。按 §94.4 判据写回旧名 + 注明「当时叫…」 |
| A#60 | `src/ui/routes.ts:552` | 前端两条纪律的注释（文件路径改准） −1/+1 | ✅ 正确 | `public/ui_v1/js/signalr.js:16-17` 确实写着「60 秒内至少发一条」（每 30 秒心跳）；`:19` 写着「断线期间界面继续靠轮询收敛」 |

### 1.19 `src/uiEnabled.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| A#61 | `src/uiEnabled.ts:3` | uiEnabled 头部：界面资源与三前缀 −1/+2 | ✅ 正确 | 关闭态三个前缀一律 404 由 `src/index.ts:249` 与 `:260` 的 `uiDisabledResponse` 落地 |
| A#62 | `src/uiEnabled.ts:9` | 关闭后的行为清单改准 −2/+2 | ✅ 正确 | 根路径不再 302：`src/routes/webdav.ts:37` 的 `&& isUiEnabled(c.env)`；接口面回 JSON、页面回纯文本见 `uiEnabled.ts:28-29` |

---

## 2. B 段 —— 工作区未提交（落笔时 29 处；2026-09-20 复核 **31 处** / 10 文件）

行号 = **审计当时**的工作区行号（`git diff -U0` 输出的新行号）。这一段全部是第三轮 / 第四轮审查（`docs/progress.md` §95 与 §96）留下的改动。
本轮修复（§7）改了 7 个文件的注释与代码。
**⚠️ 2026-09-20 复核订正**：这里的注脚原写「其中只有 `src/serialization.ts` 的**行数**变化（+12），故该文件 `B#79`–`B#81` 三处行号此后需 +12；其余文件行数未变」——
**两半都不成立**：`serialization.ts` 变的是 **+13/−1**（`B#79`–`B#81` 的行号此后需 +13），而 `ui/query.ts` 也变了 **+1/−1**（`B#88` 之后多出 `:473` 那处引号修复，见 §8 的 F-5）。
下面这张表描述的是**修复前**的树；要今天的数请看 §8。
那几处 hunk 的**内容**在修复后也变了（注释被改写），§7 用**锚点文本**而不是行号记述修复，避免再引入漂移。

### 2.1 `src/cleanup.ts`（4 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#63 | `src/cleanup.ts:334` | flush 必须分块的理由注释 −0/+5 | ✅ 正确 | `R2_DELETE_BATCH = 1000`（storage.ts:12）；`deleteHistoryKeys` 在 >1000 时直接抛（:167-169）⇒ 注释描述的「该目录每轮都删不掉」机制成立 |
| B#64 | `src/cleanup.ts:341` | sweepWorkingDirs 的 flush 按 1000 分块 −7/+9 | ✅ 正确 | 预算检查与记账移入块循环；正常数据（每目录 1 个对象）仍只有一块 ⇒ 与改动前逐位相同；失败时 `keys` 不复位 ⇒ 下轮重试（R2 删不存在的 key 是幂等成功） |
| B#65 | `src/cleanup.ts:480` | cleanOrphans 的 flush 注释 −0/+1 | ✅ 正确 | 与 B#63 同理由 |
| B#66 | `src/cleanup.ts:483` | cleanOrphans 的 flush 按 1000 分块 −7/+9 | ✅ 正确 | `processed += pendingDirs.length` 仍只在整组成功后执行 ⇒ 部分失败不会虚报已处理，与「不另立游标、下轮重新求差集」的设计一致 |

### 2.2 `src/db.ts`（3 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#67 | `src/db.ts:312` | listTransferFileCandidates 的预筛改法说明 −0/+9 | 🩹 含 1 处数字错（已修） | 论点成立（D1 的 LIKE 模式上限 50 字节，见 B#80）；但例句「就 60 字节」实测为 **59**（`TextEncoder` 与 `Buffer.byteLength` 两法一致）⇒ 本轮订正，并把「模式 = `%/` + 名字 = 61 > 50」写进注释（见 D2） |
| B#68 | `src/db.ts:322` | 空文件名短路 −0/+2 | ✅ 正确 | 上游 `string.IsNullOrEmpty(fileName)` 直接返回 null；同时避开 `substr(x, 0)` 这个边界 |
| B#69 | `src/db.ts:327` | 预筛 SQL 改用 substr（去掉 LIKE） −1/+1 | ✅ 正确 | `substr(TransferDataFile, -length(?2)) = ?2` 取末尾 N 字符比较，无通配符、无模式长度上限；候选语义仍由调用方 `basename(...) === fileName` 定（`src/routes/webdav.ts:149-153`）⇒ 预筛只宽不漏 |

### 2.3 `src/index.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#70 | `src/index.ts:229` | 裸 /ui/api 也算接口面 −1/+5 | ✅ 正确（有意行为改变） | 裸形态此前落到界面资源分支 ⇒ ASSETS 未命中 ⇒ Hono 的 `app.all('/ui/*')` ⇒ **HTML 404 页**；现在交给 Hono 后由 `app.all('/ui/api/*')` 回 JSON 404。两种写法的形态差异就此消除（关闭态也随之回 JSON，见 B#91） |

### 2.4 `src/profile.ts`（5 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#71 | `src/profile.ts:421` | deleteDataIfNeed 第一处调用点去掉 db 实参 −1/+1 | ✅ 正确 | 函数体只用 storage + entity（`db` 从未被引用） |
| B#72 | `src/profile.ts:455` | tranfer 注释的节号订正（§3 → §5.1/§8.1） −1/+2 | ✅ 正确 | `tranfer` 只出现在 `docs/protocol.md` §5.1 与 §8.1；§3 是 DTO 定义段 |
| B#73 | `src/profile.ts:463` | deleteDataIfNeed 第二处调用点去掉 db 实参 −1/+1 | ✅ 正确 | 同 B#71 |
| B#74 | `src/profile.ts:626` | deleteDataIfNeed 形参删除的理由注释 −1/+3 | ✅ 正确 | 「tsconfig 未开 noUnusedLocals、eslint 不覆盖 src/」是它一直静默留着的原因（`tsconfig.json` 与 `eslint.config.js` 可核） |
| B#75 | `src/profile.ts:629` | 删掉 db 形参 −1/+0 | ✅ 正确 | 定义处只剩 `storage` 与 `entity`；两处调用点已同步（B#71/B#73） |

### 2.5 `src/routes/history.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#76 | `src/routes/history.ts:262` | /data 遇 hash 含分隔符的坏行 → 404 −0/+7 | ✅ 正确 | 守卫放在 `storage.getHistory` 之前，不再撞 `assertHashForPath` 的抛错；404 的语义与 `src/ui/notFound.ts:4` 写下的契约（缺数据必须 404）一致 |

### 2.6 `src/serialization.ts`（5 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#77 | `src/serialization.ts:203` | 四个字段的 JSON 类型判定（readString/readBool）+ 理由注释 −0/+19 | 🩹 与上游仍有 1 处未对齐（已修） | 类型判定本身对（`webdav.ts:112` 的 catch-all 把抛错映射成 400 `Invalid JSON body`）。但注释说的「null 对非空**引用**类型允许」被同时用到了非空**值**类型的 `HasData`（`bool`）上 ⇒ `{"hasData":null}` 上游 400、本实现按缺省处理。本轮对齐（见 D5） |
| B#78 | `src/serialization.ts:246` | 四个字段改用具名判定函数 −4/+4 | 🩹 同 D5（已修） | `hash`/`text`/`dataName` 三处与上游一致（引用类型，null 等价缺省）；`hasData: readBool(...) ?? false` 的 null 宽容与上游 `bool` 非空值类型不符 ⇒ 本轮改判 400 |
| B#79 | `src/serialization.ts:390` | PATCH 日期字段的类型口径收紧 −9/+15 | ✅ 正确 | 与上游一致：`HistoryRecordUpdateDto` 全字段可空（`bool?` / `int?` / `DateTimeOffset?`）⇒ null 就是「未提供」；类型不符与空串在 STJ 里都是反序列化失败 ⇒ 400。F7 的「非法串在解析期抛错」动机保持不变 |
| B#80 | `src/serialization.ts:439` | 搜索串预算改为模式上限推出的 48 −5/+13 | ✅ 正确 | 50 是**模式**字节上限（两个 LIKE 站点各测一次：50 过 / 51 报）；`MAX_SEARCH_BYTES = MAX_LIKE_PATTERN_BYTES − 2 = 48` 可复算；协议侧入口 `routes/history.ts:107` 确实过 `normalizeSearchText` |
| B#81 | `src/serialization.ts:461` | 新增 assertLikePatternFits（转义后校核） −0/+11 | ✅ 正确 | 转义后 ≤ 48 ⇒ 拼出的模式 ≤ 50，正好贴住实测边界；25 个 `%` 转义成 50 字节 ⇒ 越过 ⇒ 400（对应修前的 500） |

### 2.7 `src/ui/maintenance.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#82 | `src/ui/maintenance.ts:16` | import 补 isValidProfileHash −1/+1 | ✅ 正确 | 具名导入，与 B#83 的使用一致 |
| B#83 | `src/ui/maintenance.ts:79` | integrity 遇坏行按「取不到」计并列进清单 −1/+10 | ✅ 正确 | 守卫在 `historyKey()` 之前；`reachable=false` 时不 `continue` ⇒ 计入 `missingCount`，且 `hash: r.hash` 原样露出 ⇒ 与注释逐句对应 |

### 2.8 `src/ui/query.ts`（5 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#84 | `src/ui/query.ts:8` | import 补 assertLikePatternFits −1/+7 | ✅ 正确 | 与 B#85 的使用一致 |
| B#85 | `src/ui/query.ts:151` | 解析期补「转义后」预算校核 −0/+4 | ✅ 正确 | 校核放在**同一个 try 内** ⇒ `InvalidQueryValueError` 被翻成 `UiQueryError`（上层映射 400），不会刺穿成 500 |
| B#86 | `src/ui/query.ts:180` | escapeLike 抽成唯一实现 −0/+6 | ✅ 正确 | 全仓只此一处定义（解析期与拼 SQL 共用）；`/[\\%_]/g` 连反斜杠自身一起转义 ⇒ 「字面反斜杠 + %」不会被解释成「转义符 + 通配符」 |
| B#87 | `src/ui/query.ts:214` | 拼 SQL 处的注释指向共用函数 −2/+2 | ✅ 正确 | 转义函数的调用点只有 :154 与 :217 两处，注释所述与代码一致 |
| B#88 | `src/ui/query.ts:217` | 拼 SQL 处改调 escapeLike，删掉局部 escaped −1/+1 | ✅ 正确 | 消除「两处实现漂移」的可能；参数拼法未变 |

### 2.9 `src/ui/routes.ts`（2 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#89 | `src/ui/routes.ts:301` | 守卫注释写回旧地名 + 注明来由 −2/+6 | ✅ 正确 | 见 A#59；并补上「今天那条路径到不了这里」的判据 |
| B#90 | `src/ui/routes.ts:706` | /ui/* 兜底可达性的说明 −0/+4 | ✅ 正确 | 三条兜底在 `src/ui/routes.ts:710-712`；后两条（页面 404 与 `/ui` 跳转）确实到不了 —— `isUiAsset` 覆盖三前缀的裸形态与 `/*` |

### 2.10 `src/uiEnabled.ts`（1 处）

| # | 位置 | 变更 | 判定 | 判据（可复核） |
|---|---|---|---|---|
| B#91 | `src/uiEnabled.ts:9` | 关闭态清单补「裸 /ui/api」 −1/+2 | ✅ 正确 | 与 B#70 的实现一致（关闭态由 `uiDisabledResponse(true)` 回 JSON） |

---

## 3. 已核实进度

- 本表每次标记的**处数**：91 / 91（**全部核实完毕**）
- 标为 ⬜ 的行**只有编号与位置**，没有判定 —— 不允许把未核实的行当作已核实引用。

---

## 4. 问题与处置

### D1

- **问题**：`src/ui/query.ts` 的 `\"` 转义残留（A#57 引入）+ `docs/progress.md` §95.3 第 2 行**记录了从未落地的修复**
- **处置**：改代码 + 订正记录（本轮）

### D2

- **问题**：`src/db.ts` 例句「就 60 字节」实测 **59**（两法一致）
- **处置**：订正数字，并补「模式 = `%/` + 名字 = 61 > 50」（本轮）

### D3

- **问题**：`docs/protocol.md:230`、`test/fixes.test.ts:827` 仍写**不存在**的 `listHistoryWorkingDirs`（A#16/A#44/A#47 只改了 3 处 src 注释，同一事实的另两处漏改）
- **处置**：按实际方法名改回（本轮）

### D4

- **问题**：`docs/AUDIT-redundancies.md` 的 C-05 两处声称「已登记在 `docs/protocol.md` §10」，而 §10 没有这一条（A#13 的新注释恰好相反）
- **处置**：订正为按节名指向 `SearchText` 口径（本轮）

### D5

- **问题**：`src/serialization.ts` 把「null 等价缺省」用到了**非空值类型**上：`{"type":null}` 与 `{"hasData":null}` 上游是 STJ 反序列化失败 ⇒ **400**，本实现按缺省处理
- **处置**：对齐 400 + 同步唯一钉住旧行为的用例（本轮）

### D6

- **问题**：**改名残留**（A#59）：`/ui_v2/不存在` 是改名**之后**才有的名字，却用来叙述改名前的实测（`git show 380b5da` 原文是 `/ui/不存在`）
- **处置**：前轮已按 §94.4 判据写回旧名 + 注明「当时叫…」（B#89）

---

## 5. 诚实清单（未做 / 不可核）

- **本轮未跑任何测试**：`tsc --noEmit`、`eslint`、`vitest`、浏览器探针都没跑（用户明令）。因此本表**不声称**门禁是绿的；改动后必须由下一次门禁确认。
- 涉及**运行时**的断言（D1 的 LIKE 50 字节边界、25 个 `%` 的 500、`{"hash":123}` 的 5 例 500、`{"hasData":"false"}` 的 400、1200 对象的目录删不掉、《正常数据只有一块 flush》）沿用 `docs/progress.md` §95 记录的真机读数，**本轮未复跑**。
- 未核项：**0**。91 处逐处有判定与判据，没有「看起来没问题」这类占位。
- 措辞类备注（判定为「可接受」、**未改代码**）：A#14 的「溢出」（应为「越过安全整数范围、丢精度」）、A#17 的「字节」（实指 V8 字符串内存）——两处都不影响结论，记在此处以免后人重复讨论。

---

## 6. 覆盖核对（防止漏项）

| 段 | 文件数 | hunk 数 | 与 `git diff --stat` 对得上 |
|---|---|---|---|
| A `6ebcf6e..HEAD` | 19 | 62 | ✓ +177 −111 |
| B 工作区 | 10 | 29 | ✓ +160 −48 |
| 合计 | 20（去重后） | 91 | — |

| 文件 | 本表 | `git diff -U0` |
|---|---|---|
| `src/cleanup.ts` | 15 | 15 ✓ |
| `src/db.ts` | 8 | 8 ✓ |
| `src/durable/SyncClipboardHub.ts` | 2 | 2 ✓ |
| `src/env.ts` | 1 | 1 ✓ |
| `src/hash.ts` | 1 | 1 ✓ |
| `src/index.ts` | 7 | 7 ✓ |
| `src/pathCase.ts` | 2 | 2 ✓ |
| `src/profile.ts` | 8 | 8 ✓ |
| `src/rateLimit.ts` | 4 | 4 ✓ |
| `src/requestLimits.ts` | 1 | 1 ✓ |
| `src/routes/history.ts` | 3 | 3 ✓ |
| `src/routes/webdav.ts` | 4 | 4 ✓ |
| `src/serialization.ts` | 6 | 6 ✓ |
| `src/storage.ts` | 2 | 2 ✓ |
| `src/types.ts` | 2 | 2 ✓ |
| `src/ui/notFound.ts` | 7 | 7 ✓ |
| `src/ui/query.ts` | 9 | 9 ✓ |
| `src/ui/routes.ts` | 4 | 4 ✓ |
| `src/uiEnabled.ts` | 3 | 3 ✓ |
| `src/ui/maintenance.ts` | 2 | 2 ✓ |

---

## 7. 本轮修复（13 处替换 / 7 个文件）

记述用**锚点文本**而不是行号（行号会随改动漂移，锚点不会）。13 处在 `node .audits/_patch.mjs .audits/spec-r25-fixes.mjs` 的**一次读写**里完成，
并由 `_patch.mjs` 逐文件**读回核对**（自带三项自检：落地 / 行尾保持 CRLF / 旧文本已消失）。

> ⚠️ **本台账 §1/§2 的清单是「修复前」的快照**（91 处 = 提交段 62 + 工作区 29）。本轮修复落地后，
> 今天再跑 `git diff -U0 -- src/` 会得到 **10 文件 / 31 处**（比快照多 2 处，**差额是本节这 13 处，不是漏项**）。
> **2026-09-20 复核订正归属**：这里原写「本轮在 `src/db.ts` 与 `src/ui/query.ts` 各改出一处新的 hunk」——数对了、
> 归属**错了**：新增 hunk 的两处是 **`src/serialization.ts`**（`rawType` 的 `== null` → `=== undefined` 拆成独立 hunk）
> 与 **`src/ui/query.ts`**（`:473` 的 `\"` → `「」`）；而 **`src/db.ts` 那处（60 → 59 字节）落在既有 hunk `B#67` 内部**，不新增。
> 逐处对应见 **§8**。

| # | 文件 | 锚点（改前） | 改成 | 属于 |
|---|---|---|---|---|
| 1 | `src/ui/query.ts` | 注释里的 `\"大小写不敏感\"` | 「大小写不敏感」（去掉真实存在的转义反斜杠） | D1 |
| 2 | `src/db.ts` | 「就 60 字节。」 | 「就 59 字节（`%/` + 名字 = 61 > 50）。」（并给出模式算式） | D2 |
| 3 | `docs/protocol.md` | （孤儿目录判定那句）`listHistoryWorkingDirs` | `listHistoryObjectsByDir` | D3 |
| 4 | `test/fixes.test.ts` | `R2Storage.listHistoryWorkingDirs()` | `R2Storage.listHistoryObjectsByDir()` | D3 |
| 5 | `docs/AUDIT-redundancies.md` | C-05 行「两侧都有注释与 §10 登记」 | 「协议面 `SearchText` 口径见 §3 / §5 —— 不是协议差异，§10 没有这一条」 | D4 |
| 6 | `docs/AUDIT-redundancies.md` | C-05 行「两侧注释与 §10 已登记」 | 同上（§10 未登记的理由写在行内） | D4 |
| 7 | `src/serialization.ts` | 「null 对非空引用类型是允许的（等价于缺省）」 | 删掉这半句，另起一段写「null 按字段可空性分两类」 | D5 |
| 8 | `src/serialization.ts` | `readBool` 的 `value === undefined \|\| value === null` | 只对 `undefined` 返回 null（显式 null 落到类型判定 ⇒ 抛错） | D5 |
| 9 | `src/serialization.ts` | `if (rawType == null)` | `if (rawType === undefined)`（键缺失才是缺省） | D5 |
| 10 | `test/dto-validation.test.ts` | hasData 拒绝清单（5 个 JSON 值） | 补 `null`（值类型的 null 也是类型错误） | D5 |
| 11 | `test/dto-validation.test.ts` | 「null 与缺省等价」用例的 body 含 `hasData:null` | body 去掉 hasData、标题限定为「只限引用类型字段」，并补 `{"type":null}` 抛错 | D5 |
| 12 | `test/dto-validation.test.ts` | HTTP 400 用例的 bodies 列表 | 补 `hasData:null` 与 `type:null` 两例（钉住 HTTP 层的 400） | D5 |
| 13 | `src/serialization.ts` | 注释「这里补齐其余四个字段。」 | 其后补「null 的处置按字段可空性分两类」整段（含上游两份 DTO 的对照） | D5 |

### 7.1 行数偏移（供引用时换算）

| 文件 | 本轮行数变化 | 影响本台账的哪些行 |
|---|---|---|
| `src/serialization.ts` | **+13 / −1**（**2026-09-20 订正**：原写 +12） | `B#79`、`B#80`、`B#81` 的行号各 **+13**（插入点在它们之前：`B#77` 扩写 +10、`rawType` 那处 +3） |
| `src/ui/query.ts` | **+1 / −1**（**2026-09-20 订正**：原来归在"其余 5 个文件 = 0"里） | 不影响行号（改动在文件末尾 `:473`，且净 0 行） |
| `test/dto-validation.test.ts` | +6 | 不影响（该文件不在 `src/` 段） |
| 其余 4 个文件（db.ts / protocol.md / fixes.test.ts / AUDIT-redundancies.md） | 0 | 无 |

---

## 8. 独立复核（2026-09-20，`docs/progress.md` §101）

> **来源**：用户第四次下同一句指令（"把 `6ebcf6e` 到最新的每一处 diff 列出来在文档中，逐个核实……**禁止跑测试**。
> **禁止脚本**"），对象是 `src/`。本台账（§96）已经存在 ⇒ 这一轮的正确形态是**把它自己再验一遍**
> （与 §98 对 `public/` 台账做的一样），依据仍是本仓那句：「**审计员的话本身也是一个需要被验证的断言**」。

### 8.1 范围重算（三数对账）

| 口径 | 命令 | 台账声称 | 复核读数 |
|---|---|---|---|
| 提交段 hunk | `git diff -U0 -M 6ebcf6e..HEAD -- src/` 数 `@@` | 62 处 / 19 文件 | **62 / 19** ✅ 逐位吻合 |
| 提交段行数 | `git diff --shortstat 6ebcf6e..HEAD -- src/` | +177 / −111 | **+177 / −111** ✅ |
| 工作区段 hunk | `git diff -U0 -- src/` 数 `@@` | 落笔时 29 处 / 10 文件 | **复核时 31 / 10**；**本轮收尾后 32 / 10**（见 8.3 的第三处） |
| 工作区段行数 | `git diff --shortstat -- src/` | 落笔时 +160 / −48 | **复核时 +174 / −50**；**本轮收尾后 +176 / −51** |
| A 段逐文件相加 | 台账 §1.1–§1.19 声称的处数 | 11+5+2+1+1+6+2+3+4+1+2+4+1+2+2+7+4+2+2 | = **62** ✅ |
| B 段逐文件相加 | 台账 §2.1–§2.10 声称的处数 | 4+3+1+5+1+5+2+5+2+1 | = **29** ✅（与它自己的表自洽；今天的真值是 32，三项差额见 8.3） |

> ⚠️ 两个口径不能混：**默认 `-U3` 数出来是 48 处**（相邻改动被合并），本台账的「处」一律是 **`-U0`** 口径。
> 复核时若不声明这一点，会得到"48 vs 91"这种假缺口 —— 与 §95.8 末那条教训同族：**数字必须连口径一起写**。

### 8.2 载荷最大的判定：逐条回代码复算

| 台账行 | 它的判定 | 复算法 | 结果 |
|---|---|---|---|
| `A#11`（删掉 `subrequests` 的一次赋值） | 🔁 等价，"留下的那次含收尾成本" | 读 `src/cleanup.ts:651-666`：收尾落库（`budget.spend` + `setMetaValues`）**之后**才是 `result.subrequests = run.budget.spent` | ✅ 成立（被删的是收尾**之前**那次 ⇒ 现在报的数更准） |
| `A#16`/`A#44`/`A#47`（旧方法名） | ✅ 三处已改 | 全仓搜 `listHistoryWorkingDirs` | ✅ **`src/` 与 `test/` 零命中**（余下命中全在 `progress.md` 历史段与台账自身的引用里） |
| `A#?`｜`src/storage.ts:29` 的工作目录名注释 | ✅ "与 `listHistoryObjectsByDir()` 分组后的目录键同形式" | 读 `src/storage.ts:143-161`：`dir = rest.slice(0, slash + 1)` ⇒ 键正是 `{Type}_{hash}/` | ✅ 成立 |
| `A#?`｜`src/durable/SyncClipboardHub.ts:52` | ✅ "`MAX_QUEUED_BYTES` 判的是 **UTF-16 码元数**" | 读 `:70` 的字段注释 + `:425` 的 `lp.queuedBytes += message.length` | ✅ 成立（现有注释与新增注释口径一致） |
| `A#?`｜`src/ui/routes.ts:552` | ✅ "两条纪律写在 V1 的 `signalr.js` 里" | 读 `public/ui_v1/js/signalr.js:16-19`（60 秒静默即断 / 每 30 秒心跳 / 断线靠轮询收敛） | ✅ ①② 都成立 |
| `B#70` + `B#91`（裸 `/ui/api`） | ✅ "有意行为改变" | 读 `src/index.ts:228-261`：`isUiApi` 含裸形态、只有 `isUiAsset && !isUiApi` 才被拦 ⇒ 裸形态进出 Hono | ✅ 逻辑成立；"Hono 侧确实匹配裸形态"是**实测**声明 ⇒ 进 §8.5 |
| `B#83`（integrity 遇坏行） | ✅ 不 `continue` ⇒ 计入 missing，hash 原样露出 | 读 `src/ui/maintenance.ts:85-98` | ✅ 成立 |
| `B#67`（60 → 59 字节） | 🩹 已订正 | 读现文：`就 59 字节（`%/` + 名字 = 61 > 50）` | ✅ 订正落地 |
| 穷举①（ASI 那类） | — | 全仓 `strict: false` 共 **6 处**：3 处（`index.ts:59`、`routes/history.ts:225`、`routes/webdav.ts:24`）曾有行尾注释吞分号（本轮已挪到上方），另 3 处（`ui/maintenance.ts:59`、`ui/routes.ts:239`/`:299`）**本来就没有行尾注释** | ✅ 证明上一轮的修复**完整** |
| 穷举②（"副作用藏在 filter 里"那类） | — | 搜 `\.filter\(\(.*\) => .*(delete\|push\|set\|add)\\(` | ✅ 全仓**只剩那条注释本身** ⇒ 同类形状已清零 |

### 8.3 三处新增 hunk 的逐处对照（32 − 29 = 3）

| # | 新 hunk | 是什么 | 判定 |
|---|---|---|---|
| 1 | `src/serialization.ts` `@@ -219 +248,3 @@` | `if (rawType == null)` → `=== undefined`（键缺失才是缺省；显式 `null` 落到类型判定 ⇒ 400） —— 这是 **D5 的修复本身**拆出来的独立 hunk | ✅ 正确（与 §7 第 9 行同一处；契约与上游 `ProfileType` 非空值类型一致） |
| 2 | `src/ui/query.ts` `@@ -457 +473 @@` | 注释里 `\"大小写不敏感\"` → `「大小写不敏感」`（去掉真实存在的转义反斜杠） —— **D1 的修复** | ✅ 正确（§7 第 1 行） |
| 3 | `src/db.ts` `@@ -296 +296,2 @@` | **本轮（§101）自己那处措辞订正**：防御性钳制的注释「`(2^53-1 - 1) * 50` 本身就会**溢出**」→「越过安全整数范围 —— JS 在那里是**丢精度**」。它落在 **A 段**（已提交）那一行上 ⇒ 对 HEAD 而言是一处新改动、新 hunk | ✅ 正确（无行为变更；判据见 8.5） |

> ⚠️ 第 3 处的存在正是 8.5 教训 2 的实例：**我一边写"工作区段的数会腐烂"，一边自己把它又改了一次。**
> 所以上面 8.1 那一栏给的是**三个读数**（落笔时 / 复核时 / 收尾后），不是一个假装的定值。

**同一批修复里"变大但没新增 hunk"的两处**（供换算行号）：`serialization.ts` 的 `B#77` **+19 → +29**（D5 的注释段扩写）、`B#78` 内容变但仍是 −4/+4。

### 8.4 台账自身的订正（4 处，全部已就地改）

| # | 位置 | 原文 | 真值 |
|---|---|---|---|
| **G-1** | §0 的规模行 + §2 段头 | 工作区段「29 处（+160 −48）」 | **31 处（+174 −50）**（差额 = §7 那批修复） |
| **G-2** | §2 段头的注脚 | 「**只有** `src/serialization.ts` 的行数变化（**+12**），其余文件行数未变」 | **两半都不成立**：`serialization.ts` 是 **+13/−1**、`ui/query.ts` 也变了 **+1/−1**。这一句是给读者换算行号用的 ⇒ 错了要改 |
| **G-3** | §7.1 的表 | `serialization.ts` **+12**；「其余 5 个文件 = 0」 | **+13 / −1**；`ui/query.ts` **+1 / −1**（其余 4 个才是 0） |
| **G-4** | §7 的 ⚠️ 注 | 「本轮在 **`src/db.ts`** 与 `src/ui/query.ts` 各改出一处新的 hunk」 | 数对了（31）、**归属错了**：新增 hunk 的是 **`serialization.ts`**（`rawType`）与 `ui/query.ts`；`db.ts` 那处（60→59 字节）落在既有 hunk `B#67` **内部**，不新增 |

> G-1…G-4 是**同一类**：台账的**结论**（表里的逐处判定）几乎全对，而**它对自己"修复后状态"的描述**对不上 ——
> 修复改的是"另一批文件"，而描述停留在修复前的账。⇒ 与 §96.5 第 1 条（"自述已改要数一遍实际处数"）同族。

### 8.5 这一轮**改了**什么、以及边界

- **代码/注释改 1 处**（唯一一处，`src/`）：`src/db.ts` 的防御性钳制注释把「`(2^53-1 - 1) * 50` 本身就会**溢出**」
  订正为「越过安全整数范围 —— JS 在那里是**丢精度**（不报错、也不变成 Infinity）」。
  判据：`Number.MAX_SAFE_INTEGER = 9007199254740991`，而 `(2**53 − 2) × 50` 远大于它 ⇒ 结果是**舍入后**的数，
  不是 `Infinity`、更不抛错；原措辞会让读者以为"它会炸，所以不用管"。§96 曾把它记为"措辞项、未改" ⇒ 本轮收口。
- **台账改 6 处**（G-1…G-4 + §7 的归属 + §7.1 的表）。
- **边界（不许读成"已通过"）**：
  1. **门禁一条都没跑**（用户第四次明令禁测试）：`tsc` / `eslint` / 22 套件 / 四个探针。
     故 `B#70` 里那句「Hono 的守卫中间件与 `app.all('/ui/api/*')` **都**匹配裸形态（**实测**）」，
     本轮**只能核到它的代码路径自洽**，核不到那次实测本身。
  2. **`.audits/` 的分析脚本一个都没跑**（禁脚本）；范围与计数用的是 `git` + 计数工具，不是分析脚本。
  3. **A 段 62 处是重读 + 抽核**（8.2 的 10 条 + 8.1 的对账），**不是**逐字节重算每一条 ——
     上一轮宣称的"机械逐字一致（`MISMATCH = 0`）"依赖 `.audits/` 里那几个脚本，本轮没有重跑，
     故**沿用但未复验**（这条边界必须写明）。
  4. 逐处判定沿用台账 §1/§2 的表（本轮抽核的 10 条全部成立，未发现需要推翻的判定）。

