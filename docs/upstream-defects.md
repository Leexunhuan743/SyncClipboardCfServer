# 上游缺陷与怪癖的复刻清单 · 逐条处置（21 条候选：A 必须复刻 10 / B 有意偏离 5 / C 结构性消除 2 / D 待办 2 / 不改但需知 2）

> **本轮性质**：以 `28c7e596`（= 本仓 `docs/upstream-parity.md` 的对照基线，也就是上游仓库当前的 HEAD）为基准，
> 把「本实现复刻了上游哪些缺陷/怪癖」从散落的注释里收敛成一张可核对的表，并为每一条给出**处置决定**。
>
> **方法**：上游代码取自本地仓库 `C:/Users/leeexx/Documents/NewProject/SyncClipboard`（`git rev-parse HEAD` = `28c7e5963b8329e40586175eeeda326597c3e732`，工作区干净）。
> 每条都给 `文件:行` 与逐字代码。**本轮未运行上游服务端**——「影响」是按代码语义的推断，凡未实测处均标注；
> 已由 `tools/ab-upstream-probe.ps1` 实测过的项标 **[A/B 实测]**（依据 `docs/progress.md` §44）。
>
> **与 `upstream-issues.md` 的分工**：那份文件是**给上游提 issue 的稿子**（**15** 条，只收录上游自身的问题）；
> 本文件回答另一个问题——**上游的问题在本实现里怎么处置的**。两份文件的编号空间互相独立。
>
> **2026-09-18 重排**：本表初版按「16 条已复刻 + 5 条未复刻」两分（总数 21 不变），现按**处置**重分为
> A/B/C/D/不改但需知 五类（§1 表）——旧的「已复刻」把"必须复刻的契约"与"已加固的缺陷"混在一栏，
> 读过之后分不清哪条**不许顺手改好**。条目本身未增删；§6 的变更记录保持 2026-09-15 的原样（历史快照）。
>
> **数据来源**：本轮的「已复刻」条目来自对 `src/**` 全量检索 + 逐条回上游核对；不是从注释里抄的
> （抄注释会漏掉「注释放大了」与「注释漏说了」两类：本轮实测到 **1 处注释不完整、3 处注释缺失**，见 §5）。

---

## 1. 结论摘要

上游的行为里有三类东西，必须分开对待——混在一起谈会得出错误结论：

| 类别 | 定义 | 本实现的态度 |
|---|---|---|
| **契约** | 客户端依赖它做判定：状态码、媒体类型、DTO 形状、哈希、`ShouldUpdate` | **必须逐字复刻**，哪怕它看着别扭（ADR D9） |
| **缺陷** | 上游自己也认为是 bug，或会导致数据/内存/可用性受损，且**不在 wire 上也无人依赖** | **可合理处置**：加固 / 修好 / 文档登记为有意偏离 |
| **怪癖** | 上游没明说的实现细节，第三方客户端理论上可能撞上 | 按「是否已在 wire 上可观测」决定复刻还是收敛 |

本轮 21 条候选的处置分布：

| 处置 | 条数 | 含义 |
|---|---|---|
| **A · 必须复刻** | 10 | wire 上可观测且客户端可能依赖；复刻是正确选择，**不要**"顺手改好" |
| **B · 有意加固/偏离（已登记）** | 5 | 已偏离且已写进 `protocol.md` §10；**维持**，本轮只补强理由 |
| **C · 已消除（不需要偏离）** | 2 | 上游问题在本架构下**结构性地不存在**（无缓存、有唯一索引） |
| **D · 待办** | 2 | 本轮新发现的**文档缺口**（D1 / D2：行为都已对，缺的只是说明），两处均已在同轮补齐 |
| **不改但需知** | 2 | 无行为后果，仅记录（K1 = 有意不做，K2 = 待观察；见 §2.5） |

**一句话**：本实现的复刻**没有一处是"抄错了"**——每一处都能指回上游的具体行，且都能说清"为什么必须这样"。
本轮真正需要动作的是 **3 处文档补强 + 1 条新 issue 候选**，没有需要改的代码。

---

## 2. 逐条清单

`上游位置` 一律给 `文件:行`；「复刻?」列指本实现是否保留上游行为。

### 2.1 契约类 —— 必须复刻（A 类，10 条）

| # | 项 | 上游位置与行为 | 本实现 | 复刻? |
|---|---|---|---|---|
| Q1 | **路由整体大小写不敏感** | `SyncClipboardController.cs:47/53/59/67/77/85/105/122/156/179` 与 `HistoryController.cs:25/49/81/120/266/294/303` 的 `[HttpGet]`/`[HttpPost]`/`[AcceptVerbs]`：ASP.NET Core 对**字面段** `OrdinalIgnoreCase` 匹配，`/API/version` 命中 | `src/pathCase.ts`：只归一"上游确实有字面路由"的位置，取值段（`{fileName}`/`{profileId}`）**原样保留大小写** | ✅ [A/B 实测] |
| Q2 | **字符串枚举名大小写敏感** | `Profile.cs:99` `Enum.TryParse(parts[0], out type)`（`ignoreCase` 默认 **false**）；`HistoryController.cs:211` 显式传 `true` ⇒ **上游自身不一致** | `parseProfileId` 用 `parseProfileType`（大小写不敏感）⇒ 两处都宽松 | ✅ 宽松超集（`protocol.md` §10 已登记） |
| Q3 | **`Enum.TryParse` 接受数字** | 同上位置：`"0-HASH"` 解析为 `Text`；越界数字（如 `"6"`）也"解析成功"⇒ 查不到 → 404 | `src/serialization.ts:79-84` 接受任意 int32，越界由查询自然落空 | ✅ 已登记 |
| Q4 | **`ProfileTypeFilter` 高位不可达** | `HistoryService.cs:138-141` 用 `Enum.GetValues(typeof(ProfileType))` 遍历**已定义值**；`ProfileTypeFilter` 只定义到 `All=15` ⇒ 16/32 永不被测试 | `src/db.ts:236-249` 同一算法（遍历 `ProfileType` 的值，不遍历 filter 的位） | ✅ |
| Q5 | **`ShouldUpdate` 的 5 分钟阈值语义** | `HistoryHelper.cs:5-28`：`gap <= 5min → newVersion >= oldVersion`，否则 `newUtc >= oldUtc`（注意**比的是时间而非版本**） | `src/db.ts:102-113` 逐字同构 | ✅ |
| Q6 | **Text `Size` 是 UTF-16 字符数** | `TextProfile.cs:23` `Size = text.Length`（C# `string.Length` = UTF-16 码元）、`:150/159/164` 同 | `src/profile.ts:141` `new TextDecoder().decode(content).length` + 注释明说"不是 UTF-8 字节数（F11）" | ✅ |
| Q7 | **Group `Size` 是条目长度之和** | `GroupProfile` 的 `totalSize`（非 zip 体积） | `src/hash.ts:203` `totalSize = Σ content.length`（非 `zipBytes.length`） | ✅ |
| Q8 | **File 哈希的 `Name` 是名字而非路径** | `FileProfile.cs:96-103` `GetSHA256HashFromFile` 只取 `Path.GetFileName(filePath)` ⇒ 同内容不同目录得**同 hash** | `src/hash.ts:28-31` `fileProfileHash(fileName, content)`，调用方传 `basename` | ✅ |
| Q9 | **`GET /file/{name}` 缺失时回退到更旧的同名记录** | `HistoryService.cs:221-227`：按 `LastAccessed` 倒序**逐条** `File.Exists`，缺失继续回退 | `src/routes/webdav.ts:148-153` 遍历 `listTransferFileCandidates()` 返回首个真实存在的对象 | ✅（成本见 Issue 11） |
| Q10 | **空 `hasData` 的 File/Image/Group 必须被拒** | `FileProfile.cs:230-233` `Persist()` 抛 `Cannot persist a FileProfile with no data.`；`GroupProfile` 同型 ⇒ 上游 **500** | `src/profile.ts:285-289` 明确 **400** `Transfer data is required for X profile` | ✅ 偏离（更准）已登记 |

**为什么 Q1–Q10 不能"改好"**：Q1–Q3 是**兼容性超集**（收紧会让第三方客户端从命中变成 404/400）；
Q5 是**跨设备收敛算法**（改了会让历史在两个实现之间反复互相覆盖）；
Q6–Q9 直接决定 **hash 与 size 的取值**——改了会让同一条剪贴板在两个服务端算出不同 hash，等于**整个历史库分裂**；
Q10 是**拒绝语义**（上游 500 vs 本实现 400，客户端对两者同为"失败重试"，但 4xx 比 5xx 更可诊断）。

### 2.2 缺陷类 —— 已偏离并登记（B 类，5 条）

| # | 项 | 上游缺陷（`文件:行` + 逐字） | 本实现处置 | 登记处 |
|---|---|---|---|---|
| Q11 | **Basic 凭据缺冒号 → 500** | `BasicAuthenticationHandler.cs:24-25`：`Split(':')` 后直接 `credentials[1]` ⇒ 无冒号时 `IndexOutOfRangeException`，无 try/catch ⇒ 未处理异常 **500** | 401（`src/auth.ts:52-54` 用 `indexOf(':')`，`<0` 返回 null） | `protocol.md` §10「Basic 凭据缺冒号」 |
| Q12 | **Basic 密码含冒号 → 认证失败** | 同上：`Split(':')` 取 `[1]` ⇒ `a:b:c` 的密码被截成 `b` ⇒ 401（**无法使用含冒号的密码**） | 取首个冒号后**全部**（`src/auth.ts:54` `decoded.slice(sep + 1)`）⇒ 更宽容 | `protocol.md` §10「Basic 密码含冒号」 |
| Q13 | **`GET /file/{name}` 内部异常报成 400** | `SyncClipboardController.cs:99-102`：`catch (Exception ex) when (ex is not OperationCanceledException) { return BadRequest(ex.Message); }` ⇒ 磁盘故障/权限问题也报 **400**（还回显异常消息） | **500**（异常上抛给运行时），理由：把内部故障报成 400 会误导排障 | `protocol.md` §10「`GET /file/{name}` 内部异常」 |
| Q14 | **hash 含路径分隔符 → 500 / 平台相关** | `Profile.cs:162-170` `GetWorkingDirName` 抛 `ArgumentException`（未捕获 ⇒ 500）。且判据用 `Path.DirectorySeparatorChar`/`AltDirectorySeparatorChar` ⇒ **平台相关**：Windows 拒 `\` 与 `/`，Linux 两者都是 `/` ⇒ **只拒 `/`，放行 `\`** | 写路径入口一律 **400**（`src/types.ts:118-120`），两平台一致；存储值分类视同损坏降级 | `protocol.md` §10「hash 含路径分隔符」+「平台差异」 |
| Q15 | **C# 模型的宽松解析（`TryParse` 系列）** | `HistoryController.cs:229-236`：`ParseBool`/`ParseInt`/`ParseLong` **语法不合法即静默取默认值 0/false**（不报错）；`ParseDateTimeOffset:218-227` 失败回退 `UtcNow` | 协议面**逐字复刻**这四处（`src/routes/history.ts:125-141` 用 `parseCSharpInt32` 而非 `parseInt`，因为 `'3abc'`/`'3.9'`/`'0x10'` 在 `parseInt` 下会"成功"）；**但** query 的 `Types`/`Starred` 按 `[ApiController]` 绑定失败返 400 | `protocol.md` §10 + `design.md` §9.1 |

**Q13 的收益记录**：这条偏离此前只有结论没有算术依据，本轮补上——上游把 `File.Exists` 之外的
任何异常（含 `DirectoryNotFoundException`、`UnauthorizedAccessException`）都映射成 400 并**回显 `ex.Message`**；
在公开部署上这既误导排障，又是一条无认证才可达的信息泄露面（内容为路径）。故本实现保留 500。

### 2.3 结构性消除（C 类，2 条）—— 本实现**不需要**偏离，因为上游问题不存在

| # | 上游问题 | 为什么本实现天然没有 |
|---|---|---|
| Q16 | **当前 Profile 缓存永不失效**（`upstream-issues.md` Issue 8）：① `SyncClipboardController.cs:118` 的 `_cache.Remove("SyncClipboard.json")` 用的是**字面量**，而读写用的是 `cacheKey = profilePath`（绝对路径，`:126/136/148/152/226`）⇒ 失效语句**永远删不到东西**；② `_cache.Set` 无任何过期策略 ⇒ 进程外改动（共享卷/手工修复/备份恢复）后一直返回旧值 | 本实现**没有这一层缓存**：当前 Profile 存 D1 的 `Meta.current_profile`（`schema.sql:51-54`），`src/routes/webdav.ts:69-102` 每次直读。`protocol.md` §10「缓存」行已写"无缓存（D1/R2 直读）⇒ 等价（更强一致）"——本轮**补上了"上游的具体缺陷形态"**，此前只说了策略差异 |
| Q17 | **无 `(UserId,Type,Hash)` 唯一约束**（上游 `Migrations/20251105014242_Init.cs:40-43` 只有 `PK_HistoryRecords`；`HistoryDbContext.cs:38-55` 的三个索引都不含 `Hash`）⇒ `AddProfile` 的"查无 → 插入"在**多副本共享同一 `history.db`** 时无 DB 层保护，可产生重复行 | 本实现建了**唯一索引** `ux_h_user_type_hash`（`schema.sql:35`），并把"并发抢先插入"变成**确定的合并路径**：`insert()` 识别唯一约束冲突 → 走 `mergeExistingProfile`（`src/db.ts:151-182`、`src/profile.ts:336-338`）。这条已登记在 `protocol.md` §10「并发」行 |

> Q17 与本仓第一次提交历史里的 `修复：数据库并发问题`（上游 `e79a18d6`）是同一主题——上游自己也意识到了该问题，
> 但那次提交（在基线**之前**）只在客户端侧做了处理，服务端**仍没有**唯一索引。故本条对上游仍是有效 issue 素材。

### 2.4 待办（D 类，2 条）—— 本轮新发现的文档缺口

#### D1 · 文档缺口：`Hash` 匹配用 LIKE ⇒ `%`/`_` 是通配符（**行为已对，注释不完整**）

- **上游**：`HistoryService.cs:254-255`
  ```csharp
  return _dbContext.HistoryRecords.FirstOrDefaultAsync(
      r => r.UserId == userId && EF.Functions.Like(r.Hash, hash) && r.Type == type, token);
  ```
  `EF.Functions.Like(pattern, ...)` 把**第二个参数当模式**：`%` 匹配任意串、`_` 匹配任意单字符。
- **本实现**：`src/db.ts:130-138` 用 `LOWER(Hash) = LOWER(?3)`（严格等值，可走索引）。
- **缺口**：`src/db.ts:129` 的注释只写了「大小写不敏感，等价 EF.Functions.Like」——**漏了通配符这一半**。
  行为**正确**（`protocol.md` §10 有完整的 A/B 实测记录：`GET /api/history/Text-<前 8 位>%` → 上游 200 命中、本实现 404），
  但只读代码的人会据此以为两者等价。
- **处置**：已在本轮补齐 `src/db.ts` 的注释（见 §6 变更记录），指向 `protocol.md` §10 的实测行。

#### D2 · 文档缺口：并发更新的"丢更新"（**偏离已在但理由只在代码注释里**）

- **上游**：`HistoryService.Update`（`HistoryService.cs:33-83`）是「查 → 判定 → 改字段 → `SaveChangesAsync`」，
  进程内用 `_processSem`（`:19`，**static** ⇒ 仅同进程有效）串行化。多副本共享同一个 `history.db` 时，
  两个并发 PATCH 可各自通过 `shouldUpdate` 再各自 `SaveChanges` ⇒ **后者静默覆盖前者**。
- **本实现**：`updateEntityIfVersion`（`src/db.ts:199-210`）`UPDATE ... WHERE ID=?15 AND Version=?16` +
  受影响行数判定 ⇒ 冲突时返回 409（`src/db.ts:398-403`）。理由此前只写在 `src/db.ts:197-198` 的注释里。
- **处置**：已在本轮把该理由补进 `protocol.md` §10「并发」行（原文只写"UNIQUE 索引 + 唯一冲突合并 + 乐观锁"，
  没说乐观锁**防的是上游哪一类故障**）。

### 2.5 不改但需知（2 条）—— 无行为后果，仅记录

> ⚠️ 本节两条**不计入 D 类**：`§1` 的处置分布表里它们是「不改但需知 2」，与 D 类的 D1/D2 分开数。
> 2026-09-19 按审计 **F-4** 从 §2.4 移来 —— 原先把四条一起排在「待办（D 类）」标题下，于是摘要表的
> 「D 类 2 条」与下面的 D1–D4 四条当场对不上（**算术本身没错**：10+5+2+2+2 = 21，摘要表也没错）。
> 条目编号由 `D3`/`D4` 改为 `K1`/`K2`（K = 需知），避免与 D 类混淆；全仓只有 §4 一处引用需同改。

#### K1（原 D3）· 有意**不做**：`GET /file/{name}` 的 `%2e%2e` 路径形态（**记录理由，不改**）

- **上游**：`SyncClipboardController.cs:22-25` 的 `InvalidFileName`（拒 `\` 与 `/`）在
  **`GetFileFromFolder`（`:87-103`）里没有调用**，只在 `PutFileToFolder`（`:108`）与
  `GetFileFromFolder` 的 `DeleteFileFolder` 兄弟路径上有。理论上编码后的 `%2e%2e` 解码成 `..` 后
  是否绕过 `File.Exists` 守卫，取决于 ASP.NET 的路径归一化行为——**本轮未实测，故不作为上游 issue 主张**。
- **本实现**：`src/routes/webdav.ts:143-145/161-163/184-186` 三条 `/file/:fileName` 路由**一律**先过
  `invalidFileName()` ⇒ 400。
- **处置**：**不改，也不提上游 issue**。理由：① 本实现已防御（无需动作）；② 上游侧的可达性未实测，
  按本仓纪律（ADR D10：「凡未实测的推断不得作为结论」）不进 issue 稿，只在 §4 登记为"被驳回/待实测的候选"。

#### K2（原 D4）· 待观察：`TextProfile` 的 10 KiB 截断阈值是**硬编码**

- **上游**：`TextProfile.cs:9` `private const int TRANSFER_DATA_THRESHOLD = 10240;`，`:24-29` 超阈值时
  `_fullText` 留存全文、`_text` 只留前 10240 字符（wire 上的 `text` 因此被截断）。
- **本实现**：`src/profile.ts` 复刻同一语义（大文本以 `file/` 暂存 → `history/` 持久）。
- **处置**：**不改**。它不是缺陷而是设计（避免大文本进 SQLite/wire）；记录在此仅供后人核对
  ——若上游改动该常量，wire 上的 `text` 截断长度会变，本实现需跟版。**纳入跟版观察项**。

---

## 3. 为什么"不合理地改好"会有害 —— 三条硬约束

复刻缺陷不是惰性，以下三条是**可证伪**的约束（都能在代码里指出来）：

1. **hash 一致 = 数据一致**。Q6/Q7/Q8 决定 hash 与 size。若本实现"顺手修正"（例如把 Text 的 `Size`
   改成 UTF-8 字节数），同一条剪贴板在两个服务端算出的 hash 就不同 ⇒ 客户端在切换服务端时
   **整库重新上传一遍**，且两端历史无法对齐。这正是 `docs/protocol.md` §8 把哈希列为"须精确复刻"的原因。
2. **状态码是客户端的控制流**。Q10（400 vs 500）、Q11（401 vs 500）都在 `OfficialAdapter.cs`
   的分支表上：`:395` 对 `BadRequest or UnprocessableEntity` 抛"数据被拒"（**不重试**），
   其余走 `RemoteServerException`（**会重试**）。把 500 改成 400 会**改变客户端的重试行为**——
   这是比"状态码更好看"重要得多的后果。
3. **收紧即破坏超集**。Q1–Q3 是本实现**比上游更宽松**的地方。宽松不会让官方客户端出错，
   而收紧会让"上游能用、本项目不能用"的第三方调用出现——那是**功能回归**，不是清理。

---

## 4. 复核记录：**不**建议提 issue 的候选（避免误提）

| 候选 | 为什么不成立 |
|---|---|
| 「`SyncClipboardController.cs:99-102` 把内部异常报成 400」 | 已作为 **Q13 登记为有意偏离**，但**不单列为上游 issue**：它是"错误语义不够精确"，不是安全或数据缺陷；且与 `upstream-issues.md` 的收录口径（安全/数据/可用性）不符 |
| 「`GetFileFromFolder` 未调用 `InvalidFileName`」 | 同上（K1）：可达性未实测，按 ADR D10 不作为结论 |
| 「`HistoryService.cs:19` 的 `_processSem` 是 `static`，因此在 IOC 单例之外的 scope 间也共享」 | **驳回**。`static` 在这里是**有意为之**且无害——`HistoryService` 注册为 `AddScoped`（`Web.cs:41`），
静态信号量让多个 scope 共享同一把锁，正是"串行化"想要的语义；问题不在 static，而在**多进程/多副本**时锁失效（已并入 D2） |
| 「`TextProfile.cs:9` 的 10240 是魔法数字」 | **驳回**。有名字、有单一出处、注释可推导；且它是 wire 行为的一部分，不是坏味道 |
| 「`GroupProfile` 的 `a` 与 `a/` 同名冲突不报错」 | **驳回**。官方客户端恒写显式目录条目且无重复，该路径不可达；已在 `README.md`「已知限制」与 `protocol.md` §10 登记 |

---

## 5. 本轮发现的注释/文档缺口（已修或待修）

| 位置 | 缺口 | 处置 |
|---|---|---|
| `src/db.ts:129` | 注释说"等价 `EF.Functions.Like`"，但该等价**只对大小写成立**；`%`/`_` 通配符那一半没写 | ✅ 本轮补齐 |
| `protocol.md` §10「缓存」行 | 只写了"无缓存 ⇒ 更强一致"，未说明**上游的具体缺陷形态**（失效 key 与读写 key 不一致） | ✅ 本轮补 |
| `protocol.md` §10「并发」行 | 只写"乐观锁"，未说明它防的是上游的**多副本丢更新** | ✅ 本轮补 |
| `upstream-issues.md` 头部 | 标题写「7 条」但已有 13 条（`README.md:418` 与 `:482` 亦不一致） | ✅ 本轮修正 |
| `README.md:464/466` | `tools/` 一行重复列出 | ✅ 本轮修正 |

---

## 6. 变更记录（本轮，2026-09-15）

只读对照 + 文档补强，**未改动任何源码逻辑**：

| 文件 | 变更 |
|---|---|
| `docs/upstream-defects.md` | **新建**：本文件（16 条已复刻 + 5 条未复刻的逐条处置表） |
| `docs/upstream-issues.md` | 头部标题与统计修正（7 条 → 13 条）；新增「Issue 14」并指向本文件 §2.4 的 D1/D2 |
| `docs/protocol.md` §10 | 「缓存」行补上游缺陷形态；「并发」行补乐观锁针对的故障类型 |
| `src/db.ts` | 仅补注释（`Hash` 匹配与 `LIKE` 的等价边界），无逻辑改动 |
| `README.md` | 修正 `tools/` 重复行、上游 issue 条数 |

**边界声明**：本轮**未运行**上游服务端，也**未运行**本仓测试套件（纯文档 + 注释变更）。
所有"上游行为"结论均以 `28c7e596` 的源码为据；凡属推断已逐条标注，凡属已实测已标 **[A/B 实测]**。
