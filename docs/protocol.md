# SyncClipboard CfServer — 协议契约

> 本文件是对上游官方服务器行为**逐条核对源码后**整理的兼容性契约，是开发的唯一权威依据。
> 上游核对锚点：`github.com/Jeric-X/SyncClipboard`，分支 `master`，提交 `28c7e596`（2026-09-12）。
> 若上游行为变更，先更新本文件再改代码。
> 源码位置标注为 `上游:<文件>:<行>`，便于开发时对照。

## 1. 鉴权

**所有端点**（含 `/api/time`、`/api/version`、SignalR negotiate 与 WebSocket 升级）要求 HTTP Basic Auth。
官方实现为控制器/hub 类级 `[Authorize]` + 默认策略 `RequireAuthenticatedUser`。
客户端 `OfficialAdapter` 对每个 HTTP 请求与 SignalR 连接头都携带 `Authorization: Basic base64(user:pass)`。
凭据校验失败返回 401（`BasicAuthenticationHandler`）。

## 2. JSON 序列化约定

- 属性名 **camelCase**（客户端用 `JsonSerializerOptions.Web` 读写；服务端 ASP.NET 默认 camelCase）。
- 枚举输出**字符串**（`ProfileType`：`Text|File|Image|Group|Unknown|None`）。
- `ProfileDto.Size` 为 null 时**省略**（上游 `WhenWritingNull`）；`DataName` 无 `WhenWritingNull` → 为 null 时**输出** `"dataName":null`。
- **Text 大文本（>10240 字符）**：上游 `TextProfile.TRANSFER_DATA_THRESHOLD = 10240` → `Text` 字段为**前 10240 字符截断前缀**，全文走传输数据文件；`HasData=true`、`Size = 全文字符数`（非字节数）、`Hash = SHA256hex(UTF-8 全文)`。
- 时间输出 ISO8601；C# 服务端输出 `DateTimeOffset`（UTC，`+00:00`），JS 端输出 `toISOString()`（`Z`）等价，客户端均可解析。
- 客户端解析大小写不敏感（`PropertyNameCaseInsensitive=true`），但本服务器按 camelCase 精确输出。

## 3. DTO 定义

### 3.1 ProfileDto（`上游:Shared/ProfileDto.cs`）

```jsonc
{
  "type": "Text",          // ProfileType 字符串
  "hash": "…",             // 十六进制大写 SHA-256（可为空串）
  "text": "…",             // Text=内容；File/Image=文件名；Group=路径列表(\r\n 分隔)
  "hasData": false,
  "dataName": null,        // null 时保留字段
  "size": 123              // null 时省略
}
```

### 3.2 HistoryRecordDto（`上游:Server.Core/Models/HistoryRecordDto.cs`）

```jsonc
{
  "hash": "…",
  "text": "…",
  "type": "Text",
  "createTime": "2026-09-12T05:00:00.000Z",
  "lastModified": "…",
  "lastAccessed": "…",
  "starred": false,
  "pinned": false,
  "size": 0,
  "hasData": false,        // = FilePaths 非空 或 TransferDataFile 非空
  "version": 0,
  "isDeleted": false
}
```

### 3.3 HistoryRecordUpdateDto（`上游:Server.Core/Models/HistoryRecordUpdateDto.cs`）

```jsonc
{ "starred": true, "pinned": false, "isDelete": false,
  "version": 3, "lastModified": "…", "lastAccessed": "…" }
```

注意 `IsDelete` 的 camelCase 是 **`isDelete`**（不是 isDeleted）。409 响应体即此结构（服务器当前值）。

### 3.4 HistoryQueryDto（multipart 表单字段，`上游:…/HistoryQueryDto.cs`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| Page | int | 1 | 从 1 起，页大小固定 50 |
| Before | DateTime(UTC) | null | `CreateTime/LastAccessed < before`（按排序字段） |
| After | DateTime(UTC) | null | `CreateTime/LastAccessed >= after`（按排序字段） |
| ModifiedAfter | DateTime(UTC) | null | `LastModified >= modifiedAfter` |
| Types | ProfileTypeFilter | All | 位掩码名：`None|Text|File|Image|Group|FileAndGroup|All`，逗号组合（`Text,File`）；**也接受数字**（`"5"` = Text\|Image）。非法名 → 400 |
| SearchText | string | null | `LIKE %text%`（对 Text 字段） |
| Starred | bool | null | 空串视为无过滤；非 true/false → 400 |
| SortByLastAccessed | bool | false | true 时按 LastAccessed 排序/过滤，否则按 CreateTime；非 true/false → 400 |

客户端总是发送全部字段（空值发空串）；解析须**大小写不敏感**。字段名 PascalCase（`Page`、`SortByLastAccessed` 等）。

**模型绑定失败 → 400**（对齐上游 `[ApiController]`）：`Page` 非 C# `int.TryParse` 可接受的形式
（含超 int32 范围）→ 400；`Types`/`Starred`/`SortByLastAccessed` 非法值 → 400。
`Types` 的取值与 `Enum.TryParse<ProfileTypeFilter>` 一致：枚举名（大小写不敏感）、逗号组合、**或数字**；
数字与名称混用（如 `Text,5`）解析失败 → 400。`Page < 1` 由控制器钳为 1（非 400）。
**时间字段是例外**：`Before`/`After`/`ModifiedAfter` 解析不了时本实现**忽略该项**而非 400（有意偏离，
理由与影响见 §10 的「query 的时间字段无法解析」一行）。
媒体类型不在上面这套绑定语义内：`POST /api/history/query` 只受 `[FromForm]` 约束，没有 `[Consumes]`，
故 multipart 与 `application/x-www-form-urlencoded` 都接受（见 §5.1 末）。

### 3.5 HistoryStatisticsDto

```jsonc
{ "totalCount": 0, "starredCount": 0, "deletedCount": 0, "activeCount": 0, "totalFileSizeMB": 0.0 }
```

## 4. WebDAV 兼容端点（`上游:Server.Core/Controllers/SyncClipboardController.cs`）

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/SyncClipboard.json` | 返回当前 ProfileDto（camelCase）。**三个降级出口**见 §4.0 |
| PUT | `/SyncClipboard.json` | 见 §4.1。body 为 ProfileDto JSON |
| GET/HEAD | `/file/{fileName}` | 历史查找下载，见 §4.2 |
| PUT | `/file/{fileName}` | 暂存二进制到 `file/{fileName}`（**不校验**），使当前 profile 缓存失效（无缓存实现可忽略）。文件名含 `\`/`/` → 400 |
| DELETE | `/file` | 删除整个暂存区（SafeDeleteFolder 语义） |
| DELETE | `/file/{fileName}` | 删除单个暂存文件 |
| PROPFIND | `/` | **207 multistatus**（列自身）；上游为 200 空体，客户端按 2xx 判定 |
| PROPFIND | `/file` | **207 multistatus**（目录自身 + 暂存对象，`D:href` 逐段 URL 编码）——客户端 `PreciseDelete` 的 `GetFolderSubList` 会 `XmlDocument.LoadXml` 解析，空体会抛异常 |
| MKCOL | `/file` | 200 空体（上游 `Ok()`） |
| GET | `/` | 200 文本 `"Server is running."`；**浏览器导航**（`Accept` 含 `text/html`）→ 302 `/ui/`（附带的 Web 界面入口）。客户端从不 GET 根路径（`Test()` 与 `GetFolderSubList()` 都是 PROPFIND），故该分支不影响协议行为 |

> **非协议路径**：`/ui/*`（静态资源 + `/ui/api/*`）是本实现附带的 Web 界面，**不属于协议契约**——
> 它用会话 Cookie 或 Basic 鉴权（401 不带 `WWW-Authenticate`）、响应形状可随版本调整。
> 对照实现时可以完全忽略它，但不要把它当成客户端依赖的端点。
>
> **路由容错**：ASP.NET 路由忽略尾斜杠，官方客户端 `WebDavBase.AdjustDirectoryUrl` 会给目录 URL
> **强制追加 `/`**（`DELETE file/`、`PROPFIND file/`）。本实现用 Hono `strict:false` 对齐，
> 否则客户端的 `DeletePreviousFilesOnPush` 清理会静默失效、R2 暂存区无限累积。
> 另：`DELETE /file/{fileName}` 为本实现附加端点（上游仅 `DELETE /file`），官方客户端不调用。

### 4.0 GET /SyncClipboard.json 的三个降级出口（`上游:…GetSyncProfile`）

上游先查内存缓存，未命中再读 `server/SyncClipboard.json`，读失败时有两个出口；加上「文件不存在」共三种：

| 情形 | 上游代码路径 | 响应体（wire） |
|---|---|---|
| 文件不存在 | `new TextProfile(string.Empty).ToProfileDto()` | `{"type":"Text","hash":"<SHA256("")>","text":"","hasData":false,"dataName":null,"size":0}` |
| 反序列化**抛错**（`[]`／标量／非法枚举名／非整数数字 type） | `catch` → 同上 | 同上（`size:0` 必现） |
| 反序列化得 **null**（文本为字面 `null`） | `?? new ProfileDto()` | `{"type":"Text","hash":"","text":"","hasData":false,"dataName":null}`（**`size` 键省略**：`Size` 为 `long?` 且 null） |

注意两者的 `hash` 不同：空 `TextProfile` 的 hash 是 `SHA256("")`，而 `new ProfileDto()` 的 `Hash` 是默认空串。
对客户端二者等价（`TextProfile(dto)` 的 `Size` 为 null → `GetSize()` 回落到 `ComputeSize` → 文本长度 0）。

本实现把当前 profile 存在 D1 `Meta` 表（不存在 = 上游「文件不存在」），
并用 `classifyStoredProfile` 复刻另外两个出口的判定，避免把损坏值原样发给客户端
（客户端 `ReadFromJsonAsync` 会抛异常 → 剪贴板同步中断）。

> **当前 profile 与历史记录相互独立**：`Meta.current_profile` 保存的是该 ProfileDto 的**副本**，
> 且**只**由 `PUT /SyncClipboard.json` 的写路径（`saveCurrentProfileJson`）更新；
> 任何删除路径（`PATCH isDelete`、`DELETE /api/history/clear`、清理任务、硬删）**都不触碰它**
> （与上游一致：`ClearAllAsync` 也不动 `SyncClipboard.json`）。
> 推论：**删掉历史记录并不能让当前 profile 停止对外提供该内容** —— 要让客户端不再把某内容当作
> 活动剪贴板，必须再用一次 `PUT /SyncClipboard.json` 覆盖 `Meta`。

### 4.1 PUT /SyncClipboard.json 精确流程

1. body 为 null → 400 `"dto cannot be null"`。
2. `hash` 非空白 → 查历史（`Type + Hash`，忽略大小写，且 **!IsDeleted**）：
   - 命中 → 更新：`LastAccessed = LastModified = now`，`Version++`；广播 `RemoteHistoryChanged(记录 dto)`；
     写当前 profile（用记录 dto）并广播 `RemoteProfileChanged`；返回 200。
   - 未命中 → 进入新建/复活流程（`CreateAndSaveNewProfile`）：
     a. `dto.HasData` 为真且 `DataName` 空 → 400 `"DataName cannot be null or empty when HasData is true"`。
     b. R2 读 `file/{Path.GetFileName(DataName)}`，不存在 → 404 `"Transfer data file not found"`。
     c. 按类型**校验数据哈希**（§8），不符 → 400 `"Hash is not match data."`。
     d. 移入 `history/{Type}_{Hash}/{transferDataName}`（File/Image 用 DataName 原名；Group 用 DataName）。
     c'. **Profile 类型提升**（`Profile.Create(ProfileDto)`）：`dto.Type == File` 且 `DataName` 扩展名属于
        `ImageTool.ImageExtensions`（`.jpg .jpeg .gif .bmp .png`）→ 实际建 `ImageProfile`，
        故「哈希校验 / 落库 / 当前 profile」全部按 **Image** 处理（既有记录查询仍用原始 dto.Type）。
        `webp/heic/avif` **不**在提升表内（那些属于 `ImageHelper.ExImageExtensions`，仅本机转换用）。
     e. 入库（`AddProfile` 语义，**不检查 IsDeleted**）：
        - 已存在（Type+Hash）→ 复活：`IsDeleted=false`、刷新时间、更新 TransferDataFile/FilePaths、`Version++`。
        - 不存在 → 新建：`CreateTime/LastAccessed/LastModified = now`、`Stared/Pinned=false`、`Version=0`、
          `Text`（Text=内容 / File/Image=文件名 / Group=路径列表 \r\n 分隔）、`Size`、`TransferDataFile`。
          `Size` 口径按类型：Text = `dto.Size`（JSON 缺失时回落到**解码后字符数**，对应
          `TextProfile(ProfileDto).Size = dto.Size` 为 null 时的 `ComputeSize`）；
          File/Image = `dto.Size`（缺失时回落实字节数）；Group = 解压后条目长度之和。
        - 广播 `RemoteHistoryChanged(记录 dto)`。
     f. 写当前 profile（该记录 dto）→ 广播 `RemoteProfileChanged(记录 dto)` → 200。
3. `hash` 为空 → 直接走 2 的未命中流程（不查历史）。

> 注意：Text 无数据文件时跳过 b/c/d；`GetSyncProfile` 命中历史后返回的 dto 中 `dataName` 为持久化后的文件名。

### 4.2 GET /file/{fileName} 精确语义（历史查找）

```
按 Path.GetFileName(TransferDataFile) == fileName 过滤历史记录，
取 LastAccessed 倒序第一条且对应 R2 文件存在者；
存在 → 200 二进制（Content-Type 按扩展名推断，未知 application/octet-stream）；
不存在 → 404。
```

> **不要**直接读暂存区 `file/`。这是与官方行为一致的关键点（第三方 WebDAV 客户端也走此路径）。

## 5. 官方 API 端点（`上游:…/HistoryController.cs` + SyncClipboardController）

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/time` | 200，ISO8601 当前时间（UTC） |
| GET | `/api/version` | 200，纯文本版本号（须 ≥ 3.1.1） |
| GET | `/api/history/{profileId}` | `profileId` 格式 `Type-Hash`；解析失败 → 400 `"Invalid profileId format. Expected format: 'Type-Hash'"`；不存在 → 404；成功 → HistoryRecordDto |
| GET | `/api/history/{profileId}/data` | 按记录取数据文件。**profileId 解析失败也返回 404**（上游此端点不自行校验格式，而是 `GetTransferDataFileByProfileId` 返回 null）；无数据 → 404；成功 → 二进制 + `Content-Disposition`（文件名） |
| POST | `/api/history/query` | §3.4 过滤 + 分页，返回 `HistoryRecordDto[]` |
| POST | `/api/history` | multipart 上传，见 §5.1 |
| PATCH | `/api/history/{type}/{hash}` | 部分更新，见 §5.2 |
| GET | `/api/history/statistics` | HistoryStatisticsDto |
| DELETE | `/api/history/clear` | 删除全部记录及其数据文件，返回 `{"deleted": n}` |

### 4.3 HEAD 的映射依据（为何上游只对 `/file/{name}` 支持 HEAD）

上游 `SyncClipboardController` 为同一 action **显式**写了两个特性：

```csharp
[HttpHead("file/{fileName}")]
[HttpGet("file/{fileName}")]
public async Task<IActionResult> GetFileFromFolder(string fileName, CancellationToken token)
```

若 ASP.NET Core 会自动把 HEAD 映射到 GET，这行 `[HttpHead]` 就是多余的 —— 它存在本身即证明**不会**。
另可在路由层源码确认：`HttpMethodMatcherPolicy`（v9.0.9）按 `metadata.HttpMethods` 逐个
`HttpMethods.Equals` 比较，**没有任何 HEAD 特例**（全文不含 `HEAD`/`IsHead`）。

因此上游 `HEAD /`、`HEAD /api/version` 等一律 **405**，而 Hono 会为 GET 路由自动处理 HEAD → 本实现返回 200。
这是宽松超集，客户端不可达（见 §10 差异表）。

### 5.0 hash 的字符约束（`上游:Shared/Profiles/Profile.cs:GetWorkingDirName`）

上游在 key 构造处校验并抛异常：

```csharp
public static string GetWorkingDirName(ProfileType type, string hash)
{
    if (hash.Contains(Path.DirectorySeparatorChar) || hash.Contains(Path.AltDirectorySeparatorChar))
        throw new ArgumentException("Hash contains invalid path characters.", nameof(hash));
    return $"{type}_{hash}";
}
```

本实现的 hash 参与两处**必须同构**的用途：R2 key 的 `history/{Type}_{Hash}/{file}`
与孤儿目录判定（`listHistoryWorkingDirs` 只按**第一个** `/` 截断工作目录名）。
一条 hash = `A/B` 的记录在 DB 侧是工作目录 `Text_A/B`，在 R2 侧却只会被识别为目录 `Text_A/`
—— 两者不同构，会让孤儿清理误删或被绕过。此外客户端本地也以同一规则构造路径，拿到这种 hash 会抛异常。

因此：

| 位置 | 行为 |
|---|---|
| `PUT /SyncClipboard.json`（`hash` 非空时） | 含 `/` 或 `\` → **400** `Hash contains invalid path characters` |
| `POST /api/history`（`hash` 必填） | 同上 → 400 |
| `PATCH /api/history/{type}/{hash}` | 同上 → 400（该路径在删除时会构造 R2 前缀） |
| `GET /SyncClipboard.json` 的存储值 | hash 含分隔符 → 视同损坏，降级为空 TextProfile（见 §4.0） |
| `src/storage.ts` 的 key 构造 | 另有断言兜底：将来新增写路径若漏校验会**快速失败**，而非产生跨目录 key |

官方客户端恒发 SHA256 hex（64 个十六进制字符），永不触发该校验。

### 5.1 POST /api/history（multipart 流式上传）

- 元数据字段（**大小写不敏感**）：`hash`(必填)、`type`(必填，枚举名，None/Unknown → 400)、
  `createTime`、`lastModified`、`lastAccessed`、`starred`、`pinned`、`version`、`isDeleted`、`text`、`size`。
  解析规则（`ParseHistoryRecord`）：时间解析失败 → `UtcNow`；bool/int/long 解析失败 → 默认值。
- `data` 字段：可选二进制文件流。官方客户端**总是把它放在最后**；上游解析到 `data` 即 `break`
  （其后字段被忽略）。本实现解析全部部分后再取值，因此**对字段顺序更宽容**（宽松超集，
  官方客户端行为不受影响；`data` 之前/之后顺序颠倒时本实现仍能成功，上游会因缺 `hash` 而 400）。
  空 `data` 部分（0 字节）仍算「有 data」，与上游「按 part 是否存在决定是否保存数据流」一致。
- **`size` 口径按类型**（上游 `GetSize()` 的落点，易错点）：
  | 类型 | POST /api/history | PUT /SyncClipboard.json |
  |---|---|---|
  | Text | `size` 字段原值（缺失/非法 → **0**，`ParseLong` 语义）——上游 `ProfilePersistentInfo.Size` 是必填 `long`，故**不会**回落到读文件 | `dto.Size`（JSON 缺失时回落为解码后**字符数**） |
  | File/Image | **实际写入字节数**（上游 `FileProfile(ProfilePersistentInfo)` 不设 Size → `ComputeSize` 用 `FileInfo.Length`） | `dto.Size`（缺失时回落实字节数） |
  | Group | 解压后条目长度之和（`totalSize`），**非** zip 体积 | 同左 |
- 服务端生成的传输数据文件名（`Utility.CreateTimeBasedFileName()` 等价）：
  `Text_{yyyy-MM-dd_HH-mm-ss}_{8 随机字符}.{3 随机字符}.txt`、
  `File_{yyyy-MM-dd_HH-mm-ss}_{8 随机字符}.{3 随机字符}.zip`（后者用于 Group 无既有名时）。
  注意随机段**自带一个点**（源 `Path.GetRandomFileName()` 的形状）。
  File/Image 用 `text` 字段作为文件名；已删除记录带 data 复活时**复用记录已有名**（否则记录指向旧名 → /data 404 + 孤儿对象）。
- 处理（`AddRecordDto`）：
  - 记录已存在（Type+Hash）：
    - 若 IsDeleted：有 data → 先写文件并校验；无 data → 校验本地数据有效（无效 → 400 `"Needs tranfer data."`）。
    - `ShouldUpdate(existing, incoming)`（= existing.IsDeleted || §7 规则）为真 →
      `incoming.Version = max(incoming.Version, existing.Version + 1)`；更新字段；广播；若删除标记则删数据文件。
    - 返回服务器当前记录 dto（200）。
  - 记录不存在：
    - 有 data → 写 `history/…` 并校验（`SaveTransferDataAsync`，校验失败 → **422**，见 §8.3；成功后用持久化结果回填实体字段）。
    - 校验本地数据有效（`IsLocalDataValid(true)` 语义，失败 → 400 `"Needs tranfer data."`）。
    - 入库、广播、返回记录 dto（200）。
- 请求体的媒体类型（对齐上游：该 action 有显式 `[Consumes("multipart/form-data")]`）：
  非 `multipart/form-data` → **415**（模型绑定之前就被拒，不是 400）；是 multipart 但缺 boundary → 400。
  `POST /api/history/query`（§5.3）不同：上游只有 `[FromForm]`，故它也接受
  `application/x-www-form-urlencoded`。
- 成功响应：200 + serverDto（客户端只检查状态码，忽略 body）。

### 5.2 PATCH /api/history/{type}/{hash}（`上游:…HistoryService.Update`）

1. 记录不存在 → 404。
2. `dto.Version ??= existing.Version + 1`；`dto.LastModified ??= now`。
3. `ShouldUpdate(oldVersion, newVersion, oldLastModified, newLastModified)`（§7）为假 →
   **409** + `ToUpdateDto(existing)`（服务器当前值）。
4. 为真：
   - 若 `dto.IsDelete == false` 且 existing.IsDeleted 且已有 TransferDataFile → 400/404（`(null, null)` → 404）。
   - 部分字段更新：`starred`、`pinned`、`isDelete`（有值才更新）；`LastModified = dto.LastModified(UTC)`；
     `LastAccessed` 有值才更新；`Version = dto.Version`。
   - 保存 → 广播 `RemoteHistoryChanged(记录 dto)` → 若删除标记则删数据文件 → **200 空体**。

### 5.3 查询过滤细节（`GetListAsync`）

- `after/before` 按排序字段过滤：`SortByLastAccessed=true` 用 `LastAccessed`，否则用 `CreateTime`；
  `after >= before` → 400 `"after must be less than before"`。
- `types`：位掩码与 `(1 << (int)ProfileType)` 逐位测试；无匹配类型 → 返回空数组。
- `searchText`：`LIKE %text%`。
- 排序：`OrderByDescending(排序字段).ThenByDescending(ID)`；分页 `(page-1)*50, 50`。

## 6. SignalR Hub 协议（`上游:Server.Core/Hubs/SyncClipboardHub.cs`）

- Hub 路径：`/SyncClipboardHub`（`SignalRConstants.HubPath`）。hub 无任何服务端方法（纯推送）。
- 客户端方法：`RemoteProfileChanged(ProfileDto)`、`RemoteHistoryChanged(HistoryRecordDto)`。
- 连接流程（.NET 8/9 客户端，JSON 协议）：

```
1. POST /SyncClipboardHub/negotiate?negotiateVersion=1   （带 Basic 头）
   响应 200: {"negotiateVersion":1,"connectionId":"<cid>","connectionToken":"<tok>",
              "availableTransports":[{"transport":"WebSockets","transferFormats":["Text","Binary"]},
                                     {"transport":"ServerSentEvents","transferFormats":["Text"]},
                                     {"transport":"LongPolling","transferFormats":["Text","Binary"]}]}
2. WebSocket 升级: /SyncClipboardHub?id=<tok>   （v1 token 模式；老客户端无 negotiateVersion 时用 connectionId）
3. 客户端 → 服务端: {"protocol":"json","version":1}
   服务端 → 客户端: {}   （空对象 = 握手成功；不支持则 {"error":"…"} 并关闭）
4. 客户端周期发 Ping: {"type":6}   （可忽略，不回）
5. 服务端 → 客户端广播:
   {"type":1,"target":"RemoteProfileChanged","arguments":[{...ProfileDto}]}
   {"type":1,"target":"RemoteHistoryChanged","arguments":[{...HistoryRecordDto}]}
6. 服务端心跳: 每 15s 发 {"type":6}（保持活性 + 清理死连接；可选）
7. 客户端主动关闭: {"type":7}（Close）→ 服务端回 {"type":7} 并关闭
```

- **传输**：negotiate 按上游顺序宣告三种传输，客户端按序自动降级（与 ASP.NET Core SignalR 一致）：
  | 传输 | 传输格式 | 服务端实现 |
  |---|---|---|
  | `WebSockets` | `["Text","Binary"]` | Durable Object 的 WebSocketPair |
  | `ServerSentEvents` | `["Text"]` | 挂起的流式响应（`data: <msg>\n\n` 帧，带 `x-accel-buffering: no`） |
  | `LongPolling` | `["Text","Binary"]` | 挂起 GET（首个轮询立即返回、无消息挂起 ≤25s）+ POST 上报 + DELETE 关闭（204/200） |
- 连接建立后的 HTTP 路径：`GET`（SSE 与长轮询按 `Accept: text/event-stream` 区分）、`POST`（上报消息）、
  `DELETE`（关闭）。三种传输共用同一套消息语义与心跳。

#### 6.1 negotiate 响应的逐字契约

依据 ASP.NET Core 源码（`HttpConnectionDispatcher.ProcessNegotiate` + `NegotiateProtocol.WriteResponse`
+ `NegotiationResponse.cs`，版本 v9.0.9）：

**版本协商**（请求参数 `negotiateVersion`，服务端最大值 `_protocolVersion = 1`、最小值 0）：

| 请求 | 上游行为 | 响应 |
|---|---|---|
| `negotiateVersion=1` | 正常 | 版本 1 |
| 未携带该参数 | 视为版本 0（最小值 0，**不是错误**） | 版本 0 |
| `negotiateVersion=0` | 正常 | 版本 0 |
| `negotiateVersion=2` | `> _protocolVersion` → **钳制**（不报错） | 版本 **1** |
| `negotiateVersion=abc` | `int.TryParse` 失败 | `{"error":"The client requested a non-integer protocol version."}` |
| `negotiateVersion=-1` | `< MinimumProtocolVersion(0)` | `{"error":"The client requested version '-1', but the server does not support this version."}` |

**报错时仍返回 HTTP 200**（dispatcher 不设置非 200 状态码），响应体**只有** `error` 一个字段，
不签发 `connectionId`/`connectionToken`（客户端收到 error 即抛错，见 `HttpConnection.js` 的
`if (negotiateResponse.error) throw new Error(...)`）。

**字段出现规则**（`WriteResponse` 的条件写入）：

| 字段 | 条件 |
|---|---|
| `negotiateVersion` | **恒出现**（版本 0 也序列化为 `"negotiateVersion":0`；上游用 `WriteNumber` 无条件写） |
| `connectionId` | 非空即写 → 正常路径恒出现 |
| `connectionToken` | **仅当版本 > 0**（`response.Version > 0 && !string.IsNullOrEmpty(...)`） |
| `availableTransports` | **恒出现**（数组；顺序即客户端尝试顺序） |
| `useStatefulReconnect` | 仅当为 true → 恒不出现（默认 false） |
| `url` / `accessToken` | 非空即写 → 恒不出现（本实现不做 negotiate 重定向） |
| `error` | 仅出错时，且此时**其他字段全部不出现** |

> 注意 `NegotiationResponse.Version` 序列化为 `negotiateVersion`（不是 `version`）—— 上游序列化器由
> `NegotiateProtocol` 手写 JSON 完成，名称逐字即上表。客户端按 `availableTransports` /
> `connectionToken` / `connectionId` 读取（`_resolveTransportOrError`）。
- 连接 token：negotiate（Basic Auth 保护）时签发并**登记到 DO**（`/register-token`，TTL 10 分钟），
  连接建立时校验；未登记/过期/token 缺失时回落校验请求携带的 Basic 凭据，两者皆无 → **401**。
  `/register-token` 仅 Worker 内部可达（外部路径不匹配任何路由）。
- 心跳：DO alarm 每 15s 发送 `{"type":6}`，对三种传输分别投递（WS 直接 send、SSE 写帧、长轮询入队）。
  长轮询依赖它——空轮询响应不会重置客户端 ServerTimeout，必须有真实消息（实测 15s 内返回）。
- 提前返回响应前必须消费请求体（Workers 运行时会在响应已发出但入站体未读完时抛错并使后续请求 503）。
- 长轮询关键常量对照（取自客户端源码）：客户端单次 poll 超时**硬编码 100s**
  （`LongPollingTransport.js` `timeout: 100000`），其轮询循环**串行**（同一连接不会并发两个 poll）；
  本实现挂起上限 25s、心跳 15s，均低于客户端超时。
- 平台并发（实测于 Cloudflare 边缘）：20/50 路并发挂起长轮询均正常返回且各自收到心跳；
  20 路并发 SSE 流正常建立；WS/SSE/长轮询混合时均收到同一次广播。
- 心跳：DO alarm 每 15s 发 `{"type":6}`（对齐上游 `KeepAliveInterval`），并关闭静默超过 60s 的连接
  （半开 TCP 无 close 事件；上游由框架 `ClientTimeoutInterval=30s` 承担）。
- 广播触发点（对应官方代码）：
  - `SaveAndNotifyCurrentProfile` → `RemoteProfileChanged`（PUT /SyncClipboard.json 后）
  - `AddProfile` / `Update` / `AddRecordDto` / `MarkForDeletionAsync` / `GetExistingProfileAsync` → `RemoteHistoryChanged`
- 断线由客户端侧处理（官方客户端 `ServerDisconnected` → TestAliveHelper 探测恢复后重连），服务器无需会话恢复。

## 7. 更新判定规则（`上游:Server.Core/Utilities/History/HistoryHelper.cs`）

```
gap = |newLastModified - oldLastModified|
gap <= 5 分钟 → newVersion >= oldVersion 则更新
gap >  5 分钟 → newLastModified >= oldLastModified 则更新
```

## 8. 哈希算法（服务端校验用，须精确复刻）

所有输出为 **十六进制大写**（C# `Convert.ToHexString`）。

### 8.1 Text（`上游:Shared/Profiles/TextProfile.cs`）

| 情形 | 哈希 | Size |
|---|---|---|
| inline（≤10240 字符） | `SHA256hex(UTF8(text))` | 文本字符数 |
| 大文本带 transfer data | `SHA256hex(文件字节)`（= UTF-8 全文字节哈希，与 inline 公式对同一全文等价） | 全文字符数（`dto.Size` 优先，缺失时读文件 `.Length`） |
| 服务端接收数据文件校验 | `SetTransferData(verify:true)` 按**文件字节** SHA256 与 `Hash` 比较 | — |

> 服务端 `AddNewRecordDto` 的 `IsLocalDataValid(quick)`：`HasTransferData = TransferDataFile 非空 || Size > Text.Length`；
> 为真但数据文件缺失 → **400 `Needs tranfer data.`**（本实现按此判定，非对 Text 恒 true）。

### 8.2 File / Image（`上游:Shared/Profiles/FileProfile.cs:CombineHash/GetSHA256HashFromFile`）

```
contentHash = SHA256hex(文件内容)
hash = SHA256hex(UTF8($"{fileName}|{contentHash.toUpperCase()}"))
```
其中 `fileName` 为上传文件的原始文件名（DataName）。注意 `|` 分隔、内容哈希大写后再拼接。

### 8.3 Group（`上游:Shared/Profiles/GroupProfile.cs:CaclHashAndSize/CalculateEntriesHashAsync`）

```
1. 解包 ZIP，收集条目：目录条目 + 文件条目；
   EntryName = 以工作目录为根的相对路径，目录名以 '/' 结尾（空目录也计入）。
2. 排序：按 EntryName 的 UTF-8 字节数组升序（ByteArrayComparer）。
3. 每条目构造行（UTF-8）：
   目录: "D|{EntryName}\0"
   文件: "F|{EntryName}|{Length}|{contentHashUpper}\0"
4. 按序拼接全部行 → SHA256hex。
5. 空条目集合（空 ZIP/无内容）: SHA256hex(空串) = E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855
```

服务端校验 = 解包收到的 ZIP → 计算 → 与 dto.hash 比较（忽略大小写）。

## 9. 客户端行为依赖清单（不可破坏的语义）

| 依赖 | 客户端行为（`上游`） |
|---|---|
| `/api/version` ≥ 3.1.1 | `TestConnectionAsync` 拒绝低版本服务器（OfficialAdapter） |
| `/api/time` 与本地时钟差 ≤ 5 分钟 | 历史同步 `SyncTaskImpl` 抛 `ServerTimeError` 中止同步 |
| PATCH 409 + update dto | `HistorySyncer.SyncOneAsync` 以服务器版本**回写本地**（并发冲突收敛） |
| POST /api/history 400/422 | `UploadHistoryAsync` 抛 `RemoteHistoryDataRejectedException`，队列按远端失败重试 |
| POST /api/history 409 | `RemoteHistoryConflictException`，表示已存在 |
| GET /api/history/{profileId} 对 IsDeleted 记录仍返回 dto | 客户端 adapter 自行过滤 IsDeleted → null |
| **服务端软删会传播成客户端的删除**：`SyncRemoteHistoryAsync` 对已存在记录执行 `ApplyChangesFromRemote`（复制 `IsDeleted`）后 `TriggleUpdateOrDeleteEvent` → `IsDeleted` 为真即触发 `HistoryRemoved`（`HistoryManager.cs:373-398`、`MapperExtensions.cs:33-39`） | 不要在服务端用「软删」表达「数据丢了、等客户端重传」——那会把客户端**仅存的那份本地副本**也标记删除 |
| **孤儿判定不区分软删**：`DetectOrphanDataAsync` 的 `remoteIds` 直接由 `remoteRecords.Select(r => $"{r.Type}-{r.Hash}")` 构成，**不过滤 `IsDeleted`**（`HistorySyncer.cs:311`），因此软删记录仍算「服务器存在」 | 想让客户端把本地记录标成 `LocalOnly` 并带数据重传，服务端的行必须**真正消失**（D1 `DELETE`），软删无效 |
| PUT /SyncClipboard.json 命中历史复用 | 客户端不重复上传数据文件（哈希已在库） |
| GET /file/{name} 历史查找 | 客户端按 `DataName` 下载，须能命中刚上传的记录 |
| GET /SyncClipboard.json 空档期返回空 TextProfile | 客户端 `Profile.Create` 得空文本，轮询不报错 |

## 10. 兼容性边界与已知差异

| 项 | 官方服务器 | 本实现 | 影响 |
|---|---|---|---|
| 请求体上限 | Kestrel 无限制（MaxRequestBodySize=int.MaxValue） | 平台 100MB（Free）/更高，**另有 32MiB 应用层上限**（超限 413，见 `src/requestLimits.ts` 注释：客户端默认 20MB；isolate 仅 128MB，接近 100MB 的体会在解析期 OOM） | **有意偏离**：单请求 >32MiB 失败；客户端默认 20MB 不受影响 |
| SignalR 传输 | WebSockets + SSE + LongPolling | 三种均实现，宣告顺序与格式表逐字对齐 | — |
| 磁盘布局 | 本地文件系统 | R2 对象存储 | 对外不可见，语义等价 |
| 并发 | 单进程信号量串行 | `(UserId,Type,Hash)` UNIQUE 索引 + 唯一冲突按 ShouldUpdate 合并 + `updateEntityIfVersion` 乐观锁 | 语义等价（多设备并发实测无重复行/丢更新） |
| `/api/history/statistics.totalFileSizeMB` | 遍历本地目录 | 按 R2 对象 size 求和 | 等价（R2 list 最终一致，存在短暂窗口） |
| 缓存 | 内存缓存 + 显式失效 | 无缓存（D1/R2 直读） | 等价（更强一致） |
| 保留/清理 | `HistoryCleaner` 三类后台任务（10min / 12h / 12h） | Cron Trigger 每小时批量执行同类语义 | 等价（周期不同；软删/硬删/孤儿判定一致） |
| Content-Type 映射 | `FileExtensionContentTypeProvider`（~370 项） | 46 项常见扩展 + `application/octet-stream` 回退 | 官方客户端按文件名落盘、不检查 Content-Type |
| 错误响应体 | `BadRequest()` 空体 / ProblemDetails | 统一文本（状态码一致） | 官方客户端只判状态码 |
| 方法不匹配（如 `POST /`） | ASP.NET 405 Method Not Allowed（带 `Allow` 头） | Hono 兜底 404 | 官方客户端不会发错方法；未知路径两边都是 404 |
| 非 `/file/{name}` 路径上的 `HEAD` | **405**（ASP.NET 路由**不**把 HEAD 映射到 GET —— 见下方依据） | **200**（Hono 为 GET 路由自动处理 HEAD） | 本实现更宽容（超集）：客户端不发这类 HEAD（`WebDavBase.Exist()` 定义了但未被调用），`HEAD /file/{name}` 两边都是 200 |
| `/api/history/{id}/data` 的 Content-Type | `FileExtensionContentTypeProvider`（按数据文件扩展名） | 恒 `application/octet-stream` + `nosniff` + `attachment` | 安全加固；客户端按字节落盘，不读该头 |
| `Profile.Create` 的 File→Image 提升 | 有（`.jpg/.jpeg/.gif/.bmp/.png`） | 同左 | — |
| `PUT /SyncClipboard.json` 的数据落盘方式 | `File.Move`（**不读数据**，常数内存、瞬时完成） | 读入内存（`arrayBuffer()`）→ 重传到 `history/` 新 key（R2 **无 move/rename**） | 峰值内存 ≈ 文件大小，且多一次 R2 读+写。客户端默认上限 20MB，实测 20/60MB 通过；若把客户端上限提到 ~50MB 以上需留意 Workers 128MB 内存 |
| `POST /api/history` 的 body 处理 | `MultipartReader` **流式**（`[DisableFormValueModelBinding]` + `[RequestFormLimits]`），data 段直接抄到磁盘 | 整体读入内存后解析（`c.req.arrayBuffer()`） | 同上：峰值内存 ≈ 请求体大小。实测 20MB 通过 |
| POST 路径 `size` 口径 | Text=声明值、File/Image=实际字节、Group=条目和 | 同左 | — |
| query 的时间字段无法解析（如 `Before=not-a-date`） | 表单绑定失败 → 400 | **忽略该过滤条件**（等价于上游 POST 元数据路径的 `TryParse` 失败回退） | 有意偏离：客户端时间串带偏移（`DateTimeOffsetPattern = 短日期 + 长时间 + zzz`，见 .NET `DateTimeFormatInfo.DateTimeOffsetPattern`），`Date.parse` 可覆盖 zh-CN/en-US/de-DE 等；若某文化串两边都解析不了，返 400 会让客户端历史同步**整轮失败**，而忽略只会让增量过滤退化为「多取一页」 |
| `GET /file/{name}` 内部异常（非「文件名非法」） | `catch (Exception)` → **400** + 异常消息（`GetFileFromFolder`） | 500（异常上抛到运行时） | 客户端对两者都只走 `EnsureSuccessStatusCode` 的失败分支；把内部故障报成 400 会误导排障，故有意保留 500 |
| hash 含路径分隔符（`/` 或 `\`） | `Profile.GetWorkingDirName` 抛 `ArgumentException`（未捕获 → 500） | 写路径入口 → **400**（`Hash contains invalid path characters`）；存储值分类视同损坏 → 降级为空 TextProfile | 可诊断的 400 优于 500；且杜绝「入库一条 hash 含 `/` 的记录并被设为当前 profile」（该记录会被推给客户端，而客户端本地用同一规则构造路径会抛异常） |
| hash 含分隔符的**平台差异** | Windows：`DirectorySeparatorChar='\'`、`Alt='/'` → 两者都拒；Linux：两者都是 `/` → 只拒 `/`，**允许 `\`** | 两平台一致地拒绝两者 | 严格超集；跨平台行为一致，官方客户端恒发 SHA256 hex（永不触发） |
| `profileId` 里的类型枚举大小写 | **大小写敏感**：`Profile.ParseProfileId` 用 `Enum.TryParse<TEnum>(value, out r)`（.NET 源码该重载固定 `ignoreCase: false`），故 `text-HASH` → 400。但 `PATCH /{type}` 走模型绑定（`EnumTypeModelBinder` → `EnumConverter.ConvertFrom` → `Enum.Parse(t, s, ignoreCase: **true**)`），**大小写不敏感** —— 上游自身不一致 | 两处均大小写不敏感 | 宽松超集：官方客户端恒发 `Text`/`File`/`Image`/`Group` 规范名，两种实现等价；第三方客户端更不易踩坑 |
| 第三方畸形 zip | 隐式目录/重复条目按解压落盘语义 | 隐式目录计入；重复条目首见保留（filter）；`a` 与 `a/` 同名冲突不报错 | 官方客户端恒写显式目录条目且无重复 → 不可达 |
| zip 条目名的**路径形态** | 越界形态按**平台相关**的方式处理：读取守卫（`GroupProfile.cs:619-624`：`Path.Combine` + `GetFullPath` + `StartsWith(extractPath)`）在 Windows 上会拒掉 rooted 形态（`Path.Combine` 遇 rooted 第二参数直接返回它 ⇒ 不在解压根下），在 Linux/macOS 上则把 `C:/evil.txt` 当**相对路径**落盘（生成名为 `C:` 的目录）；含 **NUL** 的名字没有专门处理，落盘时抛未处理异常（**500**，不是干净拒绝） | 入口**一律拒绝**，不依赖平台：盘符 + 分隔符形态与含 NUL 的名字都拒（POST→422 / PUT→400）；同时**不**拒「第二字符是冒号」的普通名字（`a:b.txt`、`1:30.txt`） | **有意偏离**：拒绝口径跨平台一致，且不让畸形输入变成 500。附注：`a:b.txt` 这类名字在 POSIX 上合法（上游同样落盘成功），在 Windows 上游会被同一个 rooted 守卫拒掉，而本实现一律接受——宽松超集，官方客户端不可达 |
| 应用层解压上限 | 无 | **有**：Group zip 解压总量 64MiB / 条目 1000 / 单条目压缩比 100:1（比值守卫含 8MiB 绝对下限；见 `src/hash.ts`） | **有意偏离**：合法但超大的文件夹会被拒（POST→422、PUT→400）；上游无此防护（同为全量解压） |
| PROPFIND 响应 | 200 空体 | 207 标准 multistatus | 客户端两处调用均按 2xx 判定（`DirectoryExist` 只看 404、`GetFolderSubList` 用 `EnsureSuccessStatusCode`），且 207 是 `PreciseDelete` 解析目录列表的前提 |
| **附件响应头** | 仅 `Content-Type` | 一律 `X-Content-Type-Options: nosniff`；可渲染类型（html/htm/xhtml/svg/xml）额外 `CSP: default-src 'none'; sandbox` + `Content-Disposition: attachment` | **有意加固偏离**：附件与 API 同源、浏览器会自动附带已缓存的 Basic 凭据，直接打开可读取全部历史（存储型 XSS）。桌面客户端不读这些头，已 E2E 验证无回归；代价是浏览器不再内联预览 HTML/SVG 附件 |
| `DELETE /file/{name}` | 无该路由（`PreciseDelete` 因而失效） | 已实现单文件删除 | **补全**：客户端 `PreciseDelete=true` 的 `GetFolderSubList` → `DELETE file/{name}` 才会真正生效 |
| 无数据的 File/Image/Group | `Persist()` 抛异常 → 500 | 400 | 更准确的拒绝；客户端对两者同为「失败重试」，无行为差异 |
| Basic 凭据缺冒号 | `credentials[1]` 越界 → **IndexOutOfRangeException（500）** | 401 | 更健壮（上游为未处理异常） |
| Basic 密码含冒号 | `Split(':')` 截断 → 校验失败（401） | 取首个冒号后全部 → 可用 | 更宽容；从官方服务器迁移的用户不受影响 |
| `WWW-Authenticate` | `Basic realm="SyncClipboard"` | 逐字一致 | — |
| MIME 表 | ~370 项 | 46 项常见类型 + octet-stream 回退 | 可渲染类型必须显式在表内（否则回退后仍不可渲染，安全） |
| `POST /api/history` 的媒体类型 | 显式 `[Consumes("multipart/form-data")]`（`HistoryController.cs:121`）⇒ 非 multipart 在模型绑定**之前**被拒 → **415** | 同（`src/routes/history.ts` 的 `parseFormBody(c, false)`；提前返回前先排空请求体） | **本轮对齐**（此前本实现一律回 400）。客户端按状态码分支，故必须一致 |
| `POST /api/history/query` 的媒体类型 | 只有 `[FromForm]`（`HistoryController.cs:81`）、无 `[Consumes]` ⇒ multipart 与 `application/x-www-form-urlencoded` **都接受** | 同（`parseFormBody(c, true)`：urlencoded 走 `URLSearchParams`，字段名同样大小写不敏感） | **本轮补齐**。官方客户端发 multipart，两条路径都不受影响 |
| `POST /api/history/query` 收到非表单媒体类型（如 JSON body） | 无 `[Consumes]` 约束 ⇒ 等价于「字段全缺失的表单」（`HistoryController.cs:83` 的 `query ??= new HistoryQueryDto()` 实际不可达）→ 按默认参数返回第 1 页（**推断**：ASP.NET 的 form 值提供程序对非表单体不产出任何字段；未实测） | **400**（`Invalid or missing multipart/form-data boundary`） | 有意偏离：不把畸形请求当成一次有效查询（本仓库一贯偏好 fail-loud）。客户端恒发 multipart，不可达 |
| 畸形 `Authorization` 头 | 三种畸形（`Basic` 后无空格、凭据无冒号、非 base64）都抛未捕获异常 → **500**（`BasicAuthenticationHandler.cs:20-25`） | **401**（`src/auth.ts` 一律返回 null） | 本实现更健壮。状态码**类别**不同（5xx vs 4xx）：第三方客户端若把 5xx 记成「服务器故障」会误判 |
| hash 的匹配方式 | `EF.Functions.Like(r.Hash, hash)`（`HistoryService.cs:255`）：`%`/`_` 是通配符，且 SQLite 的 LIKE 对 ASCII 大小写不敏感 | `LOWER(Hash) = LOWER(?3)`（`src/db.ts:133`） | 本实现更严格、可走索引；第三方客户端发送含 `%`/`_` 的 hash 时，上游会误命中同前缀记录 |
| 时间列的存储形态 | `CreateTime`/`LastAccessed`/`LastModified` 为 **TEXT**（EF Core 把 `DateTime` 存成 ISO8601 文本，`Migrations/20251105014242_Init.cs:29-31`） | **INTEGER** epoch 毫秒（`schema.sql:14-16`） | 对外不可见（wire 上两侧都是 ISO8601）。**但存量 `history.db` 不能直接导入**：两实现不共读同一份数据 |
| 表索引集合 | 3 个含 `Stared` 的复合索引（`HistoryDbContext.cs:40-52`），为「收藏 + 时间范围/类型 + 翻页」优化 | **本轮补齐**其中两个（`idx_h_user_stared_create` / `idx_h_user_stared_type_create`，`schema.sql`）；上游第三个 `(UserId,CreateTime,ID)` 不必单独建——SQLite 的索引条目隐含 rowid，而这里的 `ID` 就是 rowid 别名，`idx_h_user_create` 已是同一形态 | 对齐。此前只缺这两个，收藏筛选与统计在数据量上来后会退化为全表扫描 |
| Group zip 条目名含 `.` 段 | `Path.Combine` + `GetFullPath` 归一化后**接受**（`./a.txt` 落成 `a.txt`，`GroupProfile.cs:619-621`） | **拒绝**（`src/hash.ts:224-228`：`.`/`..` 段一律拒） | 有意偏离（fail-loud 优于平台相关的归一化）。官方客户端的 zip 用相对路径、无 `.` 段，不可达 |
| Group zip 的重复条目 | 内容「首次落盘优先」，但 `topLevelFiles`/条目列表**不去重**（`GroupProfile.cs:644-648`）⇒ 重复条目被计入 hash 与 `totalSize` 两次 | 同名条目只取首个，且条目集与顶层条目都**去重**（`src/hash.ts:112-116`、`185-200`） | **有意偏离**：含重复条目的 zip 上两侧 hash 与 size **必然不同**。官方客户端恒不写重复条目，不可达（见 README「已知限制」第 2 条） |
| 落库 hash 的大小写 | 原样存（`Profile.cs:86`、`TextProfile.cs:55`） | 统一 `.toUpperCase()` 落库 | 对外不可见（查询恒大小写不敏感）；避免同内容在不同设备上于 Linux 生成两个 R2 工作目录（上游在大小写敏感文件系统上会双份存储） |

## 11. 参考实现对照表

| 功能 | 上游文件 | 本实现文件（规划） |
|---|---|---|
| WebDAV 端点 | `Server.Core/Controllers/SyncClipboardController.cs` | `src/routes/webdav.ts` |
| 历史端点 | `Server.Core/Controllers/HistoryController.cs` | `src/routes/history.ts` |
| 历史服务 | `Server.Core/Services/History/HistoryService.cs` | `src/db.ts` + `src/profile.ts` |
| 更新判定 | `Server.Core/Utilities/History/HistoryHelper.cs` | `src/db.ts` |
| DTO | `Server.Core/Models/*.cs`、`Shared/ProfileDto.cs` | `src/types.ts` |
| 哈希 | `Shared/Profiles/{Text,File,Group}Profile.cs` | `src/hash.ts` |
| Hub | `Server.Core/Hubs/SyncClipboardHub.cs` | `src/durable/SyncClipboardHub.ts` |
| 鉴权 | `Server.Core/BasicAuthenticationHandler.cs` | `src/auth.ts`（UTF-8 解码、scheme 大小写不敏感、`WWW-Authenticate` 头） |
| 保留/清理 | `Server.Core/Services/History/HistoryCleaner.cs` | `src/cleanup.ts` + `wrangler.toml [triggers]` |
