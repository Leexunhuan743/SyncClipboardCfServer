# SyncClipboard CfServer — Durable Object Hibernation 改造方案

> **这是什么**：把 `SyncClipboardHub` 这个 Durable Object 从「永不可 hibernate 的标准 WebSocket API + 15 s 心跳」
> 改成「可 hibernate」的**候选方案清单**，用来回答一个具体问题：**Free 日额度 13,000 GB-s 里那 84.5–85.5%
> 能不能降下来**。
>
> **本文件不含决定**。哪条方案值得做、做到哪一档，取决于**真机实测数字**（§4.1 的空位）；
> 决定落地时按本仓库惯例登记 `docs/design.md` §2 的 ADR + `docs/progress.md` 追加一节（`AGENTS.md` §1）。
>
> **本轮零写操作**：未改 `src/**`、未改 `public/**`、未改 `test/**`、未部署、未起 `wrangler dev`、未跑任何门禁。
> 全部结论来自**实际读到**的仓库代码与官方文档原文；凡官方文档未明确或自相矛盾的，本文件一律写
> 「未明确 / 矛盾」，**不替平台下结论**；已被实测收敛的（§4.1 的 `setAlarm`、§4.2① 的普通 class 分派）就地写明读数与覆盖边界。
>
> **取数时间**：账户实测数字来自 `docs/free-plan-account-facts.md` §3.5（2026-09-25 07:19–07:31 UTC 快照）。

---

## §1 现状与实测背景

### 1.1 一个 DO 实例承载全部实时连接

三种传输**共用同一个 DO 实例**（这一点决定了后面所有方案的可行性边界）：

| 事实 | 位置 |
|---|---|
| 实例名固定为 `'hub'`，`idFromName` 恒得同一实例 | `src/hub.ts:5`（`HUB_INSTANCE`）、`src/hub.ts:33-35`（`hubStub`） |
| `/SyncClipboardHub` 的**全部**方法（WS 升级 / SSE 的 GET / 长轮询的 GET·POST·DELETE）一律转发给该实例 | `src/index.ts:292-293` |
| 客户端按 `availableTransports` 顺序降级（WebSockets → ServerSentEvents → LongPolling） | `src/hub.ts:27-31`、`docs/protocol.md` §6 |

⇒ **三种传输的「是否可 hibernate」是同一个问题的三个合取项**：只要还有**任意一个** SSE 连接或**任意一个**挂起的长轮询，
整个 DO 就仍然不可 hibernate —— 即使 WS 路径已经全部换成 hibernation API（这正是 §5 的 P1 单独不成立的原因）。

### 1.2 实测（账户 Analytics，2026-09-22 – 09-24）

`docs/free-plan-account-facts.md` §3.5 的 `SyncClipboardHub` 命名空间逐日明细：

```
日期        duration(GB-s)  activeTime(s)  wsIn  wsOut  exceededCpu  exceededMemory
2026-09-22    11014.26         86,049      6246   7263       0            0
2026-09-23    11103.05         86,743      5644   6102       0            0
2026-09-24    10970.50         85,707      5548   6154       0            0
```

- **duration = 11,014–11,103 GB-s/天 = Free 日额度 13,000 的 84.9% / 85.5% / 84.5%**；
  换算自证：`86,049 s × 128 MB / 1 GB = 11,014.3` ✓（与官方定价页的算法一致）。
- **`activeTime ≈ 86,049–86,743 s/天 ≈ 99.6% 的一天**：对象几乎**从未**离开 active/in-memory 态。
- **DO 请求 6,685/天**（2026-09-22，Free 额度 10 万/天 = 6.7%），其中 **alarm 5,783/天**（`5,668 success + 115 clientDisconnected`）
  ⇒ `86,400 / 5,783 ≈ 14.94 s`，与 `HEARTBEAT_INTERVAL_MS = 15_000` 吻合。

**现状口径已登记在别处**（不要重复记数字）：`docs/design.md` D40 的代价段（「一个常驻 WebSocket 的 DO duration 实测 11,014–11,103 GB-s/天 = 日额度 13,000 GB-s 的 84.5–85.5%」）、
`docs/design.md` §13 风险表、`README.md`「Cloudflare Free 计划的真实约束 → Durable Object 的 duration 是隐藏额度」。
本文件不复制那些结论，只做「能不能降下来」的构造级拆解。

- **WS 消息 in/out ≈ 6,246 / 7,263 条/天** ⇒ 4.34 / 5.04 条/分钟 —— 这正是我们**自己**的 15 s 应用层 Ping
  （`sendPings` 每轮每连接一条），不是客户端业务流量。

### 1.3 成因：三条互相叠加的「设计自伤」

| # | 成因 | 位置 | 官方依据 |
|---|---|---|---|
| ① | **标准 WS API 让对象永不可 hibernate** | `src/durable/SyncClipboardHub.ts:209`（`new WebSocketPair()`）、`:214`（`server.accept()`） | lifecycle 前置条件第 3 条「No WebSocket standard API is used」；pricing 脚注 4「Calling `accept()` on a WebSocket in an Object will incur duration charges for the **entire time** the WebSocket is connected」 |
| ② | **15 s 心跳把它焊在内存里** | `:38`（`HEARTBEAT_INTERVAL_MS = 15_000`）、`:541-549`（`scheduleHeartbeat` → `setAlarm`） | lifecycle：需「10 秒无任何请求或事件」才可 hibernate；实测 alarm 间隔 ≈14.94 s ⇒ 该 10 s 窗口**永远凑不满** |
| ③ | **SSE 与长轮询各自留下挂起请求** | SSE：`:264-265`（`TransformStream` + `getWriter`）、`:271`（立即写注释帧）；长轮询：`:340-347`（未兑现的 response + `setTimeout`） | lifecycle 前置条件第 4 条「No request/event is still being processed」 |

**计费口径的关键一句**（官方 pricing，页面日期 `Aug 25, 2026`）：
「Durable Objects that are **idle and eligible for hibernation are not billed** for duration, **even before** the runtime has hibernated them.」
⇒ 现状**不是**「hibernate 太慢」，而是**资格本身不成立**：`accept()` 一挂上，连接期间就全程计费（脚注 4），
与是否真被回收无关。

---

## §2 阻止 hibernate 的构造清单

前置条件取自 <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/> 原文
（「Hibernation can only occur if **all** of the conditions below are true」，10 s 阈值同页）：

- **C1** 无 `setTimeout` / `setInterval` 排程回调（「since there would be no way to recreate the callback after hibernating」）
- **C2** 无在途的 `await`ed `fetch()`（「since it is considered to be waiting for I/O」）
- **C3** **未使用标准 WebSocket API**（「No WebSocket standard API is used」）
- **C4** 无仍在处理的请求/事件（「hibernating would mean losing track of the async function which is eventually supposed to return a response」）
- **C5** 无活跃出站 TCP（`connect()`）或出站 WebSocket

| # | 构造 | 位置（`文件:行`） | 命中 | 要改成可 hibernate，需动什么（**只描述，未实施**） |
|---|---|---|---|---|
| 1 | `new WebSocketPair()` + `new Response(null, {status:101, webSocket: client})` | `src/durable/SyncClipboardHub.ts:209`、`:252` | **不命中** | 官方 hibernation 示例是**同一形状**（`new WebSocketPair()` + 101 响应），这一对**保留不动**；要换的是 `accept` 与三个监听器 |
| 2 | `server.accept()` | `src/durable/SyncClipboardHub.ts:214` | C3 | 换成 `this.state.acceptWebSocket(server)`（`DurableObjectState` 方法，见 <https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket>）。**文档明确要求两者不可并用**：「`ws.accept` must not have been called separately and `ws.addEventListener` method will not receive events」 |
| 3 | `server.addEventListener('message', …)`（含内联的 `replyToClientMessage` + `send` + `close` 分支） | `:216-240` | C3 | 删监听器，改类方法 `webSocketMessage(ws, message)`（签名见 <https://developers.cloudflare.com/durable-objects/api/base/#websocketmessage>；`message` 为 `string \| ArrayBuffer`）。原逻辑（握手响应 / `'close'` 回帧 / Ping 忽略）可原样搬进方法体 |
| 4 | `server.addEventListener('close', drop)` | `:242` | C3 | 改类方法 `webSocketClose(ws, code, reason, wasClean)`；**必须显式 `ws.close(code, reason)`**（本仓库 compat 日期早于 `2026-04-07`，见 §6①） |
| 5 | `server.addEventListener('error', …)` | `:243-249` | C3 | 改类方法 `webSocketError(ws, error)` |
| 6 | `setTimeout(() => …, POLL_TIMEOUT_MS)`（长轮询挂起超时） | `:342`（`waitForClientMessage` 整段 `:334-350`） | **C1** | 只要保留「挂起轮询」这个形态，这条就必然存在 ⇒ 长轮询必须改成**非挂起**（P2）或整体下线 |
| 7 | `Promise.withResolvers<Response>()` 造出、由**未来事件**兑现的 response | `:340`（同上整段） | **C4** | 同上：`fetch()` 返回前必须已有 `Response` ⇒ 无消息时立即返回空体 |
| 8 | SSE：`new TransformStream()` + `writable.getWriter()` + 一直不结束的 `Response` body | `:264-265`、`:271`、`:284-292` | **C4**（**推定**，见下） | 要么下线、要么改短连接（P3）。⚠️ **文档未点名流式响应**：lifecycle 只写「No request/event is still being processed」，另有一句「It does not apply to plain `fetch()` subrequests. Those never keep the Durable Object alive, even while the response body is still streaming.」—— 那句的主语是**出站连接是否 keep alive**（C5 语境），**不是** hibernate 资格。故本条按 C4 字面**推定**为阻止，**未实测** |
| 9 | `this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS)` | `:548`（`scheduleHeartbeat` `:541-549`） | **文档自相矛盾** | 见 §4.1：`best-practices/websockets` 把 alarms 与 scheduled callbacks 并列说成阻止；`concepts/durable-object-lifecycle` 的 5 条清单**没有** alarms。**第一轮实测已裁定：不阻止 hibernate**（A 臂 alarm 触发 39 次而 `duration` 仅满额 1/640，见 §4.1 实测结论）|
| 10 | 构造函数里的 `state.blockConcurrencyWhile(async () => …)` | `:118-127` | **不命中** | 它是**启动期一次性**回调，不是常驻排程（且 lifecycle 把 alarm 明列为「唤醒/启动事件」）。不必删；但它**每次唤醒都会重跑** ⇒ §6② |

**全 `src/` 范围核实**（逐条 grep 过，结论如下）：

| 要核实的项 | 结果 |
|---|---|
| `setInterval` | **0 处**（整个 `src/`）⇒ 对 C1 无额外负担 |
| 在途 `await fetch()` | **0 处在 DO 内**。所有 `hubStub(env).fetch(...)` 都在 **Worker 侧**：`src/hub.ts:61`（broadcast）、`:72`（WS 转发）、`:146`（register-token）、`src/rateLimit.ts:303`（限速端点）；`src/cleanup.ts` 的 fetch 在 Cron（Worker）里 ⇒ C2 已满足 |
| 出站 `connect()` / 出站 `new WebSocket()` | **0 处**（`src/ui/routes.ts:741` 那处只是注释里提到浏览器的 `new WebSocket`）⇒ C5 已满足 |
| `new WebSocketPair()` / `.accept()` | **各 1 处**，都在 `SyncClipboardHub.ts`（`:209` / `:214`）⇒ C3 的**唯一**来源 |

⇒ **阻止 hibernate 的构造共 8 条**（表中 #2–#9）；#1、#10 经核实不阻止，C2/C5 已满足。

---

## §3 hibernate 后会丢的内存态与迁移去向

hibernate 时「**the in-memory state is discarded**」（lifecycle 原文 Caution），构造函数会**重跑**。
逐字段（行号 = `src/durable/SyncClipboardHub.ts`）：

| 字段 | 行 | 现在存什么 | hibernate 后 | 迁移去向 |
|---|---|---|---|---|
| `wsClients: Map<WebSocket, number>` | `:102` | 连接集合 + `lastSeen` 时间戳 | **连接集合本身不丢**（平台代管：`acceptWebSocket` 之后用 `state.getWebSockets()` 取回，见 state API）；**`lastSeen` 丢失** | `lastSeen` → `ws.serializeAttachment({ lastSeen })`。⚠️ **上限 16,384 bytes**，且「Modifications to `value` after calling this method are **not** retained **unless you call it again**」⇒ **每次更新都要重新序列化**（`sendPings` / `webSocketMessage` 都要写一次） |
| `heartbeatScheduled: boolean` | `:539` | 「本轮心跳已在路上」的**防重排标志** | **丢失** ⇒ 会与平台上**仍然 pending 的 alarm** 不一致（唤醒后标志是 `false`，但 alarm 已排过） | **不可原样迁移**（它是对内存状态的断言）。判据应改成 `await this.state.storage.getAlarm()`（alarms API）。⚠️ 注意 `getAlarm()` 在 `alarm()` **正在运行**时返回 `null`（除非期间又调过 `setAlarm`）⇒ 判据写法要照抄官方示例的 `if (!currentAlarm)` 形态，不能直接当「已排程」用 |
| `sseClients: Map<string, SseClient>` | `:103` | 每连接的 `writer: WritableStreamDefaultWriter<Uint8Array>` | **整个丢失** | **不可迁移**：`writer`（`:81`、`:265`）是活的流对象，无法序列化、也无法在唤醒后重建（重建等于换了一条流）。⇒ 只要还想留 SSE，就**不可能** hibernate（P3） |
| `lpClients: Map<string, LongPollClient>` | `:104` | `queue: string[]`、`queuedBytes`、`pending`、`pollSeq`、`lastSeen`、`closed` | **整个丢失**（含**已排队但未被取走的广播消息**） | `queue`/`lastSeen`/`closed` 理论上可落 storage；**`pending: ((r: Response) => void) \| null`（`:72`）不可迁移** —— 它是活函数。⇒ 与 SSE 同理：**只要长轮询还挂起，就不可 hibernate**（P2） |
| `authLimits: Map<string, AuthLimitState>` | `:109` | 认证失败的权威计数 | 丢失，但**已落 storage**：`AUTH_RATE_LIMIT_STORAGE_KEY`，由构造函数 `:118-127` 读回、`persistAuthLimits`（`:508-521`）低频写回 | **已落 storage**，hibernate 后由构造函数恢复 ⇒ 无需额外迁移 |
| `authFailuresSincePersist: number` | `:110` | 距上次落盘累计了几次失败 | 丢失 ⇒ 落盘节奏重置（最坏多等一轮才落） | 不可迁移 / **不需要**（不影响限速判定，只影响落盘频率） |
| `burstWindowStart` / `burstCount` | `:111-112` | 全局失败计数（**仅用于告警**） | 丢失 ⇒ 窗口重置、计数归零 | 不可迁移 / **不需要**（`:499-505` 的注释已声明它只进告警，不参与封锁判定） |
| `tok:*` 登记表 | `:603-616` | negotiate 签发的 token + 过期时间 | **不受影响**（在 storage 里） | 无需迁移 |

**不可迁移、且是硬约束的两个**：SSE 的 `writer`、长轮询的 `pending`（resolve 函数）。
⇒ **§5 的 P1（只迁 WS 路径）在数学上不足以让对象可 hibernate**：这两处只要各有一个活连接，
C4 就为假。这是本方案文档最重要的一条结论。

**另一处易漏**：`closeIdleClients`（`:573-601`）与 `sendPings`（`:553-571`）都直接读内存态
（`wsClients` 的 `lastSeen`、`sseClients`、`lpClients`）。改 hibernation 后它们必须改成
「`state.getWebSockets()` + `deserializeAttachment()`」的形态，否则唤醒后第一轮心跳会把
**全部** WS 连接当成 `lastSeen = 0` 而立刻关掉。

---

## §4 未知与文档矛盾（如实标注）

### 4.1 矛盾：`setAlarm` 到底阻不阻止 hibernate？

**两处官方文档给出不相容的说法**（下表）。**第一轮实测（2026-09-25，四臂实验）已裁定：`setAlarm` 不阻止 hibernate** ——
依据与边界见本节末的「§4.1 实测结论」：

| 出处 | 原文（要点） | 读出来的结论 |
|---|---|---|
| <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>（Last updated Jun 19, 2026） | 「Events such as **alarms**, incoming requests, and **scheduled callbacks prevent hibernation**. This includes `setTimeout` and `setInterval` usage.」 | **alarms 会阻止** hibernate |
| <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>（Last updated Jul 3, 2026） | 5 条前置条件清单（C1–C5）**没有 alarms**；同页把 alarm 描述为**唤醒/启动事件**：「the first incoming request or event (**like an alarm**) will execute the `constructor()`」 | **alarms 不阻止**，它只是「事件」，触发时把对象从 hibernated 唤回 active |

**为什么这条是决定性的**：本项目的 15 s 心跳**完全**依赖 `setAlarm`（`:541-549`）。
- 若「alarms 阻止」成立 ⇒ **P4（放宽心跳节奏）与 P1 都救不了**，必须**彻底去掉服务端定时器**，
  心跳只能靠协议层 ping/pong 或客户端侧行为 ⇒ 方案的可行集合大幅收窄。
- 若「alarms 不阻止」成立 ⇒ 只需把 WS 迁到 hibernation API + 长轮询/SSE 去挂起，
  15 s alarm 可以保留（代价：每 15 s 唤醒一次，每次唤醒进入 active 计费窗口，**5,783 次/天**）
  —— **第一轮实测确认走的是这一支**：A 臂整窗内 alarm 触发 39 次，`duration` 仍只有满额的 1/640（见下）。

⇒ **由四臂对照实验回答**（**另一条工作流在执行**，本文件不跑实验、不部署、不抢资源）。
**第一轮结果（2026-09-25）：A 臂有效全窗；B/C/D 三臂因连接层异常而无效**（不是指标问题）。
臂的定义以**实验包为准**（下表逐字对齐实验包的路由与类名）：

| 臂 | 路由 | 类 | 构造 | 要回答的问题 |
|---|---|---|---|---|
| A | `/a` | `HibernatingAlarm` | `acceptWebSocket` + 15 s alarm ping | 被减数：hibernation API 下 15 s alarm 的代价 |
| B | `/b` | `StandardAlarm` | `server.accept()` + 同款 15 s alarm | **生产形态对照**（现状形态的等价实验臂） |
| C | `/c` | `HibernatingIdle` | `acceptWebSocket`、**无 alarm**、WS 保持连接 | 无 alarm 时能否**真** hibernate |
| D | `/d` | `HibernatingSse` | **无 WS、无 alarm**，仅**一条悬着的流式响应** | 一条悬着的 SSE 响应是否**单独**就足以让 duration 保持满额 |

**怎么读这四臂**（每对只变一个变量）：

- **B ÷ A = hibernation 到底省多少** —— **主问题**。两臂同为 15 s alarm，唯一变量是
  「标准 API（`server.accept()`）↔ hibernation API（`acceptWebSocket`）」。
  **本轮只有推定**（生产速率作对照，≈1000× 量级，见 §4.1 实测结论）；同仪器对照待 B 臂补测。
- **A vs C = `setAlarm` 是否阻止 hibernate** —— 唯一变量是「有无 alarm」（两臂都是 hibernation API + WS 保持连接）。
  **本轮已由 A 臂单独裁定**（alarm 确实触发 39 次、`duration` 仍只有满额 1/640 ⇒ 不阻止）；
  C 臂作为「无 alarm」对照的**增量**价值（量出 alarm 的边际代价）仍待补测。
- **D vs C = 一条悬着的流式响应是否单独足以让 duration 保持满额** —— 唯一变量是「有一条 SSE 挂着」。
  **本轮不能判定**：D 与 C 两臂都无效；D 的**补测正在另一条工作流上进行**。

## §4.1 实测结论（待回填）

> **第一轮（2026-09-25）：A 臂有效；B/C/D 无效。第二轮（D 优先补测）：D 与 C 仍未测出**
> —— 可重现的 ~60 s 静默连接硬切 + 新命名空间 Analytics 落地慢（见下表后的两条环境事实与重跑配方）
> ⇒ **D / C 两问仍留待回填**；**A 臂结论不变**。
> 窗口（A 臂两次）：**1800 s**（30 分钟，`arm-A.json`）与 **600 s** + settle **300 s**（10 分钟，S1→S2 实际 **301.529 s**）；
> 两次都**未跨 UTC 零点**、都 `heldFullPeriod=true`；本轮实验净消耗 ≈ **19.4 GB-s**（10 分钟那轮）。
> 「满额」口径 = `窗口秒数 × 128 MB / 1 GB`（= 全程 active/in-memory 且不可 hibernate 时应消耗的量）：
> 600 s ⇒ **76.8 GB-s**、1800 s ⇒ **230.4 GB-s**。
> 下列数字一律标注为**实测（2026-09-25）**；**未测出/无效臂的读数只登记、不采信**。

| 臂 | 读数（实测 2026-09-25；窗口随臂不同，见各格） | `activeTime` | 结论 |
|---|---|---|---|
| 生产基线（现状形态，**实测**，非本实验） | 2026-09-22 全天 `duration` = **11,014 GB-s/天**；速率 **0.12745 GB-s/s = 满额 99.6%**（2026-09-25 10:39 读数；逐小时稳定 ≈456–460 GB-s） | 86,049 s/天 | 对照锚点（不同形态、不同仪器、不同窗口） |
| A `HibernatingAlarm`（`acceptWebSocket` + 15 s alarm） | **两个有效全窗读数（互相印证）**：① **30 分钟 / 1800 s**（`%TEMP%/do-hibernation-probe/arm-A.json` + `measure-A.json`）—— `heldFullPeriod=true`、`reason=hold-complete`、`close=null`、**`frames=119`**（≈每 **15.1 s** 一条 ⇒ alarm 在跑）；净 `duration` **0.175 GB-s**（`durationRaw` 0.234 − 基线 0.059）、`rateHeld` **0.0000974 GB-s/s** = **满额 0.076%**；② **10 分钟 / 600 s**（`p-arm-A.json` + `p-driver-A.log`）—— `heldFullPeriod=true`、`close=null`、**`frames=39`**（≈每 15.4 s 一条）；S1/S2/S3 `duration` = **0.339 / 0.367 / 0.396 GB-s**、斜率 **0.00009 GB-s/s** = 满额 **0.1%**、窗口总 delta **0.12 GB-s**（满额 76.8 ⇒ **1/640**） | ① **1.83 s**（`cpuTime` 0.059 s、`requests` 170）；② **3 s**（`cpuTime` 0.095 s、`requests` 254） | **采信**（两次独立全窗）：hibernation 成立；**「WS 单独在线」的 duration ≈ 满额的 0.08–0.1%** |
| B `StandardAlarm`（`server.accept()` + 15 s alarm） | **本轮无效**：保持 **20.5 s**、驱动 exit 2、WS **`1006`**、`frames=0`（与 C/D 同一根因） | — | **不采信**（连接层异常，不是指标问题） |
| C `HibernatingIdle`（`acceptWebSocket`、无 alarm） | **本轮未测出**：保持 **60.9 s** 即断（WS **`1006`**、`frames=0）；指标 t0/S1/S2/S3 **全 0**，直到 11:18:50 后才开始出现 `requests=2 / errors=1` ⇒ **数据陆续到达、不完整，不能当读数** | — | **不采信**（可重现的 ~60 s 静默连接硬切 + 新命名空间 Analytics 落地慢，见 §4.1 的两条环境事实） |
| D `HibernatingSse`（无 WS、无 alarm、一条悬着的流式响应） | **本轮未测出**（重建探针后**串行**跑、窗口 300 s）：驱动 HTTP **200**、首字节 **1.64 s**、**1 帧**，但保持 **60.2 s** 就被掐断（`curlExit=56` 接收数据失败）、`完整=false`；指标 t0/S1/S2/S3 **全 0.000 GB-s、`requests=0`** ⇒ **Analytics 根本还没落地**（一个返回过 HTTP 200 的命名空间不可能 `requests=0`）⇒ **不得解读为结论** | — | **不采信**（同上：~60 s 硬切 + Analytics 落后） |

**可重现性（本轮实测）**：D 两次都是 **60.2 s**（60.248 / 60.245 s）、C 两次都是 **60.9 s**
⇒ 稳定复现，**不是偶发抖动**。

**两条新环境事实（本轮实测，直接决定「哪些臂在本机可测」）**：

1. **本机到 Cloudflare 的静默长连接有 ~60 秒硬切** —— D（60.2 s、`curl 56`）与 C（60.9 s、WS `1006`）
   都在 ~60 s 被掐断，而 **A 臂因为每 15 s 有 alarm ping 而活了 600 s / 1800 s** ⇒ 这是**客户端路径
   （本地代理 `127.0.0.1:7897`）的空闲超时**，**不是** DO 或平台行为。
   **推论：任何需要服务端保持静默的臂（C / D）在本机不可测**，必须在**无该代理的客户端**上跑。
2. **新建的 DO 命名空间 Analytics 落地极慢** —— 重建探针后 **~18 分钟**仍 `requests=0`
   （而**旧**命名空间几分钟内就有数、生产当小时数据也是即时的）⇒ **「短实验 + 删重建命名空间」这个组合不可用**；
   再跑应**沿用已存在的命名空间**，或等 **≥30 分钟**。

**重跑配方（下一次要拿 D / C 读数时按这个来）**：

| 项 | 要求 |
|---|---|
| 客户端 | **无本地代理的客户端**（CI runner / 另一台机器）—— 否则任何静默臂都会在 ~60 s 被切（事实 1） |
| 命名空间 | **沿用已存在的**（不要删重建），或新建后**等 ≥30 分钟**再开跑（事实 2） |
| 窗口 | **≥10 分钟**（聚合延迟 > 30 s；且必须斜率 + 多次采样，单点 delta 不可作判据） |
| 编排 | **串行**（本轮 D 就是串行跑的）；开跑前确认窗口不跨 UTC 零点 |

**裁定（第一轮）：`setAlarm` 不阻止 hibernate。**

依据是 A 臂的**同臂自证**，不需要 B/C 对照：整窗内 alarm 确实触发（10 分钟那次 **39 次**、≈每 15.4 s 一条，
与 `HEARTBEAT_INTERVAL_MS = 15_000` 吻合），而**同一窗口**的 `duration` 只有满额的 **1/640**
（0.12 / 76.8 GB-s）。若 alarm 会阻止 hibernate，A 臂应当接近满额 **76.8 GB-s**。
⇒ **`best-practices/websockets` 那句「Events such as alarms … prevent hibernation」与本次读数不相容**；
`concepts/durable-object-lifecycle` 的 5 条前置条件清单（**不含** alarms）与读数一致。

**第二个有效读数（30 分钟）把它进一步钉住**：该窗口 alarm 触发 **119 次**（≈每 15.1 s 一条）、
净 `duration` **0.175 GB-s**（满额应 **230.4 GB-s** = 1800 s × 0.128）⇒ 满额的 **0.076%**。
两次独立全窗读数给出 **0.076% / 0.1%**（相差仅 1.3 倍）⇒ **量级一致**，结论**不变但更强**：
**「WS 单独在线时段」的 duration ≈ 满额的 0.08–0.1%**。
⚠️ 这次 30 分钟读数的**出处**：它来自当时**被中止的串行批**，但**该臂自身的窗口跑完了**
（驱动判据完整：`heldFullPeriod: true` + `reason: "hold-complete"` + `close: null` + `errors: []`）
⇒ 按「**臂自身判据完整即可采信**」记为有效读数（`docs/progress.md` §182.6 第 1 条当时给它的「未采信」标签，
由本轮在 §183 更正 —— §182 原文按轮次记录惯例保留不改）。

⚠️ **本裁定的强度边界（不得越读）**：它推翻的是「alarms **绝对**阻止 hibernate」这一读法；
「**有无 alarm 的边际代价**」尚未用**同仪器对照**测出（C 臂本轮无效）—— 见下条推定。

**证据链留存（一处不完整，只登记、不影响结论）**：首轮四臂的汇总文件
`%TEMP%/do-hibernation-probe/parallel-results.json` **已被 C 单臂重跑以同名覆盖**（现内容只有 C 臂、约 1.0 KB）
⇒ 首轮四臂的 S1/S2/S3 只存在于当时的回报文本里。**仍在盘**的量化证据是：
`arm-A.json` + `measure-A.json`（30 分钟那次）与 `p-arm-A.json` + `p-driver-A.log`（10 分钟那次的连接层事实）；
另 `parallel-baseline.json`（11:07:40，四臂全 0）可佐证「新命名空间 Analytics 落地慢」。
两次 A 臂读数**互证**，故该留存缺口**不影响任何结论**。

**B ÷ A：以生产速率作对照的推定（≈1300–1400×，量级写「约 10³ 倍」），不是同仪器对照。**

生产 `SyncClipboardHub` 的速率 **0.12745 GB-s/s = 满额 99.6%**（2026-09-25 10:39 读数），A 臂
**0.0000974 GB-s/s（30 分钟那次）/ 0.00009 GB-s/s（10 分钟那次）** ⇒ 生产 ÷ A ≈ **1300–1400×**
（量级表述用「约 10³ 倍」；两个 A 读数与生产速率都是实测，但**不是同一仪器、同一窗口**）。
⚠️ **必须标注**：这是拿**生产部署的 Analytics 读数**（不同形态、不同仪器、不同窗口长度）与**探针 A 臂**
相比 —— 两侧**不同日期 / 不同命名空间 / 不同窗口长度** ⇒ **不可当同仪器对照引用**。真正的 B ÷ A 同仪器对照要等 B 臂补测（当前 B 无效）。

**回填后的三问（当前状态）**：

1. **B ÷ A**（hibernation 净收益，主问题）—— **当前只有推定**（生产速率 vs A 臂，≈1300–1400× / 约 10³ 倍）；同仪器对照待 B 臂补测。
2. **A vs C**（`setAlarm` 是否阻止 hibernate）—— **已由 A 臂单独裁定**（39 次 alarm 触发 + `duration` 1/640）；
   C 臂的**增量**价值（量出 alarm 的边际代价）**本轮仍未测出**。
3. **D vs C**（悬着的流式响应是否单独足以让 duration 保持满额）—— **仍不能判定**：D 与 C 两臂**均未测出**
   （~60 s 硬切 + Analytics 落后，见上两条环境事实）；重跑配方见上。

⚠️ **D 只覆盖「悬着的流式响应」这一半**。「**挂起的长轮询**」在 §2（第 6、7 行）与 §3（`pending` 不可迁移）里
与 SSE 同属 **C4**，但本实验包里**没有**对应的臂 ⇒ 若要独立证实长轮询那一半，需**再加一臂**
（`acceptWebSocket` 之外再挂一条长轮询 GET）。这是**待定项**，本文件不替实验包决定。

### 4.2 其余官方文档未明确处

> 表里 ① 是**唯一已经收敛的一条**（本地 miniflare 实测，2026-09-25）—— 它留在表中是因为
> 「官方文档为何没写」这件事本身仍有信息量；②–⑤ 仍是**未明确**，本文件不替平台下结论。

| # | 未明确的问题 | 已知的边界 | 影响 |
|---|---|---|---|
| ① | **不 `extends DurableObject` 的普通 class，能否按名解析 `webSocketMessage` / `webSocketClose` / `webSocketError` 这些 handler？** —— **已实测（2026-09-25，本地 miniflare）** | 本仓库当前是**普通 class**：`export class SyncClipboardHub {`（`:101`），构造函数签名 `(state: DurableObjectState, env: Bindings)`（`:114`）；官方文档与 API 参考里的**所有**示例都写 `extends DurableObject`（<https://developers.cloudflare.com/durable-objects/api/base/>），但**没有一句**说「不继承就不解析 handler」 | **实测结论：按名分派成立 ⇒ 类声明与构造函数不需要改**（方法与读数见下方「§4.2① 的本地实测」）。⚠️ 覆盖边界：只验了 `webSocketMessage` 与 `webSocketClose`，**`webSocketError` 未被触发 ⇒ 未验证** |
| ② | **hibernation API 是否有最低 `compatibility_date`？** | 本仓库 `compatibility_date = "2025-09-01"`（`wrangler.toml:3`）；`@cloudflare/workers-types@^5.20260915.1` 的 `index.d.ts:701-703` 已声明 `acceptWebSocket` / `getWebSockets` / `setWebSocketAutoResponse`（即**类型层可用**）。官方文档中**唯一**与 compat 日期绑定的行为是 `web_socket_auto_reply_to_close`（`>= 2026-04-07`），而它是**close 握手**的开关，不是 hibernation 的开关 | 未明确。类型可用 ≠ 运行期可用，故列为待实测项 |
| ③ | **挂起的流式响应（SSE）算不算 C4？** | 见 §2 第 8 行的脚注：lifecycle 未点名流式响应；那句「plain `fetch()` subrequests … never keep the Durable Object alive, even while the response body is still streaming」属于 C5 的出站连接语境 | 本文件按 C4 字面**推定**为阻止（**推定 ≠ 实测**） |
| ④ | **`setWebSocketAutoResponse` 能否承接 SignalR 的 15 s 应用层 Ping？** | 官方说它「sets an automatic response … for the request provided」（state API），`request`/`response` 各 ≤ 2,048 字符，且**不唤醒** hibernating WebSocket、**不计** wall-clock（pricing 脚注 3）。但文档**未说明**匹配语义（是否要求整帧精确相等）、**也未说明**是否支持多组 request/response 对 | **P4 已被否（见 §5 P4）⇒ 本条不再影响决策**（保留作历史信息：它当初是 P4「零唤醒心跳」那条路子的前提）。另注：SignalR Ping 帧是 `{"type":6}\x1e`（`src/durable/signalr.ts:60-61`），客户端**也**会发自己的 `{"type":6}`（`docs/protocol.md` §6 步骤 4） |
| ⑤ | **唤醒时构造函数与 `alarm()` 的先后** | 这条**是明确的**（不算未知，但极易踩）：alarms API 文档写「if the Durable Object wakes up after being inactive, the constructor is invoked **before** the alarm handler」，并明确警告「if the constructor calls `setAlarm`, it could interfere with the next alarm which has already been set」 | 直接决定 §6③ 的改法 |

**§4.2① 的本地实测（2026-09-25，仓库外一次性探针；非云端、无需凭据）**

方法：`%TEMP%/plain-class-do-probe/` 做**两档 + 一对照**，两档都用 `this.state.acceptWebSocket(server)`
（与生产一致的调用形态）：`/plain` 是**普通 class**（`constructor(state, env)` + `this.state`），
`/ext` 是 `extends DurableObject` + `this.ctx`（**对照**，用来证明脚手架本身跑得通）；两者都定义
`fetch`（`new WebSocketPair()` → `acceptWebSocket` → 101）与 `webSocketMessage` / `webSocketClose` / `webSocketError`。

复现：

```
cd %TEMP%/plain-class-do-probe
npx wrangler dev --port 8899          # 显式端口，避免与其它本地服务撞
# 另一个终端：
node ws-client.mjs plain 8899 5000    # 连 /plain、发一条 'hello'、等 5 s（超时退出码 2）
node ws-client.mjs ext   8899 5000    # 对照
```

版本：wrangler **4.131.2**、miniflare **5.20260911.1-alpha**、探针 `compatibility_date = "2025-09-01"`
（与 `wrangler.toml:3` 同档）。

读数：`/plain` → `PLAIN_HANDLER_OK`（**3 次全部收到，无超时**）；`/ext` → `EXT_HANDLER_OK`（对照通过）。
本地日志原文含 `[plain] constructor ran`、`[plain] acceptWebSocket ok, sockets=1`、
`[plain] webSocketMessage "hello"`、`[plain] webSocketClose code=1005`（后者由客户端 `ws.close()`
不带 code 触发）⇒ **普通 class 同样被按名分派**。

⚠️ **覆盖边界（不得越读）**：① 只验了 `webSocketMessage` 与 `webSocketClose`，**`webSocketError` 未被触发 ⇒ 未验证**
（它走同一条按名解析路径，风险低）；② 本地**不**验证 hibernation 本身（是否真进入 hibernated、duration 是否停计费
—— 那是云端 Analytics 的事，见 §4.1 的四臂；官方「本地开发不 hibernate」那句是按版本门控的旧说明，不构成反驳）；
③ 单次本地实验、单一版本档。

⇒ 对 §8 的影响：类声明与构造函数**不需要改动**（见 §8.1 #15）。

---

## §5 候选方案（并列，**不裁决**）

四条方案**互相独立**，可任意组合；下面每条只写「改什么 / 收益前提 / 代价 / 协议影响 / 测试面」。
**收益前提**一律以 §4.1 的实测为准 —— 本文件不预设降幅。
**第一轮实测（2026-09-25）后的状态：P4 已降为「不需要」；P1 拿到实测支撑但收益上限仍待臂 D；P2 / P3 仍不能判定。**

### P1 只迁 WS 路径（把三处 handler 换成 hibernation API）

- **改哪些文件**：`src/durable/SyncClipboardHub.ts` 的 `handleWebSocket`（`:208-253`）—— `accept()` → `state.acceptWebSocket()`，
  三个 `addEventListener` → 类方法 `webSocketMessage` / `webSocketClose` / `webSocketError`；
  `sendPings`（`:553-571`）与 `closeIdleClients`（`:573-601`）的 WS 分支改成 `getWebSockets()` + attachment；
  `broadcast`（`:657-680`）的 WS 分支同理。`src/hub.ts` / `src/index.ts` **不动**（转发路径与 negotiate 载荷不变）。
- **收益前提（关键，必须写在方案里）**：**只要有任一 SSE 连接或任一挂起的长轮询，仍不可 hibernate**（§3 的
  `writer` 与 `pending` 不可迁移；§1.1 的单实例约束）。⇒ P1 的收益**上限**是「WS 单独在线时的时段」，
  而 `docs/protocol.md` §6 的降级链意味着客户端**默认**走 WS —— 所以 P1 的收益可能是全部、也可能是零，
  取决于**是否真的从未有 SSE/长轮询连接**。
  ⚠️ **这个问题由 §4.1 的臂 D（`HibernatingSse`）回答，A/B/C 都答不了** —— A、B、C 三臂都**不带** SSE/长轮询客户端，
  测的是「只有 WS 时 hibernation 省多少」，无法反映「有一条 SSE 挂着」的情形。
  且 **D 只覆盖 SSE 那一半**：「挂起的长轮询」按 §2 第 6/7 行与 §3 与 SSE 同属 C4，实验包里**没有**对应臂
  ⇒ 若要独立证实长轮询那一半，需再加一臂（见 §4.1 空位表后的待定项）。本文件不猜结论。
- **实测支撑（2026-09-25，四臂实验第一轮）**：A 臂实测证明**「WS 单独在线」时段的 `duration` ≈ 满额的
  **0.08–0.1%**（**两次独立全窗读数**：30 分钟那次净 delta 0.175 / 满额 230.4 GB-s = 0.076%、`activeTime` 1.83 s；
  10 分钟那次斜率 0.00009 GB-s/s、总 delta 0.12 / 76.8 GB-s = 0.1%、`activeTime` 3 s），
  对照生产现状的 **84.5–85.5% 日额度**（`docs/free-plan-account-facts.md` §3.5）—— 且 **wire 上协议面零变化**。
  ⚠️ **这不等于「能省 X%」**：P1 的**收益上限仍取决于臂 D**（一条悬着的 SSE 是否单独就吃掉全部收益），
  而 **D 的补测本轮仍未测出**（~60 s 静默连接硬切 + 新命名空间 Analytics 落地慢，见 §4.1 的两条环境事实
  与重跑配方）⇒ **P1 的收益上限仍是未回答**。本文件不给任何降幅结论。
- **代价**：`lastSeen` 从内存 Map 变成 per-connection attachment（每次更新都要重新 `serializeAttachment`，
  16,384 bytes 上限）；`heartbeatScheduled` 判据改 `getAlarm()`；`wsClients.size` 这类计数改 `getWebSockets().length`
  （`clientCount()` `:530-532` 是三传输合计，SSE/LP 那部分不变）。
- **协议兼容**：**对外零变化**（wire 上仍是同一条 WS、同样的握手/广播/Ping 帧）。
  `docs/protocol.md` §10 **不需要**登记新行 —— 但 §6 表格里「传输」那一行的「服务端实现」描述
  （`docs/protocol.md:336-340` 的表格）若写的是实现细节，可按需微调（**属文档同步，不属协议差异**）。
- **测试面**：`transports.test.ts`（三种传输的 negotiate 与握手，含 WS 用例 `:171-173`）、`signalr.test.ts`
  （真实 SignalR 客户端）、`cleanup.test.ts`（`:239` 起用真实连接收广播）、`rate-limit.test.ts`
  （⚠️ **必然受影响**：它的 `createDoState()` 假状态 `:570-584` 只有 `blockConcurrencyWhile` 与
  `storage.{get,put,delete,list,setAlarm}`，**没有** `acceptWebSocket` / `getWebSockets` ⇒ 夹具必须同步扩，
  否则 `:569` 起那组用例直接 `TypeError`）。

### P2 长轮询改「非挂起」（无消息立刻返回空体，客户端自行重试）

- **改哪些文件**：`src/durable/SyncClipboardHub.ts` 的 `handleLongPoll`（`:312-332`）与
  `waitForClientMessage`（`:334-350`）—— 去掉 `Promise.withResolvers` + `setTimeout`，
  无排队消息时立刻返回 `200` 空体（沿用现有 `POLL_HEADERS`，`:59-62`）；`POLL_TIMEOUT_MS`（`:46`）与
  `pollSeq` / `pending` / `settlePoll`（`:352-359`）随之可删。`deliverTo`（`:423-458`）的 LP 分支只剩入队。
- **收益前提**：长轮询连接不再留下「仍在处理的请求」（C4）与 `setTimeout`（C1）。
  **但仍需 P3**：SSE 挂着的时候照样不可 hibernate。
- **代价（必须写清）**：**请求数上升**。挂起式长轮询现在的节奏是「一条消息或 25 s 一次请求」；
  改成非挂起后变成「空体即返回 ⇒ 客户端立刻重试」。SignalR 的长轮询客户端在收到空体后会立即再发一次，
  于是**空转频率取决于客户端退避**（未实测）。这些请求全部计入 **Free 的 10 万请求/天**（`docs/free-plan-account-facts.md` §3.3：
  账号级峰值 28,028/天，本 Worker 峰值 24,212/天）。⇒ **这条是把 duration 压力换成 requests 压力**，
  两边的额度余量不同（duration 已到 84.5%，requests 到 24%），但是否划算**要实测**。
- **协议兼容**：ASP.NET Core 的长轮询**本身就是**「空体 → 客户端立刻重试」的语义（现有注释 `:309-311`
  已经写着「超时返回 200 空体，客户端会重新轮询」）⇒ 对外**不改变可观察语义**，只是**永不挂起**。
  `docs/protocol.md` §10 **不需要**登记差异（上游也是这个行为）；但 `docs/protocol.md` §6 的
  「挂起 GET（首个轮询立即返回、无消息挂起 ≤25s）」这一句描述**必须改**（属文档同步）。
- **测试面**：`transports.test.ts` 的两条长轮询用例 —— `:207-232`「长轮询挂起的上限有界：无消息时不会永久挂住（>25s 内必须返回）」
  **语义会变**（不再是「挂起但有界」而是「立即返回」，断言要改写成「远小于 25 s」）；
  `:183-205`「首轮 GET 立即返回 200」**不受影响**；`rate-limit.test.ts:569` 起的队列封顶用例
  （`MAX_QUEUED_MESSAGES` / `MAX_QUEUED_BYTES`，`:55-56`）**不受影响**（入队逻辑不变）。

### P3 SSE 改短连接或下线

- **改哪些文件**：`src/durable/SyncClipboardHub.ts` 的 `handleSseConnect`（`:259-282`）、
  `writeSseRaw`（`:284-292`）、`closeSseClient`（`:294-303`），以及 `deliverTo` / `sendPings` / `broadcast` 的 SSE 分支；
  若下线，还要动 `src/hub.ts:27-31` 的 `AVAILABLE_TRANSPORTS` 与 `docs/protocol.md` §6。
- **收益前提**：消除 C4 的第二个来源（挂起的流式响应）。
- **状态（2026-09-26 复核）：机制侧只有「长轮询」那一条可信，「SSE」那条不可引用；生产的必要性仍未回答。**
  · **长轮询**：§8.7(c) 的 5 分钟相位 = 满速 **103%** ⇒ **在线即收益归零**（轮询每 ~15 s 重连，不吃 60 s 静默切，
    读数成立）。⇒ P2 的价值是**已证实**的。
  · **SSE**：§8.7(c) 的 5 分钟相位 = **20%**，与「4 帧 × 15 s = 60 s = 本机代理硬切点」**逐位吻合** ⇒ 判为**假象**
    （`progress.md` §189.1）⇒ SSE 的真实代价**未知**（C4 若成立则与长轮询同级）。
  · **生产侧**：原「无长轮询流量」的推论**已撤回**（`type` 拆不出 LP，§189.2）⇒ 合并前无法判定。
  ⇒ 收口两条路见 §189.4：① 先部署「只加传输打点」的 master 侧小改动；② 合并后看 `duration` 是否塌。
  · D（`HibernatingSse`）与 C 两臂**第二轮补测仍未测出**（D 保持 60.2 s 后 `curl 56`、指标全 0 且 `requests=0`；
    C 保持 60.9 s 后 WS `1006`、指标不全）；根因是**客户端路径 ~60 s 静默连接硬切** + **新命名空间 Analytics
    落地慢**（§4.1 的两条环境事实），**不是**指标问题 ⇒ 重跑配方见 §4.1。
  ⚠️ D / C 的旧**未采信信号**按「仅登记、不作证据」保留：`activeTime` **404 s** / delta **+16.87 GB-s** ——
  方向与预期一致，但该命名空间**有前序污染**（同一命名空间被重建前的读数混入），且**无效臂不得作证据**
  （§4.1 实测结论表已标「不采信」）。
- **代价（协议面能力收窄）**：SSE 是官方客户端在 **WS 被阻断**（剥离 `Upgrade` 的代理、只放行普通 HTTP 的防火墙）
  时的**唯一中间档**（`docs/protocol.md` §6 的降级链、`src/hub.ts:22-31` 的注释）。
  改短连接 = 每条消息一次 HTTP 请求（把 duration 压力换成 requests 压力，同 P2）；
  下线 = 只剩 WS 与长轮询两档。
- **⚠️ 红线**：**不要**在方案里改变 `AVAILABLE_TRANSPORTS` 的**宣告顺序** —— 顺序 = 客户端的尝试顺序
  （`src/hub.ts:22-26` 的注释、`docs/protocol.md` §6），改顺序等于改变所有客户端的传输选择。
  若最终选择下线 SSE，那只能是**从数组里整条移除**（而不是挪到后面），且必须重新评估「WS 被阻断」场景。
- **协议兼容**：`docs/protocol.md` §10 的「SignalR 传输」行（现为「三种均实现，宣告顺序与格式表逐字对齐」）
  **必须登记**；§6 的传输表与连接流程同样要改。
- **测试面**：`transports.test.ts` 的 `:175-177`「ServerSentEvents：握手 + 广播（回退能力）」
  与 `:234-257`「自动回退：不指定传输时…仍能连接并收到广播」（这条依赖降级链）**都会受影响**；
  `transports.test.ts:147-169`「negotiate 按上游顺序宣告三种传输」的断言要按新数组改。

### P4 「心跳节奏」旋钮 —— **第一轮实测后判定为「不需要」**

- **状态（2026-09-25，四臂实验第一轮）：不需要。** 依据 A 臂实测：**15 s alarm 全窗跑着（39 次触发）时，
  `duration` 仍只有满额的 0.1%**（斜率 0.00009 GB-s/s、窗口总 delta 0.12 / 76.8 GB-s）⇒ **放宽心跳对 duration
  没有收益**。它原本的动机（「每 15 s 唤醒一次很贵」）被这条读数直接否掉。
- **它还有一条与本实验无关的硬约束**（因此即便将来又想要收益，也不能靠放宽间隔实现）：客户端
  **ServerTimeout 30 s** —— `src/durable/SyncClipboardHub.ts:11`（「三种传输共用同一套心跳（15s Ping）与静默清理（60s），
  因为客户端 ServerTimeout 对三者一致」）、`:37`（「须 < 客户端 ServerTimeout 30s」）、`:537`、`:552`、
  `docs/protocol.md:391/398`。⇒ **服务端到客户端的应用层 Ping 不能稀于 ~30 s**，否则客户端自判超时并反复重连；
  P4 能调的空间本来就只有「15 s → 更接近 30 s」（alarm 5,783 → ~2,900 次/天），**不能取消**。
- **以下为「为什么否掉」的留档**（历史信息，不再作为候选）：

  - **改哪些文件**（若将来重启该议题）：`src/durable/SyncClipboardHub.ts:38`（`HEARTBEAT_INTERVAL_MS`）、
    `sendPings`（`:553-571`）、`scheduleHeartbeat`（`:541-549`）；若改到协议层则同时涉及 `docs/protocol.md` §6 步骤 6。
  - **曾被考虑的替代路径（**未明确，需实测**）**：文档明确「自动 ping/pong **不**唤醒对象」——
    <https://developers.cloudflare.com/durable-objects/best-practices/websockets/#automatic-pingpong-handling>：
    「Ping/pong handling **does not interrupt hibernation**」「The `webSocketMessage` handler is not called for control frames」。
    另有 `state.setWebSocketAutoResponse()`：应用层自动应答，**不唤醒** hibernating WebSocket、**不计** wall-clock
    （pricing 脚注 3）。⇒ 理论上「WS 上的 SignalR Ping」可以由这两者之一承接、完全不需要 alarm。
    **但**：协议层 ping/pong 是 **WS 控制帧**，而 SignalR 的 Ping 是**文本帧** `{"type":6}\x1e` ——
    两者不是一回事，且官方客户端**同时**会发自己的 Ping（`docs/protocol.md` §6 步骤 4）；
    `setWebSocketAutoResponse` 的匹配语义官方**未说明**（§4.2 ④，已随本条一并标为「不再影响决策」）。
  - **代价（若真去放宽）**：心跳变稀 ⇒ 死连接（半开 TCP）的发现延迟从 60 s（`IDLE_TIMEOUT_MS`，`:41-43`）继续放大；
    长轮询**尤其**依赖真实消息重置 ServerTimeout（`:552` 的注释：「空轮询响应不会重置客户端 ServerTimeout，必须有真实消息」）
    ⇒ **与 P2 直接冲突**：若长轮询改成非挂起，服务端就必须靠别的方式让客户端看到真实消息。
  - **协议兼容 / 测试面**：若只是把 15 s 改成别的值，对外**不可观察**（Ping 是可忽略帧），`docs/protocol.md` §10 不必登记，
    但 `docs/protocol.md:398`（「心跳：DO alarm 每 15s 发 `{"type":6}`」）与 §6 步骤 6 的「每 15s」要同步；
    无套件直接钉 15 s，而 `signalr.test.ts` / `transports.test.ts` 的连接存活依赖它（心跳缺失会表现为
    **30 s 后的客户端超时重连**，症状是「测试偶发慢/偶发失败」，很难定位）⇒ 改这一项必须跑真实客户端套件。

---

## §6 回归面与坑

| # | 坑 | 依据 | 后果 / 判据 |
|---|---|---|---|
| ① | **`compatibility_date = "2025-09-01"` 早于 `2026-04-07`** ⇒ `webSocketClose` 里**必须**显式 `ws.close(code, reason)` | `wrangler.toml:3`；<https://developers.cloudflare.com/durable-objects/api/base/#websocketclose>：「On older compatibility dates (before `2026-04-07`), you **must** call `ws.close(code, reason)` inside this handler to complete the WebSocket close handshake. Failing to reciprocate the close will result in **`1006`** errors on the client」 | 客户端收到异常关闭 `1006`（表现为「连接莫名断开」）。**不要**用「升级 compat 日期」来回避：那会一次性引入该日期之前的所有行为变更（本仓库 compat 日期是有意钉住的） |
| ② | **hibernate 后构造函数会重跑**，`blockConcurrencyWhile` 每次都重跑 | `src/durable/SyncClipboardHub.ts:118-127`；lifecycle「the `constructor()` will run again」；best-practices「**Minimize work in the constructor** when using hibernation」；state API：`blockConcurrencyWhile` 有 **30 s 超时**，超出则对象被 reset | 现在构造函数里那次 `storage.get` 是**每次唤醒**都要付的成本；它同时**延迟**首次事件处理。⇒ 唤醒频繁时（15 s alarm 保留——**本轮 A 臂实测其代价 ≈ 满额 0.1%**，见 §4.1）这条的抵消量很小，但**它仍是每次唤醒都要付**的固定成本 |
| ③ | **`heartbeatScheduled` 在 hibernate 后与平台上 pending 的 alarm 不一致** | `:539` 的注释推理**依赖「进程不被回收」**（「本 DO 单实例 ⇒ 内存标志足够，无需读存储」）；但 alarms 文档明确「if the Durable Object wakes up after being inactive, the constructor is invoked **before** the alarm handler」，且**警告**构造函数里调 `setAlarm` 会干扰已排好的 alarm | 唤醒后标志为 `false` 而 alarm 仍在路上 ⇒ 会**重复** `setAlarm`（覆盖已有 alarm，等于把心跳时间往后推）或**漏排**。判据应改成 `await this.state.storage.getAlarm()`；⚠️ 且 `getAlarm()` 在 `alarm()` **正在运行**时返回 `null`（除非期间又 setAlarm）⇒ 照抄官方示例的 `if (!currentAlarm)` 形态 |
| ④ | **`authLimits` 丢失等价于计数归零**（既有取舍） | `:117` 的注释已声明：「低频落盘的计数在 DO 重启后恢复。丢失等价于计数归零（最坏多给阈值次失败），故为尽力而为」 | hibernate 会让**重启频率显著上升** ⇒ 这条「尽力而为」的代价被放大（封锁更容易被绕过一点）。**属既有取舍**，改造时只需确认「最坏多给阈值次失败」仍然可接受，不必新增机制 |
| ⑤ | **测试夹具缺 hibernation 方法** | `test/rate-limit.test.ts:570-584` 的 `createDoState()` 只有 `blockConcurrencyWhile` + `storage.{get,put,delete,list,setAlarm}` | P1 落地时该夹具**必须**补 `acceptWebSocket` / `getWebSockets`，否则 `:569` 起那组用例 `TypeError`。**这是同一轮必须一起改的**（`AGENTS.md` §1） |
| ⑥ | **静默清理依赖内存 `lastSeen`** | `closeIdleClients` `:573-601`（`wsClients` 的 `lastSeen`） | 唤醒后 `lastSeen` 只能来自 attachment（§3）；**若忘了迁移**，第一轮 `closeIdleClients` 会把全部 WS 当死连接关掉（`IDLE_TIMEOUT_MS = 60_000`，`:41-43`），症状是「一唤醒就全体掉线」 |
| ⑦ | **alarm 本身也是「请求」** | pricing 的 Requests 一栏把「**alarm invocations**」计入 DO requests；实测 5,783 次/天 ≈ DO 请求的 **86%**（6,685/天） | 放宽心跳本可顺带省下这部分请求配额，但 **P4 已被本轮实测否掉**（§5 P4：放宽对 duration 无收益）⇒ 这部分请求配额**不构成**改造理由 |
| ⑧ | **长轮询队列是纯内存态** | `lpClients.queue` `:69`、`MAX_QUEUED_MESSAGES`/`MAX_QUEUED_BYTES` `:55-56` | 一旦真的 hibernate，**已排队未被取走的广播消息会静默消失**（客户端表现为「丢了一条变更通知」，靠 60 s 看门狗轮询兜底）。P1 单独不改这条（LP 存在即不可 hibernate）；P2 之后「排队」只发生在「客户端停止轮询」的窗口里，性质不变 |

---

## §7 做什么 / 不做什么的边界

> **状态（2026-09-25，已实施）**：**P1 已被采纳并落地** —— 决定与依据见 `docs/design.md` **D42**，
> 实现记录与门禁读数见 `docs/progress.md` §184。本节「不含决定 / 不改代码」的描述是**本文件成文时**
> （§1–§6 成文、实测数字未回填）的状态，**按轮次记录惯例保留不改**；下面「决定的落地路径」已逐条执行：
> ADR → `docs/design.md` §2 的 **D42**；进度 → `docs/progress.md` §184 + `docs/progress-index.md` 逐字同步；
> 协议面**零变化** ⇒ `docs/protocol.md` §6/§10 **均未动**；`README.md` 的 duration 数字**未改**
> （收益须上线后按 §8.5 复核，届时再决定要不要改那条口径）。**P2 / P3 仍未决定**（臂 D 至今未测出）。

**本文件做什么**：把「哪些构造阻止 hibernate」「hibernate 后会丢什么」「官方文档哪里自相矛盾」
「有哪些并列方案、各自代价是什么」逐条钉到 `文件:行` 与官方 URL 上，供实测落地后做决定。

**本文件不做什么**：

1. **不含决定**。不选 P1–P4 中的任何一个、不给优先级、不给收益数字。
   实测数字落地前，任何「这样做能省 X%」的说法都是猜测。
2. **不改代码、不部署、不跑门禁**（用户本轮明确指示）。
   §4.1 的四臂实测（A `HibernatingAlarm` / B `StandardAlarm` / C `HibernatingIdle` / D `HibernatingSse`）由**另一条工作流**执行，本文件不抢资源、不部署探针。
3. **不替平台下结论**。官方文档未明确（§4.2 的 ②–⑤）或自相矛盾（§4.1）之处一律标注，不写成事实。
4. **不改变协议宣告顺序**（§5 P3 的红线）。

**决定的落地路径**（实测数字回来后，按本仓库惯例）：

- `docs/design.md` **§2** 加一条 ADR（编号递增），实现处注明 D 号（`AGENTS.md` §1）；
- `docs/progress.md` **追加一节**（编号递增 + 日期），**同一次**更新 `docs/progress-index.md`（`test/docs.test.ts` 有逐字守卫）；
- 若涉及协议面变化（P3 下线 SSE、P2 的挂起语义描述），同步 `docs/protocol.md` §6 / §10；
- 若改动 `README.md`「Cloudflare Free 计划的真实约束」里那条「Durable Object 的 duration 是隐藏额度」
  （现在写着「一个常驻连接约 11,059 GB-s/天，吃掉日额度约 85%」），要一起改数字。

---

## §8 P1 实施清单（**已实施**：2026-09-25，ADR D42 / `docs/progress.md` §184）

> **状态（2026-09-25，已实施）**：本清单**已按 §8.1 逐条执行**（`src/durable/SyncClipboardHub.ts`
> + `test/rate-limit.test.ts` 的夹具），门禁读数见 `docs/progress.md` §184。下表行号是**改动前**的状态
> （改动后的行号见 §184.2），保留原样以便对照。
> **与清单的差异（3 条，都是本轮实测/用户要求带来的）**：
> 1. **§8.3 漏了一个夹具**：`test/fixes.test.ts` 的 F10 `makeHub()`（`:647-664`）也直连 `hub.wsClients`
>    与 `closeIdleClients()` / `alarm()` ⇒ 同一轮里一并改（假 socket 带 `deserializeAttachment()`），
>    否则那三条用例会红。§8.3 只点了 `test/rate-limit.test.ts`。
> 2. **§8.2 的「`authLimits` P1 不动」被本轮的用户要求取代**：封锁状态必须**按实质变化落盘**
>    （hibernate 每段静默都清内存，而封锁窗口是分钟级 ⇒ 只靠内存等于「停手 10 秒就能重来」）。
>    落盘形态改为 `{persistedAt, limits}`（仍单 key = 1 行写），触发条件与写放大读数见 §184.3。
>    该行的 `sseClients` / `lpClients` / `tok:*` 三项**仍然成立**（确实未动）。
> 3. **`isAuthLimitBlocked` 的用法变了**：落盘判据不再用「任一 key 已封锁」，而是「`blockedUntil`
>    **新产生或延长**」—— 前者在「已有封锁」期间会让**每次**失败都落一行（写放大 = 失败次数）。
>
> 下面这段「条件清单 / 尚未采纳」的原文**按轮次记录惯例保留不改**（它描述的是成文时的状态）。

> **§8 是条件清单：取决于 §4.1 的实测结果与项目所有者的决定；本文件仍不含决定。**
> 它把 P1（只迁 WS 路径）的**机械面**提前钉住 —— 逐文件到函数级、必迁内存态、夹具、红线、验收、回滚 ——
> 目的是数字一到就能直接动手，**不是**「已经决定要做 P1」。
> 若 §4.1 显示 hibernation 收益不足，或臂 D 显示「一条悬着的 SSE 响应」单独就吃掉全部收益，
> 本清单作废（或只在 P2/P3 一并落地后才成立）。**§8 不新增任何结论，也不替代 §5 P1 的收益前提。**

### 8.1 逐文件改动清单（到函数级）

范围：**只迁 WS 路径**。行号 = 现状（`src/durable/SyncClipboardHub.ts`）。

| # | 位置（现） | 现状 | 改成 | 备注 |
|---|---|---|---|---|
| 1 | `:208-253` `handleWebSocket` | `new WebSocketPair()`（`:209`）→ `wsClients.set(server, Date.now())`（`:212`）→ `scheduleHeartbeat()`（`:213`）→ `server.accept()`（`:214`）→ 三个监听器（`:216-249`） | `new WebSocketPair()` 与 `:252` 的 101 响应**不动**；`wsClients.set` → `server.serializeAttachment({ lastSeen: Date.now() })`；`server.accept()` → `this.state.acceptWebSocket(server)`；三个监听器**删除**（职责搬进 #2–#4） | 顺序按官方示例：先 `acceptWebSocket(server)`，再 `serializeAttachment` |
| 2 | `:216-240` message 监听器 | 匿名函数：刷新时间戳 → `replyToClientMessage` → `'close'` 则 `send(closeMessage())`+`close()`，否则 `send(reply)`；catch 里 `wsClients.delete` | 新**类方法** `webSocketMessage(ws, message)`：刷新 `lastSeen`（**重新 `serializeAttachment`**）、`replyToClientMessage(typeof message === 'string' ? message : '')`、`'close'` 分支沿用 send+`ws.close()`、reply 非 null 时 `ws.send(reply)`；catch 里的集合删除**去掉**（连接集合由平台代管） | 参数类型是 `string \| ArrayBuffer`；原实现 `typeof event.data === 'string' ? event.data : ''` 的语义等价保留 |
| 3 | `:242` close 监听器（`drop`） | `drop()` = 删集合 + `scheduleHeartbeat()` | 新**类方法** `webSocketClose(ws, code, reason, wasClean)`：**必须** `ws.close(code, reason)`，然后 `scheduleHeartbeat()` | **红线**：漏掉 `ws.close(code, reason)` ⇒ 客户端收 **1006**（§6①） |
| 4 | `:243-249` error 监听器 | `drop()` + `try { server.close() } catch {}` | 新**类方法** `webSocketError(ws, error)`：`scheduleHeartbeat()` + `try { ws.close() } catch {}` | — |
| 5 | `:238-241` 局部 `const drop = () => {…}` | 被 #3/#4 共用 | **删除**（两个职责分别搬进 #3/#4） | — |
| 6 | `:553-571` `sendPings` 的 WS 分支 | `for (const [ws] of this.wsClients)` + `readyState === OPEN` 判定 + catch 里 `wsClients.delete(ws)` | `for (const ws of this.state.getWebSockets())`；`readyState === WebSocket.OPEN` 判定**保留**；catch 里只 `try { ws.close() } catch {}` | SSE/LP 两个循环**不动** |
| 7 | `:573-601` `closeIdleClients` 的 WS 分支 | `for (const [ws, last] of this.wsClients)`，用内存 `lastSeen` | `for (const ws of this.state.getWebSockets())`，`lastSeen = ws.deserializeAttachment()?.lastSeen ?? 0`；`ws.close(1000, 'idle timeout')` **不变**；集合删除去掉 | ⚠️ 漏迁 ⇒ 唤醒后首轮把全部 WS 当死连接关掉（§6⑥） |
| 8 | `:657-680` `broadcast` 的 WS 分支 | `for (const [ws] of this.wsClients)` | 同 #6（`getWebSockets()` + `readyState` 判定 + catch 只 close） | — |
| 9 | `:530-532` `clientCount()` | `wsClients.size + sseClients.size + lpClients.size` | `this.state.getWebSockets().length + sseClients.size + lpClients.size` | 三传输合计**语义不变**；⚠️ `getWebSockets()` 可能含 `CLOSING` ⇒ 计数偏高，见 §8.2 末 |
| 10 | `:541-549` `scheduleHeartbeat()` | `if (this.heartbeatScheduled) return; this.heartbeatScheduled = true; void storage.setAlarm(...)` | 改 `async`：`if ((await this.state.storage.getAlarm()) !== null) return; void this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS)` | **8 个调用点一起改**（`:213`、`:240`、`:268`、`:304`、`:318`、`:398`、`:448`、`:527`）：同步函数里写 `void this.scheduleHeartbeat()`，`alarm()` 里 `await`。⚠️ `getAlarm()` 在 `alarm()` **运行中**返回 `null`（除非期间又 `setAlarm`），`:527` 正是 alarm 内调用 ⇒ 语义要照抄官方示例的 `if (!currentAlarm)` 形态 |
| 11 | `:523-528` `alarm()` | 首行 `this.heartbeatScheduled = false;`（`:524`） | **删除该行**（防重排判据已交给 `getAlarm()`） | 其余（`sendPings` + `closeIdleClients` + 重排）不变 |
| 12 | `:539` `private heartbeatScheduled = false;` | 内存标志字段 | **删除** | — |
| 13 | `:102` `private wsClients = new Map<WebSocket, number>();` | WS 连接集合 | **删除** | — |
| 14 | `src/hub.ts` / `src/index.ts` / `wrangler.toml` | — | **0 行改动** | 转发路径、negotiate 载荷、`compatibility_date`、`[[migrations]]` 全不动 |
| 15 | `:101` / `:114` 类声明与构造函数 | `export class SyncClipboardHub {`（**普通 class，不继承**）+ `constructor(state: DurableObjectState, env: Bindings)`，自持 `this.state` | **不需要改动** —— §4.2① 的本地 miniflare 实测（2026-09-25）确认普通 class 同样被按名分派 `webSocketMessage` / `webSocketClose` | 兜底（**仅当将来被推翻**）：改 `extends DurableObject` + `super(ctx, env)`，并把 `this.state` 与基类 `ctx` 对齐；⚠️ 该实测**未触发 `webSocketError`**，那条 handler 的分派仍未验证 |

**规模量级**：单文件（`src/durable/SyncClipboardHub.ts`）+ 单测试文件（`test/rate-limit.test.ts` 的夹具）。

### 8.2 必迁的内存态与其落点（对应 §3）

| 内存态 | 现（行号） | 落点 | 必须注意 |
|---|---|---|---|
| `wsClients`（连接集合 + `lastSeen`） | `:102` | 集合 → `state.getWebSockets()`（平台代管）；`lastSeen` → `ws.serializeAttachment({ lastSeen })` | **16,384 bytes 上限**；「改完必须**重新序列化**」⇒ `sendPings` / `webSocketMessage` 每次触碰都要写一次；attachment 在任一侧关闭时丢失 |
| `heartbeatScheduled`（防重排标志） | `:539` | `await state.storage.getAlarm()` | `alarm()` 运行中返回 `null`（见 #10）；`setAlarm` 会**覆盖**已有 alarm ⇒ 判据写错会「永远推后心跳」或「漏排」 |
| `clientCount()`（三传输合计） | `:530-532` | WS 部分改 `getWebSockets().length`；SSE/LP 部分**不变** | ⚠️ **已知不确定**：state API 写「`getWebSockets` may still return WebSockets even after `ws.close` has been called」（`CLOSING` 态）⇒ 计数可能 > 实际活连接数 ⇒ `clientCount() === 0` 的短路（`:542-545`）可能失效、心跳多排几轮。**是否要按 `readyState` 过滤，留待实测**（本文件不裁定） |
| `sseClients` / `lpClients` / `tok:*` | `:103` / `:104` / `:603-616` | **P1 不动**（SSE/LP 保持原实现；token 本来就在 storage） | P1 的收益上限受 SSE/LP 限制（§5 P1 的收益前提） |
| `authLimits`（**已按本轮用户要求改**） | `:109` | 落盘形态改 `{persistedAt, limits}`、触发条件改「封锁开始/延长立即落 + 计数清零强制落 + 纯计数按 15 s 节流落」 | ⚠️ 原写的「已在 storage ⇒ P1 不动」**不成立**：封锁窗口是分钟级而 hibernate 每段静默都清内存 ⇒ 计数进度几乎从不落盘会让封锁**永远不触发**。写放大与探针读数见 `docs/progress.md` §184.3 |

### 8.3 必须同一轮一起改的测试夹具与用例

**(a) 夹具（硬性）**：`test/rate-limit.test.ts:570-584` 的 `createDoState()`（`describe` 在 `:569`）——
现在只有 `blockConcurrencyWhile` + `storage.{get,put,delete,list,setAlarm}`，**必须补**
`acceptWebSocket(ws)`（登记到一个本地数组/Set）与 `getWebSockets()`（返回该数组）。
否则该 `describe` 下 **6 条用例里 5 条**当场 `TypeError`（它们都经 `handleLongPoll` → `scheduleHeartbeat()` → `clientCount()`）：

| 用例（`test/rate-limit.test.ts`） | 会红？ | 原因 |
|---|---|---|
| `:602` 排队消息数超过上限 → 关闭连接（204）并记录日志 | **红** | 首个 GET 走 `handleLongPoll` → `scheduleHeartbeat()` → `clientCount()` → `getWebSockets()` |
| `:617` 单条超大消息触发字节上限 | **红** | 同上 |
| `:628` 一次请求投递整批（ADR D33）：消息仍逐条入队 | **红** | 同上 |
| `:651` 未超限的消息仍按原语义整批取回 | **红** | 同上 |
| `:664` Hub 连接鉴权失败同样限速（WS/SSE/长轮询不走 Worker 中间件） | **红** | 同上（该请求也落到 `handleLongPoll`） |
| `:689` `AUTH_RATE_LIMIT_PATH` 端点：report / snapshot / clear | **不红** | 该路径不进 `scheduleHeartbeat` |

**(b) 依赖 WS 行为的用例（逐条判定「预期仍成立 / 需改断言」）**：

| 用例 | 判定 |
|---|---|
| `test/transports.test.ts:171`「WebSockets：握手 + 广播（回归）」（走 `:50` 的 `expectBroadcastOverTransport('ws', …)`） | **预期仍成立**：wire 上握手 `{}\x1e` 与广播 `{"type":1,…}\x1e` 逐字节不变 |
| `test/transports.test.ts:234`「自动回退：不指定传输时…仍能连接并收到广播」 | **预期仍成立**（WS 可用时仍走 WS；降级链未动） |
| `test/transports.test.ts:259`「无有效凭据与 token 时，三种传输的连接请求一律 401」 | **预期仍成立**（鉴权在 `fetch` 入口，与 accept 方式无关） |
| `test/transports.test.ts:175` / `:179`（SSE / 长轮询握手 + 广播）、`:183` / `:207`（长轮询首轮立即返回 / 挂起有界）、`:148`（negotiate 宣告顺序） | **预期仍成立**：P1 不碰 SSE / LP / negotiate |
| `test/signalr.test.ts:71` 连接 + 握手成功（拿到 connectionId） | **预期仍成立** |
| `test/signalr.test.ts:77` / `:100` 广播在响应前 await（PUT / PATCH 路径） | **预期仍成立** |
| `test/signalr.test.ts:125`「心跳：连接保持超过客户端 ServerTimeout（30s）不掉线」 | **预期仍成立，且是 P1 最该盯的一条**：它钉的正是「`alarm()` 里对 hibernated WS 发 `send` 仍能送达」。若 `getWebSockets()` 迭代或 `send` 在唤醒后异常，它会以「30 s 后客户端自判超时」的形式红 |

### 8.4 红线（不得违反）

1. **wire 上逐字节不变**：握手 `{}\x1e`（`src/durable/signalr.ts:45-46`）、广播 `{"type":1,…}\x1e`（`:50-51`）、
   Close `{"type":7}\x1e`（`:55-56`）、Ping `{"type":6}\x1e`（`:60-61`）、RS 分隔符（`:8`）、
   101 升级响应（`SyncClipboardHub.ts:252`）。
2. **`compatibility_date` 不动**（`wrangler.toml:3` = `2025-09-01`）：**不得**为绕开 §6① 而升级它
   （升级会一次性引入该日期之前的全部行为变更）。
3. **`AVAILABLE_TRANSPORTS` 顺序不动**（`src/hub.ts:27-31`）：顺序 = 客户端尝试顺序。
4. **`docs/protocol.md` §10 不新增差异行**：P1 对外零变化 ⇒ 无新差异可登记
   （若确实微调了 §6 表格里「服务端实现」那列的文字，属**文档同步**，仍不进 §10）。
5. **`[[migrations]]` 不动**（`wrangler.toml:33-35`）：类名与存储后端都不变 ⇒ 不需要新 tag。
6. **不得顺手改 SSE / 长轮询**：P2/P3 是独立方案，混在一起会让 §4.1 的读数**无法归因**。

### 8.5 落地后的验收判据（可复现）

**(a) 套件**（跑法见 `docs/design.md` §12：黑盒套件需先起 `wrangler dev`）：

- 必跑：`transports`、`signalr`、`rate-limit`、`cleanup`（后两者用真实连接 / 真实 DO 类）；
- 一并跑（防连带）：`protocol`、`fixes`、`fix-regressions`。

**(b) Analytics 对比（N 天）**：`N ≥ 2 个完整 UTC 日`（Analytics 按 UTC 日聚合，当日不完整 —— 参照
`docs/free-plan-account-facts.md` §3.5 的「2026-09-25 当日未过完」）。查询骨架（与
`docs/free-plan-account-facts.md` §4 的查询原文同源；**`filter` 必填、窗口 ≤ 1 周**）：

```graphql
query($acc:String!,$ns:String!,$a:Date!,$b:Date!){
  viewer{ accounts(filter:{accountTag:$acc}){
    durableObjectsPeriodicGroups(limit:1000,
      filter:{namespaceId:$ns,date_geq:$a,date_leq:$b}){
      sum{duration cpuTime activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount
          exceededCpuErrors exceededMemoryErrors}
      dimensions{date namespaceId}}}}}
```

⚠️ **`namespaceId` 必须取「实验部署那个 Worker」的命名空间**，**不是**生产命名空间
（`0be018a796d8455f9b3786b35d265cd2`，`docs/free-plan-account-facts.md` §1.3）—— 拿生产数字冒充实验读数等于没测。

**预期看到什么才算成功**（对照基线 `duration` = 11,014 / 11,103 / 10,970 GB-s/天、`activeTime` = 86,049 / 86,743 / 85,707 s/天）。

> **2026-09-25 更新（旁挂 A/B 实测后）**：下面 1/2 条从「显著低于」改成带数字的判据，
> 并新增第 4 条（DO 请求数）。实测读数与复现配方见 §8.7。

1. 逐日 `duration` **< 50 GB-s**（预期 **3–11 GB-s/天**；实测每连接秒只计满速的 0.025%）。
2. `activeTime` **< 1,000 s/天**（预期 **约 22–90 s/天**；若仍 ≈86,000 ⇒ 对象从未 hibernate，P1 无效）。
3. 逐日 `duration` **不超过** Free 额度 13,000 GB-s/天。
4. **新增**：逐日 DO **请求数**（`durableObjectsInvocationsAdaptiveGroups` 的 `sum.requests`）——
   合并后每个入站 WS 消息都是**一次调用**（实测：`wsIn` 不再统计它们，见 §8.7(c)），
   预期 **1.2 万–2.9 万/天**（alarm 5,760 + 每客户端 5,760 keepalive + negotiate/广播），
   判据 **< 100,000/天**（Free 额度）：
   ```graphql
   query($acc:String!,$ns:String!,$a:Date!,$b:Date!){
     viewer{ accounts(filter:{accountTag:$acc}){
       durableObjectsInvocationsAdaptiveGroups(limit:1000,
         filter:{namespaceId:$ns,date_geq:$a,date_leq:$b}){
         sum{requests errors} dimensions{type status}}}}}
   ```
5. ⚠️ **`inboundWebsocketMsgCount` / `outboundWebsocketMsgCount` 的读法变了**：Hibernation API 下
   入站消息走 DO 调用 ⇒ `wsIn` **会掉到 0 附近**（实测探针命名空间 `wsIn = 0`、`wsOut = 47`），
   这不是故障；客户端的存活改由第 4 条的请求数与客户端侧是否重连来观察。
   （原第 4 条「若 P4 落地则 wsIn/wsOut 下降」随之作废 —— P4 未采纳，见 §5 的 P4 段。）

**(c) 要盯的回归症状**：

| 症状 | 指向 |
|---|---|
| 客户端报 **1006** 异常关闭 | `webSocketClose` 漏了 `ws.close(code, reason)`（§6①） |
| 「一唤醒就全体掉线」 | `lastSeen` 未迁到 attachment，首轮 `closeIdleClients` 误杀（§6⑥） |
| 每 **30 s** 一次的重连 | 心跳（`alarm` → `ws.send(ping)`）未送达 hibernated WS（`test/signalr.test.ts:125` 会先红） |
| DO 请求里 `type=alarm` 反而**变多** | `getWebSockets()` 含 `CLOSING` ⇒ `clientCount()` 偏高、心跳多排（§8.2 末）。⚠️ **2026-09-25 实测排除**：客户端全部离开后静默 8 分钟，两个命名空间的 `requests` 与 `duration` 增量**都是 0**（§8.7(c)） |

### 8.6 回滚

- **代码**：改动集中在**单文件** `src/durable/SyncClipboardHub.ts` ⇒
  `git revert <该提交>` 或 `git checkout <上一提交> -- src/durable/SyncClipboardHub.ts`；
  测试夹具（`test/rate-limit.test.ts`）在**同一提交**内，一起回退。
  `wrangler.toml`（`compatibility_date` / `[[migrations]]`）自始未动 ⇒ **无迁移要回滚**。
- **状态**：`serializeAttachment` 写的 attachment 随连接生命周期消失（官方：「If either side closes the connection,
  attachments are lost」）⇒ 无需主动清理；平台上可能残留一个 pending alarm，而老代码的 `setAlarm` 会**覆盖**它
  ⇒ 无需处理（要立刻清干净可 `state.storage.deleteAlarm()`，**不必须**）。

### 8.7 真实边缘 A/B 与第二轮微优化（2026-09-25 补充，**已实测**）

**(a) 旁挂 A/B：分支 vs master**（同一台机器、同一套客户端脚本、同一 runtime 设置 —— 唯一差别是 Hub 实现）

| | 分支（Hibernation API） | master（标准 API，对照） |
|---|---|---|
| 客户端连接秒数 | 574 s（6 条连接） | ≈420 s（6 条连接） |
| `duration` | **0.0184 GB-s** | **55.65 GB-s** |
| `activeTime` | **0.144 s** | **434.7 s** |
| 每连接秒占满速 | **0.025%** | **≈104%**（434.7 s ≈ 客户端在线时长） |

⇒ **每连接秒约 4,100× 差距**，累计 3,021×（0.0184 vs 55.65）。两版 `compatibility_date` 与 flags
逐字相同（`2025-09-01` + `nodejs_compat`），源码分别取 `perf/free-plan` 的 `6498bf5` 与
`origin/master` 的 `41d51b2`（后者在**独立 worktree** 里部署，主仓库工作树未被触碰）。

**(b) 交付物（保留，供后续复测）**：`syncclipboard-freeplan-probe`（分支，DO 命名空间
`3cf57bbeba1e4ed7bba394767d96c3ed`）与 `syncclipboard-master-probe`（master，
`eb352d7cc9b24155bcd3dea5e6e22293`），各自独立 D1（`e6faf56d-4e8e-47b8-b50f-0c4ca5a806ed` /
`ee4f2f8d-9369-4f77-bb29-691f00026ed6`），均**不绑 R2、不配 Cron**；生产 `syncclipboard-cf-server`
全程未动（部署列表最新仍是 2026-09-22T17:04:55Z）。

**(c) 同一环境下的其它实测**

| 项 | 结果 |
|---|---|
| **P3：长轮询挂住 5 min** | `duration` **+39.69 GB-s** = 满速 **103%** ⇒ **长轮询在线时收益归零**（这就是 P2 的价值所在） |
| **P3：SSE 挂住 5 min** | **+7.72 GB-s** = 满速 **20%** ⇒ ⚠️ **2026-09-26 复核：该读数判为假象，不可引用** —— 相位注「300 s，4 帧」，而心跳是 15 s/帧 ⇒ 「4 帧」= **60 s** = 本机代理的静默硬切点，且 `60/300 = 20%` **逐位吻合**（本节 §5 P3 也把这条 D 臂标成「未测出 / 不采信」）。⇒ **SSE 的真实代价仍未知**（若 C4 推定成立则与长轮询同级）。见 `progress.md` §189.1 |
| **静默踢线** | 连接后不发任何消息：分支与 master **都是 75 s、code 1000** ⇒ 迁移未破坏静默回收，客户端看到的是**干净关闭**（不是 1006） |
| **心跳泄漏** | 无客户端静默 8 min：两个命名空间 `requests` / `duration` 增量均为 **0** ⇒ `clientCount()` 的 `CLOSING` 隐患在真实运行时不存在 |
| **响应时间** | 冷/热各测：分支热态 p50 **111–263 ms**、master **124–252 ms**（冷态 0.6–1.1 s 含本机代理 RTT）⇒ **无系统性差异**、无延迟回归 |
| **界面实时链路** | `login → hub-ticket → WS` 建立后，一次真实 PUT 的广播**当场送达界面 WS** ✓ |
| **生产流量构成** | ⚠️ **2026-09-26 复核：这条推论不成立（已撤回）** —— 长轮询的每次 poll 也是 `http` 调用，`type` 拆分**分不出** LP；「4 台客户端用 LP（~25 s 一 poll ⇒ ~13.8k http/天）+ 5,783 alarm」与实测 ~24.2k 请求/天**兼容** ⇒ 「用 LP」与「用 WS」两种世界都符合该计数。⇒ 生产实际用了哪些传输，**合并前无法从现有可观测面判定**（服务端也没有按传输打点）。见 `progress.md` §189.2 / §189.4 |

**(d) 第二轮微优化（同轮改动，均落在 `src/durable/SyncClipboardHub.ts`）**

1. **限速快照改按需加载**（`loadAuthLimitsOnce`）：hibernate 后构造函数**每次唤醒都重跑**，而多数唤醒
   （客户端 keepalive / 广播 / 连接事件）根本用不到限速状态 ⇒ 旧写法每次唤醒都多一次 storage 读**和**
   一个往返延迟。现在只有 `handleAuthRateLimit` 与 `connectionAuthFailure` 两条入口会读
   （**有效 token 的连接路径零存储读**）。
2. **`alarm()` 内重排不再读 `getAlarm()`**（`rearmHeartbeatInAlarm`）：alarm 正在执行时平台上必无
   pending alarm（防重排判据本来就建立在这条语义上）⇒ 省 5,760 读/天。
3. **落盘形态的形状守卫 + 旧形态迁移**（`readPersistedAuthLimits`）：新形态 `{persistedAt, limits}` 与
   **上一版的平铺表**都认 —— 后者逐条用 `isAuthLimitState` 校验后接收、`persistedAt` 取 0（节流判据立刻允许
   落盘 ⇒ 下一次实质变化即写成新形态）。
   ⚠️ **为什么是迁移而不是丢弃**（**2026-09-26 按用户审查意见改**）：master 落的就是平铺表，丢弃会让**部署那一刻
   仍在有效期内的封锁与失败计数全部归零** —— 攻击者只要等到发布窗口就能重来，慢速试探的进度也白攒。
   只有**真正不可识别**的损坏值才按空表起算并留一条 `[hub] authRateLimits 快照形态不识别…` 告警。
   测试面：`test/rate-limit.test.ts` —— 新形态被采信（正对照）、**旧形态被迁移**（封锁跨部署保留 + 落成新形态 +
   换实例可读回）、损坏值按空表起算并告警。
