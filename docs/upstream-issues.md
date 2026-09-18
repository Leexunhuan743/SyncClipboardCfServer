# 上游 SyncClipboard 安全问题 · Issue 稿（7 条）

- **对象**：`SyncClipboard`（C# / ASP.NET Core 服务端，仓库本地路径 `C:/Users/leeexx/Documents/NewProject/SyncClipboard`）
- **核实方式**：本轮**只读**通读上游源码（下列每条都给出 `文件:行` 与逐字代码），未运行上游服务；因此"影响"部分是按代码语义的推断，凡未实测处均已标注。
- **关联审计**：`cfserver-audit-003`（对 SyncClipboardCfServer 的交叉验证审计）。本文件只收录**上游本身存在**的问题；本实现特有的问题见 `docs/security-fix-plan.md`。
- **用途**：可直接拆成 7 个 issue 提交上游。建议标签：`security`、`Area-Server`。

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
