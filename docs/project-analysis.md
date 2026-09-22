# SyncClipboard CfServer 全面解析

> **说明**：本文件只描述项目**当前**的架构与实现，不记录改动过程。
> 文中 `文件:行号` 形式的出处以文件内容为准；协议行为以 [`protocol.md`](protocol.md) 为准，
> 界面以 [`ui.md`](ui.md) 为准，取舍理由见 `docs/design.md` 的决策记录。

## 1. 定位
- **一句话概括**：基于 Cloudflare Workers + D1 + R2 + Durable Objects，用 TypeScript 完全独立重写上游 [SyncClipboard](https://github.com/Jeric-X/SyncClipboard) 官方 ASP.NET Core 同步服务器的边缘无服务器实现，并内嵌纯原生零构建的 Web 历史管理系统。
- **解决什么问题**：官方客户端连接第三方存储（WebDAV / S3）时只能使用轮询模式且缺失剪贴板历史面板；只有连接官方 C# 服务端才能启用基于 SignalR 的长连接实时双向同步和历史跨设备漫游。本项目将官方服务端的专属能力原样移植至 Cloudflare Serverless 架构，使用户无需自备 VPS、Docker 与守护进程，在 Cloudflare 个人免费额度内即可获得与官方服务端一致的体验。
- **支持平台**：
  - 官方桌面端客户端（Windows WinUI3 / WPF、macOS、Linux，要求版本 ≥ 3.1.1）；
  - 官方/第三方移动端（Android、iOS 等基于 WebDAV / 历史 API 的客户端）；
  - 现代桌面与移动端浏览器（Web 管理后台）。
- **出处**：`README.md:1-25`、`docs/design.md:7-35`、`docs/protocol.md:1-20`。

---

## 2. 功能要点
提炼自 `README.md`、`docs/protocol.md` 与 `docs/ui.md`：

1. **WebDAV 兼容同步**：支持 `SyncClipboard.json` 当前剪贴板 Profile 读取与写入；支持 `/file/*` 附件流式暂存与清理；支持 `PROPFIND`（207 Multi-Status）与 `MKCOL` 目录探活，完全满足客户端在 `PreciseDelete` 模式下的目录递归发现与清理。*(出处：`src/routes/webdav.ts`、`docs/protocol.md §4`)*
2. **SignalR 实时推送中枢**：支持 `/SyncClipboardHub`；按官方顺序宣告并支持 **WebSockets（首选）→ Server-Sent Events (SSE) → LongPolling (长轮询)** 三种传输协议，在网络受限时自动平滑降级；实现 15 秒心跳 Ping 守护与 60 秒静默超时连接清理；写操作后毫秒级向全员广播 `RemoteProfileChanged` 与 `RemoteHistoryChanged`；界面侧的批量写把整批广播**合并成一次 DO 子请求**投递（消息内容与顺序不变，100 条批量写从 100 次子请求降为 1 次）。*(出处：`src/durable/SyncClipboardHub.ts`、`src/durable/signalr.ts`、`src/hub.ts`)*
3. **历史记录与跨设备同步（`/api/history/*`）**：全套对齐上游 HistoryController；支持分页（Page 从 1 起，固定每页 50 条）、时间跨度过滤（Before/After/ModifiedAfter）、全文模糊匹配（`LIKE %text%`）、ProfileTypeFilter 位掩码筛选；历史上传在本实现里只有**单条**端点（`POST /api/history`；协议端点表里没有批量项 —— 批量语义只存在于界面面的 `/ui/api/history/batch-update`）；支持基于版本号（`version`）的 PATCH 乐观并发修改，冲突返回 409 及服务器**当前值**实体。*(出处：`src/routes/history.ts`、`src/historyOps.ts`)*
4. **严格逐字节对齐的数据完整性校验**：服务端逐字节复刻上游 C# 的哈希算法；对客户端提交的数据在落库前做严格校验，哈希不符直接 400/422 拒绝。*(出处：`src/hash.ts`、`docs/protocol.md §8`)*
5. **分级保留与定时清理（Cron Pipeline）**：通过 Cron Trigger 每 20 分钟执行一次后台任务；包含保留期过期软删除、记录总数上限裁剪、已删除超过 30 天的记录硬删除、以及 R2 孤儿存储目录回收。*(出处：`src/cleanup.ts`)*
6. **内置 Web 历史管理面板（V1 生产面）**：浏览器访问站点根（`GET /` 且 `Accept` 含 `text/html`，且界面开关 `UI_ENABLED` 开着）时 302 跳转至 `/ui_v1/`；提供全文检索、类型与自定义时间范围筛选、原图预览、文本一键复制与编辑、文件下载、单条与批量收藏置顶/删除/恢复、回收站与在线维护面板（Cron 运行状态、保留参数在线调整、数据完整性自检）。四条与写路径有关的语义（都落在 `/ui/api/*`，不新增协议行为）：
   - **预览里的「编辑」保存 = 新建一条文本记录**：文本记录的 `hash = SHA256(utf8(正文))`，正文一改就是另一条记录；保存走协议 `POST /api/history` 的同一套写路径，因此**只广播 `RemoteHistoryChanged`、不触碰当前剪贴板**；正文上限 1 MiB。
   - **界面的复制 / 下载会推进该记录的 `LastAccessed`**：载荷回显 `version` 与 `lastModified`，使落库改动的只有访问时间 —— 版本不动则官方客户端随后的同步不会被判成冲突，修改时间不动则「修改」列不因一次复制而跳。
   - **批量动作在途可中止**：确认框的「取消」与选择条上那枚按钮在途时都变成「中止」，中止点落在批与批之间（在途那一批跑完），已生效条数如实报出。
   - **回收站是可恢复形态**：软删只置 `IsDeleted=1`、**数据文件保留**，30 天内可连同数据一起恢复；行内「彻底删除」与「清空回收站」是立刻释放 R2 空间的出口（前者只删 `IsDeleted != 0` 的行，判据写在 SQL 里）。
   「数据不可用」这一标注只在 **R2 对象确实缺失**时出现（界面数据端点的 `data_missing`），与是否已删无关。*(出处：`src/ui/routes.ts`、`src/historyOps.ts`、`public/ui_v1/js/main.js`、`docs/ui.md` §5)*

---

## 3. 解决方案结构

### 3.1 模块与项目清单

| 模块目录 / 文件 | 技术类别 | 核心职责 |
|---|---|---|
| `src/index.ts` | Hono / Worker Entry | 网关总入口：中间件串联、静态资源与 WebUI 熔断判定、路由转发、Cron 调度 |
| `src/routes/` | Hono 业务路由 | `webdav.ts`（WebDAV 兼容端点）、`history.ts`（官方 `/api/history/*` 接口） |
| `src/durable/` | Cloudflare Durable Objects | `SyncClipboardHub.ts`（SignalR 连接池、心跳、广播、限速权威状态）、`signalr.ts`（帧编解码） |
| `src/ui/` | Web 界面服务端面 | `/ui/api/*` 专属接口、HMAC-SHA256 无状态签名 Cookie 会话、维护与自检接口 |
| `src/` (核心领域与存储) | 核心算法与存储模型 | `db.ts`（D1 数据层）、`storage.ts`（R2 访问层）、`hash.ts`（哈希与解压）、`profile.ts`（Profile 状态机）、`cleanup.ts`（定时清理） |
| `src/` (横切与基础设施) | 输入校验 / 响应头 / 路由前置 | `serialization.ts`（DTO 序列化与解析）、`requestLimits.ts`（体量上限与 loopback 判定）、`contentTypes.ts`（Content-Type 与附件加固）、`multipart.ts`（字节级表单解析）、`pathCase.ts`（协议路径字面段归一）、`webdavXml.ts`（PROPFIND 207）、`rateLimit.ts`（认证失败限速）、`uiEnabled.ts`（界面开关） |
| `public/ui_v1/` | 前端生产界面 (V1) | 纯原生 ES 模块与 CSS，零构建；系统默认主界面 |
| `public/ui_v2/` | 前端重构实验面 (V2) | 新一代设计系统与状态机演进分支，本体位于 `/ui_v2/app/` |
| `public/ui_shared/` | 两版共用的静态资产层 | 品牌图标（`brand/`）与无版本耦合的纯数据模块（`js/icons.js`）；V1 只允许逃到这一层，仍禁止引用 `/ui_v2/` |
| `public/ui/` | 页面跳转壳 | 仅包含 `index.html` 与 `redirect-hash.js`，将老书签携带 URL Fragment 重定向到 `/ui_v1/` |
| `test/` | Vitest 测试工程 | 22 个测试套件，涵盖协议回归、长连接通信、安全防爆破、清理预算与文档口径 |
| `tools/` | 按需运行的核实工具 | `ab-upstream-probe.ps1`（对官方服务端发布件做 A/B 逐条对照，退出码 = 未登记差异数）、`check-d1-like-limit.mjs`（核对 D1 的 LIKE 模式上限是否仍与常量一致）；不进任何套件、不参与部署产物 |
| `schema.sql` / `wrangler.toml` | 部署输入 | D1 建表、索引与去重语句（幂等）；绑定、DO 迁移、`[vars]`、Cron、`[assets]` 与可观测性声明 |
| `.github/workflows/deploy.yml` | CI / CD | `quality`（typecheck + lint + 全部套件，自起 miniflare）→ 解析或创建 D1/R2 → 应用 schema → 部署 → 只读冒烟 |
| `docs/` | 文档体系 | 设计、协议、界面、进度与审计记录（分工见 §10.1） |

### 3.2 依赖与调用拓扑

```mermaid
flowchart TD
    Client["官方客户端 (v3.1.1+) / WebDAV / 浏览器"] -->|HTTP 请求| Entry["src/index.ts (Worker Entry)"]
    Client <-->|WebSocket / SSE / LongPolling| HubDO["src/durable/SyncClipboardHub.ts (DO)"]

    subgraph EntryBranch["入口前置分支（在 Hono 之外，src/index.ts 的 fetch）"]
        PathNorm["① 协议路径字面段大小写归一 (src/pathCase.ts)"]
        AssetSwitch["② UI_ENABLED 分支：/ui* 转 ASSETS 或 404；/ui/api* 交 Hono 或 404 JSON"]
        HubRoute["③ negotiate 与 Hub 连接转发 DO"]
    end

    subgraph MiddlewareChain["Hono 中间件链（注册顺序即执行顺序）"]
        HSTS["④ 明文 301 升级 + HSTS（loopback 除外）"]
        BodyLimit["⑤ 请求体上限预检 (48~64 MiB → 413)"]
        OriginCheck["⑥ /ui/api/* 来源校验 + 登录限速"]
        BasicAuth["⑦ 全局 Basic Auth（放行 /ui/* 与浏览器根导航）"]
    end

    Entry --> EntryBranch
    EntryBranch --> MiddlewareChain

    subgraph Handlers["路由分发层"]
        WebDAV["src/routes/webdav.ts"]
        HistoryAPI["src/routes/history.ts"]
        UIAPI["src/ui/routes.ts"]
        StaticAssets["public/** (ASSETS binding)"]
    end

    MiddlewareChain --> WebDAV
    MiddlewareChain --> HistoryAPI
    MiddlewareChain --> UIAPI
    AssetSwitch --> StaticAssets
    HubRoute --> HubDO

    subgraph ServiceLayer["业务与领域服务"]
        ProfileSvc["src/profile.ts (Profile 校验与截断)"]
        HistoryOps["src/historyOps.ts (历史并发写入与清空)"]
        CleanupSvc["src/cleanup.ts (预算受控清理管线)"]
    end

    WebDAV --> ProfileSvc
    HistoryAPI --> ProfileSvc
    HistoryAPI --> HistoryOps
    UIAPI --> HistoryOps
    Entry -.Cron 每 20 分钟.-> CleanupSvc

    subgraph InfraLayer["数据与存储访问"]
        DB["src/db.ts (HistoryDb)"]
        Storage["src/storage.ts (R2Storage)"]
        Hash["src/hash.ts (流式哈希/fflate)"]
        Session["src/ui/session.ts (HKDF Cookie)"]
    end

    ProfileSvc --> DB
    ProfileSvc --> Storage
    ProfileSvc --> Hash
    HistoryOps --> DB
    HistoryOps --> Storage
    UIAPI --> Session
    CleanupSvc --> DB
    CleanupSvc --> Storage

    ProfileSvc -.写后广播.-> HubDO
    HistoryOps -.写后广播.-> HubDO
    HubDO -.推送变更通知.-> Client

    subgraph CloudflareCloud["Cloudflare 基础设施"]
        D1[("D1 Database (SQLite)")]
        R2[("R2 Storage Bucket")]
    end

    DB --> D1
    Storage --> R2
```
*(出处：`src/index.ts`、`src/hub.ts`、`src/uiEnabled.ts`、`docs/design.md` §3)*

### 3.3 界面服务端接口（`/ui/api/*`）

这一层只服务本站页面，**不属于协议契约**（官方客户端不感知任何 `/ui/*` 路径）；但它与协议面**共用**
同一张表、同一套行映射（`db.ts` 的 `rowToEntity`）与 DTO 序列化，写操作也走同一条写路径
（`historyOps.applyHistoryUpdate`），因此不存在「界面改了而客户端不知道」。
**下面 20 条就是完整清单** —— `test/ui-guard.test.ts` 的 `EXPECTED_API_ROUTES` 与之逐条对齐，
增删端点必须同时改那里（守卫会遍历 Hono 注册表逐条打未认证请求，只放行 3 条公开端点）。

**公开（3 条，不需要凭据）**：`POST /login`（表单登录 → 签发会话 Cookie；400 请求体非法 / 401 凭据错误 /
500 未配置凭据）、`POST /logout`（清本机 Cookie）、`GET /session`（探测登录态，**总是 200**，用
`authenticated` 表达）。**其余 17 条**要求会话 Cookie 或 Basic，未带凭据一律 401。

| 方法 | 路径（前缀 `/ui/api`） | 语义 | 错误 |
|---|---|---|---|
| GET | `/history` | 列表：`page`、`pageSize`(≤500)、`types`、`search`、`starred`、`after`/`before`、`deleted`、`sort`(6 字段白名单)、`order`、`includeDeleted`、`pinnedFirst`(默认 true)；正文截断 500 字符并带 `textTruncated` | 400 参数非法 |
| GET | `/history/:type/:hash` | 单条元数据（**正文完整**） | 400 / 404 |
| GET | `/history/:type/:hash/data` | 数据文件；`?download=1` 走附件；支持单区间 `Range`（206 + `content-range`，后缀区间 `bytes=-n`，不可满足 → 416） | 404 `not_found` / 404 `data_missing` |
| POST | `/history` | **新建一条文本记录**（预览框「编辑」保存）：`{text}` → 落库并回读该条 | 400 `text_required` / `text_too_large` / 415 |
| PATCH | `/history/:type/:hash` | 收藏 / 置顶 / 删除；也承接「触碰访问时间」的 `{lastAccessed, lastModified, version}` | 400 / 404 / 409 |
| POST | `/history/batch-update` | 批量写（`starred` / `pinned` / `isDelete`），**单次 ≤100 条**、有界并发 10、整批一次广播 | 400 / 415 |
| POST | `/history/batch-meta` | 批量取记录（**含完整正文**），单次 ≤100 条；用于「选中多条 → 一起复制/下载」 | 400 / 415 |
| POST | `/history/batch-purge` | 回收站「彻底删除」：只删 `IsDeleted != 0` 的行并清其数据目录；单次 ≤100 条、不广播 | 400 / 415 |
| POST | `/history/clear` | 清空历史：`{scope:'trash'\|'all'}`；`all` 与协议 `DELETE /api/history/clear` **共用同一实现** | 400 / 415 |
| POST | `/hub-ticket` | 签发一张 Hub 连接票据 `{token, path}`，供前端建 WebSocket（浏览器不能给 WS 设请求头，故走票据） | 503（DO 不可达，前端继续轮询） |
| GET | `/statistics` | 官方统计 + 三套计数：`byType`（随 `deleted` 走）、`byTypeActive`（恒为活跃口径）、两个 `starredCount*` | 400 参数非法 |
| GET | `/overview` | **首屏合成快照**：统计、类型计数、变更标记、部署信息、`serverTime` 同源一次返回 | 400 参数非法 |
| GET | `/activity` | 活动趋势：`days`(≤90) + `tz`(分钟偏移)，「一天」按调用方时区切分 | 400 `invalid_range` |
| GET | `/info` | 部署信息：客户端该填的地址、版本、Hub 传输、保留策略（含来源）、存储占用、**清理可观测面**（`lastRunAt` / `lastError` / 各阶段游标） | — |
| GET | `/poll` | 变更信号 `{count, lastModified, serverTime}`（`serverTime` 供界面显示时钟差） | — |
| GET | `/integrity` | 数据完整性自检：期望目录集 × R2 实际对象求差，只对差集逐条探测（不逐条 HEAD） | — |
| PUT | `/settings` | 保留策略在线调整：扁平 `{retentionMinutes?, maxSavedHistoryCount?}`，数字 = 覆盖、`null` = 清除覆盖回落到部署变量、缺省字段 = 不改动；响应回读生效值 | 400 / 415 |

横切约定：

- **缓存**：`/ui/api/*` 的 JSON 一律 `no-store`；唯数据端点自带 `private, max-age=60`（预览/缩略图复用）。
- **内容类型**：五个写端点只接受 `application/json`，非 JSON → 415（跨站**表单**能直接发 POST 且不过 CORS 预检，而 JSON 必须由脚本构造 ⇒ 这是一层纵深防御）。
- **来源校验**：`/ui/api/*` 的状态变更方法校验 `Origin` 与 `Sec-Fetch-Site`，外源一律 403。
- **鉴权靠注册顺序**：守卫以 `use('/ui/api/*')` 在受保护路由**之前**注册；维护端点（`integrity` / `settings`）显式注册在它之后（顺序写反 = 端点照常工作但不再要求凭据，守卫会遍历断言 401）。
- **未知路径**：`/ui/api/*` 未命中返回 `{"error":"not_found"}` JSON（页面命名空间才返回 404 页）。

*(出处：`src/ui/routes.ts`、`src/ui/query.ts`、`src/ui/maintenance.ts`、`src/ui/guard.ts`、`test/ui-guard.test.ts`、`docs/ui.md` §5)*

---

## 4. 技术栈与依赖

### 4.1 核心运行时与依赖库
- **语言**：TypeScript `^5.6.0`（`strict` + `noUncheckedIndexedAccess`；**`noEmit: true`** —— 仓库不产出编译文件，类型只作静态把关，运行时由 wrangler/esbuild 就地处理 TS）。*(出处：`tsconfig.json`、`package.json`)*
- **Web 框架**：`hono` (v4.6.0) —— 边缘极轻量 Web 路由框架，提供零开销中间件模型与类型安全上下文绑定。*(出处：`package.json:17`)*
- **解压引擎**：`fflate` (v0.8.2) —— 纯 JavaScript 实现的高性能 zip 流式解压库，无 Node 平台 C++ 扩展依赖，完全运行在 Cloudflare V8 isolate 内部。*(出处：`package.json:16`、`src/hash.ts:2`)*
- **MIME 映射**：`mrmime` (v2.0.1) —— 438 项扩展名→类型表（MIT、零依赖），另留 12 项本地补遗（`mrmime` 未收录的 `.docx`/`.xlsx`/`.pptx`/`.xls`/`.ppt`/`.7z`/`.rar`/`.tar`/`.ico`/`.avi`/`.mkv`/`.flac`）。*(出处：`package.json` 的 `dependencies`、`src/contentTypes.ts`)*

### 4.2 开发与测试工具链
- **Wrangler**：`^4.131.2` —— Cloudflare Workers 部署与本地 Miniflare 边缘模拟环境。
- **Vitest**：`^2.1.0` —— 测试框架，驱动 22 个测试套件。
- **@microsoft/signalr**：`^8.0.7` —— 微软官方 SignalR 客户端，仅用于自动化测试验证 Hub 长连接通信。
- **ESLint**：`^10.10.0` —— 只覆盖**零构建前端与手动探针**（`public/ui_v1/js`、`public/ui_v2/js`、`public/ui_shared/js`、`test/manual`）；`src/**` 与 `test/**` 由 `tsc --noEmit` 把关，**eslint 不覆盖后端**（见 `eslint.config.js` 头部）。
- **其它开发依赖**：`globals`（eslint 环境）、`undici`（测试期 fetch 实现）、`@types/node`。
- **出处**：`package.json` 的 `devDependencies` 与 `scripts`。

---

## 5. 核心数据模型

### 5.1 领域实体与 DTO（`src/types.ts`、`src/ui/query.ts`）

| 模型名称 | 类型 | 存储/传输格式 | 关键行为与校验规则 |
|---|---|---|---|
| **`ProfileType`** | 枚举 | `0:Text, 1:File, 2:Image, 3:Group, 4:Unknown, 5:None` | 传输序列化为字符串；`POST`/`PUT` 拒绝 `Unknown`/`None` |
| **`ProfileTypeFilter`** | 枚举位掩码 | `None=0, Text=1, File=2, Image=4, Group=8, FileAndGroup=10, All=15` | 用于 `/api/history/query` 与 `/ui/api/history` 的类型组合筛选；**名字**（`Text,Image`）与**数字**（`5`）都接受，非法名 → 400（协议面）|
| **`ProfileDto`** | DTO | JSON (camelCase) | `hasData: boolean`；大文本（>10240 字符）时 `text` 只带前 10240 字符前缀、全文走传输数据文件，`size` 仍为全文字符数；**`dataName` 为 null 时保留该键、`size` 为 null 时整键省略**（对齐上游 `WhenWritingNull` 的不对称） |
| **`HistoryRecordDto`** | DTO | JSON (camelCase) | 客户端拉取历史记录的载体；`size`（Text 为字符数、File/Image 为字节数、Group 为解压后条目和）、`version`（并发版本号）、`hasData` 由 `filePaths`/`transferDataFile` 推导 |
| **`HistoryRecordUpdateDto`** | DTO | JSON (camelCase) | 乐观更新载体；字段名严格为 `isDelete`（非 isDeleted）；`version` 必须是 int32、日期字段必须是可解析串，否则 400 |
| **`HistoryRecordEntity`** | 数据库实体 | SQLite 行映射 (`HistoryRecords`) | `stared` 对应列名 `Stared`；`filePaths` 序列化为 JSON 字符串；时间列为 epoch 毫秒 |
| **`HistoryQueryDto`** | DTO（表单） | multipart 或 `application/x-www-form-urlencoded`，字段名 **PascalCase** | `Page` / `Before` / `After` / `ModifiedAfter` / `Types` / `SearchText` / `Starred` / `SortByLastAccessed`；**绑定失败即 400**（唯一的例外：时间字段解析不了时忽略该项） |
| **`HistoryStatisticsDto`** | DTO | JSON (camelCase) | `totalCount` / `starredCount` / `deletedCount` / `activeCount` / `totalFileSizeMB`（保留两位小数，有数据但不足 0.01 MB 时取 0.01） |
| **`UiHistoryItem` / `UiHistoryListItem`** | DTO（界面面） | JSON (camelCase) | 协议 `HistoryRecordDto` **加上** `id`（D1 行 ID，仅前端 key/展示）与 `dataName`；列表项另把 `text` 截断到 500 字符并置 `textTruncated`（全文走单条端点） |
| **`UiViewCounts`** | 聚合结果 | 进程内对象 | 一条 `GROUP BY Type, IsDeleted, Stared` 出齐：活跃/回收站两套按类型计数 + 两个收藏计数（`byType` 随视图走、`byTypeActive` 恒为活跃口径） |

*(出处：`src/types.ts`、`src/serialization.ts`、`src/ui/query.ts`、`docs/protocol.md` §3)*

### 5.2 存储与索引模式（`schema.sql`）

- **`HistoryRecords` 表**：
  - 主键：`ID INTEGER PRIMARY KEY AUTOINCREMENT`（同时是 SQLite 的 rowid 别名）；
  - 并发防重唯一索引：`CREATE UNIQUE INDEX ux_h_user_type_hash ON HistoryRecords(UserId, Type, Hash)`，从数据库底层阻断多客户端并发提交相同内容的重复插入（应用层的「先查再插」在并发下保证不了唯一性）；
  - 建唯一索引**之前**先跑一句去重 `DELETE`（同一 `(UserId, Type, Hash)` 只保留最小 `ID` 的行）—— 否则存量重复行会让索引创建失败；
  - 检索索引群：覆盖 `(UserId, CreateTime)`、`(UserId, LastAccessed)`、`(UserId, LastModified)`，以及针对收藏筛选的复合索引 `(UserId, Stared, CreateTime)` 与 `(UserId, Stared, Type, CreateTime)`；另有一条与唯一索引同形的非唯一索引 `idx_h_user_type_hash`（查询走它，唯一性由上面的约束保证）。
- **`Meta` 表**：
  - 键值存储：`Key TEXT PRIMARY KEY, Value TEXT NOT NULL`；
  - 键的四个族（键名定义处：`src/cleanup.ts` 的 `CLEANUP_META_KEYS` / `SETTINGS_META_KEYS`、`src/db.ts` 的 `current_profile`）：
    - `current_profile` —— 当前剪贴板快照（ProfileDto JSON）；
    - `cleanup:lastRunAt` / `cleanup:lastError` —— 清理轮次的可观测面（`/ui/api/info` 只读展示同名键）；
    - `cleanup:cursor:retention` / `cleanup:cursor:trim` / `cleanup:cursor:hardDelete` / `cleanup:cursor:orphans` —— **每个阶段一个**游标键（**不存在**聚合的 `cleanup:cursors`）；
    - `settings:retentionMinutes` / `settings:maxSavedHistoryCount` —— 免重新部署的在线覆盖。
- **出处**：`schema.sql:1-45`。

### 5.3 哈希计算与防爆破模型（`src/hash.ts`）

- **Text**：`SHA256Hex(UTF-8(text))`；
- **File / Image**：`SHA256Hex(UTF-8($"{fileName}|{contentHash.toUpperCase()}"))`；
- **Group (Zip 文件夹)**：按无符号字典序（`ByteArrayComparer`）对条目排序后格式化为 `D|{name}\0` 与 `F|{name}|{length}|{hash}\0`，拼接计算 SHA-256；三条与输入形状有关的规则：
  - **隐式父目录计入**：文件条目路径上的每一级目录都被补进目录条目集（等价于上游"解压后遍历文件系统"）；目录条目名以 `/` 结尾，空目录同样计入；
  - **同名重复条目取首见**（对齐上游"首次写入优先"）；
  - **条目名安全校验一律拒**（不依赖平台）：盘符形态（`C:/…`、`C:\…`）、含反斜杠或 NUL、前导 `/`、以及 `..` / `.` 段；而 `a:b.txt`、`1:30.txt` 这类"第二字符是冒号"的普通名字**接受**。`text` 字段由**顶层条目名**（`TrimEnd('/')` 后不含 `/`）用 `\n` 拼成。
- **防 Zip 炸弹护栏**：流式解压限制最大体积 64 MiB、条目数 ≤ 1000、单条目解压膨胀比 ≤ 100:1（比值只在单条目解压后 ≥ 8 MiB 时才判定）。
- **解压预算随 Body 收缩**：`groupZipDecompressionCap(zip) = clamp(96 MiB - zip.length, 1 MiB, 64 MiB)`（`ISOLATE_TRANSFER_BUDGET_BYTES = 96 MiB`）。理由是 zip 的压缩体与解压内容在解压期间**同时存活**，两个上限各自贴顶会顶穿 isolate。
- **出处**：`src/hash.ts`（`groupZipDecompressionCap`）、`src/requestLimits.ts`。

---

## 6. 核心架构与分层描述

```
[模型层]   src/types.ts, src/serialization.ts (数据契约与严格类型同构)
   │
[存储层]   src/db.ts, src/storage.ts (D1 SQLite 访问与 R2 分层对象读写)
   │
[业务层]   src/profile.ts, src/historyOps.ts, src/cleanup.ts (状态机、并发控制、定时管线)
   │
[通讯层]   src/durable/SyncClipboardHub.ts, src/hub.ts (SignalR 协议与 DO 长连接广播)
   │
[适配层]   src/routes/webdav.ts, src/routes/history.ts, src/ui/routes.ts (端点解析与契约映射)
   │
[网关壳]   src/index.ts, src/auth.ts, src/rateLimit.ts (全局安全中间件、Hono 路由总装)
```

1. **模型层**：以领域类型为唯一事实源，消除 C# 与 JS 跨语言边界的空值、时间格式与位运算差异。
2. **存储层**：D1 负责强一致事务与元数据检索；R2 负责二进制数据归档（`file/` 暂存与 `history/{Type}_{hash}/` 持久区分离），杜绝防御性 Buffer 拷贝以保住 128 MiB 内存上限。
3. **业务层**：`profile.ts` 协调 Profile 入库与大文本自动转附件；`historyOps.ts` 集中收敛官方 PATCH 与 WebUI 写操作，保证数据修改、广播与 R2 清理原子一致；`cleanup.ts` 基于严格的 800 次子请求配额调度定时任务。
4. **通讯层**：通过 Durable Object 单例有状态管理连接池，实现跨边缘无状态实例的实时消息全员广播与权威限速计数。
5. **适配层**：将 WebDAV、ASP.NET Core 专有格式与 WebUI 接口分流隔离，确保协议面与产品展示面解耦。
6. **网关壳**：统一处理 TLS 强制、HSTS、防时序 Basic 鉴权、流式 Body 排空及前端静态资源代理。
- **出处**：`docs/design.md:130-220`。

---

## 7. 关键流程

### 流程 1：剪贴板变更上传与实时广播（PUT /SyncClipboard.json）

```mermaid
sequenceDiagram
    autonumber
    actor Client as 官方客户端 A
    participant Gateway as src/index.ts (网关)
    participant WebDAV as src/routes/webdav.ts
    participant Profile as src/profile.ts
    participant D1 as D1 数据库
    participant R2 as R2 存储桶
    participant Hub as SyncClipboardHub (DO)
    actor OtherClient as 官方客户端 B

    Client->>Gateway: PUT /SyncClipboard.json (带 ProfileDto JSON)
    Gateway->>Gateway: ① 路径字面段归一 → ② 明文 301/HSTS → ③ 预检 Content-Length(≤48MiB→413) → ④ 全局 Basic 鉴权 → ⑤ (路由内) 解析 JSON + 校验 hash 无路径分隔符
    Gateway->>WebDAV: 路由分发
    WebDAV->>Profile: putSyncProfile(dto)
    alt hash 命中未删除的历史记录
        Profile->>D1: 更新该记录：LastAccessed = LastModified = now，Version++
        Profile->>Hub: RemoteHistoryChanged(记录 dto)
    else 未命中（新建 / 复活已删记录）
        Profile->>Profile: resolveCreateProfileType（扩展名为图片时 File 提升为 Image）
        opt hasData = true
            Profile->>R2: 读 file/{dataName} 实际字节
            Profile->>Profile: 重算数据哈希比对校验（不符则 400）
            Profile->>R2: 写 history/{Type}_{hash}/{fileName} 并删暂存（R2 无 move ⇒ 读 + 写 + 删）
        end
        Profile->>D1: 插入或复活记录（ux_h_user_type_hash 保证唯一，冲突走合并）
        Profile->>Hub: RemoteHistoryChanged(记录 dto)
    end
    Profile->>D1: 写入 Meta.current_profile（记录 dto 的副本）
    Profile->>Hub: RemoteProfileChanged(dto)
    Hub-->>OtherClient: WebSocket 推送上述变更帧
    WebDAV-->>Client: 200 OK（**空体**；返回 DTO 的是 POST /api/history）
```
*(出处：`src/routes/webdav.ts` 的 `PUT /SyncClipboard.json` 分支、`src/profile.ts` 的 `putSyncProfile` / `addProfile` / `saveAndNotifyCurrentProfile`)*

### 流程 2：SignalR 协商、升级与传输降级链路

```mermaid
sequenceDiagram
    autonumber
    actor Client as 官方客户端
    participant Entry as src/index.ts
    participant HubRoute as src/hub.ts
    participant DO as SyncClipboardHub (DO)

    Client->>Entry: POST /SyncClipboardHub/negotiate
    Entry->>HubRoute: negotiateResponse()
    HubRoute->>DO: 注册并生成 connectionToken (TTL: 10分钟)
    HubRoute-->>Client: 200 返回三种协议: WebSockets, SSE, LongPolling

    alt 首选: WebSocket 建立
        Client->>Entry: GET /SyncClipboardHub?id={token} (Upgrade: websocket)
        Entry->>DO: forwardToHub() 移交 WebSocketPair
        DO-->>Client: 101 Switching Protocols
        Client->>DO: 发送握手帧 (protocol=json, version=1, 终止符 0x1e)
        DO-->>Client: 返回握手响应 ({}, 终止符 0x1e)
        loop 维持心跳
            DO-->>Client: 每 15 秒发送心跳帧 (type=6 Ping, 终止符 0x1e)
        end
    else 降级 1: Server-Sent Events (SSE)
        Client->>Entry: GET /SyncClipboardHub?id={token} (Accept: text/event-stream)
        Entry->>DO: forwardToHub() 挂起流式响应（先写一个注释帧促使首字节下发）
        DO-->>Client: 200 OK (持续流式推送 data 帧)
    else 降级 2: LongPolling（单次挂起 25 秒；服务端关闭 = 204）
        Client->>Entry: GET /SyncClipboardHub?id={token}  取消息
        Client->>Entry: POST /SyncClipboardHub?id={token} 上报消息（握手/Ping/Close）
        Client->>Entry: DELETE /SyncClipboardHub?id={token} 结束连接
    end
```
*(出处：`src/hub.ts`、`src/durable/SyncClipboardHub.ts`、`docs/protocol.md` §6.1)*

三条对外契约（客户端按它们分支）：

- **出错也返回 HTTP 200，且响应体只有 `error` 一个字段**、不签发 `connectionId` / `connectionToken`。版本号规则按 .NET `int.TryParse` 复刻：未携带该参数视为版本 0；解析成功但为负数 → 另一条错误串（回显解析后的整数）；非数字**或超出 Int32** → 同一条错误串（回显原样入参）；`> 1` 的版本**钳制**为 1 而不报错。
- **两种 id 形态**：版本 > 0 的客户端把 `connectionToken` 当 `?id=`，版本 0 的客户端用 `connectionId`（本实现让二者同值，两种形态都能通过 DO 的连接鉴权）。
- **连接鉴权在 DO 内完成**：negotiate 时登记的 token 有 10 分钟 TTL；请求没带可验证 token 时回落到校验其 Basic 凭据，两者皆无 → 401。连接侧的认证失败与 HTTP 面**共用同一套 key 约定与同一个限速状态机**。

### 流程 3：定时清理预算记账管线（Cron Trigger）

```mermaid
flowchart TD
    Start([Cron Trigger 每 20 分钟唤醒]) --> Init[初始化 800 次子请求配额]
    Init --> Phase1[Phase 1: Retention 保留期过期软删除<br/>按 D1 批量查询, 批内一次清扫 R2, 广播通知]
    Phase1 -->|记账扣减 / 留保底配额| Phase2[Phase 2: Trim 条数上限软删除<br/>保留最新的 N 条, 超过部分软删除]
    Phase2 -->|记账扣减 / 留保底配额| Phase3[Phase 3: HardDelete 彻底物理删除<br/>清理 IsDeleted=1 且超 30 天的记录, 不广播]
    Phase3 -->|记账扣减 / 留保底配额| Phase4[Phase 4: Orphans 孤儿目录回收<br/>扫描 R2 无主历史目录并彻底删除]
    Phase4 --> Finish[写入 Meta cleanup:lastRunAt 与游标, 正常退出]

    Phase1 -.配额不足.-> Truncate[截断当前阶段并持久化当前游标]
    Truncate --> Finish
```
*(出处：`src/cleanup.ts:1-200`)*

---

## 8. 配置与状态

### 8.1 双层配置系统
1. **静态/部署环境变量（`wrangler.toml` 与 GitHub Variables）**：
   - `VERSION`：服务版本号，固定对齐上游报 `"3.2.0"`；
   - `MAX_SAVED_HISTORY_COUNT`：历史条数硬上限（默认 1000）；
   - `HISTORY_RETENTION_MINUTES`：保留时长（默认 10080 分钟 = 7 天）；
   - `MAX_REQUEST_BODY_BYTES`：单请求体上限（默认 48 MiB，允许调至 64 MiB）；
   - `UI_ENABLED`：Web 界面总熔断开关（默认 `"true"`）；
   - `ENFORCE_STRONG_CREDENTIALS`：弱口令硬阻断开关（**未设置 = 仅打告警日志**；设 `"true"` 时命中文档化默认口令或长度不足 8 的请求一律 500）；
   - `AUTH_RATE_LIMIT_WINDOW_MS` / `_MAX_FAILURES` / `_BLOCK_MS` / `_BURST_WARN`：认证失败限速四参数（**不建议改**；非法/越界值**逐字段**回落默认并打一次日志，见 `src/rateLimit.ts`）；
   - CI 侧专属（不在 `wrangler.toml`）：`D1_DATABASE_ID`（钉住要绑定的库 id，`Sync fork` 冲不掉）、`D1_BOOTSTRAP`（缺库时是否允许自动创建）。
2. **动态运行时覆盖（D1 `Meta` 表）**：
   - Web 界面维护面板通过 `PUT /ui/api/settings` 在线更新 `settings:retentionMinutes` 与 `settings:maxSavedHistoryCount`；
   - **机制**：读取时优先采用 Meta 覆盖值，键**不存在**才回退部署环境变量（唯一读入口 `readRetentionSettings`，`src/cleanup.ts`），实现**免重新部署在线调优**。
   - ⚠️ **「清除覆盖」= 删除该 Meta 键，不是写空串**：空串经 `Number('')` 会解析成 `0`，而 `0` 的语义是「**关闭该阶段**」，与「回退到 env」恰好相反（`src/db.ts` 的 `deleteMetaValues`、`src/cleanup.ts` 的 `SETTINGS_META_KEYS`）。
- **出处**：`wrangler.toml:30-80`、`src/cleanup.ts:380-420`、`src/ui/maintenance.ts:90-150`。

### 8.2 持久化与状态迁移
- D1 数据库由 `schema.sql` 驱动，建表、索引与去重语句都具备幂等性（`CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` / 去重 `DELETE`）；
- 升级部署时执行 `wrangler d1 execute <库名> --remote --file=./schema.sql`，旧数据与索引自动保留；Web 界面里还有一条 `GET /ui/api/integrity` 可核对「记录声明的数据文件」是否真的都在 R2 里。
- Durable Object 由 `wrangler.toml` 的 `[[migrations]] tag = "v1"`（`new_sqlite_classes = ["SyncClipboardHub"]`）声明；改 DO 的存储形态时**新增** tag，不改旧 tag。
- **`database_id` 在仓库里是全零占位值**：本地 `wrangler dev` 与全部测试都不读它（绑定按 `binding` 名建立），所以 `npm run dev` 不受影响；CI 在部署前按**库名**解析出真实 id，只注入 runner 里的那份配置副本、**不回写仓库** —— 因此 `Sync fork` 之后仍会绑回同一个库。想钉住某个库就设仓库变量 `D1_DATABASE_ID`；禁止 CI 自动建库就设 `D1_BOOTSTRAP=false`。
- 备份：`npx wrangler d1 export syncclipboard --remote --output=./backup.sql`（剪贴板历史的元数据都在 D1 里）。
- **出处**：`schema.sql`、`wrangler.toml`、`.github/workflows/deploy.yml`、`README.md` 的部署章节。

---

## 9. 测试

### 9.1 测试体系与框架
- **测试框架**：Vitest 2.1.0（由于涉及本地 D1 数据改写，全局强制 `--no-file-parallelism` 串行执行）。
- **套件规模**：共 **22 个测试套件**（`npm test` 全绿）。**用例数不写死** —— 每加一条断言就变、且无法从文件系统数出来（见 `AGENTS.md` §2 的「写文档的数字口径」），要引用就写"见 `npm test` 输出"。
- **两半**：纯逻辑套件在进程内跑、不需要服务器；HTTP 黑盒套件要求 dev server 已启动。其中 4 个套件（`fixes`、`dto-validation`、`cleanup-budget`、`ui-activity`）的 D1 由 `test/support/d1-sqlite.ts`（`node:sqlite` 适配器）模拟 —— 它**不是真 D1**，两者引擎口径存在差异，因此**平台口径类断言不放在它上面**。
- **出处**：`package.json` 的 `test` 脚本、`test/support/d1-sqlite.ts`、`test/docs.test.ts`。

### 9.2 套件覆盖清单（全部 22 个套件）

| 类别 | 套件文件 | 覆盖内容与验证点 |
|---|---|---|
| **协议黑盒** | `protocol.test.ts`, `signalr.test.ts`, `transports.test.ts` | 真实模拟客户端 HTTP 与 SignalR 全套交互、长连接升级与降级（WS / SSE / LongPolling） |
| **回归防线** | `fix-regressions.test.ts`, `fixes.test.ts` | 已修复缺陷的回归守卫（孤儿目录误删、原型链查找污染、跨平台用户名等） |
| **数据与算法** | `hash.test.ts`, `dto-validation.test.ts`, `clipboard.test.ts` | 4 类哈希逐字节对齐、C# DTO 边界值、前端剪贴板写入的判别结果（位图扩展名判定、PNG 直写与非 PNG 转码、`unsupported`/`failed(+底层原因)`/`execCommand` 三条分支） |
| **安全与防护** | `rate-limit.test.ts`, `limits.test.ts`, `hardening.test.ts` | 爆破限速与解封、413 内存护栏、防 Zip 炸弹、伪造 Cookie 阻断、XSS 响应头 |
| **后台清理** | `cleanup.test.ts`, `cleanup-budget.test.ts` | 800 次子请求记账模型、保底配额、游标续跑、孤儿目录回收 |
| **查询与目标** | `query-filters.test.ts`, `next-target.test.ts` | 复杂组合 SQL 过滤（类型位掩码、排序方向、时间范围）与焦点切换边界测试 |
| **WebUI 契约** | `ui.test.ts`, `ui-logic.test.ts`, `ui-guard.test.ts`, `ui-input.test.ts`, `ui-contract.test.ts`, `ui-activity.test.ts` | 多列排序、回收站恢复边界、跨版本文案一致性、挂载点动态发现 |
| **防漂移守卫** | `docs.test.ts` | 只校验**能从文件系统数出来**的量：5 份现状文档（`README.md`/`AGENTS.md`/`docs/design.md`/`docs/ui.md`/`.github/workflows/deploy.yml`）声明的**套件数（22）**、`docs/ui.md` 的**资源数（85）**、以及 `docs/design.md` 的套件清单是否逐个覆盖实际套件。⚠️ **端点表、目录树、挂载点、写库套件名单都不在它管辖内** —— 挂载点由 `ui-guard.test.ts` 动态发现守卫，「写库套件」是各套件自己调用 `assertWritableTarget`（见 §9.3） |

### 9.3 安全防护网（`test/support/target-guard.ts`）
7 个写库套件（`protocol`, `fix-regressions`, `transports`, `signalr`, `cleanup`, `query-filters`, `ui`）在文件顶层调用 `assertWritableTarget(BASE)`：目标主机不属于 `127.0.0.1` / `localhost` / `::1` / `[::1]` / `0.0.0.0` **且**未设 `ALLOW_REMOTE_TARGET=1` 时**直接抛错终止**（连 `beforeAll` 都不会执行），杜绝误向线上实例执行测试导致数据损坏。*(出处：`test/support/target-guard.ts`)*

### 9.4 运行前提与 CI
- **dev server**：黑盒套件把地址写死为 `http://127.0.0.1:8787`；`cleanup` 套件经 `GET /__scheduled` 触发**真实的** scheduled handler，因此该服务必须带 `--test-scheduled` 启动（未启用时它**跳过并报告原因**，而不是假装通过）。
- **地址与凭据**：来自 `BASE` / `SYNC_USER` / `SYNC_PASS`（默认 `127.0.0.1:8787` + `admin`/`admin`）。刻意**不读**宿主环境的 `USER` / `USERNAME`（两者在 Windows 与 CI runner 上恒被占用，读它们会静默拿错凭据 → 401 假失败）。
- **CI（`.github/workflows/deploy.yml` 的 `quality` job）**：`typecheck` + `lint` + 全部 22 套件；由 CI 自起 `wrangler dev --local --test-scheduled`、用 `--var` 临时注入凭据、`d1 execute --local` 初始化 schema ⇒ **不需要 Cloudflare 凭据、也不接触线上资源**。`deploy` job 以 `needs: quality` 依赖它，质量门失败即不部署。
- **触发条件**：push 到 `master` 且改动落在白名单路径（`src/**`、`public/**`、`test/**`、`schema.sql`、`wrangler.toml`、`package.json`/`package-lock.json`、`tsconfig.json`、`vitest.config.ts`、`eslint.config.js`、`.github/workflows/**`），或手动 `workflow_dispatch`。
- **出处**：`test/support/target-guard.ts`、`test/cleanup.test.ts`、`.github/workflows/deploy.yml`、`vitest.config.ts`。

---

## 10. 文档与约定

### 10.1 文档体系分工
- `README.md`：面向使用者与运维的白描指南（部署、客户端配置、网络、排障）；
- `docs/design.md`：架构总览、架构决策记录（ADR 表）、资源预算推导与风险登记；
- `docs/protocol.md`：协议唯一权威契约，附带与上游源码行级比对的差异登记表（§10）；
- `docs/ui.md`：Web 界面设计、安全头策略、接口契约与来源融合清单；
- `docs/progress.md`：**按轮次记录的历史台账**（改动过程与当时的数字快照，不作为现状口径）；
- `AGENTS.md`：给 AI Agent 与开发者的行为契约（DoD 完成定义）。

### 10.2 工程红线与规范（`AGENTS.md`）
1. **代码与文档同改**：责任范围是 `AGENTS.md` §1 那张同步表（**端点表、目录树、令牌表、差异登记表都在守卫之外**，靠人逐行过）。门禁只机械盯住其中一部分：
   - `test/docs.test.ts` → 套件数（22）、`public/` 资源数（85）、`docs/design.md` 的套件清单；
   - `test/ui-guard.test.ts` → 四个界面挂载点（`/ui`、`/ui_v1`、`/ui_v2`、`/ui_shared`）在三处副本里的一致性（`wrangler.toml` 的 `run_worker_first`、`src/index.ts` 的 `isUiAsset`、`public/_headers` 的规则；挂载点集合从 `public/` **动态发现**）、`/ui/api/*` 端点清单（`EXPECTED_API_ROUTES`，20 条）、V1 与 V2 的 `messages.js` 正文对等、V1 预载清单 == import 闭包、`/ui/api/*` 的注册顺序（未认证一律 401）。
2. **两套前端定位红线**：`/ui_v1/` 为默认产品面，禁止跨版引用 `/ui_v2/`（V1 自包含）；两版同名的 `messages.js` 正文必须逐字一致（对等守卫断言；文件头**有意不同**）。
3. **完成定义（DoD，`AGENTS.md` §2 共五条）**：① `tsc --noEmit` 0 错；② eslint 0 告警（范围含 `test/manual`）＋ 4 个 `test/manual/*.mjs` 过 `node --check`；③ 在**端口 8787** 的 dev server 上 **22 个套件全过**；④ §1 同步表逐行核对；⑤ **改前端必须用真实浏览器量一次**（`test/manual/probe.mjs` / `probe-ui-v1.mjs`：零 console 错误、零失败请求）。
- **出处**：`AGENTS.md` §1–§2。

---

## 11. 总结

### 11.1 架构风格
SyncClipboard CfServer 是一套**极具工匠精神的高保真 Serverless 移植系统**。它并未因为运行在 FaaS 平台而对协议做妥协或取巧，而是在严格对齐 C# 官方服务端所有二进制哈希、XML 协议、SignalR 帧序列化与错误语义的同时，深度适配了 Cloudflare 的边缘分布式特性。

### 11.2 核心工程难点与攻关解法
1. **内存边界（128 MiB isolate，且被所有并发请求共享）**：R2 无 `move`（改名 = put 新对象 + 删旧对象）；入口按 `content-length` 预检（>48 MiB → 413），落库时再按**暂存对象实际大小**判一次（流式暂存可以绕过预检），Zip 解压预算随请求体收缩，上传路径不做防御性拷贝（`R2Storage` 把 body 直接透传给 R2 `put`）。⚠️ **multipart 表单体不是流式的**：`POST /api/history` 会 `await c.req.arrayBuffer()` 整包读入内存，再由 `src/multipart.ts` 手写字节级扫描（首字节 memchr 优化）；真正流式的只有 `PUT /file/{name}`（body 直接透传 R2 `put`）；
2. **调度配额（1,000 次子请求）**：通过设计「批内目录清扫」，将定时清理任务单条记录消耗由 3 次降为 1 次，并引入分阶段预算记账与游标断点续跑，完美化解了平台硬性调度限制；
3. **状态同步与安全**：利用 Durable Objects 单线程特性，在无分布式锁的前提下实现 WebSocket 实时广播与防爆破权威计数；会话为 HKDF 从 `PASSWORD` 派生密钥签名的无状态 Cookie（零存储、可水平扩展），**改口令即让全部已签发会话失效** —— 登出只清本机 Cookie，不吊销已签发的令牌。

整个系统设计扎实、代码克制、证据链完整，具备工业级的健壮性。

---

### 建议下一步深入方向
- 如需探究 SignalR 帧与 WebSocket 降级实现细节，可精读 `src/durable/SyncClipboardHub.ts` 与 `src/durable/signalr.ts`；
- 如需了解平台配额下的定时任务记账推导，可精读 `src/cleanup.ts` 与 `docs/design.md §7.2`；
- 如需查看完整的协议端点差异与处置依据，可精读 `docs/protocol.md §10`。
