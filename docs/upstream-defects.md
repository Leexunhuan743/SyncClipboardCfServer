# 上游缺陷 / 怪癖在本实现里的处置（21 条：A 必须复刻 10 / B 有意偏离 5 / C 结构性消除 2 / D 待办 2 / K 需知 2）

> **精简介**：本节起为 2026-10-04 的整篇重写（原文 204 行）；历史版本见
> `git show <hash>:docs/upstream-defects.md`：重写前最近一版 `f6cced5`，初版 `28c7e596` 基线那轮。
> 重写只改表述，处置结论与落地位置逐条照当前代码复核。
>
> **本文件回答什么**：上游有缺陷/怪癖 ⇒ **本实现怎么处置**。姊妹篇
> [`upstream-issues.md`](upstream-issues.md) 回答的是"给上游提什么 issue"；两份**编号空间独立**
> （那是 Issue 1–15，这里是 Q1–Q17 / D1–D2 / K1–K2），且同一件事在两份里的名字不同 —— 交叉引用时认编号。
>
> **基线**：上游本地仓库 `C:/Users/leeexx/Documents/NewProject/SyncClipboard`，提交 `28c7e596`。
> 每条给 `文件:行` 与上游逐字代码。**未运行上游服务端** ⇒ "影响"是按代码语义的推断；
> 已用官方发布件 A/B 实测过的标 **[A/B 实测]**（依据 `docs/progress.md` §44）。
>
> **本实现侧的锚点一律写"文件 + 符号"**（如 `src/db.ts` 的 `shouldUpdate`），不写行号 ——
> 行号会随改动漂移，而这份文件的价值全在"能不能真的找到那一处"。

---

## 1. 结论

上游行为分三类，必须分开对待 —— 混在一起谈必然得出错误结论：

| 类别 | 定义 | 本实现的态度 |
|---|---|---|
| **契约** | 客户端依赖它做判定：状态码、媒体类型、DTO 形状、哈希、`ShouldUpdate` | **必须逐字复刻**，哪怕它看着别扭（ADR D9） |
| **缺陷** | 上游自己也认为是 bug，或会伤数据 / 内存 / 可用性，且**不在 wire 上、也无人依赖** | 可合理处置：加固 / 修好 / 登记为有意偏离 |
| **怪癖** | 上游没明说的实现细节，第三方客户端理论上可能撞上 | 按"是否已在 wire 上可观测"决定复刻还是收敛 |

| 处置 | 条数 | 含义 |
|---|---|---|
| **A · 必须复刻** | 10 | wire 上可观测且客户端可能依赖 ⇒ **不要"顺手改好"** |
| **B · 有意偏离（已登记）** | 5 | 已偏离且写进 `protocol.md` §10；**维持** |
| **C · 结构性消除** | 2 | 上游问题在本架构下**结构性地不存在**（无缓存、有唯一索引） |
| **D · 待办** | 2 | 行为已对、缺的只是**说明**；两条已在同轮补齐 |
| **K · 需知** | 2 | 无行为后果，仅记录（K1 = 有意不做，K2 = 跟版观察） |

**一句话**：本实现的复刻**没有一处是"抄错了"** —— 每处都能指回上游的具体位置，也都能说清"为什么必须这样"。

---

## 2. 逐条清单

### 2.1 A 类 · 必须复刻（10 条）

| # | 项 | 上游位置与行为 | 本实现 |
|---|---|---|---|
| Q1 | **路由整体大小写不敏感** | `SyncClipboardController.cs` 与 `HistoryController.cs` 的 `[HttpGet]`/`[HttpPost]`/`[AcceptVerbs]`：ASP.NET Core 对**字面段** `OrdinalIgnoreCase` 匹配，`/API/version` 命中 | `src/pathCase.ts` 的 `normalizeProtocolPath`：只归一"上游确实有字面路由"的位置，取值段（`{fileName}`/`{profileId}`）**原样保留** ✅ [A/B 实测] |
| Q2 | **字符串枚举名大小写敏感（上游自身不一致）** | `Profile.cs` 的 `Enum.TryParse(parts[0], out type)`（`ignoreCase` 默认 **false**）；`HistoryController.cs` 那处却显式传 `true` | `src/serialization.ts` 的 `parseProfileType` **大小写不敏感** ⇒ 两处都宽松 ✅ 宽松超集（`protocol.md` §10 已登记） |
| Q3 | **`Enum.TryParse` 接受数字** | 同上：`"0-HASH"` 解析为 `Text`；越界数字（如 `"6"`）也"解析成功"⇒ 查不到 → 404 | `parseProfileType` 接受任意 int32，越界由查询自然落空 ✅ 已登记 |
| Q4 | **`ProfileTypeFilter` 高位不可达** | `HistoryService.cs` 的 `Enum.GetValues(typeof(ProfileType))` 只遍历**已定义值**；filter 只定义到 `All=15` ⇒ 16/32 永不被测试 | `src/db.ts` 的查询过滤走同一算法（遍历 `ProfileType` 的值，不遍历 filter 的位） ✅ |
| Q5 | **`ShouldUpdate` 的 5 分钟阈值语义** | `HistoryHelper.cs`：`gap <= 5min → newVersion >= oldVersion`，否则 `newUtc >= oldUtc`（**比的是时间而非版本**） | `src/db.ts` 的 `shouldUpdate` 逐字同构（`HISTORY_UPDATE_THRESHOLD_MS`） ✅ |
| Q6 | **Text `Size` 是 UTF-16 码元数** | `TextProfile.cs` 的 `Size = text.Length`（C# `string.Length` = UTF-16 码元） | `src/profile.ts` 用 `new TextDecoder().decode(content).length`，注释明说"不是 UTF-8 字节数（F11）" ✅ |
| Q7 | **Group `Size` 是条目长度之和** | `GroupProfile` 的 `totalSize`（**非** zip 体积） | `src/hash.ts` 的 `parseGroupZip` 返回 `totalSize = Σ contentLength`（非 `zipBytes.length`） ✅ |
| Q8 | **File 哈希的 `Name` 是名字而非路径** | `FileProfile.cs` 的 `GetSHA256HashFromFile` 只取 `Path.GetFileName(filePath)` ⇒ 同内容不同目录得**同 hash** | `src/hash.ts` 的 `fileProfileHash(fileName, content)`，调用方传 `basename` ✅ |
| Q9 | **`GET /file/{name}` 缺失时回退到更旧的同名记录** | `HistoryService.cs` 的 `GetRecentTransferFile`：按 `LastAccessed` 倒序**逐条** `File.Exists`，缺失继续回退 | `src/routes/webdav.ts` 遍历 `db.listTransferFileCandidates()`，返回首个**真实存在**的对象 ✅（成本见 `upstream-issues.md` Issue 11） |
| Q10 | **空 `hasData` 的 File/Image/Group 必须被拒** | `FileProfile.cs` 的 `Persist()` 抛 `Cannot persist a FileProfile with no data.`；`GroupProfile` 同型 ⇒ 上游 **500** | `src/profile.ts` 明确 **400** `Transfer data is required for X profile` ✅ 偏离（更准）已登记 |

**为什么 A 类不能"改好"**：Q1–Q3 是**兼容性超集**（收紧会让"上游能用、本项目不能用"的调用出现 —— 那是功能回归）；
Q5 是**跨设备收敛算法**（改了会让历史在两个实现之间反复互相覆盖）；Q6–Q9 直接决定 **hash 与 size 的取值**
（改了会让同一条剪贴板在两个服务端算出不同 hash，等于**整个历史库分裂**）；
Q10 是**拒绝语义**（客户端对 400 与 500 同为"失败重试"，但 4xx 更可诊断）。

---

### 2.2 B 类 · 有意偏离且已登记（5 条）

| # | 上游缺陷 | 本实现处置 | 登记处 |
|---|---|---|---|
| Q11 | **Basic 凭据缺冒号 → 500**：`BasicAuthenticationHandler.cs` 的 `Split(':')` 后直接取 `credentials[1]` ⇒ `IndexOutOfRangeException`，无 try/catch | **401**（`src/auth.ts` 的 `parseBasicCredentials` 用 `indexOf(':')`，`< 0` 返回 null） | `protocol.md` §10 |
| Q12 | **Basic 密码含冒号 → 认证失败**：同处 `Split(':')` 取 `[1]` ⇒ `a:b:c` 的密码被截成 `b`，含冒号的密码根本无法使用 | 取首个冒号后**全部**（`decoded.slice(sep + 1)`）⇒ 更宽容 | `protocol.md` §10 |
| Q13 | **`GET /file/{name}` 内部异常报成 400**：`catch (Exception ex) when (ex is not OperationCanceledException) { return BadRequest(ex.Message); }` ⇒ 磁盘故障、权限问题也报 400，且**回显 `ex.Message`** | **500**（异常上抛给运行时）。理由：把内部故障报成 400 误导排障；且回显的异常消息里是路径，等于一条信息泄露面 | `protocol.md` §10 |
| Q14 | **hash 含路径分隔符 → 500，且平台相关**：`Profile.cs` 的 `GetWorkingDirName` 抛 `ArgumentException`（未捕获 ⇒ 500）；判据用 `Path.DirectorySeparatorChar`/`AltDirectorySeparatorChar` ⇒ Windows 拒 `\` 与 `/`，Linux 两者都是 `/` ⇒ **只拒 `/`、放行 `\`** | 写路径入口一律 **400**（`src/types.ts` 的 `isValidProfileHash`），两平台一致；存储值分类视同损坏降级 | `protocol.md` §10（含"平台差异"一行） |
| Q15 | **C# 模型的宽松解析（`TryParse` 系列）**：`HistoryController.cs` 的 `ParseBool`/`ParseInt`/`ParseLong` **语法不合法即静默取默认值**（不报错）；`ParseDateTimeOffset` 失败回退 `UtcNow` | 协议面**逐字复刻**这四处（`src/routes/history.ts` 用 `parseCSharpInt32` 而非 `parseInt` —— `'3abc'`/`'3.9'`/`'0x10'` 在 `parseInt` 下会"成功"）；**但** query 的 `Types`/`Starred` 按 `[ApiController]` 绑定失败返 400 | `protocol.md` §10、`design.md` §9.1 |

---

### 2.3 C 类 · 结构性消除（2 条）—— 本实现不需要偏离，因为上游问题不存在

| # | 上游问题 | 为什么本实现天然没有 |
|---|---|---|
| Q16 | **当前 Profile 缓存永不失效**（= `upstream-issues.md` Issue 8）：① `SyncClipboardController.cs` 的 `_cache.Remove("SyncClipboard.json")` 用**字面量**，而读写用 `cacheKey = profilePath`（绝对路径）⇒ 失效语句**永远删不到东西**；② `_cache.Set` 无过期策略 ⇒ 进程外改动（共享卷 / 手工修复 / 备份恢复）后一直返回旧值 | 本实现**没有这一层缓存**：当前 Profile 存 D1 的 `Meta.current_profile`，`src/routes/webdav.ts` 的 `GET /SyncClipboard.json` 每次直读。`protocol.md` §10「缓存」行已写明"无缓存（D1/R2 直读）⇒ 等价（更强一致）" |
| Q17 | **无 `(UserId,Type,Hash)` 唯一约束**：`Migrations/…_Init.cs` 只有 `PK_HistoryRecords`，`HistoryDbContext.cs` 的三个索引都不含 `Hash` ⇒ `AddProfile` 的"查无 → 插入"在**多副本共享同一 `history.db`** 时无 DB 层保护，可产生重复行 | 本实现建了唯一索引 `ux_h_user_type_hash`，并把"并发抢先插入"变成**确定的合并路径**：`HistoryDb.insert()` 识别唯一约束冲突（`isUniqueConstraintError`）→ 复刻上游 `UpdateExistingRecordDto` 的判定合并（`existing.isDeleted` 或 `shouldUpdate(...)` 才合，`Version = max(new, existing+1)` 绝不倒退） |

> Q17 与上游自己那次同主题修复（`e79a18d6`「修复：数据库并发问题」，在基线之前）是同一件事 ——
> 但那次**只在客户端侧**处理，服务端仍没有唯一索引 ⇒ 对上游它仍是有效 issue 素材。

---

### 2.4 D 类 · 待办（2 条）—— 行为已对，缺的是说明

#### D1 · `Hash` 匹配用 `LIKE` ⇒ `%`/`_` 是通配符

- **上游**：`HistoryService.cs` 的
  `EF.Functions.Like(r.Hash, hash)` —— 第二个参数是**模式**：`%` 匹配任意串、`_` 匹配任意单字符。
- **本实现**：`HistoryDb.getByTypeAndHash` 用 `LOWER(Hash) = LOWER(?3)`（严格等值，可走索引）。
  `protocol.md` §10 有 [A/B 实测] 记录：`GET /api/history/Text-<前 8 位>%` → 上游 200 命中、本实现 404。
- **原缺口**：`src/db.ts` 的注释只写了"大小写不敏感，等价 `EF.Functions.Like`"，**漏了通配符那一半** ——
  只读代码的人会以为两者等价。
- **处置**：✅ 注释已补齐并指向 `protocol.md` §10 与本节（现状见 `getByTypeAndHash` 上方那段）。

#### D2 · 并发更新的"丢更新"（偏离已落地，理由此前只在代码注释里）

- **上游**：`HistoryService.Update` 是「查 → 判定 → 改字段 → `SaveChangesAsync`」，进程内用
  `_processSem`（**static** ⇒ 仅同进程有效）串行化。多副本共享同一个 `history.db` 时，两个并发 PATCH
  可各自通过 `shouldUpdate` 再各自 `SaveChanges` ⇒ **后者静默覆盖前者**；而官方客户端
  `OfficialAdapter.cs` 正**依赖 409** 来发现冲突并重试，这条路径在多副本下不会触发。
- **本实现**：`HistoryDb.updateEntityIfVersion` 走 `UPDATE … WHERE ID = ?16 AND Version = ?17`，
  按受影响行数判定冲突 → 409（`src/ui/routes.ts` 与协议路由映射为 `conflict`）。
- **原缺口**：理由此前只写在代码注释里。
- **处置**：✅ 理由已补进 `protocol.md` §10「并发」行（原文只写"UNIQUE 索引 + 唯一冲突合并 + 乐观锁"，
  没说乐观锁**防的是上游哪一类故障**）。

---

### 2.5 K 类 · 需知（2 条）—— 无行为后果，仅记录

#### K1 · 有意**不做**：`GET /file/{name}` 的 `%2e%2e` 路径形态

- **上游**：`SyncClipboardController.cs` 的 `InvalidFileName`（拒 `\` 与 `/`）在
  **`GetFileFromFolder` 里没有调用**，只在 `PutFileToFolder` 那条路径上有。编码后的 `%2e%2e` 解码成 `..`
  后能否绕过守卫，取决于 ASP.NET 的路径归一化 —— **未实测，故不作为上游 issue 主张**。
- **本实现**：`src/routes/webdav.ts` 三条 `/file/:fileName` 路由**一律**先过 `invalidFileName()` ⇒ 400。
- **处置**：**不改，也不提 issue**。本实现已防御；上游侧可达性未实测，按"凡未实测的推断不得作为结论"
  只登记为待实测候选（见 `upstream-issues.md` 的同名表格）。

#### K2 · 待观察：`TextProfile` 的 10 KiB 截断阈值是**硬编码**

- **上游**：`TextProfile.cs` 的 `private const int TRANSFER_DATA_THRESHOLD = 10240;` —— 超阈值时
  `_fullText` 留全文、`_text` 只留前 10240 字符 ⇒ **wire 上的 `text` 被截断**。
- **本实现**：同一语义（大文本以 `file/` 暂存 → `history/` 持久）；`src/routes/history.ts` 的
  内联文本上限注释里引用了这个常量名作为口径依据。
- **处置**：**不改**。它不是缺陷而是设计（避免大文本进 SQLite / wire）；记录在此仅供跟版核对 ——
  上游若改这个常量，wire 上的截断长度会变，本实现需跟。**纳入跟版观察项**。

---

## 3. 为什么"不合理地改好"会有害 —— 三条可证伪的约束

1. **hash 一致 = 数据一致**。Q6/Q7/Q8 决定 hash 与 `size`。若"顺手修正"（例如把 Text 的 `Size` 改成
   UTF-8 字节数），同一条剪贴板在两个服务端算出的 hash 就不同 ⇒ 客户端切换服务端时**整库重传一遍**，
   且两端历史无法对齐。这正是 `protocol.md` §8 把哈希列为"须精确复刻"的原因。
2. **状态码是客户端的控制流**。Q10（400 vs 500）、Q11（401 vs 500）都落在客户端的分支表上：
   `OfficialAdapter.cs` 对 `BadRequest`/`UnprocessableEntity` 抛"数据被拒"（**不重试**），
   其余走 `RemoteServerException`（**会重试**）。把 500 改成 400 会**改变客户端的重试行为** ——
   这比"状态码更好看"重要得多。
3. **收紧即破坏超集**。Q1–Q3 是本实现**比上游更宽松**的地方。宽松不会让官方客户端出错；
   收紧会让"上游能用、本项目不能用"的第三方调用出现 —— 那是**功能回归**，不是清理。

---

## 4. 复核记录：**不**建议提 issue 的候选

| 候选 | 为什么不成立 |
|---|---|
| 「`GET /file/{name}` 把内部异常报成 400」 | 已作为 **Q13 登记为有意偏离**，但**不单列为上游 issue**：它是"错误语义不够精确 + 信息泄露"，与 `upstream-issues.md` 的收录口径（安全 / 数据 / 可用性）不符者已另列。 |
| 「`GetFileFromFolder` 未调用 `InvalidFileName`」 | 同 K1：可达性未实测，按"未实测的推断不得作为结论"不作主张。 |
| 「`_processSem` 是 `static`，因此在 IOC 单例之外的 scope 间也共享」 | **驳回**。`static` 在这里有意为之且无害 —— `HistoryService` 注册为 `AddScoped`，静态信号量让多个 scope 共享同一把锁，正是"串行化"想要的语义；问题不在 `static`，而在**多进程 / 多副本**时锁失效（已并入 D2）。 |
| 「`TextProfile.cs` 的 `10240` 是魔法数字」 | **驳回**。有名字、有单一出处、注释可推导；且它是 wire 行为的一部分，不是坏味道。 |
| 「`GroupProfile` 的 `a` 与 `a/` 同名冲突不报错」 | **驳回**。官方客户端恒写显式目录条目且无重复，该路径不可达；已在 `README.md`「已知限制」与 `protocol.md` §10 登记。 |

---

## 5. 变更记录（2026-09-15，历史快照）

只读对照 + 文档补强，**未改动任何源码逻辑**：新建本文件；`upstream-issues.md` 头部统计修正并新增 Issue 14；
`protocol.md` §10 的「缓存」行补上游缺陷形态、「并发」行补乐观锁针对的故障类型；
`src/db.ts` 补注释（`Hash` 匹配与 `LIKE` 的等价边界）；`README.md` 修正 `tools/` 重复行与 issue 条数。

**边界声明**：本轮**未运行**上游服务端，也**未运行**本仓测试套件。所有"上游行为"结论均以 `28c7e596`
的源码为据；凡属推断已逐条标注，凡属已实测已标 **[A/B 实测]**。
