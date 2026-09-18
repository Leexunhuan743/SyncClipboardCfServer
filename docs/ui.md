# Web 历史界面（`/ui/`）

本文件描述本项目的 Web 界面：它的来源、与协议面的边界、模块划分、鉴权模型、设计系统与验证记录。

**一句话**：界面把另一个实现（Python 项目 `clipserver`）里「用浏览器看剪贴板历史」这件事，按本项目的
架构重写了一遍——数据面完全复用官方历史 API 的同一套表与语义，另开一层只为界面服务的
`/ui/api/*`，不动任何客户端依赖的协议行为。

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
| 5b | 类型筛选 / 搜索 / 收藏筛选 / 日期范围 | 复用官方查询语义（`Types` 位掩码、`SearchText`、`Starred`、`Before/After`） |
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
  │  GET /ui/**            → Cloudflare 静态资源（public/ui/**，不经过 Worker）
  │  GET/PATCH /ui/api/**  → Worker：src/ui/routes.ts（会话 Cookie 或 Basic 鉴权）
  │  GET /ui/api/**/data   → Worker → R2（图片预览 / 文件下载）
  ▼
Worker
  ├─ src/ui/*        UI 自己的面（本文件描述）
  ├─ src/routes/*    协议面（/api/history/*、/SyncClipboard.json、/file/*）—— 客户端依赖，**未改动语义**
  └─ src/durable/*   SignalR 兼容 Hub（客户端连接用；界面不走它，见 §6）
```

三条不变式：

1. **协议面无 UI 依赖**：`src/routes/*` 不 import `src/ui/*`；反向依赖只允许 `src/ui/*` 复用
   `src/historyOps.ts`、`src/db.ts`、`src/storage.ts`、`src/serialization.ts`。
2. **写路径唯一**：界面上的收藏/置顶/删除都经 `src/historyOps.ts` 的 `applyHistoryUpdate`——
   与官方 `PATCH /api/history/{type}/{hash}` 是同一个实现（同一套版本判定、同一条广播、同一次 R2 清理）。
   这样「界面改了但客户端不知道」在结构上不可能发生。
3. **静态资源不占协议路径**：`public/` 下不放 `index.html`，所有资源都在 `/ui/` 下；
   根路径留给 `PROPFIND`（客户端的探活与目录列举）。

`wrangler.toml` 的 `[assets]` 只声明 `directory` 与 `not_found_handling = "none"`：命中资源的请求由边缘
直接返回，未命中的（含全部协议请求）回落给 Worker。

---

## 3. 模块划分

### 3.1 服务端（`src/ui/`，5 个模块，一个文件一个职责）

| 文件 | 职责 |
|---|---|
| `session.ts` | 无状态签名 Cookie：签发 / 校验 / 清除。纯密码学，不含路由与 HTTP 语义 |
| `guard.ts` | 鉴权：会话 Cookie 或 Basic；401 的响应形状与失败路径的请求体排空 |
| `query.ts` | 只读查询层：参数解析、白名单排序、LIKE 转义、分页、按类型计数、变更信号。拥有 `UiHistoryItem` / `UiListQuery` 等类型 |
| `routes.ts` | 路由装配：把 HTTP 映射到上面三者 + 复用协议层的 `HistoryDb`/`R2Storage`/`applyHistoryUpdate` |
| `notFound.ts` | `/ui/*` 未匹配路径的 404 页（只覆盖 UI 命名空间，不碰协议 404 语义） |

共享层的小幅开放：`db.ts` 导出 `rowToEntity`/`DbRow`（界面按自己的排序读同一张表，若另写一份映射，
两处对 NULL/布尔列的解释迟早分叉）；`contentTypes.ts` 从 `routes/webdav.ts` 抽出（`fileHeaders`
现有两个真实调用方：WebDAV 附件与界面数据端点——少一道 `nosniff` 就是一个存储型 XSS 面）；
`auth.ts` 抽出 `verifyCredentials`（Basic 头与登录表单共用）。

### 3.2 前端（`public/ui/`，真文件 + 原生 ES 模块，无构建步骤）

共 32 个资源：`public/ui/` 下 31 个（2 个 HTML + 6 张样式表 + 19 个 JS 模块（10 个顶层 + 9 个组件）
+ `favicon.svg` / `favicon-32.png` / `apple-touch-icon.png` / `manifest.webmanifest`），
外加站点根的 `robots.txt`（爬虫只读根路径，故不能放 `/ui/` 下）。

| 文件 | 职责 |
|---|---|
| `index.html` / `login.html` | 页面外壳与挂载点；主题在首帧前由内联脚本定好（深色用户不会看到白闪） |
| `css/tokens.css` | 设计令牌：颜色（浅/深）、字号阶梯、间距、圆角、阴影、时长与缓动 |
| `css/base.css` | 重置、排版、`:focus-visible`、跳转链接、微标签 |
| `css/layout.css` | 骨架：顶栏、统计条、工具栏、结果区、页脚 |
| `css/components.css` | 组件：按钮、字段、分段控件、徽标、数据表、星标、复选框、对话框、提示、空状态、分页 |
| `css/motion.css` | 动效集中处 + `prefers-reduced-motion` 的等价降级 |
| `css/auth.css` | 登录页专属样式（列表页不加载） |
| `js/api.js` | `/ui/api` 调用封装、类型归一化、401 统一跳登录 |
| `js/filters.js` | 筛选状态 ⇄ URL（可链接、可后退、刷新不丢） |
| `js/store.js` | 状态容器（订阅制），不掺 DOM 不掺网络 |
| `js/dom.js` | DOM 工具。**不提供任何插入 HTML 的途径**（见 §7） |
| `js/icons.js` | 图标路径常量表（不用 emoji；含原地成功态用的 `check`） |
| `js/clipboard.js` | 剪贴板写入（文本 / 图片）：安全上下文探测、非 PNG 转码、失败降级与**带原因的判别结果**（`{status, reason}`：`unsupported` 与 `failed` 分别对应「换环境」和「权限/激活问题」，并把底层原因带进提示，不混成一句「不支持」） |
| `js/format.js` | 类型/体积/时间/摘要的展示格式化 |
| `js/components/header.js` | 顶栏（标识、版本、主题切换、会话操作） |
| `js/components/stats.js` | 统计条（三个真实数字） |
| `js/components/toolbar.js` | 类型分段筛选、收藏筛选、搜索（含清空按钮、`Esc` 清空、`focusSearch()` 供快捷键调用）、每页条数、刷新（按钮自带进行中态） |
| `js/components/list.js` | 结果区：表格、行、排序表头、选择条（Shift 范围选择）、空状态、缩略图与降级；**同一视图内的刷新按行对账**（内容未变的行不重建，见 §3.3） |
| `js/components/pagination.js` | 范围文本、上一页/下一页、跳页（聚焦全选、回车后清空并交还焦点；只有一页时隐藏跳页） |
| `js/components/preview.js` | 预览对话框（文本全文 / 图片原图 / 不可用态）；点背景关闭、打开时焦点落在主操作、长文本先给加载态 |
| `js/components/confirm.js` | 确认对话框（销毁性操作前问一句）：请求进行中留在对话框内、失败就地显示原因可重试；**结算不依赖 `close` 事件**（见 §3.3） |
| `js/components/info.js` | 部署信息对话框；服务器地址一键复制用原地成功态 |
| `js/components/toast.js` | 反馈层：瞬时提示（离场动画、最多 4 条）+ **原地状态** `setPending` / `flashSuccess`（行内按钮与对话框按钮共用，见 §3.3） |
| `js/main.js` | 装配点：唯一知道「谁是谁」的地方；`actions` 返回「是否做成」供组件呈现，另承载 `/` 快捷键与翻页/改筛选后的滚动定位 |
| `js/login.js` | 登录页逻辑 |
| `js/next-target.js` | 登录后「下一跳」的判定（纯函数 `resolveNext`）：只接受**同源**目标，否则回落站内默认页。独立成文件是为了能被测试直接覆盖（见 §7） |

### 3.3 前端交互约定（改动这些地方前先读）

五条约定是**功能正确性**的一部分，不是风格偏好：

1. **actions 返回结果，组件呈现结果。** `main.js` 的 action 返回 `true` 才算做成；行内按钮据此决定是否显示成功态。只看「请求发出去了」会把失败显示成成功。
2. **原地反馈优先于提示条。** 用户按的是哪个控件，结果（进行中 / 成功）就落在哪个控件上（`setPending` / `flashSuccess`）；提示条只承载需要解释或跨控件的反馈（错误、降级）。
3. **同一视图内的刷新按行对账。** `list.js` 用内容签名（`signature()`）比对，未变化的行**不重建**——重建成整表会让每 10 秒一次的轮询重载缩略图、打断动画、丢掉焦点。新视图（翻页/改筛选）才整表重建并错峰入场。
4. **对话框的结算不依赖 `close` 事件。** 主路径（确认 / 取消）在**决定的当下**结算 Promise，`close` / `cancel` 只作旁路兜底（Esc、点背景）。依赖事件会让「事件不来即永不结算」，调用方 `await` 之后的收尾（提示、刷新）整段丢失——实测 headless Chromium 上 `dialog.close()` 后 `close` 事件就不来。
5. **删除成功后行就地收掉**（`list.removeItem`），随后静默刷新补齐并对其余行对账；等下一次整页刷新才消失会读成「点了没反应」。

> 前台另有两条与本轮无关但同样承重的旧约定：正文一律走 `textContent`（`dom.js` 不提供插入 HTML 的途径，见 §7）；行入场只在新视图播放（轮询刷新不重放，避免「幻灯片式入场」）。

---

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
| GET | `/ui/api/history` | 列表：`page` `pageSize`(≤500) `types` `search` `starred` `after` `before` `sort` `order` `includeDeleted` | 400 参数非法 |
| GET | `/ui/api/history/:type/:hash` | 单条元数据（**正文完整**） | 400/404 |
| GET | `/ui/api/history/:type/:hash/data` | 数据文件；`?download=1` 走附件 | 404 `not_found` / 404 `data_missing` |
| PATCH | `/ui/api/history/:type/:hash` | 收藏 / 置顶 / 删除（复用 `applyHistoryUpdate`） | 400/404/409 |
| POST | `/ui/api/history/batch-delete` | 批量软删（≤200 条，逐条走同一条写路径）；**只接受 `application/json`** | 400 / 415（内容类型不是 JSON，审计残余 G3） |
| GET | `/ui/api/statistics` | 官方统计 + 按类型分布 | — |
| GET | `/ui/api/info` | 部署信息（客户端该填的地址、版本、传输、保留策略、存储；`cleanup` 为清理状态：`lastRunAt` / `lastError` / 各阶段游标） | — |
| GET | `/ui/api/poll` | 变更信号 `{count, lastModified}` | — |

四处刻意的设计：

1. **列表正文截断（500 字符）并带 `textTruncated`**：粘一段日志是常态，一页几百条长文会有几十 MB。
   前端在复制/预览时若看到该标记，**先取单条全文**——否则用户复制到的是被砍过一半的剪贴板内容。
2. **`data_missing` 与 `not_found` 分开**：`hasData` 是元数据推导（`filePaths.length > 0 ||
   transferDataFile !== ''`），**不代表 R2 对象真的存在**。线上就有这类记录（数据被已修复的孤儿清理
   事故误删）。界面据此渲染「数据不可用」，而不是裂图或静默失败。
3. **`sort` 用 `Object.hasOwn` 做白名单**：`'constructor' in SORT_COLUMNS` 为真（走原型链），
   随后把原生函数源码插进 `ORDER BY` → SQL 语法错误 500，白名单形同虚设（审查代理发现，已修）。
4. **删除是软删，不是立即清除**：`PATCH {"isDelete":true}`（单条与批量同一条写路径）只置 `IsDeleted=1`
   并清 R2 数据目录；D1 行在 **30 天**（`cleanup.ts` 的 `DELETED_RETENTION_DAYS`）内仍存在，
   **正文经协议 API 仍可读**，到期才由清理任务硬删（D1 行 + R2 目录）。这是与上游 `HistoryCleaner`
   一致的语义（协议面对齐，不单边偏离）；界面的删除确认文案按此表述（「服务端仍保留该记录（软删），
   30 天后才彻底清除」），**不承诺「立即彻底删除」**。要做「立即彻底清除」得作为新功能立项（D1 与 R2 双清）。
   注意两个期限不是同一个数字：活跃记录的保留期是 `HISTORY_RETENTION_MINUTES`（默认 7 天，
   过期的未收藏/未置顶记录被软删），30 天是**已删除记录**的硬删期限。

---

## 6. 不做什么（以及为什么）

| 项 | 理由 |
|---|---|
| `/dav` 前缀别名 | 本项目的 WebDAV 端点在站点根，`PROPFIND` 的 `href` 是从根计算的绝对路径。要让 `/dav` 前缀可用，必须改写协议输出（href 前缀）——为一个迁移便利去碰协议保真不值得。迁移方式：客户端服务器地址填 `https://<host>/`（界面「部署信息」里直接给出并可复制） |
| 界面走 SignalR Hub 实时推送 | 需要给 DO 的连接鉴权加一条 Cookie 通道，即改动协议侧代码；收益只是「更快一点」。改用 `/ui/api/poll` 的变更信号（可见 10s / 隐藏 30s），完全隔离在 UI 面内 |
| 服务端会话表 / 内存会话 | Workers 没有可靠的进程内状态；签名 Cookie 语义等价且零存储（见 ADR D13） |
| Web 字体 | 目标是国内网络：外部字体 CDN 大概率加载失败，会出现「先无字后有字」的闪烁，比系统栈更糟。层级由字号阶梯（12/13/14/18/30px）与 `tabular-nums` 承担 |
| 列表缩略图预检 | 缩略图用 `loading="lazy"`，对象缺失时由 `<img>` 的 `error` 降级为占位——不为每一行预先发一次探测请求 |

---

### 6.1 同一文档重复初始化（实测触发过）

应用若被以 `/ui` 与 `/ui/` 两个 URL 同时加载，模块图会出现两份，`boot()` 被第二次求值时
挂载点已被上一次替换掉（`getElementById` 返回 null）→ 半渲染 + 报错。已在 `boot()` 开头用
`document.documentElement.dataset.appBooted` 做幂等保护（3 行，实测拦住）。

## 7. 安全

- **同源 XSS 面**：附件与 API 同源，浏览器会为同源请求自动带上凭据（`routes/webdav.ts` 的
  `RENDERABLE_TYPES` 注释记录了这条链）。界面因此：
  - 一切记录文本经 `textContent` 渲染；`js/dom.js` **不提供** `innerHTML` 入口；
  - 图标用 `createElementNS` + 常量路径构造；
  - 可渲染类型（html/svg/xml）继续由 `fileHeaders` 强制降级为附件，**不为预览放宽**；
  - 图片预览依赖 `content-type: image/*` + 同源 `<img>`，不引入 iframe/`<object>` 内联。
- **`?next=` 只接受同源目标**：由 `js/next-target.js` 的纯函数 `resolveNext(raw, location.origin)` 判定——
  `new URL(raw, origin)` 解析出的 `origin` 必须与当前页相等，且返回的只有 `pathname + search + hash`
  （不带 origin，跨源字符串没有漏出的路径）。**前缀比较不够**：浏览器（WHATWG URL）对 http/https
  这类 special scheme 把 `\` 视同 `/`，于是 `?next=/\evil.example` 与 `//evil.example` 一样是协议相对 URL
  而跳到站外——登录成功后与「已登录时打开登录页」两处 `location.replace` 都会中招。
  按 origin 判定后 `//evil.example`、`/\evil.example`、`javascript:alert(1)` 全部落回站内默认页 `/ui/`，
  站内目标（如 `?next=/ui/?x=1`）照常可用。回归用例见 `test/next-target.test.ts`。
- **失败路径排空请求体**：受守卫的 `PATCH` / `batch-delete` 都带 body，一旦在未读完入站体时就发出响应，
  Workers 会抛 `Can't read from request stream after response has been sent.` 并让**本 isolate 的后续请求**
  以 503 结束。已在守卫的 401/500、login 的 500、logout、三条 400 早退路径逐一排空；
  另有 `batch-delete` 的非 JSON → 415 早退（同样先排空，见 §5 的接口表）。
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

动效层只有**一**条准入规则：每个动效都必须对应一个真实的内容事件，且关掉它以后信息不丢。
当前清单（实现全部在 `css/motion.css`）：

| 动效 | 对应的事件 | 约束 |
|---|---|---|
| 行入场（错峰 40ms） | **新视图**：首次加载 / 翻页 / 改筛选 | 只在 `viewToken` 变化时播放；轮询刷新不播，否则每次刷新整页闪一遍。超过 12 行不再错峰（延迟累积会让第 50 行等两秒） |
| 行高亮闪一次（`row-flash`） | **内容变化**：轮询发现新记录，或某行被对账判定为「内容变了」（别的设备改了它） | 单次播放、落在最终态；不用于「每次刷新」 |
| 行离场淡出（`row-out`） | **删除成功**（行在用户点下确认后就地收掉） | 只淡出不做位移（表格行位移会让整列错位）；`animationend` 之外还有 240ms 兜底定时器，reduced-motion 下也能收掉 |
| 成功对勾弹入（`ok-pop`） | **原地成功态**：复制 / 下载 / 删除等动作做成 | 60% 处轻微过冲，160ms 级；与 `data-state="ok"` 绑定 |
| 星标弹出（`star-pop`） | **收藏状态改变** | `linear()` 采样表达过冲（`cubic-bezier` 做不到）；同一属性不会重启动画，故重放前先删属性 + 强制回流 |
| 浮层进出（`@starting-style` + `overlay/display allow-discrete`） | **对话框开关** | 整段包在 `@supports` 里：不支持 `transition-behavior` 的浏览器若被套用 `opacity: 0`，对话框会**永远看不见** |
| 提示条进出（`toast-in` / `toast-out`） | **瞬时反馈出现与消失** | 离场动画与「最多 4 条」的上限配合（溢出走同步移除，不走动画——见 §3.3 第 2 条） |
| 视图过渡（`view-transition-name: results`） | **翻页 / 改筛选后的结果区替换** | 由 `withViewTransition` 触发；被中止是正常路径（后台标签页），已接住 `ready`/`finished` 的 rejection |

**刻意不做**：滚动淡入、统一上浮、页面级入场动画、装饰性循环动效——它们不对应任何内容事件。

**关掉动效后页面必须完全可用**：`prefers-reduced-motion: reduce` 下所有动画归零、行立即处于终态、
不做视图过渡（实测：50 行全部 `opacity: 1`、`animation-name: none`；该模式下删除靠兜底定时器收行，
实测无残留的 `data-leaving` 行）。

关于 `motion-web` 技能的取用边界见 ADR D14。

---

## 9. 生产打磨（逐条对照 production-polish 清单）

清单里的每一项都是「要么在、要么是缺陷」，故逐条给出结论与**偏离理由**。

### 9.1 头部与元信息

| 项 | 状态 |
|---|---|
| `lang` / `charset` / `viewport` / `color-scheme` | ✅ |
| `<title>` 40–60 字符 | ⚠️ 偏离：用 22 字符的「剪贴板历史 · SyncClipboard」。这是 noindex 的私有应用，标题长度换不来搜索曝光，短标题在书签与标签页里更好认 |
| `meta description` | ✅ |
| `og:type/title/description`、`twitter:card` | ✅（链接被贴进 Slack / 微信时至少有一行像样的预览） |
| `og:image`（绝对 URL，1200×630） | ❌ **有意不做**：og:image 必须是绝对 URL，而部署域名由使用者决定、构建时未知。写死一个错的绝对 URL 会让预览比现在更糟（空白图）。要做就得让 Worker 注入 origin，那等于为了预览把 HTML 从静态资源挪回 Worker——不值 |
| favicon：`.svg` + 32px PNG | ✅（`favicon.svg` + `favicon-32.png`，后者同时作为 manifest 图标） |
| `apple-touch-icon` 180×180 不透明 | ✅（生成后做过像素验收：0 透明像素、0 半透明像素、图形占 62%、居中偏移 ≤0.5px） |
| `manifest` | ✅（`display: standalone`，可直接「添加到主屏幕」） |
| `theme-color` 按主题两行 | ✅（浅 `#faf8f5` / 深 `#191817`） |

### 9.2 404 与爬虫

- ✅ **设计过的 404**：`src/ui/notFound.ts` 服务 `/ui/*` 下未匹配的路径（协议命名空间仍是 JSON/文本 404，语义不动）。
- ✅ `robots.txt` 放**站点根**（`public/robots.txt`，爬虫只读根路径）——`Disallow: /` 与页面里的 `noindex` 构成两道。
- ⚠️ 不做 `sitemap.xml`：整站 noindex，站点地图没有意义。
- ✅ 尾斜杠决策：`/ui` 由静态资源层重定向到 `/ui/`；协议路由用 Hono 的 `strict: false` 容忍（对齐 ASP.NET）。

### 9.3 非快乐路径的状态

| 状态 | 实现 |
|---|---|
| loading | 骨架屏占位（保留布局，不跳） |
| pending | 按钮原地换标签 + `data-loading` 保持宽度（不抖），登录按钮同样 |
| success | 留在页面上：按钮标签变「已复制 N 个字符」，行原地更新 |
| error | 就地呈现并说明原因（`复制图片失败：<原因>`），登录错误带 `role="alert"` 且焦点回到出错的字段 |
| empty | 设计过的空状态：说明 + 出口按钮（清除筛选 / 如何配置客户端） |
| **首次加载失败** | **本轮补上**：此前会把骨架屏永远留在页面上（正是清单点名的「无限骨架」）→ 现在给出「加载失败 + 原因 + 重试」；已有内容时则保留旧数据只给一条提示（比清空更正确） |

### 9.4 深色模式

- ✅ 令牌层整体重映射（组件层一行未改，符合「level-2 token remap only」）+ `<head>` 里的阻塞式内联脚本在首帧前定好主题（实测 5 次重载 `data-theme` 均在首帧前就位、CLS 全 0）。
- ⚠️ 偏离：没有改用 `light-dark()`。它能省掉一半令牌，但令牌的**派生项**（类型色、阴影）仍需成对书写；更关键的是不支持该函数的浏览器会丢掉整条声明、调色板直接失效，而当前写法在任何浏览器都成立。

### 9.5 让页面「像成品」的小东西

- ✅ `::selection`、`accent-color`、`caret-color` 都指向主题色（**本轮补的**：原先原生控件仍是浏览器默认蓝）。
- ✅ 触屏点击高亮已去除，且**与真实 `:active` 态成对**（所有可点元素都有按下反馈）——两者缺一页面在触屏上会显得死。
- ⚠️ 不做 `scrollbar-gutter: stable`：本页不禁用页面滚动（原生 `<dialog>` 不锁 body 滚动），不存在「弹窗一开滚动条消失导致横向跳动」的问题，加了反而常驻一条空白。
- ✅ 中文文案用全角标点。

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

## 10. 验证记录

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 干净（含 `test/**`） |
| `npm test` | **全部 18 套件通过**（用例数见命令输出；`test/ui.test.ts` 覆盖 `/ui/api/*` 的鉴权、列表语义与写操作；`test/next-target.test.ts` 覆盖登录跳转的判定） |
| 横向溢出（320/375/414/768/1024/1440） | **全部 0px**（修复了工具栏与分页在 320px 下溢出 185px） |
| 对比度（浅/深，9 类文本） | 全部 ≥ 4.5:1（修复了三级文本 2.92 / 4.05 两处不达标） |
| 区块重叠 / 非预期裁切 | 0（几何断言） |
| 浏览器交互（headless Chromium，真实浏览器引擎） | 登录流、筛选/搜索/排序/分页、星标往返、单选/全选、批量删除确认（取消路径）、文本与图片预览、Esc 关闭、空状态、部署信息、主题切换与持久化、`data_missing` 的**三处可达**表现（缩略图占位/预览空态/下载提示） |
| 路由语义 | 匿名 `/ui/不存在` → 404 页；匿名 `/ui/api/*` → 401 JSON；带凭据 `/ui/api/未知` → 404 JSON；协议路径 404 语义不变 |
| 登录跳转 `?next=`（headless Chromium 导航日志 + 纯函数用例） | 打开 `/ui/login.html?next=/%5Cevil.example`（反斜杠变体，浏览器解析为 `http://evil.example/`）时，**零交互**的已登录跳转落在 `/ui/`（同源），没有站外跳转；`//evil.example`、`javascript:alert(1)`、`https://evil.example`、空值同样落回默认页，`/ui/?x=1` 与 `/` 正常返回；页面零 console 错误。用例：`test/next-target.test.ts` |
| 窄屏行布局（触屏模拟） | 内容列 84px → **239px@375 / 278px@414**、行高 170px → **106px**、操作按钮 **44×44**（独占整行、换行确定）、元信息「类型 · 时间」可见、表头排序保留、溢出 0 |
| 桌面（1440） | 行 55px、七列齐全、`.cell-content__meta` 隐藏——窄屏改动对桌面零影响 |
| 触屏命中区（`pointer: coarse`） | `.btn`/`.select` 44px、`.icon-btn` 44×44（含 `flex: none`）、星标 44×44、分段控件 40px |
| 无障碍底线（baseline-ui 逐条） | 动效关闭下内容完整；无「仅靠 hover」的控件；Tab 全站有焦点环、无死环（站数随数据变化，定义见 §9.8 第 3 条）；`<dialog>` 释放焦点；网格轨道 `minmax(0, 1fr)`；`overflow-x: clip` 兜底；图片容器预留高度 |
| **交互打磨轮**（headless Chromium + 本地实例，逐项断言） | 登录流带 `?next=` 回到原 URL；排序指示器随 `th[aria-sort]` 出现（此前是死状态）；星标就地更新（行 DOM 节点不变）且播一次弹出；复制成功后按钮本身变「已复制」；刷新/删除按钮请求中转圈（同步采样 `data-loading`/`aria-busy`，请求结束后清除）；删除对话框初始焦点在「取消」、请求中不关闭、成功后行就地消失并提示「已删除」且**静默刷新确实发出**（页面请求序列 PATCH → /ui/api/statistics → GET /ui/api/history）；`Shift+点击` 范围选择 4 行；行点击开预览（焦点落主操作）、Esc 与点背景均可关闭；选中文字时点行不触发预览；部署信息复制按钮就地成功态；翻页与跳页（跳页后输入清空并失焦）；连点 6 次刷新提示封顶 4 条且页面不冻结；对话框实例唯一（`.dialog--narrow` = 1，排除重复模块图）；`prefers-reduced-motion` 下动画归零、删除照常收行（无 `data-leaving` 僵尸行） |
| 本轮门禁 | `npx tsc --noEmit` 干净；`npm test` **全部 18 个套件通过**（用例数见命令输出；含本轮新增的 `clipboard`） |
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
