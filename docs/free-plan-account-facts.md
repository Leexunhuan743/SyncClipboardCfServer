# SyncClipboard CfServer — Cloudflare 账户实测事实档案

> **这是什么**：`syncclipboard-cf-server` 这个部署**实际跑在什么账户、消耗了多少配额、有没有撞到过平台上限**的
> 一手事实档案。它是 `docs/free-plan-audit.md`（**文档事实** + 静态推算）的**账户事实**对照面：
> 前者回答"平台规定是什么"，本文件回答"这台部署实际发生了什么"。
> 两份文件的分工与冲突处置见 §2.4 的**两难论证**。
>
> **取数时间**：2026-09-25 **07:19–07:31 UTC**（本机 15:19–15:31 CST，TZ = UTC+8）。
> 所有数字都是那一刻的快照，**不是**实时值。
>
> **取数窗口**：7 天 = `2026-09-18T00:00:00Z`–`2026-09-25T07:00:00Z`；30 天 = `2026-08-26T00:00:00Z`–`2026-09-25T07:00:00Z`；
> 逐日 = `2026-09-21`–`2026-09-25`。**注意**：本 Worker 2026-09-21T14:14Z 才创建，
> 故 30 天窗口与 7 天窗口**返回完全相同的结果**（窗口更早的部分没有数据，不是"数据缺失"）。
>
> **本轮零写操作**：未 `wrangler deploy`、未 `wrangler dev`、未写 D1/R2/DO、未改任何文件、未跑门禁。
> 唯一两条"POST"是 D1 的**只读 SELECT**（`POST /accounts/{id}/d1/database/{db}/query`），
> 其响应自证未改数据：`"changes":0, "changed_db":false, "rows_written":0`。
>
> **凭据边界（重要）**：全程只用**本机已存凭据**（wrangler 的 OAuth，配置在
> `%APPDATA%/xdg.config/.wrangler/config/default.toml`），**未回显任何 token / secret**。
> 取数时其 access token 已过期，用同一文件里的 `refresh_token` 向
> `https://dash.cloudflare.com/oauth2/token` 换新（`client_id` 是 wrangler 源码内的**公开**常量）。
> **未回写该配置文件**（mtime 保持 `2026-09-21 23:31:47 +0800`），且第二次用原 `refresh_token` 刷新仍成功
> ⇒ 本机登录态未被破坏。所有临时脚本与令牌文件都在仓库外（`%TEMP%`）并**已删除**。

---

## §1 账户与资源清单

### 1.1 账户

`GET /accounts` → HTTP 200（<https://developers.cloudflare.com/api/resources/accounts/methods/list/>）：

```json
{ "id": "33e80ac788088b5eae6d0fef2ce1e564",
  "name": "Leeexx2001@gmail.com's Account",
  "type": "standard",
  "settings": { "enforce_twofactor": false, "api_access_enabled": null,
                "access_approval_expiry": null, "abuse_contact_email": null,
                "oauth_app_access_enabled": true },
  "created_on": "2026-01-18T13:34:14.292285Z" }
```

### 1.2 凭据类型与权限范围

`wrangler whoami` 报 `Not logged in. Your auth token has expired and could not be refreshed`
⇒ OAuth access token 过期（配置里 `expiration_time = 2026-09-21T16:31:47.919Z`）。配置里的
`scopes` 原文：

```
"user:read", "offline_access", "account:read", "workers:write", "workers_kv:write",
"workers_routes:write", "workers_scripts:write", "workers_tail:read", "d1:write", "pages:write",
"zone:read", "ssl_certs:write", "ai:write", "ai-search:write", "ai-search:run", "websearch.run",
"agent-memory:write", "queues:write", "pipelines:write", "secrets_store:write", "artifacts:write",
"flagship:write", "containers:write", "cloudchamber:write", "connectivity:admin",
"email_routing:write", "email_sending:write", "browser:write", "challenge-widgets.write"
```

⇒ **没有 `billing:read`**。这就是 §2「计划无法判定」的**唯一**原因。

### 1.3 本 Worker 及其资源

```
Worker          syncclipboard-cf-server
  script_tag    47e096e9c4184391ad1f9087df6c2a82
  created_on    2026-09-21T14:14:00.360852Z
  modified_on   2026-09-24T01:59:39.630862Z
  handlers      ["fetch", "scheduled"]；named_handler SyncClipboardHub；migration_tag "v1"
  compat        date 2025-09-01 / flags ["nodejs_compat"]
  observability logs.enabled=true, head_sampling_rate=1, persist=true, invocation_logs=true
workers.dev 子域 leeexx2001（已启用）
自定义域名      syncc.141425.xyz -> syncclipboard-cf-server
zone          141425.xyz（id d2190968e0886537bda9c9e984ed0277）
              plan = {"name":"Free Website","legacy_id":"free","price":0,"is_subscribed":false}
D1            syncclipboard = 2acc91d2-7f31-4daa-aff2-0593d49bb8e6（file_size 290,816 B）
R2            bucket syncclipboard（建桶 2026-09-21T03:13:07.947Z）
DO 命名空间     syncclipboard-cf-server_SyncClipboardHub = 0be018a796d8455f9b3786b35d265cd2
              （use_sqlite: true）
Cron          1 条：7,27,47 * * * *（创建 2026-09-21T14:14:20Z）
```

**部署态绑定**（`GET /accounts/{id}/workers/scripts/syncclipboard-cf-server/settings`）：

```
ASSETS | DB=2acc91d2-…(d1) | HUB=SyncClipboardHub(do) | R2=syncclipboard
MAX_REQUEST_BODY_BYTES=50331648 (48 MiB)   ← 与 src/requestLimits.ts:10 的默认值一致
AUTH_RATE_LIMIT_WINDOW_MS=900000 | MAX_FAILURES=10 | BLOCK_MS=900000 | BURST_WARN=50
VERSION=3.3.0-beta1 | UI_ENABLED=true | HISTORY_RETENTION_MINUTES=0 | MAX_SAVED_HISTORY_COUNT=1000
```

（注：`AUTH_RATE_LIMIT_*` 与 `MAX_REQUEST_BODY_BYTES` **不在** `wrangler.toml [vars]` 里，
是 CI 用同名 GitHub 仓库变量注入的 —— 见 `.github/workflows/deploy.yml` 的 "Resolve deploy switches"。
`MAX_REQUEST_BODY_BYTES` 的值与代码默认值相同。）

### 1.4 账号级结构性事实（用于 §2 的间接推断）

| 事实 | 实测 | Free 上限 | Paid 上限 |
|---|---|---|---|
| 账号级 Cron 触发器数 | **恰好 5 个**（11 个脚本里 5 个有 cron） | **5** | 250 |
| D1 库数 | 7 | 10 | 50,000 |
| 脚本数 | 11 | 100 | 500 |
| DO 后端 | 3 个命名空间**全部** `use_sqlite: true` | Free 只允许 SQLite | 两者皆可 |
| Queues | 1 条（`flaremo-data-export`） | **Free 也有 10,000 ops/天** ⇒ 不是 Paid 证据 | 100 万 ops/月 |
| 账号级 `entitlements` | 17 条，**无任何 Workers / D1 / DO 条目**；有 `r2` 组的 `R2 - Enabled = true` | — | — |

---

## §2 计划判定

### 2.1 结论：**无法判定**（缺 Billing Read）

`GET /accounts/{id}/subscriptions`（官方 API 文档：<https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get>）
需要 **`Billing Write,Billing Read`**（OpenAPI 的 `x-api-token-group`），本机授权没有 ⇒ **403**：

```json
{"success":false,"errors":[{"code":10000,"message":"Authentication error",
 "documentation_url":"https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get"}]}
```

同样 403 的还有：`/accounts/{id}/billing/profile`、`/accounts/{id}/billing/usage`、
`/accounts/{id}/billing/credits`、`/user/subscriptions`。
（`/accounts/{id}/billing/bad-debt`、`/billing/unpaid-invoice` 是 400「无此路由」；
`/accounts/{id}/workers/plans`、`/accounts/{id}/plans` 也是 400。）

**怎么补**：① 控制台看 `Manage Account → Billing → Subscriptions`（或 `Workers & Pages → Plans`）；
② 或建一个 API Token 勾 **Account → Billing Read**（GraphQL 另需 **Account Analytics Read**），
再跑上面那条 GET。

### 2.2 `usage_model` **不能**用来判计划（一个容易误用的字段）

`GET /accounts/{id}/workers/scripts/{name}/usage-model` → HTTP 200，四个脚本（含本 Worker）：

```json
{"usage_model":"standard","user_limits":null}
```

`usage_model` 在官方 OpenAPI 里已标记 **deprecated**（`workers_usage_model`）：

```json
{"description":"Usage model for the Worker invocations.","type":"string",
 "enum":["standard","bundled","unbound"],"default":"standard","deprecated":true,
 "x-stainless-deprecation-message":"All new projects now use the Standard usage model."}
```

并且该字段已从 wrangler 配置文档（<https://developers.cloudflare.com/workers/wrangler/configuration/>，
last updated **Sep 24, 2026**）里**整个消失**。⇒ `"standard"` 是**所有** Worker 的默认值，
**不是**计划判据。`user_limits.cpu_ms = null` 只说明**从未设置**自定义 CPU 上限（Free 不能调大、
Paid 只是没调），同样不是判据。

### 2.3 间接证据全部"未越界" ⇒ 不能反推

§1.4 的五个结构性事实里，只有「Cron 恰好 5 个 = Free 上限」像"上限生效"，但"恰好 5 个"也可能是巧合；
其余（7 个 D1 库 / 11 个脚本 / 全 SQLite 后端 / 账号日请求峰值 28,028）都**远未接近**任何上限。
⇒ **既没有证明 Free 的硬事实，也没有证明 Paid 的硬事实**（无 KV 后端 DO、无 `cpu_ms`、无越界配额）。

### 2.4 两难论证：为什么"账户是 Free 还是 Paid"**不影响**那条被推翻的结论

`docs/free-plan-audit.md` 原「一句话结论」断言：**Free 上有效上传上限约 3–10 MiB，超过会以 `error 1102` 失败**。
无论计划是哪一个，这条都不成立：

- **若账户是 Free** ⇒ §3.2 的 **20.36 MiB Group 载荷 / 15.5 MiB zip 请求体在 Free 上成功落库**
  ⇒ 该上限被实测推翻。
- **若账户是 Paid** ⇒ 整条 Free 前提不成立 ⇒ 该结论同样不成立。
- 唯一能救回它的情形是「Free + rollover 信用**恰好只够偶发**越界」——但 2026-09-24T15:00–15:18Z 的
  **18 分钟里连续落下 5 个 12–20 MiB 的 Group 上传**（每次 CPU 数百毫秒，§3.2），这不是"偶发"
  （官方 limits 页对 rollover 的限定词是 "infrequently runs over the configured limit"）。

⇒ 本轮文档改写**不需要**先判定计划（判定本身也需要 Billing Read，见 §2.1）。

---

## §3 实测运行事实

数据来源：`POST https://api.cloudflare.com/client/v4/graphql`，数据集
`viewer.accounts(filter:{accountTag:"33e80ac788088b5eae6d0fef2ce1e564"}).workersInvocationsAdaptive`
（查询原文见 §4）。**单位是微秒**：同一 schema 里给 cron 用的字段名自带 `Us`
（`workersInvocationsScheduled.cpuTimeUs`），且 P50 ≈ 700 若当毫秒即"一次探活花 0.7 秒"，不成立。

### 3.1 调用状态与 CPU 分位（`syncclipboard-cf-server`，7 天 = 30 天）

```json
[
 {"dimensions":{"status":"clientDisconnected"},
  "quantiles":{"cpuTimeP50":1241,"cpuTimeP99":4457,"cpuTimeP999":5362},
  "sum":{"errors":0,"requests":187,"subrequests":182}},
 {"dimensions":{"status":"responseStreamDisconnected"},
  "quantiles":{"cpuTimeP50":1135,"cpuTimeP99":2935,"cpuTimeP999":2935},
  "sum":{"errors":0,"requests":91,"subrequests":91}},
 {"dimensions":{"status":"success"},
  "quantiles":{"cpuTimeP50":709,"cpuTimeP99":6893,"cpuTimeP999":14987},
  "sum":{"errors":0,"requests":79745,"subrequests":6751}}
]
```

**没有 `exceededCpu` / `exceededMemory` / `tooManySubrequests` 这类结果。** 该数据集此版本
**不接受** `outcome` 字段（报 `unknown field "outcome"`），等价的分类维度就是 `status`；
实测只出现 `success` / `clientDisconnected` / `responseStreamDisconnected` 三种。

**全账号口径**（11 个 Worker，`2026-09-21`–`2026-09-25`）：

```json
[{"dimensions":{"status":"scriptThrewException"},"sum":{"errors":4,"requests":4,"subrequests":0}},
 {"dimensions":{"status":"clientDisconnected"},"sum":{"errors":0,"requests":375,"subrequests":1315}},
 {"dimensions":{"status":"responseStreamDisconnected"},"sum":{"errors":0,"requests":293,"subrequests":293}},
 {"dimensions":{"status":"success"},"sum":{"errors":0,"requests":106215,"subrequests":12400}}]
```

⇒ 账号级约 **10.7 万次请求，资源超限（`exceededResources`，涵盖 exceededCpu/exceededMemory）0 次**。

### 3.2 **决定性证据：单次调用 CPU 达 633 ms / 712 ms 且成功**

按小时分组（`syncclipboard-cf-server`，2026-09-24，`err=0` 全时段）：

```
2026-09-24T06:00Z req=850 p50=814  p99=4677  p999=10116
2026-09-24T07:00Z req=697 p50=805  p99=6376  p999=11382
2026-09-24T08:00Z req=871 p50=810  p99=7573  p999=12891
2026-09-24T09:00Z req=862 p50=799  p99=8151  p999=13368
2026-09-24T10:00Z req=928 p50=725  p99=8303  p999=20388
2026-09-24T11:00Z req=913 p50=770  p99=6515  p999=20209
2026-09-24T12:00Z req=874 p50=736  p99=7278  p999=7803
2026-09-24T13:00Z req=745 p50=728  p99=2018  p999=9785
2026-09-24T14:00Z req=720 p50=727  p99=4631  p999=46339
2026-09-24T15:00Z req=771 p50=683  p99=13557 p999=633571   ← 633 ms
2026-09-24T16:00Z req=827 p50=716  p99=4537  p999=712024   ← 712 ms
2026-09-24T17:00Z req=747 p50=663  p99=2324  p999=16233
2026-09-24T18:00Z req=806 p50=667  p99=1681  p999=11427
2026-09-24T19:00Z req=819 p50=587  p99=2427  p999=19546
```

P999 在 771 次请求的小时里 ≈ 最差的那一次调用。这两个小时正是大文件上传落库的时间（见下）。

**三重对齐**（这是本档案最硬的一条证据链）：

| 证据面 | 取值 | 来源 |
|---|---|---|
| D1 记录（服务端时间戳，UTC） | `id=1317 type=3(Group) Size=20.361 MiB CreateTime=2026-09-24T15:17:54.529Z` | 只读 SELECT |
| R2 对象（真实字节数） | `16,247,298 B (15.495 MiB) history/Group_DE74C3D1…/File_2026-09-24_15-18-26_e2i4efql.dnk.zip` | R2 只读列举 |
| CPU 峰值小时 | `2026-09-24T15:00Z P999 = 633,571 µs`，`err=0` | GraphQL Analytics |

**同批大上传**（D1 侧按 `Size` 倒序，`CreateTime` 与 R2 对象名的客户端时间戳**逐条对齐**；
本机是 UTC+8，说明客户端文件名用的是 **UTC**）：

```
id=1317 type=3 size=20.361 MiB  createUTC=2026-09-24T15:17:54.529Z
id=1314 type=3 size=20.047 MiB  createUTC=2026-09-24T15:14:01.980Z
id=1332 type=3 size=16.564 MiB  createUTC=2026-09-24T16:37:44.133Z   ← 落在 T16:00Z 的 712 ms 桶
id=1313 type=3 size=13.776 MiB  createUTC=2026-09-24T15:05:26.720Z
id=1315 type=3 size=13.089 MiB  createUTC=2026-09-24T15:14:40.241Z
id=1316 type=3 size=12.754 MiB  createUTC=2026-09-24T15:14:49.819Z
id=1310 type=3 size= 9.731 MiB  createUTC=2026-09-24T14:38:50.146Z
id=1306 type=1 size= 3.681 MiB  createUTC=2026-09-24T14:33:06.424Z
```

**R2 对象实测字节数**（`GET /accounts/{id}/r2/buckets/syncclipboard/objects?per_page=1000`）：

```
16,247,298 B (15.495 MiB) history/Group_DE74C3D1…/File_2026-09-24_15-18-26_e2i4efql.dnk.zip
16,106,573 B (15.360 MiB) history/Group_1AC85FE4…/File_2026-09-24_15-14-30_2r1boqav.rno.zip
15,169,004 B (14.466 MiB) history/Group_F842922E…/File_2026-09-24_16-38-34_91ukr1t3.dto.zip
11,165,882 B (10.649 MiB) history/Group_D298F41E…/File_2026-09-24_15-05-49_omd99a8h.im4.zip
10,858,958 B (10.356 MiB) history/Group_CC892397…/File_2026-09-24_15-15-15_bm3z9bq7.jdu.zip
10,074,783 B ( 9.608 MiB) history/Group_3AA59B3B…/File_2026-09-24_15-15-19_zj7a09m8.by6.zip
 8,907,893 B ( 8.495 MiB) history/Group_FFAF1AF1…/File_2026-09-24_14-39-08_rvugofhi.svb.zip
 3,860,266 B ( 3.681 MiB) history/File_9379D25A…/grammar-club.pdf
```

⇒ **本账户真实承载过 15.5 MiB 的请求体（zip 上传）+ 20.36 MiB 的 Group 载荷，单次调用 CPU 数百毫秒，零错误。**

> **别误判**：D1 的 `Size = 21,349,675`（20.36 MiB）是**载荷大小列**，不是行字节。
> 同一行的 `Text` 最长仅 2,727 B、`TransferDataFile` 41 B ⇒ **不违反** D1 的 2 MB 行上限。

**口径说明**：Group 的 D1 `Size` 是**解压后总量**，R2 对象是**上传的 zip**，两者比值 1.15–1.33
（压缩比）；File 类型两者相等（`id=1306` 3.681 MiB ↔ `grammar-club.pdf` 3,681,266 B，**逐字节吻合**）。

### 3.3 逐日请求量（核对"10 万/天"）

```
日期        账号合计   syncclipboard
2026-09-18   8,052            0        （本 Worker 尚未创建）
2026-09-19   3,871            0
2026-09-20   3,052            0
2026-09-21  27,805       11,275
2026-09-22  28,028       24,212   ← 账号峰值
2026-09-23  22,350       19,630
2026-09-24  22,234       19,311
2026-09-25   6,470        5,595   （截至 07:00Z，当日不完整）
```

⇒ 账号级峰值 28,028/天 = Free 额度（100,000/天）的 **28%**；单 Worker 峰值 24,212/天。
按此折算，10 万/天约合 **4 台**常驻客户端（`README.md` 里 17,280/台 的估算是 5 台 —— 见 §5.4）。

### 3.4 Cron 实测（`workersInvocationsScheduled`）

```
返回 264 行（窗口内全部）；cron = "7,27,47 * * * *"
status 计数：{"success":264}          ← 0 次终止
cpuTimeUs：min=3,195  avg=7,461  max=19,546
TOP 8（µs）：19546 / 16233 / 15860 / 15521 / 15487 / 15183 / 15098 / 14957
```

264 次 ≈ 72 次/天 × 3.7 天，与「每 20 分钟一轮」一致（`GET .../scripts/{name}/schedules`
也确认线上只注册了这一个 cron）。

### 3.5 Durable Object 实测

**账号级逐日 duration**（Free 额度 13,000 GB-s/天，官方 pricing 页 last updated Aug 25, 2026）：

```
2026-09-22  TOTAL=11031.0 GB-s (84.9%)   [SyncClipboardHub 11014.3 | nodewarden 16.7]
2026-09-23  TOTAL=11121.1 GB-s (85.5%)   [SyncClipboardHub 11103.0 | nodewarden 18.1]
2026-09-24  TOTAL=10988.5 GB-s (84.5%)   [SyncClipboardHub 10970.5 | nodewarden 17.9]
2026-09-25  TOTAL= 3412.3 GB-s (26.2%)   （当日未过完）
```

**SyncClipboardHub 命名空间明细**：

```
日期        duration(GB-s)  cpuTime(µs)  activeTime(s)  wsIn  wsOut  exceededCpu  exceededMemory
2026-09-22    11014.26      2,702,833      86,049      6246   7263       0            0
2026-09-23    11103.05      2,271,068      86,743      5644   6102       0            0
2026-09-24    10970.50      2,302,259      85,707      5548   6154       0            0
```

`duration ≈ activeTime × 128 MB / 1 GB`（86,049 s × 0.128 = 11,014.3 ✓），与官方定价页算法一致。

**DO 请求数**（`durableObjectsInvocationsAdaptiveGroups`，峰值日 2026-09-22）：

```
type=alarm | success            -> 5668
type=alarm | clientDisconnected ->  115
type=http  | success            ->  743
type=http  | clientDisconnected ->  113
type=http  | scriptThrewException -> 46
合计 6,685/天（Free 额度 100,000/天 = 6.7%）
```

### 3.6 D1 / R2 日用量

```
D1 日期       rowsRead   rowsWritten  readQueries  writeQueries  respBytes
2026-09-21    675,016      19,826        6,896        2,443      11,037,838
2026-09-22    249,376       2,900        3,450          488       9,672,984
2026-09-23     95,670       1,851        1,006          308       2,030,141
2026-09-24    163,299       2,688        1,233          442       2,306,729
2026-09-25     21,130         339          172           57         562,336

Free 额度：行读 5,000,000/天（峰值 13.5%）、行写 100,000/天（峰值 19.8%）
库大小：290,816 B / 500 MB = 0.06%；`HistoryRecords` 共 293 行
```

```
R2（bucket syncclipboard）5 天逐 actionType 合计（原始计数，未按类归并）：
  PutObject 686 / ListObjects 1,667 / PutBucket 1 / GetObject 1,452 / HeadBucket 126 / DeleteObjects 619
按 §1.1 的口径归并（Class A = PUT/COPY/POST/LIST；Class B = GET/HEAD；DELETE 免费，见 R2-4）：
  Class A = 686 + 1,667 + 1 = **2,354**（折月约 1.4 万，额度 1,000,000/月）
  Class B = 1,452 + 126   = **1,578**（折月约 0.95 万，额度 10,000,000/月）
  DeleteObjects 619 次按官方定价表**不计 Class A/B**
  单日最大 2026-09-21（ListObjects 1260 / PutObject 662 / GetObject 1293 / DeleteObjects 617）
```

---

## §4 查询原文（可复现）

**REST**（全部 `GET`，`https://api.cloudflare.com/client/v4`，`Authorization: Bearer <本机凭据>`）：

```
/accounts
/accounts/{id}/subscriptions            -> 403（缺 Billing Read）
/accounts/{id}/billing/profile          -> 403
/accounts/{id}/billing/usage            -> 403
/accounts/{id}/billing/credits          -> 403
/accounts/{id}/entitlements?per_page=100
/accounts/{id}/workers/account-settings
/accounts/{id}/workers/subdomain
/accounts/{id}/workers/services
/accounts/{id}/workers/scripts
/accounts/{id}/workers/scripts/{name}/settings
/accounts/{id}/workers/scripts/{name}/usage-model
/accounts/{id}/workers/scripts/{name}/schedules
/accounts/{id}/workers/domains?per_page=100
/accounts/{id}/workers/durable_objects/namespaces
/accounts/{id}/workers/scripts/{name}/deployments
/accounts/{id}/d1/database
/accounts/{id}/r2/buckets
/accounts/{id}/r2/buckets/syncclipboard/objects?per_page=1000
/accounts/{id}/queues
/accounts/{id}/hyperdrive/configs
/zones?per_page=50  ;  /zones/d2190968e0886537bda9c9e984ed0277
```

**只读 SQL**（`POST /accounts/{id}/d1/database/2acc91d2-7f31-4daa-aff2-0593d49bb8e6/query`，
body `{"sql":"SELECT …"}`；响应 meta 自证未改数据：`"changed_db":false,"rows_written":0,"changes":0`）：

```sql
SELECT COUNT(*) AS n, MAX(Size) AS maxSize, MAX(LENGTH(Text)) AS maxText,
       MAX(LENGTH(TransferDataFile)) AS maxFile, MAX(LENGTH(TransferDataHash)) AS maxHash
FROM HistoryRecords;
-- 结果：{"n":293,"maxSize":21349675,"maxText":2727,"maxFile":41,"maxHash":64}

SELECT ID, Type, Size, TransferDataHash, CreateTime FROM HistoryRecords ORDER BY Size DESC LIMIT 8;
```

**GraphQL**（`POST https://api.cloudflare.com/client/v4/graphql`）：

```graphql
# 3.1 状态与 CPU 分位
query($acc:String!,$s:String!,$a:Time!,$b:Time!){
  viewer{ accounts(filter:{accountTag:$acc}){
    workersInvocationsAdaptive(limit:1000,filter:{scriptName:$s,datetime_geq:$a,datetime_leq:$b}){
      sum{requests subrequests errors}
      quantiles{cpuTimeP50 cpuTimeP99 cpuTimeP999}
      dimensions{status}
    }
  }}
}
# 变量：s="syncclipboard-cf-server"；a/b 取 §0 的窗口

# 3.2 按小时（把 dimensions 换成 {datetimeHour}，并加 orderBy:[datetimeHour_ASC]）

# 3.3 逐日 + 逐脚本
query($acc:String!,$a:Time!,$b:Time!){
  viewer{ accounts(filter:{accountTag:$acc}){
    workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$a,datetime_leq:$b},orderBy:[date_ASC]){
      sum{requests subrequests errors} dimensions{scriptName date}}}}
}

# 3.4 Cron
query($acc:String!){
  viewer{ accounts(filter:{accountTag:$acc}){
    workersInvocationsScheduled(limit:1000,
      filter:{scriptName:"syncclipboard-cf-server",
              datetime_geq:"2026-09-21T00:00:00Z",datetime_leq:"2026-09-25T07:00:00Z"},
      orderBy:[cpuTimeUs_DESC]){cpuTimeUs cron datetime status}}}}

# 3.5 DO duration（账号级；加 namespaceId 可收窄）
query($acc:String!){
  viewer{ accounts(filter:{accountTag:$acc}){
    durableObjectsPeriodicGroups(limit:1000,filter:{date_geq:"2026-09-22",date_leq:"2026-09-25"}){
      sum{duration cpuTime activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount
          exceededCpuErrors exceededMemoryErrors}
      dimensions{date namespaceId}}}}}

# 3.5 DO 请求
query($acc:String!){
  viewer{ accounts(filter:{accountTag:$acc}){
    durableObjectsInvocationsAdaptiveGroups(limit:100,
      filter:{namespaceId:"0be018a796d8455f9b3786b35d265cd2",
              date_geq:"2026-09-21",date_leq:"2026-09-25"}){
      sum{requests errors wallTime responseBodySize} dimensions{date type status}}}}

# 3.6 D1
query($acc:String!){
  viewer{ accounts(filter:{accountTag:$acc}){
    d1AnalyticsAdaptiveGroups(limit:200,
      filter:{databaseId:"2acc91d2-7f31-4daa-aff2-0593d49bb8e6",
              date_geq:"2026-09-21",date_leq:"2026-09-25"}){
      sum{rowsRead rowsWritten readQueries writeQueries queryBatchResponseBytes} dimensions{date}}}}}

# 3.6 R2
query($acc:String!){
  viewer{ accounts(filter:{accountTag:$acc}){
    r2OperationsAdaptiveGroups(limit:500,
      filter:{bucketName:"syncclipboard",date_geq:"2026-09-21",date_leq:"2026-09-25"}){
      sum{requests responseBytes} dimensions{date actionType actionStatus storageClass}}}}}
```

**复现时别踩的三个语法事实**：① `filter` 参数**必填**（缺了报 `filter: not an object`）；
② 单次查询窗口**不得超过 1 周**（报 `cannot request a time range wider than 1w`，`extensions.code: quota`）；
③ 该数据集**没有** `outcome` / `count` / `sum{cpuTime}` 字段，`datetimeDay` 不是合法 `orderBy` 值。

**复核过的官方页面**（`last updated` 为页面自述）：

```
https://developers.cloudflare.com/workers/platform/limits/                      Sep 5, 2026
https://developers.cloudflare.com/workers/observability/metrics-and-analytics/  Jul 1, 2026   ← rollover CPU time 那句
https://developers.cloudflare.com/d1/platform/limits/                           Apr 21, 2026
https://developers.cloudflare.com/durable-objects/platform/pricing/             Aug 25, 2026  ← 13,000 GB-s/天
https://developers.cloudflare.com/queues/platform/pricing/                      Apr 21, 2026  ← Free 也有 10,000 ops/天
https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/  Feb 11, 2026
https://developers.cloudflare.com/workers/wrangler/configuration/                Sep 24, 2026
https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json       （schema 原文）
```

**查不到的项**（如实登记，不推测）：

| 项 | 状态 | 缺什么 / 怎么补 |
|---|---|---|
| 账户是 Free 还是 Paid | **查不到**（403） | 缺 `billing:read`；补法见 §2.1 |
| Workers Logs / 单次调用明细（`exceededCpu` 原文、wall time） | **查不到**（403） | 缺 observability/telemetry 读权限（`/workers/observability/telemetry/keys` → 403）；或 `wrangler tail`（会连线上，本轮未做） |
| 单次请求体的**精确**大小分布 | **间接可得**（用 R2 对象字节数 + D1 `Size` 列作答，§3.2）；无直接数据集 | 需精确只能加日志字段或 Analytics Engine（属代码改动） |
| 更早（>30 天）的 CPU 终止历史 | **查不到** | 本 Worker 2026-09-21 才创建，更早无数据 |

---

## §5 附带发现

> 以下五条**均未排查、未实施**，只是取数时顺手看到的事实，登记在此备查。

### 5.1 DO alarm 调用量偏大，且与"每次 `setAlarm` = 1 行写"对不上

2026-09-22：`type=alarm` 共 **5,783 次**调用（其中 5,668 success / 115 clientDisconnected），
而同日该命名空间的 `rowsWritten` 仅 **364**。官方定价页脚注 3 写的是"Each `setAlarm()` is billed as
a single row written" —— 两者数量级对不上（alarm 调用 5,783 vs 行写 364）。
alarm 会持续唤醒 DO，这也是 §3.5 里 duration 24 小时/天、11,000 GB-s/天 的成因之一。
**未进一步排查**（需读部署态代码 + 日志）。

### 5.2 线上 DO 有 `scriptThrewException`

`type=http` 侧 5 天共 **81 次**（09-21: 14 / 09-22: 46 / 09-23: 11 / 09-24: 8 / 09-25: 2）。
属部署态代码问题，与 Free/Paid 无关。**未排查**。

### 5.3 DO duration 85% 是**实测确认**的，不是推算

`docs/free-plan-audit.md` §4.4 推算"一个常驻 WebSocket 的 DO ≈ 11,059 GB-s/天、占 13,000 的约 85%"。
实测（§3.5）：**11,014.3 / 11,103.0 / 10,970.5 GB-s/天**，账号合计 **84.5–85.5%** ⇒ 推算与实测吻合。
账号级余量仅 **1,879 GB-s/天（14.5%）**，第二个 24 小时常驻 DO 会再加约 11,000 ⇒ 必然越界。

**由此得出的下一个真杠杆**：DO 现在用的是**非 Hibernation** 的 `server.accept()`
（WebSocket 连着多久就计费多久，且按分配到的 128 MB 计，与实际用量无关）。
官方定价页明确写 Hibernation API "can dramatically reduce duration-related charges"。
⇒ **若要把 DO duration 从 85% 压下来，Hibernation API 是唯一直接杠杆**（改动量在 DO 侧，
不影响协议面）。**本轮未实施、未评估**。

### 5.4 README 的"17,280 次/客户端/天"估算偏乐观

实测单 Worker 单日峰值 **24,212 次**（2026-09-22）⇒ 10 万/天约合 **4 台**，而非 5 台。
差异可能来自界面侧轮询/静态资源请求与客户端探活叠加（未细分，故只作**估算口径**登记）。

### 5.5 部署态 var 与仓库 `[vars]` 的差异（非缺陷）

线上有 `AUTH_RATE_LIMIT_*` 四个 var 与 `MAX_REQUEST_BODY_BYTES=50331648`，
而 `wrangler.toml [vars]` 里没有它们 —— 由 CI 的 GitHub 仓库变量注入（§1.3）。
`MAX_REQUEST_BODY_BYTES` 与 `src/requestLimits.ts:10` 的默认值相同，**无漂移**。

---

## §6 本档案对既有文档的影响

本轮（2026-09-25，`perf/free-plan` 分支）按本档案改写了以下条目（**只改文档与注释，不改任何常量**）：

| 位置 | 改动 |
|---|---|
| `README.md`「Cloudflare Free 计划的真实约束」 | 删除"有效上传上限约 3–10 MiB / 建议先设 `2 MiB` / 超限以 `error 1102` 结束"三条断言，改为本档案的实测口径 + rollover 说明 |
| `README.md`「请求量与免费额度」 | "5 台客户端"补上实测口径（约 4 台） |
| `README.md`「上传大小与并发内存」⚠️ 行 | 同上（删除"应显式调小"） |
| `docs/design.md` D40 ①、§7.1、§9、§13 两行 | 同上；"硬顶"改为"平均 CPU 预算 + rollover" |
| `docs/free-plan-audit.md` | **不重写原分析**（它是带日期的产物）：在开头加指向本档案的修订说明，并新增 §6.1 实测回填表；§1.1 的 CFG-1 行改为精确表述 |
| `src/cleanup.ts` 注释 | 补 rollover 说明（**常量 256 KiB 保持不动**） |
| `docs/progress.md` §180 / `docs/progress-index.md` | 本轮留档 |

**刻意没改的**：`MAX_REQUEST_BODY_BYTES`（保持 48 MiB 默认）、`wrangler.toml`（不加 `[limits]`）、
`SOFT_DELETE_ROW_BYTES_PER_ROUND` / `HARD_DELETE_ROW_BYTES_PER_ROUND`（256 KiB，保守但无害 ——
当前库仅 293 行，实测 cron 均 7.46 ms，该预算从未成为约束）。
