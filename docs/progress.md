# SyncClipboard CfServer — 开发进度

> 本文件随开发过程持续维护：每完成一个模块/验证即更新。日期格式 `YYYY-MM-DD`。

## 1. 项目状态

| 阶段 | 状态 | 完成日期 | 说明 |
|---|---|---|---|
| 方案讨论与敲定 | ✅ | 2026-09-12 | TypeScript / 独立仓库 / 协议级测试 + 真实客户端联调 |
| 设计文档 | ✅ | 2026-09-12 | design.md + protocol.md + 本文件 |
| M1 脚手架与本地环境 | ✅ | 2026-09-12 | 依赖、D1 schema、wrangler dev 跑通 |
| M2 HTTP 层（鉴权/WebDAV 兼容） | ✅ | 2026-09-12 | 含哈希校验与历史查找 |
| M3 官方 API（/api/history/* 等） | ✅ | 2026-09-12 | |
| M4 SignalR 兼容 Hub（DO） | ✅ | 2026-09-12 | 握手/心跳/广播 |
| M5 协议级集成测试 | ✅ | 2026-09-12 | 31 用例全绿（hash/protocol/signalr） |
| M6 真实客户端联调 | ✅ | 2026-09-12 | 官方 v3.2.0 WinUI3 客户端双向同步打通 |
| M7 部署上线 | ✅ | 2026-09-12 | Cloudflare Workers 部署完成，线上验证通过 |

## 2. 模块开发状态

| 模块 | 文件（规划） | 状态 | 验证方式 | 备注 |
|---|---|---|---|---|
| Worker 入口 | `src/index.ts` | ✅ | wrangler dev | |
| Basic Auth | `src/auth.ts` | ✅ | 协议测试 401/200 | |
| 类型与序列化 | `src/types.ts` / `serialization.ts` | ✅ | 单测 | |
| 哈希算法 | `src/hash.ts` | ✅ | 对照 C# 公式 | 含隐式目录推导 |
| Profile 服务端语义 | `src/profile.ts` | ✅ | 协议测试 | 移动/校验/命名 |
| D1 访问层 | `src/db.ts` | ✅ | 协议测试 | 含 ShouldUpdate |
| R2 访问层 | `src/storage.ts` | ✅ | 协议测试 | |
| multipart 解析 | `src/multipart.ts` | ✅ | 真实客户端 | 兼容 .NET 无引号 name |
| WebDAV 路由 | `src/routes/webdav.ts` | ✅ | 协议测试 | |
| 历史路由 | `src/routes/history.ts` | ✅ | 协议测试 | |
| SignalR Hub | `src/durable/*` | ✅ | @microsoft/signalr 测试 | |
| 广播触发 | `src/hub.ts` | ✅ | signalr 测试 | |

## 3. 决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-09-12 | 语言用 TypeScript | 类型系统兜协议细节；编译产物即 JS |
| 2026-09-12 | 独立目录 + 独立 git 仓库 | 与上游解耦 |
| 2026-09-12 | 最终验证 = 协议级测试 + 真实客户端联调 | 兼容性最可靠 |
| 2026-09-12 | 历史/当前 Profile 存 D1，数据文件存 R2 | 强一致 + 对象存储 |
| 2026-09-12 | negotiate 只宣告 WebSockets | 缩小 SignalR 实现面 |
| 2026-09-12 | `/api/version` 返回 "3.2.1"（可配 VERSION） | 客户端要求 ≥ 3.1.1 |
| 2026-09-12 | 服务端心跳用 DO alarm（15s）而非定时器 | DO 空闲时 JS 定时器冻结，alarm 由平台保证触发 |
| 2026-09-12 | SignalR 消息必须带 RS（0x1E）结尾 | .NET SignalR JSON 协议硬性要求 |
| 2026-09-12 | 广播 await 于响应内 | fire-and-forget 的 DO fetch 会被 Workers 运行时取消 |
| 2026-09-12 | 自定义字节级 multipart 解析器 | undici formData 不兼容 .NET 无引号 `name=hash` |
| 2026-09-12 | Group 校验从 zip 条目推导隐式目录 | 对齐 C# 解压后文件系统遍历（不含显式目录条目的 zip） |

## 4. 验证记录

| 日期 | 验证项 | 结果 | 备注 |
|---|---|---|---|
| 2026-09-12 | 协议级测试 31 用例 | ✅ | hash 12 / protocol 16 / signalr 3（含 35s 心跳） |
| 2026-09-12 | 官方 v3.2.0 WinUI3 客户端连接 | ✅ | Basic Auth、version、SignalR WS、心跳 |
| 2026-09-12 | 客户端 → 服务器上传 | ✅ | 剪贴板文本入库 + 当前 profile 更新 |
| 2026-09-12 | 服务器 → 客户端推送下载 | ✅ | SignalR 广播后客户端修改本地剪贴板 |
| 2026-09-12 | PUSH/PULL 互斥 | ✅ | 下载期间抑制上传 |
| 2026-09-12 | 线上部署 | ✅ | Cloudflare Workers（workers.dev 子域） |
| 2026-09-12 | 线上 HTTP 全端点 | ✅ | 401/version/time/profile/File 上传校验下载/history |
| 2026-09-12 | 线上 SignalR | ✅ | 连接、双广播、35s 心跳（DO alarm 在 CF 边缘工作） |

## 5. 审计修复验证（2026-09-12，cfserver-audit-001）

11 路隔离调查者交叉审计（pre-fix 快照 6b6a174）确认 9 项 material 发现；实现者手动修复
（commit 7315c1d + b6a4fba），主代理逐项验证：

| 修复 | 对应发现 | 验证方式 | 结果 |
|---|---|---|---|
| F1/F13 WS 升级鉴权（token 登记+校验，fail-closed） | High：无凭据可收剪贴板广播 | 代码审 + 伪造/真实 token 回归测试 + 线上 101→401 实测 | ✅ |
| F5 并发写（UNIQUE 索引 + 冲突合并 + updateEntityIfVersion 乐观更新） | Medium：丢更新/重复行 | 代码审 + fixes.test 数据层用例 | ✅ |
| F3 去掉历史查找 LIMIT 500 | Medium：旧记录下载 404 | 代码审 | ✅ |
| F7/F8/F9 解析期拒绝（C# int32/long 绑定语义、严格枚举） | Medium：非法输入 500 | fix-regressions HTTP 级用例 | ✅ |
| F4 暂存消费（Move 语义） | Medium：R2 无界增长 | 代码审 + 暂存重复 PUT 404 回归 | ✅ |
| F6 PATCH 广播 await | Medium：推送丢失 | signalr.test 真实客户端收到 PATCH 广播 | ✅ |
| F11 size/hash 派生（空档 size:0、hash=SHA256("")、Group=解压长度和、dataName 整键省略） | Low：wire 格式偏差 | 线上空档实测 + 断言翻转 | ✅ |
| F10 死连接 60s 清理 | Low：半开连接泄漏 | fixes.test 确定性回归 | ✅ |
| F12 畸形 zip（首见保留、尾斜杠全 trim） | Low：与上游差异 | hash.test 扩展 | ✅ |
| F2/F14 Text+data（data 部分存在即有数据） | High：>10KB 文本无法同步且停摆队列 | fixes.test | ✅ |
| D11 /api/time JSON、/api/version text | Low：客户端 ReadFromJsonAsync 断裂 | 线上 content-type 实测 | ✅ |

测试 82/82 全绿；tsc 干净；已部署（版本 e3872025）；线上 WS 无凭据 401 实测确认。
备注：非法枚举返回 400（上游 NotSupportedException→500），属有意偏离（4xx 更合理），已记录。


## 6. 第二轮对照审核（2026-09-12，对齐上游 28c7e596）

7 路隔离对照（A WebDAV / B 历史 / C SignalR / D Profile哈希 / E 鉴权序列化 / F 客户端契约 / G 存储运维），
逐面双向 file:line 比对上游 .NET 源码；F 面另以 46 条客户端调用契约逆向核对。

**结论：无阻断发布项；发现并修复 6 项兼容性缺陷 + 补齐 1 项生产就绪缺口。**

| # | 面 | 严重度 | 缺陷 | 修复 |
|---|---|---|---|---|
| 1 | A | major | 目录端点尾斜杠：上游客户端 `AdjustDirectoryUrl` 恒加 `/`（DELETE/PROPFIND `file/`），ASP.NET 忽略尾斜杠而 Hono 严格匹配 → 客户端清理静默失效、R2 累积 | Hono `strict:false` + F16 回归 |
| 2 | B | major | 已删除 Group 记录带 data 重传写新随机名且不回写实体 → `/data` 404 + 孤儿对象 | 复用实体 `transferDataFile` + F15 回归 |
| 3 | D | minor | `ProfileDto.dataName` null 时整键省略（上游输出 `"dataName":null`） | 改为输出 null + 断言修正 |
| 4 | D | info | Text PUT 哈希经解码再编码（上游为文件字节哈希） | 改为字节口径，与 POST 一致 |
| 5 | E | major | Basic 凭据 `atob` latin1 解码（上游 `Encoding.UTF8.GetString`）→ 非 ASCII 凭据全 401 | UTF-8 解码 |
| 6 | E | minor | scheme 大小写敏感（上游 OrdinalIgnoreCase）；401 缺 `WWW-Authenticate` | 大小写不敏感 + 补头 |
| 7 | G | major | 保留/清理机制整体缺失（上游 HistoryCleaner：10min 保留+条数、12h 已删+孤儿）→ D1/R2 无限增长 | Cron Trigger + `runCleanup` |

一致项摘要：哈希三类逐字节一致（Python 独立复刻验证）、ShouldUpdate 矩阵逐分支一致、
历史 API 全分支/422/409/400 语义一致、SignalR 帧与心跳一致、46 条客户端契约 42 条完全满足。

测试：**89 例全绿**（含 F15-F18 判别回归）；已部署（版本 `10a961ba`），cron `17 * * * *` 已注册；
线上复验：尾斜杠 200、`dataName:null`、小写 scheme basic 200、401 带 `WWW-Authenticate`。


### 复核确认（逐项回上游源码二次核对本次变更）

| 变更 | 上游依据 | 复核结论 |
|---|---|---|
| `auth.ts` UTF-8 解码 | `BasicAuthenticationHandler`: `Encoding.UTF8.GetString(Convert.FromBase64String(...))` | 一致（atob 为 latin1，已改） |
| `auth.ts` scheme 大小写 / `WWW-Authenticate` | 同文件 `StartsWith("basic", OrdinalIgnoreCase)` + `Response.Headers.WWWAuthenticate` | 一致 |
| `serialization.ts` dataName | `ProfileDto.cs`：仅 `Size` 有 `WhenWritingNull`，`DataName` 无 | 一致（null 时输出） |
| `profile.ts` Group 复活文件名 | `GroupProfile`：`_transferDataName ?? CreateNewDataFileName()` | 一致（复用旧名 + 回写） |
| `profile.ts` Text PUT 哈希 | `TextProfile.SetTransferData → GetSHA256HashFromFile`（文件字节口径） | 一致 |
| `strict:false` 尾斜杠 | 客户端 `AdjustDirectoryUrl` 恒加 `/`；ASP.NET 路由忽略尾斜杠 | 一致（线上 200 实测） |
| **`cleanup.ts` 保留期删除** | `RemoveOutOfRetentionRecords → RemoveExpiredInBatchesAsync → MarkForDeletionAsync` 是**软删**（IsDeleted=1/Version++/LastModified=now），非硬删 | **复核发现偏差并修正**（由 DELETE 改为 UPDATE 软删 + 排序取 `MAX(LastModified,LastAccessed)`） |
| **`cleanup.ts` 30 天硬删** | `RemoveOutOfDateDeletedRecords` 硬删后仍 `DeleteProfileDataIfNeed` 删数据目录（不广播） | **复核发现漏项并修正**（补数据目录清理） |
| `cleanup.ts` 条数裁剪 | `SetRecordsMaxCount`：软删最旧、`QueryCount=!IsDeleted`、`QueryToDeleteByOverCount=!Stared&&!Pinned&&!IsDeleted`、`QueryDeleteOrderBy=MAX(...)` | 一致 |
| `cleanup.ts` 孤儿判定 | `CleanOrphanedFolders`：记录不存在或 IsDeleted → 删目录 | 等价（活记录集合求差） |

**执行级验证**（本地 `--test-scheduled` 实跑，非仅单测）：

```
seed: EXPIRED(8天前/未收藏) / EXPSTAR(8天前/收藏) / OLDDEAD(31天前/已删) / KEEP(新)
[cleanup] expired=1 trimmed=0 hardDeleted=1 orphans=46 batches=1
after: EXPIRED → IsDeleted=1,Version=1 （软删，广播 [DO] RemoteHistoryChanged）
       EXPSTAR → 保留（收藏豁免）
       OLDDEAD → 行消失（硬删）
       KEEP → 保留
```

**受控孤儿验证**：API 创建 `history/File_2BC32AFF.../orphan-test.bin`（R2 实存）→ 删 DB 记录 →
触发清理 → R2 keys **5 → 1**，目标对象消失，`file/` 暂存区未被误删（cleanup 仅作用 `history/` 前缀）。

另修正：`wrangler r2 object put` 语法误用导致在项目根创建 `history/...` 文件并被误提交，已移除并加根锚定 `.gitignore` 防护。


## 7. 第三轮复核：变更代码逐行对照（2026-09-12）

针对上一轮变更的 16 个文件，**逐行回上游源码复核**，发现并修正 3 处 Text 语义遗漏（同类缺陷在 Text 路径此前漏修）：

| # | 遗漏 | 上游依据 | 影响 | 修正 |
|---|---|---|---|---|
| 1 | `saveTextTransferData` 未复用 `entity.transferDataFile` | `TextProfile.NeedsTransferData`：`_transferDataName ?? 生成名` | 已删除 Text 记录带 data 重传写新随机名、记录仍指向旧名 → `/data` 404 + R2 孤儿 | 复用实体文件名 |
| 2 | Text 分支 `FilePaths: []` | `TextProfile.Persist`：`path is null ? [] : [path]` | 与上游存储形状不一致 | `[dataName]` |
| 3 | `isLocalDataValid` 对 Text 恒 `true` | `TextProfile.IsLocalDataValid`：`HasTransferData = TransferDataFile 非空 \|\| Size > Text.Length`，为真时要求文件存在 | `size > text.length` 且无 data 的请求应 400，本实现静默入库 | 按上游判定 |
| 4 | Size 缺失（0）时用 0 | `GetSize()` 读文件 `.Length`（字符数） | 缺 size 声明的请求记录 Size 错误 | 回退全文**字符数** |

**大文本语义（上游 `TRANSFER_DATA_THRESHOLD = 10240`）线上实测双向**：

```
上行（官方客户端设置 14013 字符）：hasData:true, size:14013, textLen:10240   ← 与上游阈值一致
下行（API 推送 13012 字符全文）：客户端剪贴板 len=13012, tail=...zzzzzzzz-END  ← 全文完整取回
```

**文档同步**：protocol.md 更新（dataName 序列化规则、Text 大文本三种哈希情形、路由尾斜杠容错、
SignalR token 登记/心跳/静默清理、保留清理、差异表全面刷新）；README 已知限制更新。

测试 **94 例全绿**（新增 F19 五项判别用例）；线上版本 `cbe53c64`。


## 8. 第四轮逐项完善（2026-09-12，对齐上游 28c7e596）

按「一个功能一个功能」推进，每项都做：上游源码对照 → 判别测试（PRE-fix 变体确认会失败）→ 线上验证 → 提交。

### 发现并修复的缺陷（5 项）

| # | 缺陷 | 上游依据 | 影响 | 提交 |
|---|---|---|---|---|
| ① | `GET /file` 命中最新同名记录后不检查对象是否存在 | `GetRecentTransferFile` = `basename 匹配 && File.Exists(...)` 后 `FirstOrDefault` | 最新记录数据缺失时**直接 404**；上游**回退到更旧的同名记录** | `1e1fbd0` |
| ② | `profileId`/`type` 不接受数字枚举 | `Profile.ParseProfileId` 用 `Enum.TryParse`（接受 `0-HASH` → Text，未定义值也成功） | 数字形式被误拒 400；应可查（200/404） | `0be8475` |
| ③ | `Types` 非法名静默回退 `All` | 上游枚举绑定失败 → `[ApiController]` 400 | **静默降级**：拼错过滤条件变成"返回全量记录" | `6f6383d` |
| ④ | **PROPFIND 返回空体** | 客户端 `GetFolderSubList` → `XmlDocument.LoadXml(响应体)`；空体抛 XmlException | `PreciseDelete=true` 的 WebDAV 用户**上传流程失败**（官方服务器类型不走此路径，故前三轮未暴露） | `3ac2867` |
| ⑤ | `DELETE /file` 清理失败升级为 5xx | 上游 `SafeDeleteFolder` 用 `catch{}` 吞异常恒 200 | 客户端可选清理步骤被报错 | `5d105a1` |

性能：消除上传路径两处全量拷贝（`storage.normalizeBody` 恒等包装删除 + multipart `slice`→`subarray`），
POST /api/history 峰值内存由约文件大小 **3 倍降到 ~1 倍**（40MB ≈ 120MB → ~40MB，逼近 128MB 平台上限的隐患解除）。`ee872d2`

### 核对一致、无需修改（6 项，附依据）

- `PUT /file`：上游 `Request.Body.CopyToAsync`（流式），本实现同为流式透传
- `statistics`：客户端 `IOfficialSyncServer` 未声明该方法 → 不调用；口径差异不可见
- `HEAD /file`：本地实测 body 为空（客户端不依赖）
- `PATCH` 边界：`Version ??= existing+1`、`LastModified ??= now`、`IsDelete===false` 守卫顺序、
  部分字段更新集、`LastAccessed` 仅显式提供时更新 —— 与上游 `Update` 逐行一致
- multipart 头部：无/空 boundary、非 multipart → 400；合法 boundary → 200，与上游一致
- `If-Match` / ETag：**上游也不发 ETag、不处理 If-Match** → 客户端 `GetProfileSnapshotAsync`
  的 `Version` 恒空 → `StorageBasedServerHelper` 走「无版本前置」降级分支，两端行为一致

### 验证方式

- 判别力：每项修复都先用 PRE-fix 变体验证测试会失败（如 ④ 空体 → body 长度 0）再恢复
- 测试：**104 例全绿**；`tsc --noEmit` 干净
- 线上：④ 用 PowerShell 的 **.NET `XmlDocument`（与客户端同款 API）** 复验线上响应——
  `LoadXml` 成功、解析出 8 个 response（1 目录 + 7 文件）
- 部署：`324ef80f` → `0d50092c` → `03ac2867` → `553e6439`


## 9. 第五轮逐项完善（2026-09-12）

### 发现并修复（1 项）

| # | 缺陷 | 上游依据 | 影响 | 提交 |
|---|---|---|---|---|
| ① | `File`/`Image`/`Group` + `hasData=false` 被静默入库 | 上游这些 Profile 的 `Persist()` 无数据时抛异常（`FileProfile: "Cannot persist a FileProfile with no data."`、`GroupProfile: "No local data available..."`），请求被拒 | 写入**永远取不到数据的坏记录**（`GET /file` 恒 404），并污染 `Meta.current_profile`，客户端反复重试下载 | `767d919` |

修复：`putSyncProfile` 在 `persisted` 为空且类型非 `Text` 时抛 `BadRequestError`（400）。
比上游的未处理异常（500）更准确。**F26** 判别验证：PRE-fix 变体下三种类型均返回 200。

### 端到端验证：`WebDAV` + `PreciseDelete=true`（验证第四轮修复的真实使用路径）

把真实客户端切到 WebDAV 账号并开启 `PreciseDelete`（默认关闭，第四轮修复针对的正是这条路径）：

| 步骤 | 结果 |
|---|---|
| 铺 3 个遗留暂存对象（含空格/中文名）+ 既有残留 → PROPFIND 报 11 个条目 | ✓ |
| 触发文本上传 | `Push End`，元数据回填 `{Type,Hash,Text,HasData,DataName,Size}` 全对 |
| **PreciseDelete 清理** | **11 个条目 → 仅剩目录自身**（暂存对象 0），证明 PROPFIND multistatus + `DELETE /file/{name}` 全链路可用 |
| `File` 同步（`wdfile.txt`） | profile `DataName=wdfile.txt / HasData=true / Size=18`，暂存区同步清空 |
| 特殊字符名（`stale b.bin` / `遗留-c.bin`） | 编码/解码正确、可删除 |

**URL 编码边界的往返验证**（第七轮补充）：服务端 `encodeHrefPath` 逐段编码 → 客户端
`HttpUtility.UrlDecode` 还原，对以下名称做完整往返比对，全部一致：

| 原始名 | PROPFIND href | 解码回读 |
|---|---|---|
| `sp ace.txt` | `/file/sp%20ace.txt` | `sp ace.txt` ✓ |
| `中文.txt` | `/file/%E4%B8%AD%E6%96%87.txt` | `中文.txt` ✓ |
| `a+b&c#d.txt` | `/file/a%2Bb%26c%23d.txt` | `a+b&c#d.txt` ✓ |
| `pct%20literal.txt` | `/file/pct%2520literal.txt` | `pct%20literal.txt` ✓（`%` 字面量正确双重编码） |
| `plain.txt` | `/file/plain.txt` | `plain.txt` ✓（纯 ASCII 无需编码） |

解码后的 5 个对象全部通过 `DELETE /file/{name}` 删除成功、暂存区归零。

> 注：上游服务端**没有** `DELETE /file/{name}` 路由，故 `PreciseDelete` 在上游实际不生效
> （`GetFolderSubList` 拿到的节点会 404）。本实现补上了该端点，使这项配置真正可用。

### 核对一致、无需修改（3 项）

- **Group 反斜杠条目**：上游 `VerifyExistingTransferArchiveAsync` 用 `Replace('\\','/')` 规范化；
  本实现拒绝反斜杠条目。核对客户端 `BuildRelativeEntryName` —— 它用
  `Path.DirectorySeparatorChar/AltDirectorySeparatorChar` **强制规范化为 `/`**，故官方客户端
  产生的 zip 永不含反斜杠（仅第三方畸形输入，行为差异不可达）。
- **query 时间格式**：客户端用 `before?.ToString()`（.NET 文化格式，非 ISO8601）发送。
  实测 V8 `Date.parse` 可解析 `zh-CN`/`en-US`/ISO 往返格式；且 `HistoryQueryDto.Before`
  类型为 `DateTimeOffset?` → `ToString()` **恒带 offset**（`+08:00`），故无时区歧义、
  与上游 `DateTimeOffset` 绑定语义一致。
- **`If-Match`/ETag**：上游同样不发 ETag、不处理 `If-Match` → 客户端
  `StorageBasedServerHelper` 的 `Version` 恒空 → 走「无版本前置」降级分支，两端一致
  （日志中 `Profile metadata updated` 已证实该降级路径工作正常）。


## 10. 第六轮：历史同步端到端验证（2026-09-12）

把真实客户端指向本地 `wrangler dev`（可见完整请求日志），验证历史同步全链路。

### 结果：**历史同步正常**

| 观察项 | 结果 |
|---|---|
| dev server 请求日志 | `POST /api/history 200`（多条）、`GET /api/time 200`、`PROPFIND / 207`、`GET /api/version 200`、`GET /api/history/{id} 404`（孤儿检测） |
| `[DO] broadcast RemoteHistoryChanged` | 每次写入后服务端广播（SignalR 推送链路正常） |
| 客户端本地库 | **45 条**（1 LocalOnly + 44 ServerOnly），`IsLocalFileReady=1` 45/45 |
| 服务器记录 | **45 条**（44 active + 1 deleted） |
| 两端一致性 | **完全一致（45 = 45）**，数据全部就绪 |

> 自我纠错：`SyncStatus` 枚举实际为 `LocalOnly=0, ServerOnly=1, Synced=2, Disconnected=3, SyncError=4`。
> 初查时误把 `ServerOnly(1)` 读作 "NeedSync"，据此得出"同步未完成"的错误结论；
> 读枚举定义后纠正——`ServerOnly` 表示记录来自服务器，是**同步成功**的正常状态。

### 本轮核对一致、无需修改

- **客户端探测频率**：`TestAliveHelper` 每 10s 调 `TestConnectionAsync`（`/api/version`），
  叠加历史同步与轮询；实测各端点延迟正常（`/api/version` 冷启动约 0.7s、稳态 1-2ms，
  `negotiate` 约 190ms，5 路并发 negotiate 全部 200）。单客户端约 8.6k 请求/天，
  Workers 免费版 10 万/天可支撑约 10 个客户端（见 README 容量提示）。
- **客户端上传成功判定**：`UploadHistoryAsync` 只查 `IsSuccessStatusCode`，**不解析响应体**，
  故响应体字段差异不影响同步（本实现返回完整 `HistoryRecordDto`，更为丰富）。
- **`statistics.totalFileSizeMB` 口径**：上游遍历 `_persistentDir` 全部文件求和，
  本实现遍历 R2 `history/` 前缀求和 —— 等价（都含未清理的孤儿对象）。


## 11. 第七轮：最终覆盖审计与收敛确认（2026-09-12）

### 端点覆盖：100%

逐行枚举上游 `Server.Core/Controllers/*.cs` 的 17 条路由声明（19 个方法），与本实现对照：

| 上游路由 | 本实现 |
|---|---|
| `HttpGet("")`（服务根） | `app.get('/')` |
| `HttpGet("api/time")` / `HttpGet("api/version")` | ✓ / ✓ |
| `AcceptVerbs("PROPFIND")`（根） | ✓（207 multistatus） |
| `AcceptVerbs("PROPFIND","MKCOL")`（file） | ✓ / ✓ |
| `HttpDelete("file")` | ✓ |
| `HttpHead`/`HttpGet("file/{fileName}")` | ✓（含同名回退） |
| `HttpPut("file/{fileName}")` | ✓ |
| `HttpGet`/`HttpPut("SyncClipboard.json")` | ✓ / ✓ |
| `HttpGet("{profileId}")` / `("{profileId}/data")` | ✓ / ✓ |
| `HttpPost("query")` / `HttpPost` | ✓ / ✓ |
| `HttpPatch("{type}/{hash}")` | ✓ |
| `HttpGet("statistics")` / `HttpDelete("clear")` | ✓ / ✓ |

**额外补全**：`DELETE /file/{fileName}`（上游无此路由，缺失使 `PreciseDelete` 失效）——已记入差异表。

### 其他核对（无代码改动）

- `ServerProfileEnvProvider` 布局：`server/file`（暂存）+ `server/history/{Type}_{hash}`（持久）+
  `server/data`（DB）↔ 本实现 R2 `file/` + `history/` 前缀，逐层等价
- `BasicAuthenticationHandler`：`WWW-Authenticate: Basic realm="SyncClipboard"` **逐字一致**；
  上游对缺冒号凭据 `credentials[1]` 越界抛 `IndexOutOfRangeException`（500）、密码含冒号被
  `Split(':')` 截断 —— 本实现两处均更健壮/宽容（已记差异表）
- `ImageProfile`：仅比 `FileProfile` 多一个客户端用的 `CreateImageFileName()`，服务端处理等价
- 修正 `ProfileTypeFilter.FileAndGroup` 注释（值为 `2|8 = 10`，原注释误写 6；枚举值本身正确）

### 收敛曲线

| 轮次 | 新发现缺陷 |
|---|---|
| 第一轮（审计） | 15 |
| 第二轮（7 面对照） | 6 + 清理机制 |
| 第三轮（Text 语义） | 4 |
| 第四轮（逐项 + 内存） | 5 |
| 第五轮（PreciseDelete） | 1 |
| 第六轮（历史同步 E2E） | 0（验证型） |
| 第七轮（覆盖审计） | 0（核对型） |

### 最终状态

- 测试：**105 例全绿**；`tsc --noEmit` 干净
- 线上：`c512124f`（cron `17 * * * *` 已注册），smoke 13 项全通过
- 仓库：工作区干净，本地 = 远端（`492705a`）

## 12. 待办与已知问题

- [ ] **线上 secrets 仍为 admin/admin，需用户修改**（`wrangler secret put USERNAME/PASSWORD`）
- [ ] 可选：官方真实客户端连接线上 URL 完成一次完整同步（协议栈已由本地真客户端 + 线上 @microsoft/signalr 双重验证）
- [ ] 可选：绑定自定义域名（wrangler.toml routes 或 Cloudflare 控制台）

已知限制（详见 README）：免费版单请求 100MB；仅 WebSockets 传输；畸形 zip 的隐式目录/重复条目语义与上游在第三方畸形输入上存在 minor 差异（官方客户端不可达）。

## 13. 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.1.0 | 2026-09-12 | 项目初始化：骨架 + 设计/协议/进度文档 |
| 0.2.0 | 2026-09-12 | 核心实现：HTTP 层 + SignalR 兼容 Hub + 存储层（31 测试全绿） |
| 0.2.1 | 2026-09-12 | 真实客户端联调修复：multipart .NET 兼容、Group 哈希落盘语义 |
| 1.0.0 | 2026-09-12 | 部署上线：Cloudflare 边缘 + 线上验证通过 |
| 1.1.0 | 2026-09-12 | 交叉审计 15 项修复 + 判别回归（82 测试全绿）+ 线上复验 |
| 1.2.0 | 2026-09-12 | 第二轮 7 面对照：6 项兼容性修复 + 保留清理机制（89 测试全绿）+ 线上复验 |
| 1.2.1 | 2026-09-12 | 复核修正：清理改软删语义 + 硬删补数据清理（执行级验证） |
| 1.3.0 | 2026-09-12 | 第三轮复核：Text transfer data 语义 4 项对齐 + 文档全面同步（94 测试全绿） |
| 1.4.0 | 2026-09-12 | 第四轮逐项完善：5 项缺陷修复（含 PROPFIND multistatus）+ 上传内存优化（104 测试全绿） |
| 1.5.0 | 2026-09-12 | 第五轮：无数据 profile 拒绝 + WebDAV PreciseDelete 端到端打通（105 测试全绿） |
| 1.6.0 | 2026-09-12 | 第六轮：历史同步端到端验证通过（两端 45=45 一致）+ 客户端探测频率与容量评估 |
| 1.7.0 | 2026-09-12 | 第七轮：端点覆盖 100% 审计 + 收敛确认（105 测试全绿，线上 smoke 全通过） |
