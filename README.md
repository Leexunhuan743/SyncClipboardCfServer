# SyncClipboard CfServer

这是 [SyncClipboard](https://github.com/Jeric-X/SyncClipboard) 官方服务端的 Cloudflare Workers 重写实现。

原版基于 ASP.NET Core 开发。本项目使用 TypeScript 重写，运行在 Cloudflare 边缘网络上，依赖 D1 数据库、R2 对象存储和 Durable Objects。官方客户端不需要任何修改，将服务器地址指向部署好的 Worker 即可使用剪贴板实时同步、历史记录查询以及跨设备历史同步。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 协议与功能差异

SyncClipboard 官方客户端支持三类服务端，能力不同：

| 能力 | 官方 C# 服务端 | 本项目（Cloudflare Workers） | WebDAV 存储 | S3 兼容存储 |
|---|---|---|---|---|
| 同步机制 | SignalR WebSocket 实时长连接 | SignalR WebSocket 实时长连接（Durable Objects） | 定时轮询 | 定时轮询 |
| 历史记录面板 | 支持 | 支持 | 不支持 | 不支持 |
| 历史记录跨设备同步 | 支持 | 支持 | 不支持 | 不支持 |
| 部署与运维要求 | 需要自备 VPS / Docker / 进程守护 | Cloudflare 无服务器部署，按量计费，个人用量在免费额度内 | 依赖现有 WebDAV 服务 | 依赖现有 S3 服务 |

本项目复刻了官方服务端全部接口，包括 WebDAV 端点、SignalR Hub 和 `/api/history/*` 历史记录接口。在此基础上，新增了内置的 Web 历史管理界面。

部署完成后，在电脑或手机浏览器中打开 Worker 地址，根路径会自动跳转至 Web 界面。使用与客户端相同的用户名和密码登录。

| Web 历史记录管理主界面（桌面） | 同一界面（手机竖版 480×1040） | 登录验证与状态提示 |
| :---: | :---: | :---: |
| ![Web 历史管理主界面](docs/images/07-ui-v1.png) | ![手机竖版的 Web 历史管理界面](docs/images/07-ui-v1-mobile.png) | ![登录验证与状态提示](docs/images/18-state-login-error.png) |

### 已知限制（会影响使用的行为差异）

协议接口与官方服务端逐条对齐；下表只列**普通使用中可能碰到的不同**，写法尽量不含实现细节
（每条的技术依据与逐条登记在 `docs/protocol.md` §10）：

| 方面           | 官方服务端                                | 本项目（cfserver）                                                     | 影响与对策                                                               |
| ------------ | ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| 删除后能否找回      | 移到回收站时**数据文件一并删除** —— 图片/文件删了就找不回来   | 数据文件跟着记录保留，回收站里可**连数据一起恢复**；30 天后才真正清理                            | 好处是能恢复；代价是多占最多 30 天存储。想立刻腾空间点「彻底删除 / 清空回收站」                         |
| 单次上传大小       | 不限制                                  | 默认上限 **48 MiB**（可调到 64 MiB），超过返回 413                              | 客户端默认单文件 20 MB，不受影响；确实要同步更大文件时调 `MAX_REQUEST_BODY_BYTES`（免费 cf 的限制） |
| 文件夹与大文本      | 不限制：压缩包全量解压，文本多长都收                   | 压缩包：解压后总量 64 MiB、条目 1000 个、**单个条目 24 MiB**、膨胀比 100:1；单条内联文本 1 MiB | 超过上限时同步失败（返回 422 / 400）。官方客户端默认 20 MB 以内基本碰不到（免费 cf 的限制）            |
| 历史清理节奏       | 过期记录每 10 分钟处理一次；回收站与孤儿文件每 12 小时一次    | 每 20 分钟跑一轮（三类一起做），单轮有资源预算，积压多时分多轮完成                               | 调小保留期后记录不会立刻消失，最多等一轮（20 分钟）+ 若干轮；期间这些记录仍算活跃（免费 cf 的限制）              |
| 访问不存在的地址     | 直接 404，不计入风控                         | 未带凭据时返回 401，并**计入失败次数**                                           | 同一 IP 15 分钟内失败 10 次会临时封锁 15 分钟（到期自动恢复）；正常使用不受影响                     |
| 数据迁移         | 历史存在本机 `history.db` 文件里              | 历史存在 Cloudflare D1（两者表结构不同）                                       | **不能直接把 `history.db` 导入**；换服务端后让客户端重新同步历史即可                         |
| 第三方工具造的畸形压缩包 | 重复条目会重复计入体积；`.`/`..` 这类路径按操作系统归一化后接受 | 重复条目只算一次；`.`/`..` 一律拒绝                                            | 官方客户端生成的压缩包不含这些形态；第三方工具造的畸形包可能同步失败                                  |

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

    W --> D1[("D1<br/>历史记录与当前 Profile")]
    W --> R2[("R2<br/>file/ 暂存 + history/ 持久数据文件")]
    NEG --> DO["Durable Object<br/>SyncClipboardHub"]
    C1 <-->|WebSocket| DO
    C2 <-->|WebSocket| DO
    DAV -.广播.-> DO
    API -.广播.-> DO
    UI -.广播.-> DO
    DO -.RemoteProfileChanged / RemoteHistoryChanged.-> C1
    DO -.RemoteProfileChanged / RemoteHistoryChanged.-> C2
```

- **Workers (Hono)**：处理 HTTP 路由、鉴权与文件流。
- **D1 (SQLite)**：存储历史记录元数据、当前剪贴板状态（Profile）以及系统配置。
- **R2**：存储剪贴板附件数据。`file/` 作为暂存区，`history/` 存放持久化文件。
- **Durable Objects**：作为 SignalR Hub 维持 WebSocket 长连接，处理心跳并向所有在线客户端广播数据变更通知。
- **静态资源 (Assets)**：托管 Web 历史管理界面，请求经过 Worker 判定开关后提供服务。

## 客户端支持

- **版本要求**：官方客户端 **v3.1.1 或更高版本**（协议基准格式要求）。
- **客户端下载**：前往官方发布页下载：[SyncClipboard Releases](https://github.com/Jeric-X/SyncClipboard/releases)。支持 Windows (WinUI3 / WPF)、Android、macOS 等平台。
- **服务端版本伪装**：Worker 对 `/api/version` 接口固定返回 `3.3.0-beta1`，与官方服务端基准版本一致，避免客户端版本检查拦截。

## 准备工作

部署前需要准备好：
1. **Cloudflare 账号**：拥有 Workers、D1、R2 和 Durable Objects 使用权限（个人免费计划即可）。
2. **Node.js 环境**：Node.js 20 或更高版本（如果采用命令行部署）。
3. **设置凭据意识**：服务端通过 HTTP Basic 鉴权保护所有剪贴板数据。你需要自行指定一组用户名和密码，不要使用默认或简单弱口令。

## 部署

部署提供两种方式：本地命令行部署与 GitHub Actions 自动部署。

两种方式部署出的 Worker 实例行为相同。区别在于**资源由谁创建**：**方式一（命令行）**需要你先在 Cloudflare 建好 D1 数据库与 R2 存储桶，并把真实的 `database_id` 填进配置文件；**方式二（GitHub Actions）不需要** —— 工作流会在部署前按库名自动创建或复用它们（见方式二第 2 步）。

### 方式一：命令行部署（Wrangler CLI）

1. **克隆项目并安装依赖**：
   ```bash
   git clone https://github.com/leeexx/SyncClipboardCfServer.git
   cd SyncClipboardCfServer
   npm install
   ```

2. **登录 Cloudflare**：
   ```bash
   npx wrangler login
   ```
   浏览器会自动打开授权页面，按提示完成登录。在无图形界面的终端（如 SSH 会话）中操作时，可直接设置环境变量 `export CLOUDFLARE_API_TOKEN="你的Token"` 免去网页交互。

3. **创建 D1 数据库与 R2 存储桶**：
   ```bash
   npx wrangler d1 create syncclipboard
   npx wrangler r2 bucket create syncclipboard
   ```
   命令执行后，终端会输出 D1 的 `database_id`（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）。
   打开根目录下的 `wrangler.toml`，找到 `[[d1_databases]]` 配置块，将 `database_id` 替换为你刚刚生成的真实 ID：
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "syncclipboard"
   database_id = "在这里粘贴你的 database_id"
   ```

4. **初始化线上 D1 数据库表**：
   ```bash
   npx wrangler d1 execute DB --remote --file=./schema.sql
   ```
   这一步会创建存储历史记录所需的表和索引，操作具备幂等性。

5. **设置访问凭据（用户名与密码）**：
   通过 Cloudflare Secret 设置剪贴板服务的自定义用户名和强密码：
   ```bash
   npx wrangler secret put USERNAME
   npx wrangler secret put PASSWORD
   ```
   按提示输入你计划使用的用户名和密码。这两项凭据将在后续客户端连接和网页登录中使用。

6. **发布部署**：
   ```bash
   npm run deploy
   ```
   部署完成后，终端会显示分配的 Worker 访问地址（例如 `https://syncclipboard-cf-server.<你的子域名>.workers.dev`）。

---

### 方式二：GitHub Actions 自动部署

1. **Fork 本仓库**到你自己的 GitHub 账号。
2. 手动建资源 **（普通用户略过）**
   CI 会在部署前**按库名**创建/复用 D1 数据库 `syncclipboard` 与 R2 存储桶 `syncclipboard`
   —— 你**不需要**事先在 Cloudflare 上创建它们，也**不需要**把任何 `database_id` 填进 `wrangler.toml`
   （仓库里那份 `database_id` 是**全零占位值**，部署时由 CI 在 runner 内注入真实 id、不回写仓库）。
   因此 fork 之后**同步上游（`Sync fork`）也不会破坏部署**：每次都会按库名重新解析到同一个库。除非如下两种情况：
   > 想钉住到某个特定库（例如保护已有数据不被误重建）就设仓库变量 `D1_DATABASE_ID`；
   > 想禁止 CI 自动建库（缺库时报错而不是建一个新空库）就设 `D1_BOOTSTRAP=false`。
3. **配置 GitHub Secrets**（必填）：
   在 GitHub 仓库进入 `Settings` → `Secrets and variables` → `Actions` → `Secrets`，添加以下机密项：
   - `CLOUDFLARE_API_TOKEN`：Cloudflare API 令牌。在 Cloudflare 控制台「My Profile」→「API Tokens」中生成，需要拥有以下权限：
     - `Account` - `Account Settings: Read`
     - `Account` - `Workers Scripts: Edit`
     - `Account` - `D1: Edit`
     - `Account` - `R2: Edit`
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID。可在 Cloudflare 控制台 Workers 页面右**侧栏/地址栏**复制，是一长串字符。
   - `USERNAME` / `PASSWORD`：可选。自定义的同步用户名和密码。不填也可以通过命令行手动设置。
4. **配置 GitHub Variables（部署开关）**（建议默认）：
   在同页面的 `Variables` 选项卡中，可按需添加以下仓库变量（不填则使用默认值）：

   | 变量名 | 默认值 | 作用说明 |
   |---|---|---|
   | `UI_ENABLED` | `true` | 是否开启 Web 历史界面。设为 `false` 时关闭全部 WebUI 路由与静态资源，仅保留协议同步功能。 |
   | `MAX_SAVED_HISTORY_COUNT` | `1000` | 历史记录保留条数上限（超过的旧记录会在定时清理时被软删除）。**0 = 不限制条数**。 |
   | `HISTORY_RETENTION_MINUTES` | `0` | 历史记录保留时长（单位分钟）。**0 = 不限制**（默认 0，对齐上游 3.3.0 的默认值）⇒ 默认不做按时间的清理，只由条数上限兜底；要看住敏感历史就填一个正数（如 `10080` = 7 天）。 |
   | `MAX_REQUEST_BODY_BYTES` | `50331648` | 单次上传请求体大小限制，默认 48 MiB（允许范围 256 KiB–64 MiB）。 |
   | `ENFORCE_STRONG_CREDENTIALS` | `false` | 设为 `true` 时，检测到弱密码会直接中断服务（返回 500）。默认仅打出安全警告。 |
   | `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` | 认证失败统计窗口（毫秒，默认 15 分钟；范围 1 分钟–24 小时）。 |
   | `AUTH_RATE_LIMIT_MAX_FAILURES` | `10` | 该窗口内允许的最大失败次数（范围 3–100），超过即封锁来源。 |
   | `AUTH_RATE_LIMIT_BLOCK_MS` | `900000` | 封锁时长（毫秒，默认 15 分钟；范围 1 分钟–24 小时）。 |
   | `AUTH_RATE_LIMIT_BURST_WARN` | `50` | 全局失败告警阈值（范围 10–10000），只影响日志。 |
   | `D1_DATABASE_ID` | （未设置） | 钉住要绑定的 D1 库 id；不设置时按库名 `syncclipboard` 自动解析（不存在则创建）。它写在 GitHub 设置里，`Sync fork` 不会把它冲掉。 |
   | `D1_BOOTSTRAP` | `true` | 是否允许 CI 在库不存在时**自动创建**。设为 `false` 则缺库直接报错 —— 适合「已有数据、怕误重建」的场景。 |

   > 上面四个 `AUTH_RATE_LIMIT_*` 属于防暴力破解参数，**通常保持默认即可**（默认策略见「功能与安全」一节的说明）；
   > 运行期的校验范围另见 `src/rateLimit.ts` 的 `AUTH_RATE_LIMIT_RANGES`（与 CI 里的范围校验一致）。
   >
   > `MAX_SAVED_HISTORY_COUNT` 与 `HISTORY_RETENTION_MINUTES` 除了在此处通过变量设置，也可以在 Web 界面的「维护面板」中直接在线修改。设置会写入 D1 数据库的 Meta 表并立即生效，不需要重新部署。在界面中清空设置即可恢复使用这里的变量值。

5. **触发部署**：
   推送代码变更到 master 分支，或者在 GitHub 仓库的 `Actions` 页面找到「Deploy」工作流点击「Run workflow」手动执行。CI 会自动跑完代码检查、测试套件并完成部署。
   **部署完成后点开这次 run，Summary 里就有服务器地址**（含客户端该选什么类型、界面入口）。
    `Actions`完整链路：`quality`（typecheck + lint + 22 个套件）→ 解析/创建资源 → `Deploy Worker` → 同步凭据 → 只读冒烟检查。

---

### 域名绑定与网络访问

Cloudflare 默认分配的 `*.workers.dev` 域名在部分国内运营商网络下存在 DNS 污染或连接不稳定问题。

如果官方客户端连接时频繁超时，建议绑定自定义域名：
1. 在 Cloudflare 控制台中，确保你有一个托管在此账号下的域名（自行查阅相关资料）。
2. 进入 Worker 详情页，点击「Settings」→「Domains & Routes」→「Add」→「Custom Domain」。
3. 绑定一个二级域名（例如 `clip.yourdomain.com`）。
4. 在客户端与浏览器中，将请求地址改为绑定的自定义域名。

---

### 升级与数据备份

- **服务升级**：后续版本更新时，数据库建表脚本具备幂等性，升级不会影响已有剪贴板历史。
  - 命令行部署：拉取最新代码，执行 `npm install && npm run deploy`。**已有库新增列**（如 `TransferDataHash`）
    用 `node tools/migrate-d1.mjs --remote`（幂等，可重复执行；`--local` 修本地库）——
    ⚠️ `schema.sql` 的 `CREATE TABLE IF NOT EXISTS` 只对新库生效，**老库加列必须跑迁移脚本**，否则
    新代码的每次写库都会因缺列失败。
  - GitHub Actions 部署：在你的 Fork 仓库页面点击「Sync fork」同步上游更新，推送到 master 分支后会自动触发重新部署（CI 已内置迁移步骤，部署前自动执行）。
- **数据备份**：剪贴板历史保存在 D1 数据库中，可通过官方命令导出本地 SQL 备份：
  ```bash
  npx wrangler d1 export DB --remote --output=./backup.sql
  ```

---

## 客户端配置

在各设备上打开 SyncClipboard 官方客户端，进入设置添加账号：

| 配置项       | 填写内容与示例                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| **类型**    | 必须选择 **`SyncClipboard`**（勿选择 WebDAV。WebDAV 走轮询，无法使用实时推送与历史面板）                 |
| **服务器地址** | 填写你的 Worker 地址，例如 `https://clip.yourdomain.com`（必须带 `https://`，末尾不要加斜杠或多余子路径） |
| **用户名**   | 对应设置的 `USERNAME` 凭据                                                           |
| **密码**    | 对应设置的 `PASSWORD` 凭据                                                           |

保存配置后，客户端状态指示灯应变为就绪状态。在任意一台设备上复制文本或图片，其他设备会在短时间内自动同步。服务端采用单空间设计（与官方服务端一致），配置相同地址与凭据的设备共享同一套剪贴板与历史。多用户独立使用需要分别部署不同的 Worker 实例。

---

## 容量估算与限制

### 请求量与免费额度

Cloudflare Workers 免费计划提供每日 10 万次请求额度：
- **客户端探活消耗**：官方客户端处于后台运行时，每 10 秒会执行一次长连接保活检查，每次包含两个请求（`PROPFIND /` 和 `GET /api/version`）。
- **单客户端请求量**：一个客户端全天保持运行，每天约产生 `(86400 / 10) * 2 ≈ 17,280` 次请求。
- **承载量**：5 台客户端同时全天在线时，每天基础心跳约产生 8.6 万次请求，落在 10 万次免费额度内。多于 5 台客户端长时间运行建议升级为 Workers Paid 计划。

### Web 界面连接消耗

- **网页处于前台且 WebSocket 连接正常**：维持一条常驻长连接，轮询降级为 60 秒一次看门狗检查（每天产生约 1,440 次 Worker 请求）。心跳走 Durable Objects，不计入 Worker 请求次数。
- **网页处于后台（标签页被隐藏）**：前台 WebSocket 连接会主动断开以节约资源，改为 30 秒一次低频轮询（每天约 2,900 次请求）。

### 上传大小与并发内存

- **单文件大小限制**：写端点对请求体进行了拦截保护，默认上限为 **48 MiB**，最大允许放宽至 **64 MiB**。超出限制的请求会直接返回 413 状态码。
- **内存考量**：Cloudflare Workers 每个 isolate 的内存为 128 MiB，由所有并发请求共享。因为 R2 无法像传统文件系统那样直接重命名文件，上传时需要将文件数据读入内存计算哈希并写入存储。限制在 48~64 MiB 是为了预留内存，避免并发写入时出现内存溢出（OOM）导致其他正常请求一并返回 503。
- **大文本同步**：复制超过 10,240 字符的长文本时，服务端自动将其转存为数据流文件，客户端可完整同步全文。
- **文件夹（Group）压缩包**：支持同步文件夹，解压总量限制为 64 MiB，解压条目上限 1,000 项，**单条目上限 24 MiB**，单文件解压膨胀比上限 100:1（完整上限清单见上文「已知限制」）。

### 历史记录清理机制

后台定时任务通过 Cron Trigger 每 20 分钟执行一轮，单批处理 500 条记录。**默认只按条数上限（1000 条，收藏/置顶豁免）回收**——保留期默认 0 = 不限制；要按时间自动清理需显式设置 `HISTORY_RETENTION_MINUTES`。被软删的记录连同数据进回收站（最长留 30 天后硬删）。如果换机后客户端一次性同步数千条历史，或者临时大幅缩短了保留时间，超期记录不会立刻在页面中消失，需要等待数轮清理任务（每轮间隔 20 分钟）逐步分批删除。在此期间这些记录仍属于活跃状态。

---

## 安全机制

服务端存放剪贴板明文与附件，包含以下防护：

- **认证失败限速**：同一 IP 或用户名在 15 分钟内认证失败达到 10 次，会对该来源封锁 15 分钟（返回 429）。统计计数在 isolate 内存与 Durable Objects 中维护，认证失败的请求不会写入 D1 数据库。**未带凭据访问未知路径也会计入该计数**（协议端点一律要求认证），因此同一 IP 短时间内打错 10 次地址同样会被临时封锁。
- **请求来源检查**：Web 界面的写接口（`/ui/api/*`）会校验请求头中的 `Origin` 与 `Sec-Fetch-Site`，拦截跨站伪造请求。
- **传输加密**：非本地地址的明文 HTTP 请求会自动 301 重定向至 HTTPS，响应头包含 HSTS。
- **弱口令防护**：使用常见默认密码或长度少于 8 位时，系统会在控制台输出警告日志。开启 `ENFORCE_STRONG_CREDENTIALS=true` 后，命中弱密码的所有通道会直接返回 500 阻止访问。
- **静态资源安全头**：界面静态资源声明了内容安全策略（CSP）、禁止 MIME 嗅探（`nosniff`）以及禁止页面嵌套（`X-Frame-Options: DENY`）。

---

## 日志查看与排障

### 实时日志与历史查询

Cloudflare 不支持传统意义上的文件日志级别配置，日志通过以下两种途径查阅：
1. **实时日志流（CLI）**：
   ```bash
   npx wrangler tail
   ```
   可添加过滤参数：只看报错 `npx wrangler tail --status error`；按关键字搜索 `npx wrangler tail --search '[cleanup]'`。
2. **控制台历史日志**：
   登录 Cloudflare 控制台，进入「Workers & Pages」→ 选择当前 Worker → 点击「Observability」选项卡，可按时间区间和状态筛选查看过去 7 天内的调用与异常日志。

### 常见日志标识

- `[cleanup]`：后台定时清理任务运行信息。打印每阶段处理条数、批次、子请求消耗量。
- `[DO] broadcast`：SignalR Hub 处理状态变更与向客户端广播消息的记录。
- `[security]`：弱密码警告或认证失败突发告警。
- `[HISTORY ...]`：历史上传被服务端拒绝的具体原因（如缺少哈希、非法字符路径等）。

### 常见问题排查

- **客户端连接失败、指示灯为红色**：
  - 检查填写的地址是否以 `https://` 开头。
  - 检查网络是否能直接连通 `workers.dev` 域名。如果存在网络阻断，切换为自定义域名。
  - 检查用户名和密码是否与 Cloudflare Secret 中的配置相符。
- **客户端或浏览器提示 429 Too Many Requests**：
  - 触发了服务端的防暴力破解限速。默认策略为：15 分钟内认证失败超过 10 次，会对该 IP 封锁 15 分钟。请检查客户端是否有设备使用了旧密码反复重试。封锁期结束后会自动解除。
- **同步大文件或图片失败，报错 413**：
  - 上传的文件体积超过了当前配置的 `MAX_REQUEST_BODY_BYTES`（默认 48 MiB）。
- **历史记录清理有延迟**：
  - 定时清理任务通过 Cron Trigger 每 20 分钟执行一轮，单批处理 500 条记录。若单次删除大量记录或调小了保留时长，需要等待数轮清理任务逐步回收存储。

---

## 本地开发与测试

运行本地开发环境使用 Miniflare 模拟 Cloudflare 运行时：

```bash
npm install

# 初始化本地 D1 数据库（保存在 .wrangler 目录下）
npx wrangler d1 execute DB --local --file=./schema.sql

# 配置本地环境变量与测试凭据
cp .dev.vars.example .dev.vars

# 启动本地开发服务（默认监听 127.0.0.1:8787）
npm run dev
```

运行测试（22 个套件）：

```bash
# 类型检查与 ESLint
npm run check

# 运行纯算法与单元测试（无需启动服务）
npx vitest run test/hash.test.ts test/fixes.test.ts

# 运行全部集成测试套件（必须先在后台启动本地 dev 服务）
npm test
```

**写库套件默认只允许指向本机**：七个套件（`protocol`、`fix-regressions`、`transports`、`signalr`、`cleanup`、`query-filters`、`ui`）会创建/删除历史记录与 R2 对象，因此当目标地址非 `127.0.0.1` 或 `localhost` 时会默认拒绝执行，防止误删线上数据。如需向特定远端实例执行测试，必须显式附加参数：`ALLOW_REMOTE_TARGET=1 BASE=https://your-worker.workers.dev npm test`。

---

## 项目结构

```
src/
├── index.ts            Worker 入口，路由装配、鉴权中间件与 Cron 调度
├── auth.ts             HTTP Basic 鉴权处理与常量时间防时序攻击比较
├── hash.ts             Text、File、Image、Group 数据的哈希计算（逐字节对齐官方实现）
├── profile.ts          剪贴板 Profile 数据校验与状态持久化
├── db.ts               D1 数据库访问层与乐观并发控制
├── storage.ts          R2 对象存储读写、暂存区维护与孤儿文件回收
├── cleanup.ts          保留期裁剪、条数限制与孤儿清理后台任务
├── routes/             WebDAV 与官方 history 相关业务路由
├── ui/                 Web 界面服务端接口与会话管理
└── durable/            SignalR Hub（WebSocket 连接维持、心跳与广播）
public/                 静态资源：robots.txt + _headers + ui_v1/（默认界面 V1）+ ui_v2/（开发测试版 V2）+ ui_shared/（两版共用的品牌图标与图标表）+ ui/（/ui/ 的跳转壳）
schema.sql              D1 数据库建表与初始元数据语句
wrangler.toml           Cloudflare Worker 配置文件与绑定声明
test/                   测试套件（集成测试、协议回归测试、文档口径测试）
```

---

## 相关文档

- [docs/project-analysis.md](docs/project-analysis.md)：系统全景架构解析、时序图与数据模型
- [docs/design.md](docs/design.md)：系统总体架构设计、决策记录与存储映射
- [docs/protocol.md](docs/protocol.md)：官方协议逐条对照、DTO 契约与已知差异表
- [docs/ui.md](docs/ui.md)：Web 历史界面的接口设计、鉴权模型与前端规范
- [docs/security-fix-plan.md](docs/security-fix-plan.md)：安全审计与已知安全加固项说明
- [AGENTS.md](AGENTS.md)：开发行为契约与代码维护规范

## 许可证

[MIT LICENSE](LICENSE)。

本项目是 SyncClipboard 服务端协议的独立重实现，其中协议行为、哈希算法与数据格式定义
移植自 [SyncClipboard](https://github.com/Jeric-X/SyncClipboard)（Copyright © 2022 JericX，MIT 许可），
原始版权声明已在 [LICENSE](LICENSE) 中保留。

## 致谢

- [SyncClipboard](https://github.com/Jeric-X/SyncClipboard) —— 客户端与服务端协议定义
- [clipserver](https://github.com/ting1e/clipserver) —— 同类服务端的参考实现与 Web 历史界面灵感来源
- [Hono](https://hono.dev/) —— 轻量 Workers Web 框架
- [fflate](https://github.com/101arrowz/fflate) —— 纯 JS zip 流式解压（Workers 内存安全兼容）
- [Microsoft ASP.NET Core SignalR](https://github.com/dotnet/aspnetcore) —— 实时推送协议规范与测试套件通信基准
- [Lucide Icons](https://lucide.dev/) —— Web 管理界面的内嵌极简 SVG 矢量图标
