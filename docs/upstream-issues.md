# 上游 SyncClipboard 缺陷清单（可直接提 issue 的 15 条）

> **精简介**：本节起为 2026-10-04 的整篇重写（原文 529 行）；历史版本见
> `git show <hash>:docs/upstream-issues.md`：重写前最近一版 `e88599f`，初版见
> `git show --diff-filter=A --format=%h -- docs/upstream-issues.md`。重写只改表述，
> 事实（`文件:行`、逐字代码、严重度、处置）逐条照上游源码与 `docs/protocol.md` §10 复核。

**这份文件是什么**：一份可以直接拆成上游 issue 的缺陷清单 —— 对象是上游
[SyncClipboard](https://github.com/Jeric-X/SyncClipboard) 的 C# / ASP.NET Core 服务端
（本地路径 `C:/Users/leeexx/Documents/NewProject/SyncClipboard`）。上游 3.3.0 时代，行号按
`984d3463` 附近核对。

**它不是**什么：`upstream-defects.md` 回答的是"上游的这个问题在本实现里怎么处置"
（含**有意复刻**的契约类行为，那些不是 issue）；本实现自身的问题见
[README 的安全机制](../README.md#安全机制) 与现行回归测试。历史安全审计过程已移出工作树。

**核实方式**：只读通读上游源码，逐条给出 `文件:行` 与逐字代码；**未运行**上游服务端。
因此凡"影响"是按代码语义的推断，未实测处逐一标注；已用官方发布件 A/B 实测过的项标
**[A/B 实测]**。复现步骤可执行，但本环境没有 .NET SDK。

**建议提交方式**：按主题拆成若干 issue，标签 `security` + `Area-Server`；
Issue 15 属客户端，标签改用 `Area-Client` + `privacy`。

---

## 速查表

| # | 问题 | 严重度 | 上游位置 | 本实现状态 |
|---|---|---|---|---|
| 1 | 缺配置时回退 `admin/admin`，随仓配置用可猜占位凭据 | Critical | `FileCredentialChecker.cs:5-15` | 不复刻：fail-closed + 弱凭据告警 |
| 2 | 认证失败路径无限速 / 计数 / 锁定 | High | `Server.Core/` 全目录零命中 | 不复刻：DO 权威计数 + 封锁 |
| 3 | 默认明文 HTTP 监听所有网卡，无 HSTS | High | `Web.cs:108-117` | 平台层天然 TLS（边缘强制） |
| 4 | Kestrel 请求体上限被设成 `int.MaxValue` | Medium | `Web.cs:25` | 不复刻：`[256 KiB, 64 MiB]` 区间上限 |
| 5 | Group zip 解压无体积 / 条目数 / 压缩比上限 | Medium | `GroupProfile.cs:609-655` | 不复刻：三层上限 + 预算随体收缩 |
| 6 | 凭据比较非常量时间 | Low | `FileCredentialChecker.cs:14` | 不复刻：`safeEqual` 定长字节比较 |
| 7 | 只有软删，无"单条立即彻底清除"入口 | Low（设计取舍） | `HistoryService.cs:516-564` | 提供：恢复 + 彻底删除 + 清空回收站 |
| 8 | 当前 Profile 内存缓存永不失效（key 不是同一个） | Medium | `SyncClipboardController.cs:118/125-126` | 不复刻：无缓存，D1/R2 直读 |
| 9 | 孤儿目录清理：单条删除失败中断整轮 | Low-Medium | `HistoryService.cs:685-719` | 不复刻：逐条隔离 + 预算截断续跑 |
| 10 | `MaxSavedHistoryCount` 在收藏+置顶占满时不收敛且无告警 | Low-Medium | `HistoryService.cs:579-580` | 不复刻：超限落日志 + 页面写明豁免 |
| 11 | `GET /file/{name}` 每次把该用户全部历史行拉进内存 | Low-Medium | `HistoryService.cs:211-230` | 不复刻：SQL 下推 + 索引 |
| 12 | 三处静默吞异常 / 全表物化 | Low | `HistoryService.cs:494/558-560/662` | 不复刻：可观测 + 分批 |
| 13 | 单账号 + 硬编码 UserId（设计欠账） | Low（非缺陷） | `HistoryController.cs:20-21` | 同构：单账号；已在 README 声明 |
| 14 | 并发更新静默覆盖，DB 层无唯一约束 | Medium | `HistoryService.cs:19/33-83/182-209` | 不复刻：唯一索引 + 版本化 UPDATE |
| 15 | （客户端）硬删只删行不删文件，删文件的 Job 抢不到 | Medium-High | `HistoryManager.cs:408-466` | 不适用（服务端） |

---

## Issue 1 · 服务端在缺少配置时回退到内置 `admin/admin`，且随仓配置使用可预测占位凭据

**严重度**：Critical（默认部署即可被接管）
**位置**：`src/SyncClipboard.Server.Core/CredentialChecker/FileCredentialChecker.cs:5-15`、
`src/SyncClipboard.Server/appsettings.json`

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

**影响**：Basic Auth 是服务端唯一认证手段。(a) 配置节缺失（例如用环境变量部署却没设
`AppSettings__UserName`）时凭据直接退化为 `admin/admin`；(b) 即便按随仓配置启动，凭据也是
一眼可猜的占位值。两者叠加默认监听所有网卡（Issue 3）即"公网可读全部剪贴板历史与附件"。

**复现**：以不含 `AppSettings` 节的配置启动，用 `admin:admin` 请求 `GET /SyncClipboard.json`
→ 返回内容而非 401。

**建议修复**：① 去掉代码级回退，配置缺失时 **fail-closed**（启动报错或一律鉴权失败）并打印明确错误；
② 随仓配置不放可用凭据，首次启动生成随机口令写入本地配置并一次性提示；
③ 增加弱凭据拒绝（`admin`、`your_username`、`your_password`、`password` 等命中即拒绝启动）。

> 不主张的部分：`your_username` 的实际部署效果取决于部署者改没改；(a) 与部署方式无关。

---

## Issue 2 · 认证失败路径没有任何速率限制 / 失败计数 / 锁定

**严重度**：High（弱口令可在线爆破，叠加上唯一的认证因子）
**位置**：`src/SyncClipboard.Server.Core/`（全目录检索 `AddRateLimiter|RateLimiter|lockout|MaxFailedAccessAttempts` **零命中**）

**影响**：服务端只有 Basic Auth，而失败路径不计数、不延迟、不锁定 ⇒ 在线猜测成功率只取决于口令熵。
配合默认/占位凭据等于没有防护。

**复现**：对 `GET /api/version` 连发 N 次错凭据 → 全部 401，无 429、无 `Retry-After`、无递增延迟。

**建议修复**：① `AddRateLimiter` 按 IP + 凭据维度限流；② 失败 N 次后指数退避 / 临时锁定并记审计日志；
③ 文档写明"公网暴露 + 弱口令"的后果。

---

## Issue 3 · 默认以明文 HTTP 监听所有网卡；仅显式配置证书时才用 HTTPS，且全项目无 HSTS

**严重度**：High（Basic 凭据与剪贴板正文在链路上明文传输）
**位置**：`src/SyncClipboard.Server/appsettings.json`、`src/SyncClipboard.Server.Core/Web.cs:108-117`
（检索 `UseHsts` 零命中）

```jsonc
"Kestrel": { "Endpoints": { "http": { "Url": "http://*:5033" },
                            //"https": { "Url": "https://*:5033" } } },
"AllowedHosts": "*"
```

`Web.cs:114` 的 `options.UseHttps()` 只在配置了证书（`Kestrel:Certificates:Default`）时执行；
全项目没有 `UseHsts()`，也没有明文→https 跳转。

**影响**：按随仓配置启动即在**所有网卡**上以明文提供 Basic Auth ⇒ 同链路的任何人都能读走
剪贴板正文、附件与 Basic 凭据本身（可重放）。放在反向代理后、而代理未强制 TLS 时同样成立。

**复现**：按随仓配置启动，`curl -I http://<局域网IP>:5033/` → 无重定向；响应无 `Strict-Transport-Security`。

**建议修复**：① 默认只监听 `127.0.0.1`，对外暴露必须是显式选择；② 加 `UseHsts()`，
有证书时把明文 301 到 https；③ 文档把"公网部署必须 TLS"写成硬性要求。

---

## Issue 4 · Kestrel 请求体上限被显式设为 `int.MaxValue`

**严重度**：Medium（单请求即可造成内存 / 带宽放大）
**位置**：`src/SyncClipboard.Server.Core/Web.cs:25`

```csharp
services.Configure<KestrelServerOptions>(options => options.Limits.MaxRequestBodySize = int.MaxValue);
```

**影响**：Kestrel 默认 30 MB 的体量保护被**主动移除**。任何人对上传端点
（`PUT /SyncClipboard.json`、`POST /api/history` 等）发超大请求，服务端会把整包读进内存/磁盘
→ 内存压力、磁盘写满、拖垮实例。与 Issue 2 叠加（无限速）更易触发。

**复现**：`curl -X PUT --data-binary @large.bin -u admin:admin http://host:5033/SyncClipboard.json`，
观察内存/磁盘随体积线性增长。

**建议修复**：按端点上限定值并对超限返回 413；确需大文件时用流式 + 配额，而不是取消全局上限。

---

## Issue 5 · Group（zip）解压无体积 / 条目数上限，压缩比可被放大 ~1000 倍

**严重度**：Medium（小体积请求即可物化巨量数据 → 内存 / 磁盘耗尽）
**位置**：`src/SyncClipboard.Shared/Profiles/GroupProfile.cs:609-655`（`ExtractArchiveEntriesAsync`）

该方法**有**路径穿越守卫（`:621-624` 用 `destPath.StartsWith(extractPath)` 拒绝逃逸条目），
但**没有任何体积或条目数上限**：全文件检索 `MaxLength|MaxSize|EntryCount|上限` 均零命中；
逐条目复制 `entryStream.CopyToAsync(destStream, 81920, token)` 里的 `81920` 是缓冲区大小、不是上限。

**影响**：Group 上传的 zip 在服务端被完整解压，且**在哈希校验通过之前**就已付出解压代价 ⇒
高压缩比 zip（实测 65.7 KB → 64 MB，约 1000:1）即可让小请求物化出远超上传体积的数据；
条目数同样无上限（数万条目逐个 SHA-256）。

**复现**：构造 zero-filled 大文件的 zip（压缩比 ≥1000:1），以 Group 类型上传 →
观察服务端解压后的物化体积与耗时。

**建议修复**：① 解压前检查 `entry.Length` 之和与条目数上限（例如总量 ≤ `上传体积 × 20` 且 ≤ 固定上限，
条目 ≤ 1000）；② 先校验声明 hash 与 zip 内容一致再解压；③ 逐条目流式处理、边解压边计数、超限立即中止。

---

## Issue 6 · 凭据比较使用非常量时间比较（次要加固）

**严重度**：Low（远程时序攻击在 HTTP 上通常不实用）
**位置**：`FileCredentialChecker.cs:14`（`return name == configUserName && password == configPassword;`）、
`StaticCredentialChecker.cs:11`（同型）

**影响**：字符串比较在首个不同字符处短路，理论上提供逐字节的时序侧信道。实际可利用性受网络抖动限制，
但在内网 / 同机场景下有讨论价值。

**建议修复**：用 `CryptographicOperations.FixedTimeEquals`，长度不同也走固定路径。

---

## Issue 7 · 设计层：删除是软删，无"单条立即彻底清除"入口（保留期内的明文仍在库）

**严重度**：Low（与产品文档一致，但影响"误发敏感内容后想立即销毁"）
**位置**：`HistoryService.cs:516-530`（`RemoveOutOfDateDeletedRecords`）、`:538-564`（`RemoveOutOfRetentionRecords`）、
`HistoryCleaner.cs:28-64`（两个循环 + `Task.Delay(10min/12h)`）

**现状**：`IsDeleted=1` 只是软删，30 天后由清理任务硬删；`ClearAllAsync` 是"全清"而非"单条彻底清除"。

> **2026-09-22 增补**：上游 3.3.0（#402/#426）把 `HistoryRetentionMinutes` 默认值改成 **`0` = 不限制** ——
> "保留期内的明文仍在库"的窗口从 7 天变成**默认无上限**（只有条数上限 1000 兜底）。

**建议**：在 UI/API 增加"彻底删除此条（不可恢复）"入口（行 + 数据文件双清），
或把"删除"在 UI 上明确标注为"标记删除，30 天后清除"。

**说明**：本条是**设计取舍**而非缺陷，故列最后。

---

## Issue 8 · 当前 Profile 的内存缓存永不失效（失效语句用的 key 与读写的 key 不是同一个）

**严重度**：Medium（外部改动不可见；共享卷 / 手工修复 / 备份恢复场景下长期提供过期剪贴板）
**位置**：`src/SyncClipboard.Server.Core/Controllers/SyncClipboardController.cs`

```csharp
// :118  —— PUT /file/{fileName} 里想「使当前 profile 缓存失效」
_cache.Remove("SyncClipboard.json");

// :125-126 —— GET /SyncClipboard.json 真正的 key 是**绝对路径**
var profilePath = Path.Combine(_serverEnv.GetDataRootPath(), "SyncClipboard.json");
var cacheKey = profilePath;
// :136 / :148 / :152 / :226 —— 读写的都是 cacheKey
_cache.Set(cacheKey, dto);
```

**影响**：(a) `:118` 的 `Remove` 永远删不到东西（key 是字面量而非 `profilePath`）——
它要表达的「暂存目录变化后重新读 profile」**从未生效**；(b) 缓存项 `Set` 不带任何过期策略，
因此文件被**进程外改动**时（两个容器共享同一 `/app/data` 卷、手工编辑 `server/SyncClipboard.json`、
从备份恢复）服务端会一直返回内存里的旧值，直到进程重启或下次 `SaveAndNotifyCurrentProfile`（`:226`）。

**复现**：启动 → `GET /SyncClipboard.json`（被缓存）→ 直接改 `server/SyncClipboard.json` →
再 `GET` → 返回值不变。

**建议修复**：让失效语句用同一个 key（把 `cacheKey` 的构造提成方法/属性，或按 Profile 语义包一层），
并按"文件是唯一事实源"加短 TTL（1–5 s）或改用 `FileSystemWatcher` / `IChangeToken`。

---

## Issue 9 · 孤儿目录清理：单个目录删除失败会中断整轮，剩余孤儿要等下个周期

**严重度**：Low-Medium（孤儿目录堆积；12 小时周期内不再重试）
**位置**：`HistoryService.cs:685-719`（`CleanOrphanedFolders`）

```csharp
foreach (var directory in directories)
{
    token.ThrowIfCancellationRequested();
    ...
    if (entity is null || entity.IsDeleted)
    {
        Directory.Delete(directory, true);   // ← :717 无 try/catch
    }
}
```

**影响**：`Directory.Delete` 在目标被占用 / 权限不足 / 路径超长时抛异常，`CleanOrphanedFolders`
直接向上抛，被 `HistoryCleaner` 的外层 catch 记一条日志后**本轮结束** —— 循环里它后面的目录本轮不再处理。
与同类路径（`DeleteProfileData` 用 `catch when (!token.IsCancellationRequested) { }` 明确吞掉）处置不一致。

**复现**：在 `server/history/` 下造两个无活记录引用的目录，其中一个用句柄占住（Linux 上 `chmod 500`）→
触发清理 → 日志只有一条异常，另一个可删目录仍在。

**建议修复**：逐目录 try/catch + 失败计数，把失败写进日志；或收集失败列表在轮末汇总。

---

## Issue 10 · `MaxSavedHistoryCount` 在「收藏 + 置顶占满配额」时永远不收敛，且无告警

**严重度**：Low-Medium（"最多 N 条"实际不成立；磁盘 / DB 无界增长）
**位置**：`HistoryService.cs:579-580`（两个判定表达式不一致）+ `HistoryManagerHelper.cs:27-42`

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

**影响**：计数用"全部活跃"，待删集排除收藏/置顶 ⇒ 当 `starred + pinned ≥ MaxSavedHistoryCount` 时
`batch` 恒空、循环 break，**活跃行数永远超过配置上限**且日志无提示。
`GET /api/history/statistics` 仍照实报 `totalCount > maxSavedHistoryCount`，用户看到"配置 1000、实际 3000"
而没有任何解释。

**复现**：把上限设为 2、收藏 3 条，再新增若干普通记录 → 活跃数持续增长，日志无裁剪失败提示。

**建议修复**：至少记一条日志；更好的做法是让上限服从豁免（按 `maxCount + 豁免数` 判定）或文档写明关系。

---

## Issue 11 · `GET /file/{fileName}` 每次都把该用户的全部历史行拉进内存

**严重度**：Low-Medium（请求成本随历史库规模线性增长；可被反复调用）
**位置**：`HistoryService.cs:211-230`（`GetRecentTransferFile`，由 `SyncClipboardController.cs:96` 调用）

```csharp
var existing = _dbContext.HistoryRecords
    .Where(r => r.UserId == userId)
    .OrderByDescending(r => r.LastAccessed)
    .AsEnumerable()                                    // ← 到此为止都还没落库
    .Where(r => Path.GetFileName(r.TransferDataFile) == fileName
                && File.Exists(Profile.GetFullPath(_persistentDir, r.Type, r.Hash, r.TransferDataFile)))
    .Select(r => Profile.GetFullPath(_persistentDir, r.Type, r.Hash, r.TransferDataFile))
    .FirstOrDefault();
```

**影响**：`AsEnumerable()` 把该用户**全部历史行**物化到内存后才做文件名匹配与 `File.Exists` 探测。
`GET /file/{name}` 是每次下载（客户端每次取剪贴板数据）都走的热路径，记录数上万时每次请求都要
反序列化整张表；这种写法也用不上 `TransferDataFile` 上的索引（该列也没有索引）。
功能正确（"文件缺失则回退到更旧同名记录"的语义本实现逐条复刻，见 [`protocol.md`](protocol.md) §4.2），
但成本与库规模成正比。

**复现**：把历史库灌到数万行，对 `GET /file/<真实文件名>` 计时；与手写
`SELECT ... WHERE TransferDataFile LIKE '%/' || ?` 对比。

**建议修复**：把文件名匹配下推到 SQL（basename 语义可考虑新增 `TransferDataFileName` 列并建索引），
再用 `OrderByDescending(LastAccessed)` + 逐条 `File.Exists` 收敛为"取前 N 条候选"。

---

## Issue 12 · 三处静默吞异常 / 全表物化导致状态失真

**严重度**：Low（不致命，但排障成本高：故障表现为"数字不对"而不是"报错"）

| 位置 | 代码 | 后果 |
|---|---|---|
| `HistoryService.cs:662`（`GetStatisticsAsync`） | `catch { }` 包住目录体积枚举 | 读取失败时 `totalFileSizeMB` 静默变 0（面板显示 0 MB，而记录仍在） |
| `HistoryService.cs:494`（`DeleteProfileData`） | `catch when (!token.IsCancellationRequested) { }` | 工作目录删除失败无任何日志；只能等 12 小时后的孤儿清理兜底 |
| `HistoryService.cs:558-560`（`ClearAllAsync`） | `ToListAsync()` 全表物化后再 `RemoveRange` | 清空历史时把全部行（含 Text 正文与 FilePaths）读进内存 |

**建议修复**：三处都补最小可观测性（`LogWarning` 带原因 + 计数）；全表物化改分批
（与 `RemoveExpiredInBatchesAsync` 同款 `BatchSize=500`）。

---

## Issue 13 · 服务端仍是「单账号 + 硬编码用户 ID」形态（设计欠账，非缺陷）

**严重度**：Low（与产品定位一致，但挡住多用户 / 按账号隔离的演进）
**位置**：`HistoryController.cs:20-21`（`// TODO: replace this hardcoded user id...` +
`HistoryService.HARD_CODED_USER_ID`）、`Web.cs:29`（授权策略只有 `RequireAuthenticatedUser`）、
`SyncClipboardHub.cs`（`Clients.All` 对所有人广播）

**影响**：`ICredentialChecker` 只有"一对用户名/口令"的语义，所有数据落在同一个 `UserId` 下；
`Clients.All.RemoteHistoryChanged` 把**任何**记录的变更推给**所有**已认证连接。多人共用一个部署时无法隔离。
另注意两处同名常量（`HistoryController.HARD_CODED_USER_ID` 与 `HistoryService.HARD_CODED_USER_ID`）
必须保持同值，改名时容易漏一处。

**建议修复**：凭据换成"账号表 + 按账号解析 UserId"，Hub 改用 `Clients.User` / 分组广播；
文档显式写明"单账号单空间"是当前边界。

---

## Issue 14 · 并发更新会被静默覆盖，且数据库层没有任何唯一约束兜底

**严重度**：Medium（多副本 / 多进程共享同一 `history.db` 时丢更新与产生重复行）
**位置**：`HistoryService.cs:19`（`_processSem`）、`:33-83`（`Update`）、`:182-209`（`AddProfile`）、
`Utilities/History/HistoryDbContext.cs:38-55`、`Migrations/20251105014242_Init.cs:40-58`

```csharp
// :19 —— 进程内静态信号量：同进程多个 scope 共享，跨进程 / 跨副本无效
private static readonly SemaphoreSlim _processSem = new(1, 1);

// :43-82 —— Update：读 → 判定 → 改字段 → SaveChanges，全程只被上面那把锁保护
var existing = await Query(userId, type, hash, token);
...
if (!shouldUpdate) { return (false, HistoryRecordDto.FromEntity(existing)); }
existing.LastModified = dto.LastModified.Value.UtcDateTime;
existing.Version = dto.Version.Value;
await _dbContext.SaveChangesAsync(token);      // ← 无条件覆盖，不检查期间是否已被他人修改

// :192-207 —— AddProfile 的「查无 → 插入」，同样只有进程内锁
var existing = await Query(userId, type, hash, token);
if (existing is not null) { ...; return; }
await _dbContext.HistoryRecords.AddAsync(entity, token);   // ← 无 DB 层唯一约束
```

数据库侧只有主键，**没有**任何针对 `(UserId, Type, Hash)` 的约束
（`Migrations/…_Init.cs:40-43` 只有 `table.PrimaryKey("PK_HistoryRecords", x => x.ID)`；
`HistoryDbContext.cs:38-55` 的三个索引都不含 `Hash`）。

**影响**：

1. **丢更新**：`Update` 把乐观并发判定完全交给客户端提交的 `Version`/`LastModified`，服务端**不做**
   "我读到的版本是否仍未被改动"的检查。两个并发 PATCH 可各自通过 `ShouldUpdate` 再各自 `SaveChanges`，
   后写者静默覆盖前写者 —— 而客户端 `OfficialAdapter.cs:323-337` 正**依赖 409** 来发现冲突并重试，
   这条路径在多副本下不会触发。
2. **重复行**：`AddProfile` 是典型的 check-then-act。进程内锁让它单进程安全，但两个进程 / 副本共享
   同一个 `history.db`（容器编排把 SQLite 放共享卷上是这类单文件部署最常见的误用）时，同一 hash 会被
   插入两行。此后 `Query` 的 `FirstOrDefaultAsync` **不保证取到哪一行**，而 `GetRecentTransferFile` 又按
   `File.Exists` 逐条回退 ⇒ 客户端可能反复取到"另一行"的数据文件，形成反复下载 / 反复上传。
   上游自己已有一次同主题修复（提交 `e79a18d6`），但那次只在客户端侧处理，服务端仍未加约束。

**复现（未实测，按代码语义推断）**：把 `server/data/history.db` 放在两个实例共享的卷上，并发对同一 hash
发两个 `PUT`，或对同一条记录发两个 `PATCH` → 前者产生重复行，后者其中一个更新被静默丢弃。

**建议修复**：① 加唯一索引 `(UserId, Type, Hash)`，并把 `AddProfile` 的 check-then-act 改成
"插入 → 捕获唯一冲突 → 转入已存在分支"；② 把乐观并发下推到 SQL
（`UPDATE … WHERE ID = @id AND Version = @readVersion`，按受影响行数返回 409）——这正是客户端在等的分支；
③ 若确定只支持单实例，就在文档里显式声明该前提，而不是把正确性寄托在一把 `static` 信号量上。

> **与 Issue 8 的关系**：8 是"外部改动不可见"（缓存层），14 是"并发改动互相覆盖"（存储层）。
> 都是服务端状态一致性问题，但触发条件不同，建议分别提交。

---

## Issue 15 ·（客户端）已删记录的本地数据在 30 天后被"只删行不删文件"，而负责删文件的 Job 通常抢不到

**严重度**：Medium-High（`EnableSyncHistory = true` 时敏感内容在盘上至少多留 7 天）
**位置**：`src/SyncClipboard.Core/Utilities/History/HistoryManager.cs:408-424`
（`RemoveSoftDeletedOutOfDateRecords`）、`:453-466`（`CleanupExpiredHistory` 的分派）、
`:426-451`（`ClearDeletedHistoryData`，**会**删目录的那个）、`:88-105`（`DeleteWorkingDirAsync`）、
`:492-541`（`CleanupOrphanedHistoryFolders`）；调度周期在 `Utilities/Job/Job.cs:14-16`

```csharp
// :408-424 —— 30 天后硬删：只 RemoveRange，**没有** DeleteWorkingDirAsync
var cutoffTime = DateTime.UtcNow.AddDays(-30);
var toDeletes = _dbContext.HistoryRecords.Where(r => r.IsDeleted && r.LastModified < cutoffTime);
if (!toDeletes.Any()) { return; }
_dbContext.HistoryRecords.RemoveRange(toDeletes);
await _dbContext.SaveChangesAsync(token);      // ← 行没了，工作目录还在

// :453-466 —— 历史同步开启时走上面那条分支
public async Task CleanupExpiredHistory(CancellationToken token = default)
{
    if (!EnableCleanup) { return; }
    if (_runtimeHistoryConfig.EnableSyncHistory) { await RemoveSoftDeletedOutOfDateRecords(token); return; }
    ...
}

// :426-451 —— 唯一"成对删除"的入口，候选集比上面窄（多了 FilePath.Length > 0 && IsLocalFileReady）
.Where(r => r.IsDeleted && r.FilePath.Length > 0 && r.IsLocalFileReady)
```

调度（`Job.cs:14-16`）：

```csharp
scheduler.AddJob<HistoryCleanupJob>(TimeSpan.FromMinutes(1));            // 硬删 30 天前的行
scheduler.AddJob<DeletedHistoryDataCleanupJob>(TimeSpan.FromMinutes(5)); // 删行 + 删目录
scheduler.AddJob<OrphanedHistoryCleanupJob>(TimeSpan.FromHours(6));      // 按目录名差集
```

**影响**：两条硬删路径的候选集**互斥** —— `ClearDeletedHistoryData` 要求
`IsDeleted && FilePath.Length > 0 && IsLocalFileReady`，而 `RemoveSoftDeletedOutOfDateRecords` 只要
`IsDeleted && LastModified < now-30d`。后者**每 1 分钟**跑、前者**每 5 分钟**一次 ⇒ 一条软删记录活到
第 30 天时几乎总是被**前者**先删行；行一没，`ClearDeletedHistoryData` 再也命中不到它，
**`DeleteWorkingDirAsync` 从未对它执行过**。

留下的目录只能靠 `CleanupOrphanedHistoryFolders` 回收，而它带两个额外条件（`:510` 的
`cutoffTime = now-7d`、`:521` 比 `dirInfo.CreationTime`）：① 目录创建不足 **7 天**则不删 ⇒ 文件真正消失
**至少被推迟到第 7 天之后**；② `EnableCleanup` 为假时 `CleanupExpiredHistory` 直接早退，而该 Job 的
6 小时轮询仍在跑，用户却以为"已经关了清理、也删干净了"；③ 目录被句柄占住（Windows 常见）时两处删除都只留一行日志。

净效果：**用户已经删掉（含"删除并想让它消失"的敏感剪贴板）的文件内容，在磁盘上比 UI 与文档暗示的时间
多留 7 天以上**。触发前提是"软删后满 30 天"——对历史同步开启（= 官方服务器用户）的路径，这是默认分支。

> **2026-09-22 增补**：上游 3.3.0 把**服务端**保留期默认改成 `0` = 不限制（#402/#426），
> 但**客户端**这条 `RemoveSoftDeletedOutOfDateRecords` 的周期与"至少多留 7 天"的窗口**未变**
> （它管的是客户端本地盘）。服务端默认不再按时间清理后，"关掉清理后可能永久遗留"从
> "用户主动关"变成"上游默认"。

**复现（未实测，按代码语义推断）**：开历史同步 → 删除一条带数据文件的记录 → 把该记录的
`LastModified` 改到 31 天前 → 触发 `HistoryCleanupJob` → 观察 DB 行已消失而
`Env.HistoryFileFolder` 下对应工作目录**仍在**，直到 7 天窗口过后由 6 小时 Job 回收。

**建议修复**：① `RemoveSoftDeletedOutOfDateRecords` 改为**先删目录、再删行**（或直接复用
`RemoveHistoryNoLock` 的成对语义）——最小且语义正确的修法；② 若要保留两个 Job 的分工，把它们之间的
时序依赖写成断言或注释（`DeletedHistoryDataCleanupJob` 的周期必须**短于** `HistoryCleanupJob` 的硬删判定窗口），
当前这条依赖没有任何守护；③ `CleanupOrphanedHistoryFolders` 用**目录创建时间**表达保留期值得复核
（`CreationTime` 在部分平台 / 复制场景下语义不稳，且会让"删除后想尽快清除"落空）。

**边界**：本机无 .NET SDK，**未运行**客户端，故为源码级推断。但"两个 Job 的候选集互斥"与"1min < 5min"
可直接从上文代码读出，不依赖运行观察；兜底路径也已在文中给出 ⇒ 本条不是"文件必然永久残留"，
而是"**兜底路径比预期晚 ≥7 天，且可被配置彻底切断**"。

---

## 复核记录：两个被驳回的候选（**不要**提 issue）

| 候选 | 为什么不成立 |
|---|---|
| 「`Web.cs:27-29` 只 `AddAuthentication("BasicAuthentication")` 而未设 `DefaultChallengeScheme`，因此 `[Authorize]` 拒绝时会抛 `No authenticationScheme was specified` → 500」 | **驳回**。ASP.NET Core 解析默认质询方案的回退链是 `DefaultChallengeScheme ?? DefaultScheme`，而 `AddAuthentication("BasicAuthentication")` 设的正是 `DefaultScheme` ⇒ 质询落到 `BasicAuthenticationHandler`，401 + `WWW-Authenticate` 正常生效。**官方文档依据**：`AddAuthentication(IServiceCollection, String)` 的参数说明是 "The default scheme used as a **fallback for all other schemes**"，`AuthenticationOptions.DefaultScheme` 是 "Used as the **fallback default scheme for all the other defaults**"，而 `DefaultChallengeScheme` 才是 `ChallengeAsync` 的默认方案。**[A/B 实测]**：对官方发布件发一条未认证的 `GET /api/version` 得到 **401 + `WWW-Authenticate: Basic realm="SyncClipboard"`**（`tools/ab-upstream-probe.ps1` 用例 1、`docs/progress.md` §44），不存在"401 变 500"。 |
| 「`README_DOCKER.md:54` 让用户把配置挂到 `/app/appsettings.json`，而 `Dockerfile:17` 的 `--contentRoot` 是 `/app/data`，所以按文档挂载不生效、改密码无效」 | **驳回**。`Program.cs:48-74` 的 `EnsureAppSettingsExists` 在 `/app/data/appsettings.json` 不存在时，会从 `AppContext.BaseDirectory`（= `/app`，正是文档里的挂载点）**复制**该文件到 `/app/data/` 并 `AddJsonFile(...)` 显式加载 ⇒ 文档给的挂载路径恰好落在复制来源上，配置能生效。附带结论：镜像内的 `/app/appsettings.json`（占位口令）会被复制成运行时配置——这是 Issue 1 的另一条触发路径，而不是"文档无效"。 |

## 待实测、暂不主张的候选（可提，但先要有证据）

与上面"被驳回"不同：这些**可能成立**，但本环境**无法在不运行上游服务端的情况下判定**，
按本仓纪律（凡属推断的行为都必须有一次真上游实测）暂不进 issue 稿。拿得到上游实例时按下表各测一次即可定性。

| 候选 | 为什么现在不能主张 | 判定方式 |
|---|---|---|
| `SyncClipboardController.cs:87-103` 的 `GetFileFromFolder` **没有**调用 `InvalidFileName`（`:22-25`），而 `PutFileToFolder`（`:108`）调用了 | 编码后的路径形态能否绕过守卫取决于 ASP.NET Core 对路由值的路径归一化与 `File.Exists` 的组合行为；纯读代码无法确定 `%2e%2e`（解码为 `..`）能否落到 `Path.Combine(folder, fileName)` 之外 | 对上游发 `GET /file/%2e%2e%2fSyncClipboard.json`（及 `%252e`、`..%5c` 变体），看是否 200 且返回内容；对照 `GET /file/..%2f..%2fSyncClipboard.json` |
| `SyncClipboardController.cs:99-102` 把内部异常（磁盘 / 权限）映射成 **400** 且回显 `ex.Message` | 属"错误语义不精确 + 信息泄露"，是否算 issue 取决于上游接收口径；需先确认异常消息里是否真的带路径 | 把 `server/history` 目录 `chmod 000`（或占用目标文件句柄）后请求 `GET /file/<真实文件名>`，看状态码与响应体 |
| `HistoryController.cs:66` 的 `File(stream, contentType, fileName)` 是否会把含 CR/LF 的 `fileName` 写进 `Content-Disposition` 而抛错 | ASP.NET 的 `FileResult` / `ContentDispositionHeaderValue` 未必像 Workers 的 `new Response(...)` 那样严格 | 上传一个 `text`（= 文件名）含 `%0d%0a` 的记录，再 `GET /api/history/{id}/data`，看是否 500 |

## 附：**不**属于上游问题的项（避免误提 issue）

以下问题只在 SyncClipboardCfServer 出现，上游没有对应实现或反而更严：

| 问题 | 为什么与上游无关 |
|---|---|
| 登录页 `?next=` 开放重定向 | 上游 `Server.Core` 无 Web UI 与登录页（检索 `Cookie|Session|HtmlContent|text/html|Razor` 零命中） |
| `/ui/api/*` 无来源校验（CSRF 纵深防御） | 上游无 Cookie 会话、也无状态变更型 UI 端点 |
| 注销不吊销会话令牌 | 上游根本没有会话 / 令牌概念（只有无状态 Basic） |
| PATCH `version` / PUT `size` 缺校验 | **上游更严**：`HistoryRecordUpdateDto.cs:8` 为 `int?`、`ProfileDto.cs:15` 为 `long?`，模型绑定直接 400 |
| 清理任务跑不完 / 失败静默 | 上游 `HistoryCleaner.cs` 无批量上限、`while` 循环 + `logger.LogError` + 下轮重试；该缺陷由 cfserver 引入的分批上限与无 catch 造成 |
| multipart 分界串朴素查找（O(体 × 分界串)） | 上游用框架的 multipart 解析器，不存在该实现 |
| CRLF 的 dataName 导致 `/data` 500 | 上游走 `HistoryController.cs:66` 的 `File(stream, contentType, fileName)` 由 ASP.NET 写响应头；**本轮未验证**上游是否同样报错，故不作主张 |

---

## 附：本实现对这些缺陷的处置（速查表右列的依据）

| # | cfserver 的处置 | 落地位置 |
|---|---|---|
| 1 | 不复刻 `admin/admin`：凭据未配置一律 500（fail-closed），并对弱凭据打告警（`ENFORCE_STRONG_CREDENTIALS=true` 时硬失败） | `src/auth.ts` 的 `verifyCredentials` / `hasWeakCredentials` |
| 2 | 不复刻无限速：DO 持有权威失败计数（IP 与凭据两个维度），失败 N 次后封锁 | `src/rateLimit.ts`、`SyncClipboardHub.ts` 的 `AUTH_RATE_LIMIT_PATH` |
| 3 | 平台层天然 TLS：边缘只接受 HTTPS，明文请求 301 + HSTS（loopback 除外） | `src/index.ts` |
| 4 | 不复刻无限体量：请求体上限默认 48 MiB、区间 `[256 KiB, 64 MiB]`，超限 413；流式暂存另按对象实际大小复判 | `src/requestLimits.ts`、`src/profile.ts` |
| 5 | 不复刻无上限解压：总字节 ≤ 64 MiB、条目 ≤ 1000、单条目 ≤ 24 MiB、压缩比 ≤ 100:1，且预算随请求体收缩 | `src/hash.ts` |
| 6 | 不复刻非常量时间比较：`safeEqual` 定长字节比较，且两项都比较完再合并（不短路） | `src/auth.ts` |
| 7 | 提供出口：回收站软删保留数据（≤30 天）+「彻底删除」+「清空回收站」；清理任务同样受预算约束 | `src/ui/routes.ts` 的 `batch-purge` / `clear`、`src/historyOps.ts` |
| 8 | 不复刻缓存：当前 profile 直接存在 D1 `Meta`，每次直读 | `src/profile.ts` 的 `saveAndNotifyCurrentProfile` |
| 9 | 不复刻整轮中断：每阶段独立 try/catch，失败按阶段隔离，游标续跑 | `src/cleanup.ts` |
| 10 | 不复刻静默：条数上限裁到无可删对象时日志留痕；界面上写明"收藏与置顶不受清理" | `src/cleanup.ts`、`public/ui_v1/js/components/info.js` |
| 11 | 不复刻全表物化：同名候选**不设上限**由库内容决定，但只取调用方要用的三列（避免把 Text 全读进 isolate） | `src/db.ts` 的 `getRecentTransferFile` |
| 12 | 不复刻静默吞异常：清理的每个失败都落 `cleanup:lastError` 并在界面暴露；清空走分批 | `src/cleanup.ts`、`src/historyOps.ts` |
| 13 | 同构（单账号），但已在 README「已知限制」显式声明该边界 | `README.md` |
| 14 | 不复刻：`ux_h_user_type_hash` 唯一索引 + 唯一冲突合并 + 版本化 UPDATE（受影响行数为 0 → 409） | `schema.sql`、`src/db.ts` 的 `isUniqueConstraintError` / `updateEntityIfVersion` |
| 15 | 不适用（客户端问题） | — |
