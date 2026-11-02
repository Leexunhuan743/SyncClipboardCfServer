# SyncClipboard CfServer — 总体设计

> 本文只描述**当前架构与仍有约束力的设计决定**。协议细节与有意偏离见 `protocol.md`，
> Web UI 行为见 `ui.md`，部署与使用见 `README.md`。历史推演、被否方案和实验过程只在 Git 历史中保留。

## 1. 定位

这是 SyncClipboard 官方服务端的 Cloudflare Workers 复刻：

- Worker/Hono 承载 HTTP 协议与 UI API；
- D1 保存当前 Profile 元数据、历史记录与少量运行状态；
- R2 保存暂存文件与历史数据文件；
- Durable Object 承载 SignalR 连接、广播与认证失败权威计数；
- `public/` 作为静态 Web UI，由 `UI_ENABLED` 控制是否暴露。

目标是**官方客户端协议兼容 + 单用户自部署 + Cloudflare 原生运行**，不是多租户平台。

## 2. ADR 索引

> `D<n>` 编号保持稳定，供代码与测试引用。这里不记录改动过程，只保留当前结论。

| ID | 当前结论 |
|---|---|
| D1 | TypeScript；Workers 原生运行。 |
| D2 | 独立仓库维护，不与上游源码树耦合。 |
| D3 | HTTP 框架使用 Hono。 |
| D4 | 元数据/历史进 D1，二进制数据进 R2。 |
| D5 | SignalR 连接与广播由 Durable Object 承载。 |
| D6 | negotiate 按上游顺序宣告 WebSockets → SSE → LongPolling。 |
| D7 | `/api/version` 逐字对齐上游版本事实源；与 `package.json` 项目版本无关。 |
| D8 | D1 时间统一存 epoch ms，DTO 边界转 ISO8601。 |
| D9 | 协议默认严格复刻上游；有意偏离必须登记在 `protocol.md`。 |
| D10 | 协议结论优先由真实 HTTP/SignalR 与上游 A/B 验证，不只靠读码。 |
| D11 | 历史 Git 提交策略不再属于架构；当前协作规则以 `AGENTS.md` 的 branch + PR 为准。 |
| D12 | Web UI 使用独立 `/ui/api/*`，不改官方 `/api/*` 协议面。 |
| D13 | UI 会话是无状态 HMAC Cookie；改密码可整体失效，不建服务端会话表。 |
| D14 | 历史设计工具选择已失去运行时约束，不再作为当前规则。 |
| D15 | 不提供 `/dav` 别名；WebDAV 协议路径保持站点根。 |
| D16 | `UI_ENABLED=false` 时全部 UI 静态挂载与 `/ui/api/*` 返回 404，协议面不受影响。 |
| D17a | Web 界面只有一套：`web/` 下的 TypeScript 单页应用，构建到 `public/ui/`，挂在 `/ui/`。 |
| D17b | 请求体默认 48 MiB、上限 64 MiB；Group 解压预算随请求体动态收缩，避免击穿 128 MiB isolate。 |
| D18 | 历史“推送后是否等待 CI”属于工作流偏好，不再是架构决定。 |
| D19 | UI 的“清除筛选”统一回到默认活跃列表。 |
| D20 | 平台相关黑盒测试继续以 `wrangler dev` 为准；进程内 SQLite 只用于纯逻辑/受控测试。 |
| D21 | 文档预览尚未实施，不是当前设计；只在 GitHub Issue #4 跟踪。 |
| D22 | 界面源码在 `web/`，由 `wrangler.toml` 的 `[build]` 钩子（`node web/build.mjs`）在 dev / deploy 前打包；产物带内容哈希，不进仓库。 |
| D23 | UI 统计中的记录/收藏计数跟当前视图走；R2 存储体积按真实对象统计。 |
| D24 | 列表里长文本只显示开头（最多 3 行）；全文始终可在详情面板获取。 |
| D25 | 浮层（菜单、提示条）进入浏览器顶层，不被模态框遮住，也不挡住列表。 |
| D26 | 回收站支持单条/批量彻底删除；硬删后清理对应 R2 数据。 |
| D27 | 批量操作展示进度，部分失败按“已生效/未生效”报告。 |
| D28 | 长批量允许在批次边界中止；已生效结果必须如实保留。 |
| D29 | 软删是真回收站：数据保留至恢复、30 天硬删或显式彻底删除。 |
| D30 | 文本“编辑”保存为一条新记录，不原地改 hash 已确定的旧记录。 |
| D31 | dialog 外壳控制高度，正文是唯一可收缩/滚动区域。 |
| D32 | UI 成功复制/下载会推进 `LastAccessed`，但回显 version/lastModified，不能制造版本冲突。 |
| D33 | 批量写只发一次 DO 子请求，DO 内仍逐条、保序广播。 |
| D34 | 选择条上的长批量动作在执行中可切换为“中止”。 |
| D35 | 记录卡信息层级：正文优先，类型/大小/时间/标记在其下一行；窄屏操作行换到卡片下方。 |
| D36 | 模态框打开时 toast 宿主进入最上层 dialog，关闭后回到 body。 |
| D37 | 键盘操作必须有可见等价入口；输入控件与 IME 优先；彻底删除与清空必须确认，软删用「撤销」提示代替确认。 |
| D38 | 列表结果、URL、筛选/排序/分页与选择集必须属于同一查询状态。 |
| D39 | UI 的“字符数”按用户可见字符口径；大文本可省略昂贵计数。 |
| D40 | Free 计划不额外压低 48 MiB 请求上限；清理通过子请求预算 + 行字节预算慢收敛。 |
| D41 | SignalR 15s heartbeat 保持不动；实测其 Hibernation duration 成本可忽略。 |
| D42 | WebSocket 路径使用 Hibernation API：`state.acceptWebSocket()` + attachments + alarms；SSE/LongPolling 保持原实现。 |
| D43 | 不为假设中的 Free CPU 过度牺牲正确性：同名候选无 32 条硬截断；统计只保留一份实现；清理预算只留真实生效处。 |
| D44 | query 时间解析失败维持上游式“忽略 + warn”，不自行引入 day-first 超集。 |
| D45 | 搜索保留上游 LIKE 通配语义与 48 字节模式上限，不改成 `instr` 子串语义。 |
| D46 | 界面可以上传文件/图片：`POST /ui/api/upload` 直接收原始字节并走协议 `addRecordDto` 的同一条写路径；`octet-stream` 是 CSRF 纵深（跨站表单发不出）。 |
| D47 | 窄屏详情占一格浏览历史，系统返回键 = 关闭详情；手机用底部标签栏做主导航。 |
| D48 | 界面日常刷新用轻量概览（`/ui/api/overview?storage=0`）：不列举 R2 桶（Class A 操作），存储体积由前端沿用上一次的值，只在首次 / 超过 10 分钟 / 上传与删除之后 / 手动刷新时取完整值。不在服务端加体积缓存：轻量模式之后收益很小，且会让「存储体积按真实对象统计」的断言失去意义。 |
| D49 | `readBodyCapped` 在请求声明了 `content-length` 时按它一次性分配并边读边写，不再「收集分块 + 拼接」：后者让 48 MiB 的体峰值接近 96 MiB，贴着 isolate 的 128 MiB。声明值只是提示，读多了退回收集分块，读少了截出实际长度；上限判定不变。 |
| D50 | 收藏夹（界面独有）：`Folders` 表 + `HistoryRecords.FolderId`；一条记录至多一个收藏夹，独立于星标；`FolderId != 0` 不参与自动清理；删除收藏夹只把成员移出、不删记录。`FolderId` 不进协议 DTO 与整行覆盖写，客户端改不掉它，也不改 `Version` / `LastModified`。不复用上游保留列 `Tags`（语义归上游）；`HistoryRecords.FolderId` 不建索引（部署先跑 `schema.sql` 再跑迁移，老库此时还没有这一列）。 |
| D51 | 控制 D1 读行数（免费额度 500 万/天，按扫描行数计）：线上实测某天用到 83%、99% 来自网页界面，根因是列表 / 计数 / 总览 / 轮询几乎每条都全表扫描，而回收站（软删保留 30 天）也一并被扫（占 70% 行数时成本 ×3.4）。对策：① `idx_h_user_list (UserId, IsDeleted, Pinned, CreateTime)`，列表一页与总数只读需要的行；② 变更信号只用 `MAX(LastModified)`（读 1 行），代价是别的标签页发现不了「只减少行数」的硬删，只影响回收站数字；③ 总览的四个计数与收藏夹条数从 `countByTypeViews` 同一次分组算出（与协议 `db.statistics()` 同口径，测试钉成同值），不再多扫两遍；④ 隐藏页不轮询、推送在线时看门狗放宽到 2 分钟、趋势图只在可见时查。索引只引用老列：部署先跑 `schema.sql` 再跑迁移，索引里出现新列会让老库的 schema 步骤失败。 |

## 3. 架构

```text
官方客户端 / WebDAV / 浏览器
          │
          ▼
  Cloudflare Worker (Hono)
    ├─ Basic Auth / UI session
    ├─ WebDAV + 官方 API
    ├─ /ui/api/*
    ├─ D1  <── HistoryRecords / Meta
    ├─ R2  <── file/* / history/*
    └─ Durable Object <── SignalR / auth rate-limit state

web/ ──(esbuild)──> public/ui/** ── ASSETS binding ──> /ui
```

`/ui*` 请求先进入 Worker，由 `UI_ENABLED` 决定转发静态资源还是 404；协议路径始终由 Worker 处理。

### 模块边界

| 区域 | 职责 |
|---|---|
| `src/routes/` | 官方 API 与 WebDAV 路由 |
| `src/durable/` | SignalR/DO 连接状态 |
| `src/ui/` | UI API、会话、维护端点（HTTP 面拆在 `src/ui/routes/`） |
| `src/db.ts` | D1 数据访问与并发判定 |
| `src/storage.ts` / `src/profile*.ts` / `src/historyOps.ts` | R2、Profile 写路径与历史写路径 |
| `src/cleanup.ts` | 定时清理与预算收敛 |
| `web/` | Web 界面源码（TypeScript）与构建脚本 |
| `public/ui/` | 界面构建产物（不进仓库） |
| `test/` | 协议、UI、清理与部署回归 |

完整目录树不写进文档；文件系统本身就是唯一事实源。

## 4. 存储与数据模型

### D1

`schema.sql` 是新库建表事实源，`tools/migrate-d1.mjs` 负责老库加列；二者由测试保持一致。

关键约束：

- `HistoryRecords.ID` 为主键；
- `(UserId, Type, Hash)` 唯一，防并发重复记录；
- 时间字段统一 epoch ms；
- `Meta` 保存当前 Profile、清理状态与少量设置覆盖。

### R2

| Key | 用途 |
|---|---|
| `file/{dataName}` | WebDAV 暂存区 |
| `history/{Type}_{Hash}/{transferDataName}` | 历史持久数据 |

`GET /file/{name}` 不直接读暂存区，而是按历史记录中的同名 `TransferDataFile` + `LastAccessed` 倒序寻找首个真实存在对象；这是协议兼容行为。

## 5. 核心数据流

### 当前剪贴板上传

`PUT /SyncClipboard.json`：解析 Profile → 校验/读取暂存数据 → 计算/核对 hash → 插入或合并历史 → 持久化 R2 → 更新 `Meta.current_profile` → 广播。

当前 Profile 与历史行独立：删除历史记录不会自动清空当前 Profile。

### 历史 API

- `POST /api/history`：新增/合并历史记录；有 data 时验证真实内容；
- `POST /api/history/query`：固定协议分页与过滤；
- `PATCH /api/history/:id`：SQL 乐观并发，冲突返回 409 + 当前服务器值；
- 数据下载与 wire 细节以 `protocol.md` 为准。

### SignalR

negotiate 返回三种传输；连接最终落到单个 `SyncClipboardHub` DO。WebSocket 使用 Hibernation API；SSE 与 LongPolling 仍持有活请求，不能获得同样的休眠收益。

## 6. 一致性与并发

- `ShouldUpdate` 复刻上游：5 分钟窗口内比 version，窗口外比时间；
- 唯一索引解决并发插入；
- `UPDATE ... WHERE ID=? AND Version=?` 把乐观并发下推到 D1；
- 批量写可合并 DO 子请求，但客户端仍收到逐条、保序的广播；
- 软删保留数据，硬删才清 R2；孤儿扫描必须把仍可恢复的回收站数据视为“有引用”；
- 删除的**成功语义**：D1 完成永久删除 = 业务删除成功；随后 R2 清理失败只留下孤儿对象
  （由清理任务的孤儿阶段回收）并打日志，不把已生效的删除改判成 500。顺序恒为“先 D1、后 R2”，
  绝不反过来（反转一旦失败就是整库悬空）。

## 7. 资源边界

- Workers isolate 内存：128 MiB，且同一 isolate 的并发请求共享；
- 应用请求体：默认 48 MiB，可调至 64 MiB；
- Group zip：请求体与解压工作集共享预算，不能把两个上限独立贴满；
- 内部 Cloudflare 服务子请求：清理按预算截断并用游标续跑；
- Free CPU 是平均预算，不据此把正常上传上限粗暴降到几 MiB。

账户实测事实集中在 `free-plan-account-facts.md`，不要把实验过程复制回总体设计。

## 8. 清理与保留

Cron 每 20 分钟执行：

1. 保留期软删；
2. 条数上限裁剪（收藏/置顶/收藏夹里的记录豁免）；
3. 已删除超过 30 天硬删；
4. R2 孤儿目录回收。

默认 `HISTORY_RETENTION_MINUTES=0` 表示不按时间软删，只受条数上限约束。

清理同时受子请求预算和行字节预算限制；`cleanup:lastRunAt` 在轮首写入，完成状态只在轮尾写入，因此中途被平台终止时可被诊断。

## 9. 错误与安全边界

| 状态 | 含义 |
|---|---|
| 400 | 请求/DTO/hash 不合法 |
| 401 | 鉴权失败 |
| 404 | 记录或数据不存在 |
| 409 | 乐观并发冲突 |
| 413 | 请求体超限 |
| 415 | 媒体类型不符 |
| 422 | 声称有数据但服务器无法取得有效数据 |
| 500 | 未预期内部故障 |

安全模型是**单用户、服务端可信**：Basic Auth/签名 Cookie 控制访问，数据服务端可见；本项目不是端到端加密剪贴板。

## 10. 测试策略

- 纯函数：Vitest；
- 协议/UI 黑盒：本地 `wrangler dev --test-scheduled` + 真实 HTTP；
- SignalR：`@microsoft/signalr`；
- 上游疑难行为：`tools/ab-upstream-probe.ps1` 做真上游 A/B；
- 写库测试默认只允许 localhost，远端必须显式 `ALLOW_REMOTE_TARGET=1`。

测试数量、文件数量与目录树不写进文档，以仓库和 `npm test` 输出为准。

## 11. 部署与运维

部署步骤、GitHub Actions、secrets、开关和备份见 `README.md`。总体设计只保留两个硬约束：

- D1 schema 变更必须同时更新 `schema.sql` 与 `tools/migrate-d1.mjs`；
- `public/` 是部署产物的一部分，缺失会导致静态 UI 无法发布。

## 12. 当前主要风险

| 风险 | 现有缓解 |
|---|---|
| 并发大上传共享 128 MiB isolate | 48 MiB 默认上限 + Group 动态解压预算 |
| SignalR 多传输的边缘语义复杂 | 真客户端/SignalR 测试；WS Hibernation，SSE/LP 明确边界 |
| 清理在 Free 额度下慢收敛 | 子请求预算 + 行字节预算 + 游标 + 未完成状态可见 |
| 收藏/置顶/收藏夹长期豁免清理 | 文档明确；个人场景接受，必要时人工清理（收藏夹里的记录占用的 R2 空间也不会自动释放） |
| R2 统计需要列举对象 | 界面日常刷新走轻量概览不列举（D48）；完整统计只在首次 / 每 10 分钟 / 写入体积的操作后 / 手动刷新时取；规模化后再引入缓存/汇总 |

未实施的产品想法不要追加到本文：统一放 GitHub Issues（当前 roadmap 见 #3，文档预览见 #4，图片缩略图见 #5）。
