# 上游对照报告：SyncClipboard ↔ SyncClipboardCfServer

> **基准**：`C:/Users/leeexx/Documents/NewProject/SyncClipboard` @ `28c7e596`（`fix: 数据储存型服务器上的大文件，
> 桌面客户端循环反复下载 (#415)`）。本轮未改动上游任何文件。
> **对象**：本仓库（迁移实现）@ 本轮基线 `e86ddef`。
> **方法**：上游在范围内文件**逐个打开**读取（不是检索式扫读）；HTTP 行为以**上游服务端源码 + 官方客户端
> 源码**双向核对（`OfficialAdapter` / `WebDavBase` / `OfficialEventDrivenServer` 定义了服务端必须满足的契约）；
> 迁移侧改动后跑全量套件验证。**未运行上游服务端**（本机无 .NET SDK、无 NuGet 缓存），涉及
> ASP.NET Core 框架运行时行为的结论均标注为「推断/待实测」。
> **关联**：逐条差异的登记表在 [`protocol.md`](protocol.md) §10；上游自身缺陷在 [`upstream-issues.md`](upstream-issues.md)；
> 本轮实施记录在 [`progress.md`](progress.md) §39。

---

## 1. 范围与分类（上游 785 个文件如何处置）

上游是一个**客户端 + 服务端同仓**的项目（`src/` 下 11 个工程、541 个 `.cs`）。本迁移只复刻**官方服务端**
的运行形态，故先做范围判定，再对范围内文件逐文件对照：

| 上游工程 | 文件数 | 处置 | 依据 |
|---|---|---|---|
| `SyncClipboard.Server` | 8 | **对照**（部署/启动/配置） | 官方服务端的宿主工程 |
| `SyncClipboard.Server.Core` | 33 | **对照**（协议面本体） | 控制器/Hub/服务/模型/迁移 |
| `SyncClipboard.Shared` | 34 | **对照**（协议地基：Profile、哈希、DTO） | 服务端引用的共享库 |
| `SyncClipboard.Test` | 24 | **参考**（作为语义约束的旁证） | 上游单测；本机无法运行（无 .NET SDK） |
| `SyncClipboard.Core` | 288 | **参考**（只读客户端侧契约） | 客户端业务逻辑，服务端不依赖；本轮读了其中 `RemoteServer/**`、`Utilities/Web/*` 用于确认"服务端必须满足什么" |
| `SyncClipboard.Desktop*` / `WinUI3` / `Test.Desktop` / `Test.WinUI3` | 390 | **不适用** | 平台壳与 UI，属于客户端 |

**范围内的三处"不适用"（附理由，不是遗漏）**：上游没有云托管形态，因此 Kestrel 端点/证书、Docker
数据卷、`ServerPara`（进程内嵌服务器的启动参数）、Swagger（`DiagnoseMode`）在本项目里没有对应物 ——
它们的能力在被托管平台的等价物或被本项目界面替代（逐项见 §2/§6）。

### 1.1 `src/` 之外的目录（同样逐个枚举，判为不适用）

| 上游目录 | 内容 | 判定 |
|---|---|---|
| `docs/` | `Hash.md`（**上游自带的哈希规范**）、`README_EN.md`（**公开 API 文档**）、`S3-Adapter-Design.md`、`ai_design/*`、图片、`donate.md` | **已核对**：前两个是协议级文档，与迁移实现逐条比对见 §3.7；其余为客户端设计/宣传素材 |
| `.github/workflows/` | 24 个工作流，其中 `server-build.yml` / `server-release.yml` 是本复刻对象的构建与发布链路 | **已核对**：`dotnet publish` → zip 产物 + Docker 镜像（`linux/amd64,linux/arm64` → Docker Hub）。**上游服务端发布链路没有任何测试门禁**（对比：本仓库 CI 先跑 20 个套件，`needs: quality` 才部署） |
| `build/` | 客户端安装包/打包脚本（Inno Setup、dmg、AppImage、pupnet） + 图标 | 不适用（客户端打包） |
| `script/` | AutoX.js / HTTP Shortcuts 客户端脚本 | 不适用（移动端客户端脚本） |
| `winget-manifest/`、`LICENSES/`、`.vscode/`、`scratch/`（空） | 包清单、第三方许可、编辑器配置 | 不适用（与运行形态无关；`scratch/` 为空目录） |
| 根目录 `AGENTS.md` / `CLAUDE.md` / `LICENSE` / `Changes.md` / `README.md` | 仓库约定与变更史 | 已读：`Changes.md` 最新为 `v3.2.1`（与 `VersionPrefix=3.2.0` 不一致，见 §6.4）；`LICENSE` 为 MIT，本仓库已保留版权声明 |

---

## 2. 文件映射总表（范围内 75 个文件）

### 2.1 `SyncClipboard.Server`（8）

| 上游 | 迁移对应物 | 结论 |
|---|---|---|
| `Program.cs` | `wrangler.toml`（绑定/变量/定时）+ `src/index.ts`（`export default.fetch`/`scheduled`） | 等价。上游「环境变量优先、否则配置文件」的凭据选择 → 迁移只用 Cloudflare secrets（**fail-closed**，不保留 `admin/admin` 回退） |
| `appsettings.json` | `wrangler.toml [vars]` + secrets + `src/env.ts` | 等价：`MaxSavedHistoryCount=1000`、`HistoryRetentionMinutes=10080` 数值一致；Kestrel/日志节不适用 |
| `appsettings.Development.json` | `.dev.vars.example` | 等价（都只是本地开发凭据样例） |
| `Dockerfile` / `docker-compose.yml` / `.dockerignore` | 无 / 无 / `.gitignore` | 不适用（托管平台）；`.dockerignore` 的作用由 `.gitignore` 的 `.dev.vars` 规则承担 |
| `README_DOCKER.md` | `README.md` 的部署章节（含 GitHub Actions 方式） | 等价（重写，且新增 CI 路径） |
| `SyncClipboard.Server.csproj` | `package.json` + `tsconfig.json` | 等价（依赖清单/编译目标） |

### 2.2 `SyncClipboard.Server.Core`（33）

| 上游 | 迁移对应物 | 结论 |
|---|---|---|
| `Web.cs` | `src/index.ts`（中间件链、路由装配）+ `src/hub.ts`（negotiate/转发） | 等价。上游 `AddSignalR()` 默认值（KeepAlive 15s / ClientTimeout 30s / 传输宣告顺序）逐项对齐；`MaxRequestBodySize=int.MaxValue` → 迁移 **32 MiB** + 413（已登记，安全收紧） |
| `BasicAuthenticationHandler.cs` | `src/auth.ts` | 等价 + 增强（常量时间比较、失败限速、弱凭据告警、未配置 fail-closed）；畸形头上游 500 / 迁移 401（已登记） |
| `CredentialChecker/{I,Static,File}CredentialChecker.cs` | `src/auth.ts#verifyCredentials` + `env.USERNAME/PASSWORD` | 等价（三文件合并为一，**默认口令回退被有意去掉**） |
| `Constants/SignalRConstants.cs` | `src/hub.ts#HUB_PATH` | 等价（`/SyncClipboardHub` 逐字） |
| `Controllers/SyncClipboardController.cs` | `src/routes/webdav.ts` + `src/index.ts`（`/api/time`、`/api/version`） | 等价：18 个返回点全覆盖（含 3 个降级出口、`InvalidFileName`、404 文案）；PROPFIND 200→207 已登记 |
| `Controllers/HistoryController.cs` | `src/routes/history.ts` | 等价：全部返回点覆盖；**本轮修掉媒体类型 415 与 urlencoded 缺口（§4.1）** |
| `Models/AppSettings.cs` | `src/env.ts` + `wrangler.toml` | 等价（默认值一致） |
| `Models/HistoryQueryDto.cs` | `src/types.ts#HistoryQueryDto` | 等价（含 `Types` 位掩码、`SortByLastAccessed`） |
| `Models/HistoryRecordDto.cs` | `src/types.ts` + `src/serialization.ts` | 等价（`HasData` 推导、`Stared`→`starred`、ISO 时间） |
| `Models/HistoryRecordEntity.cs` | `src/types.ts#HistoryRecordEntity` + `schema.sql` | 等价（列集合无缺项）。**保留列** `TransferDataSha256`/`TransferDataMd5`/`From`/`Tags`/`ExtraData` 两侧都只建列、从不写入（上游仅 `Mapper.cs:22` 显式置 `ExtraData = null`）⇒ 无行为差异 |
| `Models/HistoryRecordUpdateDto.cs` | `src/types.ts#HistoryRecordUpdateDto` | 等价（`isDelete` 拼写、`int?` 校验 → 400） |
| `Models/HistoryStatisticsDto.cs` | `src/types.ts` + `src/serialization.ts#historySizeMB` | 等价（**含「非零但不足 0.01MB 显示 0.01」这条上游口径**） |
| `Models/Mapper.cs` | `src/serialization.ts`（`entityToDto`/`entityToDtoWire`） | 等价 |
| `Models/HistoryRecordCreateDto.cs` | 无 | **上游死代码**：全仓除自身定义外零引用 |
| `Attributes/DisableFormValueModelBindingAttribute.cs` | 无同类 | 等价：上游用它避开框架的流式绑定，迁移本来就"全量读入后自解析"（内存代价已登记） |
| `Exceptions/HistoryTransferDataException.cs` | `src/profile.ts#ProfileDataInvalidError` | 等价（→ 422 `history_data_invalid` + ProblemDetails 四字段） |
| `Services/ServerProfileEnvProvider(.Extension).cs` | `src/storage.ts` 的 key 布局（`file/`、`history/{Type}_{hash}/`） | 等价（`GetHistoryPersistentDir` 与 `GetPersistentDir` 上游同值） |
| `Services/History/HistoryService.cs`（605 行） | `src/profile.ts` + `src/db.ts` + `src/historyOps.ts` | 等价（逐方法核对，见 §3.2；差异见 §4.3） |
| `Services/History/HistoryCleaner.cs` | `src/cleanup.ts` | 等价语义，周期/批次不同（已登记：CF 子请求预算） |
| `Utilities/History/HistoryDbContext.cs` + `Migrations/*` | `schema.sql` + `src/db.ts` | 等价（列无缺）；**时间列类型与索引集不同 → 本轮补索引** |
| `Utilities/History/HistoryHelper.cs` | `src/db.ts#shouldUpdate` | **逐字等价**（阈值 5 分钟；阈值内比 Version、阈值外比 LastModified） |
| `Utilities/MigrationHelper.cs` | `schema.sql`（幂等）+ CI 的 `d1 execute` | 等价；`CLEAR_SQLITE_LOCK`/`__EFMigrationsLock` 在 D1 上不适用 |
| `Swagger/*` | 无（界面「部署信息/维护面板」替代诊断面） | 不适用/有意偏离 |

### 2.3 `SyncClipboard.Shared`（34）

| 上游 | 迁移对应物 | 结论 |
|---|---|---|
| `ProfileDto.cs` | `src/types.ts` + `serialization.ts` | **逐字等价**（`[JsonConverter(JsonStringEnumConverter)]` 对 type、`WhenWritingNull` 只加在 Size、`DataName` 为 null 时保留键） |
| `SyncClipboardProperty.cs` | `wrangler.toml` 的 `VERSION` | **逐字等价**（2026-09-15 对齐后：上游取自 Shared 程序集的 `AssemblyInformationalVersion` ⇒ 基线实际值的 `3.2.0`，本仓库 `VERSION = "3.2.0"`；见 §4.2 U5） |
| `Profiles/Profile.cs` | `src/profile.ts` + `src/types.ts` | 等价（`GetWorkingDirName` 分隔符约束、`ParseProfileId`、`Create` 的类型提升） |
| `Profiles/TextProfile.cs` | `src/profile.ts`（PUT/POST 两条路径分开复刻） | 等价（哈希按文件字节、Size 口径、`NeedsTransferData` 判定） |
| `Profiles/FileProfile.cs` | `src/hash.ts#fileProfileHash` + `profile.ts` | **逐字节等价** |
| `Profiles/ImageProfile.cs` | `src/profile.ts`（提升规则 + 同一套哈希） | 等价 |
| `Profiles/GroupProfile.cs`（853 行） | `src/hash.ts#parseGroupZip/groupHashFromEntries` | 哈希/排序/NUL 行格式/隐式父目录/顶层条目**逐项等价**；上限与 `.` 段/重复条目差异见 §4.3 |
| `Profiles/{GroupEntry,ProfileType,ProfileTypeFilter,IProfileEnv,LocalProfileDataUnavailableException,UnknownProfile,Models/*}.cs` | `src/types.ts` + `src/hash.ts` + `src/profile.ts` | 等价或服务端不需要（`UnknownProfile` 服务端不构造；`ClipboardProfileDTO` 上游自身已 `[Obsolete]` 且抛异常） |
| `Utilities/ByteArrayComparer.cs` | `src/hash.ts#compareBytes` | 等价（无符号逐字节 + 短者在前） |
| `Utilities/Utility.cs` | `src/profile.ts`（`CreateTimeBasedFileName` 等价形状）+ `hash.ts` | 等价（时间戳 + 8.3 随机段、字母表 a-z0-9） |
| `Utilities/HistoryManagerHelper.cs` | `src/cleanup.ts` 的分批/判定 | 等价语义；差异见 §4.3（上游 batch 500 / 无上限循环 vs 迁移 200 / 预算+游标） |
| `Utilities/{FileSys,ImageTool,FileFilterHelper,IEnumerableExtention,ScopeGuard,IHistoryEntityRepository,Models/FileFilter*}.cs` | 无 / `src/hash.ts` 的部分逻辑 | 不适用或不参与服务端哈希（`FileFilterConfig` 在服务端恒为默认实例） |
| `ClipboardProfileDTO.cs` / `IClipboardImage.cs` / `IClipboardMoniter.cs` / `ServerPara.cs` / `Attributes/ConfigKeyAttribute.cs` / `Interfaces/IConfigValidator.cs` / `Models/DateTimePropertyHelper.cs` | 无 | 不适用（客户端 UI/配置/平台接口；`ServerPara` 只用于进程内嵌服务器） |

---

## 3. 行为等价性逐项核对（不只对接口名）

### 3.1 HTTP 协议面

- **返回点覆盖**：两个控制器共 18 个 action、约 45 个返回点，迁移全部有对应分支；上游唯一"缺失"的
  `GET /api/history/{type}` 在上游自身被整块注释（`HistoryController.cs:70-75`）。
- **状态码/文案**：400/404/409/422/415 与 `"Hash is not match data."`、`"Needs tranfer data."`、
  `"after must be less than before"`、`"Invalid profileId format. Expected format: 'Type-Hash'"`、
  `"DataName cannot be null or empty when HasData is true"`、`"Transfer data file not found"` 逐条对上。
- **模型绑定语义**：`int.TryParse`/`long.TryParse`/`bool.TryParse`/`Enum.TryParse` 的"整体合法、失败取默认"
  与 `[ApiController]` 的"绑定失败即 400"两条都复刻（`src/routes/history.ts` 与 `src/serialization.ts`）。
- **响应头**：`WWW-Authenticate: Basic realm="SyncClipboard"` 逐字；附件 `Content-Type` 与
  `Content-Disposition` 的差异属已登记的安全加固。
- **客户端侧交叉验证**（读上游客户端源码确认服务端契约）：`OfficialAdapter` 把 profile/文件传输**委托给
  `WebDavAdapter`** ⇒ 官方服务器上真实使用的 WebDAV 面是 `PROPFIND /`（`Test()`）、`MKCOL file`、
  `PROPFIND file/`（`DirectoryExist`，恒加尾斜杠）、`DELETE file/`（`DirectoryDelete`）——迁移用 Hono
  `strict:false` 对齐；`GetVersionAsync` 读到 404 才视作"无 profile"，`SetCurrentProfile` 把 404 映射为
  `RemoteHistoryNotFoundException` ⇒ 迁移的 404 语义正确。

### 3.2 数据与状态流转

- `ShouldUpdate` 逐字等价（含阈值与两个比较分支）。
- 软删/硬删/广播/删数据目录的**触发点与顺序**一致：软删 → 广播 `RemoteHistoryChanged` + 删数据目录；
  硬删不广播；`MarkForDeletion` 后 `Version++`、`LastModified=now`。
- `Update`（PATCH）：`dto.Version ??= existing.Version + 1`、`dto.LastModified ??= UtcNow`、
  判定失败 → 409 回服务器当前值、`IsDelete=false` 且已删且有数据文件 → 404 —— **逐条一致**。
- `AddRecordDto`（POST）：既有记录分支只拷元数据（`UpdateEntityFields` 只含 CreateTime/LastAccessed/
  LastModified/Stared/Pinned/Version/IsDeleted）；新增分支 `IsLocalDataValid(true)` 失败 → 400。
- `AddProfile`（PUT 复用/复活分支）：上游只覆盖 `LastAccessed/IsDeleted/LastModified/TransferDataFile/FilePaths`
  —— 迁移额外覆盖了 `Text/Size`，**判定为低风险偏差并保留**（理由见 §4.3）。

### 3.3 哈希 / 体积 / 命名

四种 Profile 的哈希公式、排序比较器、NUL 结尾行格式、隐式父目录、`TrimEnd('/')` 顶层判定、
`CreateTimeBasedFileName` 形状、`GetWorkingDirName` 的字符约束**逐项等价**（对照表见
`test/hash.test.ts` 的用例与 §4.3 的差异项）。`Size` 在 PUT/POST 两条路径上的不同口径也都复刻。

### 3.4 清理与保留

保留期四条件（`!IsDeleted && !Stared && !Pinned && LastModified<cutoff && LastAccessed<cutoff`）、
`MAX(LastModified,LastAccessed)` 排序、条数上限排除收藏/置顶、30 天硬删、孤儿目录差集 —— 全部等价。
软删单批现为 **500 条（与上游一致）**；周期是 **20 分钟 vs 上游的 10 分钟**，差异只在"积压收敛速度"
（本实现另有平台单次调用的子请求预算与游标续跑机制，见 `design.md` §9）。实测（本地 miniflare，
真实 Cron 触发）：300 条过期记录与 500 条超量都在**一轮内**处理完，单轮子请求 508/800。

### 3.5 鉴权与实时

Hub 路径、广播方法名与参数形状（`RemoteProfileChanged` / `RemoteHistoryChanged` 单参数）、
传输宣告顺序与格式表、KeepAlive 15s、长轮询挂起 < 客户端 100s 超时 —— 等价。上游 Hub 类没有
客户端可调用的 RPC（纯推送），迁移同样无；`OnConnectedAsync/OnDisconnectedAsync` 上游未使用，
故不构成缺失。

### 3.6 配置 / 构建 / 部署

配置键与默认值见 §2.1。上游服务端的发布链路是 `dotnet publish` → zip + Docker 镜像
（`.github/workflows/server-build.yml`、`server-release.yml`），**链路里没有任何测试门禁**；本仓库的
等价物是 GitHub Actions 的 `quality`（typecheck + lint + 全部套件，自起 miniflare）→ `needs: quality` 才
`deploy`，属**更强**的一侧。部署链路的三个真实缺口见 §4.2（CI 不创建资源、DO 迁移步骤、冒烟断言过弱）。

### 3.7 上游自带文档的交叉核对（第三份独立证据）

| 上游文档 | 核对结果 |
|---|---|
| `docs/Hash.md` | **与实现一致，也与迁移实现一致**：Text = UTF-8 SHA256；File/Image = `SHA256(UTF8("文件名\|" + 大写(内容哈希)))`；Group = 条目按 EntryName 的 **UTF-8 字节字典序**升序，拼 `D\|{name}\0` / `F\|{name}\|{length}\|{contentHash}\0` 后再 SHA256。文档里的示例（`D\|folder/` → `F\|folder/a.txt\|100\|…` → `D\|folder/subdir/` → `F\|folder/subdir/b.txt\|200\|…`）恰好验证了迁移实现的「隐式父目录计入 + 目录条目前缀」两条推导规则。另："Hash 实际使用时大小写不敏感"与迁移的 `LOWER(Hash)=LOWER(?)` 一致 |
| `docs/README_EN.md` 的 API 章节 | 与迁移实现一致：`GET/PUT SyncClipboard.json`、`GET/PUT /file/dataName`、ProfileDto 字段语义（`dataName` 在 `hasData` 为真时必填、File/Image/Group 恒 `hasData=true`、`text` 是预览/全文、`size` 是文件字节数或 Text 完整串长度）、"不要在 url 结尾带 `/`"。**一处上游文档与实现不符**：文档写「All API fields are case-sensitive」，而 ASP.NET 的 `JsonSerializerOptions.Web` 默认 `PropertyNameCaseInsensitive=true`（multipart 侧更是显式 `StringComparer.OrdinalIgnoreCase`）⇒ 实际不区分大小写，迁移的宽松解析才与行为一致 |
| `docs/ai_design/Issue-408-Missing-Group-Data-Retry-Design.md`（上游**最新一轮**的设计文档） | 它把服务端契约写死为：**无效 Group 归档/哈希不符 → 可识别的 422 + 响应无堆栈 + 不创建 DB 记录 + 不残留上传文件或解压目录**。迁移逐条满足：`parseGroupZip`／`fileProfileHash` 都在 `storage.putHistory` **之前**抛出，失败路径不写 R2、不入库（测试守着：`test/protocol.test.ts:184`、`test/fix-regressions.test.ts:145`、`test/limits.test.ts:247`「且不写入任何对象」）；422 体是 ProblemDetails（无堆栈）。本迁移用对象存储、没有"解压目录"这一概念，故该条天然满足 |

---

## 4. 差异与修复清单

### 4.1 本轮**已修复**（代码改动 + 测试）

| # | 差异 | 上游证据 | 修复 | 验证 |
|---|---|---|---|---|
| P1 | `POST /api/history` 收到非 multipart 时返回 400，上游返回 **415**（`[Consumes("multipart/form-data")]`，在模型绑定之前拒绝） | `HistoryController.cs:121` | `src/routes/history.ts` 新增 `parseFormBody(c, false)`：媒体类型判定 → 415，并在提前返回前排空请求体 | `test/protocol.test.ts` 新增 3 例（415 / 缺 boundary→400 / 415 后本 isolate 仍健康） |
| P2 | `POST /api/history/query` 只接受 multipart；上游 `[FromForm]` 同时接受 `application/x-www-form-urlencoded` | `HistoryController.cs:81` | 新增 `allowUrlEncoded` 分支（`URLSearchParams` → 同一套 `MultipartResult` 取值语义，字段名大小写不敏感） | 2 例（urlencoded 且断言 `SearchText` 真被解析；非法 `Page` → 400） |
| P3 | `schema.sql` 缺上游为「收藏 + 时间/类型 + 翻页」建的复合索引 | `HistoryDbContext.cs:40-52`、`Migrations/20251105014242_Init.cs:50-58` | 补 `idx_h_user_stared_create`、`idx_h_user_stared_type_create`（上游第三个 `(UserId,CreateTime,ID)` 无需单建：SQLite 索引条目隐含 rowid，而 `ID` 即 rowid 别名） | `wrangler d1 execute --local --file=./schema.sql` 成功；全量套件复跑通过 |
| P4 | README 把客户端 10 秒探活写成「一次 `/api/version`」⇒ 单客户端 8.6k 请求/天 | `OfficialAdapter.cs:144-170` + `WebDavBase.cs:271-282`：`TestConnectionAsync` 先 `PROPFIND /` 再 `GET /api/version`，**每次探活两个请求** | 改为 **17.3k 请求/天**、免费版可支撑 **≤5 个客户端**，并写清漏算的那一半 | 源码逐行核对；`progress.md` §10 的旧数字以订正注记保留（见 §39） |
| P5 | `docs/protocol.md` §10 未登记本轮新核实的 8 类差异 | —— | 补 10 行（415、urlencoded、非表单媒体类型、畸形 Basic 头、hash 匹配方式、时间列存储形态、索引集合、Group `.` 段/重复条目、落库大小写），并在 §3.4/§5.1 加上交叉引用 | 文档自检：`test/docs.test.ts` 通过 |

### 4.2 未修复但已分级（不阻断上线，需要部署侧注意）

| # | 项 | 级别 | 说明与处置 |
|---|---|---|---|
| U1 | CI 不创建 D1/R2 资源 | 中 | `deploy.yml` 只 `d1 execute` 已存在的库；全新账号首次部署必须照 README 手工 `d1 create`/`r2 bucket create`。写进 README 已有，但 CI 不会给出可诊断的提示 |
| U2 | 冒烟检查只断言未认证请求 = 401 | 中 | 能间接发现「凭据未配置」（那种情况返回 500），但**不能**证明凭据可用、历史读写打通。建议后续加一步带凭据的 `/api/history/statistics` |
| U3 | ~~本地 `compatibility_date` 与生产不一致~~ → **已修复（2026-09-15）** | 低-中 | 原状：`wrangler.toml` 写 `2025-09-01`，而仓库锁定的 `wrangler ^3.80`（3.114.17）本地运行时最高支持 `2025-07-18` ⇒ 本地/CI 与生产跑在不同 compat date 上。**处置**：wrangler 升到 **4.131.2**（连带 `@cloudflare/workers-types` 4 → 5，wrangler 4 的 peer 要求），本地起 dev server 不再 fallback、CI 质量门与部署工具链同为 v4；全量 20 套件 / 325 例在新运行时下复跑通过 |
| U4 | ~~无日志级别配置~~ → **已处理（2026-09-15）** | 低 | 上游 `Logging:LogLevel` 在 Workers 上没有等价物（console 即日志流）。**处置**：`wrangler.toml` 显式声明 `[observability] enabled = true`（不依赖"新建 Worker 默认已开"这一会变的默认），README 新增「日志与排障」写清查询方式、7 天保留、日志前缀表与隐私口径（见 `progress.md` §42） |
| U5 | ~~版本事实源三处不同~~ → **已修复（2026-09-15）** | 低 | 原状：上游 `VersionPrefix=3.2.0`、`Changes.md` 最新条目 `v3.2.1`、本仓库 `VERSION=3.2.1`。**处置**：`VERSION` 改为 **`3.2.0`**，与上游基线编译后真实返回值逐字一致（用户决定，理由与跟版规则见 `progress.md` §43、`protocol.md` §10、`design.md` §10）。两套编号的语义已在 README 写清：`VERSION` = 对外自我描述，`package.json` 版本 = 迁移项目自身版本 |

### 4.3 有意偏离（已在 §10 登记，**本轮不修**）

| 项 | 理由 |
|---|---|
| Worker 请求体上限 32 MiB（上游无上限） | 安全收紧；isolate 只有 128MB 内存，放行接近平台上限的体会解析期 OOM |
| Group zip 解压上限（总量 64MiB / 条目 1000 / 压缩比 100:1） | 上游可在哈希校验前付出全量解压代价（已作为上游 Issue 5 提出）。**代价**：含 1000+ 文件的合法文件夹会被拒 → 属已知限制 |
| 清理周期（每小时 vs 10min/12h）与批次（200/1000 vs 500） | CF 单次调用子请求上限（800 预算 + 阶段保底 + 游标续跑） |
| 保留策略在线可调（Meta 覆盖） | 上游只能改配置文件重启；本实现只加不减语义 |
| `clear` 不逐条广播 | 上游广播触发点清单不含 clear；逐条广播会超子请求上限 |
| 协议侧忽略 `Range`，UI 数据端点支持 206 | 对齐上游 `EnableRangeProcessing=false`；界面另开一层 |
| PROPFIND 200 空体 → 207 multistatus；新增 `DELETE /file/{name}` | 上游的空体在 `PreciseDelete` 下会让客户端 `LoadXml` 抛异常 |
| 附件响应头加固（nosniff/CSP/attachment） | 存储型 XSS 面；客户端不读这些头 |
| 单条 PATCH 的 `hash` 含分隔符 → 400；时间字段解析失败 → 忽略 | 前者把上游的未捕获异常变成可诊断的 400；后者避免客户端整轮同步失败 |
| hash 落库统一大写 | 避免 Linux 上同内容产生两个工作目录 |
| Group `.` 段条目名一律拒；重复条目去重 | fail-loud 优于平台相关归一化；官方客户端不可达（差异后果已写进 §10） |

### 4.4 复核后**判定不需要修**的候选

| 候选 | 结论 |
|---|---|
| 列表排序缺 `ThenByDescending(ID)`（子代理提出为"高"） | **不成立**：迁移是 `ORDER BY sortCol DESC, ID DESC`，与上游 `OrderByDescending(...).ThenByDescending(ID)` 完全一致 |
| 硬删记录时无条件删数据目录（子代理提出为"中高"） | **不成立**：上游 `DeleteProfileDataIfNeed(force:false)` 只在 `IsDeleted == false` 时早退，而硬删的候选集本身恒为已删记录 ⇒ 上游同样会删目录 |
| `MarkForDeletionAsync` 的 detached 分支"设了字段却不保存" | **不成立**：该分支改的是 `Query()` 取回的**被跟踪实体**，保存由 `HistoryManagerHelper` 显式 `SaveChangesAsync()` 负责 |
| `Web.cs` 未设 `DefaultChallengeScheme` ⇒ 401 变 500 | **驳回**（框架回退链 `DefaultChallengeScheme ?? DefaultScheme`，`AddAuthentication("BasicAuthentication")` 设的正是 `DefaultScheme`）。未实测，故按"不主张"处理，不写入 upstream-issues |
| `README_DOCKER.md` 的挂载路径 `/app/appsettings.json` 与 `--contentRoot /app/data` 不符 | **驳回**：`Program.cs:48-74` 正好从 `/app`（`AppContext.BaseDirectory`）把该文件复制到 `/app/data/` 并显式 `AddJsonFile` ⇒ 文档给的挂载点生效 |
| `dto.Version` 为 null 会 NRE | **不成立**：`HistoryService.cs:50-51` 有 `??=` 兜底 |

---

## 5. 风险分级汇总

**阻断上线：无。**

| 级别 | 项 |
|---|---|
| 中 | U1（新环境首次部署靠手工建资源）、U2（冒烟断言弱）、清理周期/批次与上游不同（已登记，饱和积压下收敛更慢） |
| 低-中 | U3（本地 compat date fallback）、畸形 Basic 头状态码类别不同（5xx/4xx，第三方客户端可能误判） |
| 低 | U4/U5、`mergeExistingProfile` 额外覆盖 Text/Size、hash 匹配从 `LIKE` 收紧为等值、`POST /api/history/query` 对非表单体回 400（上游按空表单处理）、Group `.` 段与重复条目语义差异 |
| 需人工确认 | §6 全部条目 |

---

## 6. 仍需人工确认（本环境无法验证）

1. ~~**框架级行为**：negotiate 的"版本 >1 钳为 1 / 出错仍回 200 / `connectionToken` 仅版本 >0 出现"、
   客户端 `{"type":7}` 后服务端是否回 Close 帧、`[FromForm]` 对非表单体是否等价于空表单——未能实测。~~
   → **大部分已实测（2026-09-15，见 `progress.md` §44）**。做法：本机**有** ASP.NET Core 8 运行时
   （只是没有 SDK），而官方 v3.2.0 release 附了框架依赖型的 `SyncClipboard.Server.zip` ⇒ 直接起官方服务端
   对跑，工具固化为 `tools/ab-upstream-probe.ps1`（**34** 例状态码级 + 18 例 negotiate 文本级；
   其中 3 条大小写用例在 2026-09-15 修复后由「已知偏离」转为「一致」，见 §44.7）。
   实测结论：negotiate 的**钳制为 1**、**出错仍回 200**、**`connectionToken` 仅版本 >0 出现**、**错误串逐字**
   全部一致（并修掉两处真缺陷，见 §44.4）；`[FromForm]` 对非表单体**等价于空表单**（上游 200 + 默认第 1 页）。
   **仍未实测的只剩**：客户端发 `{"type":7}`（Close）后服务端是否回 Close 帧——探针停在 HTTP 层，未做
   WebSocket 帧级捕获。
2. ~~**上游客户端 E2E**：本机没有 Windows 官方客户端可用……~~
   → **已实测（2026-09-15，见 `progress.md` §44.5）**：本机 `_tmpclient2` 就是**官方 v3.2.0 便携客户端**
   （self-contained `net9.0`），其配置指向我们的生产 worker。真客户端 × 生产的双向验证全部通过：
   文本（客户端→服务端 hash == SHA256(text)；服务端→客户端 **1.5 s** 内改写剪贴板，日志出现 `[EVENT]`
   实时推送）、文件（上传后从服务端回下载**字节一致**；服务端推送的文件被落盘并设为剪贴板文件）、
   以及 **File hash 规则与真客户端逐字相同**。1.20.0 那两处改动（415/urlencoded）也确实落在客户端不走的路径上。
3. **上游 `HistoryRecordCreateDto`**：全仓零引用，但可能是给未来/外部（如 SDK）用的公共模型；判为死代码
   只是"当前仓库内"的结论。
4. ~~**版本号语义**：迁移对外报 `3.2.1`，而按上游 `VersionPrefix` 编译出的真实服务端会报 `3.2.0`。~~
   → **已决（2026-09-15）**：用户选择**逐字对齐上游**，`VERSION` 改为 `3.2.0`（见 §4.2 U5、
   `protocol.md` §10）。附带结论：该值**没有功能后果**——客户端下限是 `3.1.1`，且
   `AppVersion.TryParse` 失败时版本检查被静默跳过（`OfficialAdapter.cs:151-160` 的 `if` 无 `else`）；
   改的是自我描述的真实性。另需注意上游基线的"自我描述滞后"现象：基线在 `v3.2.0` 标签之后 14 个提交
   （含服务端提交 `#402` 保留期自动删除、`#412` 完整性检查），但版本号仍写 `3.2.0`。

---

## 7. 验证证据与上线结论

**验证方式**：`wrangler dev --test-scheduled`（本地 miniflare，128MB isolate、D1/R2/DO 全部模拟）
+ 全量套件（含 HTTP 黑盒、真 SignalR 客户端三传输、清理 Cron 真触发、界面 API 与契约守卫）。
+ **真上游 A/B**（`tools/ab-upstream-probe.ps1` × 官方 v3.2.0 服务端发布件，34 例状态码级 + 18 例文本级）
+ **真客户端 E2E**（官方 v3.2.0 便携客户端 × 生产：双向文本/文件 + 实时推送）——两类证据的完整记录见
+`progress.md` §44。

**结果**：`20` 个套件全绿、**324 例通过**（本轮新增 5 例：415 ×3、urlencoded ×2）；
`npm run check`（`tsc --noEmit` + `eslint`）通过；`wrangler d1 execute --local --file=./schema.sql`
（含新索引）幂等执行成功；文档口径守卫（`test/docs.test.ts`）与前端契约守卫（`test/ui-contract.test.ts`）通过。

**一次测试波动（如实记录）**：`test/signalr.test.ts` 的「心跳跨过客户端 ServerTimeout」用例
（真实时钟等待 35 秒）在与另一条 shell 命令并发执行时失败过一次（`expect(closed).toBeUndefined()`），
单独复跑与随后一次**空载全量复跑**均通过。该用例依赖真实时钟与 DO alarm，机器负载会直接影响它；
本轮未改动 Hub/DO 代码，CI 单独运行该套件时不受影响。

**结论**：

- **协议层完整、行为等价**：上游服务端 18 个 action / 约 45 个返回点全部覆盖，差异项**要么已在本轮修复**，
  **要么是已在 `docs/protocol.md` §10 逐条登记的有意偏离**（安全加固、平台约束、fail-loud 取舍）。
- **未发现阻断上线的等价性缺口**；本轮修掉的两处（415、urlencoded）都是"上游有、迁移没有"的真实契约差异。
- **可上线的边界**：① 部署前需手工创建 D1/R2（U1）；② 生产与本地 compat date 不同（U3，建议升 wrangler 4）；
  ③ §6 的框架级行为未实测 —— 它们都是**上游自身的框架行为**，本迁移的实现依据是"官方客户端 + 框架文档语义"，
  在真实客户端 E2E 之前保留为待确认项。
- 本轮**未修改上游任何文件**；上游自身缺陷记录在 [`upstream-issues.md`](upstream-issues.md)（新增 Issue 8–13）。
