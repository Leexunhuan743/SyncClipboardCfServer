# 上游 SyncClipboard 安全问题 · Issue 稿（15 条）

> **2026-09-15 追加（一）**：以 `28c7e596` 为基准做了一次逐文件对照（报告见 [`upstream-parity.md`](upstream-parity.md)），
> 新增 **Issue 8–12**（缓存键失效、孤儿清理中断、条数上限不收敛、全表拉取、静默吞异常）与一节
> **「复核记录：被驳回的候选」**。原有 7 条未改动。
>
> **2026-09-15 追加（二）**：又做了一轮「上游缺陷在本实现里怎么处置」的逐条对照
> （报告见 **[`upstream-defects.md`](upstream-defects.md)**：21 条候选按处置分五类（A 必须复刻 / B 有意偏离 / C 结构性消除 / D 待办 / 不改但需知），
> 该轮初版写作「16 条已复刻 + 5 条未复刻」，2026-09-18 重排为按处置分类，条目本身未变）。
> 该轮的结论：**原有 13 条全部成立，无一条需要撤回**；新增 **Issue 14**（服务端无唯一索引，
> 是 Issue 8 同一族的数据完整性问题），并把两条**此前只写在代码注释里**的偏离理由
> （LIKE 通配符、乐观锁针对的故障类型）补进了 `protocol.md` §10。
>
> **2026-09-15 追加（三）**：客户端侧专项对照（对照范围从"服务端"扩到 `SyncClipboard.Core` 的
> 历史/清理链路），新增 **Issue 15**（软删记录的本地数据被"只删行不删文件"，且两个清理 Job 的候选集互斥
> 使抢救它的那个**通常抢不到**）。本条属**客户端**问题，标签建议 `Area-Client` + `privacy`。
> 本文件与 `upstream-defects.md` 的分工：**本文件只收录"给上游提 issue"的条目**；
> `upstream-defects.md` 回答"上游的问题在本实现里如何处理"（含**有意复刻**的契约类行为——那些**不是** issue）。

- **对象**：`SyncClipboard`（C# / ASP.NET Core 服务端，仓库本地路径 `C:/Users/leeexx/Documents/NewProject/SyncClipboard`）
- **核实方式**：本轮**只读**通读上游源码（下列每条都给出 `文件:行` 与逐字代码），未运行上游服务；因此"影响"部分是按代码语义的推断，凡未实测处均已标注。
- **关联审计**：`cfserver-audit-003`（对 SyncClipboardCfServer 的交叉验证审计）。本文件只收录**上游本身存在**的问题；本实现特有的问题见 `docs/security-fix-plan.md`。
- **用途**：可按主题拆成若干 issue 提交上游（本文件共 **15** 条，其中 8–15 为后续追加轮次补入）。建议标签：`security`、`Area-Server`。

---

## Issue 1 · 服务端在缺少配置时回退到内置 `admin/admin`，且随仓配置使用可预测占位凭据

**严重度**：Critical（默认部署即可被接管）
**位置**：`src/SyncClipboard.Server.Core/CredentialChecker/FileCredentialChecker.cs:5-15`、`src/SyncClipboard.Server/appsettings.json`

**代码（逐字）**：

```csharp
private const string DEFAULT_USERNAME = "admin";
private const string DEFAULT_PASSWORD = "admin";

public bool Check(string name, string password)
{
    var configUserName = configuration["AppSettings:UserName"] ?? DEFAULT_USERNAME;
    var configPassword = configuration["AppSettings:Password"] ?? DEFAULT_PASSWORD;
    return name == configUserName && password == configPassword;
}
```

随仓 `appsettings.json`：`"AppSettings": { "UserName": "your_username", "Password": "your_password", ... }`

**影响**：Basic Auth 是服务端唯一认证手段。(a) 配置节缺失（例如用环境变量部署却没设 `AppSettings__UserName`）时，凭据直接退化为 `admin/admin`；(b) 即便按随仓配置启动，凭据也是 `your_username`/`your_password` 这种一眼可猜的占位值。两种情形叠加默认监听地址（见 Issue 3）即"公网可读全部剪贴板历史与附件"。

**复现**：以不含 `AppSettings` 节的配置启动服务端，用 `admin:admin` 访问 `GET /SyncClipboard.json` → 返回内容而非 401。

**建议修复**：
1. 去掉代码级回退：配置缺失时**fail-closed**（启动即报错或一律鉴权失败），并打印明确错误。
2. 随仓配置不要放可用的占位凭据；首次启动生成随机口令写入本地配置并打印一次性提示，或要求部署者显式提供。
3. 增加弱凭据拒绝（`admin`、`your_username`、`your_password`、`password` 等命中即拒绝启动）。

**说明（不主张的部分）**：`your_username` 在随仓配置里的**实际部署效果**取决于部署者的改法（若已改成强口令则不受 (b) 影响）；(a) 与部署方式无关，只要配置节缺失就成立。

---

## Issue 2 · 认证失败路径没有任何速率限制 / 失败计数 / 锁定

**严重度**：High（弱口令可在线爆破；与服务端唯一认证因子叠加）
**位置**：`src/SyncClipboard.Server.Core/`（全目录检索 `AddRateLimiter|RateLimiter|lockout|MaxFailedAccessAttempts` **零命中**）

**影响**：服务端只用 Basic Auth（见 Issue 1），而失败路径不计数、不延迟、不锁定 ⇒ 在线猜测成功率只取决于口令熵。若配合默认/占位凭据，等于没有防护。

**复现**：对 `GET /api/version` 连续发 N 次错凭据请求 → 全部 401，无 429、无 `Retry-After`、无递增延迟。

**建议修复**：
1. `builder.Services.AddRateLimiter(...)` 按 IP + 凭据维度限流，失败计数用内存缓存（单实例）或分布式缓存。
2. 失败 N 次后指数退避 / 临时锁定，并记录审计日志（可观测）。
3. 文档层面对"公网暴露 + 弱口令"给出显式警告。

**补充**：本实现的对应加固（尚待实施）见 `docs/security-fix-plan.md` 的 F7。

---

## Issue 3 · 默认以明文 HTTP 监听所有网卡；仅在显式配置证书时才用 HTTPS，且全项目无 HSTS

**严重度**：High（Basic 凭据与剪贴板正文会在链路上明文传输）
**位置**：`src/SyncClipboard.Server/appsettings.json`、`src/SyncClipboard.Server.Core/Web.cs:108-117`（检索 `UseHsts` **零命中**）

**配置（逐字，注意 https 段是注释掉的）**：

```jsonc
"Kestrel": { "Endpoints": { "http": { "Url": "http://*:5033" },
                            //"https": { "Url": "https://*:5033" } } },
"AllowedHosts": "*"
```

**代码**：`Web.cs:114` 的 `options.UseHttps()` 只在配置了证书（`Kestrel:Certificates:Default`）时执行；全项目没有 `UseHsts()`，也没有明文→https 的跳转。

**影响**：按随仓配置启动，服务端在**所有网卡**上以明文 HTTP 提供 Basic Auth ⇒ 同一局域网/同一链路上的任何人都能直接读走剪贴板正文与附件，以及 Basic 凭据本身（可重放）。放在反向代理后若代理未强制 TLS，同样成立。

**复现**：按随仓配置启动，`curl -I http://<局域网 IP>:5033/` → 无重定向；响应无 `Strict-Transport-Security`。

**建议修复**：
1. 默认只监听 `127.0.0.1`，对外暴露必须是显式选择。
2. 加 `UseHsts()`，并在有证书时把明文请求 301 到 https。
3. 文档把"公网部署必须 TLS（反代或 Kestrel 证书）"写成硬性要求。

---

## Issue 4 · Kestrel 请求体上限被显式设为 `int.MaxValue`

**严重度**：Medium（单请求即可造成内存/带宽放大）
**位置**：`src/SyncClipboard.Server.Core/Web.cs:25`

**代码（逐字）**：

```csharp
services.Configure<KestrelServerOptions>(options => options.Limits.MaxRequestBodySize = int.MaxValue);
```

**影响**：Kestrel 默认 30 MB 的体量保护被**主动移除**。任何人都可以对上传端点（`PUT /SyncClipboard.json`、`POST /api/history` 等）发超大请求，服务端会把整个体读进内存/磁盘 → 内存压力、磁盘写满、拖垮单实例。与 Issue 2 叠加（无限速）更易触发。

**复现**：`curl -X PUT --data-binary @large.bin -u admin:admin http://host:5033/SyncClipboard.json`，观察进程内存/磁盘随体积线性增长。

**建议修复**：按端点上限定值（例如文本 10 MB、附件按业务上限），对超限请求返回 413；确需大文件时用流式 + 配额，而不是取消全局上限。

**备注**：本实现（cfserver）同样缺体量上限（审计 F9），修复计划见 `docs/security-fix-plan.md`。

---

## Issue 5 · Group（zip）解压无体积 / 条目数上限，压缩比可被放大 ~1000 倍

**严重度**：Medium（小体积请求即可物化巨量数据 → 内存/磁盘耗尽）
**位置**：`src/SyncClipboard.Shared/Profiles/GroupProfile.cs:609-655`（`ExtractArchiveEntriesAsync`）。该方法**有**路径穿越守卫（`:621-624` 用 `destPath.StartsWith(extractPath)` 拒绝逃逸条目），但**没有任何体积或条目数上限**：全文件检索 `MaxLength`/`MaxSize`/`EntryCount`/`上限` 均为 0 次；逐条目复制 `entryStream.CopyToAsync(destStream, 81920, token)` 中的 `81920` 是缓冲区大小、不是上限。

**影响**：Group 上传的 zip 在服务端被完整解压，且**在哈希校验通过之前**就已付出解压代价 ⇒ 攻击者只需提供高压缩比 zip（实测：65.7 KB → 64 MB，约 1000:1）即可让服务端解压出远超上传体积的数据；条目数同样无上限（数万条目逐个 SHA-256）。

**复现**：构造 `zero-filled` 大文件的 zip（压缩比 ≥1000:1），以 Group 类型上传 → 观察服务端解压后的实际物化体积与耗时。

**建议修复**：
1. 解压前检查 `entry.Length` 之和与条目数上限（例如总量 ≤ 上传体积 × 20 且 ≤ 固定上限，条目 ≤ 1000）。
2. 优先校验声明 hash 与 zip 内容的一致性，再解压（避免为无效应答付出代价）。
3. 逐条目流式处理 + 边解压边计数，超限立即中止。

---

## Issue 6 · 凭据比较使用非常量时间比较（次要加固）

**严重度**：Low（远程时序攻击在 HTTP 上通常不实用，属加固项）
**位置**：`FileCredentialChecker.cs:14`（`return name == configUserName && password == configPassword;`）、`StaticCredentialChecker.cs:11`（同型）

**影响**：字符串比较在首个不同字符处短路，理论上可提供逐字节的时序侧信道。实际可利用性受网络抖动限制，但在**内网/同机**场景下有讨论价值；一旦将来出现限速（Issue 2 的修复）之外的补偿手段，这条会成为最后一层。

**建议修复**：用 `CryptographicOperations.FixedTimeEquals`（UTF-8 字节序列先做等长处理或对长度差异单独处理），保持"长度不同也走固定路径"。

---

## Issue 7 · 设计层：删除是软删，无"单条立即彻底清除"入口（保留期内的明文仍在库）

**严重度**：Low（与产品文档一致，但影响"误发敏感内容后想立即销毁"的诉求）
**位置**：`src/SyncClipboard.Server.Core/Services/History/HistoryService.cs:516-530`（`RemoveOutOfDateDeletedRecords`）、`:538-564`（`RemoveOutOfRetentionRecords`）、`HistoryCleaner.cs:28-64`（两个循环 + `Task.Delay(10min/12h)`）

**现状**：`IsDeleted=1` 只是软删；30 天后由清理任务硬删；`ClearAllAsync` 是"全清"而非"单条彻底清除"。默认保留期 `HistoryRetentionMinutes=10080`（7 天）、条数上限 1000（`appsettings.json`）。

**建议**：在 UI/API 增加"彻底删除此条（不可恢复）"入口（D1 行 + 数据文件双清），或把"删除"在 UI 上明确标注为"标记删除，30 天后清除"。

**说明**：本条为**设计取舍**而非缺陷，故列最后；与 cfserver 的实现语义一致（审计 F10）。

---

## Issue 8 · 当前 Profile 的内存缓存永不失效（失效语句用的 key 与读写的 key 不是同一个）

**严重度**：Medium（外部改动不可见；多实例/手工修复/备份恢复场景下会长期提供**过期**的当前剪贴板）
**位置**：`src/SyncClipboard.Server.Core/Controllers/SyncClipboardController.cs`

**代码（逐字，注意三处 key）**：

```csharp
// :118  —— PUT /file/{fileName} 里想「使当前 profile 缓存失效」
_cache.Remove("SyncClipboard.json");

// :125-126 —— GET /SyncClipboard.json 真正的 key 是**绝对路径**
var profilePath = Path.Combine(_serverEnv.GetDataRootPath(), "SyncClipboard.json");
var cacheKey = profilePath;
// :136 / :148 / :152 / :226 —— 读写的都是 cacheKey（= 绝对路径）
_cache.Set(cacheKey, dto);
```

**影响**：(a) `:118` 的 `Remove` 永远删不到东西（key 是字面量而不是 `profilePath`）—— 它本来要表达的语义
「暂存目录变化后重新读 profile」**从未生效**；(b) 缓存项 `Set` 时不带任何过期策略（无 `AbsoluteExpiration` /
`SlidingExpiration`），因此在**文件被进程外改动**时（两个容器共享同一 `/app/data` 卷、手工编辑/修复
`server/SyncClipboard.json`、从备份恢复）服务端会一直返回内存里的旧值，直到进程重启或下次
`SaveAndNotifyCurrentProfile`（`:226`）覆盖它。

**复现**：启动服务端 → `GET /SyncClipboard.json`（结果被缓存）→ 直接改 `server/SyncClipboard.json` 文件
→ 再次 `GET /SyncClipboard.json` → 返回值不变。

**建议修复**：让失效语句使用同一个 key（把 `cacheKey` 的构造提取成方法/属性，或给 `IMemoryCache` 包一层
按 Profile 语义命名的方法），并按「文件是唯一事实源」给缓存加短 TTL（例如 1–5 秒）或改用
`FileSystemWatcher`/`IChangeToken`。

---

## Issue 9 · 孤儿目录清理：单个目录删除失败会中断整轮，剩余孤儿要等下个周期

**严重度**：Low-Medium（孤儿目录堆积；12 小时周期内不再重试）
**位置**：`src/SyncClipboard.Server.Core/Services/History/HistoryService.cs:685-719`（`CleanOrphanedFolders`）

**代码（逐字，`:717` 无任何 try/catch）**：

```csharp
foreach (var directory in directories)
{
    token.ThrowIfCancellationRequested();
    ...
    if (entity is null || entity.IsDeleted)
    {
        Directory.Delete(directory, true);   // ← 无 try/catch
    }
}
```

**影响**：`Directory.Delete` 在目标被占用/权限不足/路径超长时抛异常；`CleanOrphanedFolders` 直接向上抛，
被 `HistoryCleaner` 的外层 try/catch 记一条日志后**本轮结束**——循环里它后面的目录本轮不再处理。
与同类路径（`DeleteProfileData` 用 `catch when (!token.IsCancellationRequested) { }` 明确吞掉删除失败）
处置不一致。

**复现**：在 `server/history/` 下造两个「无活记录引用」的目录，其中一个用句柄占住（Linux 上
`chmod 500` 即可）→ 触发清理 → 观察日志：只有一条异常，另一个可删目录仍在。

**建议修复**：逐目录 try/catch + 失败计数，把失败写进日志（现在是静默中断）；或收集失败列表在轮末汇总。

---

## Issue 10 · `MaxSavedHistoryCount` 在「收藏 + 置顶占满配额」时永远不会收敛，且无告警

**严重度**：Low-Medium（配置承诺「最多 N 条」实际不成立；磁盘/DB 无界增长）
**位置**：`HistoryService.cs:579-580`（两个判定表达式不一致）+ `HistoryManagerHelper.cs:27-42`

**代码（逐字）**：

```csharp
public Expression<Func<HistoryRecordEntity, bool>> QueryCount
    => entity => !entity.IsDeleted;                                    // 计数：全部活跃行
public Expression<Func<HistoryRecordEntity, bool>> QueryToDeleteByOverCount
    => entity => !entity.Stared && !entity.Pinned && !entity.IsDeleted; // 待删：排除收藏/置顶

// HistoryManagerHelper.SetRecordsMaxCount
uint count = (uint)await records.Where(repository.QueryCount).CountAsync(token);
if (count <= maxCount) break;
var take = (int)Math.Min(BatchSize, count - maxCount);
var batch = await records.Where(repository.QueryToDeleteByOverCount)...Take(take).ToListAsync(token);
if (batch.Count == 0) { break; }        // ← 超量但无可删对象 ⇒ 静默收工，无日志
```

**影响**：`count` 用「全部活跃」而待删集排除了收藏/置顶，因此当 `starred + pinned` 达到或超过
`MaxSavedHistoryCount` 时，`batch` 恒为空、循环 break —— **活跃行数会永远超过配置上限**，日志里也没有
任何提示。此时 `GET /api/history/statistics` 仍照实报 `totalCount > maxSavedHistoryCount`，用户看到的是
「配置 1000 条、实际 3000 条」而没有任何解释。

**复现**：把 `MaxSavedHistoryCount` 设为 2，收藏 3 条记录，再新增若干普通记录 → 活跃数持续增长，
日志无任何裁剪失败提示。

**建议修复**：至少记一条日志（`超量 N 条，但可裁剪对象为 0，请取消收藏/置顶或调高上限`）；
更好的做法是把「收藏/置顶豁免」与「上限」的关系写进文档或让上限服从豁免（例如按 `maxCount + 豁免数` 判定）。

---

## Issue 11 · `GET /file/{fileName}` 每次都把该用户的**全部历史行**拉进内存

**严重度**：Low-Medium（放大面：请求成本随历史库规模线性增长；可被反复调用）
**位置**：`HistoryService.cs:211-230`（`GetRecentTransferFile`，由 `SyncClipboardController.cs:96` 调用）

**代码（逐字）**：

```csharp
var existing = _dbContext.HistoryRecords
    .Where(r => r.UserId == userId)
    .OrderByDescending(r => r.LastAccessed)
    .AsEnumerable()                                    // ← 到此为止都还没落库，下面在内存里做
    .Where(r => Path.GetFileName(r.TransferDataFile) == fileName
                && File.Exists(Profile.GetFullPath(_persistentDir, r.Type, r.Hash, r.TransferDataFile)))
    .Select(r => Profile.GetFullPath(_persistentDir, r.Type, r.Hash, r.TransferDataFile))
    .FirstOrDefault();
```

**影响**：`AsEnumerable()` 把「该用户的全部历史行」物化到内存后才做文件名匹配与 `File.Exists` 探测——
`GET /file/{name}` 是**每次下载**（客户端每取一次剪贴板数据）都会走的热路径，记录数上万时每次请求都要
反序列化整张表；同时这种写法无法使用 `TransferDataFile` 上的索引（该列也没有索引）。
功能正确（迁移实现逐条复刻了这个「文件缺失则回退到更旧同名记录」的语义，见 `docs/protocol.md` §4.2），
但成本与库规模成正比。

**复现**：把历史库灌到数万行，对 `GET /file/<某个真实文件名>` 计时；与
`SELECT ... WHERE TransferDataFile LIKE '%/' || ?` 的手写查询对比。

**建议修复**：把文件名匹配下推到 SQL（`Where(r => r.UserId == userId && r.TransferDataFile.EndsWith(fileName))`
不足以表达 basename 语义，可考虑新增一列 `TransferDataFileName` 存 basename 并建索引），
再用 `OrderByDescending(LastAccessed)` + 逐条 `File.Exists` 收敛为「取前 N 条候选」而不是全表。

---

## Issue 12 · 三处静默吞异常 / 全表物化导致的状态失真（低）

**严重度**：Low（不致命，但排障成本高：故障表现为「数字不对」而不是「报错」）
**位置与代码**：

| 位置 | 代码 | 后果 |
|---|---|---|
| `HistoryService.cs:662`（`GetStatisticsAsync`） | `catch { }` 包住目录体积枚举 | R2/目录读取失败时 `totalFileSizeMB` 静默变 0（客户端统计面板显示 0 MB，而记录仍在） |
| `HistoryService.cs:494`（`DeleteProfileData`） | `catch when (!token.IsCancellationRequested) { }` | 工作目录删除失败无任何日志；只能等 12 小时后的孤儿清理兜底 |
| `HistoryService.cs:558-560`（`ClearAllAsync`） | `ToListAsync()` 全表物化后再 `RemoveRange` | 清空历史时把**全部行（含 Text 正文与 FilePaths）**读进内存；`DELETE ... RETURNING`/分批删除可以避免 |

**建议修复**：三处都补最小可观测性（`logger.LogWarning` 带原因 + 计数），全表物化改为分批（与
`RemoveExpiredInBatchesAsync` 同款 BatchSize=500 的写法即可）。

---

## Issue 13 · 服务端仍是「单账号 + 硬编码用户 ID」形态（设计欠账，非缺陷）

**严重度**：Low（与产品定位一致，但挡住了多用户/按账号隔离的演进）
**位置**：`HistoryController.cs:20-21`（`// TODO: replace this hardcoded user id with actual user
identification from authentication/claims` + `HistoryService.HARD_CODED_USER_ID`）、
`Web.cs:29`（授权策略只有 `RequireAuthenticatedUser`）、`SyncClipboardHub.cs`（`Clients.All` 对所有人广播）

**影响**：`ICredentialChecker` 只有「一对用户名/口令」的语义（`StaticCredentialChecker`/`FileCredentialChecker`），
所有数据落在同一个 `UserId` 下；`Clients.All.RemoteHistoryChanged` 会把**任何**记录的变更推给**所有**已认证
连接。多人共用一个部署时无法隔离。另注意两处同名常量（`HistoryController.HARD_CODED_USER_ID` 与
`HistoryService.HARD_CODED_USER_ID`）必须保持同值，改名时容易漏一处。

**建议修复**：把凭据换成「账号表 + 按账号解析 UserId」，Hub 改用 `Clients.User(connectionId)`/分组广播；
在文档中显式写明「单账号单空间」是当前设计边界（本项目已在 README「已知限制」里声明同一语义）。

---

## Issue 14 · 并发更新会被静默覆盖，且数据库层没有任何唯一约束兜底

**严重度**：Medium（多副本/多进程共享同一 `history.db` 时丢更新与产生重复行；单进程部署不受影响，但两个缺陷都只靠进程内状态遮掩）
**位置**：`src/SyncClipboard.Server.Core/Services/History/HistoryService.cs:19`（`_processSem`）、`:33-83`（`Update`）、`:182-209`（`AddProfile`）；
`src/SyncClipboard.Server.Core/Utilities/History/HistoryDbContext.cs:38-55`；`src/SyncClipboard.Server.Core/Migrations/20251105014242_Init.cs:40-58`

**代码（逐字）**：

```csharp
// HistoryService.cs:19 —— 进程内静态信号量：同一进程的多个 scope 共享，但跨进程/跨副本无效
private static readonly SemaphoreSlim _processSem = new(1, 1);

// HistoryService.cs:43-82 —— Update：读 → 判定 → 改字段 → SaveChanges，全程只被上面那把锁保护
var existing = await Query(userId, type, hash, token);
...
if (!shouldUpdate) { return (false, HistoryRecordDto.FromEntity(existing)); }
...
existing.LastModified = dto.LastModified.Value.UtcDateTime;
existing.Version = dto.Version.Value;
await _dbContext.SaveChangesAsync(token);      // ← 无条件覆盖，不检查期间是否已被他人修改

// HistoryService.cs:192-207 —— AddProfile 的「查无 → 插入」，同样只有进程内锁
var existing = await Query(userId, type, hash, token);
if (existing is not null) { ... return; }
await _dbContext.HistoryRecords.AddAsync(entity, token);   // ← 无 DB 层唯一约束
```

数据库侧只有主键，**没有**任何针对 `(UserId, Type, Hash)` 的约束（`Migrations/…_Init.cs:40-43` 只有
`table.PrimaryKey("PK_HistoryRecords", x => x.ID)`；`HistoryDbContext.cs:38-55` 的三个索引都不含 `Hash`）。

**影响**：

1. **丢更新**：`Update` 把乐观并发判定完全交给客户端提交的 `Version`/`LastModified`，服务端**不做**
   「我读到的版本是否仍未被改动」的检查。两个并发 PATCH（两个副本，或同一实例上的两轮竞态）可各自通过
   `ShouldUpdate` 再各自 `SaveChanges`，后写者静默覆盖前写者——**客户端 `OfficialAdapter.cs:323-337` 依赖 409 来发现冲突并重试，
   这条路径在多副本下不会触发**。
2. **重复行**：`AddProfile` 是典型的 check-then-act。进程内锁让它单进程安全，但一旦两个进程/副本
   共享同一个 `history.db`（容器编排把 SQLite 放在共享卷上是这类单文件部署最常见的误用），
   同一 hash 会被插入两行。此后 `Query` 用 `FirstOrDefaultAsync` **不保证取到哪一行**，
   而 `GetRecentTransferFile` 又按 `File.Exists` 逐条回退 ⇒ 客户端可能反复取到"另一行"的数据文件，
   形成反复下载/反复上传。**上游自己已有一次同主题修复**（提交 `e79a18d6`「修复：数据库并发问题」，
   在 `28c7e596` 之前），但那次只在客户端侧处理，服务端仍未加约束。

**复现（未实测，按代码语义推断）**：把 `server/data/history.db` 放在两个服务端实例共享的卷上，
并发对同一 hash 发两个 `PUT /SyncClipboard.json`，或对同一条记录发两个 `PATCH` → 前者产生重复行
（`SELECT COUNT(*) … GROUP BY UserId, Type, Hash` 出现 2），后者其中一个更新被静默丢弃。

**建议修复**：

1. **加唯一索引** `(UserId, Type, Hash)`（迁移），并把 `AddProfile` 的 check-then-act 改成
   「插入 → 捕获唯一冲突 → 转入已存在分支」（与上游 `UpdateExistingRecordDto` 的语义一致）。
2. **把乐观并发下推到 SQL**：`UPDATE … WHERE ID = @id AND Version = @readVersion`，按受影响行数判定冲突并返回 409
   ——这正是客户端已经在等的那条分支（`OfficialAdapter.cs:329` 读 `HistoryRecordUpdateDto` 抛
   `RemoteHistoryConflictException`），服务端目前却几乎不会触发它。
3. 若确定只支持**单实例**部署，则在文档中显式声明该前提（并说明共享 `history.db` 不受支持），
   而不是把正确性寄托在一把 `static` 信号量上。

**参考实现**：SyncClipboardCfServer 已落地上述 1 与 2
（`schema.sql:35` 的 `ux_h_user_type_hash`；`src/db.ts:151-182` 的唯一冲突合并、`:199-210` 的
`updateEntityIfVersion`），可作为 PR 的最小实现形态参考。

**与 Issue 8 的关系**：Issue 8 是"外部改动不可见"（缓存层），本条是"并发改动互相覆盖"（存储层）；
两者都是**服务端状态一致性**问题，但触发条件不同，建议分别提交。

---

## Issue 15 · 已删记录的本地数据在 30 天后被"只删行不删文件"，而负责删文件的那个 Job **通常抢不到**（客户端）

**严重度**：Medium-High（`EnableSyncHistory = true` 时敏感内容在盘上至少多留 7 天；关掉清理后可能永久遗留）
**位置**：`src/SyncClipboard.Core/Utilities/History/HistoryManager.cs:408-424`（`RemoveSoftDeletedOutOfDateRecords`）、
`:453-466`（`CleanupExpiredHistory` 的分派）、`:426-451`（`ClearDeletedHistoryData`，**会**删目录的那个）、
`:88-105`（`DeleteWorkingDirAsync`）、`:492-541`（`CleanupOrphanedHistoryFolders`）；
调度周期在 `src/SyncClipboard.Core/Utilities/Job/Job.cs:14-16`

**代码（逐字）**：

```csharp
// HistoryManager.cs:408-424 —— 30 天后硬删：只 RemoveRange，**没有** DeleteWorkingDirAsync
private async Task RemoveSoftDeletedOutOfDateRecords(CancellationToken token = default)
{
    ...
    var cutoffTime = DateTime.UtcNow.AddDays(-30);
    var toDeletes = _dbContext.HistoryRecords.Where(r => r.IsDeleted && r.LastModified < cutoffTime);
    if (!toDeletes.Any()) { return; }
    _dbContext.HistoryRecords.RemoveRange(toDeletes);
    await _dbContext.SaveChangesAsync(token);      // ← 行没了，工作目录还在
}

// :453-466 —— 历史同步开启时走上面那条分支，其余分支同理
public async Task CleanupExpiredHistory(CancellationToken token = default)
{
    if (!EnableCleanup) { return; }
    if (_runtimeHistoryConfig.EnableSyncHistory)
    {
        await RemoveSoftDeletedOutOfDateRecords(token);
        return;                                     // ← 到此为止
    }
    ...
}

// :426-451 —— 唯一"成对删除"的入口：删目录 + 删行。它的候选集比上面窄
public async Task ClearDeletedHistoryData(CancellationToken token = default)
{
    var deletedRecords = _dbContext.HistoryRecords
        .Where(r => r.IsDeleted && r.FilePath.Length > 0 && r.IsLocalFileReady)   // ← 额外两个条件
        .ToList();
    ...
    foreach (var record in deletedRecords) { ...; await DeleteWorkingDirAsync(record, token); }
    _dbContext.HistoryRecords.RemoveRange(deletedRecords);
    await _dbContext.SaveChangesAsync(token);
}
```

调度（`Job.cs:14-16`）：

```csharp
scheduler.AddJob<HistoryCleanupJob>(TimeSpan.FromMinutes(1));            // → CleanupExpiredHistory（硬删 30 天前的行）
scheduler.AddJob<DeletedHistoryDataCleanupJob>(TimeSpan.FromMinutes(5)); // → ClearDeletedHistoryData（删行 + 删目录）
scheduler.AddJob<OrphanedHistoryCleanupJob>(TimeSpan.FromHours(6));      // → CleanupOrphanedHistoryFolders（按目录名差集）
```

**影响**：两条硬删路径的候选集**互斥**——`ClearDeletedHistoryData` 要求 `IsDeleted && FilePath.Length > 0
&& IsLocalFileReady`，而 `RemoveSoftDeletedOutOfDateRecords` 只要 `IsDeleted && LastModified < now-30d`。
后者**每 1 分钟**跑一次、前者**每 5 分钟**一次 ⇒ 一条软删记录活到第 30 天时，几乎总是被**前者**先删行；
行一没，`ClearDeletedHistoryData` 的查询就再也命中不到它，**`DeleteWorkingDirAsync` 从未对它执行过**。

留下的目录只能靠 `CleanupOrphanedHistoryFolders` 回收，而它带两个额外条件（`:510` 的
`cutoffTime = now-7d`、`:521` 比 `dirInfo.CreationTime`）：
① 目录创建不足 **7 天**则不删 ⇒ 即使 30 天前建的目录早已过 7 天，"文件真正消失"也**至少被推迟到第 7 天之后**；
② `EnableCleanup` 为假时 `CleanupExpiredHistory` 直接早退（`:457-460`），该 Job 的 6 小时轮询仍在跑，
但用户以为"已经关了清理、也删干净了"；③ 目录被句柄占住（Windows 常见）时两处删除都只留一行日志。

净效果：**用户已经删掉（含"删除并想让它消失"的敏感剪贴板）的文件内容，在磁盘上比 UI 与文档所暗示的时间多留 7 天以上**。
注意本条的触发前提是"软删后满 30 天"——对**历史同步开启**（= 官方服务器用户）的路径，这是默认分支。

**复现（未实测，按代码语义推断）**：开历史同步 → 删除一条带数据文件的记录 →
把该记录的 `LastModified` 手工改到 31 天前（或直接用 `-30d` 构造数据）→ 触发 `HistoryCleanupJob` →
观察 DB 行已消失，而 `Env.HistoryFileFolder` 下对应工作目录**仍在**，直到 7 天窗口过后由 6 小时 Job 回收。

**建议修复**：

1. `RemoveSoftDeletedOutOfDateRecords` 改为**先删目录、再删行**（或直接复用 `RemoveHistoryNoLock` 的成对语义）
   ——这是最小且语义正确的修法。
2. 若要保持两个 Job 分工，则把它们之间的**时序依赖写成断言或注释**：`DeletedHistoryDataCleanupJob` 的周期
   必须**短于** `HistoryCleanupJob` 的硬删判定窗口，否则前者对本分支**永久不可达**。当前这条依赖没有任何守护。
3. `CleanupOrphanedHistoryFolders` 的 `CreationTime` 判据值得复核：用**目录创建时间**而非"记录删除时间"
   表达保留期，会让"删除后想尽快清除"的诉求落空；且 `CreationTime` 在部分平台/复制场景下的语义不稳。

**边界**：本机无 .NET SDK，**未运行**客户端，故为源码级推断。但"两个 Job 的候选集互斥"与"1min < 5min"
均可直接从上文代码读出，不依赖运行观察；`CleanupOrphanedHistoryFolders` 的兜底路径也已在文中给出，
故本条不是"文件必然永久残留"，而是"**兜底路径比预期晚 ≥7 天，且可被配置彻底切断**"。

---

## 复核记录：两个**被驳回**的候选（不要提 issue）

| 候选 | 为什么不成立 |
|---|---|
| 「`Web.cs:27-29` 只 `AddAuthentication("BasicAuthentication")` 而未设 `DefaultChallengeScheme`，因此 `[Authorize]` 拒绝时会抛 `No authenticationScheme was specified` → 500，`BasicAuthenticationHandler` 手写的 401 永远不生效」 | **驳回**。ASP.NET Core 的 `AuthenticationService` 在解析默认质询方案时的回退链是 `DefaultChallengeScheme ?? DefaultScheme`，而 `AddAuthentication("BasicAuthentication")` 设的正是 `DefaultScheme` ⇒ 质询会落到 `BasicAuthenticationHandler`，401 + `WWW-Authenticate` 正常生效。**官方文档依据**（2026-09-15 补引）：`AddAuthentication(IServiceCollection, String)` 的参数说明是 "The default scheme used as a **fallback for all other schemes**"，`AuthenticationOptions.DefaultScheme` 是 "Used as the **fallback default scheme for all the other defaults**"，而 `DefaultChallengeScheme` 才是 `ChallengeAsync` 的默认方案（[AddAuthentication](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.authenticationservicecollectionextensions.addauthentication?view=aspnetcore-8.0)、[AuthenticationOptions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.authenticationoptions?view=aspnetcore-8.0)）。**2026-09-15 已实测确认该驳回**：真上游 v3.2.0 服务端对未认证 `GET /api/version` 返回
**401 + `WWW-Authenticate: Basic realm="SyncClipboard"`**（`tools/ab-upstream-probe.ps1` 用例 1、`progress.md` §44），
与 `BasicAuthenticationHandler` 手写 401 的行为一致，**不存在**"401 变 500"。此前按「不主张」处理的原因是
本机无可用的上游服务端（该判断本身也已纠正：本机缺的只是 SDK，运行时与官方发布件都在）；`docs/protocol.md` §1/§10 对 401 的描述维持不变。若将来要做实证，用一条未认证的 `GET /api/version` 看状态码即可判定。 |
| 「`README_DOCKER.md:54` 让用户把配置挂到 `/app/appsettings.json`，而 `Dockerfile:17` 的 `--contentRoot` 是 `/app/data`，所以按文档挂载不生效、改密码无效」 | **驳回**。`Program.cs:48-74` 的 `EnsureAppSettingsExists` 在 `/app/data/appsettings.json` 不存在时，会从 `AppContext.BaseDirectory`（= `/app`，正是文档里的挂载点）**复制**该文件到 `/app/data/` 并 `configurationManager.AddJsonFile(...)` 显式加载 ⇒ 文档给的挂载路径恰好落在复制来源上，配置能生效。附带结论：镜像内的 `/app/appsettings.json`（占位口令）会被复制成运行时配置——这是 Issue 1 的另一条触发路径，而不是「文档无效」。 |

---

## 待实测，暂不主张的候选（可提，但先要有证据）

与上面「被驳回」不同：这些候选**可能成立**，但本环境**无法在不运行上游服务端的情况下判定**，
按本仓纪律（ADR D10：「凡属推断的行为都必须有一次真上游实测」）暂不进 issue 稿。
拿得到上游实例时，按下表的判定方式各测一次即可定性。

| 候选 | 为什么现在不能主张 | 可判定的实测方式 |
|---|---|---|
| `SyncClipboardController.cs:87-103` 的 `GetFileFromFolder` **没有**调用 `InvalidFileName`（`:22-25`），而 `PutFileToFolder`（`:108`）调用了 | 编码后的路径形态是否真能绕过守卫，取决于 ASP.NET Core 对路由值的路径归一化与 `File.Exists` 的组合行为；纯读代码无法确定 `%2e%2e`（解码为 `..`）能否落到 `Path.Combine(folder, fileName)` 之外的路径上 | 对上游发 `GET /file/%2e%2e%2fSyncClipboard.json`（及其变体 `%252e`、`..%5c`），看是否 200 且返回内容；同时对照 `GET /file/..%2f..%2fSyncClipboard.json` |
| `SyncClipboardController.cs:99-102` 把内部异常（磁盘/权限）映射成 **400** 且回显 `ex.Message` | 属"错误语义不精确 + 信息泄露"，是否算 issue 取决于上游的接收口径；需要先确认异常消息里是否真的带路径 | 把 `server/history` 目录 `chmod 000`（或占用目标文件句柄）后请求 `GET /file/<真实文件名>`，看状态码与响应体 |
| `HistoryController.cs:66` 的 `File(stream, contentType, fileName)` 是否会把含 CR/LF 的 `fileName` 写进 `Content-Disposition` 而抛错 | ASP.NET 的 `FileResult`/`ContentDispositionHeaderValue` 未必像 Workers 的 `new Response(...)` 那样严格；本仓 `protocol.md` 的"不属于上游问题"表已把这条记为**未验证** | 以 `POST /api/history` 上传一个 `text`（= 文件名）含 `%0d%0a` 的记录，再 `GET /api/history/{id}/data`，看是否 500 |

---

## 附：**不**属于上游问题的项（避免误提 issue）

以下问题只在 SyncClipboardCfServer 出现，上游没有对应实现或反而更严，**不要**作为上游 issue 提交：

| 问题 | 为什么与上游无关 |
|---|---|
| 登录页 `?next=` 开放重定向 | 上游 `Server.Core` 无 Web UI 与登录页（检索 `Cookie|Session|HtmlContent|text/html|Razor` 零命中） |
| `/ui/api/*` 无来源校验（CSRF 纵深防御） | 上游无 Cookie 会话、也无状态变更型 UI 端点 |
| 注销不吊销会话令牌 | 上游根本没有会话/令牌概念（只有无状态 Basic） |
| PATCH `version` / PUT `size` 缺校验 | **上游更严**：`HistoryRecordUpdateDto.cs:8` 为 `int?`、`ProfileDto.cs:15` 为 `long?`，模型绑定直接 400 |
| 清理任务跑不完 / 失败静默 | 上游 `HistoryCleaner.cs` 无批量上限、`while` 循环 + `logger.LogError` + 下轮重试；该缺陷由 cfserver 引入的分批上限与无 catch 造成 |
| multipart 分界串朴素查找（O(体×分界串)） | 上游用框架的 multipart 解析器，不存在该实现 |
| CRLF 的 dataName 导致 `/data` 500 | 上游走 `HistoryController.cs:66` 的 `File(stream, contentType, fileName)`，由 ASP.NET 写响应头；**本轮未验证**上游是否同样报错，故不作主张 |
