# Web 历史界面（默认界面 V1 `/ui_v1/`；开发测试版 V2 `/ui_v2/`）

本文件描述本项目的 Web 界面：它的来源、与协议面的边界、模块划分、鉴权模型、设计系统与验证记录。

**一句话**：界面把另一个实现（Python 项目 `clipserver`）里「用浏览器看剪贴板历史」这件事，按本项目的
架构重写了一遍——数据面完全复用官方历史 API 的同一套表与语义，另开一层只为界面服务的
`/ui/api/*`，不动任何客户端依赖的协议行为。

> **待落地的一档能力**：重格式（PDF/Office/压缩包/邮件/音视频）目前只能下载 —— 把它们接成
> 「文档预览」的决策、方案、CSP 放宽清单与过程日志见
> [`ui-document-preview.md`](ui-document-preview.md)（方案已定并**已获授权**，实现进行中；本文 §3.2 之后
> 的内容仍描述**当前**实现）。

---

## 1. 来源与取舍（融合清单）

`clipserver` 是一个 FastAPI + WsgiDAV 的 Python 服务端：WebDAV 端点 + 钩住 `SyncClipboard.json`
写入落库 + 一个 Web 历史界面。逐项对照后的处置：

| # | clipserver 的能力 | 本项目的处置 |
|---|---|---|
| 1 | WebDAV 服务端 | **已具备**（且更完整：PROPFIND 207、`DELETE /file/{name}`、无引号 multipart 兼容等） |
| 2 | 剪贴板更新落库 | **已具备**（写入路径在 `PUT /SyncClipboard.json` 与 `POST /api/history`，含版本/去重语义） |
| 3 | 类型识别 Text/Image/File/Group | **已具备**（`ProfileType` 枚举，含位掩码筛选） |
| 4 | 数据文件归档 | **已具备**（R2 `history/{Type}_{Hash}/{file}`） |
| 5 | **Web 历史界面** | **本轮新增**（见下） |
| 5a | 列表分页、每页条数可选 | 新增：UI 层支持 20/50/100/200，官方 API 保持固定 50 |
| 5b | 类型筛选 / 搜索 / 收藏筛选 / 日期范围 | 复用官方查询语义（`Types` 位掩码、`SearchText`、`Starred`、`Before/After`）；**日期范围本轮接入**：预设（今天 / 近 7 天 / 近 30 天）+ 自定义区间，边界按**本地日界**计算 |
| 5k | **回收站**（查看已删除 / 恢复） | **本轮新增**：`deleted=true` 只看已删除行（`src/ui/query.ts`）；可恢复的（无数据文件）给出「恢复」，其余禁用并说明原因——判据与服务端守卫一致，见 §5 第 4 条 |
| 5c | 多列排序（id/type/size/created_at） | 新增：UI 层支持 6 个排序字段 + 升降序；官方 API 仍只有 createTime/lastAccessed |
| 5d | 收藏切换 | 复用 `PATCH`（星标/置顶），走与官方 PATCH 同一个实现 |
| 5e | 删除 / 批量删除 | 单条复用 `PATCH isDelete`；批量是 UI 独有的选择集语义 |
| 5f | 文本预览、图片预览、文件下载 | 新增（浏览器端；数据经 `/ui/api/.../data`，同源 Cookie 鉴权） |
| 5j | **复制到剪贴板**（文本 / 图片） | 新增：文本走 `writeText`，图片走 `ClipboardItem`（非 PNG 先转码；`File` 的文件名是位图扩展名时同样按图片处理）。写入结果可判别（`unsupported` / `failed` + 底层原因），失败降级到预览。**成功路径未能在本环境验证，边界见 §10** |
| 5g | 统计（总数/按类型/最近同步） | 复用 `statistics` 并补按类型分布 |
| 5h | 自动刷新新记录 | **改进**：由轮询变更信号驱动（原实现是整页轮询），且只重拉当前页 |
| 5i | 登录 / 登出 / 会话 | 新增（签名 Cookie，见 §4） |
| 6 | `/api/info` 存储信息 | 新增为「部署信息」对话框，直接给出客户端该填的服务器地址 |
| 7 | Docker 部署 | **不适用**（本项目部署在 Cloudflare Workers） |
| 8 | Unix 风格 `/dav` 前缀 | **有意不实现**，见 ADR D15 |

**没有照搬的部分**：clipserver 的接口形状（`GET /api/history`、`/api/file/{id}`、`/api/stats`…）
与前端 JS 都没有移植——那样会在同一个 Worker 上造出第二套语义。界面改用本项目已有的官方历史 API
作为数据面，只为自己需要的差异（可变页大小、多列排序、选择集、缩略图）新开 `/ui/api/*`。

---

## 2. 架构与边界

```
浏览器
  │  GET /                 → Worker：302 → `/ui_v1/`（默认界面；Accept: text/html 才跳）
  │  GET /ui/**            → Cloudflare 静态资源（public/ui/**，`/ui/` = 跳转壳，送到 /ui_v1/）
  │  GET /ui_v1/**        → Cloudflare 静态资源（public/ui_v1/**，V1 = 默认界面）
  │  GET /ui_v2/**        → Cloudflare 静态资源（public/ui_v2/**，V2 = 开发测试版）
  │      ↑ 三个面都先经过 Worker：`run_worker_first = ["/ui", "/ui/*", "/ui_v1", "/ui_v1/*", "/ui_v2", "/ui_v2/*"]`
  │        + `binding = "ASSETS"` —— 入口据此判断界面开关（UI_ENABLED），开着才转回
  │        `env.ASSETS.fetch()`，关着直接 404
  │  GET/PATCH /ui/api/**  → Worker：src/ui/routes.ts（会话 Cookie 或 Basic 鉴权）
  │  GET /ui/api/**/data   → Worker → R2（图片预览 / 文件下载）
  ▼
Worker
  ├─ src/ui/*        UI 自己的面（本文件描述）
  ├─ src/routes/*    协议面（/api/history/*、/SyncClipboard.json、/file/*）—— 客户端依赖，**未改动语义**
  └─ src/durable/*   SignalR 兼容 Hub（客户端连接用；Web 界面亦可通过 /ui/api/hub-ticket 换取票据接入实时推送，见 §3.3 第 8 条与 §6）

### 2.1 界面开关（`UI_ENABLED`，默认开）

两个界面面原本都由 Cloudflare 直接托管、**不经过 Worker** —— 那样的话"关掉界面"就无从实现。
2026-09-15 起 `[assets]` 增加了 `binding = "ASSETS"` 与 `run_worker_first = ["/ui", "/ui/*"]`；
**2026-09-18 把 V1 那一面补进名单**（提交 `a4b8967`；当时的前缀还叫 `ui_old`，次日改名才是
`/ui_v1` 与 `/ui_v1/*`）—— V1 成为默认界面后，这一面的开关必须真的生效：
不在名单里时，边缘命中静态资源就直接返回，请求到不了 Worker，那段 404 判定永远不执行。
于是界面请求先到 `src/index.ts`，由它按 GitHub 仓库变量 `UI_ENABLED`（判定见 `src/uiEnabled.ts`）分流：

| | 界面开着（默认） | `UI_ENABLED=false` |
| --- | --- | --- |
| `/ui`、`/ui/js/*`（跳转壳；`redirect-hash.js` 同样是代码资源）、`/ui_v1/`、`/ui_v1/js/*`（V1）与 `/ui_v2/`、`/ui_v2/js/*`（V2） | 转 `env.ASSETS.fetch()`，行为与"静态资源直接托管"时**逐条一致**（含裸 `/ui` 的 `307 → /ui/`） | **404**（纯文本 `Not Found`） |
| `/ui/不存在的路径`、`/ui_v1/不存在的路径`、`/ui_v2/不存在的路径` | 资源 404 后**回落 Hono**，拿到 `notFoundPage`（三个前缀共用同一条链，与平台自身回落一致） | 404 纯文本（不产生界面痕迹） |
| `/ui/api/*`（含裸 `/ui/api`） | 照旧交给 Hono，守卫与业务不变。**裸形态 2026-09-20 起也归接口面**：它与 `/ui/api/` 是同一个命名空间的两种写法，此前却落进上一条的资源分支、回的是**HTML 404 页** | **404 JSON** `{"error":"not_found"}` |
| 根路径 `/`（`Accept: text/html`） | 302 → **`/ui_v1/`**（默认界面，少一跳） | **200 `Server is running.`**（不再把人引到不存在的界面） |
| 协议面 | 不受影响 | **不受影响**（`/api/*`、`/SyncClipboard.json`、`/file/*`、Hub 全照常） |

三条不变式由 `test/ui-guard.test.ts` 的「UI 部署开关」用例守着：关闭态**一次都不访问**静态资源且全 404；
开启态资源未命中必须回落出 404 页；**每个界面挂载点都在 `run_worker_first` 里**（2026-09-18 补的第三条、2026-09-19 改名后扩到三个；挂载点从 `public/` 动态发现 ——
此前文档写着"删掉它会测试即红"，而实际上没有任何测试在读这份配置）。
线上每次部署后由 CI 冒烟按开关断言三面的页面与入口 JS：
`/ui/`（跳转壳）、`/ui_v1/`、`/ui_v1/js/main.js`、`/ui_v2/app/`、`/ui_v2/js/boot.js`。
```

三条不变式：

1. **协议面无 UI 依赖**：`src/routes/*` 不 import `src/ui/*`；反向依赖只允许 `src/ui/*` 复用
   `src/historyOps.ts`、`src/db.ts`、`src/storage.ts`、`src/serialization.ts`。
2. **写路径唯一**：界面上的收藏/置顶/删除都经 `src/historyOps.ts` 的 `applyHistoryUpdate`——
   与官方 `PATCH /api/history/{type}/{hash}` 是同一个实现（同一套版本判定、同一条广播、同一次 R2 清理）。
   这样「界面改了但客户端不知道」在结构上不可能发生。
3. **静态资源不占协议路径**：`public/` 下不放 `index.html`，所有资源都在四个挂载点（`/ui/`、`/ui_v1/`、`/ui_v2/`、`/ui_shared/`）下；
   根路径留给 `PROPFIND`（客户端的探活与目录列举）。

`wrangler.toml` 的 `[assets]` 声明 `directory`、`binding = "ASSETS"`、`run_worker_first` 与 `not_found_handling = "none"`：
四个界面前缀（`/ui`、`/ui_v1`、`/ui_v2`、`/ui_shared` 及各自的 `/*`）的请求**先进 Worker**，其余命中的静态资源由边缘直接返回，未命中的（含全部协议请求）回落给 Worker。

---

## 3. 模块划分

### 3.1 服务端（`src/ui/`，6 个模块，一个文件一个职责）

| 文件 | 职责 |
|---|---|
| `session.ts` | 无状态签名 Cookie：签发 / 校验 / 清除。纯密码学，不含路由与 HTTP 语义 |
| `guard.ts` | 鉴权：会话 Cookie 或 Basic；401 的响应形状与失败路径的请求体排空 |
| `query.ts` | 只读查询层：参数解析、白名单排序、LIKE 转义、分页、按类型计数、变更信号。拥有 `UiHistoryItem` / `UiListQuery` 等类型 |
| `routes.ts` | 路由装配：把 HTTP 映射到上面三者 + 复用协议层的 `HistoryDb`/`R2Storage`/`applyHistoryUpdate` |
| `maintenance.ts` | 维护面：数据完整性自检（R2 列举 × D1 期望目录差集）与保留策略的在线读写（写 Meta 覆盖，0 = 关闭该阶段，空 = 回落部署环境变量） |
| `notFound.ts` | 四个界面前缀（`/ui/*`、`/ui_v1/*`、`/ui_v2/*`、`/ui_shared/*`）未匹配路径共用的 404 页（只覆盖 UI 命名空间，不碰协议 404 语义） |

共享层的小幅开放：`db.ts` 导出 `rowToEntity`/`DbRow`（界面按自己的排序读同一张表，若另写一份映射，
两处对 NULL/布尔列的解释迟早分叉）；`contentTypes.ts` 从 `routes/webdav.ts` 抽出（`fileHeaders`
现有两个真实调用方：WebDAV 附件与界面数据端点——少一道 `nosniff` 就是一个存储型 XSS 面）；
`auth.ts` 抽出 `verifyCredentials`（Basic 头与登录表单共用）。

### 3.2 前端（`public/ui_v1/` = V1，真文件 + 原生 ES 模块，无构建步骤）

> **本节描述的是 V1，而 V1 从 2026-09-18 起就是默认界面。**
> 站点根 `GET /` 的浏览器分支（`src/routes/webdav.ts`）与 `/ui/` 的目录索引
> （`public/ui/index.html`，meta refresh + canonical）**都**指向 `/ui_v1/`；两者必须一致，
> 守卫见 `test/ui-guard.test.ts` 的「默认界面的入口链一致」。
> V2（`public/ui_v2/`，本体 `/ui_v2/app/`）降为**开发测试版**：它进去后顶栏版本号与登录页副标题
> 都标着"开发测试版"，设计与实现见 [`docs/ui-v2-design.md`](ui-v2-design.md)。
> 本文件从 §3.2 到 §11 的内容描述的是 V1 的实现。
>
> 沿革：2026-09-15 界面曾由 V2 接管、V1 降为备用；2026-09-17 `public/ui_v1/` 重新纳入维护
> （接口前缀故障修复、密度与移动端重做、运行时可重复验证，见 `docs/progress.md` §53）；
> 2026-09-18 用户定的新定位 —— **V1 是产品界面，V2 只是开发测试版**（见 §70）。
>
> 挂载点分工：**页面与静态资源在 `/ui_v1/...`，服务端接口在 `/ui/api/...`**（与 V2 共用同一套），
> 接口前缀只写在 `public/ui_v1/js/api.js` 的 `API_BASE` 一处。
> **V1 保持完全自包含**：消除对 `public/ui_v2/` 的任何跨目录依赖（此前曾尝试跨目录共用 `messages.js` 的兼容层已彻底清除），V1 拥有完整独立的本地实现，避免因开发测试版（V2）的演进或移除造成任何破坏；守卫见 `test/ui-guard.test.ts` 的「V1 不依赖 V2」（2026-09-21 改名并放宽其判据）。
>
> **与 V2 唯一的共享面是 `public/ui_shared/`**（2026-09-21 新增）：品牌图标与无版本耦合的纯数据模块
> （`js/icons.js`）放在那里，两版各自 import；**只允许逃到这一层**，逃进 `/ui_v2/` 依旧一律红，
> 且守卫要求 V1 确实有引用（防"共用层空转"）。允许放什么、为什么，判据见 §3.4。
> 自包含的代价是"两份必然漂移"，因此 V1 自己的 `js/messages.js` 与 V2 的同名文件由一条**对等守卫**钉住逐字一致（同上文件；V2 真被删掉时连守卫一起删）——这两份是**各自独立的副本**，不是共享模块。
> 保留 V2 的三个理由：① 它是零构建前端的**对照基线**（新的模块划分、状态矩阵与探针都先在
> 那边试）；② 开发期的实验场（改坏了不影响默认入口）；③ 它与协议端点
> （`/api/*`、`/SyncClipboard.json`、`/file/*`、Hub）零关系，两版可以各自演进。

`public/` 下共 85 个资源，分五部分（2026-09-21 新增共用层后）：

| 部分 | 文件数 | 说明 |
|---|---|---|
| **V1**（`public/ui_v1/`，**默认界面**） | 34 | 默认入口，挂载 `/ui_v1/`；2026-09-17 修复接口前缀、重做密度与移动端，2026-09-18 接手默认跳转、并把用户文案收回本地 `js/messages.js`（见该目录 `README.md`）；2026-09-21 新增 `js/components/tooltip.js`（hover 预览浮层，见 §3.3 硬约束 #26） |
| **V2**（`public/ui_v2/`，**开发测试版**） | 43 | 3 处入口（`app/index.html`、`app/login.html`、以及 `js/*` 的模块图）+ 5 张样式表 + 34 个 JS 模块 + `theme-init.js` + `manifest.webmanifest`；应用本体挂 `/ui_v2/app/` |
| **共用层**（`public/ui_shared/`，2026-09-21 新增） | 4 | 两版**唯一**的共享面：`brand/favicon.svg`、`brand/favicon-32.png`、`brand/apple-touch-icon.png`（两版此前逐字节各存一份）与 `js/icons.js`（两版图标表的**并集**，2026-09-22 复核为 33 键：两版都用 23 + 只 V1 用 4（`edit` `arrowUp` `image` `push`）+ 只 V2 用 6（`chevronDown` `dots` `filter` `inbox` `list` `settings`）；两版都不用的键按死数据删除）。挂 `/ui_shared/`，与其它三个挂载点受**同一个** `UI_ENABLED` 管；允许放什么见 §3.4 |
| **跳转壳**（`public/ui/`） | 2 | 只剩 `index.html`（meta refresh + canonical + 外链脚本）与 `js/redirect-hash.js`（把 fragment 中继到目标）。它把 `/ui/`（老书签）送到 `/ui_v1/`；**保留这个前缀的真正原因是 `/ui/api/*`** —— 两版共用的服务端接口命名空间，路由在 `src/ui/routes.ts` |
| 站点根 | 2 | `robots.txt`（爬虫只读根路径，故不能放四个挂载点下）与 `_headers`（Cloudflare 静态资源的响应头：CSP `default-src 'none'` + 逐项白名单、`nosniff`、`Referrer-Policy`、`frame-ancestors 'none'`，以及 js/css 的 `no-cache, must-revalidate`（每次回源验证）、图标/manifest 的长缓存——这些响应头由静态资源层施加（四个前缀的请求虽先进 Worker，资源仍由 `ASSETS` 出网），只能在那里声明。`connect-src` 显式写成 `'self' wss: ws:`：`'self'` 对 websocket scheme 的解析在各浏览器不一致（MDN 引 w3c/webappsec-csp#7），不写死会让实时推送在部分浏览器上静默降级成轮询） |

下表是 **V1** 的文件清单（供对照）：

| 文件 | 职责 |
|---|---|
| `index.html` / `login.html` | 页面外壳与挂载点；主题在首帧前由阻塞式的 `/ui_v1/js/theme-init.js` 定好（深色用户不会看到白闪）；预加载列表与 import 闭包对齐，完全自包含于 `/ui_v1/` |
| `css/tokens.css` | 设计令牌：颜色（浅/深）、字号阶梯（13/14/16/18；12px 档已合并进 13px，`--fs-stat` 数字档已在 2026-09-18 删掉，见 `progress.md` §57.5）、间距（4/8/12/16/24/32/48/64）、圆角、阴影、时长与缓动 |
| `css/base.css` | 重置、排版、`:focus-visible`、跳转链接、微标签 |
| `css/layout.css` | 骨架：顶栏、统计条、工具栏、结果区、页脚 |
| `css/components.css` | 组件：按钮、字段、分段控件、徽标、数据表、星标、复选框、对话框、提示、空状态、分页 |
| `css/motion.css` | 动效集中处 + `prefers-reduced-motion` 的等价降级 |
| `css/auth.css` | 登录页专属样式（列表页不加载） |
| `js/api.js` | `/ui/api` 调用封装、类型归一化、401 统一跳登录；**首屏合成快照** `overview()`、**批量取全文** `batchMeta()`（按服务端 100 条上限分片）、`latest()`（全库最新一条，供顶栏「复制最近一条」）、请求默认 30 秒超时（把调用方取消与超时合成一个 signal） |
| `js/filters.js` | 筛选状态 ⇄ URL（可链接、可后退、刷新不丢） |
| `js/store.js` | 状态容器：`get` / `set`，不掺 DOM 不掺网络。**刻意不提供订阅**——此前有过一个 `subscribe()` 而全仓无人调用；「看起来像响应式、实际全靠手动 `render()`」的接口只会误导下一个人（真要改成订阅驱动，得连同组件的重建策略一起设计） |
| `js/signalr.js` | 原生 SignalR 推送通道（`createPushChannel`）：票据换 WebSocket、`\x1e` 分帧、30 秒心跳（DO 静默 60 秒即断）、退避重连。**轮询不被关掉**——在线时它降级为 60 秒看门狗（见 §3.3 第 8 条） |
| `js/latest.js` | 竞态守卫（`createLatestGate`）：一次往返的「**最新请求胜出**」——`begin()` abort 掉上一个请求并给出序号，`isCurrent(ticket)` 决定这次结果是否落地。列表 / 统计 / 变更信号各持一个实例（见 §3.3 第 6 条） |
| `js/dom.js` | DOM 工具。**不提供任何插入 HTML 的途径**（见 §7） |
| `js/clipboard.js` | 剪贴板写入（文本 / 图片）：安全上下文探测、非 PNG 转码、失败降级与**带原因的判别结果**（`{status, reason}`：`unsupported` 与 `failed` 分别对应「换环境」和「权限/激活问题」，并把底层原因带进提示，不混成一句「不支持」） |
| `js/format.js` | 类型/体积/时间/摘要的展示格式化 |
| `js/messages.js` | 面向用户的**文案**单点：删除/批量删除/清空历史的确认句、列表错误的"人话翻译"、剪贴板失败的原因句。不碰 DOM/网络/状态。**V1 自己的副本**（产品面自包含），与 V2 的同名文件由 `test/ui-guard.test.ts` 的对等守卫钉住逐字一致 |
| `js/components/header.js` | 顶栏（标识、「复制最近一条」、**「部署信息」（图标即推送状态）**、主题切换、会话操作）。那枚控件 2026-09-18 由"状态胶囊 + 独立的部署信息按钮"合成：**可见文字只有「部署信息」**（按钮的名字就是它做的事），**推送状态只由图标承载**（三态三字形：广播/信号、缺口圆环旋转、刷新箭头），**hover 给「状态词 + 一句解释」**，整枚一个命中区，位置紧跟「复制最近一条」。状态变化另用一个视觉隐藏的 `role="status"` 播报**状态词**（`aria-live` 不挂在按钮上：按钮名本来就随状态变，叠加等于念两遍）。见 `progress.md` §60 / §63.4 |
| `js/components/stats.js` | 统计条（三个真实数字：记录 / 已收藏 / 存储占用，**数字在上、标签在下**）；明细行 = 「全库 N 条」+ **排障面**（最近同步 / 时钟差 / 清理状态，`progress.md` §57.2）+ 近 14 天活动趋势（回收站入口已按用户要求删除，见 §54.3） |
| `js/components/toolbar.js` | 类型分段筛选、收藏筛选、搜索（含清空按钮、`Esc` 清空、`focusSearch()` 供快捷键调用、`/` 键帽提示）、每页条数、刷新（按钮自带进行中态） |
| `js/components/list.js` | 结果区：表格、行、**四个固定槽位的行内动作**（预览/复制/下载/删除，缺失的动作放等宽占位——同一动作在每行的位置恒定；文本行的第 3 槽分两支：有原文件是「下载」（原字节+原名）、内联文本是「下载文本」（正文存成 `.txt`））、排序表头、选择条（Shift 范围选择；批量按钮带**进行中态**）、**一键复位筛选**、空状态；**同一视图内的刷新按行对账**（内容未变的行不重建，见 §3.3） |
| `js/components/row-content.js` | 结果行的行内内容：缩略图（含降级与 512 KiB 阈值）、状态徽标、收藏/置顶开关的字段与文案；从 `list.js` 拆出——对账、选择与焦点仍在那份文件里 |
| `js/components/pagination.js` | 范围文本、上一页/下一页、跳页（聚焦全选、回车后清空并交还焦点；只有一页时隐藏跳页） |
| `js/components/preview.js` | 预览对话框（文本全文 / 图片原图 / 不可用态）；点背景关闭、打开时焦点落在主操作、长文本先给加载态；主操作文案与行内统一（「复制文本」「下载文本」「复制图片」「下载」）。**2026-09-22（ADR D30）起文本多一个「编辑」态**：两态机 预览 ⇄ 编辑（等宽 `<textarea>`、页脚换「取消 / 保存」、保存 = 新建一条记录、保存成功后**改指向新记录**、Esc 只退编辑不关框、保存途中不许关框，见 §3.3 #29）；头部（类型徽标 / 字符数 / 时间）由 `renderHead()` 单点绘制 |
| `js/components/tooltip.js` | **hover 预览浮层**（2026-09-21 起 V1 唯一实现）：悬停 150ms 出现、只在内容被截断时出、到达并停住；**纯视觉、不接收指针事件**（`pointer-events: none`）且 `aria-hidden="true"`（不挂 `aria-describedby` —— 完整文本本来就在 DOM 里，取全文的可访问出口是行内「预览」；见 §3.3 硬约束 #26） |
| `js/components/confirm.js` | 确认对话框（销毁性操作前问一句）：请求进行中留在对话框内、失败就地显示原因可重试；**结算不依赖 `close` 事件**（见 §3.3） |
| `js/components/toast.js` | 反馈层：瞬时提示（离场动画、最多 4 条）+ **原地状态** `setPending` / `flashSuccess`（行内按钮与对话框按钮共用，见 §3.3）；错误提示可带一个**动作**（目前是「重试」，带动作时停留 10 秒，见 §58.4） |
| `js/components/info.js` | 部署信息 / 维护面板对话框：① 客户端该填什么地址（尾斜杠、`/dav` 这类第一个卡点）；② 时钟差（> 5 分钟会让官方客户端中止历史同步，故本地先提醒）；③ 清理状态与数据完整性自检；④ 保留策略在线调整（上界 1 年 / 100 万条，与 `src/ui/maintenance.ts` 逐字同值）；⑤ 危险操作。合成一个面板是因为「这台服务器现在怎么样」本来就是同一个问题 |
| `js/main.js` | 装配点：唯一知道「谁是谁」的地方；`actions` 返回「是否做成」供组件呈现，另承载 `/` 快捷键、翻页/改筛选后的滚动定位、**首屏合成快照**（`refreshOverview`）、批量复制、顶栏「复制最近一条」、失败路径的「重试」接线（§57.2 / §58） |
| `js/login.js` | 登录页逻辑 |
| `js/next-target.js` | 登录后「下一跳」的判定（纯函数 `resolveNext`）：只接受**同源**目标，否则回落站内默认页。独立成文件是为了能被测试直接覆盖（见 §7） |
| `js/theme-init.js` | 首帧前把主题写进 `<html data-theme>` 的**经典脚本**（不是模块：模块默认 defer，会晚于首帧）。外链而非内联，CSP 才能保持 `script-src 'self'` |

> 上表**只列 V1 自己的文件**。**图标路径表已移入共用层**（`public/ui_shared/js/icons.js`，2026-09-21）：
> 它是两版唯一的共享模块之一，V1 的 9 个组件模块都从 `../../../ui_shared/js/icons.js` 取 `iconPaths`；
> 原来的 `js/icons.js` 已删除（判据与理由见 §3.4）。`_headers` 曾误列在这里 —— 它住在**站点根**（`public/_headers`，与两个界面都无关，见上一张表的「站点根」行）。

### 3.3 前端交互约定（改动这些地方前先读）

下面的约定是**功能正确性**的一部分，不是风格偏好：

1. **actions 返回结果，组件呈现结果。** `main.js` 的 action 返回 `true` 才算做成；行内按钮据此决定是否显示成功态。只看「请求发出去了」会把失败显示成成功。
2. **原地反馈优先于提示条。** 用户按的是哪个控件，结果（进行中 / 成功）就落在哪个控件上（`setPending` / `flashSuccess`）；提示条只承载需要解释或跨控件的反馈（错误、降级）。
3. **同一视图内的刷新按行对账。** `list.js` 用内容签名（`signature()`）比对，未变化的行**不重建**——重建成整表会让每 10 秒一次的轮询重载缩略图、打断动画、丢掉焦点。新视图（翻页/改筛选）才整表重建并错峰入场。
4. **对话框的结算不依赖 `close` 事件。** 主路径（确认 / 取消）在**决定的当下**结算 Promise，`close` / `cancel` 只作旁路兜底（Esc、点背景）。依赖事件会让「事件不来即永不结算」，调用方 `await` 之后的收尾（提示、刷新）整段丢失——实测 headless Chromium 上 `dialog.close()` 后 `close` 事件就不来。
5. **删除成功后行就地收掉**（`list.removeItem`），随后静默刷新补齐并对其余行对账；等下一次整页刷新才消失会读成「点了没反应」。收行时**必须把焦点交给邻居**：焦点原本在被移除的按钮上，不管就会落到 `<body>`，键盘用户得从页面开头重新 Tab（`removeItem` 因此会记住「哪个操作」并在邻居行里找同一个按钮，都没有时交给空状态的主按钮）。
6. **每次列表 / 统计 / 变更信号的往返都过 `latest.js` 的守卫**：`begin()` 拿 ticket、`isCurrent()` 通过才允许写回 store，且 `catch` 里要先看 `signal.aborted`（被取代不是失败）。少了这一步就是「陈旧响应覆盖新状态」——实测复现过：URL 与筛选控件说 Text、列表里是 46 行图片，且不会自愈。

7. **推送是轮询的加速器，不是替代品。** 可见时用 `/ui/api/hub-ticket` 换票据、建 WebSocket
   （`js/signalr.js`：`\x1e` 分帧、30 秒心跳——DO 静默 60 秒即断、退避重连），收到任何广播都走
   **与轮询完全相同的那次刷新**（增量对账只有一份实现），并对广播做 300ms 尾沿去抖——批量写是
   **逐条广播**的，不去抖会让一次「批量收藏 200 条」连开 200 次列表请求。连接在线时轮询降为
   60 秒看门狗；断线、拿不到票据（503）、环境不支持——失败都自动回到 10 秒轮询，且**连续失败
   5 次后停止重试**（坏环境里每 ≤60 秒白试一次 ≈1.4k 请求/天），回前台重新尝试。
   **轮询代码不会被删**：看门狗的存在就是为了「广播没到」这种情况（DO 休眠、代理掐连接）。
8. **后台标签页主动断开推送。** 隐藏页的定时器被浏览器节流到 ≥1 分钟，30 秒心跳必然漏掉 60 秒静默
  窗口，那条路会退化成「断开→退避重连」的抖动（每次重连 = 一次票据 POST + 一次 WS + 一次 DO 唤醒），
   比它省下的轮询还贵，且连接不断时 DO 永不休眠（计费）。隐藏期间交给 30 秒轮询兜底。
9. **行内开关（收藏 / 置顶）就地更新、徽标同步。** 目标状态取**按下那一刻**的行数据（连点两次的
   第二次必须反向）；`patchItem` 采纳服务端回传的元数据（`version`/`lastModified`/`lastAccessed`，
   见 §5 第 7 条），并就地替换徽标容器——`signature()` 必须包含**会变**的展示字段（`lastModified` /
   `lastAccessed`），否则轮询刷新后行不重建、时间停在首次渲染值（按「访问」排序时看起来像排序坏了）。
10. **深链接 `#Text-<hash>`**：`hash` 空闲（筛选状态在 query string），打开即预览那一条；
    打开预览时把当前记录写进 hash（可分享），关闭时清掉，避免刷新又弹出上一条。
    ⚠️ 清 hash 依赖 `dialog` 的 `close` 事件：headless 的隐藏标签页里该事件不派发（页面被冻结），
    故这条行为**只在真实浏览器可靠**，本机浏览器回归未覆盖到它。

11. **列表更新一帧落地，不做视图过渡、不播入场错峰。** 视图过渡要对整个结果区做布局/样式快照
    （实测 6× 降速下一次「什么都没变」的切换多花 ~60ms，且随页大小上升）；入场错峰的尾巴是
    (12 − 1) × 40ms = 440ms（错峰 12 行、`--row-index` 取 0–11），读起来是「内容慢半拍」。两者都只保留在**首屏**那一次（`hasRendered` 之后不再播），
    之后任何更新都走按行对账。
12. **筛选控件立刻画，列表等响应。** `store` 不触发绘制，而 `render()` 原先只在 `refresh()` 落地后跑 ——
    从点击到响应这段时间里被点的那一段毫无变化（真实网络上是几百毫秒的「点下去没反应」，响应一到整块换掉，
    读起来就是卡顿）。现在 `setFilters` 在发请求前先 `render()`：控件即时按下、结果区 `data-busy` 变淡，
    行仍是旧的，等响应回来再按行对账。
13. **切换类型不是「新视图」**：`全部 ↔ 文本` 在多数库里是同一批行（线上 74/74），原先每次切换都
   整表重建 + 12 行错峰入场 + 结果区交叉淡入，全是白做。现在只有**首屏（第一份非空结果）**走一次
   整表重建 + 错峰入场，之后一律按 key 对账（`reconcile`）、不播动画；`viewToken` 那套「视图标记」
   已随之删除——它当年只为入场动画服务，判断「内容是否变」由行签名（`signature()`）负责。
14. **类型计数在「迁就新视图」期间是隐藏，不是清空。** 切**范围**（回收站）会换掉整份计数，而
    `countsForView` 的守卫要求「统计的归属视图与当前视图一致才允许显示」——中间的几百毫秒里
    `byType` 是空的。此时 `toolbar.js` **不写数字**、只给分段控件加 `data-stale`，由 CSS
    （`visibility: hidden`）把它藏起来：**占位不动**，因此 chip 宽度不变、搜索框不会被顶宽。
    清空（旧的写法）会让五个 chip 各窄掉数字那一段 —— 实测分段控件 −99px、搜索框被顶宽 50px
    再弹回，就是用户报告的「点回收站之后搜索框闪一下」。也**不要**改成"留住旧数字显示"：
    那会在屏上出现另一个视图的计数，正是这条守卫要禁止的。回归守卫：探针的 `TOOLBARSW`。

15. **批量动作后的焦点交接不许抢回用户已经放好的焦点。** `restoreFocus()` 有一圈 ~0.5s 的重试
    （用于等浏览器关闭模态后的补焦），判据是"只接手**无主**的焦点"：没有任何元素、或仍停在正在
    关闭的对话框里。焦点一旦落在别的可交互元素上（用户点了搜索框、点了下一行），立刻交还用户。
    回归守卫：探针的 `FOCUSKEEP` —— 修前 `after:INPUT`（被拽回表头全选框），修后 `after:search`。
16. **选择集里的那一份行对象必须与列表同步。** 复选框读的是行的**可变引用**（`rowRefs`），
    `toggleFlag` 成功后若该行在选择集里就换掉那一份并 `list.updateSelection()` 刷新选择条 ——
    否则"这一行明明已经置顶、选择条还说置顶"会从批量按钮上冒出来。行的内容签名同时从 DOM 属性
    搬进模块内的 `WeakMap`：签名含最多 500 字符正文，50 行/页 = 每 10 秒一次无谓的属性写入。

17. **行内操作那一栏（预览 / 复制 / 下载 / 删除）的三条硬约束**（2026-09-18）：
    ① **槽位固定**（预览=1、复制=2、下载=3、删除=4，缺失的用等宽占位；回收站的"恢复"固定在槽 1）——
    同一动作在同一列位，鼠标沿行间下移时按钮不跳；
    ② **触屏命中区不许挨着**：粗指针下按钮 44px、间距 10px（`--col-actions-coarse: 230px`），
    而"下载"的邻居就是"删除"（V2 为此把间距从 4px 提到 10px，理由是"缝里点的后果不可接受"）；
    ③ **禁用态必须还能被指针够到**：`[disabled]` 上不能写 `pointer-events: none` ——
    那会把 `title`（"数据不可用，无法下载"）和 `cursor: not-allowed` 一起废掉。
    另：rest 态不透明度 0.7（SC 1.4.11 的 3:1；0.6 只有 ≈2.4:1），提亮判据是
    `(max-width: 720px), (pointer: coarse)` —— 触屏没有 hover，不能用宽度代替指针类型。
    带数据文件的 Text 行**有**下载槽（「含数据文件」徽标说有文件，界面就得有取它的路）。
    ④ **按 30px 按钮摊出来的列宽在触屏全都不成立**：按钮涨到 44px 后，
    「收藏 / 置顶」列（84 → 112px）与操作列（150 → 230px）都要跟着放宽 ——
    少放宽的那一列会把按钮挤成上下两行，行高从 61px 顶到 105px（实测于 1024×768 触屏模拟）。
    ⑤ **文本行的下载按"服务端有没有这个文件"分两支**（见 `progress.md` §65/§66）：
    带数据文件 → 走文件那条路，取回**原字节 + 原名**（`notes.md` 就叫 `notes.md`，按钮叫「下载」）；
    内联文本 → 把正文包成 `text/plain` 存为 `Text-<hash 前 8 位>.txt`（按钮叫「下载文本」），
    长文本必须先取全文（列表里是 500 字符截断），否则会存下半个文件。
    文件名统一过 `safeFileName`：先 basename、洗掉文件系统不认的字符、去掉结尾的点/空白、
    限长 64 且**截断时保留扩展名**（`dataName` 来自客户端，不可信）。
    判据：探针的 `COARSE`（几何 + 媒体查询是否真的匹配）与 `DISABLED`（计算值 `pointer-events`）。
18. **筛选生效时的出口按钮「清除筛选」**（2026-09-18 用户当场定形，2026-09-21 改形）：最终形态 =
    **形状与批量按钮完全一致**（标准 `.btn`：36px、`--r-md` 圆角、字重 500、16px close 图标 + 文字），
    **只把颜色换成青色**（用户原话："复制选中什么样 清除筛选什么样 只是颜色换成青色"）——
    `--accent-soft` 底 + `--accent` 字 + 强调色混出的描边；`.results__clear` 只覆盖三枚色令牌，
    形状全部来自 `.btn` 基类，两处形状必然一致。历史：2026-09-18 先是胶囊（36 显胖、24 显小、
    28 当场定）、字重 600；2026-09-21 用户先要"图标 + 与批量按钮统一"、后改口要回青色，
    最终按上面那句原话定案。hover 规则 `.btn.results__clear:hover` 必须与 `.btn:hover` 同块声明
    （基色 `--accent-soft` 会被 `.btn:hover` 的 `--surface-2` 按回去）。只在真的有筛选时出现，
    位置在结果区头栏「筛选中 · 共 N 条」右边；空状态里同一个动作的按钮带同款 close 图标。
19. **表单错误挂到字段上**（2026-09-18；出处写作 `components.md` §2 的 error 格 —— ⚠️ 该文档
    **不在本仓库**，故要求在这里完整写出，照做不必去找它）：两个表单
    （登录页、部署信息的保留策略）在报错时给**出错的那个字段**置 `aria-invalid` 与
    `aria-describedby`（分别指向 `#login-error` / `#retention-status`），并把焦点送过去；
    CSS 用 `.input[aria-invalid="true"]` 换描边色（颜色只是加速识别，错误**文案**才是主通道）。
    服务端的 500/429 不是"字段填错了"，只挂描述、不标 `aria-invalid`（标了会撒谎）。
    守卫与覆盖缺口见 `progress.md` §69.1。
20. **页脚的相关链接**（2026-09-18 用户三次定形）：常驻入口是**项目名**
    `SyncClipboard CfServer`（本身就是链接，指向本项目仓库；早先写的是 `Leexunhuan743/SyncClipboardCfServer`，
    用户要求改回项目名，见 `progress.md` §79）。它带 `title`（本项目的 GitHub 仓库地址）：
    **可见文字是本产品的名字，`title` 才是"它会开到哪"**——有文本内容的链接里 `title` 不参与命名，
    只作描述与悬停提示；悬停（细指针）或键盘聚焦
    （`:focus-within`）时在它**上方**拉出一张「致谢项目」卡片，列 README「致谢」里那六项
    （SyncClipboard / clipserver / Hono / fflate / ASP.NET Core SignalR / Lucide Icons）及各自 URL
    （2026-09-18 用户要求删掉 `clipserver` 后面的「（另一个实现）」括注、并去掉上游那条的「客户端」三个字：
    致谢卡片里只要名字就够了，解释留给 README 与 `design.md` D15；
    2026-09-21 用户把标题从「致谢如下项目」改成「致谢项目」、并把清单补全到与 README 一致；
    卡片标题与 `nav` 的 `aria-label` 逐字一致，均为「致谢项目」，见 `progress.md` §82）。收起态是 `opacity: 0 + pointer-events: none`
    （不是 `display: none`）——链接留在 Tab 顺序里；触屏没有 hover，那一档把卡片改成**常驻**。
    动效是 160ms 的淡入 + 6px 上浮（状态过渡，写在组件里而非 motion.css）。见 `progress.md` §72。
21. **分页在窄屏的行结构**（2026-09-18 用户截图报的）：范围文本允许独占一行，但
    「上一页 / 第 X / Y 页 / 下一页」必须**同一行且靠右** —— 靠 `.pagination__prev` 的
    `margin-left: auto`（窄屏 spacer 被隐藏、这一组常常换行到第二行，只有 auto margin 两种情形都成立）。
    两条反面教训：范围文本与页码标签**不能共用 `pagination__range`**（窄屏那条 `width: 100%`
    会把页码也撑成整行，分页于是折成四行）；页脚那个浮层的包含块是**入口**（`.footer-links`，
    `right: 0`）而**不是** `.app-footer__inner` —— 锚整块时面板贴的是页脚，与入口之间会空出一条带子。
    但锚入口要同时满足另外两条才不会退回"面板跑到视口外"：页脚 `align-items: flex-start` + 说明那格
    `flex: 1 1 0; min-width: 0`（否则入口被挤到第二行、行首），以及面板宽度上限按**视口**算
     `min(calc(100vw - 2 * var(--sp-5)), 30rem)`（按包含块算会把 55 字符的地址折成四行）。
    判据：探针的 `PAGER` 与 `FOOTER` 两行 + `progress.md` §73、§74。
22. **顶栏那枚「部署信息」胶囊的名字不许断行**（2026-09-18 用户截图）：`.status__entry` 加
    `white-space: nowrap`。中文没有词边界，没有这条时顶栏一挤就把那四个字压成「部署信 / 息」，
    字还溢出 30px 高的胶囊（288px 实测：label 盒 23×81、胶囊 63×30）。加上它之后胶囊的
    `min-width: auto`（= min-content）等于整条名字，不会再被压到名字以下；代价是顶栏必须在
    **更窄**时也放得下，故跟着补两档让位：≤380px 只收间距（一个控件都不隐藏），
    ≤280px 才让纯装饰的品牌图标走（顺序沿用 ≤560px 那条"要不要办事"的判据）。
    判据：探针的 `HEADER` 一行 + `progress.md` §75。
23. **窄屏工具栏的两条**（2026-09-18 用户两句）：「每页条数 + 刷新」是**一组**（同一个
    `.toolbar__group--pager`），整组 `margin-left: auto` 贴**行尾** —— 放得下就与「收藏 / 回收站 /
    时间范围」并排，放不下就整组落到下面一行、仍在右边（判据 `sameRowAsFilters` 与 `gapToRight: 0`）。
    「每页条数」**不再**在 ≤560px 隐藏：上一版把它让出去换了一整行，代价是窄屏**没有改页大小的地方**
    （只能手改 URL，那不是入口）。筛选 chip 的文案是 `收藏`，不是"仅收藏"（与 V2 对齐）。
    判据：探针的 `PAGERBAR` 一行 + `progress.md` §76。
24. **筛选一变就清空选择集**（2026-09-19 补登记，来源 `AUDIT-v1-v2-drift-2026-09-19.md` 的 F3）：
    `setFilters` 对**会改变结果集成员资格**的字段统一清选择集（并 `updateSelection` 刷新选择条），
    否则残留的旧快照会让"删除选中"落到当前筛选**看不见的行**上 —— 选 3 条文本 → 点「图片」→
    选择条仍说"已选 3 条" → 删除，被删的是列表里根本看不到的那 3 条文本。
    成员资格字段 = `types / starred / deleted / range / after / before / **search**`；
    排序 / 翻页 / 页大小**不在列**（它们不改变集合）。
    ⚠️ **`search` 一度被漏掉**，理由是"搜索只是高亮过滤"——**与事实相反**：服务端为它生成
    `Text LIKE ?`（`src/ui/query.ts`），被它滤掉的行看不见、却仍留在选择集里，与 F3 完全同型。
    判据：两版 `MEMBERSHIP_KEYS`（V1 `main.js` / V2 `boot.js`）+ `progress.md` §91。
25. **选中态下点行体 = 切换选中，点空白 = 清空选区**（2026-09-21 用户定案，`grilling` 走完全部
    分支后落地）：选区非空（≥1 行）即"选中态"——
    ① **行体点击**（非按钮/复选框/标签、未在划选文字）**切换该行选中**（已选中的行点行体 =
    取消），**Shift+点击行体 = 范围选择**（锚点与复选框共用 `anchorIndex`）；
    预览/下载/复制/删除/收藏/置顶图标在按钮区里照常（行体点击的 `closest('button, input, a, label')`
    排除）。
    ② **点空白清空选区**，空白 = **整页**（页面背景、表头底色、表格留白、卡片内边距、页脚），
    排除行体、`<dialog>` 内（模态顶层，点它不该动背后的选区）、控件、划选文字中的点击。
    ③ 选区变空即退出选中态，行体点击恢复「预览」。
    实现要点：**原生 Shift+点击会扩展文字选择**（mousedown 就开始，`click` 里 preventDefault 拦不住），
    故行体上挂 `mousedown`：选中态 + Shift + 非控件才 preventDefault；普通 mousedown **不拦**
    （用户要拖动划选文字复制）。清空选区一律走 `onClearSelection()`（**跨页全清**）——
    批量条「取消选择」与点空白同用它；`onSelectAll(false)` 只清**当前页**（`store.items` 是本页），
    保留给表头全选框的取消（它的语义就是"本页都不选"，不是全清）。
    判据：行点击处理器 + `document` 级空白点击处理器 + `progress.md` §119。
26. **悬停预览（hover tooltip）是渐进增强，信息绝不靠 hover 单独传达**（2026-09-21 定案，同日**重做**；
    `js/components/tooltip.js` 是 V1 唯一的实现）：
    · 触发：`@media (hover: hover) and (pointer: fine)` 内悬停 **150ms** 出现（用户定"悬停一律
      150ms"）；触屏**不挂监听**（走既有点击预览）。
    · **只在内容真正被裁掉时出现**：调用方传 `check(trigger)`，判据是 `scrollHeight > clientHeight`
      —— 正文是 `line-clamp:1` 的**纵向**裁切，而 `pre-wrap` 会让长文本换行铺满宽度 ⇒
      `scrollWidth == clientWidth` 恒成立、横向判据**永远检测不到**（第一版就是这么漏的）。
    · **绝不接收指针事件**（`pointer-events: none`，本构件的**第一硬前提**）：浮层贴在行下方、必然
      压住后面几行，一旦它能命中，那几行的 hover 与点击就被吞掉 —— 实测 `elementFromPoint` 在
      覆盖处返回浮层本身，鼠标顺着一列往下走"走不过去"，被压住的行连「收藏」都点不到。
    · **高度按行数封顶**（6 行），超出裁掉、**不给滚动条、也不给"还有更多"的说明行**
      （2026-09-21 用户定：不加提示行）。可滚动的前提是能移进去，与上一条直接冲突；
      而"这条被裁过"本来就有行内的 `长文本` 徽标与「预览」按钮在说 —— 取全文的出口始终是
      行内「预览」（可访问、键盘可达）与点击行体。
    · **纯视觉，不承担无障碍职责**：正文的完整文本本来就在 DOM 里（`.cell-content__text` 只是被
      CSS 裁切，文本节点一直是从头到尾的完整串），读屏不需要它 ⇒ 浮层 `aria-hidden="true"`、
      **不挂** `aria-describedby`。第一版写的 `role="tooltip"` + `aria-describedby` + focus/blur
      监听是**死代码**（触发元素是个不可聚焦的 `div`，那三个监听永远不会响），重做时已删除。
      取全文的**可访问**路径是行内的「预览」按钮（键盘可达，对话框里有全文）。
    · 行被对账重建 / 移出文档之后由 `list.js` 的 `update()` 调 `prune()` 主动收起：指针**不动**时
      节点被 `remove()` 不会产生 `mouseleave`，不主动收就会连着旧内容留在屏上。
    · 短元数据（时间列相对→绝对、图标按钮动作名）继续用原生 `title`；**只有长内容**才用本构件。
    范围（2026-09-21）：行内正文 `.cell-content__text`。
    判据：`tooltip.js` + `list.js` 的 attach/prune + 探针的 `HOVER` 行 + `progress.md` §122。
27. **回收站的两个出口各占一个固定槽位，且都过确认框**（2026-09-21 定案，`progress.md` §125）：
    · 行内动作只有两个 —— **恢复固定槽 1**（与活跃视图的"预览"同位）、**彻底删除固定槽 4**
      （与活跃视图的"删除"同位），中间两槽是等宽占位。理由与活跃视图那四个固定槽同一条：
      动作按类型追加会让"哪个按钮在哪一列"逐行不同，而切换视图后误按的代价是
      "把记录恢复出去"或"把它永久删掉"。
    · 两处入口：行内「彻底删除」+ 选择条「彻底删除选中」（回收站视图专有，与「恢复选中」
      「清空回收站」并列）。**没有"彻底删除少量/中量"的入口时，用户只能整罐倒** ——
      这正是它存在的理由（2026-09-21 实测定案）。
    · **都过确认框**（不可撤销），文案住在 `messages.js` 的 `purgeConfirmSpec` /
      `batchPurgeConfirmSpec`，与 `deleteConfirmSpec` 的差别（软删=进回收站 vs 彻底删除=行也没了）
      必须写在句子里的。
    · 服务端**只删 `IsDeleted != 0` 的行**（判据在 SQL 里）：活跃记录走不到这条路径 ——
      "绕过回收站直接真删"不是本界面的能力；删成功后**顺带清掉它的数据目录**（ADR D29 起回收站里
      是真数据，这条出口的语义就是立刻连字节一起没）。
    · **「恢复」不再按 `hasData` 禁用**（2026-09-22，ADR D29）：真回收站保留了数据文件，两类记录
      都能恢复（服务端那条"有数据就不许恢复"的上游守卫已经去掉）。于是界面里**没有**"不可恢复"
      这个状态，也没有按 `hasData` 预筛批量恢复的分支。
    判据：`list.js` 的 `buildActions`（回收站分支）+ 选择条 + `main.js` 的 purgeItem/batchPurge +
    `docs/ui.md` §5 的 `/ui/api/history/batch-purge` 行 + `docs/protocol.md` §10 的两行偏离登记。
28. **长批量在途可中止，中止点是"批"的边界**（2026-09-21，`progress.md` §127）：确认框**在途**时
    「取消」变成「**中止**」（✕ 与 Esc 仍在途挡住 —— F2 的理由不变：在途关框会让调用方把"已成功"
    读成"用户取消"）。点中止**不关框**：停掉后续批次，把「已生效 N 条」写在框里（`batchAbortedText`）。
    · 粒度由服务端决定：**一次请求内部不会被打断**（那 100 条一定跑完）⇒ 中止点天然落在批与批之间，
      不会留下半条记录，已生效条数也如实可报。
    · 中止**不是失败**：`api.js` 的批量循环返回 `{…, aborted: true}` 而不是抛错（超时仍然抛，
      两者用 `error.name` 区分 —— 这一条别合并成"都是异常"）。
    · 只覆盖**分片发送**的批量（收藏/置顶/删除/恢复/彻底删除）。单条动作与「清空回收站」是单次请求，
      快到不值得中止，不接这条。
    判据：`confirm.js` 的 busy 分支 + `api.js` 的 `isAbortError`/`aborted` + `main.js` 的 aborted 分支 +
    `messages.js` 的 `batchAbortedText`（两版逐字一致）。

29. **预览框里的「编辑」是两态机 预览 ⇄ 编辑，保存 = 新建一条记录**（2026-09-22，ADR D30，
    `progress.md` §130；`grilling` 逐问定案）：
    · **只对 `Text` 开放**（`File`/`Image`/`Group` 没有"编辑正文"这回事，那是下载/预览的活）。
    · **保存的是新记录，不是改这一条**：文本记录的 `hash = SHA256(utf8(正文))`，正文一改 hash
      必变 ⇒ 在协议模型里它就是**另一条记录**。服务端走 `addRecordDto`，**只广播
      `RemoteHistoryChanged`、不碰当前剪贴板** ⇒ 其它设备只是多一条历史，不会有人被迫换剪贴板。
      「编辑」按钮的 `title` 就把这句写出来（"保存成一条新记录，当前剪贴板不受影响"）。
    · **保存后不关框**：正文换成刚保存的那段、上方给一条「已保存为新记录（N 个字符）。原来那条
      仍在历史里，列表已刷新。」的就地说明（`.dialog__note`），列表在框**背后**静默刷新。
      复制/下载一律跟着**屏幕上这段**走（`currentText` 是唯一来源）——不许出现"刚存完却复制到旧文本"。
    · **`<textarea>` 的「没改字」判据必须先归一化行尾**：`<textarea>` 的 `value` 会把 CRLF 折成 LF
      （HTML 规范的 API value），而记录里存的常常就是 CRLF（官方客户端从 Windows 剪贴板发出的正文）。
      直接比会得出"改过"，从而让**只点一下保存**凭空生成一条"只差行尾"的新记录（实测踩到）。
    · **Esc 在编辑态只退出编辑、不关对话框**（`cancel` 事件里 `preventDefault()`）：一段几千字的
      编辑不该被一个 Esc 丢掉。非编辑态的 Esc 行为不变（关框）。
    · **`> 1 MiB` 不给编辑**：按钮 `disabled` **且带 `title` 说明原因**（"正文超过 1.0 MB，在浏览器里
      编辑会卡住；请用「下载文本」在本地编辑。"）—— 禁用不带原因等于把用户堵死在这里。
      上限与服务端 `UI_TEXT_CREATE_MAX_BYTES` 同值（纵深防御）。
    · **保存失败留在编辑态**：原因**就地**渲染在 `<textarea>` 正下方（`.alert--error`，`role="alert"`），
      textarea **静态** `aria-describedby="preview-edit-error"` 指向它（与 `info.js` 保留策略表单同一手法：
      目标常驻、无错时 `hidden`），焦点送回正文里；用户改的内容一个字不动，可以改完再存一次。
      只有**正文本身不合规**（服务端 400，例如超过 1 MiB）才加 `aria-invalid` —— 网络/500 不是字段的问题，
      标了会让读屏说"这个输入框有误"（第 19 条同一条判据）。
    · **保存途中不许关框**（2026-09-22 自审补，与 `confirm.js` 的 F2 同源）：`saving` 期间 ✕ 与「点背景」
      都被挡（`closeButton.disabled` + `requestClose()` 守卫）。理由是可测的：**提示条在顶层对话框之下**
      —— 实测在这个模态开着时往 `#toasts` 里塞一条提示、再问它自己中心点的 `elementFromPoint`，
      拿到的是 `dialog` 而不是提示条。在途关框 = 把一次失败丢在屏幕外。
    · **保存成功后对话框改指向新记录**（2026-09-22 自审补）：`onEdit` 回传刚创建的条目，
      预览框据此换掉 `currentItem` 并**重画头部**（`renderHead()` 是头部唯一绘制点），
      深链接也换成新记录的 `#Text-<hash>`。不改的话屏幕上是"头部说旧记录的字符数、正文是新文本"，
      且刷新页面会弹回旧那一条。⚠️ 这条依赖 `api.createText` **过 `normalizeItem`**：
      服务端按上游惯例把 `type` 序列化成数字，不过归一化时 `type` 是 `0`，
      于是「文本」那一支全判错（头部显示成字节数、页脚只剩「下载」）—— 自审时实测踩到过。
    · **头部与说明的字符数同源**：都用服务端 `size`（= `dto.text.length`，UTF-16 码元），
      与列表讲的是同一件事；**不在头部本地跑 `charCount`** —— 它走 `Intl.Segmenter`，
      实测 1.1 MB 的正文要 169ms，而且与同一屏的 `size` 会给出两个不同的数字（10 个 emoji：10 vs 20）。
      `charCount` 只在响应没带 `size` 时才兜底。
    判据：`preview.js` 的 `enterEdit`/`exitEdit`/`renderView`/`renderViewActions`/`renderHead` +
    `main.js` 的 `createTextRecord` + `api.js` 的 `createText` + `messages.js` 的
    `editTooLargeText`/`textSavedNote`/`textSaveFailedText`（两版逐字一致）+
    `docs/ui.md` §5 的 `POST /ui/api/history` 行 + `progress.md` §130。

> 前台另有两条与本轮无关但同样承重的旧约定：正文一律走 `textContent`（`dom.js` 不提供插入 HTML 的途径，见 §7）；行入场只在新视图播放（轮询刷新不重放，避免「幻灯片式入场」）。

---

### 3.4 共用层（`public/ui_shared/`）—— 两版唯一的共享面

2026-09-21 起，V1 与 V2 之间**只有这一层**可以共享。它挂 `/ui_shared/`，与其它三个挂载点受**同一个**
`UI_ENABLED` 管（界面关掉时它一起消失 —— 断掉界面后不该还有人能从这一层拿到界面的东西）。

**允许放什么**，判据只有一条：**它不随某一版的界面演进变化**。

| 允许 | 现状 |
|---|---|
| 纯静态资产 | `brand/favicon.svg`、`brand/favicon-32.png`、`brand/apple-touch-icon.png`（两版此前逐字节相同，各存一份） |
| 无版本耦合的**纯数据/纯函数**模块 | `js/icons.js`：24×24 常量路径表 + `iconPaths()`；两版合并为一份（并集；唯一几何分歧 `trash` 取 V2 的版本） |
| 将来的双语/翻译资源 | ——（目录**用到才建**，不留空目录） |

**不允许放什么**：

- **组件、视图逻辑、样式表** —— 那是两版各自的表达（V1 与 V2 的界面本来就不同）；
- **两版"实现有意不同"的模块**（`format.js` / `dom.js` / `filters.js` / `api.js` / `messages.js` …）——
  例：`truncateText`/`charCount` 的口径差异（UTF-16 码元 vs 字素簇）是**文档化的决定**
  （见 `AGENTS.md` §1 与 `docs/archive/AUDIT-v1-v2-divergence.md` §5.3）。搬进共用层 = 把"改一版"
  变成"两版一起变"，那正是这条红线要防的；
- **各版自己的 `manifest.webmanifest`**（身份/scope 不同）。

**守卫**（`test/ui-guard.test.ts`）：

1. 挂载点集合从 `public/` **动态发现** ⇒ `wrangler.toml` 的 `run_worker_first`、`src/index.ts` 的
   `isUiAsset`、`public/_headers` 的规则三处必须一起含 `ui_shared`；
2. `_headers`：`/ui_shared/js/*` 必须 `no-cache, must-revalidate`；`/ui_shared/brand/*` 走图标的长缓存；
3. V1 的模块**只允许**逃到共用层（`../ui_shared/…`），逃进 `/ui_v2/` 一律红；并且**必须至少有一处引用**
   （防"共用层空转"——否则等于放宽了红线却什么都没换到）；
4. V1 两页的 `modulepreload` 清单 == import 闭包（共用层的条目按 `/ui_shared/…` 计入）。

## 4. 鉴权模型（ADR D13）

- **会话 Cookie**：`base64url(payload).base64url(HMAC-SHA256)`，payload 为 `{u, exp}`。
  密钥由 `PASSWORD` 经 HKDF-SHA256（salt=`syncclipboard-cf-server`，info=`ui-session-cookie-v1`）派生，
  **因此改密码即让全部已签发会话失效**。零存储、可水平扩展（Workers 没有可靠的进程内状态）。
- **登出只清本机 Cookie，不吊销令牌**：`POST /ui/api/logout` 回写 `Max-Age=0` 让浏览器丢弃 Cookie；
  服务端没有吊销集/版本号（零存储的代价），**已泄露的 Cookie 字符串在 24h 有效期内仍被接受**。
  唯一撤销手段是**改口令**（密钥由口令派生 ⇒ 全部已签发会话立即失效，见上一条）；
  若要「登出即吊销」需引入服务端会话状态，与 ADR D13 冲突，须单独立项。
- **属性**：`HttpOnly; SameSite=Strict; Path=/`，`Secure` 仅在 https 下加（本地 http 调试时加了会被浏览器丢弃）。
  有效期 24 小时（与 `clipserver` 的 `SESSION_EXPIRE_HOURS` 一致）。
- **双通道**：会话 Cookie（浏览器）**或** HTTP Basic（curl/脚本，凭据与协议端点相同）。
- **与协议端点的两处有意差异**：
  1. UI 的 401 **不带** `WWW-Authenticate`——否则浏览器会弹出原生凭据框，盖掉自己的登录页；
  2. 凭据未配置时 UI 返回可诊断的 JSON 500，而不是让人对着 401 反复猜。
- **fail-closed**：`verifyCredentials` 在 `isAuthConfigured` 为假时直接返回 false。
  少了这一句会出现：未配置凭据时 `safeEqual('', undefined)` 两侧都是零长度数组而判等，
  `/ui/api/session` 对 `Authorization: Basic Og==` 返回 `authenticated: true`，界面显示成「已登录」，
  真正的「未配置」诊断被掩盖（审查代理发现，已修并加回归用例）。

---

## 5. API 契约（`/ui/api/*`）

| 方法 | 路径 | 语义 | 错误 |
|---|---|---|---|
| POST | `/ui/api/login` | 表单登录，签发会话 Cookie | 400 请求体非法 / 401 凭据错误 / 500 未配置凭据 |
| POST | `/ui/api/logout` | 清除本机 Cookie（公开端点，但会排空请求体）；**不吊销已泄露的令牌**，撤销手段见 §4 | — |
| GET | `/ui/api/session` | 探测登录状态（**总是 200**，用 `authenticated` 表达） | — |
| GET | `/ui/api/history` | 列表：`page` `pageSize`(≤500) `types` `search` `starred` `after` `before` `deleted` `sort` `order` `includeDeleted` `pinnedFirst`（默认 true = 置顶恒优先，见下第 7 条） | 400 参数非法 |
| GET | `/ui/api/history/:type/:hash` | 单条元数据（**正文完整**） | 400/404 |
| GET | `/ui/api/history/:type/:hash/data` | 数据文件；`?download=1` 走附件。**支持 Range**（单区间 206 + `content-range` + `accept-ranges`；后缀区间 `bytes=-n`；不可满足 → 416 + `bytes */size`；多段 → 按 200 全量回退；协议侧的 `/file/{name}` 与 `/api/history/{id}/data` **有意忽略 Range**，见 F29b） | 404 `not_found` / 404 `data_missing` |
| PATCH | `/ui/api/history/:type/:hash` | 收藏 / 置顶 / 删除（复用 `applyHistoryUpdate`） | 400/404/409 |
| POST | `/ui/api/history` | **新建一条文本记录**（预览框「编辑」保存时用，ADR D30）：`{text}` → 落库并**回读**该条，回 `toUiItem(entity)`（与 PATCH 同形，前端复用同一个归一化函数）。**只认 Text** —— File/Image/Group 没有"编辑正文"这回事。走协议 `POST /api/history` 的同一条写路径 `addRecordDto`，因此只广播 `RemoteHistoryChanged`、**不碰当前剪贴板**（没有设备会被迫换剪贴板）；`version` 取 **0**（客户端重传同文本时 `shouldUpdate` 的 `newVersion >= oldVersion` 才成立，写 1 会让随后的重传被判冲突）；正文上限 **1 MiB**（`UI_TEXT_CREATE_MAX_BYTES`，前端在按钮上先拦，超限时「编辑」是 disabled + 说明，这条是纵深防御）；**只接受 `application/json`** | 400 `text_required` / 400 `text_too_large` / 400 `invalid_request` / 415 |
| POST | `/ui/api/history/batch-update` | 批量写：`{items, update:{starred?\|pinned?\|isDelete?}}`（**单次 ≤100 条**，逐条走同一条写路径；**有界并发 10**（2026-09-21：串行是瓶颈——生产实测 100 条删除 66s，并发后 ~5s；总量子请求不变、仍在 1000 上限内）；更多由界面按 100 分片串行发）；**只接受 `application/json`**（原 `batch-delete`，泛化后改名） | 400 / 415（内容类型不是 JSON，审计残余 G3） |
| POST | `/ui/api/history/batch-meta` | 批量取记录（**含完整正文**）：`{items:[{type,hash}]}`（**单次 ≤100 条**，超出由界面分片串行发）→ `{items:[完整 HistoryRecordDto]}`。用于「选中多条 → 一起复制/下载」——列表里的正文被服务端截断到 500 字符，而逐条走单条端点是 O(N) 次请求；**只接受 `application/json`**（与 batch-update / clear 同一条纵深防御） | 400 / 415 |
| POST | `/ui/api/history/batch-purge` | 回收站的**彻底删除**：`{items:[{type,hash}]}`（**单次 ≤100 条**）→ `{purged, failed}`。**本地纯硬删**：只删 `IsDeleted != 0` 的行（判据写在 SQL 里 ⇒ 活跃记录删不掉、不许绕过回收站）；**不广播**（理由同 clear 的三条）、**每条顺带清掉它的数据目录**（+1 次 R2 列举）—— 2026-09-22（ADR D29）起回收站里是真数据，彻底删除的语义就是立刻连字节一起没。上游没有这个能力（它的硬删是 30 天定时任务），属本站自己的面，`docs/protocol.md` §10 无需登记 | 400 / 415 |
| POST | `/ui/api/history/clear` | 清空历史：`{scope:'trash'\|'all'}`。trash = 只删已删除行并返回计数（不物化整批行）；all = 与协议 `DELETE /api/history/clear` **共用** `historyOps.clearAllHistory`（先删行，再按 `clearAll` 返回的**实体集合**删工作目录——最坏漏删孤儿目录，不会误删并发写入的新记录）。**不逐条广播**（上游的广播触发点清单里没有 clear，见 §6 的说明；跨标签页收敛靠 `/ui/api/poll` 的计数变化） | 400 / 415 |
| POST | `/ui/api/hub-ticket` | 签发一张 Hub 连接票据（`{token, path}`），供前端建立 WebSocket；DO 打不通时 503（前端据此继续轮询） | 503 |
| GET | `/ui/api/integrity` | 数据完整性自检：`{checkedAt, recordsWithData, historyObjects, missingCount, missing[], missingTruncated}`。成本 = 1 次 D1 + `ceil(对象数/1000)` 次 R2 列举（**不逐条 HEAD**）。⚠️ hash 含路径分隔符的**坏行**（只能带外写入 —— 三条写路径都拒）按「取不到」计入 `missingCount` 并列进清单：不是 500、也不是静默跳过（2026-09-20；此前 `historyKey()` 的断言会让整个自检 500 —— 而它恰恰是数据坏掉时唯一该工作的诊断面） | — |
| PUT | `/ui/api/settings` | 保留策略的在线调整。**请求**是**扁平**两个字段：`{retentionMinutes?, maxSavedHistoryCount?}` —— 数字 = 覆盖、`null` = 清除覆盖（删 Meta 键、回落部署环境变量）、**缺省字段 = 不改动**；两个字段都不给 → 400（静默 200 会让界面以为改动生效了）。**响应**与读路径同形：`{retention:{retentionMinutes, maxSavedHistoryCount, retentionSource, maxCountSource}}` —— 是**回读的生效值**，不是回显请求体。**没有对应的 GET**：读取走 `/ui/api/info` 的 `retention`（同一份 `readRetentionSettings`，连通来源字段一起给） | 400 / 415 |
| GET | `/ui/api/statistics` | 官方统计 + 按类型分布。**三个计数键口径不同**：`byType` 随 `?deleted=true` 走（工具栏的类型计数要与当前视图同源），`byTypeActive` **恒为活跃口径**（统计条「存储占用」的明细用它；注意 2026-09-22（ADR D29）起删除**不再**立刻释放空间——数据要在回收站留 30 天，那条明细与「存储占用」反映的都是 R2 的真实占用）；`starredCountActive` / `starredCountDeleted` 是**按视图各一个的收藏计数**（都是全表聚合、与请求的 `deleted` 无关，两个一起给）——统计条「已收藏」那一格与工具栏「收藏」筛选同屏，卡片用**全库**口径（协议 DTO 的 `starredCount`，含回收站里的行）会出现"卡片说 12、点开筛选只有 9"（2026-09-21 dogfood 实测） | 400 参数非法 |
| GET | `/ui/api/overview` | **首屏合成快照**：一次往返拿到 `{stats, byType, byTypeActive, starredCountActive, starredCountDeleted, marker, info, serverTime}` —— 统计、类型计数、变更标记、部署信息、服务端时间**同源**（数字与列表来自同一瞬间，不会「控件说 1009、列表说 1008」）。`?deleted=true` 时 `byType` 随视图走（`byTypeActive` 恒活跃）；两个 `starredCount*` 与 `byTypeActive` 一样**恒为全表聚合**、与请求视图无关，前端按当前视图取用。⚠️ 这四个计数是**顶层**字段（快照把 stats 与"随视图的计数"并排放，`/ui/api/statistics` 则是铺平的一个对象）——前端落地时漏搬任何一个都会让那一格静默回落成 0（2026-09-21 实测踩过）。**只读、无副作用**，且统计层只算一次（此前单次请求要列举两遍 R2 全桶，见 O-01）。**不含 `activity`**：那是独立的一天粒度查询，前端在列表落地后单独拉 | 400 参数非法（`deleted` 非法值 → 400 而不是 500） |
| GET | `/ui/api/activity` | 活动趋势（概览带的趋势图 + 抽屉明细）：`?days`（默认 14，上限 **90**）`&tz`（`getTimezoneOffset()` 的分钟数，UTC+8 ⇒ −480）→ `{days:[{day,total,Text,Image,File,Group}], max}`。「一天」按**调用方时区**切分——服务端只知道 UTC，按 UTC 切会让 UTC+8 的用户在早上 8 点前看到的"今天"其实是昨天 | 400 `invalid_range`（days / tz 越界） |
| GET | `/ui/api/info` | 部署信息（客户端该填的地址、版本、传输、保留策略、存储；`cleanup` 为清理状态：`lastRunAt` / `lastError` / 各阶段游标） | — |
| GET | `/ui/api/poll` | 变更信号 `{count, lastModified, serverTime}`——`serverTime` 供界面显示与本机的时钟差（官方客户端在 \|差\| > 5 分钟时中止历史同步） | — |

四处刻意的设计：

1. **列表正文截断（500 字符）并带 `textTruncated`**：粘一段日志是常态，一页几百条长文会有几十 MB。
   前端在复制/预览时若看到该标记，**先取单条全文**——否则用户复制到的是被砍过一半的剪贴板内容。
2. **`data_missing` 与 `not_found` 分开**：`hasData` 是元数据推导（`filePaths.length > 0 ||
   transferDataFile !== ''`），**不代表 R2 对象真的存在**。线上就有这类记录（数据被已修复的孤儿清理
   事故误删）。界面据此渲染「数据不可用」，而不是裂图或静默失败。
3. **`sort` 用 `Object.hasOwn` 做白名单**：`'constructor' in SORT_COLUMNS` 为真（走原型链），
   随后把原生函数源码插进 `ORDER BY` → SQL 语法错误 500，白名单形同虚设（审查代理发现，已修）。
4. **删除是软删，数据文件保留到"真的没了"那一刻**（2026-09-22 改，ADR D29）：`PATCH {"isDelete":true}`
   （单条与批量同一条写路径）置 `IsDeleted=1`，**数据文件不动** —— 到「30 天硬删」（`cleanup.ts` 的
   `DELETED_RETENTION_DAYS`，批次清扫）或用户点「彻底删除」/「清空回收站」时才连目录一起清。
   期间 D1 行仍在、**正文经协议 API 仍可读**、数据的 `GET …/data` 也照常可取（回收站里的图片因此
   能直接预览）。
   ⚠️ **这是有意偏离上游**：上游 `DeleteProfileDataIfNeed` 是 `IsDeleted` 为真就删目录
   （`HistoryService.cs:80`），于是"恢复"对带数据文件的记录必然失败（同文件 `:64` 那条守卫）。
   两条本实现都放开了 —— 回收站因此对**图片/文件**也成立；改之前它只是"元数据墓碑"，
   这正是用户报的"回收站定位不对、图片放进去就回不来"。偏离逐条登记在 `docs/protocol.md` §10。
   界面的确认文案**不再按有无数据文件分叉**（两种情况都能拿回来），统一说
   「30 天内可以从回收站恢复（数据文件同样保留），之后自动彻底清除」。
   **回收站视图**（`deleted=true`）：所有记录都可恢复；「彻底删除」是"立刻清掉"的出口（行 + 数据目录）。
   注意两个期限不是同一个数字：活跃记录的保留期是 `HISTORY_RETENTION_MINUTES`（默认 7 天，
   过期的未收藏/未置顶记录被软删），30 天是**已删除记录**的硬删期限。

5. **`/ui/api/*` 的 JSON 一律 `no-store`，数据端点例外**：列表/统计/变更信号都是「随时会变」
   的私有数据，被浏览器缓存住只会让界面显示陈旧内容（返回键回退时最明显）；判据是「响应尚未自带
   `cache-control` 才补」，故数据端点自带的 `private, max-age=60`（预览/缩略图复用）自动落在例外里。
   变更信号 `/ui/api/poll` 顺带回传 `serverTime`：官方客户端在时钟差 > 5 分钟时会中止历史同步，
   界面的「部署信息」把它显示出来（不为此新增端点，也不多一次请求）。
6. **搜索串上限 48 字节（`MAX_SEARCH_BYTES`）在入口翻译成 400**：`normalizeSearchText` 抛的是
   `InvalidQueryValueError`，若不在查询层翻译成 `UiQueryError`，它会刺穿路由的映射变成 500
   （实测：49 字节的搜索词）。协议侧对同一个错误是 400，两边语义一致；界面把这条错误翻译成
   「搜索词过长（约 16 个汉字）」。
7. **置顶恒优先（`Pinned DESC` 恒在主排序列之前）**：这个接口没有"默认排序"这一档（`sort` 恒有值），
   只在某一列插置顶会让同一个动作时灵时不灵，故默认对**每一列**都生效；`pinnedFirst=false` 是唯一
   例外，给「**全库**最新的那一条」用（V1 的「复制最近一条」——它问的是时间上的最新，不是"当前列表的
   第一行"，让它跟着置顶走会答非所问）。置顶的其余语义与上游一致：`Pinned` 与 `Stared` 一样豁免
   保留期软删与条数裁剪（`db.ts` 的两条 SQL 都带 `Pinned = 0`），但**不豁免**已删除记录的 30 天硬删，
   也不豁免「清空回收站」。界面侧：行内置顶成功后立刻静默对账一次，让这一行**当场**移到最前，
   而不是等下一次轮询时自己跳走（`public/ui_v1/js/main.js` 与 `public/ui_v2/js/boot.js` 的同一条判据）。

---

## 6. 不做什么（以及为什么）

| 项 | 理由 |
|---|---|
| `/dav` 前缀别名 | 本项目的 WebDAV 端点在站点根，`PROPFIND` 的 `href` 是从根计算的绝对路径。要让 `/dav` 前缀可用，必须改写协议输出（href 前缀）——为一个迁移便利去碰协议保真不值得。迁移方式：客户端服务器地址填 `https://<host>/`（界面「部署信息」里直接给出并可复制） |
| 服务端会话表 / 内存会话 | Workers 没有可靠的进程内状态；签名 Cookie 语义等价且零存储（见 ADR D13） |
| Web 字体 | 目标是国内网络：外部字体 CDN 大概率加载失败，会出现「先无字后有字」的闪烁，比系统栈更糟。层级由字号阶梯（13/14/16/18px）与 `tabular-nums` 承担 |
| 列表缩略图预检 | 缩略图用 `loading="lazy"`，对象缺失时由 `<img>` 的 `error` 降级为占位——不为每一行预先发一次探测请求 |

> 反向清单（后端**已具备但界面未接**的能力、以及可新增的端点与改造）见 `docs/backend-gaps.md`；
> 其中本轮已实施的部分记在 `docs/progress.md`。
>
> **「界面走 SignalR Hub 实时推送」已从本表移除**（本轮实施，见 §3.3 第 8 条）：原先的理由
> （「需要给 DO 的连接鉴权加一条 Cookie 通道，即改动协议侧代码」）经复核不成立——DO 的连接鉴权
> 本来就接受 `?id=<token>`，票据由 `/ui/api/hub-ticket` 走会话 Cookie 签发，协议侧一行未改。
> 保留的纪律是：**轮询不关**（连上时 60 秒看门狗、未连上 10 秒、隐藏 30 秒），且页面切到后台
> 主动断开推送通道（后台定时器被节流会退化成「断开→重连」抖动，比它省下的轮询还贵）。

---

### 6.1 同一文档重复初始化（实测触发过）

应用若被以 `/ui_v2/app` 与 `/ui_v2/app/` 两个 URL 同时加载（V1 同理：`/ui_v1` 与 `/ui_v1/`），模块图会出现两份，`boot()` 被第二次求值时
挂载点已被上一次替换掉（`getElementById` 返回 null）→ 半渲染 + 报错。已在 `boot()` 开头用
`document.documentElement.dataset.appBooted` 做幂等保护（3 行，实测拦住）。

## 7. 安全

- **同源 XSS 面**：附件与 API 同源，浏览器会为同源请求自动带上凭据（`src/contentTypes.ts` 的
  「默认-deny 内联白名单」注释记录了这条链）。界面因此：
  - 一切记录文本经 `textContent` 渲染；`js/dom.js` **不提供** `innerHTML` 入口；
  - 图标用 `createElementNS` + 常量路径构造；
  - **内联策略是默认-deny 白名单**（2026-09-21 起）：只有图片（除 svg）、`text/plain`、`text/csv`、
    `text/markdown`、`application/json`、`application/pdf` 允许内联；其余一律由 `fileHeaders` 强制
    `attachment`。HTML/XML 家族（按**后缀**判定，含 `+xml`）另加 CSP 沙箱，**不为预览放宽**；
  - 图片预览依赖 `content-type: image/*` + 同源 `<img>`，不引入 iframe/`<object>` 内联。
- **`?next=` 只接受同源目标**：由 `js/next-target.js` 的纯函数 `resolveNext(raw, location.origin)` 判定——
  `new URL(raw, origin)` 解析出的 `origin` 必须与当前页相等，且返回的只有 `pathname + search + hash`
  （不带 origin，跨源字符串没有漏出的路径）。**前缀比较不够**：浏览器（WHATWG URL）对 http/https
  这类 special scheme 把 `\` 视同 `/`，于是 `?next=/\evil.example` 与 `//evil.example` 一样是协议相对 URL
  而跳到站外——登录成功后与「已登录时打开登录页」两处 `location.replace` 都会中招。
  按 origin 判定后 `//evil.example`、`/\evil.example`、`javascript:alert(1)` 全部落回站内默认页 `/ui_v2/app/`，
  站内目标（如 `?next=/ui_v2/app/?x=1`）照常可用。**指向登录页自身**的目标也回落 —— 否则登录成功后会再次
  落到登录页（多一跳）。判据比的是**平台的规范路径**而不是文件名：实测 `/ui_v2/app/login.html` → 307 →
  `/ui_v2/app/login`（尾斜杠同样被 307 归一），所以带扩展名与不带扩展名两种写法都要算
  （2026-09-19 修，原判据只认文件名 ⇒ 规范形态反而漏掉）。回归用例见 `test/next-target.test.ts`（纯函数）
  与 `test/manual/states.mjs` 的导航计数（真实浏览器：`?next=` 自指时登录页只许加载一次）。
- **失败路径排空请求体**：受守卫的 `PATCH` / `batch-update` / `clear` 都带 body，一旦在未读完入站体时就发出响应，
  Workers 会抛 `Can't read from request stream after response has been sent.` 并让**本 isolate 的后续请求**
  以 503 结束。已在守卫的 401/500、login 的 500、logout、三条 400 早退路径逐一排空；
  另有 `batch-update` / `clear` 的非 JSON → 415 早退（同样先排空，见 §5 的接口表）。
  `test/ui.test.ts` 里有对应的可观测回归用例（400/401 之后紧跟一个正常请求，断言仍是 200）。
- **`noindex`**：私有实例，不该被收录。
- **base64url 末字符的填充位不参与解码**：32 字节签名编成 43 个字符（43×6 = 258 位，比 256 多 2 位），末字符只用高 **4** 位、低 **2** 位是填充位，而 `atob` 忽略填充位。因此「只改末字符填充位」的篡改解码后字节完全相同、验签照样通过——**这不是漏洞**（伪造仍需知道 HMAC），但用它来构造「伪造 Cookie」的测试会随签名值随机通过/失败（改末位约 1/4 命中同一字节，而签名含 `exp`、每轮都不同）。`test/ui.test.ts` 已改为篡改签名首位，并额外断言「篡改后的 base64 解码成不同字节」——把前提本身也测出来，这类失败就不能再靠运气出现。

---

## 8. 设计系统与动效

方言取 **product**（数据表 + 筛选 + 对话框）：圆角 8/10/6px、边框优先于阴影、句子式标签、表格用 `<table>`。
调色板是**暖中性底 + 单一强调色（深青）+ 星标琥珀**——两个色相加一套中性色；刻意避开紫→靛渐变
（生成式页面最可靠的识别特征）。

状态矩阵是硬要求：每个可交互组件都有 rest / hover / `:active` / `:focus-visible` / disabled / loading，
hover 一律包在 `@media (hover: hover) and (pointer: fine)` 内（触屏不会卡住悬停态）；
列表的**空状态是设计过的状态**（说明 + 出口按钮），不是一块空白。

其中 loading 与 success 是**就地**表达的：`.btn` 与 `.icon-btn` 共用 `data-loading`（`::after` 生成的转圈、
保留宽度不抖、同时置 `aria-busy`）与 `data-state="ok"`（对勾 + 结果文案，1.6s 后还原）。
登录、刷新、删除 / 批量删除、复制（文本 / 图片）、下载、部署信息复制都会进入这两个状态——
此前只有登录按钮接了 `data-loading`，其余异步动作期间界面上没有任何信号。

**对话框的高度只有一条契约**（ADR D31，2026-09-22）：`.dialog` 自身是 `flex-direction: column`
（高度上限沿用原生 `<dialog>` 的 UA `max-height`，不自写），页眉/页脚 `flex: none`，
**正文区是唯一的收缩者**（`flex: 1 1 auto; min-height: 0`）。三种对话框（预览 / 确认 / 部署信息）
共用它，于是"视口不够时"的表现是**正文变矮并内部滚动**，而不是页脚被推到视口外 ——
实测 390×360（横屏手机 / 键盘弹起时就是这个几何）：改动前编辑态的页脚落在 381（越出 21px），
改动后三个对话框的页脚都在视野内。新增对话框时**别再各写一个 `max-height`**。
⚠️ 给它加 `display` 时必须**同时**把 UA 那条 `dialog:not([open]) { display: none }` 写回来
（作者规则会盖掉 UA 规则）：2026-09-22 漏了一次，关掉的对话框不再隐藏，连带
`preview.js` 等 `display` 变 `none` 才释放正文的逻辑永远等不到 —— 探针的 `PRVCLOSE`/`AUDIT` 抓到
（见 `progress.md` §131.1）。

动效层只有**一**条准入规则：每个动效都必须对应一个真实的内容事件，且关掉它以后信息不丢。
当前清单（实现全部在 `css/motion.css`）：

| 动效 | 对应的事件 | 约束 |
|---|---|---|
| 行入场（错峰 40ms） | **仅首屏**（第一份非空结果，`hasRendered` 之前） | 首屏之后任何更新（切类型 / 翻页 / 改筛选 / 轮询 / 推送）都不播：级联的尾巴（12 行错峰、下标 0–11 ⇒ 11 × 40ms = 440ms）在用户已经在看这张表时只会读成「内容慢半拍」（实测 6× 降速下一次切换 250~350ms 主线程；早期记的「去掉后 38ms」是更窄窗口的口径，同口径复测见 §11.5）。超过 12 行不再错峰（延迟累积会让第 50 行等两秒） |
| 行高亮闪一次（`row-flash`） | **内容变化**：轮询发现新记录，或某行被对账判定为「内容变了」（别的设备改了它） | 单次播放、落在最终态；不用于「每次刷新」 |
| 行离场淡出（`row-out`） | **删除成功**（行在用户点下确认后就地收掉） | 只淡出不做位移（表格行位移会让整列错位）；`animationend` 之外还有 240ms 兜底定时器，reduced-motion 下也能收掉 |
| 成功对勾弹入（`ok-pop`） | **原地成功态**：复制 / 下载 / 删除等动作做成 | 60% 处轻微过冲，160ms 级；与 `data-state="ok"` 绑定 |
| 星标弹出（`star-pop`） | **收藏状态改变** | `linear()` 采样表达过冲（`cubic-bezier` 做不到）；同一属性不会重启动画，故重放前先删属性 + 强制回流 |
| 浮层进出（`@starting-style` + `overlay/display allow-discrete`） | **对话框开关** | 整段包在 `@supports` 里：不支持 `transition-behavior` 的浏览器若被套用 `opacity: 0`，对话框会**永远看不见** |
| 提示条进出（`toast-in` / `toast-out`） | **瞬时反馈出现与消失** | 离场动画与「最多 4 条」的上限配合（溢出走同步移除，不走动画——见 §3.3 第 2 条） |
| 视图过渡 | **只保留跨文档那一条**（登录页 → 列表页） | 由 `motion.css` 的 `@view-transition { navigation: auto }` 声明。结果区**不具名**：同文档过渡已从列表刷新路径移除（实测开销见「性能预算」一节），`test/ui-contract.test.ts` 有守卫盯着它不被重新引入 |

**刻意不做**：滚动淡入、统一上浮、页面级入场动画、装饰性循环动效——它们不对应任何内容事件。

**关掉动效后页面必须完全可用**：`prefers-reduced-motion: reduce` 下所有动画归零、行立即处于终态、
不做视图过渡（实测：50 行全部 `opacity: 1`、`animation-name: none`；该模式下删除靠兜底定时器收行，
实测无残留的 `data-leaving` 行）。

### 8.1 按下反馈（`:active`，2026-09-18 补全）

上表是"**内容事件的动效**"；按下反馈是另一件事（状态矩阵里的一格，不是内容事件），
实现散在各组件表里（`components.css` / `layout.css`），只有两条规矩：

1. **每个可点控件都要有**（触屏没有 hover，`:active` 是唯一的按下反馈）；
2. 手法两档 —— 小钮/方钮缩放（`.search__clear` `.checkbox` = 0.9、
   `.toast__action` = 0.94、`.segmented__item` = 0.96、`.status` = 0.97），
   文字类控件**不缩放**（表头排序用底色压深一档，缩放会让一行文字抖）。时长一律 `--dur-instant`。

清单（`btn` / `icon-btn` / `segmented__item` / `th-sort` / `search__clear` /
`toast__action` / `checkbox` / `status`）**手写**在 `test/ui-guard.test.ts` 里：新增可点控件
不写 `:active` 就红。此前只有 `.btn` 与 `.icon-btn` 两处有 —— 而 `base.css` 那句"所有可点元素
都有 :active"当时是假的（详见 `progress.md` §68.2）。

### 8.2 「到达并停住」：静止页面必须真的静止（2026-09-18）

`handfeel.md` §7 的"跟随"那一族（相机/光标/导轨/tooltip）在 V1 里一度**没有消费者**：`public/ui_v1/js` 里
没有 rAF、没有插值循环、没有弹簧解算（唯一的时间循环是 `signalr.js` 每 30 秒的保活心跳）。
**2026-09-21 起 tooltip 成为第一个消费者**（`js/components/tooltip.js`，悬停预览，见 §3.3 硬约束 #26）
——它遵守 §7 的「必须到达并停住」（出现即定住、不跟指针走），但仍是纯 CSS 定位 + 定时器，
不引入 rAF/插值循环。⚠️ 它**不接收指针事件**（`pointer-events: none`）：这是它能在数据表里存在的
前提（浮层必然压住后面几行，能命中就等于把那几行封死），见 §3.3 #26 的推导与探针的 `HOVER` 行。
所有"动"都是 CSS 状态过渡 + 一次性 keyframes，停不停由终态负责 —— 这是零构建 ADR D12 的产物。

判据（探针 `SETTLED`）：`document.getAnimations()` 里**没有**还在跑的动画，唯一允许的例外是
在用持续动效编码"正在做"的那两个（推送连接中的旋转环、首屏骨架屏呼吸）。实测静止页面
`runningCount: 0`。这条同时把"装饰性循环动效"挡在门外。

唯一一次踩到 §7.3（"滤波后再补修正 → 一抖一抖"）的是 `list.js` 的 `restoreFocus()` ——
见 §3 第 15 条与 `progress.md` §63.2。

关于 `motion-web` 技能的取用边界见 ADR D14。

---

## 9. 生产打磨（逐条对照 production-polish 清单）

清单里的每一项都是「要么在、要么是缺陷」，故逐条给出结论与**偏离理由**。

### 9.1 头部与元信息

| 项 | 状态 |
|---|---|
| `lang` / `charset` / `viewport` / `color-scheme` | ✅ |
| `<title>` 40–60 字符 | ⚠️ 偏离：用 28 字符的「剪贴板历史 · SyncClipboard（开发测试版）」。这是 noindex 的私有应用，标题长度换不来搜索曝光。**2026-09-18 加了"（开发测试版）"后缀**：默认界面换成了 V1，两份界面长得像，标签页标题必须能一眼分清（V1 那边保持 21 字符的短标题「剪贴板历史 · SyncClipboard」） |
| `meta description` | ✅ |
| `og:type/title/description`、`twitter:card` | ✅（链接被贴进 Slack / 微信时至少有一行像样的预览） |
| `og:image`（绝对 URL，1200×630） | ❌ **有意不做**：og:image 必须是绝对 URL，而部署域名由使用者决定、构建时未知。写死一个错的绝对 URL 会让预览比现在更糟（空白图）。要做就得让 Worker 注入 origin，那等于为了预览把 HTML 从静态资源挪回 Worker——不值 |
| favicon：`.svg` + 32px PNG | ✅（`favicon.svg` + `favicon-32.png`，后者同时作为 manifest 图标） |
| `apple-touch-icon` 180×180 不透明 | ✅（生成后做过像素验收：0 透明像素、0 半透明像素、图形占 62%、居中偏移 ≤0.5px） |
| `manifest` | ✅（`display: standalone`，可直接「添加到主屏幕」） |
| `theme-color` 按主题两行 | ✅（浅 `#faf8f5` / 深 `#191817`） |

### 9.2 404 与爬虫

- ✅ **设计过的 404**：`src/ui/notFound.ts` 服务三个前缀（`/ui/*`、`/ui_v1/*`、`/ui_v2/*`）下未匹配的路径（协议命名空间仍是 JSON/文本 404，语义不动）。
- ✅ `robots.txt` 放**站点根**（`public/robots.txt`，爬虫只读根路径）——`Disallow: /` 与页面里的 `noindex` 构成两道。
- ⚠️ 不做 `sitemap.xml`：整站 noindex，站点地图没有意义。
- ✅ 尾斜杠决策：`/ui` 由静态资源层重定向到 `/ui/`（那一层壳再把人送到 `/ui_v1/`）；协议路由用 Hono 的 `strict: false` 容忍（对齐 ASP.NET）。

### 9.3 非快乐路径的状态

| 状态 | 实现 |
|---|---|
| loading | 骨架屏占位（保留布局，不跳）。**2026-09-18 之前这一行只是一句声明**：`list.js` 根本没有加载档，而 `boot()` 的顺序是 `render()`（items 还空）→ `refresh()`，于是首屏那次请求落地之前的整段时间里，界面画的一直是空状态 —— 库里有记录时它是一句假话（详见 `progress.md` §85）。现在由 `store.loading` 驱动：行数按当前页大小、行高与真实行同高（表格档 47px；卡片档 103px、粗指针 117px —— 2026-09-20 对齐，见 `progress.md` §94 第 16 行），折线以上不发生位移 |
| pending | 按钮原地换标签 + `data-loading` 保持宽度（不抖），登录按钮同样 |
| success | 留在页面上：按钮标签变「已复制 N 个字符」，行原地更新 |
| error | 就地呈现并说明原因（`复制图片失败：<原因>`），登录错误带 `role="alert"` 且焦点回到出错的字段 |
| empty | 设计过的空状态：说明 + 出口按钮（清除筛选 / 如何配置客户端）。**只在数据已经落地且确实为空时才出现**——加载中画它等于替服务器断言"一条都没有" |
| **首次加载失败** | **本轮补上**：此前会把骨架屏永远留在页面上（正是清单点名的「无限骨架」）→ 现在给出「加载失败 + 原因 + 重试」；已有内容时则保留旧数据只给一条提示（比清空更正确） |
| **失去联系**（轮询/统计失败） | **本轮补上**：这两条链路是**静默**的（10s 一次，没有 UI 事件），失败此前没有任何迹象，页面会一直显示旧数据让人以为「服务器上没有新内容」。现在显示一条 `role="status"` 的横幅，成功的那次请求把它收掉 |
| 回收站为空 / 收回筛选 | 空状态按语境换文案与出口：回收站给「返回历史记录」，筛选态给「清除筛选条件」（含时间范围与回收站两个新维度） |

### 9.4 深色模式

- ✅ 令牌层整体重映射（组件层一行未改，符合「level-2 token remap only」）+ 首帧前定主题（实测 5 次重载 `data-theme` 均在首帧前就位、CLS 全 0）。该脚本**本轮从内联外置**为 `/ui_v1/js/theme-init.js`：外链才能让 CSP 保持 `script-src 'self'`（内联要么开 `'unsafe-inline'`、要么维护 hash）。它必须是**经典脚本**——`type="module"` 默认 defer，会晚于首帧。
- ✅ **`color-scheme` 跟随生效主题**（本轮修）：在 `tokens.css` 的 `:root` 与 `:root[data-theme="dark"]` 各声明一次。此前只有 `base.css` 里一句 `color-scheme: light dark`（跟随**系统**），于是浅色系统 + 应用内切深色时，原生 `<select>` 下拉、滚动条、数字输入的 spinner 仍是浅色。实测：改前两种 `data-theme` 下计算值都是 `light dark`，改后分别为 `light` / `dark`。
- ⚠️ 偏离：没有改用 `light-dark()`。它能省掉一半令牌，但令牌的**派生项**（类型色、阴影）仍需成对书写；更关键的是不支持该函数的浏览器会丢掉整条声明、调色板直接失效，而当前写法在任何浏览器都成立。

### 9.5 让页面「像成品」的小东西

- ✅ `::selection`、`accent-color`、`caret-color` 都指向主题色（**本轮补的**：原先原生控件仍是浏览器默认蓝）。
- ✅ 触屏点击高亮已去除，且**与真实 `:active` 态成对**（所有可点元素都有按下反馈）——两者缺一页面在触屏上会显得死。
- ⚠️ 不做 `scrollbar-gutter: stable`：本页不禁用页面滚动（原生 `<dialog>` 不锁 body 滚动），不存在「弹窗一开滚动条消失导致横向跳动」的问题，加了反而常驻一条空白。
- ✅ 中文文案用全角标点。
- ✅ **「部署信息」入口的可发现性**（2026-09-14 记为问题，2026-09-18 定稿）：当时入口是一枚无文字的 ⓘ，
  第一次使用者找不到"客户端该填哪个地址"。现在入口是顶栏那枚**「图标 + 部署信息」**的控件 ——
  **文字就是动作**（可见标签 = 可访问名的开头），图标承载推送状态，hover 给「状态词 + 一句解释」；
  窄屏**只收「复制最近一条」的文字，不收「部署信息」那四个字**。详见 `progress.md` §60。

### 9.6 机器可读的结构

- ✅ 每页恰好一个 `<h1>`（含登录页与 404 页），层级不跳（对话框内为 `<h2>`）。
- ✅ 地标齐全：`<header>` / `<main id="main">` / `<footer>` / `<nav aria-label="分页导航">`。
- ✅ 跳转链接（skip link）在每个页面首位；`.sr-only` 用于只给读屏的文案。
- ⚠️ 不做 JSON-LD：本页没有现实实体（组织/文章/面包屑）可描述。

### 9.7 分析与第三方

✅ 零第三方脚本、零分析（私有实例，且清单要求「至多一个」）。

### 9.8 清单 §9 的十项人工检查（逐项执行结果）

| # | 检查 | 结果 |
|---|---|---|
| 1 | 关闭 JS 加载 | 骨架之外仍有跳转链接、页脚说明与「需要 JavaScript」提示——不是空白页 |
| 2 | `prefers-reduced-motion: reduce` | 50 行全部 `opacity:1`、`animation-name: none`，视图过渡关闭，功能完整 |
| 3 | 全页 Tab | 顺序 = 阅读顺序（跳转链接 → 顶栏 → 工具条 → 表头 → 逐行 → 分页）；无死环；**每一站都有可见焦点环**。站数**随数据变化**（每行 5–6 个可聚焦控件），故不记字面值：2026-09-13 交互打磨轮按 `?pageSize=20` + 搜索为空实测 **123** 个可聚焦元素，搜索命中 1 条时为 **26** 个 |
| 4 | 320 / 375 / 414 / 768 / 1440 | 横向溢出全部 0px |
| 5 | 放大到 200%（等效 720px 视口） | 溢出 0、无裁切、无重叠 |
| 6 | 真机中端安卓 | ❌ 无设备，未做（headless Chromium 的触屏/性能特征不能替代） |
| 7 | 把 URL 贴进 Slack 看预览 | ⚠️ 无 og:image（见 9.1），预览只有标题与描述 |
| 8 | 提交表单（含失败） | 空提交 → 提示 + 焦点回到空字段；错密码 → `role=alert` 的「用户名或密码不正确。」+ 按钮回到非 pending、停留原页 |
| 9 | 访问不存在的 URL | 404 页（含返回入口） |
| 10 | 连续重载 5 次 | 主题每次都在首帧前就位、CLS 全 0、零 console 错误 |

### 9.9 窄屏是一个**具名的降级**，不是副作用

≤720px 时列表从表格重排为两行卡片：

```
[✓] [内容 …………………………………………] [★]
    [类型 · 大小 · 时间]              [预览][复制][下载][删除]
```

- **为什么必须重排**：按桌面列宽摊分，390px 下内容列只剩 **84px**（约 5 个汉字/行），
  而操作列还会把 4 个图标按钮压到 28px——低于 44px 的命中区底线。这正是「移动端沦为
  桌面设计的截图」那种失败。
  重排后实测（headless Chromium，触屏模拟）：375px 内容列 **239px**、414px **278px**，行高 **106px**
  （每屏约 8 行），操作按钮 **44×44**；且换行是**确定**的——320/360/375/414/480/600/720 的内容列
  为 184/224/239/278/344/464/584，严格单调（早先让元信息单独成列时，它是否与操作同行取决于
  flex-basis 恰好放不放得下，出现过 414 比 375 更窄的反常）。
- **类型/大小/时间三列隐藏**，信息改由 `.cell-content__meta` 呈现——它在**内容单元内部**，
  桌面下 `display: none` 不进无障碍树；窄屏下隐藏的是那三列，同一份信息不会被读屏读两遍。
- **表头保留**成一条紧凑排序条——窄屏同样能排序，不是把功能删掉。
- **行内操作在窄屏恒为可见**（不依赖 hover），触屏（`pointer: coarse`）下所有按钮命中区 44px。
- **语义**：改了 `display` 会让 `<table>` 的隐式角色丢失，故 `role="table" / rowgroup /
  row / columnheader / cell` 已在 `list.js` 显式补齐。
- **触屏平板（>720px + `pointer: coarse`）不是窄屏**：卡片重排只在 ≤720px 生效，所以平板仍是表格；
  而桌面操作列（116/88px）是按 30px 图标按钮摊的，触屏上按钮 44px、图片/文件行有 **4 个**按钮
  （4×44 + 3×10 间距 = 206px 内容宽，再加单元格 24px 内边距 = **230px**）塞不进去。
  本轮修法**不是**把重排条件加上 `coarse`（那会让 1024px 的 iPad 也变卡片、每屏只放几行），
  而是**在 coarse 下把操作列按内容放宽到 230px**，超出部分从内容列（弹性列）取。
  实测（**4 按钮的 Image 行**，用 Text 行的 3 按钮行验会得出假结论）：810px 下操作列 88 → **230px**、
  越界按钮 **0**（188px 时是 1 个按钮越出 12px）；721 / 810 / 1024 三档内容列 83 / 172 / 326px、文档溢出 0。
- **触屏命中区补齐**：`.th-sort`（窄屏卡片模式下它就是排序条，命中区只有 42×19）与 `.search__clear`
  （写死 24×24）此前漏在 `pointer: coarse` 白名单外，是全页唯一两处低于 44px 的可点控件。
  现在分别是 **42×44 / 44×44**；清空按钮变大后输入框右侧内边距同步让位（48px），文字不会钻到按钮下面。
- **结果区头部（「共 N 条记录」那一行）恒为 45px，不随选中态改变**（2026-09-21）：勾选几行后
  头部换成操作条（36px 按钮 + 上下留白 = 45px），若头部只有 42px 会当场被顶高 3px，窄屏换行更会跳
  到 89px —— 用户正盯着那行字，跳变看得很清楚。修法是头部固定 45px + 操作条**恒单行、不换行**：
  放不下时整条**自身横向滚动**（与工具栏类型 chips 同一套，`scrollbar-width: none`）。
- **操作条在 ≤560px 只显示图标**（2026-09-21）：复制选中 / 收藏 / 置顶 / 删除选中（及回收站里的
  恢复 / 清空）四个带图标的按钮文字被 CSS 藏掉（`.results__selection .btn:has(svg) .btn__label`），
  可访问名由 JS 的 `aria-label` 承担（与顶栏「复制最近一条」同一手法）；「取消选择」没有图标、
  文字是它唯一的表达，**保留**。这一档正好让 430px 下操作条无需滚动（icon 按钮 42px×4 + 计数 +
  取消选择 ≈ 364px），390px 才需要横滑。

## 10. 验证记录

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 干净（含 `test/**`） |
| `npm test` | **全部 22 套件通过**（用例数见命令输出；`test/ui.test.ts` 覆盖 `/ui/api/*` 的鉴权、列表语义、回收站视图与写操作；`test/ui-activity.test.ts` 覆盖活动趋势的按天分桶；`test/ui-logic.test.ts` 覆盖筛选/格式化/归一化等纯逻辑；`test/next-target.test.ts` 覆盖登录跳转的判定） |
| 横向溢出（320/375/414/768/1024/1440） | **全部 0px**（修复了工具栏与分页在 320px 下溢出 185px） |
| 对比度（浅/深，9 类文本） | 全部 ≥ 4.5:1（修复了三级文本 2.92 / 4.05 两处不达标；2026-09-21 再修一处：`--ink-faint` 在 `--surface-2` 上只有 4.36，axe 报 7 处 serious —— 判据从"白底"换成它真正被用到的最深那层底后调深到 `#706c66`，`--surface-2` 上 4.63、白底 5.2，axe 0 违规） |
| 区块重叠 / 非预期裁切 | 0（几何断言） |
| 浏览器交互（headless Chromium，真实浏览器引擎） | 登录流、筛选/搜索/排序/分页、星标往返、单选/全选、批量删除确认（取消路径）、文本与图片预览、Esc 关闭、空状态、部署信息、主题切换与持久化、`data_missing` 的**三处可达**表现（缩略图占位/预览空态/下载提示） |
| 路由语义 | 匿名 `/ui_v2/不存在` → 404 页；匿名 `/ui/api/*` → 401 JSON；带凭据 `/ui/api/未知` → 404 JSON；协议路径 404 语义不变 |
| 登录跳转 `?next=`（headless Chromium 导航日志 + 纯函数用例） | 打开 `/ui_v2/app/login.html?next=/%5Cevil.example`（反斜杠变体，浏览器解析为 `http://evil.example/`）时，**零交互**的已登录跳转落在 `/ui_v2/app/`（同源），没有站外跳转；`//evil.example`、`javascript:alert(1)`、`https://evil.example`、空值同样落回默认页，`/ui_v2/app/?x=1` 与 `/` 正常返回；页面零 console 错误。**指向登录页自身**时（带扩展名与规范形态两种写法）
另有一条判据：只许加载登录页**一次** —— `states.mjs` 数 `Page.frameNavigated` 而不比最终落点，
因为两条路最终都会到 `/ui_v2/app/`，只比值区分不出来（2026-09-19 加，原判据只认文件名）。
用例：`test/next-target.test.ts` |
| 窄屏行布局（触屏模拟） | 内容列 84px → **239px@375 / 278px@414**、行高 170px → **106px**、操作按钮 **44×44**（独占整行、换行确定）、元信息「类型 · 时间」可见、表头排序保留、溢出 0 |
| 桌面（1440） | 行 55px、七列齐全、`.cell-content__meta` 隐藏——窄屏改动对桌面零影响 |
| 触屏命中区（`pointer: coarse`） | `.btn`/`.select` 44px、`.icon-btn` 44×44（含 `flex: none`）、星标 44×44、分段控件 40px、**`.th-sort` 42×44 / `.search__clear` 44×44**（本轮补） |
| **A 批修复轮**（2026-09-13，详见 `docs/progress.md` §33） | 竞态：同一实验（首个列表请求延迟 2.5s + 120ms 内改两次筛选）下 3.5s 时列表**仍是 Text/50 行**（改前被迟到的图片响应改成 46 行、头部计数同样被改写）；焦点：删除确认后落在**邻居行的删除按钮**（改前 `document.activeElement === BODY`）；`color-scheme` 随生效主题（`light`/`dark`，改前恒 `light dark`）；深色销毁性确认按钮对比 **5.50:1**（改前白字 2.77:1）；列表页「部署信息」的说明文字 12px + 弱化色（改前 14px 无样式）；810px + 触屏操作列 88→**212px**（A 批当轮值；间距后来由 4 提到 10，`--col-actions-coarse` 现为 **230px**）、越界按钮 **0**（188px 时越出 12px）；18 个 JS 资源**全在 22–24ms 内开始**（改前三层瀑布 20/39/50–60ms） |
| 跨文件契约守卫（`ui-contract`，9 例） | ① 每页 `modulepreload` == 该页 import 闭包；② BEM 类名**按页**双向核对（用到的必须在**该页加载的样式表**里有定义、定义了的必须有人用）；③ CSS 消费的 `data-*`/`aria-*` 必须有生产者（JS 或 HTML）；④ 用 Node 原生 ESM 解析器逐个解析模块（只容忍顶层碰 DOM 的运行时错误）。**四次变异实验**（删一行预载 / 加一条死类 / 加一条没人写的属性选择器 / 把 TS 语法写回 `.js`）均按预期变红 |
| 无障碍底线（baseline-ui 逐条） | 动效关闭下内容完整；无「仅靠 hover」的控件；Tab 全站有焦点环、无死环（站数随数据变化，定义见 §9.8 第 3 条）；`<dialog>` 释放焦点；网格轨道 `minmax(0, 1fr)`；`overflow-x: clip` 兜底；图片容器预留高度 |
| **交互打磨轮**（headless Chromium + 本地实例，逐项断言） | 登录流带 `?next=` 回到原 URL；排序指示器随 `th[aria-sort]` 出现（此前是死状态）；星标就地更新（行 DOM 节点不变）且播一次弹出；复制成功后按钮本身变「已复制」；刷新/删除按钮请求中转圈（同步采样 `data-loading`/`aria-busy`，请求结束后清除）；删除对话框初始焦点在「取消」、请求中不关闭、成功后行就地消失并提示「已删除」且**静默刷新确实发出**（页面请求序列 PATCH → /ui/api/statistics → GET /ui/api/history）；`Shift+点击` 范围选择 4 行；行点击开预览（焦点落主操作）、Esc 与点背景均可关闭；选中文字时点行不触发预览；部署信息复制按钮就地成功态；翻页与跳页（跳页后输入清空并失焦）；连点 6 次刷新提示封顶 4 条且页面不冻结；对话框实例唯一（`.dialog--narrow` = 1，排除重复模块图）；`prefers-reduced-motion` 下动画归零、删除照常收行（无 `data-leaving` 僵尸行） |
| 当轮门禁（A 批，历史的数字不改写） | `npx tsc --noEmit` 干净；`npm test` 全部套件通过（当轮为 19 个测试文件；用例数见命令输出，含当轮新增的 `clipboard`） |
| **系统性完善轮**（2026-09-13，详见 `docs/progress.md` §34） | 时间范围：预设 `range=today` 请求携带本地日界 `after`、自定义区间带 `after/before`（`?range=custom&after=1788969600000` → API `after=1788969600000`）；回收站：`?deleted=1` → API `deleted=true`、行内只剩「恢复」（带数据文件的图片记录全部 `disabled` 且 tooltip 说明原因）、恢复一条后计数 −1 且行就地消失并提示「已恢复」；**类型计数与视图同源**：回收站工具栏 `全部 1064 / 文本 667`（已删口径），同一屏的存储明细仍是 `文本 742`（活跃口径）；切回活跃视图 `1009 / 742`；快速切换 6 次两个方向都正确；星标一条后统计条「已收藏」251 → **252 就地更新**（不再等列表刷新）；选择列在回收站隐藏（`display: none`）；失联横幅全程 `hidden`；工具栏在 1440 / 375 两档无横向溢出（自定义日期行独占一行，桌面 36 → 84px）；新元素对比度 —— 统计条回收站入口 **5.47（浅）/ 6.62（深）**、失联横幅 **5.66 / 5.44**（均 ≥ 4.5:1）；登录页在外置主题脚本 + CSP 下三条路径全通过（空提交本地校验、错口令 401 文案、成功登录回列表），零异常 |
| **本轮静态投递**（`_headers`） | 实测响应头：`content-security-policy`（`default-src 'none'` + 逐项白名单）、`x-content-type-options: nosniff`、`referrer-policy: same-origin`、`cache-control: public, no-cache, must-revalidate`（js/css）；页面在**零 CSP 违规**下加载（CDP `Log.entryAdded` + `Runtime.exceptionThrown` 全量采集，0 条） |
| **前端 lint**（`npm run lint`，eslint 覆盖 `public/ui_v2/js` 与 `public/ui_v1/js`——这两个目录不在 `tsc` 的 include 里） | 首次运行抓到 `buildActions(item, actions, ref)` 的 `ref` 从未使用（既有代码）；复核轮加上 `no-shadow` 后又抓到一处**真缺陷的成因**（见 §10 末的复核记录）：`refreshStats` 的局部 `const stats = await api.statistics(...)` 遮蔽了模块级组件实例，`stats.update(...)` 每次都抛 TypeError 被 catch 吞掉 |
| **主世界错误采集**（CDP `Runtime.exceptionThrown` + `Log.entryAdded`） | 遍历改筛选 / 翻页 / 换排序（三条视图过渡路径）后 **0 异常**。采集方式说明：`page.on('console')` 在本 harness 抓不到任何条目（合成 `console.log` 亦无输出），隔离世界的 `window.onerror` 也看不到主世界——**只有 CDP 这条路可信**；本轮据此发现并修掉一个真实缺陷（见下） |

**本轮修掉的两处「状态是死的」缺陷**（都不影响功能、只影响可信度，正因如此长期无人发现）：

- **排序指示器从未显示**：CSS 等的是按钮上的 `.th-sort[aria-sort]`，而 JS 正确地写在 `th` 上（`aria-sort` 的宿主是表头单元格）。排序一直能用，但看不出按哪列、朝哪个方向。
- **星标弹出动画从未播放**：`motion.css` 有 `.star-btn[data-pop="true"]` 的规则，但没有任何代码写 `data-pop`。

**本轮另外修掉两个真实缺陷**：

- **视图过渡被中止时产生 unhandled rejection**：`document.startViewTransition()` 在被中止（文档不可见、或下一次过渡抢先）时会 reject `ready` / `finished`；`dom.js` 原先不接住它，于是后台标签页里每次改筛选/翻页都会抛 `InvalidStateError: Transition was aborted because of invalid state. Document hidden`（CDP 采集到的 3 次即此）。现已接住两个 promise——中止只影响过渡动画本身，DOM 已由 update callback 更新完毕。
- **搜索框出现两个清空入口**：Chromium/WebKit 给 `<input type="search">` 自带的 `::-webkit-search-cancel-button` 从未被关掉，于是与本页自己的 `.search__clear` 并排显示（且原生那颗不受主题/文案/命中区控制）。已在 `components.css` 里关掉原生那颗。

**本轮确立的三处稳健性约束**（详见 §3.3）：对话框结算不依赖 `close` 事件（实测 headless Chromium 上 `dialog.close()` 后该事件不来，依赖它会让调用方的收尾整段丢失）；提示条溢出必须**同步移除**（异步移除写在循环条件里就是死循环——本轮自己踩到并修掉）；同一视图内的刷新按行对账，避免每 10 秒一次的轮询重载缩略图、打断动画、丢掉焦点。

**图片复制的成功路径未能在本环境验证**：headless Chromium 对 `navigator.clipboard.write`（图片）
恒返回 `NotAllowedError: Write permission denied`。为排除「缺少用户激活」这一可能，
最后用 CDP 的真实点击（带瞬时激活）重试，并在导航前 `overridePermissions(['clipboard-write','clipboard-read'])`——
仍被拒。**2026-09-13 复核**：本机唯一可用的带界面浏览器是宿主 Edge，而它正在被使用且没有 CDP 端点——
harness 只能「关掉它」或「用 `app.cdp_url` 连一个显式拉起的实例」，前者会毁掉使用者的窗口与会话，
故**放弃 headed 尝试**（为一条验证边界去动用户的进程不值得）。替代证据是 `test/clipboard.test.ts` 的 9 例：
能力探测、PNG 直写、非 PNG 转码、`unsupported` / `failed(+底层原因)` / `execCommand` 降级全部被钉住——
**「浏览器是否接受写入」本身仍未验证**。文本复制在同环境成功，说明不是本实现的问题。

**不可达的界面分支**：`!hasData && 非 Text` 的「数据不可用」徽标与随之禁用的下载/复制按钮，在服务端
当前的不变量下**不可达**（写入路径拒绝无传输数据的非 Text Profile；实测线上 + 本地 226 条非 Text 记录中
`hasData=false` 为 0 条）。它们保留为防御性分支并在代码里标注，**不计入已验证项**。

**像素级外观：视觉模型不可用，改用可测量的替代**（2026-09-13 复核）：截图走 `?q=` 读图返回
`model does not support vision`，本会话仍无法「看图」。替代证据是**逐像素统计**（浏览器解码截图后统计色相/饱和度）：
桌面浅色 1800×1125 截图中饱和像素仅 **6.07%**，其中紫/靛色相带（240–300°）占 **0.16%**；色相带前列为
30°（暖中性底/琥珀）、80°（Text 类型色）、200–220°（深青强调色）——与设计令牌声明的调色板一致，
没有生成式页面最典型的紫蓝渐变。**这不等价于肉眼验收**：对齐、间距、字重的主观问题仍可能漏过。

其余「版式」结论来自几何、对比度与命中测试的断言，不是肉眼看图；行内缩略图的降级路径在 headless 下需强制
`loading="eager"` 才能触发（headless 不发懒加载请求），已在真实触发条件下验证。

**复核记录（同日，外部复核指出）**：回收站视图里工具栏的**类型计数**与列表对不上——计数来自 `/ui/api/statistics`，
而它统计的是**活跃记录**（`countByType` 写死 `IsDeleted = 0`）。顺着这条线发现并修掉两个真问题：

1. **统计的绘制路径是死的**（既有缺陷，早于本轮）：`refreshStats()` 里 `const stats = await api.statistics(...)`
   **遮蔽**了模块级的组件实例 `const stats = createStats(...)`，于是 `stats.update(...)` 在响应对象上找不到方法
   → 每次调用抛 `TypeError` → 被同一个 `try` 的 `catch` 吞掉，末尾的 `toolbar.update(...)` 因此从未执行。
   界面之所以看着正常，是因为 `render()`（列表刷新路径）顺手把统计也画了一遍——所以计数总是"慢一拍"，
   而统计条的三个数字只在列表刷新时才更新。本轮给它加了 `setStale(true)` 后，失败被放大成
   **「与服务器暂时失去联系」横幅误报**（每次统计刷新都会打开它）。
   修法：局部改名 + 把绘制移出 fetch 的 `try`（真出渲染异常不该被当成网络失败）。
   复验：星标一条记录，「已收藏」251 → **252 就地变化**（不再等下一次列表刷新）；全程 `notice.hidden === true`。
2. **计数与视图不同源**：`/ui/api/statistics` 增加 `deleted=true`（与列表共用 `parseDeletedFlag`），
   `countByType` 带上 `IsDeleted` 条件；前端把这份计数**打上视图标签**（`stats.view`），守卫站在**绘制点**
   （`countsForView()`）——不一致时按「暂无计数」处理，而不是显示另一个视图的数字。
   复验（headless Chromium，快速切换 6 次）：进回收站 `全部 1019 / 文本 635`、切回 `1009 / 740`，
   两个方向都不再出现「显示另一套计数」或「空白」。
3. **把这类遮蔽纳入 lint**：`no-undef` 抓不到（`stats` 确实有定义），`no-shadow` 能——已开（顺手抓出
   `list.js` 的 `filter((node) => …)` 参数遮蔽，一并改名）。

**评审记录（同日的只读设计评审）**：6 条**已复现**缺陷（陈旧响应覆盖新状态、删除后焦点丢到 `<body>`、
810px+触屏按钮溢出操作列、`color-scheme` 不随主题、`.auth__note` 在列表页无样式、模块瀑布 3 层）、
一批可机械核对的缺口（死规则/令牌缺口/命中区漏网/缩略图拉原图/静态资源无缓存与安全头）与四批完善方向，
记在 `docs/progress.md` §32；其中 **A 批（竞态、焦点、主题跟随、死代码、触屏与预载 + 契约守卫）已在 §33 实施并实测**，
**B/C/D 批的主体（尺寸与命中区令牌、遮罩与长时长令牌、`_headers` 与 CSP、静态资源缓存、缩略图阈值、
失联状态、时间范围、回收站与恢复、删除文案口径、前端纯逻辑套件）已在 §34 实施并实测**；
仍未做的只有 **L2 浏览器回归套件**（需要 `puppeteer-core` 等新依赖，且本环境的浏览器验证一直是手跑 + CDP 采集）。
本节表格描述的是**已验证的事实**，与待办不要混读。

---

## 11. 性能预算与探针（改动前端时按这一节量）

**为什么有这一节**：前六轮「优化」全部在核对**正确性**（契约、类名、守卫、测试），从没量过**耗时**——
于是「点一下类型要等 250~350ms、表格内容慢半拍」这类问题只能由用户发现。性能从此是验收项。

### 11.1 预算（改动后的门槛）

| 交互 | 预算（6× CPU 降速下的主线程 TaskDuration，取 3 次中位） |
|---|---|
| 切换类型（同一行集、内容未变） | ≤ 60ms |
| 切换类型（换集合，50 行/页） | ≤ 250ms（2026-09-14 同口径实测 170~190ms，见 §11.5） |
| 其中**脚本**部分（该交互里前端代码真正花的钱） | ≤ 20ms（实测 15~19ms） |
| 翻页（含缩略图解码） | ≤ 600ms |
| 打开部署信息 / 预览 | ≤ 500ms |
| 首屏首行可见 | ≤ 500ms |

> 阈值按**降速**量：本机（Ryzen 7 7735HS）1× 下的数字太宽松，掩盖不了问题；6× 大致对应常见的
> 低功耗笔记本，留 2~3 倍余量即用户在 1× 上的观感。

### 11.2 探针步骤（可复跑，无需改代码）

> ⚠️ **2026-09-21 查实**：下面这套是**人工步骤**，`test/manual/` 四个脚本里**没有任何一个实现过它**
> ——`grep -E "Performance\.(enable|getMetrics)|CPUThrottling"` 在四个文件里零命中；探针量的是页面内
> `PerformanceObserver` 的 CLS，不是这里的 `TaskDuration` 差值。要把它变成可跑脚本，Playwright 已验证
> 可行（`context.newCDPSession` + **`Performance.enable`** 之后 `LayoutDuration` / `RecalcStyleDuration` /
> `ScriptDuration` / `TaskDuration` 都在；不 enable 时 `metrics` 是空数组），见 `progress.md` §105.7。

用 CDP，在同一会话里逐项取 `Performance.getMetrics` 的前后差值（`ScriptDuration` /
`LayoutDuration` / `RecalcStyleDuration` / `TaskDuration`）：

1. `Emulation.setCPUThrottlingRate { rate: 6 }`、`Performance.enable`；
2. 每个场景先取一次指标 → 执行动作 → 等 800ms 稳定 → 再取一次，差值即该次交互的主线程成本；
3. **A/B 必须同会话交替跑**（先 baseline，注入候选样式/开关，再跑一轮），否则页面状态与缓存差异会
   淹没结论——实测有过一次「滚动 2342ms」的假象，真因是懒加载图片，`content-visibility` A/B 后
   证明它对本项目的表格**零收益**（1104ms vs 1118ms layout），因此没有引入。

### 11.3 已量出并据此定下的三条约定

| 决定 | 依据（6× 降速，3 次中位） |
|---|---|
| 列表更新**不做同文档视图过渡** | 一次「什么都没变」的切换，过渡本身 ~60ms（要对结果区整块做布局/样式快照，随页大小上升）；移除后换集合切换 256~351ms → 38ms。⚠️ 这两个数字用的是比 §11.5 更窄的窗口（不含取数），**与 §11.5 的复测值不可比**——结论（不移除过渡就白付一次快照）不变 |
| 入场错峰**只在首屏**播（此后按行对账） | 级联的尾巴（12 行错峰、下标 0–11 ⇒ 11 × 40ms = 440ms）是「内容慢半拍」的观感来源；且它要求整表重建 |
| 行集合未变时**不重建**（按行对账） | 同集合切换 0 次节点变更（修复前 100 次） |

`test/ui-contract.test.ts` 的「性能约定」用例盯着第一条不被重新引入（判据是形态：模块里出现
`startViewTransition` 即红）。

### 11.4 已知的固有成本（不打算优化）

- **pageSize=500**：构建并布局 500 行 ≈ 3.0s TaskDuration（6×）、其中脚本仅 ~20ms，其余是布局/样式
  ——表格行无法用 `content-visibility` 跳过（实测无收益）。要再快只能做虚拟滚动，而单用户场景
  一页 50 条足够，故不做。
- **翻页**：成本主要是新页面缩略图的解码（图片记录多时明显），已由 `loading="lazy"` 限制在可见范围。

### 11.5 测量窗口（2026-09-14 复测后钉住的口径）

同一个交互换个窗口能差 5 倍，所以先钉窗口再谈预算：

- **窗口**：`click` 起算 → 稳定后（+900ms）止，取 CDP `Performance.getMetrics` 前后差值；6× CPU 降速；
  **同会话交替 A/B**；每场景 3 次取中位。**窗口包含取数**（请求 + JSON 解析 + 渲染）——用户点下去等的就是这段时间。
  ⚠️ 窗口里也会混进**非交互工作**：懒加载缩略图的解码（图片档尤其明显）、轮询/推送触发的对账重渲染。
  所以这个口径量的是**用户感知成本**，只适合「有没有变慢」以及 A/B 对比；**归因**（到底是哪一行代码花的钱）
  必须看 `ScriptDuration`——前端代码的成本在脚本里，其余是浏览器布局/样式与网络。
- **换集合切换（50 行/页，文本档）复测**：把基线（`d57ad4d`）与当前（`7d806e6`）用**同构代理**各挂一个端口
  消除直连/代理差异，交替各跑 3 轮：基线 **178ms** vs 当前 **190ms**，**脚本部分两者都是 15~19ms**。
  轮间波动 30~190ms（内容未变的那一轮布局几乎为零，基线一次样本仅 30.8ms）——**差异落在噪声内，本次可维护性清理无性能回归**。
- **据此修正 §11.1**：整体「点击→稳定」~170~200ms（阈值 250ms）；**前端代码能控制的是脚本部分，阈值 ≤ 20ms**。
- **图片档换集合贵得多**（同日实测 475~767ms）：那是缩略图的布局与解码，属 §11.4 的固有成本，不是列表代码的开销。

---
