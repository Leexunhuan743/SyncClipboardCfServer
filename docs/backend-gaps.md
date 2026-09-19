# SyncClipboard CfServer — 后端能力缺口与可完善项评估

> **状态：§1 / §3 与 §2.1、§2.3、§2.4、§2.5、§2.9 已实施**（2026-09-14，逐条状态见 §8）。
> 其余条目仍属「可做但未做」，理由记在 §8 与 `docs/progress.md` §36.6。本文件不改变任何既有契约；
> 实施结果一律记在 `docs/progress.md`（本文件只描述「有什么可做」与「做到哪一步」）。
>
> **本清单已经过三名子代理独立复核**（一版之后才定稿）：事实核对 13 条、可行性攻击 11 条、
> 文档一致性 1 轮。**订正与被驳回的意见全部记在 §7**——读 §1–§3 时若觉得某条「怎么这么写」，
> 先看 §7.2 是否为复核后的措辞。
>
> **证据口径**：`文件:行` 取自 `master`（`509bdef`）；标「实测」的行是在本机实例
> （`wrangler dev`，1009 活跃 / 938 在回收站）上真正跑过的观察，其余为直读代码的结论。
> 平台事实（免费档额度等）单独标注外链来源，不与仓库内证据混同。
>
> ⚠️ **那些路径今天可能指不到文件**：本文件是 `509bdef` 那一刻的快照，而 V2 在 2026-09-16
> 重构过目录（`public/ui_v2/js/components/*` → `public/ui_v2/js/ui/*`，`signalr.js` → `push.js`）。
> §1–§3 里引用的 V2 路径**按快照保留原样**（改了就篡改历史），要看现状请用 §8 的落地位置表
> 或 `docs/ui-v2-design.md` 的文件树。
>
> **结论先说**：**协议层没有缺口**（上游 17 条路由已 100 % 覆盖，见 `docs/progress.md` §11）；
> 缺口分三类——① 已建好的后端能力界面没用上（§1）；② 该有却没有的端点（§2）；
> ③ 后端自身的效率与规范欠账（§3）。§4 是明确不做的，§5 是建议顺序，§6 是验证边界，§7 是复核记录。
>
> 编号（`§1.N` / `§2.N` / `§3.N`，格式 `<小节>.<序号>`）是**稳定标识**，供提交信息与后续轮次引用；不要重排。
> **刻意不用 `A1/B1/C1` 这类字母标号**：本仓库 §32/§33 已用「A 批 / B 批 / C 批 / D 批」指代界面评审的批次，
> 两套并存时「见 §33.5 的 B 批」与「B1」会互相污染。
>
> **与既有记录的关系（避免重复立项）**：清单里约半数条目**此前已被记过**，这里写的是「现状 + 指回原文」，
> 不是新发现——
>
> - `docs/progress.md` §34.7 已记「未做批量恢复」→ §1.3；
> - `docs/progress.md` §24 已把三条限制列为已知问题：其中「不走 SignalR 实时推送」在 `docs/ui.md` §6 表格
>   （`:211`）有对应行；「缩略图依赖数据文件存在」在 `README.md:304`；「界面标签轮询计入请求额度」只记在
>   §24 与 README 的容量提示里（**`ui.md` 并无这三条的汇总行**，§24 那句「见 `docs/ui.md` §9/§10」本身已过期，
>   属范围外，按规矩只上报不顺手改）→ §2.1、§2.10；
> - `docs/progress.md` §26 已记「12 条 `hasData` 为真而取不到数据」→ §2.4（那里的 12 条是唯一实数）；
> - 协议侧**故意**忽略 `Range` 是既有决定（F29b + `test/fix-regressions.test.ts`）→ §2.3 的边界；
> - `docs/ui.md` §1 融合清单 5d 把「置顶」写成了已实现的界面能力（「收藏切换｜复用 `PATCH`（**星标/置顶**）」），
>   但实现只落了星标 → 这属于**文档与实现的偏差**，不是新缺口 → §1.2（复核记录见 §7.4 第 8 条）。
>
> 真正**此前未记过**的是：§1.1（清理状态没展示）、§1.4–§1.8，§2.2、§2.5–§2.9、§2.11，
> 以及 §3 全部（`statistics` 全表拉取、缺 `no-store`、变更信号粒度、`clear` 不广播）。
>
> ⚠️ **不要**把 `docs/progress.md` §33.5 的「未做」清单当现状引用：那份清单已被 §34 消耗掉大半
> （`_headers`/CSP、缩略图阈值、令牌补齐、时间范围、回收站、前端逻辑套件均已实施），按 §32 的批次口径
> 当前真正未实施的只剩 A3 离线状态与 L2 浏览器回归套件等少数项。

## 1. 已建未接（能力已在、界面或接口没接；成本最低，先做这批）

| # | 能力 | 证据 | 影响 / 备注 |
|---|---|---|---|
| 1.1 | **清理状态没有界面** | 服务端 `/ui/api/info` 已返回 `cleanup:{lastRunAt,lastError,cursors}`（`src/ui/routes.ts:309`、`:340`；键契约在 `src/cleanup.ts` 的 Meta 键清单） | 「清理在跑吗 / 上轮失败了吗 / 有没有积压」这个为 F11 专门建的可观测面**当前无人消费**（`components/info.js` 只渲染地址、版本、传输、保留、体积、类型计数）。**建议第一个做** |
| 1.2 | **`pinned`（置顶）无写入入口** | 协议 `PATCH` 支持 `pinned`；列表已渲染「置顶」徽标（`public/ui_v2/js/components/list.js:86`），但界面无任何地方能设置 | 服务端语义上 `stared` 与 `pinned` **同样豁免保留期与条数裁剪**（`src/db.ts` 的 `softDeleteExpiredRecords` / `trimToMaxCount` 两条 SQL 都带 `Stared = 0 AND Pinned = 0`）。用户在客户端置顶的记录，界面看得到、改不了 |
| 1.3 | **批量操作只有删除** | 仅 `POST /ui/api/history/batch-delete`（`src/ui/routes.ts:230`） | 回收站里逐条点「恢复」、收藏逐条点。批量写端点的形状已有，可照抄；「批量恢复」在 `docs/progress.md` §34.7 已记为未做 |
| 1.4 | **排序 6 字段只有 3 个可点** | 白名单 `SORT_COLUMNS` 有 `id/type/size/createTime/lastModified/lastAccessed`（`src/ui/query.ts:62`），表头只给 类型 / 大小 / 时间（`list.js:254-257`） | `lastModified` / `lastAccessed` / `id` 只能手改 URL 才用得上 |
| 1.5 | **`pageSize` 两套上限** | 服务端 ≤ 500（`src/ui/query.ts:59`），下拉只有 20/50/100/200（`filters.js:25`） | URL 写 `pageSize=500` 能工作，但 `<select>` 会落到空选，读起来像缺陷 |
| 1.6 | **`PATCH` 响应体被丢弃** | `api.patch` 返回归一化后的条目（`public/ui_v2/js/api.js:92`），调用点只当作成功信号（`main.js:292/322/342`） | 服务端算出的 `version` / `lastModified` 未被采纳。当前无害；将来做并发冲突提示时需要 |
| 1.7 | **「清空全部」协议有、界面无** | `DELETE /api/history/clear`（`src/routes/history.ts:331-336`） | 且它**不广播**（只有删行 + 删目录 + 返回计数）。界面要接此功能须先补广播——**该判断已被 §7.5 订正**：不补广播，界面靠 `/ui/api/poll` 的变更标记收敛；本轮已接界面（见 §8） |
| 1.8 | **`/api/time` 本站界面未使用** | 协议端点存在（`src/index.ts:185`；覆盖率见 `docs/progress.md` §11）；**官方客户端会调用它**做时钟差检查（`docs/protocol.md:430`），本仓库前端零命中 | 客户端会因服务端与本机**时钟差 > 5 分钟而中止历史同步**。端点本身有真实消费者，缺的只是**界面展示**：显示服务端时间/偏移能把这类「同步不动」的根因提前暴露（一次 fetch + 一行文案） |

## 2. 可新增（按性价比排序）

| # | 能力 | 设计要点 | 成本 / 风险 |
|---|---|---|---|
| 2.1 | **真推送替代 10 s 轮询** | 每开一个界面标签 ≈ **8.6 k 请求/天**（`README.md` 容量提示已记）。做法：Worker 侧新增 `/ui/api/hub-ticket`（会话 Cookie 鉴权）→ 调 DO 的 `/register-token`（该分支在鉴权**之前**、外部不可达：`src/durable/SyncClipboardHub.ts:144-152`；Worker 只转发 negotiate 与 Hub 路径，`src/index.ts:192/209-210`）→ 浏览器 `new WebSocket('/SyncClipboardHub?id=<ticket>')`（DO 从 query `id` 读票据，`:596-600`） | 中。**「DO 类不用改」成立**：`hubStub`（`src/hub.ts:32`）与 `REGISTER_TOKEN_PATH`（`:7`）**都已导出**，Worker 侧只需新增一个端点：生成随机串 → `hubStub(env).fetch('https://hub' + REGISTER_TOKEN_PATH, {method:'POST', body: JSON.stringify({token})})`（DO 侧该分支只校验 `token` 非空字符串，见 `SyncClipboardHub.ts:144-152`）。但仍有三条真前置：① 浏览器侧要**自己实现 SignalR 分帧**（`\x1e` 分隔、握手、类型 6 心跳，见 `src/durable/signalr.ts`），且**必须 < 60 s 主动发一次消息**，否则被 DO 的静默清理关掉（`IDLE_TIMEOUT_MS = 60_000`，`:43` / `:204-205` / `:547-557`）——`public/ui_v2/js` 目前零 SignalR 代码；② 票据是 **10 分钟有效的可复用 bearer**（`TOKEN_TTL_MS`，`:40`；鉴权成功路径只读不删），**不是一次性**，且连接建立后不再复检；③ 想要「一次性票据」或「用 WS Hibernation 避免 DO 常驻计费」都属 **DO 侧改动**（前者要在鉴权成功时删 `tok:` 键，后者要改用 `state.acceptWebSocket`），那时本结论不成立。另：现状连接存在内存 Map、无 `acceptWebSocket`，**一个开着的标签会让 DO 常驻并计入 duration 计费**。`docs/ui.md` §6 那一行给出的理由是「需要给 DO 的鉴权加一条 Cookie 通道，即改动协议侧代码」——**这条理由已过时**（票据走 DO 内路径、`hubStub` 已导出），剩下的是纯计费/收益权衡，立项时应连同该行一起更新 |
| 2.2 | **会话可撤销（登出所有设备）** | 现状：登出只清本机 Cookie，已签发的令牌在 24 h 内仍然有效（载荷只有 `{u,exp}`，`src/ui/session.ts:20-23`）；既有兜底通道是**改口令即让全部会话失效**（ADR D13，`docs/design.md:52`）。补法：Meta 存全局单调 `sessionEpoch`，Cookie 带 epoch，读取时比对 | 低-中。**代价要如实写**：验签现在是**零 I/O**（`session.ts:125-158` 只做 HMAC 校验），加 epoch 后**每个受守卫请求多一次 D1 读**（`src/ui/guard.ts:36-49`）；用 isolate 内存缓存只能**摊薄**（每 isolate 每 TTL 一次），低流量下可能退化为每请求一次，且撤销是**跨 isolate 的最终一致**——无法主动失效其它 isolate 的缓存，最坏滞后 = TTL。**这不属于 D13 的既有边界**（D13 的论据正是「零存储、不必每次请求读库」），应**新增一条 ADR**（如 D16）记录该取舍，而不是宣称「不违反 D13」。反向教训值得一并读：session 密钥曾按 isolate 缓存，导致改口令后旧会话在缓存存活期内仍被接受（G1，`session.ts:25-33`），该窗口被刻意消除——epoch 的陈旧窗口是功能本身，只能收敛不能消除 |
| 2.3 | **Range / 206（只给 UI 数据端点）** | 三个路由都不处理 `Range`（实测：仅命中 `src/routes/history.ts:89` 的一句文案）；数据端点在 `src/ui/routes.ts:158-187`，`src/contentTypes.ts:84-98` 只设 content-type / nosniff / content-length。R2 `get(key,{range})` 支持（`src/storage.ts:85` 直接透传） | 低。**范围必须收窄到 `/ui/api/history/:type/:hash/data`**：`/file/{name}`（`src/routes/webdav.ts`）与 `/api/history/{id}/data`（`src/routes/history.ts:203`）忽略 Range 是**对齐上游的有意行为**（上游 `File(bytes,…)` 的 `EnableRangeProcessing` 默认 false，F29b 已记录在案），`test/fix-regressions.test.ts:674-675` 正是断言「Range 被忽略」——给协议侧加 206 会变成新的有意偏离，必须同时改该测试与 `docs/protocol.md` 的差异表。实现含 `accept-ranges`、`content-range`、多段/非法 Range 回退 200 |
| 2.4 | **数据完整性自检** | 「`hasData = true` 但 R2 对象不存在」的记录清单——线上真发生过（`docs/progress.md` §26 记 **12 条**；§22 记的是 27 条「数据被误删」记录的**恢复路径**，不是缺数据条数） | 中。**不要按「逐条 HEAD」实现**：免费档的**内部服务**子请求上限是 **1 000/次调用**（Cloudflare limits：`Subrequests per invocation` 为 50，`Subrequests to internal services` 为 1 000，D1/R2/DO binding 都算后者；仓库正是按这条设预算，见 `src/cleanup.ts:26-31`「Free 计划上限 1,000/Cron，取 800 留 20% 余量」）——逐条 HEAD 1009 条 ≈ 1009 次内部子请求，**一次调用就触顶**。仓库已有更便宜的两半：R2 列举（`src/storage.ts:100-113`，1000 键/页）与 DB 侧期望目录集合（`src/db.ts:427-433`）——**求差即得清单**，只对差集里的嫌疑对象逐条 HEAD。若折进 cleanup，必须走既有预算纪律：`SUBREQUEST_BUDGET = 800`（`src/cleanup.ts:28`）+ 阶段保底 `PHASE_RESERVE`（`:65-72`，F11 教训） |
| 2.5 | **保留策略在线可调** | 今日只能改 `wrangler.toml` 重部署。读序改动点在 `src/cleanup.ts:382-383`（`parseNonNegativeInt(env.HISTORY_RETENTION_MINUTES, 10080)` / `env.MAX_SAVED_HISTORY_COUNT`；该函数原名 `parsePositiveInt`，2026-09-19 因「0 合法」改名）；Meta 读写辅助齐备（`src/db.ts:456` / `:469`），cleanup 每轮已在读那张表（`:389`） | 低-中。**成立**，但实施必须带上两点：① 第二个消费者是 `/ui/api/info` 的 retention 展示（`src/ui/routes.ts:327-328` 直接读 env）——不同步改就会出现「清理按 Meta、界面显示按 env」；② `0 = 关闭该阶段` 的语义（`src/cleanup.ts:355-356`）必须在 Meta 解析路径上原样保留，否则 `0` 会被当成非法值回落默认、**意外开启清理** |
| 2.6 | **存储/条数趋势** | 复用现有 Cron（`wrangler.toml:40`，**每小时**一次） | 低→中。三个隐含成本：① 每小时触发 ⇒ 写「每天一行」要按日期键**幂等**（多 1 次 Meta 读）；② Meta **没有任何裁剪机制**（`schema.sql:42-45` 只有 Key/Value 主键）⇒ 趋势行要自带 30 天过期，否则键无限增长；③ 计数来源**不要**直接调现状 `db.statistics()`（`src/db.ts:280-296` 正是 §3.1 的全表拉取），应写一条 `GROUP BY` / `SUM(CASE…)` 聚合（顺带偿还 §3.1） |
| 2.7 | **在线客户端数 / 最近同步时间** | 「最近同步」用 `poll` 的 `lastModified` 即可（`src/ui/query.ts:281-291`）。但 DO **没有可读状态端点**：`fetch` 只认 `AUTH_RATE_LIMIT_PATH` / `BROADCAST_PATH` / `REGISTER_TOKEN_PATH` 三条内部路径（`SyncClipboardHub.ts:132-152`），其余鉴权后按方法分派（`:178-190`）；要读的 `clientCount()` 是 `private`（`:514-516`，除广播日志 `:139` 外还供 `scheduleHeartbeat()` `:519` 使用） | 低，但**不是「加一个键即可」**：要么新增一个 DO 只读分支（注意别落到 `:183` 的 `handleLongPoll`——空 `id` 会被当成新连接登记并挂起 25 s），要么放弃该字段。若加：`/ui/api/info` 会从**纯 D1/R2 端**（现状 `src/ui/routes.ts:311-316`）变成带 DO 依赖的端——失败语义应为「DO 超时 → 该字段 null，其余照常」，不要整体 5xx，否则诊断面会被它要诊断的对象拖垮 |
| 2.8 | **导出历史** | 今天没有导出。全文**不能复用列表端点**：列表把 text 截到 500 字符并置 `textTruncated`（`src/ui/query.ts:194` / `:216-222`）；逐条走单条端点（`src/ui/routes.ts:146-154`）是 O(N) 请求 | 中。成本口径：① 逐条路径 1000 条 ≈ 1000 次请求 + 1000+ 行 D1 读；② 服务端 zip 可复用既有 `fflate`（`src/hash.ts:2` 已在用），但免费档 **10 ms CPU / 50 子请求**约束下必须**全程流式**（不得先聚合再压缩）；③ 128 MB 内存上限（`README.md:267`）只在「聚合」路线下才是瓶颈 |
| 2.9 | **记录级深链接** | `/ui_v2/#Text-<hash>` 打开即预览（实测：`public/ui_v2/js/` 无 `hashchange` / `location.hash` 读取；单条端点 `src/ui/routes.ts:146-154` 与数据端点 `:158` 已具备；筛选状态走 query string，`filters.js:159-160`，hash 空闲） | 低，私有实例内跨设备引用方便 |
| 2.10 | **服务端缩略图** | 仓库无任何图片处理依赖；当前 `size > 512 KiB` 不拉原图（`list.js:24` 的 `THUMB_MAX_BYTES`，`docs/progress.md` §34.4 记理由）。既有记录只到「**缩略图依赖数据文件存在**」（`docs/progress.md` §24、`README.md:304`）与 512 KiB 折中为止，没有记过「服务端产出缩略图」这条路。**「免费档没有 Image Resizing」是错的**：Cloudflare 现行定价页写明默认即 Images Free 档、**含 transformations**（可优化存放在 R2 的图），额度 **每自然月 5 000 次唯一变换**，超出后新变换返回 9422、已缓存的不受影响（[pricing](https://developers.cloudflare.com/images/pricing/)） | 由此从「受计划限制」变成**可做**：数据端点（`src/ui/routes.ts:158-187`）用 `cf.image` 子请求或 Images binding（binding 可直接吃 R2 字节，≤20 MB）产出缩略图。三点注意：① binding 的响应**不会自动缓存**，要自己设缓存头（该端点现为 `cache-control: private, max-age=60`，`routes.ts:186`）；② 用 `cf.image` + 自指 URL 时要按 `Via: image-resizing` 放行原图，否则回环；③ 额度按**唯一变换**计（同源图 + 同参数每月只算一次），列表缩略图会随图片数消耗额度，实施时按「每图每月至多 1 次」核算 |
| 2.11 | **FTS5 全文检索** | D1 支持 FTS5 模块（含 `fts5vocab`）——平台文档 <https://developers.cloudflare.com/d1/sql-api/sql-statements/>；仓库内无证据（`schema.sql` 是唯一 SQL 文件，无迁移目录）。当前是 `Text LIKE ?N ESCAPE '\'` 包 `%…%`（`src/ui/query.ts:173-177`） | 低优先。**匹配语义会变**：FTS5 是分词匹配，现在这版「子串 + LIKE 元字符转义」的语义（注释里还记着与官方 API 的有意差异）会作废。超长搜索串的**正确性不在本项**——已在 G6 处理（`MAX_SEARCH_BYTES = 48`，`src/serialization.ts:414-427`，协议与 UI 共用同一判定）。存量库加虚拟表需手工 `wrangler d1 execute` 迁移（仓库目前没有 migrations 目录） |

## 3. 效率与规范欠账

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 3.1 | **`statistics` 全表拉取，且一次调用打三条查询** | `db.statistics()` 先 `COUNT(*)`，再把**全部行**的 `Stared/IsDeleted` 拉到 JS 里循环（`src/db.ts:280-296`）；`docs/progress.md` §34 又加了 `byTypeActive` → 一次 `statistics` = `statistics` + 2×`countByType` | 合并为一条 `SELECT Type, IsDeleted, COUNT(*) … GROUP BY Type, IsDeleted` + `SUM(CASE…)`。统计在**每次页面加载、星标、删除、切视图**都会跑 |
| 3.2 | **列表 / 统计 / info / poll 这些 JSON 响应没有 `Cache-Control`** | 实测：`GET /ui/api/history?pageSize=1` 的响应头只有 `HTTP/1.1 200 OK`，无 `cache-control` / `vary`；`src/index.ts` 的中间件也没有统一设置（只设 HSTS）。**数据端点不在此列**：`GET /ui/api/history/:type/:hash/data` 自己设了 `cache-control: private, max-age=60`（`src/ui/routes.ts:186`，给缩略图/预览用） | 只给**缺省的那些 JSON 响应**补 `Cache-Control: no-store`（一条中间件，但**必须跳过数据端点**——按字面「一律 no-store」会把那 60 s 私有缓存打掉，预览/缩略图退化成每次回源） |
| 3.3 | ~~**响应压缩未确认**~~ → **复核后撤销（不是欠账）** | **复测（本机实例，带 `Accept-Encoding: gzip, br`）**：响应为 `content-encoding: gzip`、`transfer-encoding: chunked`，200 条列表 **76 595 B → 13 733 B**（−82 %）。上一版写的「本地 dev 无 `content-encoding`」是探测失误：那次请求没带 `Accept-Encoding`，且打印的 `enc=` 实为 content-type | 结论：**压缩已生效，无需处理**。生产边缘未单独复测（免凭据的 401 响应体太小，看不出压缩），但同一运行时行为一致的可能性高；仓库内确实没有出站压缩代码（`CompressionStream` 零命中），说明压缩由运行时/边缘承担 |
| 3.4 | **变更信号是全局二元组** | `readChangeMarker` 返回 `{count, lastModified}`（`src/ui/query.ts:281-291`；前端 `main.js:540` 按 `lastModified` 拼 signature） | 任何写入都让所有标签整页重拉。当前规模无感；要精细化可带 `type` 或版本号 |
| 3.5 | **`DELETE /api/history/clear` 不广播** | `src/routes/history.ts:331-336` | 初判「与 PATCH / 软删语义不一致，应先补」——**该判断已被 §7.5 订正**（上游触发点清单不含 clear，「不广播」是对齐上游；补广播反而是新的有意偏离） |

## 4. 不做的（与 `docs/ui.md` §6 一致，本评估不新增）

多租户 / 多用户、服务端会话表或内存会话（ADR D13）、界面直连 SignalR **而不经票据签发**（§2.1 的完整形态之前）、
Web 字体、`/dav` 前缀别名（ADR D15）、JSON-LD（无现实实体）、`og:image`（域名构建时未知）。

## 5. 建议实施顺序

1. **§3.2 + §3.1**——规范与效率欠账，无行为变化，半小时级；
2. **§1.1 + §1.3**——把已建的清理可观测面接上；批量收藏/置顶/恢复（端点形状照抄 `batch-delete`）；
3. **§2.1**——收益最大，前置是**前端要手写 SignalR 分帧与 <60 s 心跳**（Worker 侧只需新增一个端点，
   `hubStub` 已导出），且**必须保留轮询作为降级路径**（详见 §2.1 行）；
4. **§1.7 + §3.5**——「清空全部」须两处一起改（先补广播再接界面）；**已按 §7.5 改为只做界面侧清空端点、不补广播**；
5. **§2.3 + §2.4**——Range 只动 UI 数据端点；完整性自检按「目录差集 + 差集逐条 HEAD」实现。

§1.2 / §1.4 / §1.5 / §1.6 / §1.8 属「顺手一起修」的量级。

## 6. 验证方式与边界

- **代码证据**：上文 `文件:行` 均逐个打开核对（不是凭印象）；`SORT_COLUMNS` 六字段、`SessionPayload` 两字段、
  `clientCount()` 的调用点、`clear` 端点体内无广播，均为直读结论。**复核后新增的行号**（§2.1–§2.11 的绝大部分）
  由三名子代理独立复读并给出反证——见 §7。
- **实测（本机实例）**：列表响应体量与时长（未压缩 76 595 B / 17 ms）、`/ui/api/history` 响应头无 `cache-control`、
  三个路由无 `Range` 处理、`public/ui_v2/js/` 无 fragment 处理、`info` 端点的 `cleanup` 无人渲染；
  **压缩复测**（带 `Accept-Encoding: gzip, br`）：`content-encoding: gzip`，同一响应 76 595 B → 13 733 B。
- **平台事实（外链，非仓库证据）**：Cloudflare Images 免费档含 transformations、每自然月 5 000 次唯一变换
  （§2.10）；Workers 免费档内部服务子请求上限 1 000/次调用（§2.4）；D1 支持 FTS5 模块（§2.11）。
  三者均由主代理打开官方文档页核对后写入，链接在对应行内。
- **边界（未验证）**：① 生产边缘的响应压缩未单独复测（本机已实测生效，见上；免凭据的 401 响应体太小看不出），
  带凭据的 `/ui/api/*` 行为同样未跑；② DO 实时推送的**计费量级与连接上限**未核算——可确认的是现状
  「一个开着的标签会让 DO 常驻」（§2.1 行），具体账单影响取决于实施形态；③ §2.10 的额度够用与否取决于图片数量，
  且「本账号是否已启用 Images」属部署事实，仓库内无证据。
- 结论只针对**当前代码**；`docs/ui.md` §6「界面走 SignalR Hub 实时推送」那一行给出的**理由已过时**
  （它写「需要给 DO 的连接鉴权加一条 Cookie 通道，即改动协议侧代码」——票据走 DO 内路径、`hubStub` 已导出，
  见 §2.1）。**该行已随 §2.1 的实施从 `docs/ui.md` §6 移除**（2026-09-14，见 `docs/progress.md` §36.3），
  本行保留为「当时的判断依据」记录。

## 7. 复核记录（2026-09-13）

### 7.1 谁审的、审出了什么

三名子代理**并行、互不可见**地审阅同一份清单（只读，不改文件）：

| 审查者 | 范围 | 结论 |
|---|---|---|
| 事实核对（scout） | §1.1–§1.8、§3.1–§3.5 逐条对照源码 | 10 条属实（行号误差 ≤1）；**3 条不准确**：§1.8、§3.2、§3.4 —— 已订正 |
| 可行性/风险（reviewer） | §2.1–§2.11 逐条攻击 | 3 条成立（§2.5、§2.9、§2.11 前提）；**2 条判错**（§2.7、§2.10）；5 条需改写（§2.1、§2.2、§2.3、§2.4、§2.6）；1 条成本口径需补（§2.8）—— 已订正 |
| 文档一致性（scout） | 交叉引用、搬移后的悬空引用、仓库惯例、守卫覆盖 | 12 处引用/数字一致；**4 处需修**（§22 条数、`docs/ui.md` 的指向、`docs/ui.md`「第一行/第二行」、目录逐字）—— 已订正；结论：**无悬空引用**，本文件**不需要**加进 `test/docs.test.ts` 的 `CURRENT_STATE_FILES`（它不声明套件数/资源数，加进去反而会触发「未声明套件数？」失败） |

### 7.2 逐条订正（原表述 → 复核后）

| 条目 | 原表述的问题 | 订正 |
|---|---|---|
| 1.8 | 「`/api/time` 无人使用」——**官方客户端就在调它**（`docs/protocol.md:430`：时钟差 > 5 分钟即中止同步） | 改为「**本站界面未使用**」：端点有真实消费者，缺的只是界面展示 |
| 3.2 | 「`/ui/api/*` 没有 `Cache-Control`」——被数据端点推翻 | 限定为「**除数据端点外**」；数据端点已有 `private, max-age=60`（`src/ui/routes.ts:186`），加统一中间件时须处理这条例外 |
| 3.4 | 字段名 `maxLastModified` **不存在**（只是 SQL 别名 `m`） | 改为 `{count, lastModified}`（`src/ui/query.ts:281-291`） |
| 2.1 | 「DO 侧零改动」，并把票据说成「一次性」 | 改为「**DO 类不用改**」（`hubStub` / `REGISTER_TOKEN_PATH` 都已导出）+ 三条真前置（前端手写 SignalR 分帧 + <60 s 心跳、票据实为 10 分钟可复用 bearer、真·一次性 / WS Hibernation 都属 DO 侧改动、DO 常驻计费） |
| 2.2 | 「isolate 缓存把代价压回零」「不违反 D13」 | 改为「只能**摊薄**，撤销是跨 isolate 最终一致」+「**需要新增 ADR**（如 D16）显式记录该取舍」+ 引用 G1 的反向教训 |
| 2.3 | 泛泛写「三个路由都不处理 Range」 | 收窄为「**只给 `/ui/api/history/:type/:hash/data` 加**」——协议侧忽略 Range 是对齐上游的有意行为，且有 `test/fix-regressions.test.ts:674-675` 的断言守着 |
| 2.4 | 「分页扫描端点，每页 N 条逐条 HEAD」 | 换成**目录级差集**（R2 列举 × DB 期望目录集合，两半仓库已有），只对差集逐条 HEAD；并写明 800 子请求预算与阶段保底规则 |
| 2.6 | 成本「低」；「每天写一行」 | 补三条隐含成本：Cron 是**每小时**⇒ 需按日期键幂等；Meta **无裁剪机制**⇒ 趋势行自带过期；计数来源不要复用现状 `statistics()`（那正是 §3.1） |
| 2.7 | 「`clientCount()` 只用于一行日志」「加一个键即可」 | 判错并改写：该方法还供 `scheduleHeartbeat()` 使用；DO **没有可读端点**，须新增分支（且别落到 `handleLongPoll`）；`/ui/api/info` 会因此变成带 DO 依赖的端，失败语义要单独定 |
| 2.8 | 只说「受 128 MB 内存限制」 | 补：全文导出**不能复用列表端点**（text 截到 500 字符）；逐条路径是 O(N) 请求；zip 路线必须流式 |
| 2.10 | 「免费档无 Image Resizing / 受计划限制」 | 判错并改写：免费档**含** transformations（5 000 次/月唯一变换），本项从「受计划限制」变为**可做**，并补三条实施注意 |
| 2.11 | 「D1 支持 FTS5」（无出处） | 补平台文档出处；补「匹配语义会变」与「无 migrations 目录，存量库需手工迁移」 |

### 7.3 不采纳的复核意见

1. **§2.11 附带的一条**：审查者认为「现状 `LIKE '%…%'` 受 D1 的 50 字节模式上限、超长搜索串会报错，
   是**现状正确性问题**，不只是性能优化」——**不成立**。`src/serialization.ts:414-427` 已有
   `MAX_SEARCH_BYTES = 48`（G6 修复），注释里记录了实测口径（「48 字节通过、49 字节失败」，模式为 `%…%`），
   且**协议 `/api/history/query` 与 UI `/ui/api/history` 共用这一判定**（`src/routes/history.ts:106`、
   `src/ui/query.ts:133`）：48 + 2 个通配符 = 50，正好卡在上限内。故该项只保留「FTS5 会改变匹配语义」的部分。
   教训：审查者看到 `LIKE '%…%'` 就推出「越界」，但没往上游找那道**共享的**入口校验——**判定在读入口，
   不在拼接处**，这是本仓库已有的一条惯用做法（同类：`parseDeletedFlag`）。

### 7.4 第二轮订正（顾问复核，同日）

第一轮定稿后又收到一轮顾问意见，逐条核对后采纳 6 条、部分采纳 1 条：

| # | 意见 | 处置 |
|---|---|---|
| 1 | 标号 `A1/B1/C1` 会与 §32/§33 的「A 批 / B 批 / C 批 / D 批」互相污染 | **采纳**：改为 `§1.N / §2.N / §3.N`，文首写明理由 |
| 2 | 半数条目是既有记录（§34.7 批量恢复、§24 与 `docs/ui.md` §9 的三条已知限制、§26 的 12 条），不该当新发现 | **采纳**：文首加「与既有记录的关系」块逐条指回原文，行内补出处 |
| 3 | §2.1 的前置写错：`hubStub`（`src/hub.ts:32`）与 `REGISTER_TOKEN_PATH`（`:7`）**都已导出**，`hub.ts` 无需改动 | **采纳**：改写为「Worker 侧只需新增端点」+ 三条真前置 |
| 4 | §2.4 的「50 子请求/请求」取错行；Free 的**内部服务**子请求上限是 **1 000/次调用** | **采纳**：改写为 1 000/次调用（「逐条 HEAD 1009 条一次调用即触顶」）；结论（用目录差集）不变 |
| 5 | §3.3（压缩）的「本地 dev 无 content-encoding」是探测失误（那次没带 `Accept-Encoding`） | **采纳并撤销该条**：补带 `Accept-Encoding` 的复测——`content-encoding: gzip`、76 595 → 13 733 B |
| 6 | `README.md` 的目录树与「文档」表都逐一点了 `docs/` 下的文件，新增独立文件会静默漏项（§32 的 U27 记过同类坑） | **采纳**：两处都补上本文件 |
| 7 | 「别把 §33.5 的未做清单当现状引用」（§34 已做掉大半） | **部分采纳**：本文件未引用 §33.5，仅在文首加了一句提醒，避免后来者误用 |

另：§2.11 里被驳回的那条（LIKE 50 字节上限）由**可行性审查者提出**，顾问复核时独立核对同一处代码后
**驳回**（反证：`MAX_SEARCH_BYTES = 48` 的入口共享判定，见 §7.3）。两次的落点相同：
**判定在读入口 `normalizeSearchText`，不在 `LIKE '%…%'` 的拼接处**。

### 7.5 第三轮订正（实施期复核，2026-09-14）

| # | 原表述 | 订正 |
|---|---|---|
| 1 | §1.7/§3.5/§5 第 4 条：界面接「清空全部」**须先补广播** | **订正为不补广播**：① 上游广播触发点清单（`AddProfile`/`Update`/`AddRecordDto`/`MarkForDeletionAsync`/`GetExistingProfileAsync`，见 `docs/protocol.md` §6）**不含 clear**，且上游 `HistoryService.ClearAllAsync` 只删行 + 删数据、无通知调用；② `RemoteHistoryChanged` 的 `arguments[0]` 会被官方客户端按 `HistoryRecordDto` 反序列化，给已硬删的记录推载荷是伪造语义；③ 1000+ 条逐条广播 = 1000+ 次 DO 子请求，超单次调用上限必中途失败。界面与跨标签页收敛走 `/ui/api/poll` 的 `{count, lastModified}` |
| 2 | §2.8 的推迟理由写「免费档 50 子请求」 | 订正为「真正的约束是免费档 10ms CPU」（D1/R2 binding 属内部服务、上限 1000，见 §7.4 第 4 条） |

（这三处原表述**保留在上文对应单元格里**，只加订正标记——本文件的惯例是订正可追溯，不静默改写。）

## 8. 实施状态（2026-09-14）

| 条目 | 状态 | 落地位置 / 理由 |
|---|---|---|
| §1.1 清理状态 | ✅ | 概览抽屉的「保留策略 / 清理」小节（V2：`public/ui_v2/js/ui/drawer.js`；V1：`public/ui_v1/js/components/info.js`） |
| §1.2 `pinned` 写入口 | ✅ | 行内置顶开关 —— V2 在行菜单（`public/ui_v2/js/menus.js`），V1 在行内固定槽位（`public/ui_v1/js/components/list.js`），两版复用同一条 `PATCH` |
| §1.3 批量操作 | ✅ | `POST /ui/api/history/batch-update`（原 `batch-delete` 泛化）+ 选择条按视图给动作 |
| §1.4 排序 6 字段 | ◑ | 表头 5 个可点（类型/大小/创建/修改/访问）；`id` 无可见列，仍只在 URL 里可用 |
| §1.5 `pageSize` 上限 | ✅ | 下拉补 500 |
| §1.6 `PATCH` 回执 | ✅ | 采纳 `version`/`lastModified`/`lastAccessed` 等元数据 |
| §1.7 清空全部 | ✅ | `POST /ui/api/history/clear`（`trash`/`all`）；**不补广播**，见 §3.5 与 §8 末行 |
| §1.8 `/api/time` | ✅ | `/ui/api/poll` 带 `serverTime` → 部署信息显示与本机的时钟差（>5 分钟告警） |
| §2.1 真推送 | ✅ | `POST /ui/api/hub-ticket` + 推送通道（V2 `public/ui_v2/js/push.js`、V1 `public/ui_v1/js/signalr.js`）；轮询保留为 60 秒看门狗，后台断连 |
| §2.2 会话可撤销 | ⏸ | 推迟：需在守卫热路径加 D1 读 + 新增 ADR；现有「改口令即全部失效」通道可用 |
| §2.3 Range | ✅ | 只给 `/ui/api/history/:type/:hash/data` 加（协议侧有意忽略 Range，F29b 未动） |
| §2.4 完整性自检 | ✅ | `GET /ui/api/integrity`（目录差集，不逐条 HEAD）+ 部署信息里的「数据完整性」小节 |
| §2.5 保留策略在线可调 | ✅ | `PUT /ui/api/settings`（Meta 覆盖，`0`=关闭、空=回落 env）；读取走 `/ui/api/info` 的 `retention`（带来源字段）——单独的 GET 因无人调用已删，cleanup 与 info 读同一份 `readRetentionSettings` |
| §2.6 存储/条数趋势 | ⏸ | 推迟：Cron 幂等写 + Meta 无裁剪机制 + 新图表；收益有限（见 §2.6 的成本说明） |
| §2.7 客户端数 / 最近同步 | ◑ | 「最近一次变更」已显示（来自 `/ui/api/poll` 的 `lastModified`）；DO 侧只读端点未加（推迟） |
| §2.8 导出历史 | ⏸ | 推迟：含二进制的完整导出必须全程流式 zip，真正的约束是免费档 **10ms CPU**（§7.4 已订正过「50 子请求」那条口径——D1/R2 binding 属内部服务、上限 1000）；只导出元数据+文本又算不上「导出历史」。单条下载已覆盖「取回某个文件」的实际需求 |
| §2.9 记录级深链接 | ✅ | `/ui_v2/#Type-<hash>` 打开即预览；预览时写入 hash、关闭时清除 |
| §2.10 服务端缩略图 | ⏸ | 推迟：依赖部署侧是否启用 Images（仓库内无证据）+ 额度按唯一变换计量 |
| §2.11 FTS5 | ⏸ | 推迟：会改变匹配语义 + 存量库迁移；且 `schema.sql` 改动在「推送即生产」下需额外回填步骤 |
| §3.1 `statistics` 全表拉取 | ✅ | 一条聚合查询；`countByType` 两条合一 |
| §3.2 JSON 缺 `Cache-Control` | ✅ | `/ui/api/*` 统一 `no-store`，数据端点自带缓存自动例外 |
| §3.3 压缩 | ✅ 无动作 | 复核后撤销（压缩已生效） |
| §3.5 `clear` 不广播 | ❌ **不采纳** | 上游触发点清单不含 clear、逐条广播超子请求上限、伪造 DTO 载荷有客户端风险；协议侧改为批量数据清理（效率），界面收敛靠 `/ui/api/poll` |
| §4 不做项 | ❌ | 与 `docs/ui.md` §6 一致，本轮未新增例外 |

逐条的实施细节、验证证据与推迟理由见 `docs/progress.md` §36。
