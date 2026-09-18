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


## 12. 第八轮：补上 SignalR 传输回退（2026-09-12）

**问题**：此前 negotiate 只宣告 `WebSockets`，客户端按服务端列表取第一个可用项，
因此 WS 被代理/防火墙阻断时**没有回退、直接失联**；而上游 ASP.NET Core SignalR 默认宣告
`WebSockets → ServerSentEvents → LongPolling` 三种，可自动降级。这是与上游的真实能力差距。

**实现**（对照 `@microsoft/signalr` 客户端源码的协议要求）：

| 传输 | 客户端要求（源码依据） | 服务端实现 |
|---|---|---|
| WebSockets | 升级 + 帧收发 | 既有 WebSocketPair 路径（回归通过） |
| ServerSentEvents | `GET` 返回 `text/event-stream`，每个 `data:` 帧交给 `onreceive`；消息用 `POST` 发到同 URL | DO 内挂起的流式响应（`TransformStream` + writer），帧格式 `data: <msg>\n\n`，首帧写注释促使头部下发，响应带 `x-accel-buffering: no` |
| LongPolling | 首个 `GET` 立即返回（用于完成初始化）；后续 `GET` 挂起，有数据返 200+内容、无数据挂起；服务端关闭返 **204**；消息用 `POST`；`DELETE` 关闭 | DO 内连接状态（消息队列 + 单个挂起轮询），首轮 GET 立即 200、无消息挂起 ≤25s、关闭/静默返 204、DELETE 返 200 |

- negotiate 改为按上游顺序与格式表宣告（`WebSockets ["Text","Binary"]`、`ServerSentEvents ["Text"]`、
  `LongPolling ["Text","Binary"]`）——与 ASP.NET Core SignalR 的固定表逐字一致
- Worker 侧把 `/SyncClipboardHub` 的**所有**方法转发 DO（原先只转发 WS 升级）
- 三种传输共用同一套消息语义（握手/Ping/Close）与心跳（15s Ping）；长轮询尤其依赖心跳——
  空轮询响应不会重置客户端 ServerTimeout，必须有真实消息

**顺带修复的真实缺陷**：提前返回响应时未消费请求体 → Workers 运行时抛
`Can't read from request stream after response has been sent.`，并让**后续请求**以 503 结束
（实测：带 body 的 POST 走鉴权失败路径后，紧接着的 DELETE 收到 503）。
修复：`drainRequestBody`（流式丢弃，不占内存）用于鉴权失败、未配置凭据、405 等提前返回路径。
注意 `body.cancel()` 不足以消除该错误，必须真正读完。

**验证**：

| 项 | 结果 |
|---|---|
| 新增 `test/transports.test.ts`（8 例） | 本地 **8/8**、线上 **8/8** 全绿 |
| 覆盖内容 | negotiate 宣告顺序与格式表；三种传输各自的握手+广播；长轮询首轮立即返回；长轮询挂起有界（实测 ~15s 返回，由心跳先行触发）；自动回退（不指定传输）；三种传输的无凭据请求一律 401 |
| 全量测试 | **113/113 通过**（6 个套件） |
| 线上实测 | 三种传输在真实 CF 边缘端到端可用（SSE 流式、长轮询挂起 17s） |
| 真实客户端回归 | v3.2.0 WinUI3 客户端 WS 主路径正常、事件驱动模式保持 |
| 部署 | `7049992d` |

**已知限制（测试环境，非实现）**：`@microsoft/signalr` 在 Node 下用 ws 库，而 ws 库不读
`HTTP(S)_PROXY`；`transports.test.ts` 与 `signalr.test.ts` 均注入全局 WebSocket（undici，会走代理）
以完成 WS 路径验证。这不影响服务端行为，也不影响真实 .NET 客户端（它用自己的 WS 实现）。

**测试装置的两处修正（第九轮附带）**：
- `fix-regressions.test.ts` 的 WS 探测地址改为从 `BASE` 派生（此前硬编码 `ws://127.0.0.1:8787`，
  以线上 BASE 运行时会把线上 token 拿去连本地服务 → 假失败）。修正后 3 条 WS 鉴权用例
  首次真正覆盖线上边缘。
- 广播用例由「响应即断言」改为**有界轮询**（10s）。原断言依赖本地 RTT≈0；跨代理/WAN 时帧尚未
  抵达 → 假失败。F6 的真实主张是「广播不因 floating promise 丢弃」，有界等待仍能在真丢失时失败。
- 网络密集用例加 `{ timeout: 60_000 }`（与 `signalr.test.ts` 心跳用例的既有约定一致）；
  vitest 默认 5s 预算在多请求用例上会以 `Test timed out in 5000ms` 形式假失败。


### 传输回退的并发与平台行为验证（补验）

对照 `@microsoft/signalr` 客户端源码确认了两个关键常量，并做了平台并发实测：

| 项 | 客户端/平台事实（来源） | 本实现取值 | 结论 |
|---|---|---|---|
| 长轮询单次请求超时 | **硬编码 100s**（`LongPollingTransport.js:43` `timeout: 100000`） | 挂起上限 25s、心跳 15s | 均远低于客户端超时，不会误判失败 |
| 长轮询客户端轮询方式 | **严格串行**（`_poll` 内 `while` + `await get`，同一连接不会并发两个轮询） | 防御性处理同连接并发挂起 | 真实客户端不可达该路径 |

**平台并发实测（真实 Cloudflare 边缘）**：

| 场景 | 结果 |
|---|---|
| 20 / 50 路并发**挂起**的长轮询 | 全部 200 返回，且**每路都收到心跳**（20/20、50/50），耗时 15.2s / 15.7s |
| 20 路并发 SSE 流 | 20/20 建立成功（0.7s） |
| 三传输混合扇出（1 WS + 1 SSE + 1 LP） | 三者均收到**同一次**广播（ws:1 sse:1 lp:1） |
| 同连接两个并发挂起（防御路径） | 本地（miniflare）语义正确：旧的立即结算（0.2s）、新的继续挂起到心跳（15.0s） |

**残留不确定（如实记录）**：同连接并发挂起在**线上**观测为两个都在 15s（心跳）返回，与本地语义不同。
成因未定位（可能是测试经由代理的 HTTP 层连接复用，也可能是 DO 平台行为差异）。
影响评估：**无功能影响**——真实客户端的轮询循环是串行的（见上表第二行），不会产生同连接并发挂起；
即便发生，最坏结果是陈旧请求最多多挂 15s 后返回空体并被客户端丢弃。
DO 单实例的并发挂起容量未探到上限（已实测 **50 路**正常，真实使用规模为此的百分之一）。


## 14. 第九轮：输入校验与路径细节对照（2026-09-12）

对照上游控制器 / 服务 / Profile 类逐条核对「模型绑定与 size 口径」，发现并修复 5 项偏差。
全部先取得**修复前线上实测**证据，再修复并复验。

| # | 偏差 | 上游行为（证据） | 修复前线上实测 | 修复 |
|---|---|---|---|---|
| F27a | PUT/PATCH 的 JSON body 非对象 | `[FromBody] ProfileDto` 反序列化失败 → 400 | `body=[]`/`123`/`"text"`/`true` → **200 且覆盖当前 profile**（`text` 被清空）；`null` → 400 | `requireJsonObject` → 400 |
| F27b | `Types` 数字位掩码 | `Enum.TryParse<ProfileTypeFilter>("5")` 成功 → 200 | `Types=5` → **400** | 接受数字（int32 内），仍拒绝 `Text,5` 混用 |
| F27c | `Starred`/`SortByLastAccessed` 非法值 | `bool.TryParse` 失败 → ModelState 失败 → 400 | `Starred=maybe`、`SortByLastAccessed=yes` → **200**（静默当作无过滤） | → 400 |
| F27d | POST 表单 `version`/`size` 解析 | `int.TryParse`/`long.TryParse` **整体**必须合法，失败取 0 | `version=3abc` → **3**（`parseInt` 前缀解析） | 严格整数语法，失败取 0 |
| F28a | POST 路径 `size` 口径 | `ProfilePersistentInfo.Size` 是必填 `long` → Text 用声明值（缺失即 0，**不读文件**）；`FileProfile(ProfilePersistentInfo)` 不设 Size → File/Image 用**实际字节数** | 实现与上游相左（Text 回落读文件、File/Image 用声明值） | 按类型分别对齐 |
| F28b | `Profile.Create` 的 File→Image 提升 | `dto.Type=File` + `DataName` ∈ `.jpg/.jpeg/.gif/.bmp/.png` → 建 `ImageProfile`，落库 Type=**Image** | 落库为 **File** | `resolveCreateProfileType`（仅 PUT 路径；`webp/heic/avif` 不在提升表） |
| F28c | `GET /api/history/{id}/data` 的非法 profileId | 上游此端点不校验格式，`GetTransferDataFileByProfileId` 返回 null → **404** | 返回 **400** | → 404（元数据端点仍 400，两者上游本就不同） |
| F29a | Group 数据文件名后缀 | `CreateNewDataFileName()` = `File_{stamp}.zip` | 生成为 `File_{stamp}**.tmp**.zip`（与自身注释矛盾） | → `.zip`；随机段对齐 `Path.GetRandomFileName()` 形状（8 字符 + `.` + 3 字符） |
| F29b | `HEAD /file/{name}` | `[HttpHead]` 与 `[HttpGet]` 同挂一个 action；`File(bytes, contentType)` 的 `EnableRangeProcessing` 默认 false（忽略 Range） | 未覆盖测试 | 补判别用例（200 + Content-Length + 无体；Range 返回全量；缺失 404） |

**自我纠错（记录在案）**：此前一条单测写作「Size 声明缺失（0）时回退为全文字符数（上游读文件算 .Length）」——
该断言基于对上游的**误读**：`ProfilePersistentInfo.Size` 是 `required long`（非空），
`TextProfile(ProfilePersistentInfo)` 赋值 `Size = entity.Size` 后 `GetSize()` 原样返回，永不触发 `ComputeSize`；
读文件的回落只存在于 PUT 路径（`TextProfile(ProfileDto).Size` 是 `long?`）。
该用例已按上游证据改写为「POST 路径 Size = 声明值（缺失即 0）」，并新增 File/Image 用实际字节数的用例。

**验证**：本地 `npm test` **123/123**（6 套件）；`npx tsc --noEmit` 干净；修复前证据脚本
`.audits/f27-pre-fix.mjs` 对线上旧版本运行、修复后由 `test/fix-regressions.test.ts`（F27/F28/F29）守卫。
**线上全套**：HTTP 套件 49/49（fix-regressions 33 + protocol 16）、hub/传输 12/12
（signalr 4 + transports 8）——共 **61 例在真实 Cloudflare 边缘通过**。

**已知（有意保留，不影响官方客户端）**：
- **query 时间字段无法解析时不 400，而是忽略该过滤条件**（有意偏离）。依据：客户端发送的时间串
  由 `DateTimeOffset.ToString()` 生成，其模式为 `ShortDatePattern + " " + LongTimePattern + " zzz"`
  —— .NET 源码 `DateTimeFormatInfo.DateTimeOffsetPattern` 注释原文「default pattern DateTimeOffset :
  shortDate + long time + time zone offset」，故**带偏移**（如 `2026/9/12 22:48:42 +08:00`），
  `Date.parse` 对 zh-CN / en-US / de-DE 等形式均可正确解析（已实测），无时区偏差。
  若某文化形式两边都解析不了（如 ko-KR 的 `2026. 9. 12. 오후 10:48:42 +08:00`），
  返 400 会让客户端 `SyncTaskImpl` 整轮历史同步抛错停止；忽略则仅让增量过滤退化为「多取一页」（结果仍正确）。
- 方法不匹配时上游 405、本实现 404（客户端不会发错方法）。
- `/api/history/{id}/data` 的 Content-Type 恒为 `application/octet-stream` + `nosniff` + `attachment`
  （上游按扩展名推断）——安全加固，客户端按字节落盘不读此头。
- POST multipart 的字段顺序容忍度更高（上游解析到 `data` 即停止读取）。


## 15. 第十轮：逐条核对两个控制器的每个返回点（2026-09-12）

方法：把上游 `SyncClipboardController`（9 个 action）与 `HistoryController`（8 个 action）的**每一个 return**
列出，与本仓库路由逐条比对状态码与响应体形状。结论：**状态码全部一致**，发现 1 项真实健壮性缺口 + 2 项需记录的差异。

| # | 项 | 上游（源码依据） | 修复前 | 处理 |
|---|---|---|---|---|
| F30 | `GET /SyncClipboard.json` 的降级出口 | `GetSyncProfile` 有两个 catch/`??` 出口：① 反序列化**抛错**（`[]`／标量／非法枚举名／非整数数字）→ `new TextProfile("").ToProfileDto()`（hash=`SHA256("")`、`size:0`）；② 反序列化得 **null** → `?? new ProfileDto()`（hash=""、`size` 键省略） | 只处理「无存储值」，损坏值**原样返回** → 客户端 `ReadFromJsonAsync` 抛异常、剪贴板同步中断 | 新增 `classifyStoredProfile` 复刻两出口判定（含 `null` 与 `corrupt` 两种形状差异） |
| — | `GET /file/{name}` 内部异常 | `catch (Exception ex) → BadRequest(ex.Message)` = 400 | 500 | **有意保留 500** 并文档化：客户端两者都走失败分支；把内部故障报成 400 会误导排障 |
| — | `profileId` 中的类型枚举大小写 | `Profile.ParseProfileId` 用 `Enum.TryParse<TEnum>(value, out r)` —— .NET 源码该重载固定 `ignoreCase: **false**`（**大小写敏感**）；而 `PATCH /{type}` 走模型绑定 `EnumTypeModelBinder → EnumConverter.ConvertFrom → Enum.Parse(t, s, true)`（**大小写不敏感**）。**上游自身不一致** | 两处均大小写不敏感 | 记为宽松超集并文档化（客户端恒发规范枚举名，两种实现等价） |

**顺带核对（均为一致，无需改动）**：`api/version` 的 text/plain 裸串、`api/time` 的 JSON ISO 串、
`PROPFIND`/`MKCOL`/`DELETE /file` 的 2xx、`GET/PUT /file/{name}` 的 400/404/200 与 Range 忽略、
`PUT /SyncClipboard.json` 的 400/404 与 `"Hash is not match data."`、
`POST /api/history` 的 400/422(ProblemDetails `code=history_data_invalid`)、
`PATCH` 的 200/409(dto)/404、`DELETE /api/history/clear` 的 `{"deleted":n}`（上游 `ClearAllAsync` 是**硬删**，
与本实现的 `DELETE ... RETURNING` 一致）、`GET /api/history/{id}/data` 的 404、
`statistics` 的两位小数与「非 0 但显示为 0 → 0.01」、`POST query` 的 `after >= before → 400`。

**自我纠错（记录在案）**：本轮第一次提交 `ed39b72` 的**提交信息被 shell 反引号展开破坏**
（3 处空洞，其中两处丢失了 `GetSyncProfile` / `ReadFromJsonAsync` 等标识符）。根因是用了
`git commit -m "…反引号…"` —— 这正是既有的自记规则所禁止的（应改用 `write` 写消息文件 + `git commit -F`）。
处置：该提交尚未推送，经用户授权后按「仅重写这一条未推送提交的消息」修复
（先 `git stash create` 记下备份对象，再 `git reset --soft` + 路径限定重提交 + `cherry-pick` 重放后两条），
**三棵树的哈希与改写前逐字节一致**（`d3418f85` / `7208d586` / `20e76698`），内容零变化、无 force push。
此后所有提交一律走 `-F` 文件方式。

**验证**：本地 `npm test` **125/125**（6 套件）；`npx tsc --noEmit` 干净；新增 F30 单测覆盖
`classifyStoredProfile` 的 6 个 ok 形状、9 个 corrupt 形状与 `null` 形状，以及两个降级 dto 的 wire 差异
（`size:0` 必现 vs `size` 键省略）。


## 16. 第十一轮：hash 的路径字符约束（对齐上游 GetWorkingDirName）（2026-09-12）

对照上游 `Profile.GetWorkingDirName` 时发现本实现缺少等价防线。上游在 key 构造处校验：

```csharp
if (hash.Contains(Path.DirectorySeparatorChar) || hash.Contains(Path.AltDirectorySeparatorChar))
    throw new ArgumentException("Hash contains invalid path characters.", nameof(hash));
```

**判别性证据（线上 pre-fix 实测）**：`PUT /SyncClipboard.json` 带 `hash="ABCD1234/EF567890"` 与
`hash="ABCD1234\\EF567890"` 均返回 **200**，且第二条**成为了当前 profile**
（`.audits/f31-pre-fix.mjs` 对旧版本运行，输出「★ 当前 profile 已被含分隔符的 hash 污染」）。

**为什么有害**：hash 参与两处必须同构的用途 —— R2 key `history/{Type}_{Hash}/{file}` 与孤儿目录判定
（`listHistoryWorkingDirs` 只按**第一个** `/` 截断工作目录名）。记录侧是 `Text_A/B`，R2 侧只会被识别为
目录 `Text_A/`，二者不同构。且该坏记录会被**设为当前 profile 推给客户端**，而客户端本地用同一规则
构造路径（`GetWorkingDirName`）会抛异常/产生非法路径。

**修复（三层）**：

| 层 | 行为 |
|---|---|
| 请求边界（PUT / POST / PATCH） | hash 含 `/` 或 `\` → **400** `Hash contains invalid path characters`（上游是未捕获异常 500；400 可诊断） |
| 读取（`classifyStoredProfile`） | 存储值里的 hash 含分隔符 → 视同损坏，降级为空 TextProfile（覆盖历史遗留/外部篡改的 Meta 值） |
| `src/storage.ts` key 构造 | 断言兜底：将来新增写路径若漏校验会**快速失败**，而非产生跨目录 key |

`isValidProfileHash` 放在 `types.ts`（无依赖层），使 `serialization.ts` 的分类器与路由层共用同一判据。

**顺带修正的平台差异**：上游 Windows 拒绝 `/` 与 `\`，Linux 只拒 `/`（`Alt` 与 `Directory` 同值）→
**允许 `\`**。本实现两平台一致地拒绝两者（严格超集，跨平台行为一致）。

**验证**：
- 本地 `npm test` **129/129**；`npx tsc --noEmit` 干净。
- 线上（部署 `494cdce0` 后）：两种分隔符均 **400**、当前 profile 未被污染；
  线上套件 **52/52**（fix-regressions 36 + protocol 16）。
- 线上数据清理：删除探针注入的 2 条坏记录（`instr(Hash,'/')>0 OR instr(Hash,char(92))>0` 现为 0 条）
  —— 它们会让 cleanup 的删除路径触发断言，必须清除。


## 17. 第十二轮：CI 质量门升为真实协议回归 + 测试凭据变量专用化（2026-09-12）

通读 `deploy.yml` 与 `test/live-signalr.mjs` 后发现两处真实缺陷：

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| C1 | CI 质量门只跑 `test/fixes.test.ts test/hash.test.ts`（2 个数据层套件），注释称「CI 不启动 dev server」 | **协议回归（fix-regressions 36 / protocol 16 / signalr 4 / transports 8）完全不被 CI 拦住** —— 而本项目最有价值的正是协议兼容性 | 新增独立 `quality` job：`typecheck` + 全部 6 个套件；黑盒套件由 CI 自起 `wrangler dev --local` 跑。`deploy` 改为 `needs: quality` |
| C2 | 测试读 `process.env.USER` / `USERNAME` 取凭据 | Windows 上 `USERNAME` **恒为当前用户名**（实测 `leeexx`）→ `live-signalr.mjs` 必然 401；Ubuntu CI runner 上 `USER=runner` → 把黑盒套件加进 CI 后必然全部假失败 | 统一改为 `SYNC_USER` / `SYNC_PASS`（5 个文件：4 个测试 + `live-signalr.mjs`），默认 `admin`/`admin` 与 `.dev.vars` 示例一致 |

**CI 路径的本地等价验证**（在提交前证明该设计可行）：用空 `WRANGLER_HOME` + 空 `CLOUDFLARE_*`
+ 独立 `--persist-to` 状态目录 + `--var` 注入非默认凭据（`ci-user`/`ci-pass`）+ 独立端口 8788
起了一个与 CI 等价的实例（`:8788`），确认：

- `d1 execute --local --file=./schema.sql` 在**无登录态**下成功（证明 CI 无需 Cloudflare 凭据）
- 无凭据 → 401、`--var` 注入的凭据 → 200、`/api/history/statistics` 可用（证明 schema 生效）
- **全部 6 个套件 129/129 通过**（`BASE=http://127.0.0.1:8788 SYNC_USER=ci-user SYNC_PASS=ci-pass`）

CI 单次成本：新增一个 job（多一次 checkout + `npm ci`），`quality` 约 4–6 分钟（其中心跳用例固定 35s、
长轮询用例 ~16s）。`timeout-minutes: 20` 留足余量；失败时上传 `wrangler-dev.log` 便于定位。

**文档同步**：README（套件数 105→129、测试凭据变量说明、CI 流程改为两 job 描述）、
design.md §12（套件清单 + CI 执行策略 + 凭据来源及其原因）。

### 重大发现：自动部署从未成功（CI 一直 failure）

改完 CI 后查 `gh run list` 才发现：**此前所有 CI 运行都是 failure**（每次 18–39s 即在
`deploy` job 的 `Apply D1 schema` 步骤失败）。根因：仓库**未配置** `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`。也就是说：

- 线上每一次部署都是**手动 `npx wrangler deploy`**，GitHub Actions 自动部署从未生效。
- `deploy` job 的 `Deploy Worker` 步骤因前序失败而**从未运行过**（显示为 `-` 跳过）。
- wrangler 的报错是「In a non-interactive environment, it's necessary to set a
  CLOUDFLARE_API_TOKEN environment variable…」，它不提示「去仓库 Settings 配置」，首次使用容易卡住。

处置：在 `deploy` job 的**第一步**（checkout 之后）加显式 secrets 检查 —— 缺哪个列哪个，
并给出配置路径与所需权限；同时说明 `quality` job 不需要这些凭据、其协议回归结果仍然有效。
**保持失败语义**（不跳过）：部署是本 workflow 的目的，静默跳过会把「未部署」伪装成绿色。

**真实 CI 实测（本轮唯一一次跑到线上的验证）**：

| run | quality | deploy | 说明 |
|---|---|---|---|
| `34703844630` | ✓ 1m19s，**6 套件 129 用例全通过** | X 18s（Apply D1 schema） | 质量门升级生效 |
| `34703970484` | ✓ 1m11s | X 6s（Check required secrets） | 诊断信息按预期输出 |

即：**协议回归已真正进入 CI 门禁**；自动部署当时仍缺凭据。

### 自动部署恢复（用户配置 secrets 后实测）

用户配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 后，重新推送触发 run `34704548797`：

```
✓ quality in 1m0s+   （typecheck + 自起服务器 + 全部套件）
✓ deploy   in 24s
    ✓ Check required secrets        ← 本次通过（此前在此失败）
    ✓ Apply D1 schema (idempotent)
    ✓ Deploy Worker                 ← **首次真正执行**
    - Sync Basic Auth credentials   （未设 SYNC_AUTH_CREDENTIALS，按设计跳过）
    - Smoke check                   （未设 DEPLOY_URL，按设计跳过）
```

这是本项目**第一次通过 GitHub Actions 成功自动部署**（此前 100% 依赖手动 `npx wrangler deploy`）。

**CI 对线上 D1 的影响核对**（`Apply D1 schema --remote` 会执行 `schema.sql`，其中含一条去重 `DELETE`）：
执行后 `COUNT(*) = 301`、重复行 `(UserId,Type,Hash)` 计数 = **0** → 去重语句未删除任何行，
**无数据丢失**（唯一索引保证不可能出现重复）。

**CI 部署后的线上校验**：`/api/version` = 3.2.1、`/SyncClipboard.json` 200、
negotiate 三形态（`v=1` 有 token / 无参数 `v=0` 无 token / `abc` 仅 error）均与修复后一致。

**本轮线上套件产生的 56 条测试记录已软删清理**（`.audits/live-cleanup.mjs`，0 失败）。



## 18. 第十三轮：negotiate 响应的逐字契约（读 ASP.NET Core 源码核对）（2026-09-13）

方法：直接读 `dotnet/aspnetcore` **v9.0.9**（与上游 `Directory.Packages.props` 锁定的
`Microsoft.AspNetCore.SignalR.Client` 版本一致）的 negotiate 实现，而不是只靠客户端行为反推：

- `src/SignalR/common/Http.Connections/src/Internal/HttpConnectionDispatcher.cs`
- `src/SignalR/common/Http.Connections.Common/src/NegotiateProtocol.cs`
- `src/SignalR/common/Http.Connections.Common/src/NegotiationResponse.cs`

**已逐字确认无误的部分**（此前只是"声称对齐"）：

| 项 | 上游源码 | 本实现 |
|---|---|---|
| WebSockets 传输格式 | 硬编码 `["Text","Binary"]`（`_webSocketAvailableTransport`） | 同 |
| SSE | `["Text"]` | 同 |
| LongPolling | `["Text","Binary"]` | 同 |
| 宣告顺序 | 代码顺序 WebSockets → SSE → LongPolling | 同 |
| 字段名 | `connectionId` / `connectionToken` / `availableTransports` / `negotiateVersion` / `transport` / `transferFormats` / `error` | 同（逐字） |

**发现并修复的两处真实差异**：

| # | 差异 | 上游 | 修复前本实现 | 修复 |
|---|---|---|---|---|
| F32a | 无 `negotiateVersion` 参数时的响应 | 仍输出 `"negotiateVersion":0`（`WriteResponse` 用 `WriteNumber` **无条件**写该字段） | **省略该键**（形状不符） | 恒输出（版本 0 也写） |
| F32b | 版本参数非法 | 非整数 → `error: "The client requested a non-integer protocol version."`；负数 → `error: "The client requested version '<v>', but the server does not support this version."`；**均返回 HTTP 200**，响应体只有 error、不签发连接 | 静默忽略、按版本 1 正常签发 | 逐字复刻三条错误消息与 200 状态 |
| F32c | `> 1` 的版本 | 钳制到 `_protocolVersion`（1），**不报错** | 恒回 `negotiateVersion:1`（结果同，但未表达钳制语义） | 显式 `Math.min(n, 1)` |

**修复后的六种形态**（本地与线上均实测，逐字一致）：

```
negotiateVersion=1     200 version=1 token=有
negotiateVersion=0     200 version=0 token=无
negotiateVersion=2     200 version=1 token=有        ← 钳制
negotiateVersion=abc   200 error="The client requested a non-integer protocol version."
negotiateVersion=-1    200 error="The client requested version '-1', but the server does not support this version."
（无参数）               200 version=0 token=无
```

**为什么 F32b 值得修**：版本 0 的客户端（无 `connectionToken`）用 `connectionId` 作 `?id=`，本实现
让两者同值故仍能通过 DO 鉴权；但非法版本原本被**静默当成版本 1**，等于向一个协议不兼容的客户端
宣告可用 —— 上游会明确报错让它尽早失败。错误路径现在也不签发 token（不会留下 10 分钟 TTL 的孤儿 token）。

**验证**：本地 130/130；线上全套 **130/130**（含 6 种 negotiate 形态的判别用例）；
部署 `ffabed4d`。文档：protocol.md 新增 §6.1「negotiate 响应的逐字契约」（版本协商表 + 字段出现规则表）。


## 19. 第十四轮：生产事故 — 孤儿目录清理每小时清空全部历史数据（2026-09-13）

**用户要求清理云端残留时暴露的严重缺陷。**

### 现象

清理残留后做完整性检查（对每条活跃记录取 `/api/history/{id}/data`）发现：
**仍活跃、且声明有数据的记录，其数据文件同样 404**。`statistics.totalFileSizeMB` = **0**（R2 的
`history/` 前缀已空）。量化结果：

| 项 | 数量 |
|---|---|
| 活跃记录 | 111 |
| 其中声明有数据（`hasData=true`） | 28 |
| 数据可取回 | **1**（当时刚放置的验证数据） |
| 数据缺失（404） | **27**（File 13 / Text 14） |

### 根因（两处键形式不一致）

```ts
// src/storage.ts —— 由 R2 key 截取，**带尾斜杠**
dirs.add(rest.slice(0, slash + 1));        // "File_ABC/"

// src/db.ts —— 曾经**不带**尾斜杠
`${ProfileType[r.Type]}_${r.Hash}`          // "File_ABC"

// src/cleanup.ts —— 集合比较
for (const dir of workingDirs) {
  if (!active.has(dir)) {                   // "File_ABC/" 永远不在集合里 → 恒为 true
    await storage.deleteHistoryPrefix(dir);  // → 删除该目录
```

于是**每一个**历史工作目录都被判为孤儿 → 每小时 Cron（`17 * * * *`）把 `history/` 下全部对象删光
（含所有活跃 File/Image/Group 的数据与带传输数据的大文本）。这解释了现象与 `totalFileSizeMB=0`。

**为何长期未被发现**：既有单测只断言 `listActiveWorkingDirs` 自身的返回值（`dirs.has('Text_KEEP')`），
从未与 R2 列出的目录名形式**交叉核对**；也没有测试调用真实的 `runCleanup` 路径。

### 修复

`src/db.ts` 的 `listActiveWorkingDirs` 改为返回带尾斜杠的目录名（与 `R2Storage.listHistoryWorkingDirs()`
同形；尾斜杠同时是 `deletePrefix` 的正确性所需——`history/File_AB` 会误匹配 `history/File_ABC/…`）。
两处都加了注释说明「比较双方必须同形」这一契约。

### 判别性验证

- 新增 `test/fixes.test.ts` 的 **F33**：内存 `FakeBucket` 驱动**真实** `R2Storage` + 真实 `HistoryDb`
  + 真实 `runCleanup`，用真实 R2 语义（list/delete 前缀）覆盖到 key 构造与前缀截取这一层
  （替换 `R2Storage` 的 stub 无法发现此缺陷）。
  断言：活跃记录的数据**必须保留**、真孤儿与已软删记录的目录被清、`orphans === 2`。
- **PRE-fix 判别**：临时把 `db.ts` 改回旧形式 → F33 失败并给出
  `活跃记录的数据被误删: expected false to be true`；恢复修复后通过。
- **真实 scheduled handler 端到端**（本地 `wrangler dev --local --test-scheduled` + `GET /__scheduled`）：
  入库 → 取数据 200 → 触发 Cron → 取数据仍 **200**、`totalFileSizeMB=0.01`。
- 全量 **131/131** 通过；已部署 `3cea8d7c`（16:22 UTC，早于当小时 17:17 的 Cron）。

### 已损失的数据无法由服务端恢复（如实说明）

被误删的 R2 对象（27 条的 File/Text 数据）**不可恢复**。DB 元数据仍在，故记录显示 `hasData=true`
但取数据 404。恢复路径（需用户操作，涉及删除记录，未擅自执行）：

1. 客户端本地仍持有这些文件（`IsLocalFileReady` 在客户端侧为 true）；
2. 但服务端的 PUT/POST 复用分支在记录未删除时**不会**重写数据（与上游一致），
   所以直接重新复制同一内容也不会补回数据；
3. 可行做法：把受影响记录在服务端**硬删** → 客户端 `DetectOrphanDataAsync` 会将其标记为 `LocalOnly`
   → `SyncPendingUploadsAsync` 随即带数据重传 → 服务端重建记录与数据。

### 事后反思（流程层面）与补齐

此前 13 轮的验证都集中在 HTTP 端点契约与哈希语义，**清理这类"后台任务"只做了单测而未端到端跑
真实 scheduled handler** —— 这正是事故能长期潜伏的原因。已补上并纳入常态化验证：

**新增 `test/cleanup.test.ts`（4 例，经 `GET /__scheduled` 触发真实 scheduled handler）**：

| 用例 | 断言 | 作用 |
|---|---|---|
| 保留期清理确实执行 | 构造 8 天前的记录 → Cron 后 `isDeleted` 变为 true | **防空转**：若 `/__scheduled` 是 no-op，「数据存活」断言会假通过 |
| 活跃记录的数据不被删 | 活跃记录 → Cron 后 `/data` 仍 200（修复前为 404）、`totalFileSizeMB > 0` | 生产事故的直接回归守卫 |
| 已软删记录的数据不可取回 | PATCH isDelete → Cron 后 `/data` 404 | 清理确实生效 |
| 软删时广播 `RemoteHistoryChanged` | SignalR 客户端在 Cron 后收到该 hash 且 **`isDeleted === true`** 的事件 | 覆盖清理的**通知副作用**（上游 `OnRecordDeletedAsync` → hub）；只看库不看通知会让其它设备一直显示过期记录 |

第 4 例的断言刻意要求 `isDeleted === true`：`POST /api/history` 建记录时**也会**广播
（`isDeleted=false`），若只按 hash 匹配则无论 Cron 是否广播都会通过。已用「临时移除 cleanup 的
`broadcast` 调用」验证判别力 —— 用例以
`Cron 软删后未广播 RemoteHistoryChanged: expected false to be true` 失败。

- **PRE-fix 判别**：临时改回旧键形式 → 该套件失败并给出
  `活跃记录的数据被 Cron 误删: expected 404 to be 200`（在 HTTP 层复现了生产事故）。
- **防空转设计**：断言 `/__scheduled` 可用（未启用 `--test-scheduled` 时**跳过并报告原因**，
  不假装通过）；且用「保留期清理」证明 Cron 真的执行，避免「Cron 没跑」也被判为通过。
- `npm run dev` 与 CI 的 quality job 均改为 `--test-scheduled`。

**全量 135/135（7 套件）通过。**

### 顺带核对：`HEAD` 的方法映射（发现并记录一处超集差异）

本轮探测各端点的 HTTP 方法语义时发现：上游 `HEAD /`、`HEAD /api/version` 等返回 **405**，
而本实现返回 **200**（Hono 为 GET 路由自动处理 HEAD）。依据：

- 上游为`/file/{name}` 同一 action **显式**写了 `[HttpHead]` + `[HttpGet]` —— 若会自动映射，
  这个 `[HttpHead]` 就是多余的；
- 路由层 `HttpMethodMatcherPolicy`（aspnetcore v9.0.9）按 `metadata.HttpMethods` 逐个比较，
  **无任何 HEAD 特例**（全文不含 `HEAD`/`IsHead`）。

影响：官方客户端不发这类 HEAD（`WebDavBase.Exist()` 定义了但无处调用），`HEAD /file/{name}`
两边都是 200。故记录为**宽松超集**而不改动（要"修"反而要写代码去更不兼容，且无人可观测）。


## 20. 第十五轮：查询过滤/排序语义的端到端覆盖（客户端 UI 与增量同步依赖）（2026-09-13）

审计测试覆盖时发现一个真实缺口：`/api/history/query` 的**过滤与排序本身**从未端到端断言，
只覆盖了「非法值 → 400」（F9 的 Page 边界、F27 的 Types/Starred/SortByLastAccessed 绑定失败）。
而这些语义被官方客户端直接依赖：

| 参数 | 客户端用途 |
|---|---|
| `SearchText` | 历史搜索框 |
| `Starred` | 星标筛选 |
| `Types` | 类型筛选（此前只测了「返回数组形状」） |
| `SortByLastAccessed` | 排序切换 |
| `Before` / `After` | 时间范围分页（`HistorySyncer.FetchRemoteRangeAsync`） |
| `ModifiedAfter` | **增量同步**：`SyncAllAsync(_lastSyncTime)` 只拉 `LastModified >= 上次同步时间`，若它失效则会漏拉或全量重拉 |

**新增 `test/query-filters.test.ts`（8 例）**，逐条断言正反两向：

| 用例 | 关键断言 |
|---|---|
| SearchText | 命中子串；不匹配 → **空**；部分匹配（`gam`）也命中（上游 `LIKE %…%`） |
| Types | `Text` 命中三条；`File` → 空；组合 `Text,File` 同样命中 |
| Starred | `true` 只有星标那条；`false` 只有非星标两条 |
| 排序 | 默认 `CreateTime DESC` → gamma/beta/alpha；`SortByLastAccessed=True` → **beta/gamma/alpha**（顺序确实不同，故能区分） |
| Before/After | `Before=T2` 排除 gamma（`<`）；`After=T2` **包含** gamma（`>=`）；`SortByLastAccessed=True` 下同样参数语义随排序字段改变 |
| ModifiedAfter | `>= T1` 保留 beta/gamma；`>= T3` 只有 gamma；远未来 → 空 |
| 组合 | SearchText + Starred + ModifiedAfter 同时生效 |
| 边界 | `after >= before` → 400 且消息为上游的 `after must be less than before` |

**设计要点（避免假通过）**：
- 隔离用 text 里的唯一 `qf-<RUN>` 标记，**不用 SearchText 做隔离** —— 否则 SearchText 一旦失效会
  连带掩盖其它过滤器的断言。
- 时间戳用**未来**值（+1/+2/+3 天），确保这些记录在两种排序下都落在首页（页大小固定 50），
  不会被库里既有数据挤到第 2 页。
- 每条用例都断言「不该出现的记录必须不出现」，因此过滤器被忽略时会必然失败。
- **判别力实测**：临时禁用 `db.ts` 里的 `starred` 过滤 → 2 例失败
  （`expected [ 'gamma', 'beta', 'alpha' ] to deeply equal [ 'beta' ]`）；恢复后通过。

**全量 143/143（8 套件）通过。**

### 顺带实测：大文件路径的能力边界

`PUT /SyncClipboard.json` 上游用 `File.Move`（不读数据），本实现因 R2 无 move/rename 必须读入内存
再重传；`POST /api/history` 上游是 `MultipartReader` 流式，本实现整体读入请求体。本地实测
（内容哈希逐字节校验）：WebDAV 路径 **20MB / 60MB 通过**，multipart POST **20MB 通过**。
已记入 README「已知限制」与 protocol.md 差异表（并区分「已实测」与「未实测」——生产内存表现未测）。


## 21. 收尾：写库套件的自我收尾（避免污染目标库）（2026-09-13）

外部复核指出 `query-filters` 会向目标库留下记录且**永不回收**，复查后确认，并发现比指出的更深一层：

**问题**：该套件用未来时间戳（必要——两种排序都是 DESC，只有比既有记录都新才落在首页，页大小固定 50）。
但 `LastModified` 也被设成未来值，于是：

| 回收路径 | 谓词 | 未来 `LastModified` 的结果 |
|---|---|---|
| `softDeleteExpiredRecords`（保留期软删） | `LastModified < cutoff AND LastAccessed < cutoff` | 永不命中 |
| `trimToMaxCount`（条数裁剪） | 按 `MAX(LastModified, LastAccessed)` **升序**取最旧 | 排最后，实际不会先被裁 |
| `hardDeleteOldDeletedRecords`（30 天硬删） | `LastModified < now-30d` | 永不命中 |

**并且 afterAll 也删不掉**：`ShouldUpdate` 在时间差 > 5 分钟时要求 `newLastModified >= oldLastModified`，
用 `now` 收尾的 PATCH 会被判 **409**。已实证：对旧版遗留记录 PATCH `isDelete=true, lastModified=now`
→ **409**（该记录的 `lastModified` 是 2026-09-16）。

**修复**：

1. `LastModified` 改为**过去**值（`now-3d/-2d/-1d`，`M0/M1/M2`），`CreateTime`/`LastAccessed` 仍用未来值。
   这样 afterAll 以 `now` 收尾能正常软删，30 天后由 Cron 硬删，生命周期闭环。
2. 新增 `afterAll`：对 3 条 PATCH `isDelete=true`；**清理失败即判套件失败**（静默残留正是要避免的）。
3. 同类问题一并修：`cleanup.test.ts` 每次运行会留下一条**活跃**对照记录（`cron-keep-*`，其余记录已被
   Cron 软删），补 `afterAll` 删除它（其 `LastModified` 是当前时间，可正常删）。
4. 清理本会话在**本地开发库**积累的历史遗留：`qf-*` 15 条（API 删不掉，用 D1 收尾）、
   `cron-keep-*` 11 条（API 正常删除，11/11 成功），两者现均为 0 活跃。
5. 清理**线上**一条本会话放置的验证记录 `f33-proof.bin`（`File-D4B1E2E2…`，16:23 UTC 放置，
   不在 16:16 那轮名单里；PATCH `isDelete=true` → 200，数据端点转 404）。

**验证**：`total=18 / deleted=3`（本次运行产生的 3 条已被 afterAll 软删）、`active_keep=0`；
全量 **142/142**（8 套件）。

**已记录的约束**（design.md §12）：写库套件必须自我收尾且清理失败要判失败；
时间戳选择的两条约束（排序字段取未来值、`LastModified` 取过去值）。早期套件（`protocol`、
`fix-regressions`）写的是当前时间戳，会被保留期与条数裁剪自然回收，属**有界残留**。


## 22. 收尾：写库套件的目标守卫（防误指线上）（2026-09-13）

复核指出：只有 `cleanup`/`query-filters` 有 `afterAll`，而 `protocol`、`fix-regressions`、
`transports`、`signalr` 四个写库套件既无收尾也无「只可指向一次性实例」的守卫 —— 且
`fix-regressions.test.ts` 顶部还明确写着「此文件也会以线上 BASE 运行」。这正是本会话三次手工清理
（56 条 + 26 条）与 27 条永久孤儿记录的成因。

**采纳其建议并实施更根本的防护**（比逐个套件补 afterAll 更便宜、且防复发）：

新增 `test/support/target-guard.ts` 的 `assertWritableTarget(BASE)`，在六个写库套件
（`protocol`/`fix-regressions`/`transports`/`signalr`/`cleanup`/`query-filters`）的文件顶层调用：

- `BASE` 主机为本机（`127.0.0.1`/`localhost`/`::1`/`0.0.0.0`）→ 放行（本地与 CI 的 miniflare 均如此）；
- 否则要求 `ALLOW_REMOTE_TARGET=1`，**未设即抛错终止**（模块顶层抛错 → 连 `beforeAll` 都不执行，
  不会产生任何写入），错误信息里直接给出放行命令。

**双向验证**：

| 场景 | 结果 |
|---|---|
| `BASE=https://…workers.dev`（无放行） | 文件级 FAIL，报「拒绝把写库套件指向非本机目标」并附 `ALLOW_REMOTE_TARGET=1` 用法；**零写入** |
| 同上 + `ALLOW_REMOTE_TARGET=1` | 正常运行（实测 1 用例通过） |
| 本地默认 `npm test` | **142/142** 通过（守卫不干扰本机与 CI） |

**设计取舍**：不在四个旧套件里逐个补 `afterAll` —— 它们的残留时间戳是「当前时间」、会被保留期与
条数裁剪自然回收（有界残留），而「误指线上」才是真正会造成不可回收残留的路径；用一处守卫堵住
入口比在六处补收尾更小更稳。

## 23. 待办与已知问题

- [ ] **线上 27 条活跃记录的数据文件已被（已修复的）孤儿清理误删，需从客户端重传**（见 §19 的恢复路径）
- [ ] **线上 secrets 仍为 admin/admin，需用户修改**（`wrangler secret put USERNAME/PASSWORD`；或配 `SYNC_AUTH_CREDENTIALS` 由 CI 管理）
- [ ] 可选：官方真实客户端连接线上 URL 完成一次完整同步（协议栈已由本地真客户端 + 线上 @microsoft/signalr 双重验证）
- [ ] 可选：绑定自定义域名（wrangler.toml routes 或 Cloudflare 控制台）

已知限制（详见 README）：免费版单请求 100MB；畸形 zip 的隐式目录/重复条目语义与上游在第三方畸形输入上存在 minor 差异（官方客户端不可达）。

## 24. 版本记录

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
| 1.8.0 | 2026-09-12 | 第八轮：补上 SignalR SSE/长轮询回退 + 修复提前返回未消费请求体导致的 503（113 测试全绿） |
| 1.9.0 | 2026-09-12 | 第九轮：输入校验（JSON body/Types 数字/布尔/整数 TryParse）+ size 口径 + File→Image 提升 + data 端点 404（123 测试全绿） |
| 1.10.0 | 2026-09-12 | 第十轮：逐条核对两个控制器的每个返回点（状态码全一致）+ 补 `GET /SyncClipboard.json` 损坏值降级（125 测试全绿） |
| 1.11.0 | 2026-09-12 | 第十一轮：hash 路径字符约束（写路径 400 / 读取降级 / key 断言三层，对齐上游 GetWorkingDirName，129 测试全绿） |
| 1.12.0 | 2026-09-12 | 第十二轮：CI 质量门升为全 6 套件协议回归（独立 quality job + 自起本地服务器）+ 测试凭据变量专用化（修 Windows USERNAME / CI USER 冲突） |
| 1.13.0 | 2026-09-13 | 第十三轮：读 ASP.NET Core 源码核对 negotiate 逐字契约（补 `negotiateVersion` 恒输出、版本错误路径与钳制语义，130 测试全绿） |
| 1.14.0 | 2026-09-13 | **生产事故修复**：孤儿目录清理的键形式不一致导致每小时清空全部历史数据（F33，131 测试全绿） |
| 1.14.1 | 2026-09-13 | 补 `test/cleanup.test.ts`：经 `GET /__scheduled` 触发真实 Cron 的端到端回归守卫（含防空转设计） |
| 1.14.2 | 2026-09-13 | 补清理的**广播副作用**用例（4 例）+ 记录 `HEAD` 映射的证据与超集差异（135 测试全绿） |
| 1.15.0 | 2026-09-13 | 第十五轮：查询过滤/排序语义端到端覆盖（8 例，客户端 UI 与增量同步依赖）+ 大文件路径实测（143 测试全绿） |
| 1.15.1 | 2026-09-13 | 写库套件自我收尾：`query-filters`/`cleanup` 补 afterAll（清理失败即判失败）+ 时间戳约束（排序取未来、LastModified 取过去） |
| 1.15.2 | 2026-09-13 | 六个写库套件加**目标守卫**：`BASE` 非本机且未设 `ALLOW_REMOTE_TARGET=1` 即抛错（防误指线上） |
