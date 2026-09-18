# SyncClipboard CfServer

[SyncClipboard](https://github.com/Jeric-X/SyncClipboard) 官方同步服务器的 **Cloudflare Workers 复刻版**。

用 TypeScript 重写官方 ASP.NET Core 服务端，部署在 Cloudflare 边缘网络上。**官方客户端无需任何改动**，
把服务器地址指向部署好的 Worker 即可获得完整能力：剪贴板实时同步、历史记录与跨设备历史同步。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 为什么需要它

SyncClipboard 客户端支持三类服务端，能力并不相同：

| 服务端类型 | 传输模型 | 历史同步 | 说明 |
|---|---|---|---|
| **官方服务器**（本项目复刻的对象） | **事件驱动**（SignalR 长连接） | ✅ | 只有 `IOfficialSyncServer` 能开启历史同步 |
| WebDAV | 轮询 | ❌ | 简单，但延迟高、无历史面板 |
| S3 兼容存储 | 轮询 | ❌ | 同上 |

官方服务器的独有能力（实时推送 + 历史记录同步）依赖 SignalR Hub 与 `/api/history/*`。
本项目把这一整套搬到 Cloudflare，省去自建服务器与运维：

- **无服务器**：无需 VPS、Docker、进程守护，按量计费，免费额度对个人使用足够
- **边缘部署**：全球加速，冷启动毫秒级
- **协议保真**：逐条对齐上游实现（含哈希算法、状态机、错误语义）

## 功能

- **剪贴板双向同步**：WebDAV 兼容 API（`SyncClipboard.json` + `file/`），支持文本 / 图片 / 文件 / 多文件组
- **实时推送**：SignalR 兼容 Hub（negotiate / 握手 / 心跳 / 广播），支持 **WebSockets、
  ServerSentEvents、长轮询** 三种传输并按上游顺序宣告，WS 不可用时自动降级
- **历史记录与历史同步**：`/api/history/*` 全套（查询 / 上传 / PATCH 乐观并发 / 统计 / 清空），
  支持官方客户端的历史面板、收藏置顶、跨设备历史同步
- **数据完整性校验**：Text / File / Image / Group 四类哈希算法逐字节对齐上游 C# 实现，
  服务端校验上传数据（不符即拒绝），避免坏数据在设备间扩散
- **保留与清理**：Cron Trigger 定时执行保留期裁剪、条数上限、已删除记录硬删与孤儿对象清理
- **Web 历史界面**（默认界面 `/ui_old/`；`/ui/` 与站点根都跳到它）：浏览器里查看/搜索/筛选/预览服务器上的剪贴板历史，
  支持时间范围（今天 / 近 7 天 / 近 30 天 / 自定义）、回收站（含恢复）、文本复制、图片预览、
  文件下载、收藏置顶、批量删除与部署信息。
  界面与官方 API 读写同一套数据，写操作走与官方 `PATCH` 相同的实现（含广播与数据清理）。
  详见 [`docs/ui.md`](docs/ui.md)
- **健壮性**：并发写入用唯一索引 + 乐观并发控制；大文件上传零冗余拷贝；
  WebSocket 升级需鉴权；附件响应带 `nosniff` / CSP 防护，界面静态资源另有 `_headers`
  声明的 CSP 与缓存策略

## 架构

```mermaid
flowchart LR
    C1["官方客户端 A"] -->|HTTP Basic| W
    C2["官方客户端 B"] -->|HTTP Basic| W
    C3["WebDAV 客户端"] -->|HTTP Basic| W
    B["浏览器"] -->|会话 Cookie 或 Basic| W
    B -.静态资源.-> AS["Cloudflare 静态资源<br/>public/**"]

    subgraph W["Cloudflare Worker（Hono）"]
        AUTH[鉴权中间件]
        DAV["WebDAV 端点<br/>SyncClipboard.json / file/*"]
        API["官方 API<br/>/api/time /api/version /api/history/*"]
        NEG["SignalR negotiate"]
        UI["Web 界面 API<br/>/ui/api/*"]
    end

    W --> D1[("D1<br/>历史记录 + 当前 Profile")]
    W --> R2[("R2<br/>file/ 暂存 + history/ 持久")]
    NEG --> DO["Durable Object<br/>SyncClipboardHub"]
    C1 <-->|WebSocket| DO
    C2 <-->|WebSocket| DO
    DAV -.写后广播.-> DO
    API -.写后广播.-> DO
    UI -.写后广播.-> DO
    DO -.RemoteProfileChanged / RemoteHistoryChanged.-> C1
    DO -.RemoteProfileChanged / RemoteHistoryChanged.-> C2
```

| 组件 | 职责 |
|---|---|
| **Workers + [Hono](https://hono.dev/)** | HTTP 路由与请求处理 |
| **D1**（SQLite） | 历史记录与当前 Profile 元数据 |
| **R2** | 剪贴板数据文件（`file/` 暂存区 + `history/` 持久区） |
| **Durable Objects** | SignalR 兼容 Hub：持有 WebSocket 连接、心跳、全员广播 |
| **静态资源**（`public/ui_old/**` = 默认界面 V1、`public/ui/**` = 开发测试版 V2） | 两个界面都由 Cloudflare 托管，但请求**先进 Worker**（`run_worker_first` 覆盖 `/ui*` 与 `/ui_old*`）——入口据此判断界面开关（`UI_ENABLED`），开着转回 `env.ASSETS.fetch()`，关着一律 404 |

协议面与界面面**严格分离**：`/api/history/*`、`/SyncClipboard.json`、`/file/*` 是客户端依赖的契约，
界面只读同一套数据（另开 `/ui/api/*` 表达页大小、排序、选择集等界面需要），写操作与官方 `PATCH`
共用同一实现。详见 [`docs/ui.md`](docs/ui.md)。

## 兼容性

与上游服务端逐条对照实现，覆盖上游全部路由：

| 类别 | 端点 |
|---|---|
| 基础 | `GET /`（浏览器导航会 302 到**默认界面** `/ui_old/`）、`GET /api/version`、`GET /api/time` |
| WebDAV | `GET`/`PUT /SyncClipboard.json`、`GET`/`HEAD`/`PUT`/`DELETE /file/*`、`PROPFIND`、`MKCOL` |
| 历史 | `GET /api/history/{profileId}`、`GET /api/history/{profileId}/data`、`POST /api/history`、`POST /api/history/query`、`PATCH /api/history/{type}/{hash}`、`GET /api/history/statistics`、`DELETE /api/history/clear` |
| 实时 | `/SyncClipboardHub`（negotiate + WebSocket） |

**客户端要求**：SyncClipboard **v3.1.1 或更高**（v3.1.1 起协议为当前格式，旧版不兼容）。
已验证官方 **v3.2.0 WinUI3 客户端**：文本（含大文本）、文件的双向同步、历史同步，**以及 SignalR 实时推送**
（服务端改动 → 客户端剪贴板 **1.5 s** 内更新）。2026-09-15 用官方 v3.2.0 客户端对生产做了一轮完整 E2E 复验
（含文件字节级一致、File 哈希规则与客户端逐字一致），记录见 [`docs/progress.md`](docs/progress.md) §44.5。

**版本口径（两套编号，互不相干，不要"顺手对齐"）**：

| 编号 | 含义 | 当前位置 |
|---|---|---|
| `VERSION`（`wrangler.toml` `[vars]`） | **对外自我描述**：`/api/version` 返回的串。**逐字对齐上游基线**编译后真实返回的值 —— 上游 `src/Directory.Build.props` 的 `<VersionPrefix>3.2.0</VersionPrefix>` 是唯一事实源，`SyncClipboardProperty.AppVersion` 取 `AssemblyInformationalVersion` 并截掉 `+` 之后的部分，故基线 `28c7e596` 报 `3.2.0` | **`3.2.0`** |
| `version`（`package.json`） | **本迁移项目自身**的版本号（记录/发布用，客户端看不到） | 见 `package.json` |

跟版规则：**仅当上游改动版本事实源**（bump `<VersionPrefix>` 或换版本来源）时才改 `VERSION`，
并同步 `docs/protocol.md` §10 的登记行与 `docs/design.md` §10。客户端下限只要求 `≥ 3.1.1`，
且该检查在版本串解析失败时会被**静默跳过**，所以这个值没有功能后果——它是**忠实性**要求。

已知行为差异与有意偏离记录在 [`docs/protocol.md`](docs/protocol.md) 的差异表。

## 快速开始（本地）

```bash
npm install

# 初始化本地 D1（miniflare）
npx wrangler d1 execute syncclipboard --local --file=./schema.sql

# 配置本地凭据（.dev.vars 已被 gitignore）
cp .dev.vars.example .dev.vars     # 填入 USERNAME / PASSWORD

npm run dev                        # → http://127.0.0.1:8787
```

运行测试（22 个套件）：

```bash
npm run typecheck                  # tsc --noEmit（src + test）
npm run lint                       # eslint（两份零构建前端；它们不在 tsc 的 include 里）
npm run check                      # 上面两条

# 单元/数据层套件（无需服务器）
npx vitest run test/hash.test.ts test/fixes.test.ts

# 全部套件（含 HTTP/SignalR 黑盒）——需 dev server 已启动
npm test
```

> `npm run dev` 以 `--test-scheduled` 启动，使 `cleanup` 套件能经 `GET /__scheduled`
> 触发真实 Cron 处理器；若你自己用 `wrangler dev` 不带该参数启动，该套件会跳过并提示原因。

**写库套件默认只允许指向本机**：七个套件（`protocol`、`fix-regressions`、`transports`、
`signalr`、`cleanup`、`query-filters`、`ui`）会创建/删除历史记录与 R2 对象，
因此 `BASE` 非 `127.0.0.1`/`localhost` 时会**直接拒绝运行**。确实要指向一次性实例时显式放行：

```bash
ALLOW_REMOTE_TARGET=1 BASE=https://your-worker.workers.dev npm test
```

黑盒套件默认以 `http://127.0.0.1:8787` + `admin/admin` 连接本地 dev server。
若你改了 `.dev.vars` 里的凭据或端口，用 `SYNC_USER` / `SYNC_PASS` / `BASE` 覆盖：

```bash
BASE=http://127.0.0.1:8788 SYNC_USER=me SYNC_PASS='***' npm test
```

> 变量名不用 `USER` / `USERNAME`：Windows 有 `USERNAME`、Ubuntu CI runner 有 `USER`，
> 都被宿主环境占用，读它们会拿到错的凭据而 401。

## 部署

### 方式 A：手动部署（wrangler CLI）

```bash
# 0. 登录 Cloudflare（一次性）
npx wrangler login

# 1. 创建资源（一次性；把输出的 database_id 填入 wrangler.toml）
npx wrangler d1 create syncclipboard
npx wrangler r2 bucket create syncclipboard

# 2. 初始化线上 D1 schema（幂等，可重复执行）
npx wrangler d1 execute syncclipboard --remote --file=./schema.sql

# 3. 设置 Basic Auth 凭据（一次性，长期生效；必须使用高熵随机口令，见「安全基线」）
npx wrangler secret put USERNAME
npx wrangler secret put PASSWORD

# 4. 部署（Cron Trigger 随部署自动注册）
npm run deploy
```

部署完成后 wrangler 会输出 Worker 地址（形如 `https://<worker-name>.<subdomain>.workers.dev`），
也可在 Cloudflare 控制台绑定自定义域名。

### 方式 B：GitHub Actions 自动部署

仓库内置 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)：

- **触发**：push 到 `master` **且改动涉及产品代码或构建输入**，或 Actions 页面手动运行
  （`workflow_dispatch`）。白名单见 `deploy.yml` 的 `on.push.paths`：`src/**`、`public/**`、
  `test/**`、`schema.sql`、`wrangler.toml`、`package*.json`、`tsconfig.json`、`vitest.config.ts`、
  CI 自身。**纯文档改动不触发**——它既不改变部署产物，也不影响协议行为；反过来，将来新增
  部署输入时要同步加进那个列表，否则该变更不会触发流水线。
- **注意**：`deploy` job 需要下方两个 Secret，**未配置时该 job 会失败并列出缺少的名称**
  （`quality` job 不需要凭据，其协议/界面/文档/单元用例仍会照常运行并通过）
- **流程**：两个 job
  1. **`quality`**：`typecheck` + `lint` + **全部 22 个套件**。黑盒套件由 CI 自行用
     `wrangler dev`（miniflare）起一个本地实例来跑 —— **不接触线上资源，也不需要 Cloudflare 凭据**，
     D1 用 `--local` 初始化，凭据用 `--var` 临时注入。
  2. **`deploy`**（`needs: quality`，质量门失败则不部署）：
     D1 schema 幂等执行 → `wrangler deploy` → 凭据同步（可选）→ 冒烟检查
- **需配置**（Settings → Secrets and variables → Actions）：

  | 名称 | 类型 | 必填 | 默认 | 说明 |
  |---|---|---|---|---|
  | `CLOUDFLARE_API_TOKEN` | Secret | ✅ | — | 权限：Workers Scripts:Edit、D1:Edit、R2:Edit、Account Settings:Read |
  | `CLOUDFLARE_ACCOUNT_ID` | Secret | ✅ | — | Cloudflare 账户 ID |
  | `USERNAME` / `PASSWORD` | Secret | 可选 | — | Basic Auth 凭据（见下方两种用法）；配了它冒烟检查才会跑"带凭据"的三条断言 |
  | `SYNC_AUTH_CREDENTIALS` | Variable | 可选 | `false` | 设为 `true` 时由 CI 把凭据写入 Worker secrets |
  | `DEPLOY_URL` | Variable | 可选 | 部署输出的地址 | 自定义域名时用它做冒烟目标；不设则用 `wrangler-action` 输出的 `workers.dev` 地址（**已不再跳过**） |
  | `UI_ENABLED` | Variable | 可选 | `true` | 是否提供 Web 历史界面（见下方「部署开关」） |
  | `ENFORCE_STRONG_CREDENTIALS` | Variable | 可选 | `false` | 置 `true` 后弱口令 fail-closed（轮换完凭据之后开） |
  | `MAX_SAVED_HISTORY_COUNT` | Variable | 可选 | `1000` | 历史条数上限（对齐上游 `AppSettings.MaxSavedHistoryCount`） |
  | `HISTORY_RETENTION_MINUTES` | Variable | 可选 | `10080` | 保留期（分钟，默认 7 天；对齐上游 `HistoryRetentionMinutes`） |
  | `MAX_REQUEST_BODY_BYTES` | Variable | 可选 | `50331648`（48 MiB） | 写端点接受的请求体上限；允许 **256 KiB–64 MiB**，见下方说明 |
  | `AUTH_RATE_LIMIT_WINDOW_MS` | Variable | 可选 | `900000`（15 分钟） | **不建议改**：失败计数窗口（60 s–24 h） |
  | `AUTH_RATE_LIMIT_MAX_FAILURES` | Variable | 可选 | `10` | **不建议改**：窗口内允许的失败次数，第 N+1 次起封锁（3–100） |
  | `AUTH_RATE_LIMIT_BLOCK_MS` | Variable | 可选 | `900000`（15 分钟） | **不建议改**：封锁时长（60 s–24 h） |
  | `AUTH_RATE_LIMIT_BURST_WARN` | Variable | 可选 | `50` | **不建议改**：全局失败**告警**阈值（只打日志不封锁，10–10000） |

#### 部署开关（Variables 怎么生效、怎么改）

表里那些**可选 Variable** 就是部署开关：每次部署时由 `deploy.yml` 的 `Resolve deploy switches` 步骤读取，
做「默认值兜底 + 取值校验」后经 `wrangler-action` 的 `vars` 输入绑成 Worker 变量。
所以**改开关 = 改仓库变量 + 重新部署**（push 一提交，或在 Actions 页面手动 `workflow_dispatch`）：

```text
Settings → Secrets and variables → Actions → Variables → New repository variable
   Name: UI_ENABLED     Value: false
然后要么推一个提交，要么 Actions → Deploy → Run workflow
```

- **变量没配 / 留空**：用上表「默认」列的值（也就是 `wrangler.toml` 里的默认），**不会**把空串绑给 Worker。
- **取值写错**（布尔写 `yes`/`1`、数字写负值或超量级）：`Resolve` 步骤**当场失败**并指出变量名，
  不会"静默按默认值跑"。
- 本地 `wrangler dev` 与线上**同一套默认**：改默认值请改 `wrangler.toml`；只想改线上就用变量覆盖。

| 开关 | `true` / 其它 | `false` |
|---|---|---|
| `UI_ENABLED` | 提供 Web 界面：两个挂载点（`/ui_old/` = 默认界面 V1、`/ui/` + `/ui/app/` = 开发测试版 V2）与 `/ui/api/*` 都可用，根路径对浏览器跳转到 `/ui_old/` | **整个界面关闭**：`/ui`、`/ui/*`、`/ui_old`、`/ui_old/*`（含静态资源与 `/ui/api/*`）一律 **404**，根路径返回 `Server is running.`。协议面（`/api/*`、`/SyncClipboard.json`、`/file/*`、Hub）**完全不受影响** |
| `ENFORCE_STRONG_CREDENTIALS` | 命中弱口令（文档化默认值 / 过短）时**所有通道 fail-closed**（500） | 只警告：响应头带 `x-credential-warning: weak` 并打一条 `[security]` 日志，服务照常 |

> `MAX_SAVED_HISTORY_COUNT` / `HISTORY_RETENTION_MINUTES` 直接换数字即可；上限分别是 1000000 条与
> 5256000 分钟（10 年），越界会被 `Resolve` 拦下。
>
> **这两个参数还有第二条生效路径（免重新部署）**：Web 界面的「维护」面板可直接在线改
> （`PUT /ui/api/settings`，值写进 D1 Meta 覆盖部署变量；填 `0` = 关闭该阶段、留空 = 清除覆盖、回落到变量）。
> 也就是说：**改保留策略不必重新部署**。代价是两处状态要分清 —— 变量是"默认值/兜底"，界面里改的是"当前覆盖值"，
> 界面里清除覆盖后又会回到变量。⚠️ 注意：若把界面关掉（`UI_ENABLED=false`），这条在线路径就没了，那时只能走变量。

#### `MAX_REQUEST_BODY_BYTES`：同步大文件时才需要动

写端点（`PUT /SyncClipboard.json`、`POST /api/history`、`PATCH /api/history/*`、`PUT /file/*`）有一个
请求体上限，**超限直接 413**。默认 **48 MiB**，可调到 **64 MiB**（允许范围 256 KiB–64 MiB）。

| 情形 | 你该做什么 |
| --- | --- |
| 同步的文件/文件夹都在 48 MiB 以内（客户端默认上限 20 MB，绝大多数情况） | **什么都不用做** |
| 有单个文件/文件夹超过 48 MiB 且 < 64 MiB | 把变量设成 `67108864`，重新部署 |
| 需要 >64 MiB 的单文件 | 当前架构不支持（写端点按"整包读入内存"设计），见下方说明 |

- **两层校验**：CI 的 `Resolve` 步骤按范围表拦（写错就让部署失败）；万一有值绕过 CI 到了 Worker
  （例如直接在控制台改），运行期会**回落默认值并打一条 `[limits]` 日志** —— 配置失误绝不升级成"写请求全 500"。
- **为什么上限不是"平台给的 100 MiB"**：真正约束不是"平台单请求 100 MiB"，而是**isolate 只有 128 MiB
  内存、且被所有并发请求共享**；超过我们允许的范围会有 isolate OOM 风险，而 OOM 会让**并发中的其他正常
  请求一起 503**，比"这次上传失败"严重得多。完整推导（含合计预算与默认值的取值依据）见
  [`docs/design.md`](docs/design.md) §7.1。
- **>64 MiB 的单文件**：需要把上传路径改成流式（架构级改动），可行性已评估、当前不做——
  结论记在 [`docs/progress.md`](docs/progress.md) §48.4。

#### 限速四参数：可以调，但**不建议变化**

`AUTH_RATE_LIMIT_WINDOW_MS` / `MAX_FAILURES` / `BLOCK_MS` / `BURST_WARN` 是认证失败的限速参数
（默认：15 分钟窗口内失败 10 次 → 封锁 15 分钟；全局 50 次失败只告警）。**请保持默认**：

- 它们是**削峰 + 防爆破的纵深防御**，不是访问控制边界（真正的门是 Basic 凭据）。
- 调松 = 缩短暴力破解的代价；调紧 = 客户端多设备/脚本反复试错时容易被误伤（封锁期内**正确凭据也会被拒**）。
- 唯二正当的调整场景：**被扫描时临时收紧**，或排障时临时放宽 —— 事后应改回默认。
- 允许范围与校验行为见 [`docs/design.md`](docs/design.md) §7.1 与 `src/rateLimit.ts`。

> **安全阀不建议做成开关**：zip 解压上限、hash/路径校验、单连接队列封顶等是安全边界，
> 保持"改代码才改"才是对的——配置项多了，边界就会被悄悄放宽。

**Basic Auth 凭据的两种管理方式**（任选）：

- **A. 手动设置一次**（默认）：`npx wrangler secret put USERNAME` / `PASSWORD`。
  不配 `SYNC_AUTH_CREDENTIALS`，CI 完全不接触凭据——凭据只存在于 Cloudflare。
- **B. 交给 CI 统一管理**：配好 `USERNAME`/`PASSWORD` secrets 并把 `SYNC_AUTH_CREDENTIALS`
  设为 `true`。每次部署同步一次，**轮换密码只需改 GitHub Secrets 一处**，适合想要"配置集中、
  全自动部署"的场景。

  代价是凭据会同时存在于 GitHub 与 Cloudflare 两处。实际增量风险很低：
  CI 里的 `CLOUDFLARE_API_TOKEN` 本身就有 D1/R2 的编辑权限（可读写全部剪贴板数据）
  与任意代码部署权限，信任前者即已信任后者。为降低暴露面，workflow 把凭据只注入
  **该步骤自己的 env**（不用 job 级 env），因此 `npm ci` 的依赖安装脚本读不到它们。

> 若你的仓库可能被他人提交 PR，注意：来自 fork 的 PR 默认拿不到 secrets，但**同仓库分支**
> 的 workflow 可以。多人协作场景建议改用方式 A。

## 客户端配置

官方客户端 →「添加账号」：

| 字段 | 值 |
|---|---|
| 类型 | **SyncClipboard**（不要选 WebDAV） |
| 服务器地址 | 你的 Worker 地址 |
| 用户名 / 密码 | 与 `USERNAME` / `PASSWORD` secrets 一致 |

> 选 `SyncClipboard` 类型才能启用实时推送与历史同步；选 WebDAV 会退化为轮询模式。

## Web 界面

部署完成后，浏览器打开 Worker 地址（根路径会自动跳到**默认界面** `/ui_old/`），用与客户端相同的
`USERNAME` / `PASSWORD` 登录，即可：

- 按类型 / 收藏筛选，**按时间范围筛选**（今天 / 近 7 天 / 近 30 天 / 自定义起止日期），全文搜索，
  按类型/大小/时间排序，翻页与每页条数切换
- **回收站**：查看已删除的记录（30 天内仍在），把还能恢复的记录一键恢复——
  数据文件在删除时已清除，故只有「文本且无数据文件」的记录可恢复，界面会禁用其余按钮并说明原因
- 预览文本全文、预览图片、下载文件；**数据文件已被清理的记录会明确显示「数据不可用」**，
  而不是裂图或静默失败
- 收藏 / **置顶** / 删除（单条与**批量**：批量收藏、取消收藏、置顶、恢复、删除）——
  写操作走与官方 `PATCH` 相同的实现，客户端会同步收到变更广播
- **实时更新**：页面可见时与 Hub 建立 WebSocket（用短期票据换连接，票据 10 分钟内可复用），别的设备一同步这边立刻可见；
  连接不可用时自动回落到轮询（10 秒），轮询始终保留为兜底
- **记录级深链接**：`/ui_old/#Text-<hash>`（默认界面）打开即预览该条，链接可直接分享/收藏；
  `/ui/#Text-<hash>` 这种入口写法也行 —— 那个跳转页会把 fragment 一起带过去
- **维护面板**（部署信息对话框内）：清理任务的运行状态与失败信息、数据完整性自检
  （找出「记录说有数据、存储里却没有对象」的条目）、保留策略在线调整（0 = 关闭该阶段）、清空全部历史；
  「清空回收站」在**回收站视图**的选择条上（那里才看得到要清的东西）
- 与服务器失去联系时（轮询/统计失败）页面顶部出现一条状态横幅，恢复后自动收起，
  而不是继续显示可能过期的数据
- 查看「部署信息」：客户端该填的服务器地址（可一键复制）、版本、传输方式、保留策略、存储占用

界面细节（模块划分、接口契约、鉴权模型、设计系统、验证记录）见 [`docs/ui.md`](docs/ui.md)。

> 界面与客户端**共用同一套凭据**。请务必改成强密码——默认口令 + 公开的 `*.workers.dev`
> 地址意味着任何人都能读到你的全部剪贴板历史。

## 日志与排障

Cloudflare 侧**没有"日志级别"这个东西**（上游的 `Logging:LogLevel` 在此没有对应物）：`console.*` 的输出
要么进实时流，要么进 [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)。
本项目两处都用：

- **实时**：`npx wrangler tail`（可加 `--status error` 只看失败、`--search '[cleanup]'` 按文本过滤、
  `--format json` 便于管道处理）
- **回看**：控制台 → Workers & Pages → 选本 Worker → **Observability**，按 Worker/时间/文本查询，**保留 7 天**。
  `wrangler.toml` 已显式声明 `[observability] enabled = true` —— 不写就依赖"新建 Worker 默认开启"这一平台
  默认（默认会变，而日志丢了不会报错）；采样率 `head_sampling_rate` 保持默认 1（全量），按本仓库规模
  （见下节容量提示）远在 2000 万条/月的免费额度内，成本为 0
- **不依赖日志的可观测面**：`GET /ui/api/info` 的 `cleanup: { lastRunAt, lastError, cursors }` 是清理任务
  每轮写进 D1 `Meta` 的状态，界面「部署信息」直接展示 —— **日志只是补充，不是唯一信息源**（超过 7 天的
  清理历史只有 Meta 这一份）

**日志约定**（改日志前先读）：

| 前缀 | 位置 | 内容 |
|---|---|---|
| `[cleanup]` | `src/cleanup.ts`、`src/index.ts` | 每阶段一行（`phase= status= processed= batches= truncated= cursor= subrequests= ms=`）+ 每轮一行汇总；失败另写 `[cleanup] error stage=…`，并落进 Meta 的 `cleanup:lastError` |
| `[DO] broadcast` | `src/durable/SyncClipboardHub.ts` | 每次写操作的广播（含在线连接数）；长轮询队列溢出另有一行 |
| `[HISTORY …]` | `src/routes/history.ts` | 历史上传被拒的原因（如 `hash is required`、`Hash contains invalid path characters`） |
| `[security]` | `src/auth.ts`、`src/rateLimit.ts` | 弱凭据告警（每个 isolate 一次）、认证失败突发告警 |

**隐私**：日志里**不出现剪贴板正文** —— 只有阶段名、计数、hash、文件名与错误消息（共 12 处 `console.*`
调用点，逐处核过）。新增日志时请沿用这条约定。

## 容量提示

- **Workers 免费版每天 10 万请求**。官方客户端即使在事件驱动模式下，也在每 10 秒跑一次
  `TestAliveHelper` 探活，而那次探活是**两个请求**（`PROPFIND /` + `/api/version`）。
  单客户端因此约 **17.3k 请求/天**，免费版大致可支撑 **≤5 个客户端**，更多需升级 Workers Paid。
- **Web 界面开着标签也会计费**，量级取决于推送通道是否连上（`/ui/api/poll` 一次 D1 读）：
  · **可见 + 推送已连接**（默认）：轮询降为 60 秒看门狗 ≈ **1.4k Worker 请求/天**；另有 DO 侧开销
    ——客户端每 30 秒一次 WS 心跳（≈2.9k 条/天）与 DO 每 15 秒一次心跳 alarm（≈5.8k 次/天），
    两者走 Durable Objects 的计量口径、**不占 Worker 请求额度**；
  · **可见但推送没连上**（被代理/CSP 阻断、DO 不可达）：退回 10 秒轮询 ≈ 8.6k 请求/天；
  · **标签在后台**：推送通道主动断开（省下那条常驻连接与心跳），轮询 30 秒 ≈ 2.9k 请求/天。
  作为对照：一个官方客户端的探活本身就是 ≈17.3k 请求/天。
- **单请求体上限**：默认 **48 MiB**（可调到 64 MiB），超限 413 —— 这是为了保住 isolate 的内存余量，
  见「部署开关」一节。
- **Group（文件夹）解压上限**：解压总量 64 MiB / 条目 1000 / 单条目压缩比 100:1，超限被拒。
- D1 / R2 的免费额度对个人剪贴板场景（文本与中小文件）通常绰绰有余。

## 安全基线

本服务端存放的是**剪贴板数据**（含口令、验证码、密钥类明文与文件附件），因此按"公网暴露 + 单一口令"的前提设计防护。当前已落地：

| 防护 | 行为 | 相关常量 / 开关 |
|---|---|---|
| 认证失败限速 | 同一 IP 或同一用户名在 15 分钟内失败 10 次即封锁 15 分钟（429 + `Retry-After`）；正确凭据不计数并清零；**失败路径不写 D1**（快路径在 isolate 内存，权威计数在 DO，低频落盘） | `src/rateLimit.ts` 的 `AUTH_RATE_LIMIT_*` |
| 写端点来源校验 | `/ui/api/*` 的 POST/PATCH/PUT/DELETE 拒绝外源 `Origin` 与 `Sec-Fetch-Site: cross-site`；无 `Origin` 的命令行客户端放行 | `src/index.ts` |
| 传输强制 | 明文请求（非 loopback）301 到 https；https 响应带 HSTS（`max-age=31536000; includeSubDomains`） | `src/index.ts` / `src/requestLimits.ts` |
| 请求体上限 | `PUT /SyncClipboard.json`、`POST /api/history`、`PATCH /api/history/*`、`PUT /file/*` 超过 **48 MiB**（可调至 64 MiB）直接 413 | `MAX_REQUEST_BODY_BYTES`（`src/requestLimits.ts`） |
| 归档解压上限 | Group zip：解压总量 64 MiB / 条目 1000 / 单条目压缩比 100:1（含 8 MiB 绝对下限，避免误伤小文件） | `src/hash.ts` |
| multipart | 分界串长度上限 70 字节（RFC 2046）；分界串查找为原生扫描（不再 O(体×串)） | `src/multipart.ts` |
| 长轮询队列 | 单连接队列上限 64 条 / 1 MB，超限关闭连接（204） | `src/durable/SyncClipboardHub.ts` |
| 清理可观测 | 清理按预算分阶段执行、游标续跑、失败写入 `cleanup:lastError`（`/ui/api/info` 可读） | `src/cleanup.ts` |
| 弱凭据检测 | `PASSWORD` 命中已知弱值或短于 8 位时，每个 isolate 打一次 `console.warn`，并在 `/api/version` 响应头给出 `x-credential-warning: weak`；默认**不阻断服务**（避免直接切断同步），需要强制时设 `ENFORCE_STRONG_CREDENTIALS=true` | `src/auth.ts` / `src/requestLimits.ts` |
| 界面静态资源的响应头 | `public/_headers`（这批文件由边缘直出、不经过 Worker）：CSP `default-src 'none'` + 逐项白名单（脚本/样式限本站；`connect-src 'self' wss: ws:`——`'self'` 对 websocket scheme 的解析各浏览器不一致，显式写死以免实时推送在部分浏览器被静默拦掉；`frame-ancestors 'none'`、`object-src 'none'`）、`nosniff`、`Referrer-Policy: same-origin`、`X-Frame-Options: DENY`，以及 js/css 的短 TTL + `stale-while-revalidate`（无指纹 ⇒ 部署后有 **≤5 分钟**的新旧混用窗口，之后自动收敛；强制刷新可立即取新版）。Worker 自出的 `/ui/*` 404 页另在 `src/ui/notFound.ts` 单独设 CSP——它不经过静态资源层 | `public/_headers` / `src/ui/notFound.ts` |

> **部署前必做**：`USERNAME` / `PASSWORD` 必须是**高熵随机值**。默认/占位口令 + 公开的 `*.workers.dev` 等于把全部剪贴板历史与附件
> 交给任何知道该口令的人（审计中已实测：用该口令可**离线假冒**会话 Cookie）。轮换方式见下方"方式 A/B"；轮换后需同步更新所有
> 客户端与 WebDAV/R2 工具的账号配置（否则表现为"同步无声坏掉"）。

安全审计的完整账目在本机工作区 `.audits/cfserver-audit-003/`（`report.md` 为报告）——**它被 `.gitignore:14` 排除、不在版本库内**，
版本库里可长期查阅的是修复计划 [`docs/security-fix-plan.md`](docs/security-fix-plan.md)，
其中**同时属于上游 SyncClipboard 的问题**整理为 [`docs/upstream-issues.md`](docs/upstream-issues.md)（15 条，附 `文件:行` 证据与复现）；
而「上游缺陷与怪癖在本实现里如何处置」逐条列在 [`docs/upstream-defects.md`](docs/upstream-defects.md)
（21 条候选：A 必须复刻 10 / B 有意偏离 5 / C 结构性消除 2 / D 待办 2 / 不改但需知 2）。

## 已知限制

- SignalR **三种传输**均已实现（WebSockets → ServerSentEvents → LongPolling，与上游宣告顺序一致），
  故 WS 被代理/防火墙阻断时客户端会自动降级，不会失联
- 第三方**畸形 zip**（隐式目录、重复条目、`a` 与 `a/` 同名冲突）的语义与上游存在 minor 差异
  ——官方客户端恒写显式目录条目且无重复，该路径不可达
- `Content-Type` 映射表小于 .NET 的 `FileExtensionContentTypeProvider`（客户端按文件名落盘，不校验该头）
- Web 界面可见时走 SignalR 实时推送（票据换 WebSocket，**不动协议侧的连接鉴权**：DO 本来就
  接受 `?id=<token>`，票据由 `/ui/api/hub-ticket` 签发），轮询保留为兜底：连上时 60 秒一次、
  未连上时 10 秒一次、页面隐藏时 30 秒一次；环境不支持或被稳定阻断时**连续失败 5 次后不再重试**
  （避免在坏环境里每 ≤60 秒白试一次），回前台会重新尝试
- Web 界面的图片缩略图依赖数据文件存在：对象已被清理的记录会显示占位与「数据不可用」
- **清理任务有吞吐上限，只在"批量场景"才可能被看见**：保留期/条数上限与孤儿回收由 Cron **每 20 分钟**
  跑一轮（软删单批 **500 条**，与上游一致）。日常使用（每天几十条剪贴板）每轮只处理 0~5 条，**完全无感**；
  但三种批量情形会看到"延迟"：把 `MAX_SAVED_HISTORY_COUNT` 调小、把保留期调短、换机后客户端一次重传几千条历史
  —— 等待期内这些记录仍算**活跃**（统计数字与客户端历史面板都还看得到），它们的数据文件也仍占 R2。
  实测 300 条过期记录与 500 条超量都是**一轮内**处理完，故延迟量级是"≤20 分钟 + 若干轮"
- **大文件会占用服务端内存**：上传落盘时服务端要把数据读进内存（R2 没有 move/rename，上游则用
  `File.Move` 不读数据），峰值 ≈ 文件大小。客户端默认单文件上限 20 MB，实测 20 MB / 60 MB 均正常；
  超过服务端上限（默认 48 MiB）会被 413 拒绝 —— 上限的取值依据与调整方法见「部署开关」一节
- **单账号单空间**：一个部署 = 一套凭据 = 一个剪贴板空间（与上游语义一致，非多租户）

## 项目结构

```
src/
├── index.ts            Worker 入口：鉴权、路由装配、SignalR 转发、Cron 处理
├── auth.ts             HTTP Basic 鉴权（UTF-8 解码、常量时间比较、401 语义）
├── hash.ts             Text / File / Image / Group 哈希算法（逐字节对齐上游）
├── profile.ts          Profile 服务端语义：校验、持久化、历史编排
├── db.ts               D1 访问层：CRUD、查询过滤、乐观并发更新
├── storage.ts          R2 访问层：暂存 / 持久 / 候选查找 / 孤儿清理
├── multipart.ts        multipart 解析（兼容 .NET 无引号 name 形式）
├── serialization.ts    DTO 序列化与枚举/时间解析
├── cleanup.ts          历史保留与清理（Cron 任务）
├── webdavXml.ts        WebDAV PROPFIND multistatus 生成
├── historyOps.ts       历史记录的写路径（官方 PATCH 与 Web 界面共用）
├── contentTypes.ts     附件 Content-Type 与响应头加固（WebDAV 与界面共用）
├── routes/             webdav.ts / history.ts
├── ui/                 Web 界面的服务端面：session / guard / query / routes / maintenance / notFound
└── durable/            SyncClipboardHub.ts（Hub）+ signalr.ts（协议编解码）
public/                 静态资源：robots.txt + _headers + ui_old/（默认界面 V1）+ ui/（开发测试版 V2）
                        文件清单以 docs/ui.md §3 为准（避免四处各列一份、加文件时漏更新）
test/                   全部 22 个套件 + live-signalr.mjs（线上验证脚本）
tools/                  ab-upstream-probe.ps1（与**官方服务端发布件**逐条 A/B 对照的探针/守卫）
docs/                   design.md / protocol.md / ui.md / progress.md / security-fix-plan.md / upstream-issues.md / upstream-parity.md / upstream-defects.md / backend-gaps.md / ui-v2-design.md / ui-v2-audit.md / frontend-checklist.md
AGENTS.md               行为契约（给 AI 代理与新人）：改代码顺手维护文档、完成定义、协议与前端红线
schema.sql              D1 建表语句
```

> `tools/ab-upstream-probe.ps1` 的用途、准备步骤与结果记录见 [`docs/design.md`](docs/design.md) §12（测试策略）
> 与 [`docs/progress.md`](docs/progress.md) §44 —— 它是**开发/验证**用的工具，日常使用不需要它。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **行为契约**（给 AI 代理与新人）：改代码顺手维护文档、完成定义（DoD）、V1/V2 约定、协议红线、提交与推送规矩 |
| [docs/design.md](docs/design.md) | 总体设计：架构、存储映射、核心数据流、决策记录、部署、风险 |
| [docs/protocol.md](docs/protocol.md) | 协议契约：逐条端点的精确行为、DTO 定义、哈希算法、SignalR 细节、差异表 |
| [docs/progress.md](docs/progress.md) | 开发与验证记录：里程碑、对照审核结果、版本历史 |
| [docs/ui.md](docs/ui.md) | Web 历史界面：功能融合清单、模块划分、接口契约、鉴权模型、设计系统、验证记录 |
| [docs/security-fix-plan.md](docs/security-fix-plan.md) | 安全审计修复计划（cfserver-audit-003 的 11 Findings）：优先级、逐条修复设计、实施状态 |
| [docs/upstream-issues.md](docs/upstream-issues.md) | 上游 SyncClipboard 自身的问题（15 条，附 `文件:行` 证据与复现），用于回馈上游 |
| [docs/upstream-parity.md](docs/upstream-parity.md) | 与上游 `28c7e596` 的逐文件对照报告：文件映射总表、差异与修复清单、风险分级、待确认项、上线结论 |
| [docs/upstream-defects.md](docs/upstream-defects.md) | **上游缺陷与怪癖的复刻清单**：16 条已复刻（契约/缺陷/结构性消除三分类）+ 5 条未复刻，逐条给处置决定与"为什么不能顺手改好" |
| [docs/backend-gaps.md](docs/backend-gaps.md) | 后端能力缺口与可完善项评估：已建未接（§1）/ 可新增（§2）/ 效率欠账（§3），附建议顺序与复核记录 |
| [docs/ui-v2-design.md](docs/ui-v2-design.md) | Web 界面 V2 设计与实现记录：骨架线框、设计令牌、组件词汇表、API 契约与验证记录 |
| [docs/ui-v2-audit.md](docs/ui-v2-audit.md) | Web 界面 V2 系统性审计报告：设计系统体检、类名契约、跨端交互与状态矩阵验证 |
| [docs/frontend-checklist.md](docs/frontend-checklist.md) | 前端质量检查清单：关注点、判据与落地指导原则 |
| [docs/AUDIT-redundancies.md](docs/AUDIT-redundancies.md) | 代码审计报告（冗余 / 重复实现 / 死代码 / 兼容红线）：结论分级、可删项清单，以及唯一的已实施记录 §14（含对自身判定的三处勘误） |
| [docs/AUDIT-commit-9b4cdca.md](docs/AUDIT-commit-9b4cdca.md) | 单次提交审核报告（`9b4cdca`）：逐行读 diff + 交叉核对服务端实现 + 跑本地质量门后的结论与整改项 |

## 许可证

[MIT](LICENSE)。

本项目是 SyncClipboard 服务端协议的独立重实现，其中协议行为、哈希算法与数据格式定义
移植自 [SyncClipboard](https://github.com/Jeric-X/SyncClipboard)（Copyright © 2022 JericX，MIT 许可），
原始版权声明已在 [LICENSE](LICENSE) 中保留。

## 致谢

- [SyncClipboard](https://github.com/Jeric-X/SyncClipboard) —— 客户端与服务端协议定义
- [clipserver](https://github.com/ting1e/clipserver) —— 同类服务端的参考实现与 Web 历史界面灵感来源
- [Hono](https://hono.dev/) —— 轻量 Workers Web 框架
- [fflate](https://github.com/101arrowz/fflate) —— 纯 JS zip 解压（Workers 兼容）
