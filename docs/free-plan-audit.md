# SyncClipboard CfServer — Cloudflare Free 计划适配审计

> 审计对象：**工作区**（HEAD `8b65fe4` + 未提交改动）。审计日期 2026-09-25。
> 本文**只审计与设计，不改任何代码**；所有 `文件:行` 均为本次实读行号。
> 平台事实全部来自官方文档（URL + last updated 逐条给出），与仓库内证据**分开标注**：
> 「文档」= 官方文档，「实测」= 仓库注释里记录过的真实测量，「推断」= 本次静态推导。
> 凡读不到官方说明的，写「未核实」，不编数字。
>
> ⚠️ **修订 r3（同日，审计过程中）**：并行工作者正在改三个文件（工作区 `M`，未提交），
> 其中两处正是本文的结论：
> · `src/hash.ts` + `src/profile.ts` —— 消除「同一份字节 SHA-256 多遍」（本文 P1-1）；
> · `src/routes/webdav.ts` —— 消除 `c.json(JSON.parse(profileDtoToJson(x)))` 的三重往返（本文 P2-2）。
> 本文已按**改动后**的工作区重算 §3.1/§3.2、§2.1 与 P0-1/P1-1/P2-2，这三个文件的行号以工作区为准；
> 其余文件未改动，行号不受影响。**审计对象是工作区，不是 HEAD。**

**一句话结论**：Free 上**先撞的不是子请求，是 10 ms CPU** —— 落库路径对 payload 的 SHA-256
（`src/profile.ts:164` 等）在 Free 的 CPU 预算下只够约 3–10 MiB，而请求体默认上限是 48 MiB
（`src/requestLimits.ts:10`）；清理任务（Cron）同样只有 10 ms CPU，现有 800 子请求预算
**只管子请求、完全不管 CPU**，且平台在 CPU 超限时是**直接终止**（`error 1102`），
`ctx.waitUntil(runCleanup)` 的 catch 与收尾落库都不会执行 ⇒ 清理可观测面（F11）会重新变黑。

> ⚠️ **修订 r4（2026-09-25，账户实测回填）**：上面的「一句话结论」**已被账户实测推翻一条**。
> 该账号真实承载过 **15.5 MiB 的 zip 请求体 / 20.36 MiB 的 Group 载荷**（2026-09-24），
> 单次调用 CPU 达 **633 ms / 712 ms** 仍然成功，30 天内**资源超限 0 次**
> ⇒ 「Free 上有效上传上限约 3–10 MiB、超过必然 `error 1102`」**不成立**。
> 根因是本文漏掉的一条官方机制：**rollover CPU time** —— 官方 metrics 页原文「更高的分位可能看起来
> 超过 CPU 时间上限而不产生调用错误」，limits 页也写「每个 isolate 对偶发越界有内建余量」
> ⇒ **10 ms 是平均预算，不是单次硬顶**；只有**持续**越界才终止。
> **本文的静态分析与优先级清单不重写**（它们是带日期的产物；§3 的「必然超 10 ms」是**遍数 × 吞吐假设**的
> 保守推断，不是实测）。实测数字一律见下方 **§6.1**，完整账户事实（配额消耗、权限边界、查询原文、
> 账户计划未判定）见 [`docs/free-plan-account-facts.md`](free-plan-account-facts.md)。

---

## §1 平台限额事实

### 1.1 事实表（逐条给文档 URL 与 last updated）

| # | 限额 | Free | Paid | 来源（URL） | last updated |
|---|---|---|---|---|---|
| W1 | 请求 | 100,000 / 天（UTC 0 点重置，超限 `Error 1027`） | 无限制 | https://developers.cloudflare.com/workers/platform/limits/ | **Sep 5, 2026** |
| W2 | CPU / HTTP 请求 | **10 ms** | 5 min（默认 30 s） | 同上（`#cpu-time`） | Sep 5, 2026 |
| W3 | CPU / Cron Trigger | **10 ms** | 30 s（<1h 间隔）/ 15 min | 同上 | Sep 5, 2026 |
| W4 | 内存 / isolate | 128 MB（**按 isolate 计，被并发共享**） | 128 MB | 同上（`#memory`） | Sep 5, 2026 |
| W5 | 子请求 / 调用（外部 `fetch`） | **50** | 10,000（可配至 10M） | 同上（`#subrequests`） | Sep 5, 2026 |
| W6 | 子请求 / 调用（**到 Cloudflare 服务**） | **1,000** | 同配置值（默认 10,000） | 同上（`#subrequests` 第二行） | Sep 5, 2026 |
| W7 | 同时打开的出站连接 | 6 | 6 | 同上 | Sep 5, 2026 |
| W8 | Cron 触发器 / 账号 | **5** | 250 | 同上 | Sep 5, 2026 |
| W9 | 静态资源文件 / 版本 | **20,000**（单文件 25 MiB） | 100,000 | 同上（`#static-assets`） | Sep 5, 2026 |
| W10 | Worker 体积 / 启动时间 | 64 MiB / **1 s** | 同 | 同上 | Sep 5, 2026 |
| W11 | 环境变量 | 64 个 / Worker，单个 5 KB | 128 个 | 同上 | Sep 5, 2026 |
| W12 | 请求体上限（**按 zone 计划，不按 Workers 计划**） | Free zone = **100 MB** | — | 同上（`#request-and-response-limits`） | Sep 5, 2026 |
| W13 | Cache API 调用 / 请求 | 50（与子请求共用配额） | 1,000 | 同上 | Sep 5, 2026 |
| D1-1 | 查询 / Worker 调用 | **50（见 §1.2 的裁定）** | 1000 | https://developers.cloudflare.com/d1/platform/limits/ | **Apr 21, 2026** |
| D1-2 | 单库大小 / 账号存储 | 500 MB / 5 GB | 10 GB / 1 TB | 同上 | Apr 21, 2026 |
| D1-3 | 单行 / 单值 | 2,000,000 B（2 MB） | 同 | 同上 | Apr 21, 2026 |
| D1-4 | 绑定参数 / 单条语句长度 | 100 / 100,000 B | 同 | 同上 | Apr 21, 2026 |
| D1-5 | LIKE/GLOB 模式 | **50 字节** | 同 | 同上 | Apr 21, 2026 |
| D1-6 | 行读 / 行写（计费额度） | **5,000,000 行读 / 天；100,000 行写 / 天** | 250 亿 / 月；5000 万 / 月 | https://developers.cloudflare.com/workers/platform/pricing/ | **Aug 28, 2026** |
| D1-7 | 存储（账号） | 5 GB | 首 5 GB 含 | 同上 | Aug 28, 2026 |
| R2-1 | 存储（**按月**，仅 Standard 存储类） | **10 GB-month / 月** | $0.015/GB-mo | https://developers.cloudflare.com/r2/pricing/ | **Aug 7, 2026** |
| R2-2 | Class A 操作（**含 `ListObjects`、`PutObject`**） | **1,000,000 请求 / 月** | $4.50/百万 | 同上 | Aug 7, 2026 |
| R2-3 | Class B 操作（`GetObject`、`HeadObject`） | **10,000,000 请求 / 月** | $0.36/百万 | 同上 | Aug 7, 2026 |
| R2-4 | `DeleteObject` / `AbortMultipartUpload` | **免费（不计 Class A/B）** | 免费 | 同上 | Aug 7, 2026 |
| R2-5 | 出口流量 | 免费 | 免费 | 同上 | Aug 7, 2026 |
| R2-6 | 对象大小 / 单次上传 | 5 TiB / 5 GiB（单段） | 同 | https://developers.cloudflare.com/r2/platform/limits/ | **Jun 8, 2026** |
| DO-1 | 请求（**含 HTTP、RPC、WebSocket 消息、alarm 调用**） | **100,000 / 天** | 100 万/月 + $0.15/百万 | https://developers.cloudflare.com/workers/platform/pricing/ | Aug 28, 2026 |
| DO-2 | Duration（GB-s，按分配到的 128 MB 计费） | **13,000 GB-s / 天** | 400,000 GB-s/月 | 同上 | Aug 28, 2026 |
| DO-3 | 行读 / 行写（SQLite 后端） | 5,000,000 / 天；100,000 / 天 | 同 D1 口径 | 同上 | Aug 28, 2026 |
| DO-4 | 存储（账号） | 5 GB | 不限 | https://developers.cloudflare.com/durable-objects/platform/limits/ | **Jun 1, 2026** |
| DO-5 | 后端可用性 | **Free 仅支持 SQLite 后端**（KV 后端仅 Paid） | 两者 | 同上 | Jun 1, 2026 |
| DO-6 | 每对象 CPU | 默认 30 s，可配到 5 min | 同 | 同上 | Jun 1, 2026 |
| DO-7 | alarm | 15 min wall time；**每次 `setAlarm` = 1 行写**；alarm 调用计入 DO-1 | 同 | 同上 + pricing 脚注 3 | Jun 1, 2026 / Aug 28, 2026 |
| CFG-1 | `[limits] cpu_ms` | 文档只承诺 **Paid 可调大**（"On the Workers Paid plan, you can increase the maximum CPU time…"）；wrangler 页仅写 "Limits are only supported for the Standard Usage Model"、上限 300,000 ms，**未说 Free 不可设置** ⇒ 原「只能配 Paid」是过度引申（**不影响"不要设"的结论**：设了只会更早失败，不会抬高上限；实测本账号 `user_limits.cpu_ms = null`） | 最大 300,000 | https://developers.cloudflare.com/workers/wrangler/configuration/ | **Sep 24, 2026** |
| CFG-2 | `[limits] subrequests` | "**The free account maximum is 50**" | 最大 10,000,000 | 同上 | Sep 24, 2026 |
| CFG-3 | `[limits]` 生效范围 | "only supported for the Standard Usage Model"，且**仅部署后生效**（本地 dev 不生效） | — | 同上 | Sep 24, 2026 |

仓库侧对应现状（用于后文对照）：

- `wrangler.toml:68` `crons = ["7,27,47 * * * *"]` ⇒ 1 个 Cron 触发器（W8 用掉 1/5）✓
- `wrangler.toml:107-110` `[assets]` + `run_worker_first = ["/ui", "/ui/*", "/ui_v1", "/ui_v1/*", "/ui_v2", "/ui_v2/*", "/ui_shared", "/ui_shared/*"]`
  ⇒ **全部界面资源请求都先进 Worker**（`src/index.ts:246-268`），每次 1 次 `ASSETS.fetch`（`src/index.ts:265`）
- `public/` 共 **86 个文件**（实测 `find public -type f | wc -l`），最大单文件 102,220 B ⇒ W9 用掉 0.43% ✓
- `wrangler.toml` **没有** `[limits]` 段 ⇒ CFG-1/CFG-2 未使用（**这是对的，见 §5 P0-2**）
- `wrangler.toml:77-78` `[observability] enabled = true` ⇒ 调用级 CPU/子请求可查（**这是 §6 测量办法的基础**）

### 1.2 裁定：「子请求 50/调用」vs「internal services 1,000」vs「D1 查询 50/调用（Free）」

三处数字互相矛盾，必须先定口径，否则后面所有预算都悬空。**我采信的裁定如下**：

**采信口径（本文全部计算按此）：**

1. **Free 的单次调用上限 = 50 次「外部」`fetch` + 1,000 次「到 Cloudflare 服务」的调用**，
   两者**分开计**、各自独立封顶。D1 / R2 / DO binding 调用属于后者 ⇒ **上限 1,000**。
2. D1 页写的「Queries per Worker invocation = 50（Free）」**不作为独立限额采信**，
   但作为**风险备选口径**在 §2/§5 里单独标注（因为一旦它成立，批量端点会功能性失败）。

**理由（按证据强度排序）：**

- **决定性证据**：官方 changelog 2026-02-11《Workers are no longer limited to 1000 subrequests》
  （https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/）原文：
  > "Workers on the free plan remain limited to **50 external subrequests and 1000 subrequests to
  > Cloudflare services** per invocation."

  这是唯一一句把两个维度**分开写清**的官方表述，且它专门解释了为什么要有 1,000 这一档
  （"especially important for long-running Workers requests, such as open websockets on Durable Objects"）。
- Workers limits 页的表格结构与之一致：`Subrequests per invocation` 50 / 10,000；
  `Subrequests to internal services` **1,000** / 同配置值。两行并列 ⇒ 是两个独立额度。
- D1 页那一行的数字（**1000 Paid / 50 Free**）与**改版前**的通用子请求行（Free 50 / Paid 1,000）
  逐位相同，且该行自带括号说明「read subrequest limits」——即它是在**引用**子请求页的通用数字，
  而不是 D1 自己的实测限额。改版后通用行变成了「50 / 10,000」与「1,000 / 同配置」两行，
  D1 页没有跟着拆开 ⇒ 判定为**继承性过时表述**。

**保守口径（§2/§5 里并列给出，用于风险标注）：** 把「单次调用内可执行的 D1 语句数」按
`min(50, 1000) = 50` 计。若该口径成立，则任何单次调用发 >50 条 D1 语句的端点必然半途失败。

**对预算的影响**：仓库现有 `SUBREQUEST_BUDGET = 800`（`src/cleanup.ts:32`）与
`docs/backend-gaps.md:69`（§2.4）、`src/storage.ts:131-133` 的注释，采信的都是「1,000」——
**按上面的裁定，这个采信是对的**。但注意：**800 只在 `[limits] subrequests` 未设置时成立**
（见 §5 P0-2 与 CFG-2）。

**未核实**：D1 页与 changelog 的冲突没有被官方任何一处明确澄清；`[limits] subrequests` 在 Free 上
设成 50 时**是否同时把 internal-services 额度钳到 50**，文档未说明（CFG-2 只说了"free account maximum is 50"）。
⇒ 结论：**在 Free 上不要设置 `[limits] subrequests`**（不设 = 保持 1,000；设了最坏降到 50）。

---

## §2 每次调用的子请求最坏情况

记法：`P = ⌈N/1000⌉`（R2 列举分页数，1,000 键/页）；`N` = history 区对象数；
`T` = `file/` 暂存对象数；`C` = 同名候选记录数（`GET /file/{name}`）；
**比值列**给出 `合计 / 1,000`（采信口径），D1 列额外给出 `/50`（保守口径）。
**所有入口的外部 `fetch` = 0**（本仓库不使用外部 `fetch`，只有 binding 调用），
故 W5（50）**在任何入口都不会被撞到**。

### 2.1 官方客户端路径

| 入口 | D1 | R2 | DO | ASSETS | 合计最坏 | 比值（采信口径） | 保守口径（D1/50） |
|---|---|---|---|---|---|---|---|
| `GET /api/version`（`src/index.ts:204`） | 0 | 0 | 0 | 0 | **0** | 0 | ✓ |
| `GET /api/time`（`src/index.ts:213`） | 0 | 0 | 0 | 0 | **0** | 0 | ✓ |
| `GET /`（`src/routes/webdav.ts:35`） | 0 | 0 | 0 | 0 | **0** | 0 | ✓ |
| `PROPFIND /`（`webdav.ts:46`） | 0 | 0 | 0 | 0 | **0** | 0 | ✓ |
| `PROPFIND /file`（`webdav.ts:50` → `storage.ts:87`） | 0 | `⌈T/1000⌉` | 0 | 0 | **⌈T/1000⌉** | <1%（T<1000） | ✓ |
| `MKCOL /file`（`webdav.ts:66`） | 0 | 0 | 0 | 0 | **0** | 0 | ✓ |
| `GET /SyncClipboard.json`（`webdav.ts:71`） | 1 | 0 | 0 | 0 | **1** | 0.1% | ✓ |
| `PUT /SyncClipboard.json` 无 data（`webdav.ts:115`） | 2 | 0 | 2 | 0 | **4** | 0.4% | ✓ |
| `PUT /SyncClipboard.json` 有 data（File/Image/Group） | ≤4 | 3 | 2 | 0 | **≤9** | 0.9% | ✓ |
| `PUT /file/{name}`（暂存，流式，`webdav.ts:167`） | 0 | 1 | 0 | 0 | **1** | 0.1% | ✓ |
| `GET/HEAD /file/{name}`（`webdav.ts:149`） | 1 | **C**（每候选 1 次 get） | 0 | 0 | **1+C** | C≥999 时触顶 | ✓ |
| `DELETE /file/{name}`（`webdav.ts:190`） | 0 | 1 | 0 | 0 | **1** | 0.1% | ✓ |
| `DELETE /file`（`webdav.ts:183` → `storage.ts:220`） | 0 | 2·⌈T/1000⌉ | 0 | 0 | **2·⌈T/1000⌉** | <1% | ✓ |
| `POST /api/history`（`history.ts:381`） | ≤3 | ≤1 | 1 | 0 | **≤5** | 0.5% | ✓ |
| `POST /api/history/query`（`history.ts:355`） | 1 | 0 | 0 | 0 | **1** | 0.1% | ✓ |
| `GET /api/history/{profileId}`（`history.ts:290`） | 1 | 0 | 0 | 0 | **1** | 0.1% | ✓ |
| `GET /api/history/{id}/data`（`history.ts:304`） | 1 | 1 | 0 | 0 | **2** | 0.2% | ✓ |
| `PATCH /api/history/{type}/{hash}`（`history.ts:440`） | ≤3 | 0 | 1 | 0 | **≤4** | 0.4% | ✓ |
| `GET /api/history/statistics`（`history.ts:282`） | 1 | P | 0 | 0 | **1+P** | <1%（N<10⁵） | ✓ |
| `DELETE /api/history/clear`（`history.ts:474`） | 1 | 2·P | 0 | 0 | **1+2P** | N=5×10⁵ 时触顶 | ✓ |
| `POST /SyncClipboardHub/negotiate`（`hub.ts:90`） | 0 | 0 | 1 | 0 | **1** | 0.1% | ✓ |
| Hub WS / SSE / 长轮询连接（`src/index.ts:292-293` → DO） | 0 | 0 | **0**（全在 DO 内，含 storage 读） | 0 | **0** | 0 | ✓ |

> `GET /file/{name}` 的 `1+C` 是**唯一无界扇出**：`db.listTransferFileCandidates`（`src/db.ts:323`）
> 返回**全部**同名候选，路由对每条候选做一次 `getHistory`（`src/routes/webdav.ts:157-161`），
> 命中即返回、**不命中才继续**。C 由「库内同名文件的记录条数」决定，无上限 ⇒ C≥999 时超 1,000。

### 2.2 界面路径（`/ui/api/*`）

| 入口 | D1 | R2 | DO | ASSETS | 合计最坏 | 比值 | 保守口径（D1/50） |
|---|---|---|---|---|---|---|---|
| `POST /ui/api/login`（`routes.ts:271`） | 0 | 0 | 0 | 0 | **0** | 0 | ✓ |
| `POST /ui/api/logout` / `GET /ui/api/session` | 0 | 0 | 0 | 0 | **0** | 0 | ✓ |
| `GET /ui/api/history`（`routes.ts:327` → `query.ts:293`） | 2 | 0 | 0 | 0 | **2** | 0.2% | ✓ |
| `GET /ui/api/history/:type/:hash`（`routes.ts:339`） | 1 | 0 | 0 | 0 | **1** | 0.1% | ✓ |
| `GET /ui/api/history/:type/:hash/data`（`routes.ts:351`） | 1 | 1（带 Range 则 2：head+get） | 0 | 0 | **≤3** | 0.3% | ✓ |
| `PATCH /ui/api/history/:type/:hash`（`routes.ts:418`） | ≤3 | 0 | 1 | 0 | **≤4** | 0.4% | ✓ |
| `POST /ui/api/history`（新建文本，`routes.ts:502`） | 3 | 0 | 1 | 0 | **4** | 0.4% | ✓ |
| `POST /ui/api/history/batch-update`（`routes.ts:573`，上限 100） | **≤300**（≤100×3） | 0 | 1 | 0 | **≤301** | 30% | **✗ 超 50（6×）** |
| `POST /ui/api/history/batch-purge`（`routes.ts:662`，上限 100） | **≤100** | ≤200（每条 2：列举+删） | 0 | 0 | **≤300** | 30% | **✗ 超 50（2×）** |
| `POST /ui/api/history/clear`（`routes.ts:715`） | 1 | 2·P | 0 | 0 | **1+2P** | <1% | ✓ |
| `POST /ui/api/hub-ticket`（`routes.ts:748`） | 0 | 0 | 1 | 0 | **1** | 0.1% | ✓ |
| `GET /ui/api/statistics`（`routes.ts:772`） | 2 | P | 0 | 0 | **2+P** | <1% | ✓ |
| `GET /ui/api/info`（`routes.ts:796` → `deploymentStats`+`deploymentMeta`） | **4** | P | 0 | 0 | **4+P** | <1% | ✓ |
| `GET /ui/api/overview`（`routes.ts:828`） | **5** | P | 0 | 0 | **5+P** | <1% | ✓ |
| `GET /ui/api/activity`（`routes.ts:805`） | 1 | 0 | 0 | 0 | **1** | 0.1% | ✓ |
| `GET /ui/api/poll`（`routes.ts:856`） | 1 | 0 | 0 | 0 | **1** | 0.1% | ✓ |
| `POST /ui/api/history/batch-meta`（`routes.ts:864`，上限 100） | ≤2（`query.ts:518` 分片 50） | 0 | 0 | 0 | **2** | 0.2% | ✓ |
| `GET /ui/api/integrity`（`maintenance.ts:65`） | 1 | P | 0 | 0 | **1+P** | <1% | ✓ |
| `PUT /ui/api/settings`（`maintenance.ts:113`） | ≤3 | 0 | 0 | 0 | **3** | 0.3% | ✓ |
| 任意界面**资源**请求（HTML/CSS/JS/图标/manifest） | 0 | 0 | 0 | **1** | **1** | 0.1% | ✓ |

> `batch-update` 的实际成本比注释里写的低：`routes.ts:570-571` 说「一条记录 ≈ 1 读 + 1 写 + 1 广播
> （删除时再 +2 的 R2 目录清理），100 条封顶 ≈ 500 次」——**这句已过时**：ADR D29 之后软删不再清
> 数据目录（`src/historyOps.ts` 的软删分支注释、`src/profile.ts` 的 `deleteDataIfNeed` 已被整段删除），
> 所以删除路径现在是 **2 次 D1 + 0 次 R2**，且广播已合并为 1 次（`broadcastMany`，`src/hub.ts:54`）。
> 即：100 条 ≈ **200 D1 + 1 DO = 201**，而不是 500。这使采信口径下的余量比注释声称的更大（5×），
> 但保守口径下依然超 50 达 4 倍。

### 2.3 Cron（`runCleanup` 四阶段）

| 阶段 | D1 / 批 | R2 / 批 | DO / 批 | 单批条数 | 批上限 | 记账常量 |
|---|---|---|---|---|---|---|
| `retention` 软删（`cleanup.ts:441`） | 1 | 0 | **1 / 条**（逐条广播） | 500 | 20 | `costPerRecord=1`、`queryCost=1` |
| `trim` 条数上限（`cleanup.ts:458`） | **2**（COUNT + UPDATE） | 0 | **1 / 条** | 500 | 20 | `queryCost=2` |
| `hardDelete` 30 天硬删（`cleanup.ts:480`） | 1 | 1 / 批（+每 1000 key 多 1） | 0 | 1000 | 20 | `costPerRecord=0` |
| `orphans` 孤儿回收（`cleanup.ts:502`） | 1（全表扫描） | P + 删除块 | 0 | — | — | 最小可推进 = 3 |
| 轮首/轮尾 Meta | 3（settings 1 + cursors 1 + 落库 1） | 0 | 0 | — | — | `cleanup.ts:604/618/665` |

**一轮最坏**：子请求 **≤ 800**（`SUBREQUEST_BUDGET`，`cleanup.ts:32`；`spend` 前先 `roomFor`
判定，`cleanup.ts:251-268`），D1 语句 **≈ 10–40 条**（推演：轮首 2 + retention 2 + trim 2 +
hardDelete ≤20×1 + orphans 1 + 轮尾 1），DO ≤ 740（retention/trim 的广播）。

**与 Free 上限的比值**：

| 口径 | 上限 | 一轮用量 | 比值 |
|---|---|---|---|
| Cloudflare 服务子请求（W6） | 1,000 | ≤800（记账） | **80%** |
| D1 语句（保守口径 D1-1） | 50 | 10–40 | **20%–80%**（hardDelete 跑满 20 批时 80%） |
| 外部 fetch（W5） | 50 | 0 | 0 |
| Cron CPU（W3） | **10 ms** | **未记账、未测量** | **未知 ⇒ §6 必测** |

### 2.4 代码里的预算常量与「Free 上是否必然超限」的逐条裁定

| 常量 | 位置 | 值 | Free 上是否必然超限 |
|---|---|---|---|
| `SUBREQUEST_BUDGET` | `src/cleanup.ts:32` | 800 | **否**（<1,000，前提：不设 `[limits] subrequests`）。但它**只管子请求**，10 ms CPU 无任何约束 ⇒ 见 P0-3 |
| `SOFT_DELETE_BATCH_LIMIT` | `src/cleanup.ts:37` | 500 | 否（500 广播 + 1 查询 = 501 ≤ 800） |
| `HARD_DELETE_BATCH_LIMIT` | `src/cleanup.ts:40` | 1000 | 否（每条 0 成本；20 批 × 2 = 40 子请求） |
| `MAX_BATCHES_PER_PHASE` | `src/cleanup.ts:42` | 20 | 否 |
| `PHASE_RESERVE` | `src/cleanup.ts:71-76` | 16/16/16/24（和 72） | 否（前提 `SUBREQUEST_BUDGET > 72`，注释已写明） |
| `R2_DELETE_BATCH` | `src/storage.ts:12` | 1000 | 否（R2 单次 delete 上限） |
| batch-update 条目上限 | `src/ui/routes.ts:596` | 100 | **保守口径下是**（200 D1 > 50） |
| batch-purge 条目上限 | `src/ui/routes.ts:679` | 100 | **保守口径下是**（100 D1 > 50） |
| `BATCH_META_MAX_ITEMS` / `HASH_CHUNK` | `src/ui/query.ts:488/518` | 100 / 50 | 否（绑定参数 ≤100 已守住） |
| `MAX_REQUEST_BODY_BYTES` | `src/requestLimits.ts:10` | 48 MiB | **是（CPU 口径，非子请求）** ⇒ P0-1 |
| `MAX_REQUEST_BODY_BYTES_CEILING` | `src/requestLimits.ts:19` | 64 MiB | 同上 |
| `ISOLATE_TRANSFER_BUDGET_BYTES` | `src/requestLimits.ts:26` | 96 MiB | 与 Free 无关（内存维度 Free=Paid=128 MB） |
| `GROUP_ZIP_MAX_*` | `src/hash.ts:85-92` | 64 MiB / 1000 条 / 100:1 / 24 MiB | **CPU 口径必然超**（解压是纯 CPU）⇒ P0-1 |
| `GROUP_ZIP_MIN_RATIO_CHECK_BYTES` | `src/hash.ts:88` | 8 MiB | 无关（判定阈值） |

---

## §3 CPU（10 ms）热路径

计量单位统一为「**对 payload 字节做了几遍 O(n) 工作**」。SHA-256 的吞吐按乐观 1 GB/s、
保守 300 MB/s 两档折算（**推断**，需实测，见 §6）；解压（zlib inflate）按 50–200 MB/s 折算。

### 3.1 逐路径的字节遍历次数

| # | 路径 | 对 payload 的 O(n) 遍数（明细） | 10 ms 折算 | 裁定 |
|---|---|---|---|---|
| A | **`PUT /SyncClipboard.json`（File/Image 带 data）** | ① `temp.arrayBuffer()` 拷贝 1 遍（`profile.ts:306`）② 客户端声明哈希的核对 `sha256Hex(content)`（`profile.ts:315`，**仅当客户端声明时**）③ 复用它作 profile 哈希输入（`profile.ts:164-165`）与 `transferDataHash`（`profile.ts:171`）⇒ **SHA-256 ×1（工作区已去重，见 §3.2）+ 拷贝 ×1** | 1 GB/s：~10 MiB；300 MB/s：~3 MiB | **必然超 10 ms（≥ ~3–10 MiB）** |
| B | **`PUT /SyncClipboard.json`（Text 带 data）** | `textProfileHashOf` → `contentHash ?? sha256Hex(content)`（`profile.ts:217`），`transferDataHash` 复用（`profile.ts:149`）⇒ **×1** | 同 A | 同 A |
| C | **`POST /api/history`（File/Image 带 data）** | ① multipart 边界扫描（`multipart.ts` 的 `findSubarray`，对整包扫 2–3 遍，`indexOf` 首字节 + 逐字节校验）② `bytesHash = sha256Hex(content)`（`profile.ts:637`）③ profile 哈希走 `fileProfileHashFromContentHash`（只摘要文件名+哈希串，O(1)）⇒ **SHA-256 ×1 + 扫描 ×2–3** | 同 A（叠加扫描） | **必然超 10 ms（≥ ~3–10 MiB）** |
| D | **`POST /api/history`（Text 带 data）** | `sha256Hex(content)` ×1（`profile.ts:596`；内联文本哈希有 `if (declared)` 守卫，`profile.ts:588`，无 hash 时不白算）⇒ **×1** | 同 A | 同 A |
| E | **Group（zip）上传**（PUT `profile.ts:184/188/199`；POST `profile.ts:662/666/676`） | ① `hasEndOfCentralDirectory` 扫尾部 ≤64 KB ② **流式 inflate 全量解压**（CPU 支配项）③ 每条目 `sha256Hex(bytes)`（`hash.ts:193-195`）⇒ 1 遍解压总量 ④ `concatChunks` 拷贝 1 遍/条目（`hash.ts:299`）⑤ `groupHashFromEntries`：encode 每个名字 + 排序 + `joined` 拼接拷贝 + 1 次哈希（`hash.ts:68-80`）⑥ `sha256Hex(zipBytes)` 1 遍 zip 体积（`profile.ts:199/676`） | 20 MB zip：inflate 100–400 ms | **必然超 10 ms（任何 > ~100 KB 的 zip）** |
| F | `POST /api/history` 的 multipart 解析（任何类型） | 边界扫描 2–3 遍整包；`parseMultipart` 每部分 1 次 `findSubarray`（`multipart.ts:69/77`）。仓库注释记录过旧实现的读数：**64 KB body / 61 字节分界串 = 48 ms**（`multipart.ts:27`），现实现改为 `indexOf` 首字节 + 复用编码（`multipart.ts:41-45`） | 48 MiB body 下仍是数十 ms 量级 | **可疑需实测**（现实现未测过 48 MiB 档） |
| G | `GET /SyncClipboard.json` | 存储值 `JSON.parse`（`serialization.ts:182` 的 `classifyStoredProfile`）；三重往返（`c.json(JSON.parse(profileDtoToJson(x)))`）**已在工作区消除**（`webdav.ts:94/109` 改为直接以字面量为 body） | 微秒级 | **不超**（P2-2 已落地） |
| H | `PROPFIND /file` | `listTempObjects` 分页 + 数组构造 + `multistatusXml` 的 `map/join`（`webdavXml.ts:62`）+ 每 href 一次正则 `escapeXml` + 逐段 `encodeURIComponent`（`webdavXml.ts:29`）⇒ **O(T)** | T=2×10⁴ 时约 1–3 MB 字符串 + 2×10⁴ 次正则 ⇒ 数十 ms | **大 T 必然超**；T<1000 无虞 |
| I | `GET /api/history/statistics`、`/ui/api/statistics`、`/ui/api/info`、`/ui/api/overview` | `storage.totalHistorySize()` 全桶列举（`storage.ts:207`）：每页 1 次 R2 list（**Class A**）+ **R2 list 响应的 JSON 反序列化**（1,000 条/页）+ JS 累加 ⇒ **O(N)** | N=10⁵（100 页）时反序列化 + 循环 ≈ 10–40 ms | **大 N 必然超**；N≈305（仓库注释 `storage.ts:133` 的实测值）无虞 |
| J | `/ui/api/history` 列表 | 每行 `rowToEntity` → **`JSON.parse(FilePaths)` 每行一次**（`db.ts:57-62`）+ `entityToDto` + `truncateText`；响应整体 `JSON.stringify`（≤500 行 × ≤501 字符） | pageSize=500 时 ≈ 250 KB JSON + 500 次小 parse ⇒ 数 ms | **可疑需实测**（pageSize=500 档） |
| K | `/ui/api/overview` / `/ui/api/info` | 同 I，且是**首屏必经**（`public/ui_v1/js/main.js:1852` 的 `Promise.all([refresh(), refreshOverview()])`） | 同 I | 同 I |
| L | `/ui/api/activity`、`/ui/api/poll`、`/ui/api/history` 的 COUNT | 单条聚合，走索引 | <1 ms | 不超 |
| M | 冷启动 | `mrmime` 是**静态对象字面量**（`node_modules/mrmime/index.mjs`，448 行/2.8 kB，**无运行时构造**——本次实读确认），`EXTRA_TYPES` 12 项亦为字面量（`contentTypes.ts:31-45`）⇒ 仅模块解析成本 | 微秒级 | **不构成冷启动风险**（W10 的 1 s 上限远未逼近） |
| N | 每请求固定开销 | Basic 头 base64 解码 + 常量时间比较（`auth.ts:63-90`）；UI 侧 1 次 HMAC-SHA256 验签（`session.ts:182`）+ 1 次 `JSON.parse`；`normalizeProtocolPath` 逐段处理（`pathCase.ts`） | <1 ms | 不超 |

### 3.2 同一份字节被 SHA-256 了几次（数清）

> **本节按审计时刻的工作区计**（`src/hash.ts` / `src/profile.ts` 有未提交改动，正是为消除这里的冗余）。
> `fileProfileHash`（`hash.ts:39-41`）保留为薄封装（测试按名字取用），新增
> `fileProfileHashFromContentHash`（`hash.ts:34`）接收调用方已算出的 contentHash。

| 场景 | 现在 | 改动前（HEAD） | 证据（工作区） |
|---|---|---|---|
| `PUT /SyncClipboard.json` + File/Image + 声明 `transferDataHash` | **1** | **3** | `profile.ts:315`（算一次）→ 复用于 `:164`（profile 哈希输入）与 `:171`（`transferDataHash`） |
| `PUT /SyncClipboard.json` + File/Image **无**声明哈希 | **1** | **2** | `profile.ts:164`（`contentHash ?? sha256Hex(content)`） |
| `PUT /SyncClipboard.json` + Text 带 data | **1** | 1 | `profile.ts:217`；`transferDataHash` 复用（`profile.ts:149` 的注释"已算过，复用"） |
| `PUT /SyncClipboard.json` + Group | 解压总量 1 遍（条目）+ zip 体积 1 遍（可复用） | 同 | `hash.ts:193-195`、`profile.ts:199`（`contentHash ?? sha256Hex(content)`） |
| `POST /api/history` + File/Image 带 data | **1** | **2** | `profile.ts:637`（`bytesHash`）→ `:638` 只摘要文件名+哈希串 |
| `POST /api/history` + Text 带 data | 1 | 1 | `profile.ts:596` |
| `POST /api/history` + Group | 同 PUT Group | 同 | `profile.ts:676` |
| `POST /api/history` 无 data、新建 Text | 1 遍（内联文本，小） | 同 | `profile.ts:711`（`isLocalDataValidStrict`） |
| `PUT /SyncClipboard.json` 无 data、inline Text | 1 遍（文本） | 同 | `profile.ts:721`（`isInlineDataValid`） |
| 新建记录且 `hash=''` 的 Text | 追加 1 遍 | 同 | `profile.ts:380`（`addProfile`） |

⇒ **结论**：File/Image 落库的冗余哈希**已在工作区消除**（3 遍 → 1 遍，POST 2 遍 → 1 遍），
哈希**值**逐字节不变（`hash.ts:34-41` 的注释写明 `toUpperCase()` 仍在）。这直接改变了 P0-1 的量级：
Free 上的有效上传上限从 ~1–3 MiB 抬到 **~3–10 MiB**（仍远低于默认 48 MiB）。

### 3.3 「必然超 10 ms」与「可疑需实测」的分档

**必然超（Free 上功能性失败）**
1. 任何 File/Image/Group 的**落库**（路径 A/C/E）—— 阈值约 3–10 MiB（File/Image）、约 100 KB（zip）。
   这与 `MAX_REQUEST_BODY_BYTES = 48 MiB`（`src/requestLimits.ts:10`）差 5–16 倍（去重前是 16–48 倍）。
2. `PROPFIND /file` 在暂存对象数 T ≳ 10⁴ 时（路径 H）。
3. 全桶列举路径（I/K）在 N ≳ 10⁵ 对象时。

**可疑需实测（不能静态定论）**
4. multipart 边界扫描在 48 MiB body 下的真实耗时（路径 F）。
5. `/ui/api/history` 在 `pageSize=500` 下的序列化成本（路径 J）。
6. Cron 单轮的真实 CPU（§2.3）—— 现有预算**完全没有 CPU 维度**。
7. `crypto.subtle.digest` 的 CPU 归属（原生实现是否全额计入 CPU 时间，官方文档未明确）⇒ §6。

**不构成风险（已核实，勿再立项）**
8. `mrmime` 冷启动（静态字面量，M）。
9. `GET /SyncClipboard.json` 的三重 JSON 往返（G，量级为微秒，且已消除）。

---

## §4 每日配额消耗

### 4.1 官方客户端（后台常驻）

- 仓库自称口径（`README.md:248-249`）：每 10 s 一次保活，每次 **2 个请求**（`PROPFIND /` + `GET /api/version`）
  ⇒ **17,280 请求/天/客户端**。两个端点都是 **0 子请求、0 D1、0 R2**（§2.1）⇒ 不消耗 D1/R2/DO 额度。
- **承载量**：`100,000 / 17,280 = 5.79` ⇒ **5 台 = 86,400（86.4%）**；**第 6 台 = 103,680 ⇒ 当天超限
  （`Error 1027`，按路由的 fail open/closed 表现为绕过 Worker 或 1027 错误页）**。
  `README.md:250` 的「多于 5 台建议升级 Paid」与本文一致 ✓。
- 客户端的 SignalR 长连接（客户端会保持）另计：negotiate = 1 DO 子请求；连接建立后
  **Worker 侧 0 请求、0 子请求**（`src/index.ts:292-293` 直接转发给 DO，鉴权与心跳都在 DO 内），
  但 DO 侧的**计费**见 4.4。

### 4.2 界面一次页面加载

| 项 | 次数 | 证据 |
|---|---|---|
| 界面资源请求（HTML + 5 CSS + 22 `modulepreload` + `theme-init.js` + `main.js` + 3 图标 + manifest） | **34** | `public/ui_v1/index.html:21-24,29-33,39-60,62,170`；每个都命中 `run_worker_first`（`wrangler.toml:110`）⇒ 34 次 Worker 调用、各 1 次 `ASSETS.fetch`（`src/index.ts:265`） |
| API 请求 | **6** | `GET /ui/api/session`（`main.js:1805`）、`GET /ui/api/history`、`GET /ui/api/overview`（`main.js:1852`）、`GET /ui/api/activity`（`main.js:1854`）、`GET /ui/api/poll`（`main.js:1855`）、`POST /ui/api/hub-ticket`（`main.js:113`） |
| WebSocket 升级请求 | 1 | `main.js:112-121` |
| 缩略图/预览（仅图片行、≤512 KiB，按需） | 0–N | `api.dataUrl`（`api.js:383`） |
| **合计** | **≈41 请求** | — |

- **子请求**：session 0 + history 2 D1 + overview（1 R2 列举 + 5 D1）+ activity 1 D1 + poll 1 D1 +
  hub-ticket 1 DO ⇒ **≈11 次/首次加载**（P=1 时）。
- **R2 列举页数**：`overview` 的 `totalHistorySize()` = **P 页 Class A**（`storage.ts:207`）；
  再开部署信息对话框（`/ui/api/info`）或多按几次刷新（`refreshStats` → `/ui/api/statistics`）
  各再 +P 页。**每次页面加载至少 1 次 `ListObjects`（Class A）**。
- **持续开销**：`/ui/api/poll` 的间隔由 `public/ui_v1/js/main.js:45-49` 决定 ——
  可见 10 s / 后台 30 s / **推送在线时降为 60 s 看门狗**。
  ⇒ 推送在线：**1,440 请求/天**；推送不可用（降级）：**8,640 请求/天**（与 `docs/backend-gaps.md:66`
  的「≈8.6 k 请求/天」一致）。
- ⇒ 一个开着一天的标签页（推送在线）≈ **41 + 1,440 ≈ 1,481 请求/天**，其中 34 次资源请求只在首次加载发生。

### 4.3 Cron 一轮（每 20 分钟 ⇒ 72 轮/天）

| 维度 | 一轮（最坏） | ×72 = 日量 | Free 额度 | 占比 |
|---|---|---|---|---|
| 请求（Cron 调用，**是否计入 100k/天未核实**） | 1 | 72 | 100,000 | 0.07% |
| 子请求（Cloudflare 服务） | ≤800（记账封顶） | ≤57,600 | 无日额度（仅单次 1,000） | — |
| D1 语句 | 10–40 | 720–2,880 | 无日额度（仅单次 50/1000） | — |
| **D1 行读** | ≈ `active` + 全表行数 + 软删扫描(≤500×2) + 硬删扫描(≤1000) ≈ 5,000（按 2,000 行库） | **≈360,000** | 5,000,000 | **7.2%** |
| **D1 行写** | 饱和时 ≈2,500（软删 500×2~3 + 硬删 1000 + Meta 6~12）；空转时 ≈6–12 | 饱和 **≈180,000** / 空转 **≈600** | 100,000 | **饱和时 180%（超）**；空转 0.6% |
| R2 Class A（`ListObjects`） | 1（`listHistoryObjectsByDir`，`storage.ts:150`） | 72 | 1,000,000/月（≈33,000/天） | 0.2% |
| R2 Class B / `DeleteObject` | 批量删 = **免费操作**（R2-4） | — | — | — |
| DO 子请求 | ≤740（软删广播） | ≤53,280 | 无日额度（仅单次 1,000） | — |

行读口径依据：D1 定义「Rows read measure how many rows a query **reads (scans)**」
（`workers/platform/pricing` 的 D1 Definitions #1）。`countActiveRecords` 是 `COUNT(*)`（`db.ts:540`），
`listReferencedWorkingDirs` 是**无过滤全表扫描**（`db.ts:583-586`）⇒ 两者都按全量计。

### 4.4 DO（Hub）的日消耗 —— 最容易被忽略的一条

| 维度 | 用量 | Free 额度 | 占比 |
|---|---|---|---|
| Duration（一个 WS 常驻） | 128 MB = 0.128 GB × 86,400 s = **11,059 GB-s/天** | 13,000 GB-s/天 | **85%** |
| 请求（alarm 心跳，15 s 一次） | 86,400/15 = **5,760/天** | 100,000/天 | 5.8% |
| 行写（每次 `setAlarm` = 1 行写，`SyncClipboardHub.ts:548`） | **5,760/天** | 100,000/天 | 5.8% |
| 行读/写（`registerToken` 的 `list({prefix:'tok:'})` + `put`，每次 negotiate） | 与 negotiate 次数同阶 | — | 可忽略 |

依据：DO 定价页脚注 4 —— "**Calling `accept()` on a WebSocket in an Object will incur duration
charges for the entire time the WebSocket is connected**"；脚注 5 —— duration 按**分配到的 128 MB**
计费，与实际用量无关。本 DO 用的是 `server.accept()`（`SyncClipboardHub.ts:214`，非 Hibernation API）
⇒ **只要有一个客户端或一个界面标签连着 WS，Hub 对象就常驻并持续计费**。
85% 是「一个常驻对象」的天花板（duration 在同一对象上**共享**，多连不叠加），但它意味着
**Free 上没有任何余量容纳第二个常驻 DO 对象**（例如将来按用户/房间分片）。

### 4.5 结论：先撞哪一条

按「到达上限所需的规模」排序（**由紧到松**）：

1. **W1 请求 100k/天** —— **最先撞**：5 台常驻客户端 = 86.4%，第 6 台即超。加一个开着的界面
   （≈1.5k/天）几乎不改变结论，但**每次页面加载 34 个资源请求**会让频繁刷新的用户显著加快消耗
   （100 次刷新 = 3,400 请求）。
2. **W3 Cron CPU 10 ms** —— 第二紧，且**当前完全未测量**：清理单轮要跑几十条 D1 + 最多 500 次
   广播 + 全表扫描，CPU 超限时平台**直接终止**（不走 `runCleanup` 的 catch，见 P0-3）。
3. **DO-2 Duration 13,000 GB-s/天** —— 一个常驻 WS 就吃掉 **85%**。
4. **D1-6 行写 100k/天** —— 仅在清理有大量积压时超（饱和 ≈180%）；稳态（空转）几乎为零。
5. **D1-6 行读 5M/天 / R2 Class A 1M/月** —— 当前规模（数百对象）远未逼近；
   10⁵ 对象量级才需要重新核算。
6. **W5/W6 子请求、W9 静态资源、D1 存储 5 GB** —— 不构成近期约束。

---

## §5 优先级修复清单（只给方案，不实施）

> 取向约束：**优先「不加新配置项也能同时对 Free 与 Paid 正确」的改法**（本仓库新增部署开关要
> 同步四处：`.dev.vars.example` / `deploy.yml` / `README.md` / `wrangler.toml`，且带守卫）。

### P0 —— Free 上功能性失败

**P0-1 大 payload 落库必然触发 `error 1102`（CPU 超限），且错误形态不是干净的 413**

- 问题：`MAX_REQUEST_BODY_BYTES` 默认 48 MiB（`src/requestLimits.ts:10`），但落库要对 payload 做
  SHA-256（工作区已降到 1 遍，§3.2）与（Group）全量 inflate，Free 的 CPU 只有 10 ms
  （W2/W3，`docs/design.md:373` 自己也写着"哈希与 zip 解压都是 CPU 工作 ⇒ 大文件同步本质上需要
  付费计划"）。Free 上超过约 3–10 MiB 的上传会以 `Worker exceeded resource limits`（1102）结束，
  而客户端看到的是 5xx/连接中断，**不是 413**（F9 的 413 只按 `content-length` 预检，
  `src/index.ts:85-96`，管不到 CPU）。
- 证据：`src/requestLimits.ts:10`、`src/profile.ts:164/217/637`、`src/hash.ts:85-92`、
  `docs/design.md:371-373`、`docs/backend-gaps.md:186`（已把真正的约束订正为 10 ms CPU）。
- 建议改法（**不加配置**）：
  1. **（已在工作区落地）** 冗余哈希去重 —— `src/hash.ts:34` + `src/profile.ts:164/199/217/637`
     已把 File/Image 从 3 遍降到 1 遍。**这条不要再做一遍**，只需在提交时带上文档同步。
  2. **文档如实登记 Free 的有效上限**（约 3–10 MiB 量级，需按 §6 M1 实测标定），并说明这是平台
     约束、不是配置项。**不要**为此新增 `MAX_REQUEST_BODY_BYTES` 的"Free 档默认值"——Worker 运行期
     拿不到账号计划（`Bindings` 里没有任何计划字段，`src/env.ts`），加开关只能靠人配，会立刻漂移。
  3. （可选，收益有限）Group 路径的 `concatChunks` 拷贝（`hash.ts:299`）可用 `node:crypto` 的增量
     哈希消除（`nodejs_compat` 已开，`docs/design.md` §7.1 记过可行性），顺带降低解压峰值内存；
     但**不改 CPU 的量级**（inflate 本身仍是支配项），故列在 P1-6。
- 代价/风险：① 改 `fileProfileHash` 的调用面已由并行改动覆盖 ⇒ 本条剩余工作只是文档；
  ② 文档写死数字会漂移 ⇒ 写"量级 + 测量办法"，不写精确阈值。
- 影响计划：**Free（决定性）+ Paid（CPU 计费直接降 2/3）**。

**P0-2 在 Free 上设置 `[limits] subrequests` 会把 internal-services 额度钳到 50（最坏），清理与批量端点整体失效**

- 问题：`[limits] subrequests` 的文档写着"**The free account maximum is 50**"（CFG-2），而
  Paid 那一行明确写着 internal-services "Matches configured limit"（W6）。若 Free 同理，
  设了它 ⇒ 单次调用只能发 50 次 Cloudflare 服务调用 ⇒ `SUBREQUEST_BUDGET = 800`
  （`src/cleanup.ts:32`）永远拿不到，四阶段全部截断（软删每轮 ≤ 15 条），孤儿回收几乎不跑。
- 证据：CFG-2（wrangler 配置页）、W6、`src/cleanup.ts:32`、`docs/backend-gaps.md:69`。
- 建议改法：**保持 `wrangler.toml` 里没有 `[limits]` 段**（现状正确），并在 `docs/design.md` §9
  与 `README` 的容量章节**明写一条纪律**："Free 上不要设置 `[limits] subrequests`；它不能放宽额度，
  只可能把 internal-services 的 1,000 钳低"。若将来确需 `[limits]`，**只加 `cpu_ms`**。
- 代价/风险：纯文档；风险是"下一个人为了省额度顺手加上"。
- 影响计划：Free only（防护性）。

**P0-3 Cron 的 10 ms CPU 硬顶会让清理**静默**停摆（F11 形态回归）**

- 问题：`SUBREQUEST_BUDGET` 只约束**子请求**（`src/cleanup.ts:251-268` 的 `SubrequestBudget`），
  整条链路上**没有任何 CPU 记账**。而 W3 给 Cron 的 CPU 也是 **10 ms**，超限时平台**终止**整个
  调用 —— `runCleanup` 的顶层 catch（`src/cleanup.ts:576` 起的 try/catch）与
  `src/index.ts:301-310` 的 `ctx.waitUntil(...).catch(...)` **都不会执行**，于是：
  `[cleanup] run …` 汇总行（`cleanup.ts:684`）不打印、逐阶段行（`cleanup.ts:658`）可能只打了一部分、
  `cleanup:lastRunAt` 不更新、`cleanup:lastError` 不写 ⇒ UI 的清理可观测面
  （`/ui/api/info` 的 `cleanup` 字段，`src/ui/routes.ts:146`）**停在旧值上，看起来"一切正常"**，
  正是 F11 要消除的形态。
  注意：**数据不会丢**（候选集单调消耗、游标从剩余候选重算，`src/cleanup.ts:217` 的注释解释了
  为什么不能用 OFFSET），但会"每轮都做一点、每轮都白做"且无任何日志。
- 证据：`src/cleanup.ts:32`（只有子请求预算）、`src/index.ts:301-310`（waitUntil + catch）、
  `src/cleanup.ts:665-672`（收尾落库在 CPU 终止时不会执行）、W3、`docs/design.md:470`
  （原文只说"子请求预算与游标"，未提 CPU）。
- 建议改法（**不加配置**）：
  1. **把「轮首心跳」前移**：在 `runCleanup` 一进入就先写一次 `cleanup:lastRunAt`（当前只在
     轮尾写，`src/cleanup.ts:665-672`）。这样即使本轮被 CPU 终止，UI 也能看到"最近一次尝试"在动，
     而不是完全静止。成本：+1 次 D1 子请求（72 次/天，可忽略）。
  2. **按 CPU 而非子请求收紧单轮工作量**：把"每轮最多处理多少条"的判据从纯子请求预算改成
     `min(子请求余量, CPU 余量)`，其中 CPU 余量用**条数**近似（例如"单轮软删 ≤ 100 条、
     单轮硬删 ≤ 200 条"），使一轮的真实 CPU 落在 10 ms 内。取值的标定见 §6 M3。
  3. **明写"Free 上清理是慢收敛"**：把 `docs/design.md` §9/§13 的措辞从"一轮跑不完、下轮续跑"
     改成"**Free 上还可能因 CPU 被平台终止**，此时本轮可能无汇总日志、游标不落库，下一轮重新开始"，
     并给出建议（积压大时升级 Paid，或放宽 Cron 间隔——Cron 数不变，只改 `wrangler.toml:68` 的分钟位）。
- 代价/风险：① 改动集中在 `runCleanup` 的批次上限与一处心跳写，风险低；
  ② 收紧条数会让大积压库的收敛更慢（**这是 Free 的固有代价，不是回归**）。
- 影响计划：**Free（决定性）+ Paid（防"某次 D1 抖动导致整轮无日志"）**。

**P0-4（条件性）`batch-update` / `batch-purge` 在保守 D1 口径下超 50 条语句 ⇒ 半途失败**

- 问题：上限 100 条（`src/ui/routes.ts:596/679`），实际单次调用 D1 语句数为 **≤300 / ≤100**
  （§2.2）。若 D1 页的"50（Free）"成立，则在**中途**超限 ⇒ 前若干条已写库、后若干条未执行，
  响应是 500，前端只知道"失败"，不知道**哪几条生效了**（`routes.ts:645` 的响应契约只有
  `{updated, failed}`，而失败发生在抛错路径上，连这个体都拿不到）。
- 证据：`src/ui/routes.ts:596/679`、`src/ui/query.ts:518`（batch-meta 已按 50 分片，是同一
  约束下的既有做法——**这里应照抄它的思路**）、D1-1（§1.2 的保守口径）。
- 建议改法（**不加配置**）：把单次上限从「条目数」改成「**D1 语句预算**」：
  batch-update 按 3 条/条（读 + 写 + 冲突回读）⇒ **≤15 条**；batch-purge 按 1 D1 + 2 R2/条 ⇒
  **≤22 条**（R2 也是子请求）。前端已按上限分片（`public/ui_v1/js/api.js` 的 `batchUpdate` /
  `batchPurge`），**只需改服务端常量 + 前端常量**。
- 代价/风险：① Free 上大批量操作要多发几轮请求（计入 W1）；② 若真实口径是 1,000，这是**无谓的
  吞吐回退** ⇒ **所以这条必须先做 §6 M2 的口径实测再定**，实测前不要动。
- 影响计划：Free only（若实测证明是 1,000，本项降级为 P2 文档项）。

### P1 —— 浪费（多遍哈希、全桶扫描、无谓往返）

**P1-1 同一份字节 SHA-256 多遍（File/Image 落库）** —— **已在工作区落地**（未提交）：
`src/hash.ts:34`（新原语）、`src/profile.ts:164/199/217/637`（复用）。剩余动作只是**提交时带上
文档同步**（`docs/design.md` §7.1 的 CPU 行；哈希值与 wire 行为逐字节不变，协议侧无需登记）。

**P1-2 每次页面加载都全桶列举 R2（`ListObjects` = Class A）**

- 问题：`storage.totalHistorySize()`（`src/storage.ts:207`）在 `/ui/api/overview`（`routes.ts:828`，
  首屏必经）、`/ui/api/info`（`routes.ts:796`）、`/ui/api/statistics`（`routes.ts:772`，
  每次写操作后都会调）三条路径上各跑一遍；CPU 是 O(N)、R2 是 P 次 Class A。
- 证据：`src/storage.ts:207-217`、`src/ui/routes.ts:89-103`（`deploymentStats` 的唯一调用者）、
  `docs/design.md:634`（风险登记里已承认"`statistics.totalFileSizeMB` 每次全桶列举 R2"，
  缓解写的是"十万对象级再考虑落 Meta 缓存"）。
- 建议改法：**把字节总数落到 Meta**（键如 `stats:historyBytes`），由 Cron 每轮在孤儿阶段之后
  顺带更新（它**本来就**已经列举了 `history/` 的全部对象：`historyGroups`，
  `src/cleanup.ts:343-348`，且已经按实际页数记账）；读侧改为读 Meta（1 次 D1），
  Meta 缺失时回落现行为。
- 代价/风险：① 数字有 ≤20 分钟的陈旧窗口（要在 UI 上写明"截至最近一次清理"）；
  ② Cron 的 CPU 预算要 +O(N) 的累加（**但列举本来就在做，只是多一个 `+= obj.size`**）。
- 影响计划：**Free + Paid 都受益**（R2 Class A 与 CPU 双降）。

**P1-3 `/ui/api/overview` 一次调用打三条全表聚合**

- 问题：`db.statistics`（`db.ts:418`，一条聚合）+ `countByTypeViews`（`query.ts:339`，
  一条 `GROUP BY`）+ `readChangeMarker`（`query.ts:375`，一条 `COUNT(*) + MAX()`）= **3 条全表扫描**，
  加上 `readRetentionSettings`（`cleanup.ts:182`）与 `getMetaValues`（`db.ts:613`）共 **5 条 D1**。
- 证据：`src/ui/routes.ts:828-850`、`src/ui/query.ts:339/375`、`src/db.ts:418`。
- 建议改法：把三条全表聚合并成**一条** `SELECT Type, IsDeleted, Stared, COUNT(*) … GROUP BY Type, IsDeleted, Stared`
  （`countByTypeViews` 已经在跑这条，`total`/`active`/`deleted`/`starred` 都能从同一结果集算出），
  `MAX(LastModified)` 用一条轻量查询或从同一结果集另取。
- 代价/风险：`db.statistics` 是**协议端点** `/api/history/statistics` 也在用的公共实现
  （`src/routes/history.ts:285`）⇒ 要么给 UI 单开一条，要么一起换（注意别动协议语义）。
- 影响计划：Free + Paid。

**P1-4 `GET /file/{name}` 的无界 R2 扇出（1+C 次子请求）**

- 问题：每条候选一次 `getHistory`（`src/routes/webdav.ts:157-161`），C 无上限 ⇒ 极端数据下
  超 W6 的 1,000。
- 证据：`src/db.ts:323-341`（返回全部候选）、`src/routes/webdav.ts:149-165`。
- 建议改法：给候选循环加一个**常数上限**（例如 32）并在超限时按上游语义返回 404（上游
  `GetRecentTransferFile` 也是"逐条 `File.Exists` 直到命中"，条数同样无界，但上游跑在文件系统上、
  没有子请求配额）。**不加配置**：上限写成模块常量，注释写明依据是 W6。
- 代价/风险：极小（正常库同名候选 ≤ 数条）。行为上属"有意偏离"⇒ 需在 `docs/protocol.md` §10 登记。
- 影响计划：Free（防 1,000 触顶）+ Paid（无影响）。

**P1-5 列表每行 `JSON.parse(FilePaths)`**

- 问题：`rowToEntity` 对**每一行**解析 `FilePaths`（`src/db.ts:57-62`），而列表页只需要
  `hasData` 这一个布尔（`entityToDto` 的判据是 `filePaths.length > 0 || transferDataFile !== ''`，
  `src/serialization.ts:318`）。`pageSize=500` 时是 500 次小 parse。
- 证据：`src/db.ts:57-62`、`src/ui/query.ts:321`（列表 SQL 已刻意不拉整列 Text，却没顺手
  把 `FilePaths` 换成 `(FilePaths != '[]') AS HasData`）、`src/serialization.ts:307/318`。
- 建议改法：列表 SQL 里改选 `(FilePaths <> '[]') AS HasData`，`toItem` 走一条不解析 JSON 的映射。
- 代价/风险：需保证与 `entityToDto` 的判据逐位等价（含 `TransferDataFile != ''` 那一半）。
- 影响计划：Free + Paid。

**P1-6（可选）Group 解压路径的拷贝与峰值内存**：`concatChunks`（`src/hash.ts:299`）为每个条目
多复制一份，配合 fflate 的缓冲翻倍使峰值 ≈ `body + 2×解压`（`docs/design.md` 的 D17 行、
`src/hash.ts:108-117` 的注释）。改用 `node:crypto` 增量哈希可省掉这一份，**CPU 量级不变**
（inflate 仍是支配项），但直接改善 W4（128 MB，Free=Paid）。列在 P1 是因为它同时是 P0-1 的
"为什么大 zip 必然失败"的内存侧注解。

### P2 —— 文档 / 默认值调参

**P2-1 `MAX_REQUEST_BODY_BYTES = 48 MiB` 在 Free 上的合理性**：默认值是 Paid 口径（内存维度），
在 Free 上受 CPU 约束实际只有 3–10 MiB 量级（§3.1）。**建议只改文档**（`docs/design.md` §7.1 的表格
加一行"Free 上的有效上限（CPU 约束）"、`README` 容量章节同），**不建议改默认值** ——
48 MiB 是 isolate 内存预算的结论（ADR D17，`docs/design.md:57`），与计划无关，改它会在 Paid 上
造成功能回退。

**P2-2 `GET /SyncClipboard.json` 的三重序列化往返** —— **已在工作区落地**（未提交）：
`src/routes/webdav.ts:94/109` 改为直接以 `profileDtoToJson(...)` 的字面量为 body（`content-type`
逐字照抄 Hono `c.json` 的 `application/json`）。剩余动作只是提交时带上文档同步（本项不进
`docs/protocol.md` §10——响应体与头逐字节不变）。

**P2-3 `docs/design.md` §13 风险表的 Free 行**：现在只写"Free 计划的清理硬顶（约 50 条 D1 语句 /
10ms CPU 每次 Cron）"，其中"约 50 条 D1 语句"来自本文 §1.2 里**不采信**的那个口径 ⇒
建议改为"Free：单次调用 1,000 次 Cloudflare 服务子请求（`[limits] subrequests` 不要设置）
+ 10 ms CPU（**这是真正的硬顶**）"。

**P2-4 本轮审计文档自身的同步义务（留给分支工作者）**：按 `AGENTS.md` §1 的表，
`docs/` 下新增文件要同步 `README.md` 的文档清单与 `docs/design.md` §4 的目录树。
本审计**按硬约束不改任何已有文件**，这两处同步（以及 `test/docs.test.ts` 是否因此变红）
交由统一提交者处理。

---

## §6 无法静态判定的部分（必须实测才能定论）

| # | 待定项 | 为什么静态定不了 | 可复现的测量办法 |
|---|---|---|---|
| M1 | 各路径的**真实 CPU 时间** | 文档只给上限；SHA-256/inflate 的实际吞吐、`crypto.subtle` 的 CPU 归属（原生实现是否全额计入）都无官方数字 | 部署到一个 **Free 账号**（CPU 档位只有 Free 才准），`[observability] enabled` 已开（`wrangler.toml:77-78`）⇒ 每次调用的 `cpuTime` 可在 Workers Logs 里按 Worker/时间查询；或 `wrangler tail --format json`。**标定阶梯**：`PUT /file/{name}` + `PUT /SyncClipboard.json`，body 取 64 KiB / 256 KiB / 1 MiB / 4 MiB / 16 MiB，记录每档的 `cpuTime` 与是否 `exceededCpu` ⇒ 得到 Free 的有效上传上限（P0-1 的标定） |
| M2 | **D1 语句/子请求的真实上限**（50 还是 1,000） | §1.2 的官方冲突未被澄清；changelog 与 D1 页各说一半 | **无需改代码**：在 Free 实例上对 `POST /ui/api/history/batch-update` 做**二分**：items 取 20 / 30 / 40 / 50 / 60 / 100 条（每条 ≈2 条 D1），观察哪一档开始报错及错误文案。若 100 条通过 ⇒ 采信 1,000；若在 ~25 条附近失败 ⇒ 采信 50。同一探针顺带记录 `wrangler tail` 里的错误串（区分 "Too many subrequests" 与 D1 的 `D1_ERROR`） |
| M3 | **Cron 单轮的真实 CPU 与是否被终止** | 依赖库规模与积压量，且平台终止**不留日志**（P0-3） | ① 先确认观测面：正常一轮会在 Workers Logs 里留 ≤4 行 `[cleanup] phase=…`（`src/cleanup.ts:658`）+ 1 行 `[cleanup] run …`（`:684`）；② 在 Free 上等自然 Cron，然后查 `cleanup:lastRunAt` 是否推进 + Workers Logs 里有没有 `exceededCpu`；③ 需要可控复现时，在**本地**用 DevTools CPU profiler 测相对占比，再按 Free 的 10 ms 折算（本地 dev 不代表 Free 的 CPU 档，只能给相对比例） |
| M4 | `env.ASSETS.fetch(request)`（`src/index.ts:265`）**是否计入**子请求与 100k/天请求额度 | 官方文档未单独说明静态资源 binding 的计费口径；pricing 页只说"Requests to static assets are free and unlimited"（指**入站**到资源的请求） | 在 Free 实例上加载一次 `/ui_v1/`（34 个资源请求），用 Workers Logs / GraphQL Analytics 看这 34 次调用的 `subrequests` 计数是否为 0 |
| M5 | Cron 调用**是否计入** 100k/天请求额度 | pricing 页的 Requests 行写的是"Inbound requests to your Worker"，未明确覆盖 scheduled | 同上：跑一天后看 dashboard 的 Requests 曲线是否含 72 次 Cron |
| M6 | DO duration 的真实日消耗（是否真为 85%） | 依赖"WS 是否全天保持"与平台是否真的不给非 Hibernation 的 WS 休眠 | Free 账号的 DO 指标（Requests / Duration / Rows）看一天；或观察 WS 是否被反复重连（重连会体现在 DO 请求数上） |
| M7 | R2 Class A/B 的真实计数 | 依赖对象数与页面加载次数 | dashboard → R2 → Metrics（Class A/B 分列）；重点是确认 `ListObjects` 是否真的按 Class A 计（R2-2 已明确列出，仍建议实测一次） |
| M8 | multipart 边界扫描在 48 MiB 档的真实耗时 | 仓库只记录过旧实现的 64 KB 档读数（`src/multipart.ts:27`），现实现（`indexOf` 首字节）在 MB 级未测 | 同 M1 的阶梯探针，但 body 用 `POST /api/history` 的 multipart 形态，分界串分别取 8 / 70 字节两档 |
| M9 | 官方客户端 10 s / 2 请求的口径是否仍成立 | `README.md:248` 是本仓库的观察，不是上游文档；上游改版会让 §4.1 的 5 台结论漂移 | 抓一次真实客户端的请求日志（服务端侧看 Workers Logs 的请求间隔即可，无需改代码） |

### 6.1 实测回填（2026-09-25，账户实测）

> 取数时间 2026-09-25 07:19–07:31 UTC；数据源 = Cloudflare GraphQL Analytics + D1 只读 SELECT +
> R2 只读列举（查询原文与权限边界见 [`docs/free-plan-account-facts.md`](free-plan-account-facts.md) §4）。
> **本节是实测**，与 §3 的静态推断并列；**两者冲突处以本节为准**。

| 项 | 对应待测项 | 实测值 |
|---|---|---|
| HTTP 单次 CPU 分位（7 天 = 30 天，79,745 次 success） | M1 | p50 **0.709 ms** / p99 **6.893 ms** / p999 **14.987 ms** |
| HTTP **单次峰值**（按小时分组的 P999） | M1 | **633 ms**（09-24T15:00Z）/ **712 ms**（09-24T16:00Z），两次都 `err=0` |
| 大请求体是否成功过 | M1 | **成功**：15.5 MiB zip（R2 对象 16,247,298 B）、D1 `Size` 20.36 MiB 的 Group 记录 |
| 资源超限次数（`exceededResources`，涵盖 exceededCpu/exceededMemory） | M1 / M3 | 本 Worker **0**；**账号级 0**（11 个 Worker、约 10.7 万次请求） |
| Cron 单轮 CPU 与是否被终止 | **M3** | 264 次调用**全部 success**；min 3.195 ms / avg **7.461 ms** / max **19.546 ms** ⇒ **未被终止** |
| DO duration 的真实日消耗 | **M6** | SyncClipboardHub **11,014.3 / 11,103.0 / 10,970.5 GB-s/天**；账号合计峰值 **11,121.1 = 13,000 的 85.5%** ⇒ §4.4 的「约 85%」**推算被实测确认** |
| DO 请求数 | M6 | 峰值 **6,685/天**（09-22：alarm 5,783 + http 902），Free 额度 100,000/天 |
| R2 Class A/B 的真实计数 | **M7** | 5 天 **Class A = 2,354**（PutObject 686 + ListObjects 1,667 + PutBucket 1）、**Class B = 1,578**（GetObject 1,452 + HeadBucket 126）；另 DeleteObjects 619 次按官方定价表不计 A/B（单日最大 09-21：ListObjects 1260 / PutObject 662 / GetObject 1293） |
| D1 行读 / 行写日用量 | — | 峰值 行读 **675,016/天**（额度 5,000,000）、行写 **19,826/天**（额度 100,000）；库 290,816 B |
| 逐日请求量 | M9 | 单 Worker 峰值 **24,212/天**（09-22）⇒ §4.1 的「5 台」应改为约 **4 台**（17,280/台 的估算偏乐观约 25%）；账号级峰值 28,028/天 |

**由实测得出的三条口径修正**（已同步进 `README.md` 与 `docs/design.md` 的 D40/§7.1/§9/§13）：

1. **10 ms 是平均预算，不是单次硬顶** —— 平台对偶发越界有 rollover CPU time（633/712 ms 成功即为证）。
2. **不要调小 `MAX_REQUEST_BODY_BYTES`** —— 本账号已成功承载 15.5 MiB 请求体，调到 2 MiB 只会拒掉真实同步。
3. **账户计划本身仍未判定**（缺 `billing:read`）；但上面这些实测与「是 Free 还是 Paid」无关 ——
   见 [`docs/free-plan-account-facts.md`](free-plan-account-facts.md) §2.4 的两难论证。

**仍未测的**：M2（D1 语句/子请求的真实上限 50 还是 1,000）、M4（`ASSETS.fetch` 是否计子请求与请求额度）、
M5（Cron 是否计入 100k/天）、M8（multipart 边界扫描在 48 MiB 档的耗时）—— 这四项本轮**未取数**。

---

## 附：本次审计的证据边界

- **已实读**（工作区）：`AGENTS.md`、`README.md`（容量章节）、`wrangler.toml`、`package.json`、
  `docs/design.md`、`docs/backend-gaps.md`、`src/**` 全部相关模块
  （`index/auth/rateLimit/requestLimits/cleanup/storage/db/profile/historyOps/hash/multipart/hub/
  serialization/contentTypes/webdavXml/stores/routes/*/ui/*/durable/*`）、
  `public/ui_v1/index.html`、`public/ui_v1/js/{main,api}.js`、`public/_headers`、
  `node_modules/mrmime/index.mjs`（确认是静态字面量）。
- **已读官方文档**：Workers limits、D1 limits、R2 limits、DO limits、Workers pricing、R2 pricing、
  Wrangler configuration、2026-02-11 subrequests changelog（URL 与 last updated 见 §1.1）。
- **未做**：没有跑任何门禁（tsc / eslint / vitest）、没有起 dev server、没有部署到 Free 账号、
  没有对任何端点做真实计时 ⇒ **§3 的所有 CPU 结论都是"遍数 × 吞吐假设"的推断**，
  凡标"必然"的都是"在乐观吞吐假设下仍然超"的保守结论；真实数值一律归入 §6 待测。
- **未修改任何已有文件**；本文件为新增，未提交。
- **并行改动提示**：审计过程中 `src/hash.ts` / `src/profile.ts` / `src/routes/webdav.ts` 被另一
  工作者修改（工作区 `M`，未提交），分别对应本文 P1-1 与 P2-2。本文 §2.1、§3.1、§3.2 已按改动后
  重算；提交时请连同 P0-1 建议 2、P0-3 建议 3 的文档一起（`docs/design.md` §7.1/§9/§13）。
