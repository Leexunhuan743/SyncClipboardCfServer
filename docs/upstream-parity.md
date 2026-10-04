# 上游对照报告：SyncClipboard ↔ SyncClipboardCfServer

> **精简介**：本节起为 2026-10-04 的整篇重写（原文 319 行）；历史版本见
> `git show <hash>:docs/upstream-parity.md`：重写前最近一版 `f6cced5`，初版（第一轮对照）见
> `git show --diff-filter=A --format=%h -- docs/upstream-parity.md`。
> 重写只改表述与结论口径，事实逐条照**当前**上游源码与**当前**本仓库代码复核；
> 原文里"第一轮（2026-09-15）做了什么"的过程叙述已从正文移到 §7，正文只留**结论**。
>
> **上游基线**：本地仓库 `C:/Users/leeexx/Documents/NewProject/SyncClipboard`。
> 对照起始于 `28c7e596`，2026-09-22 起跟到 `984d3463`（区间 12 笔；与本实现有关的四件事见 §3.8）。
> **本实现基线**：本文件描述的是**当前** `master`。
>
> **方法**：范围内文件**逐个打开**读取（不是检索式扫读）；HTTP 行为用**上游服务端源码 +
> 官方客户端源码**双向核对（`OfficialAdapter` / `WebDavBase` / `OfficialEventDrivenServer`
> 定义"服务端必须满足什么"）；另起了**真上游服务端**做 A/B（工具固化为
> `tools/ab-upstream-probe.ps1`），并用**真客户端**跑过生产 E2E。证据分级标在每条结论上：
> **[实测]** = 真上游 / 真客户端跑过；**[读码]** = 只对着源码推断，未运行。
>
> **姊妹篇**：[`protocol.md`](protocol.md) §10 是**逐条差异的唯一登记处**（本文件的差异项都在那里）；
> [`upstream-issues.md`](upstream-issues.md) 是**给上游提的 issue**；
> [`upstream-defects.md`](upstream-defects.md) 是**上游缺陷在本实现里的处置**。
> 本文件回答的是第三个问题：**范围内哪些文件被复刻、等价到什么程度**。

---

## 1. 范围：上游 785 个文件怎么处置

上游是**客户端 + 服务端同仓**的项目（`src/` 下 11 个工程、541 个 `.cs`）。本复刻只取**官方服务端**的运行形态。

| 上游工程 | 文件数 | 处置 | 依据 |
|---|---|---|---|
| `SyncClipboard.Server` | 8 | **对照**（部署 / 启动 / 配置） | 服务端宿主工程 |
| `SyncClipboard.Server.Core` | 33 | **对照**（协议面本体） | 控制器 / Hub / 服务 / 模型 / 迁移 |
| `SyncClipboard.Shared` | 34 | **对照**（协议地基：Profile、哈希、DTO） | 服务端引用的共享库 |
| `SyncClipboard.Test` | 24 | **参考**（语义约束的旁证） | 上游单测；本机无 .NET SDK，跑不了 |
| `SyncClipboard.Core` | 288 | **参考**（只读客户端侧契约） | 客户端业务逻辑；本轮读了 `RemoteServer/**`、`Utilities/Web/*` 用来确认"服务端必须满足什么" |
| `SyncClipboard.Desktop*` / `WinUI3` / `Test.Desktop` / `Test.WinUI3` | 390 | **不适用** | 平台壳与 UI |

`src/` 之外的目录同样逐个枚举过：`docs/`（其中的 `Hash.md`、`README_EN.md` 已作为**第三份独立证据**核对，
见 §3.8）、`.github/workflows/`（`server-build.yml` / `server-release.yml` 是复刻对象的发布链路）、
`build/`、`script/`、`winget-manifest/`、`LICENSES/` 等 —— 除上两处外均与运行形态无关。

**范围内的三处"不适用"（有理由，不是遗漏）**：上游没有云托管形态，因此 Kestrel 端点 / 证书、
Docker 数据卷、`ServerPara`（进程内嵌服务器的启动参数）、Swagger（`DiagnoseMode`）在本项目没有对应物 ——
它们的能力由被托管平台的等价物或本项目的界面替代。

---

## 2. 文件映射总表

### 2.1 `SyncClipboard.Server`（8）

| 上游 | 本实现对应物 | 结论 |
|---|---|---|
| `Program.cs` | `wrangler.toml`（绑定 / 变量 / 定时）+ `src/index.ts`（`fetch` / `scheduled`） | 等价。上游「环境变量优先、否则配置文件」的凭据选择 → 只用 Cloudflare secrets（**fail-closed**，不保留 `admin/admin` 回退） |
| `appsettings.json` | `wrangler.toml` 的 `[vars]` + secrets + `src/env.ts` | 等价：`MAX_SAVED_HISTORY_COUNT=1000`、`HISTORY_RETENTION_MINUTES=0` 数值一致；Kestrel / 日志节不适用 |
| `appsettings.Development.json` | `.dev.vars.example` | 等价（都只是本地开发凭据样例） |
| `Dockerfile` / `docker-compose.yml` / `.dockerignore` | 无 / 无 / `.gitignore` | 不适用（托管平台）；`.dockerignore` 的作用由 `.gitignore` 的 `.dev.vars` 规则承担 |
| `README_DOCKER.md` | `README.md` 的部署章节（含 GitHub Actions 方式） | 等价（重写，且新增 CI 路径） |
| `SyncClipboard.Server.csproj` | `package.json` + `tsconfig.json` | 等价（依赖清单 / 编译目标） |

### 2.2 `SyncClipboard.Server.Core`（33）

| 上游 | 本实现对应物 | 结论 |
|---|---|---|
| `Web.cs` | `src/index.ts`（中间件链、路由装配）+ `src/hub.ts`（negotiate / 转发） | 等价。`AddSignalR()` 默认值（KeepAlive 15s / ClientTimeout 30s / 传输宣告顺序）逐项对齐；`MaxRequestBodySize=int.MaxValue` → **默认 48 MiB**（可调 64 MiB）+ 413（已登记的安全收紧） |
| `BasicAuthenticationHandler.cs` | `src/auth.ts` | 等价 + 增强（定长字节比较、失败限速、弱凭据告警、未配置 fail-closed）；畸形 Basic 头上游 500 / 本实现 401（已登记） |
| `CredentialChecker/{I,Static,File}CredentialChecker.cs` | `src/auth.ts` 的 `verifyCredentials` + `env.USERNAME/PASSWORD` | 等价（三文件合一；**默认口令回退被有意去掉**） |
| `Constants/SignalRConstants.cs` | `src/hub.ts` 的 `HUB_PATH` | 等价（`/SyncClipboardHub` 逐字） |
| `Controllers/SyncClipboardController.cs` | `src/routes/webdav.ts` + `src/index.ts`（`/api/time`、`/api/version`） | 等价：18 个返回点全覆盖（含 3 个降级出口、`InvalidFileName`、404 文案）；PROPFIND 200→207 已登记 |
| `Controllers/HistoryController.cs` | `src/routes/history.ts` | 等价：全部返回点覆盖；媒体类型 415 与 urlencoded 的缺口已修（§4.1 P1/P2） |
| `Models/AppSettings.cs` | `src/env.ts` + `wrangler.toml` | 等价（默认值一致） |
| `Models/HistoryQueryDto.cs` | `src/types.ts` 的 `HistoryQueryDto` | 等价（含 `Types` 位掩码、`SortByLastAccessed`） |
| `Models/HistoryRecordDto.cs` | `src/types.ts` + `src/serialization.ts` | 等价（`hasData` 推导、`Stared`→`starred`、ISO 时间） |
| `Models/HistoryRecordEntity.cs` | `src/types.ts` 的 `HistoryRecordEntity` + `schema.sql` | 等价（列集合无缺项）。**保留列** `TransferDataSha256`/`TransferDataMd5`/`From`/`Tags`/`ExtraData` 两侧都只建列、从不写入（上游仅 `Mapper.cs` 显式置 `ExtraData = null`）⇒ 无行为差异 |
| `Models/HistoryRecordUpdateDto.cs` | `src/types.ts` 的 `HistoryRecordUpdateDto` | 等价（`isDelete` 拼写、`int?` 校验 → 400） |
| `Models/HistoryStatisticsDto.cs` | `src/types.ts` + `src/serialization.ts` 的 `historySizeMB` | 等价（**含"非零但不足 0.01 MB 显示 0.01"这条上游口径**） |
| `Models/Mapper.cs` | `src/serialization.ts` 的 `entityToDto` / `entityToDtoWire` | 等价 |
| `Models/HistoryRecordCreateDto.cs` | 无 | **上游死代码**：全仓除自身定义外零引用（"当前仓库内"的结论，见 §6.3） |
| `Attributes/DisableFormValueModelBindingAttribute.cs` | 无同类 | 等价：上游用它避开框架的流式绑定；本实现本来就"全量读入后自解析"（内存代价已登记） |
| `Exceptions/HistoryTransferDataException.cs` | `src/profile.ts` 的 `ProfileDataInvalidError` | 等价（→ 422 `history_data_invalid` + ProblemDetails 四字段） |
| `Services/ServerProfileEnvProvider(.Extension).cs` | `src/storage.ts` 的 key 布局（`file/`、`history/{Type}_{hash}/`） | 等价（`GetHistoryPersistentDir` 与 `GetPersistentDir` 上游同值） |
| `Services/History/HistoryService.cs` | `src/profile.ts` + `src/db.ts` + `src/historyOps.ts` | 等价（逐方法核对，见 §3.2；差异见 §4.3） |
| `Services/History/HistoryCleaner.cs` | `src/cleanup.ts` | 等价语义，周期 / 批次不同（已登记：CF 子请求预算） |
| `Utilities/History/HistoryDbContext.cs` + `Migrations/*` | `schema.sql` + `src/db.ts` | 等价（列无缺）；**时间列类型与索引集不同 → 已补索引**（§4.1 P3） |
| `Utilities/History/HistoryHelper.cs` | `src/db.ts` 的 `shouldUpdate` | **逐字等价**（阈值 5 分钟；阈值内比 Version、阈值外比 LastModified） |
| `Utilities/MigrationHelper.cs` | `schema.sql`（幂等）+ CI 的 `d1 execute` | 等价；`CLEAR_SQLITE_LOCK` / `__EFMigrationsLock` 在 D1 上不适用 |
| `Swagger/*` | 无（界面「部署信息 / 维护面板」替代诊断面） | 不适用 / 有意偏离 |

### 2.3 `SyncClipboard.Shared`（34）

| 上游 | 本实现对应物 | 结论 |
|---|---|---|
| `ProfileDto.cs` | `src/types.ts` + `src/serialization.ts` | **逐字等价**（`JsonStringEnumConverter` 作用于 `type`；`WhenWritingNull` 只加在 `size`；`dataName` 为 null 时**保留键**） |
| `SyncClipboardProperty.cs` | `wrangler.toml` 的 `VERSION` | **逐字等价**（现值 `3.3.0-beta1`，随上游 #435 跟进；见 §3.8 与 `protocol.md` §10） |
| `Profiles/Profile.cs` | `src/profile.ts` + `src/types.ts` | 等价（`GetWorkingDirName` 的分隔符约束、`ParseProfileId`、`Create` 的类型提升） |
| `Profiles/TextProfile.cs` | `src/profile.ts`（PUT/POST 两条路径分开复刻） | 等价（哈希按文件字节、`Size` 口径、`NeedsTransferData` 判定） |
| `Profiles/FileProfile.cs` | `src/hash.ts` 的 `fileProfileHash` + `src/profile.ts` | **逐字节等价** |
| `Profiles/ImageProfile.cs` | `src/profile.ts`（提升规则 + 同一套哈希） | 等价 |
| `Profiles/GroupProfile.cs` | `src/hash.ts` 的 `parseGroupZip` / `groupHashFromEntries` | 哈希 / 排序 / NUL 行格式 / 隐式父目录 / 顶层条目**逐项等价**；上限与 `.` 段、重复条目的差异见 §4.3 |
| `Profiles/{GroupEntry,ProfileType,ProfileTypeFilter,IProfileEnv,LocalProfileDataUnavailableException,UnknownProfile,Models/*}.cs` | `src/types.ts` + `src/hash.ts` + `src/profile.ts` | 等价，或服务端不需要（`UnknownProfile` 服务端不构造；`ClipboardProfileDTO` 上游自身已 `[Obsolete]` 且抛异常） |
| `Utilities/ByteArrayComparer.cs` | `src/hash.ts` 的 `compareBytes` | 等价（无符号逐字节 + 短者在前） |
| `Utilities/Utility.cs` | `src/profile.ts`（`CreateTimeBasedFileName` 等价形状）+ `src/hash.ts` | 等价（时间戳 + 8.3 随机段、字母表 a-z0-9） |
| `Utilities/HistoryManagerHelper.cs` | `src/cleanup.ts` 的分批 / 判定 | 等价语义；差异见 §4.3（上游 batch 500 / 无上限循环 vs 本实现 500 分片 + 预算 + 游标） |
| `Utilities/{FileSys,ImageTool,FileFilterHelper,IEnumerableExtention,ScopeGuard,IHistoryEntityRepository,Models/FileFilter*}.cs` | 无 / `src/hash.ts` 的部分逻辑 | 不适用，或不参与服务端哈希（`FileFilterConfig` 在服务端恒为默认实例） |
| `ClipboardProfileDTO.cs` / `IClipboardImage.cs` / `IClipboardMoniter.cs` / `ServerPara.cs` / `Attributes/ConfigKeyAttribute.cs` / `Interfaces/IConfigValidator.cs` / `Models/DateTimePropertyHelper.cs` | 无 | 不适用（客户端 UI / 配置 / 平台接口；`ServerPara` 只用于进程内嵌服务器） |

---

## 3. 行为等价性（不只对接口名）

### 3.1 HTTP 协议面

- **返回点覆盖**：两个控制器共 18 个 action、约 45 个返回点，全部有对应分支；上游唯一"缺失"的
  `GET /api/history/{type}` 在**上游自身**被整块注释掉（`HistoryController.cs:70-75`）。
- **状态码与文案**：400/404/409/415/422 与 `"Hash is not match data."`、`"Needs tranfer data."`、
  `"after must be less than before"`、`"Invalid profileId format. Expected format: 'Type-Hash'"`、
  `"DataName cannot be null or empty when HasData is true"`、`"Transfer data file not found"` 逐条对上。
- **模型绑定语义**：`int.TryParse`/`long.TryParse`/`bool.TryParse`/`Enum.TryParse` 的"整体合法、失败取默认"
  与 `[ApiController]` 的"绑定失败即 400"两条都复刻。
- **响应头**：`WWW-Authenticate: Basic realm="SyncClipboard"` 逐字；附件 `Content-Type` 与
  `Content-Disposition` 的差异属已登记的安全加固。
- **客户端侧交叉验证**（读上游客户端源码确认服务端契约）：`OfficialAdapter` 把 profile / 文件传输
  **委托给 `WebDavAdapter`** ⇒ 官方服务器上真实使用的 WebDAV 面是 `PROPFIND /`（`Test()`）、`MKCOL file`、
  `PROPFIND file/`（`DirectoryExist`，恒加尾斜杠）、`DELETE file/`（`DirectoryDelete`）—— 本实现用 Hono
  `strict:false` 对齐；`GetVersionAsync` 读到 404 才视作"无 profile"，`SetCurrentProfile` 把 404 映射为
  `RemoteHistoryNotFoundException` ⇒ 本实现的 404 语义正确。

### 3.2 数据与状态流转

- `ShouldUpdate` 逐字等价（含阈值与两个比较分支）。
- 软删 / 硬删 / 广播的**触发点与顺序**一致：软删 → 广播 `RemoteHistoryChanged`；硬删不广播；
  标记删除后 `Version++`、`LastModified = now`。
  ⚠️ **"删数据目录"这一环自 2026-09-22（ADR D29）起有意不同**：上游 `DeleteProfileDataIfNeed`
  在 `IsDeleted` 为真时**立刻**删工作目录（`Update` / `UpdateExistingRecordDto` / `AddNewRecordDto` 三处），
  本实现**保留**数据到"真的没了"那一刻（30 天硬删 /「彻底删除」/「清空回收站」）—— 否则「回收站」
  对图片与文件是单向门。登记在 `protocol.md` §10。
- `Update`（PATCH）：`dto.Version ??= existing.Version + 1`、`dto.LastModified ??= UtcNow`、
  判定失败 → 409 回服务器当前值 —— 逐条一致。**末了一条守卫有意去掉**（同一处登记）：
  上游「`isDelete=false` 且已删且有数据文件 → 404」，本实现**允许恢复**（数据保留了，恢复就该成功）。
- `AddRecordDto`（POST）：既有记录分支只拷元数据；新增分支 `IsLocalDataValid(true)` 失败 → 400。
- `AddProfile`（PUT 复用 / 复活分支）：上游只覆盖 `LastAccessed/IsDeleted/LastModified/TransferDataFile/FilePaths` ——
  本实现额外覆盖了 `Text/Size`，**判定为低风险偏差并保留**（理由见 §4.3）。

### 3.3 哈希 / 体积 / 命名

四种 Profile 的哈希公式、排序比较器、NUL 结尾行格式、隐式父目录、`TrimEnd('/')` 顶层判定、
`CreateTimeBasedFileName` 形状、`GetWorkingDirName` 的字符约束**逐项等价**（用例见 `test/hash.test.ts`）。
`Size` 在 PUT / POST 两条路径上的不同口径也都复刻。

### 3.4 清理与保留

保留期四条件（`!IsDeleted && !Stared && !Pinned && LastModified < cutoff && LastAccessed < cutoff`）、
`MAX(LastModified, LastAccessed)` 排序、条数上限排除收藏 / 置顶、30 天硬删、孤儿目录差集 —— 全部等价。
软删单批 **500**（与上游一致）；周期 **20 分钟 vs 上游的 10 分钟**，差异只在"积压收敛速度"
（本实现另有平台单次调用的子请求预算与游标续跑）。
[实测]（本地 miniflare，真实 Cron 触发）：300 条过期记录与 500 条超量都在**一轮内**处理完，单轮子请求 508 / 800。

### 3.5 鉴权与实时

Hub 路径、广播方法名与参数形状（`RemoteProfileChanged` / `RemoteHistoryChanged` 单参数）、
传输宣告顺序与格式表、KeepAlive 15s、长轮询挂起 < 客户端 100s 超时 —— 等价。
上游 Hub 类没有客户端可调用的 RPC（纯推送），本实现同样无；`OnConnectedAsync`/`OnDisconnectedAsync`
上游未使用，故不构成缺失。

### 3.6 配置 / 构建 / 部署

配置键与默认值见 §2.1。上游服务端的发布链路是 `dotnet publish` → zip + Docker 镜像
（`server-build.yml` / `server-release.yml`），**链路里没有任何测试门禁**；本仓库的等价物是
`quality`（typecheck + lint + 全部套件，自起 miniflare）→ `needs: quality` 才 `deploy`，属**更强**的一侧。
部署链路的三个真实缺口见 §4.2。

### 3.7 配置面：`[observability]` 与 compat date

- 上游的 `Logging:LogLevel` 在 Workers 上没有等价物（console 即日志流），本实现显式声明
  `[observability] enabled = true`（**不依赖"新建 Worker 默认已开"这一会变的默认**），
  README 的「日志与排障」写清查询方式、7 天保留与隐私口径。
- 本地与生产跑在同一个 `compatibility_date`（`wrangler.toml` 的 `2025-09-01`）：wrangler 4 不再有
  "本地运行时最高支持某日期"的回退问题（见 §5）。

### 3.8 上游自带文档的交叉核对（第三份独立证据）

| 上游文档 | 核对结果 |
|---|---|
| `docs/Hash.md` | **与实现一致，也与本实现一致**：Text = UTF-8 SHA256；File/Image = `SHA256(UTF8("文件名\|" + 大写(内容哈希)))`；Group = 条目按 EntryName 的 **UTF-8 字节字典序**升序，拼 `D\|{name}\0` / `F\|{name}\|{length}\|{contentHash}\0` 后再 SHA256。文档里的示例（`D\|folder/` → `F\|folder/a.txt\|100\|…` → `D\|folder/subdir/` → `F\|folder/subdir/b.txt\|200\|…`）恰好验证了本实现「隐式父目录计入 + 目录条目前缀」两条推导规则。另："Hash 实际使用时大小写不敏感"与本实现的 `LOWER(Hash) = LOWER(?)` 一致 |
| `docs/README_EN.md` 的 API 章节 | 与本实现一致：`GET/PUT SyncClipboard.json`、`GET/PUT /file/dataName`、ProfileDto 字段语义（`dataName` 在 `hasData` 为真时必填、File/Image/Group 恒 `hasData=true`、`text` 是预览 / 全文、`size` 是文件字节数或 Text 完整串长度）、"不要在 url 结尾带 `/`"。**一处上游文档与自己的实现不符**：文档写「All API fields are case-sensitive」，而 ASP.NET 的 `JsonSerializerOptions.Web` 默认 `PropertyNameCaseInsensitive=true`（multipart 侧更是显式 `StringComparer.OrdinalIgnoreCase`）⇒ 实际不区分大小写，本实现的宽松解析才与**行为**一致 |
| `docs/ai_design/Issue-408-Missing-Group-Data-Retry-Design.md`（上游最新一轮设计文档） | 它把服务端契约写死为：**无效 Group 归档 / 哈希不符 → 可识别的 422 + 响应无堆栈 + 不创建 DB 记录 + 不残留上传文件或解压目录**。本实现逐条满足：`parseGroupZip` / `fileProfileHash` 都在 `storage.putHistory` **之前**抛出，失败路径不写 R2、不入库（`test/protocol.test.ts`、`test/fix-regressions.test.ts`、`test/limits.test.ts` 有断言）；422 体是 ProblemDetails（无堆栈）。本实现用对象存储、没有"解压目录"这一概念，故该条天然满足 |

---

## 4. 差异清单

### 4.1 已修复（代码 + 测试）

| # | 差异 | 上游证据 | 修复 | 验证 |
|---|---|---|---|---|
| P1 | `POST /api/history` 收到非 multipart 时返 400，上游返 **415**（`[Consumes("multipart/form-data")]` 在模型绑定之前拒绝） | `HistoryController.cs:121` | `src/routes/history.ts` 的 `parseFormBody(c, false)`：媒体类型判定 → 415，并在提前返回前排空请求体 | `test/protocol.test.ts`（415 / 缺 boundary → 400 / 415 后 isolate 仍健康） |
| P2 | `POST /api/history/query` 只接受 multipart；上游 `[FromForm]` 同时接受 `application/x-www-form-urlencoded` | `HistoryController.cs:81` | 新增 `allowUrlEncoded` 分支（`URLSearchParams` → 同一套取值语义，字段名大小写不敏感） | `test/protocol.test.ts`（urlencoded 且断言 `SearchText` 真被解析；非法 `Page` → 400） |
| P3 | `schema.sql` 缺上游为「收藏 + 时间/类型 + 翻页」建的复合索引 | `HistoryDbContext.cs:40-52`、`Migrations/20251105014242_Init.cs:50-58` | 补 `idx_h_user_stared_create`、`idx_h_user_stared_type_create`（上游第三个 `(UserId,CreateTime,ID)` 无需单建：SQLite 索引条目隐含 rowid，而 `ID` 即 rowid 别名） | `d1 execute --local --file=./schema.sql` 幂等成功；全量套件复跑通过 |
| P4 | README 把客户端 10 秒探活写成「一次 `/api/version`」⇒ 单客户端 8.6k 请求 / 天 | `OfficialAdapter.cs:144-170` + `WebDavBase.cs:271-282`：`TestConnectionAsync` 先 `PROPFIND /` 再 `GET /api/version`，**每次探活两个请求** | 改为 **17.3k 请求 / 天**、免费版可支撑 **≤5 个客户端** | 源码逐行核对 |
| P5 | `protocol.md` §10 未登记本轮新核实的 8 类差异 | —— | 补 10 行（415、urlencoded、非表单媒体类型、畸形 Basic 头、hash 匹配方式、时间列存储形态、索引集合、Group `.` 段 / 重复条目、落库大小写） | `test/docs.test.ts` |

### 4.2 未修复但已分级（不阻断上线，部署侧需注意）

| # | 项 | 级别 | 说明与处置 |
|---|---|---|---|
| U1 | CI 不创建 D1 / R2 资源 | 中 | `deploy.yml` 只对**已存在**的库执行 `d1 execute`；全新账号首次部署仍须照 README 手工 `d1 create` / `r2 bucket create`。README 写了，但 CI 不会给出可诊断的提示 |
| U2 | 冒烟检查只断言未认证请求 = 401 | 中 | 能间接发现"凭据未配置"（那种情况返 500），但**不能**证明凭据可用、历史读写打通。建议后续加一步带凭据的 `/api/history/statistics` |

> 原 U3（本地 compat date 与生产不一致）与 U4（无日志级别配置）已消解 —— 见 §3.7 与 §5。
> 原 U5（版本事实源三处不同）已修复：`VERSION` 现为 `3.3.0-beta1`，与上游基线 `984d3463` 编译后
> 真实返回值逐字一致。两套编号的语义在 README 写清：`VERSION` = 对外自我描述，
> `package.json` 版本 = 迁移项目自身版本。

### 4.3 有意偏离（**已在 `protocol.md` §10 登记，不复修**）

| 项 | 理由 |
|---|---|
| 请求体上限默认 48 MiB（上游无上限；可调至 64 MiB） | 安全收紧；isolate 只有 128 MiB 且被并发共享，放行接近平台上限的体会在解析期 OOM。上限与分组解压共享同一份"工作集预算"（96 MiB） |
| Group zip 解压上限（总量 64 MiB / 条目 1000 / 单条目 24 MiB / 压缩比 100:1） | 上游可在哈希校验前付出全量解压代价（已作为上游 Issue 5 提出）。**代价**：含 1000+ 文件的合法文件夹会被拒 —— 属已知限制 |
| 清理周期（20 分钟统一）与批次（软删 500 / 硬删 1000） | CF 单次调用子请求上限（800 预算 + 阶段保底 + 游标续跑）；软删批次**与上游同为 500** |
| 保留策略在线可调（Meta 覆盖） | 上游只能改配置文件重启；本实现只加不减语义 |
| `clear` 不逐条广播 | 上游广播触发点清单不含 clear；逐条广播会超子请求上限 |
| 协议侧忽略 `Range`，UI 数据端点支持 206 | 对齐上游 `EnableRangeProcessing=false`；界面另开一层 |
| PROPFIND 200 空体 → 207 multistatus；新增 `DELETE /file/{name}` | 上游的空体在 `PreciseDelete` 下会让客户端 `LoadXml` 抛异常 |
| 附件响应头加固（nosniff / CSP / attachment） | 存储型 XSS 面；客户端不读这些头 |
| 单条 PATCH 的 `hash` 含分隔符 → 400；时间字段解析失败 → 忽略 | 前者把上游的未捕获异常变成可诊断的 400；后者避免客户端整轮同步失败 |
| hash 落库统一大写 | 避免 Linux 上同内容产生两个工作目录 |
| Group `.` 段条目名一律拒；重复条目去重 | fail-loud 优于平台相关归一化；官方客户端不可达 |

### 4.4 复核后判定**不需要修**的候选

| 候选 | 结论 |
|---|---|
| 列表排序缺 `ThenByDescending(ID)` | **不成立**：本实现是 `ORDER BY sortCol DESC, ID DESC`，与上游 `OrderByDescending(...).ThenByDescending(ID)` 完全一致 |
| 硬删记录时无条件删数据目录 | **不成立**：上游 `DeleteProfileDataIfNeed(force:false)` 只在 `IsDeleted == false` 时早退，而硬删的候选集恒为已删记录 ⇒ 上游同样会删目录 |
| `MarkForDeletionAsync` 的 detached 分支"设了字段却不保存" | **不成立**：该分支改的是 `Query()` 取回的**被跟踪实体**，保存由 `HistoryManagerHelper` 显式 `SaveChangesAsync()` 负责 |
| `Web.cs` 未设 `DefaultChallengeScheme` ⇒ 401 变 500 | **驳回**（框架回退链 `DefaultChallengeScheme ?? DefaultScheme`，而 `AddAuthentication("BasicAuthentication")` 设的正是 `DefaultScheme`）。[实测] 已由 A/B 探针确认 401 + `WWW-Authenticate` 正常 |
| `README_DOCKER.md` 的挂载路径 `/app/appsettings.json` 与 `--contentRoot /app/data` 不符 | **驳回**：`Program.cs:48-74` 正好从 `/app`（`AppContext.BaseDirectory`）把该文件复制到 `/app/data/` 并显式 `AddJsonFile` ⇒ 文档给的挂载点生效 |
| `dto.Version` 为 null 会 NRE | **不成立**：`HistoryService.cs:50-51` 有 `??=` 兜底 |

---

## 5. 风险汇总

**阻断上线：无。**

| 级别 | 项 |
|---|---|
| 中 | U1（新环境首次部署靠手工建资源）、U2（冒烟断言弱）、清理周期与上游不同（已登记；饱和积压下收敛更慢） |
| 低 | 畸形 Basic 头的状态码类别不同（5xx / 4xx，第三方客户端可能误判）、`AddProfile` 额外覆盖 `Text/Size`、hash 匹配从 `LIKE` 收紧为等值、query 对非表单体回 400（上游按空表单处理）、Group `.` 段与重复条目语义差异 |
| 已消解 | 本地 compat date 回退（wrangler 已升到 4）、无日志配置（已显式声明 `[observability]`）、版本事实源不一致（已对齐 `3.3.0-beta1`） |

---

## 6. 仍需人工确认

1. **尚未实测的一项**：客户端发 `{"type":7}`（Close）后服务端是否回 Close 帧 —— 探针停在 HTTP 层，
   未做 WebSocket 帧级捕获。
   （`negotiate` 的"版本 >1 钳为 1 / 出错仍回 200 / `connectionToken` 仅版本 >0 出现 / 错误串逐字"
   与 `[FromForm]` 对非表单体等价于空表单，都已 [实测] 一致 —— 做法与结论见 §7。）
2. **上游客户端 E2E** 已 [实测]：官方便携客户端 × 生产 worker 的文本与文件双向同步、
   实时推送（1.5 s 内改写剪贴板）、File hash 规则逐字相同。P1 / P2 的两处改动也确实落在
   客户端不走的路径上。
3. **上游 `HistoryRecordCreateDto`**：全仓零引用，但可能是给未来 / 外部（如 SDK）用的公共模型；
   "死代码"只是**当前仓库内**的结论。
4. **上游基线的"自我描述滞后"现象**：基线在 `v3.2.0` 标签之后 14 个提交（含服务端 `#402` 保留期自动删除、
   `#412` 完整性检查），但版本号当时仍写 `3.2.0`；`984d3463` 才随 #435 变成 `3.3.0-beta1`。
   该值**没有功能后果**（客户端下限是 `3.1.1`，且 `AppVersion.TryParse` 失败时版本检查被静默跳过），
   改的只是自我描述的真实性。

---

## 7. 验证方式与证据

**验证方式**：`wrangler dev --test-scheduled`（本地 miniflare，128 MiB isolate、D1/R2/DO 全部模拟）
+ 全量套件（HTTP 黑盒、真 SignalR 客户端三传输、清理 Cron 真触发、界面 API 与契约守卫）
+ **真上游 A/B**（`tools/ab-upstream-probe.ps1` × 官方服务端发布件：34 例状态码级 + 18 例 negotiate 文本级）
+ **真客户端 E2E**（官方便携客户端 × 生产：双向文本 / 文件 + 实时推送）。

**做法（可复现）**：本机**有** ASP.NET Core 运行时（只是没有 SDK），而官方 release 附了框架依赖型的
`SyncClipboard.Server.zip` ⇒ 直接起官方服务端对跑。A/B 的结论逐条记在 `docs/progress.md` §44
（含修掉的两处真缺陷与 3 条大小写用例从"已知偏离"转为"一致"）。

**结果**：22 个套件全绿；`npm run check`（`tsc --noEmit` + `eslint`）通过；
`schema.sql` 幂等执行成功；文档口径守卫与前端契约守卫通过。

**一次测试波动（如实记录）**：`test/signalr.test.ts` 的「心跳跨过客户端 ServerTimeout」用例
（真实时钟等待 35 秒）在与另一条 shell 命令并发执行时失败过一次，单独复跑与随后的空载全量复跑均通过。
该用例依赖真实时钟与 DO alarm，机器负载会直接影响它；当时未改动 Hub/DO 代码。

**结论**：

- **协议层完整、行为等价**：上游 18 个 action / 约 45 个返回点全部覆盖；差异项**要么已修**（§4.1），
  **要么是已在 `protocol.md` §10 逐条登记的有意偏离**（安全加固、平台约束、fail-loud 取舍）。
- **未发现阻断上线的等价性缺口**；已修的两处（415、urlencoded）都是"上游有、本实现没有"的真实契约差异。
- **可上线的边界**：① 部署前需手工创建 D1/R2（U1）；② §6.1 的帧级行为待确认。
- 本轮**未修改上游任何文件**。
