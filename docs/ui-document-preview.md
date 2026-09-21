# 文档预览集成（File Viewer）— 决策、方案与过程

> **状态**：**7 项决策已定并获授权**（2026-09-21，用户逐项确认；含 §7 的 CSP 放宽授权 —— **仅限承载预览的那一张 HTML：列表页**）。
> **代码未动**；2026-09-21 **轮 4 复审**（本文 §10 末段）把方案按实测重新过了一遍，结论是**三处硬伤必须改**：
> ① §7 的"在 `_headers` 里另写一条更宽的 CSP"**机制上行不通**（同名字段逗号合并 ⇒ 交集 ⇒ 放宽无效，实测见 §3.2），
> 改由 **Worker 出承载预览那张 HTML 的响应**（新 **D-8**）；② §6 阶段 0 的对象 `@file-viewer/web-full` **与 D-1 自相矛盾**
> （`web-full` = `preset-all`，依赖链里带 AGPL-3.0-only 的 CAD 运行时），改为**离线构建标准档**；
> ③ 计划缺"**怎么构建**"这一环（`@file-viewer/web` 只有壳），补 **D-3 的交付形态 + G14 构建配方**。
> 修订后的下一步：阶段 0（含 JS 侧实测；资源侧本轮已先量完，见 §3.1）与阶段 1 可并行。本文是这次改动的**唯一过程记录 + 决策记录**；
> ADR 摘要见 [`design.md`](design.md) D21，界面口径见 [`ui.md`](ui.md)，
> 按轮次的过程追加到本文 §10 与 [`progress.md`](progress.md)。

## 1. 目标与非目标

**目标**：给 V1（`public/ui_v1/`，默认界面）增加「**文档预览**」这一档能力 —— 把
[`flyfish-dev/file-viewer`](https://github.com/flyfish-dev/file-viewer)（自有源码 Apache-2.0）
作为**内容渲染器**接进来。外壳、判据、文案、状态机、动作条由我们拥有；列表页**首屏不加载它的任何资产**。

**非目标**：

- 不改协议面（`/api/*`、`/SyncClipboard.json`、`/file/*`、`/SyncClipboardHub`）—— 客户端零感知；
- 不做编辑、转换、导出（库本身定位就是只读查看器：`file-viewer/README.md`「File Viewer is a viewer, not an editor」）；
- **不引入 CAD 运行时**（`@flyfish-dev/cad-viewer` / `dwf-viewer` 是 **AGPL-3.0-only**，理由见 §5 D-1）；
- 不改 V2（`public/ui_v2/`，开发测试版）：两版之间不引入跨目录依赖，V1 保持自包含。
- **不承担「兼容」负担**（用户 2026-09-21 指示：**本项目按开发版 / 单用户自部署对待**）：不为旧浏览器留降级路径、
  不做双跑或渐进迁移、不要求与 V2 对齐、不为"列表页保持旧行为"写兼容层、也不为日后"换回下载"预留开关。
  **但两类约束不因"开发版"免掉**：① 第三方**许可**（CAD 运行时的 AGPL）；② **安全**边界
  （放宽 CSP 仍须 §7 的授权，因为那不是兼容问题）。

## 2. 现状缺口（代码事实）

| 现状 | 事实 | 出处 |
|---|---|---|
| 预览只有三分支 | 文本（`<pre>` 全文）／位图（`<img>` 原图）／其余一律「该类型不支持在网页内预览，可下载后查看」 | `public/ui_v1/js/components/preview.js` |
| 服务端其实允许部分内联 | `image/*`（除 svg）、`text/plain`、`text/csv`、`text/markdown`、`application/json`、`application/pdf` 默认回 `inline`，其余强制 `attachment` + CSP 沙箱 | `src/contentTypes.ts` 的 `isInlineAllowed` / `fileHeaders` |
| 界面没接线 | 即便服务端允许，界面仍未给 PDF/JSON/CSV/MD 任何"打开"入口（只给下载） | 同上 + `preview.js` 的第三分支 |
| 音视频被 CSP 挡死 | `public/_headers` 是 `default-src 'none'`，没有 `media-src` ⇒ 浏览器不会播放 | `public/_headers` |

⇒ 剪贴板里最常见的 `docx / xlsx / pptx / pdf / zip / eml` 只能下载后到本机打开。

## 3. 事实（实测 2026-09-21，两仓本地）

### 3.1 库侧

| 项 | 事实 | 出处 |
|---|---|---|
| 定位 | 浏览器原生、离线优先的只读预览组件库，自带 renderer、无转换服务器（"Built-in renderers need no conversion server"） | `file-viewer/README.md` |
| 许可 | 自有源码 **Apache-2.0**；**CAD 运行时 AGPL-3.0-only**（"using or distributing CAD support requires complying with that license"） | `file-viewer/README.md` 末段、`LICENSE` |
| 源码形态 | pnpm workspace + `patchedDependencies`（`pdfjs-dist@5.4.624`、`illustrator-pgf@0.1.0` 要打补丁）⇒ **源码树不能零构建直接引用** | `file-viewer/pnpm-workspace.yaml` 末尾 |
| 运行期资产 | 必须把 **Worker / WASM / 字体 / vendor 资产**与页面一起提供（默认路径 `<base>/file-viewer/`）；缺 Worker/WASM 会让对应格式不可用 | `README.md`「Runtime assets」、`docs/guide/distribution.md` |
| 组装方式 | Vite 用 `@file-viewer/vite-plugin`（`copyAssets:true`）；其它构建器跑 `npx --no-install file-viewer-copy-assets ./public/file-viewer`；Full 包也可整目录直服 | 同上 |
| 隔离机制 | 默认 **Shadow DOM**（`styleIsolation: 'auto'`），靠 CSS 自定义属性与 Shadow Parts 定制 | `docs/guide/style-isolation.md` |
| 样式注入方式 | 组件用 `document.createElement('style')` + `textContent` 往 ShadowRoot 里注入（**这决定 CSP 必须放宽 `style-src`**） | `packages/components/vue3/src/package/components/FileViewer/ShadowFileViewer.vue:124,181` |
| 会话级 `blob:` 图片 | DOCX 等渲染用会话级 `blob:` 图片 URL，导出/打印时才内联成 `data:` | `docs/guide/usage.md:215,612`、`docs/zh/changelog.md:314` |
| 支持矩阵 | 四档支持级别 `high-fidelity / structured / basic / experimental`，`preset-*` 决定装配哪些管线 | `ecosystem/format-catalog.json` 头 |
| 体积阶梯（`npm view … dist.unpackedSize`） | `core` 1.23 MB｜`web` 0.86 MB/18 文件｜`preset-lite` 15 KB｜`renderer-media` 0.23 MB｜`renderer-archive` 0.11 MB｜`renderer-word` 0.11 MB｜`renderer-pptx` 49 KB｜`renderer-spreadsheet` 1.20 MB｜`renderer-pdf` **6.72 MB/235 文件**｜**`web-full`（preset-all）236 MB / 2961 文件** | 本地实测 |
| 预设组合 | `preset-lite`＝core+image+media+text；`preset-office`＝pdf+word+spreadsheet+presentation+ofd+hangul+iwork+wordperfect；`preset-standard`＝lite 的那几项 + archive/email/pdf/office 系 + 两个 capability | `packages/presets/{lite,office,standard}/package.json` |
| **资源载荷实测**（轮 4，`npm pack` 解包到临时目录） | `@file-viewer/assets-standard@3.1.2`＝**11.98 MB / 314 文件**：`viewer/vendor/pdf/` 9.19 MB/299（`pdf.worker.mjs` 2.04 MB、168 个 `.bcmap`、101 个 `.woff2` CJK 分片、4 个 `.ttf`、jbig2/openjpeg `.wasm`）、`libarchive.wasm` 0.96 MB、`xlsx/sheet.worker.js` 0.85 MB、`pptx/pptx.worker.js` 0.55 MB、`docx/docx.worker.js` 0.36 MB ⇒ **最大单文件 2.04 MB** | 本地解包（临时目录，未入库） |
| 资产分组只有 5 组 | `copyGroups = [archive, office-presentation, office-word-openxml, pdf, spreadsheet-openxml]` ⇒ text/image/media/email/ofd **零运行时资产**（载荷不随覆盖广度线性涨） | `viewer/flyfish-viewer-assets.json` |
| 载荷自带清单可直接当守卫源 | 清单含 `packageVersion: 3.1.2` / `profile: standard` / `copyGroups` / `profileManifestSha256` / 每个资产的 `defaultPath` + `required` + `kind`；另有 `flyfish-viewer-manifest.json`（145 B：`name`/`version`/`kind`） | 同上 |
| 载荷自带第三方许可 | `vendor/pdf/cmaps/LICENSE`、`fonts/OFL-1.1.txt`、`standard_fonts/LICENSE_{FOXIT,LIBERATION}`、`wasm/LICENSE_{JBIG2,OPENJPEG,PDFJS_*,QCMS}` ⇒ **不可裁剪** | 解包清单 |
| 壳包只有壳 | `@file-viewer/web@3.1.2`＝0.82 MB/18 文件（`dist/index.js` + iife/amd 各 0.34 MB）；**不含任何 renderer** ⇒ renderer/preset 必须由打包器装配 | `packages/components/web/package.json` + 解包 |
| 渲染器的重活不在 JS 包里 | `renderer-pdf` 6.40 MB 里 6.17 MB 是 `dist/vendor/pdfjs/**`（运行期按资源基址取），`dist/` 自己的 JS 仅 0.21 MB（230 个文件多为 `.d.ts`） | 解包清单 |
| 离线组装的两条正路 | ①（**推荐**）**Vite 一次性离线构建**：`@file-viewer/web` + `@file-viewer/preset-standard`（或显式 `formats`）+ `@file-viewer/vite-plugin` 的 `fileViewerRenderers({ copyAssets:true, chunkStrategy:'renderer' })` —— `new Worker(new URL('./x.worker.js', import.meta.url))` 只有 Vite 会重写成可部署资产；② `npm i -D file-viewer-copy-assets@3.1.2` 后 `npx --no-install file-viewer-copy-assets <dir> [--renderers <csv>]` 单独复制资源（该 CLI 自身 **189.39 MB / 2 926 文件**，含全部档位资产 ⇒ 只当工具，**不入库**） | `docs/guide/on-demand-renderers.md`、`packages/tools/copy-assets/src/cli.ts` |
| ⚠️ `web-full` = `preset-all` | `@file-viewer/web-full@3.1.2`＝**225.07 MB / 2 961 文件**，依赖里含 `@file-viewer/renderer-cad` → `@flyfish-dev/cad-viewer@0.8.2`（README 明示 DWG/DWF/DWFX 运行时 **AGPL-3.0-only**）⇒ 直接 vendor 它等于**分发 AGPL 运行时**，与 D-1 冲突；且装了它之后插件的 preset 自动发现会**静默升级成 all** | 解包 + `web-full/package.json` + `README.md` |
| 平台硬上限（官方） | 静态资源：**每版本 20 000 文件（Free）/100 000（Paid）**、**单文件 25 MiB**；Worker 脚本 64 MiB ⇒ 我们 ~450 文件 / ~15 MB 余量极大，但要写成守卫断言（G16） | docs/workers/platform/limits |

### 3.2 我们侧（约束）

| 约束 | 事实 | 出处 |
|---|---|---|
| V1 = 零构建自包含 | 纯原生 ES 模块 + CSS、无构建步骤；不允许跨目录依赖 `public/ui_v2/` | `docs/ui.md` §3.2、`public/ui_v1/README.md` |
| CSP 是全站**一条** `/*` 规则 | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss: ws:; …` —— **没有** `worker-src` / `media-src` / `blob:` / `'unsafe-inline'` | `public/_headers` |
| 同源加固史 | 附件与 API 同源的**存储型 XSS 链**修过：靠「默认-deny 内联白名单 + 强制 attachment + CSP 沙箱」；`src/contentTypes.ts` 头注释写明两者**不能分开做** | `src/contentTypes.ts`、`docs/ui.md` §7 |
| 资源数被守卫盯着 | `docs/ui.md` 的「共 N 个资源」（2026-09-21 起是 **84**，因 6 份重复图标/图标表并成了 4 份）；`test/docs.test.ts` 会与实际 `public/` 文件数比对 | `test/docs.test.ts` |
| 挂载点不变（利好） | 新资源都落在 `/ui_v1/...` ⇒ `wrangler.toml` 的 `run_worker_first` 与 `src/index.ts` 的 `isUiAsset` **不用改**（它们只认前缀） | `wrangler.toml`、`src/index.ts` |
| `_headers` 支持按路径写规则 | 已有按挂载点/按文件的 cache-control 规则 ⇒ 路径规则**能**写；但**按页放宽 CSP 做不到**（下一行的逗号合并）| `public/_headers` |
| 数据通路已有 | `GET /ui/api/history/:type/:hash/data` 同源、Cookie 鉴权、支持 `Range`（206/416） | `src/ui/routes.ts` |
| 若用 `fetch()` 取字节 | 服务端回 `attachment` **不影响** `fetch`（disposition 只影响浏览器直接导航）⇒ 不必动 `contentTypes.ts` 的加固 | `src/contentTypes.ts` + HTTP 语义 |
| `_headers` 同名头**逗号合并** | 官方原文：「If a header is applied twice in the `_headers` file, the values are joined with a comma separator.」⇒ 同一响应上出现两段 CSP ⇒ 浏览器按**交集**执行 ⇒ **"再写一条更宽的 CSP 规则"不可能放宽** | Workers 静态资源 `_headers` 文档 |
| **实测**（轮 4，`wrangler dev` 8787；临时规则已逐字节还原） | `/ui_v1/js/api.js` 命中两条规则时得到**一个头、两段策略**（`…img-src…, default-src 'none'; script-src 'self' TESTMARKER-A`）；在同一规则里用 `! Content-Security-Policy` 先取消再重设也**没生效**（manifest 那条同样两段）⇒ 两条路都走不通 | 本地实测 |
| Worker 生成的响应**不套** `_headers` | 官方原文：「Custom headers defined in the `_headers` file are not applied to responses generated by your Worker code」⇒ 预览页要放宽 CSP **只能由 Worker 出这个响应**（D-8） | 同上 |
| `_headers` 对"经 `ASSETS.fetch()` 代理的资源"**仍生效** | 实测 `/ui_v1/js/api.js` → `cache-control: public, no-cache, must-revalidate`（`/ui_shared/js/icons.js` 同）、`/ui_v1/manifest.webmanifest` → `max-age=3600`、`/ui_v1/` 与 `/ui_v2/app/` → 平台默认 `max-age=0, must-revalidate` ⇒ 现有缓存规则在 Worker-first 下照常生效 | 本地实测 |
| 仓库卫生：**没有 `.gitattributes`，且 `core.autocrlf=true`** | 入库的第三方文本（worker JS、manifest JSON）检出会变 CRLF ⇒ **任何逐条 sha256 守卫在 Windows 上都会假红**（实测运行时只读清单找 URL、不校验哈希，故风险限于我们自己的守卫） | `git config core.autocrlf` |

## 4. 术语（先收紧，否则每句话都会歧义）

| 术语 | 定义 | 与旧说法的关系 |
|---|---|---|
| **内联预览** | 我们自有、零依赖的两支：文本 `<pre>`、位图 `<img>` | 就是现在 `preview.js` 的前两支；以后**不再**用它泛指一切预览 |
| **文档预览** | 由第三方 renderer 渲染重格式（PDF/Office/压缩包/邮件/音视频/…） | 本次新增的那一档 |
| **只下载** | 既不内联也不文档预览，只给下载（现状第三支） | 保持为**兜底**，任何失败最终都退回这里 |
| **外壳** | 入口、对话框/页面框架、标题与元信息、动作条（复制/下载/删除）、主题令牌、无障碍与状态机（loading/empty/error/unsupported） | 归**我们**所有 |
| **渲染器矩阵** | 库的能力表（扩展名 → 管线 → 支持级别…），我们只把它当**能力查询**，不当流程分支 | `ecosystem/format-catalog.json` |
| **vendor 产物** | 预构建后入库的第三方文件（`public/ui_v1/vendor/file-viewer/<版本>/`），不可读、不可改、升级靠替换 | 与「我们自己的源码」相对 |
| **深度集成** | 本次把它钉死为 §5 的 **D-2 (B) 外壳集成**：我们拥有外壳与判据，渲染器只负责内容 | 取代此前含糊的"深度集成" |

## 5. 决策（全部已定；用户 2026-09-21 逐项确认）

### D-1 覆盖范围：文档类 + 媒体，**排除 CAD 与一切 specialist 渲染器**

覆盖：PDF、Office（docx/xls/ppt 系含旧二进制）、OpenDocument/RTF、文本/Markdown/代码、压缩包、邮件(eml/msg)、音视频、`html`（**沙箱渲染**，见 D-6）。
**但归谁实现按"谁能做"分**：**PDF 与常见音视频由浏览器自带能力承担**（`native-pdf`/`native-media`，见 D-4 与下段"装配档位"），第三方只负责 Office / 压缩包 / 邮件 / OFD。
**排除**：CAD（AGPL-3.0-only 会传染整个部署）、3D/EDA/DICOM/设计文件（体积主力，且与剪贴板场景无关）。
依据：`web-full` 实测 236 MB / 2961 文件；`preset-standard` 已覆盖目标集（含 OFD），而 `engineering`/specialist 不在其中。
状态：**已定（用户 2026-09-21 确认）**；理由措辞已按事实校准，见下。

**装配档位（轮 5 末用户裁定，2026-09-21）**：**`preset-standard` 减去 `renderer-pdf`** —— **PDF 不交给库**，改用**浏览器自带的阅读器**（D-4 的 `native-pdf` 路由）。
实测（§3.1 / §11.3）：`vendor/pdf/` 独占 `assets-standard` 的 **9.19 MB / 299 文件（约 77%）**，去掉后载荷只剩 **2.78 MB / 15 文件**
（`libarchive.wasm` 1.01 MB / `xlsx` worker 0.85 / `pptx` worker 0.55 / `docx` worker 0.36）。
留给库的覆盖：**docx·doc·rtf·odt / xlsx·xls·csv·ods / pptx / zip·rar·7z·tar / eml·msg·mbox / ofd**（`text`/`image`/`media` 渲染器可否选装见 G21）；
**PDF 与常见音视频走原生**（D-4）。理由：PDF 是浏览器自带阅读器做得最好的格式（Range 流式、搜索、打印、缩放，且跑在浏览器自己的沙箱里），
而 pdfjs 恰是我们载荷里最重的一块 —— 那 9 MB 是白买。
配套铁律：组装时**只装 `@file-viewer/web` + 所需 renderer（显式 `formats` 列表，不含 pdf）**，**绝不**安装任何 `*-full`/`preset-all`（G14）；
**产物里若出现 `vendor/pdf/**` 或 pdfjs 资产，守卫必须红**（G10/G24）。**反方与精确表述**：CAD 运行时（`@flyfish-dev/cad-viewer` / `dwf-viewer`）
是 **AGPL-3.0-only**，而它是**独立分发的 npm 包**、由页面单独加载 ⇒ 与我们的代码属**聚合**关系，
按主流解读**不**要求把 `src/**` 与 `public/ui_v1/**` 改成 AGPL；真实约束是 AGPL 的**网络条款**
（通过网络与之交互的用户须能取得该组件源码 —— 它本身开源，给链接即可）**加上许可解读的不确定性**，
再叠加它是体积最大的一档、与剪贴板场景关系最弱。⇒ 结论仍是"本次不做 CAD"，但它是**你的取舍**，不是法律强制。

### D-2 「深度集成」＝ 外壳集成（B 档）

我们拥有：入口判据、页面/对话框外壳、主题（沿用 `tokens.css` 的变量，通过 CSS 自定义属性注入）、文案（沿 `js/messages.js` 的单点约定）、动作条、无障碍、状态机。
第三方拥有：内容渲染区。两者之间只有一个**受控接口**：`url`（或 `File`）+ `filename` + `theme` + `styleIsolation` + 容器高度 + 事件回调（加载完成/失败/不支持）。
**否决 A 档（原样嵌入）**：会把第二套设计系统、工具栏、文案并进 V1 的产品面；**否决 C 档（源码级 fork）**：它是 32 条管线的 pnpm workspace 且两个包带 patch，fork 的维护成本与升级风险不可接受（也正是 D-3 选择 vendor 的原因）。
状态：**已定（用户 2026-09-21 确认）**。

### D-3 产物交付：**预构建 vendor 入库**（不改零构建定位）

`public/ui_v1/vendor/file-viewer-<版本>/file-viewer/…`（具体布局与资源基址见 G19），附 `LICENSE`、来源 URL、版本号、**文件清单（路径 + sha256 + 字节数）**。
新增守卫（进 `test/ui-guard.test.ts`）：① vendor 目录的文件集合与清单**逐条一致**（多一个少一个都红）；② V1 不出现 `/ui_v2/` 引用（既有判据的延伸）；③ 记录总体积上限（超限红，防止下次换 preset 时悄悄涨到几十 MB）。
**否决 CI 构建**：会把本地开发、DoD 五条、CI 两个 job、`.gitignore` 与文档里"零构建"的定位一起改，且每次部署要多拉一个 workspace 的依赖树。
反面必须记住：**vendored 产物不可读、不可改、不可 patch**（所以 D-2 只能选"包壳"）；每次部署要多上传 MB 级静态资产。
状态：**已定（用户 2026-09-21 确认）**：交付＝**预构建 vendor 入库 + 精简守卫**（先只记"版本 + 总体积"，逐条 sha256 清单留到稳定后再升，见 §9 G10）。体积数值由阶段 0 实测回填本文 §3/§10。

### D-4 判据权威源：**前端唯一判据**（服务端 disposition 与矩阵都不作流程分支）

新增一个纯函数（拟名 `viewerRoute(item)`），**五档**：
`'inline'`（文本 / 位图 → 现有对话框）｜`'native-pdf'`（**浏览器自带阅读器**：弹窗里的 `<iframe src=<数据端点>>`）｜
`'native-media'`（**浏览器自带播放器**：弹窗里的 `<audio>/<video>`）｜`'document'`（扩展名在**装配清单**里 → 交给库）｜`'download'`（其余）。
- **PDF 为什么归原生不归库**（轮 5 末用户裁定）：pdfjs 载荷占 77%（§11.3），而内置阅读器在同源 iframe 里就能用 ——
  数据端点本来就回 `content-type: application/pdf` + `content-disposition: inline` + `accept-ranges`（§11.2），体验还更好（搜索/打印/缩放/流式）。
  ⇒ 库的覆盖收敛到"浏览器**确实做不到**"的那几类（Office / 压缩包 / 邮件 / OFD）。
- **常见音视频也归原生**：mp4/webm/mp3/wav/ogg/flac/m4a 直接 `<video>/<audio>`；浏览器不认的容器（mkv/avi/mov/HLS/MIDI）才回落到库的 media 渲染器（若装了它）。
- 库的矩阵只用于**能力查询**（是否显示"打开"按钮、提示文案里写"需要额外组件"还是"不支持"）；
- 服务端 `contentTypes.ts` 的内联白名单**保持不动** —— 它管的是"浏览器直接导航时的 disposition"；而 **`attachment` 不影响子资源加载**，
  所以 `<iframe>`/`<video>` 指向同一个数据端点照常工作（§11.2 实测结论）。**不要**为了预览去放宽那张白名单。
- 装配清单（我们实际 vendor 了哪些管线）是**唯一**决定 `document` 的依据 —— 避免"按钮能点、点开却缺渲染器"。
状态：**已定（2026-09-21；轮 5 末按用户裁定把 pdf 从库里移出、并把常见媒体一并归原生）**。

### D-5 入口形态：**统一走现有对话框**（轮 5 末用户裁定：**不新增页面**）

文本 / 位图 / **PDF** / **音视频** / **Office·压缩包·邮件·OFD** 全部在**列表页现有的那个 `<dialog>` 弹窗**
（`public/ui_v1/js/components/preview.js`）里预览 —— 由 D-4 的五档决定弹窗里塞什么：`<pre>` / `<img>` / `<iframe>` / `<audio>·<video>` / 挂载库。

收益：① 不新增页面 ⇒ 无 `view.html`、无资源数里的新页面行、`DEEP_LINK` 语义**完全不变**（`#<Type>-<hash>` 仍只是"打开这个弹窗"）；
② 首屏仍零第三方字节（见下）；③ CSP 放宽的落点只有**列表页那一张 HTML**（D-8），V2 / 登录页 / 跳转壳 / 站点根保持零放宽。

代价（如实记）：① **失败隔离弱了** —— 库崩在列表页的弹窗里，影响面比独立页大（缓解：`try/catch` + 失败落回"只下载"卡片 + 关闭即销毁，见 G25）；
② **长驻页面要管生命周期** —— 弹窗是启动期创建、常驻 `body` 的节点 ⇒ 每次预览都要 `mountViewer` → `destroy()`（释放 worker / canvas / `blob:` URL），否则累积；
③ **挂载时机有坑** —— 容器在弹窗打开前/过渡中尺寸为 0，此时初始化会白屏 ⇒ 必须"`showModal()` 且布局就绪后再挂载"（G25）。

**首屏零第三方字节的落地方式**：vendor 只能**动态 `import()`**（不进 `index.html` 的 `modulepreload`、不被静态 import）。
守卫现状（已核）：`test/ui-guard.test.ts` 的闭包判据用 `/import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g` ⇒ **`import(` 形态不匹配**
⇒ 动态导入不会被要求进预载清单；`V1 不依赖 V2` 那条判据只扫 `public/ui_v1/js/`，vendor 在 `vendor/` 下也不进闭包。

状态：**已定（用户 2026-09-21 轮 5 末：不要新页面，就像现在的弹窗预览）**。

### D-6 降级、验证与登记

**降级三层**（永不空白）：
1. 扩展名不在装配清单 → 卡片："该格式需要额外组件" + 下载按钮（沿用现有"只下载"外观）；
2. 资产缺失（Worker/WASM 404）或渲染器启动失败 → 明示"渲染资源未部署/加载失败" + 下载；
3. 弹窗里的预览脚本自身加载失败 → 退化成同一张"只下载"卡片（列表页必须能在**零第三方资产**下可用）。

**验证**：新写一个探针（不改现有 `test/manual/probe-ui-v1.mjs`，其读数已稳定）；三条判据：**CSP 违例计数为 0**（监听 `securitypolicyviolation`）、首屏字节预算、**至少一种真实格式渲染成功**（pdf 或 docx 之一，用仓库内固定夹具）。

**登记**：`design.md` D21（ADR 摘要，已加）+ `ui.md` 新增一节「文档预览」+ `progress.md` 每轮一节 + `README.md` 致谢段加 File Viewer（**在真正 vendor 落地那一轮**）。

状态：**已定（用户 2026-09-21 确认）**。

### D-7 实施许可与并行（用户 2026-09-21 确认）

阶段 0 的实测走**临时目录**：**不动 `file-viewer` 工作区、不写进本仓库**，产出「真实体积 + CSP 违例清单」回填 §3/§10。
**阶段 1（`viewerRoute()` 判据）与它并行开工**（纯代码、零依赖，不被实测阻塞）。
⚠️ 轮 4 修正：原文写的 `npm pack @file-viewer/web-full` **是错的对象**（`web-full` = `preset-all`，会把 AGPL 的 CAD 运行时一起量进来，
见 §3.1 与 D-1）；阶段 0 改为**离线构建标准档**（Vite 一次构建，产物含 JS 与资源），见 §6 阶段 0 与 G14。

### D-8 CSP 放宽的**出口**：**列表页的响应由 Worker 出**（轮 5 用户最终裁定：A 档 —— 只放宽承载预览的那一张 HTML）

背景（轮 4 实测，§3.2）：同名头在 `_headers` 里**逗号合并** ⇒ 两条策略 = 交集 ⇒ 想"在 `_headers` 里只放宽某一页"**做不成**。
轮 5 用户先在 A（只放宽承载预览的那一页，需让它的响应绕过 `_headers`）与 B（放宽写进 `/*`、全站生效）之间选了 B，
看完大白话解释与代价对比后**改选 A**（更窄的策略优先）；轮 5 末又裁定**不新增预览页** ⇒ 承载预览的那一页就是**列表页**。
记录保留：B 被否的理由是"能一处生效但要牺牲全站策略"。

做法：在 `src/index.ts` 的静态分支里给**列表页那一张 HTML**（`/ui_v1/` 与 `/ui_v1/index.html`）单开一条 —— 照旧 `env.ASSETS.fetch(request)` 取 body，
但**丢弃它的响应头**，由 Worker 自己写全套（严格项原样 + CSP 换成放宽版）。

**必须一起做的三件事**（漏一条就是静默退化 —— 这是 A 档的全部成本，也是它的正确性风险）：

1. 其余安全头（`nosniff` / `Referrer-Policy` / `X-Frame-Options` / `frame-ancestors 'none'` / `COOP` / `CORP` / `Permissions-Policy`）**逐条自己补**；
2. 该页的 `Cache-Control` 由 Worker 给（与其它 HTML 一致：`public, max-age=0, must-revalidate`）；
3. `public/_headers` 的 `/*` 规则**保持零放宽**，并加守卫断言（不含 `unsafe-inline` / `wasm-unsafe-eval` / `blob:` / `worker-src`）。

配套守卫/探针（G13/G26）：`/*` 零放宽；**放宽只出现在列表页这一条路径上**（`login.html`、V2、跳转壳、站点根必须仍是 `default-src 'none'` 那套）；
列表页的放宽项**恰好**是 §7 那几条，其余安全头与登录页逐条相同。

状态：**已定（用户 2026-09-21 轮 5 末：A 档 + 列表页承载）**。这条是轮 4 前已授权那一档（只放宽承载预览的页面），**不构成新的降安全动作**。
**必须如实记住**：放宽后的策略落在**列表页**上，而列表页正是持会话 Cookie、能打 `/ui/api/*` 的那一页 ⇒ 第三方解析器与"能读/清空剪贴板历史"的权限同处一页（§11 的风险陈述即由此而来）。

### D-9 取字节：**统一 `fetch()` → `File`**（PDF 流式例外待评估）

库文档给了鉴权场景的正式路径：宿主先 `fetch(url, { credentials:'include' })` → `new File([blob], name, { type })` → 交给 `file`。
收益：① 失败**可分类**（404 `data_missing` / 401 / 网络错）⇒ 直接喂 D-6 的状态机与 G20；② MIME 由我们按 `dataName` 定；
③ 预览与"下载"共用同一份字节。**代价在轮 5 末基本消失**：原先的顾虑是"`pdf.streaming` 只在 `url` 模式生效 ⇒ 放弃 PDF 的 Range 流式"，
但 PDF 已改由**原生 iframe** 承担（D-4）—— 它走 URL，206 照旧用得上；而库里剩下的 Office/压缩包/邮件本来就是**整包解析**，
全量 `File` 没有额外损失。⇒ 统一 `File` 现在**没有已知代价**，只是库那几档拿不到"边下边看"。
状态：**已定（用户 2026-09-21 轮 5 确认：统一 `fetch` → `File`）**。

### D-10 库自身外壳的收敛（让"外壳归我们"落地）

实测选项：`toolbar: { download, print, exportHtml, zoom, search, theme, position, items, permissions }`（`false` 可全关）、
`i18n: { locale, messages }`。**推荐**：`toolbar: { download:false, print:false, exportHtml:false }` + `permissions` 同步关
（挡住 API 级调用），**保留 `zoom` / `search`** —— 全关（`toolbar:false`）会把缩放与翻页一起去掉，PDF 退化成"只能看第一屏"；
`i18n.messages` 覆盖库的文案，**尤其是**"缺渲染器→请安装 preset"那条引导（否则我们页面上会出现
`npm install @file-viewer/preset-office` 这种对用户无意义的话，见 G18）。
状态：**已定（用户 2026-09-21 轮 5 确认：关 `download`/`print`/`exportHtml`，留 `zoom`/`search`，`permissions` 同步关）**。

## 6. 实施计划（每阶段带验收）

| 阶段 | 动作 | 验收（可复算） | 前置 |
|---|---|---|---|
| 0 | **离线构建"去掉 pdf"的装配并实测**：临时目录装 `@file-viewer/web@3.1.2` + 所需 renderer（`word`/`spreadsheet`/`pptx`/`archive`/`email`/`ofd`，**不含 `renderer-pdf`**）+ `@file-viewer/vite-plugin@3.1.2` + `vite`，用 `fileViewerRenderers({ copyAssets:true, chunkStrategy:'renderer', formats:[…不含 pdf…] })` 构建；记录 **JS 体积与文件清单 + 资源体积（预期 ≈ 2.78 MB / 15 文件，见 §3.1/§11.3）+ 最大单文件 + 受控页 CSP 违例清单** | 产出：体积表（回填 §3）+ 违例清单（记入 §10）+ **可复现的构建配方**（G14）；**产物里出现 `vendor/pdf/**`/pdfjs/CAD 即算失败** | 已许可（D-7 同一授权：只写临时目录，不动 `file-viewer` 工作区、不写本仓库）。资源侧数字轮 4 已量、去掉 pdf 后的数字本行已给出预期值 |
| 1 | 前端判据：`viewerRoute()` 纯函数 + 装配清单常量 | 单测/探针可断言三种路由 | 无 |
| 2 | vendor 入库（`public/ui_v1/vendor/file-viewer-<版本>/file-viewer/…`，见 G19）+ 守卫（D-3 / G10 / G14–G16 / G22 / G24） | `test/ui-guard.test.ts` 全绿；资源数同步（§8）；守卫断言：版本==目录名、`copyGroups` 与记录一致（**不含 `pdf`**）、文件数与总字节==常量（≈2.78 MB/15）、`required` 资产的 `defaultPath` 都在、**不含 `vendor/pdf/**`/pdfjs、不含 CAD/3D/Typst 资产、不含任何 `@flyfish-dev/*`** | 阶段 0 |
| 3 | **列表页 HTML 的响应由 Worker 出**（D-8：A 档）+ 资源**预检清单**（G23，在弹窗里做） | 探针：列表页 `securitypolicyviolation` 计数为 0；放宽项**恰好**是 G17 那几条；**登录页/V2/跳转壳/站点根仍零放宽**；`public/_headers` 的 `/*` 零放宽 | 已授权（轮 5：A 档＝只放宽承载预览的那张 HTML） |
| 4 | **弹窗内三档内容**（`<iframe>` PDF / `<audio>·<video>` 媒体 / 动态 `import()` 后 `mountViewer` 到弹窗）+ 外壳（标题/元信息/动作条/主题/无障碍/状态机）+ 销毁与失败落回（G25） | 真实浏览器走查（DoD 第 5 条）：零 console 错误、零失败请求；**首屏请求里没有 vendor 任何字节**（探针的 FAILED REQUESTS/请求清单） | 阶段 1–3 |
| 5 | 新探针（CSP 违例 / 首屏字节 / **弹窗内真渲染**：PDF iframe 有内容、媒体 `readyState>0`、Office 渲染出画布）+ 关闭后**销毁干净**（worker 数回落） | 探针输出归档 | 阶段 4 |
| 6 | 文档同步（§8 清单） | `npm run check` + `node node_modules/vitest/vitest.mjs run test/docs.test.ts` 等 | 全部 |

## 7. CSP 放宽（**已授权** 2026-09-21：选 (a) —— 只放宽承载预览的那张 HTML，即**列表页**）

要让库与**原生 PDF/媒体**在列表页的弹窗里跑起来，**列表页**的 CSP 至少要在下列几项上放宽（`login.html` / V2 / 跳转壳 / 站点根保持现状）：

| 放宽项 | 为什么需要 | 依据等级 |
|---|---|---|
| `style-src 'unsafe-inline'` | ShadowRoot 内用 `createElement('style')` 注入样式 | 源码（vue3 包装；`web` 包待阶段 0 复核） |
| `script-src 'wasm-unsafe-eval'` | PDF/Archive 等管线的 WASM 实例化 | 文档（copy-assets 清单含 WASM） |
| `worker-src 'self' blob:` | 同源 module Worker（`media/mp4v.worker.js`、xlsx/pptx/docx 等）**外加 `blob:` Worker**：archive 把 libarchive worker 源码打成 blob 再 `new Worker(blobUrl)`（`archive.ts:362-366,863`）、XML 引擎同样（`xmlEngines.ts:132`） | **源码实测**（轮 4；比原计划的"仅 `'self'`"更宽） |
| `img-src 'self' data: blob:` | DOCX/XLSX 等用会话级 `blob:` 图片 | 源码实测（`spreadsheet/imageSource.ts:134`、`email/emailHtml.ts:16`） |
| `media-src 'self' blob:` | ① **原生播放**：弹窗里的 `<audio>/<video>` 指向数据端点（`'self'`；`attachment` 不影响子资源加载）—— 主要用途；② 库的 media 渲染器用 `URL.createObjectURL(blob)` 作 `src`（`media/audio.ts:123`、`media/video.ts:100`）⇒ 若**不装** media 渲染器（见 G21），这一项可收紧成 `media-src 'self'` | **源码实测**（轮 4）+ 轮 5 末的原生路由 |
| **`frame-src 'self'`** | ① **我们自己的 PDF iframe**（`native-pdf` 路由：`<iframe src=<数据端点>>`，由浏览器自带的阅读器渲染 —— 这是主要用途）；② 邮件正文与 HTML/XML 预览的 `sandbox=''` + `srcdoc` iframe（`email/email.ts:498-502`、`text/html.ts:103`、`text/xml.ts:149`）。**注意**：① 是标准同源 iframe（确定可行）；② 的 `about:srcdoc` 在 `default-src 'none'` 下的放行条件**依浏览器实现而变**，阶段 3 探针必须用 `securitypolicyviolation` 实测确认（PDF/Word 不依赖它） | 源码实测 + 待测（轮 4 补的漏项） |
| （保持）`object-src 'none'` | 即 `<embed>/<object>` 一律不可用；PDF 走 canvas ⇒ 不受影响。阶段 3 要确认没有格式依赖 `<embed>` | 现状 + 待测 |

**后果一行**：这等于**在同一来源下执行第三方解析器去处理不可信文件**，而该来源持有会话 Cookie 与 `/ui/api/*`；一旦解析器被攻破，攻击面从"下载后在本机打开"变成"在已登录界面内执行"。

**若你不接受**：正确的替代是 §5 之外的 **(c) 独立来源隔离** —— 预览器挂到**另一个 hostname**（Cloudflare 自定义域），用 `frame-src` 嵌入，把执行面与持 Cookie 的同源切开。成本：第二个 Worker/域名 + 第二套资产 + iframe 通信协议。注意库自身**不推荐** iframe 路径（`docs/guide/style-isolation.md`：iframe「让文件传递、打印、搜索、尺寸、事件桥、离线资产部署复杂得多」）。

（上面两段是**当时的**选项与后果说明，保留作为决策依据；**结论见下**。）

**授权记录（2026-09-21）**：轮 4 前用户选 (a)「放宽，但**只放宽预览页**」；轮 5 一度改判为「写进 `/*`、全站生效」，
看完代价对比后**最终改回 (a)**（见 **D-8**）。⇒ 落地方式是 **A 档**：**列表页那张 HTML**的响应由 **Worker** 出（其余安全头自己补），
`_headers` 的 `/*` 保持最严。~~`_headers` 里新增一条只在 `/ui_v1/view.html` 上生效的策略~~ 这条路已被轮 4 实测否掉（逗号合并 ⇒ 交集）。
备选 (b) 独立 hostname 隔离与 (c) 不做都不再考虑。

**实现要点（两条容易搞反的）**：

- ~~**CSP 是文档级策略**：只需在**承载预览那一页的响应**上放宽~~ —— 方向对，**但"在 `_headers` 里另写一条按页规则"这条路走不通**：
  官方文档写明同名字段**逗号合并**（两条策略 = 交集 ⇒ 放宽无效），轮 4 实测确认，且同规则内 `!` 取消再重设也不生效（§3.2）。
  ⇒ 按 **D-8** 改由 **Worker 出这个响应**（官方文档：Worker 生成的响应不套 `_headers`）。
  `public/ui_v1/vendor/**` 下的 JS/WASM/Worker 响应**不需要**（也无法靠）CSP 放宽 —— 它们照旧只带 `nosniff` 等。
- **vendor 目录反而应当长缓存**：路径里带库版本（`/ui_v1/vendor/file-viewer/<版本>/…`）⇒ 在 `_headers` 给
  `/ui_v1/vendor/*` 写 `Cache-Control: public, max-age=31536000, immutable`；这与"我们自己的 js/css 必须
  `no-cache`（无内容指纹）"不冲突，两套规则各按各的判据。

## 8. 同步清单（落地时必须一起改的位置）

| 改动 | 必须同步 |
|---|---|
| `public/` 增删文件（含 vendor、新页面） | `docs/ui.md` §3 的「共 N 个资源」总数与 V1/V2/跳转壳/站点根分表；`docs/design.md` §4 目录树；`docs/ui-v2-design.md` §7；`README.md` 的 `public/` 行 —— 且 `test/docs.test.ts` 会红直到改对 |
| `public/ui_v1/index.html` 的 `modulepreload` 清单 | 只列入口之外的**新增自有模块**；vendor 资产**不进**预载清单（按需 `import()`） |
| 新页面/新挂载点 | **本次不新增页面**（D-5：统一走现有弹窗）⇒ 挂载点集合与页面清单都不动；变的只是 `public/ui_v1/vendor/**` 下的**第三方文件数**（要计入 `docs/ui.md` §3 的「共 N 个资源」与分表）。若将来确实新增**目录**（例如 `/ui_viewer/`）⇒ `wrangler.toml` 的 `run_worker_first` + `src/index.ts` 的 `isUiAsset` + `public/_headers` 三处**一起改**，否则 `test/ui-guard.test.ts` 红（先例：`ui_shared` 就是这么落的，见 `docs/ui.md` §3.4） |
| CSP（**承载预览那张 HTML 的那一条由 Worker 施加**，见 D-8/G13/G26） | `docs/ui.md` §7 的安全头章节 + 本文 §7 的实测记录；`test/ui-guard.test.ts` 的头部规则判据（新增"`/*` 规则零放宽"断言）；`src/index.ts` 里那条 Worker 分支要带注释说明**为什么不能写进 `_headers`**（否则下一个人会"顺手"挪回去） |
| CI 冒烟 | **不需要改**（轮 5 末：无新页面 ⇒ 列表页本来就在断言里；G11 作废） |
| 新增第三方依赖/致谢 | `README.md` 致谢段；本文 §3.1 的版本与体积表 |

## 9. 落地细节清单（实现时逐条处理；G3 已定：`messages.js` 搬进共用层，见该行）

| # | 事项 | 处置 / 状态 |
|---|---|---|
| G1 | 鉴权与未登录 | **不需要新逻辑**：弹窗开在**已登录的列表页**上（未登录进不来），数据请求一律走 `api.js`（401 → `redirectToLogin`）。原来那句"`next=` 指回预览页"随独立页一起作废 |
| G2 | 挂载点字面量 | 新页面的 JS **不得**出现 `/ui_v1` 字面量：一律用 `api.js` 导出的 `PAGE_BASE` / `API_BASE`（`test/ui-guard.test.ts` 的「挂载点字面量只有一处」会红） |
| G3 | **新文案放哪（轮 5 用户已定）** | 用户裁定：**把 `messages.js` 搬进 `public/ui_shared/`（只此一份）**，预览相关的自有文案也**补在同一份**里。
**落地机制（轮 5 用户定：工厂注入，两版 `format.js` 一字不动）**：共用层 `ui_shared/js/messages.js` 导出
`createMessages({ typeLabel, truncateText })`（只此一份文案；预览相关文案也补在这份里），两版各留一个**瘦 shim** `js/messages.js`：
`import { typeLabel, truncateText } from './format.js'` + `export const { … } = createMessages({ typeLabel, truncateText })`
⇒ 5 个导出名不变、**20 余处调用点零改动**、两版 `format.js` 不动（对比"提共有函数到共用层"的方案，少改两个文件、多一层间接）。
用户同时指示「现在是**开发版**」⇒ 不为兼容留双路：V1 那份"为什么自己有一份"的旧文件头注释**直接删掉**（前提已不存在），不做再导出兼容层。
连带改：对等守卫换成「两版都不再有自己的正文，只有瘦 shim；共用层是唯一文案源」，以及 `AGENTS.md` §1/§3、
`docs/ui.md` §3/§3.4、目录树三处、资源数（−2 +2 ⇒ 仍是 **84**）；`eslint` 已覆盖 `ui_shared/js`（无需再改覆盖面） |
| G4 | CSP 与缓存 | 见 §7 + **D-8（A 档）**：只有**列表页那张 HTML**放宽，且**由 Worker 出它的响应**（`_headers` 的 `/*` 保持零放宽）；vendor 目录走长缓存（`immutable`，前提是升级换目录名，见 G14） |
| G5 | 深链接语义 | **不变**：`#<Type>-<hash>` 仍然只是"打开这个弹窗"（`main.js` 的 `DEEP_LINK` 已如此），`preview.js` 的 `onClose` 清 hash 逻辑原样保留 —— 原来"`document` 跳独立页"那条随 D-5 作废 |
| G6 | 弹窗动作集 | 仍只给「复制」（文本/图片）与「下载」；**不做**删除/收藏/置顶 ⇒ 弹窗里**不出现任何写操作**（这也是 §7 授权的对价）。库自带的下载/打印/导出按 D-10 关掉，保证"下载"只有一个出口 |
| G7 | 主题与首帧 | 复用 `js/theme-init.js`（首帧前定主题）+ `css/tokens.css`；把 `data-theme` 映射到库的 `theme: 'light' \| 'dark'` |
| G8 | 状态机与播报 | 四态：`loading` / `ready` / `unsupported`（不在装配清单）/ `failed`（缺资产或渲染失败）；后两态都给下载按钮 + `role="status"` 播报状态词 |
| G9 | 失败可观测 | console 前缀 `[viewer]`；探针据此断言"零 console 错误"（DoD 第 5 条） |
| G10 | 守卫强度 | **升级**（轮 4）：不必等 sha256 —— 载荷自带清单就够强：`packageVersion` == 目录名、`copyGroups` 与记录一致、`profileManifestSha256` 不变、每个 `required` 的 `defaultPath` 都在、文件数与总字节 == 常量（G16）、且**不含** CAD/3D/Typst 资产与任何 `@flyfish-dev/*` |
| G11 | ~~CI 冒烟加 `/ui_v1/view.html`~~ | **作废**（轮 5 末：不新增页面 ⇒ 列表页本来就在冒烟断言里，无需新增）。若将来仍新增页面，按 §8「新页面/新挂载点」那行处理 |
| G12 | 「不做 CAD」的落点 | `design.md` D21 + 本文 D-1 + `README.md` 致谢段只列**实际使用**的包；**外加守卫断言**：vendor 树里不得出现 CAD/3D/Typst 资产或 `@flyfish-dev/*`（轮 4 补，见 G10） |
| G13 | **承载预览那张 HTML 的响应由 Worker 出**（D-8 A 档） | 在 `src/index.ts` 的静态分支里给 `/ui_v1/` 与 `/ui_v1/index.html` 单开一条：取 `ASSETS.fetch` 的 body、**自写全套响应头**（严格项逐条补齐 + 放宽版 CSP + `no-cache` HTML 缓存），并在注释里写明**为什么不能写进 `_headers`**（逗号合并 ⇒ 交集，附 §3.2 的实测）；守卫断言 `/*` 规则**零放宽**；探针断言该页放宽项恰好是 G17 那几条、其余安全头与列表页逐条相同 |
| G14 | **构建配方入库 + 禁止 `-full`** | vendor 目录内 `BUILD.md`（或 `docs/` 一节）记：scratch 的 `package.json`（版本全部钉死）、`vite.config.mjs`、命令、产物校验方式；**禁止**安装任何 `@file-viewer/*-full` 或 `@file-viewer/preset-all`（否则 AGPL CAD 运行时随包进仓，且插件的 preset 自动发现会静默升到 all）。升级＝换目录名 + 重跑配方，**旧目录同笔删除**（与 `immutable` 缓存配套） |
| G15 | **`.gitattributes`** | 本仓库第一条：`public/ui_v1/vendor/** -text`（理由：`core.autocrlf=true` 会把第三方文本检出成 CRLF，让任何哈希/清单守卫在 Windows 上假红，见 §3.2） |
| G16 | **平台上限断言** | 守卫里写死：vendor 文件数 ≤ 20 000、单文件 ≤ 25 MiB（官方上限）、总字节 == 常量（超限红）—— 防"下次换档位悄悄涨到几十 MB" |
| G17 | **CSP 放宽项按实测补全** | 见 §7 表：`style-src 'unsafe-inline'`、`script-src 'wasm-unsafe-eval'`（libarchive 等 wasm 仍需要）、`worker-src 'self' blob:`、`img-src 'self' data: blob:`、`media-src 'self' blob:`、**`frame-src 'self'`**（**原生 PDF 与邮件/HTML 预览都要**）；`object-src 'none'` 保持。**不装 pdf 渲染器不改这张表**（pdfjs 从不要求额外项） |
| G18 | **库文案与 locale** | `i18n: { locale, messages }` 覆盖库文案，**必须**覆盖"缺渲染器→请安装 preset"的引导（那条对我们的用户无意义）；我们自己的文案仍进两版 `messages.js`（G3 不变） |
| G19 | **资源布局与基址** | `public/ui_v1/vendor/file-viewer-<版本>/file-viewer/{flyfish-viewer-assets.json, vendor/**}`（资源子目录**必须**叫 `file-viewer`：`copiedAssets.ts` 先试 `<base>/file-viewer/` 再回退 `<base>/`）+ 启动时 `setDefaultFileViewerAssetBaseUrl('/ui_v1/vendor/file-viewer-<版本>/')`。JS 入口另放同名目录下（`…/viewer.js`） |
| G20 | **取字节与失败分类**（D-9） | 统一 `fetch` → `File`；把 404（`data_missing`）/401/网络错分别映到 `unsupported`/`failed` 两态；下载按钮复用同一份字节 |
| G21 | **装配清单与选装决定** | ① `viewerRoute()` 的后缀常量从 `ecosystem/format-catalog.json` 抄（注明抄自哪一版），**分三张表**：`native-pdf`（pdf/svg? 不：**pdf**）、`native-media`（mp4/webm/mp3/wav/ogg/flac/m4a）、`document`（docx/doc/rtf/odt/xlsx/xls/csv/ods/pptx/zip/rar/7z/tar/eml/msg/mbox/ofd），并留哨兵断言防"按钮能点、点开却缺渲染器"；② **选装决定**：`renderer-text`/`renderer-image`/`renderer-media` 三个零资产渲染器的取舍 —— 文本/图片已有第一方等价物，媒体常见容器已归原生 ⇒ 默认**不装这三个**（库里留下的只有"浏览器确实做不到"的 Office/压缩包/邮件/OFD）；若要 MD 高亮或 HEIC，再单独加 |
| G22 | **第三方声明** | 去掉 pdf 后，随载荷走的 pdfjs/字体许可（`cmaps/LICENSE`、`fonts/OFL-1.1.txt`、`standard_fonts/LICENSE_*`、`wasm/LICENSE_*`）**一并消失**；仍需保留的是 **libarchive / xlsx / pptx / docx** 各自包里的 LICENSE 与 `@file-viewer/*` 本体的 **Apache-2.0** ⇒ 仓库加一节第三方声明（列出实际 vendor 的包与版本）+ `README.md` 致谢；**不要**为已移除的包写许可 |
| G23 | **资源预检清单**（把 D-6 第 2 层前移；**在弹窗里做**） | 第一次需要 `document` 档时，先取 `<base>/file-viewer/flyfish-viewer-assets.json`：缺失/不完整 ⇒ 弹窗里直接显示"渲染资源未部署"+下载，**不挂载库**（比等库报错更早、更可测）。**注意**：PDF/媒体走原生，永不依赖这份清单 ⇒ 清单缺失时这两档照常工作（探针分别验） |
| G24 | **原生 PDF / 媒体的实现与验证**（容器＝弹窗） | 弹窗正文里：PDF → `<iframe src="{api.dataUrl(item)}">`（同一 `dataUrl`；**不要**加 `download=1`）；媒体 → `<audio controls>/<video controls>`。探针必须验**真渲染**而非白屏：PDF 读 iframe 的 `contentDocument`/尺寸或截图；媒体读 `readyState > 0` 且 `duration > 0`。失败态（404 数据缺失 / 401 未登录）落回"下载"卡片。守卫加一条：**产物里不得出现 pdfjs** |
| G25 | **弹窗内的挂载/销毁契约**（D-5 的落地细节，也是最容易出错的一处） | ① vendor **动态 `import()`**（不进 `modulepreload`、不被静态 import ⇒ 首屏零字节）；② 挂载容器给**稳定高度**（库要求"viewer fills that surface"）；③ **`showModal()` 且布局就绪后再挂载**（容器尺寸为 0 时初始化 = 白屏；顺序或下一帧，探针要能读到大尺寸）；④ `close` 时**随现有的 `discardBody()` 一并 `controller.destroy()`** —— 注意**不能**在 `close` 里立刻销毁：`.dialog` 有退出过渡（`motion.css` 的 `allow-discrete`，实测 ~400ms 才 `display:none`），现有代码正是靠轮询 `display` 决定何时清空正文，销毁要挂在同一处；⑤ 失败/不支持一律落回"只下载"卡片并**销毁已挂载的实例**；⑥ `Esc`/点背景关闭、焦点落主操作、`aria-*` 与库 Shadow DOM 里的焦点不打架 |
| G26 | **放宽只落在列表页**（守卫） | `test/ui-guard.test.ts` 加断言：`public/_headers` 的 `/*` 保持零放宽；放宽项只出现在"列表页 HTML 由 Worker 出响应"这条路径的实现里（`src/index.ts` 的那一段），`login.html` / `/ui_v2/**` / `/ui/**` / 站点根不得带 `unsafe-inline`/`wasm-unsafe-eval`/`blob:`/`worker-src`/`frame-src`/`media-src` |

## 10. 过程日志（追加式；每轮一段）

### 2026-09-21 轮 1 — 勘察与方案确立

- 触发：用户提出「能不能把 `file-viewer` 深度集成进 V1 作为预览方案」。
- 做法：读两仓代码/文档核对事实（**未动任何文件**）：库侧许可与打包形态、运行期资产、体积阶梯（`npm view … dist.unpackedSize`）、CSP 依赖（Shadow DOM 样式注入、Worker/WASM、`blob:` 图片）；我侧 CSP/资源数/挂载点/数据端点。
- 产出：本文（决策 D-1…D-6 + 实施阶段 + 同步清单 + 需授权的 §7）；`docs/design.md` 加 ADR **D21**；`docs/ui.md` 加指针；`docs/progress.md` §112。
- 未做：任何代码、任何 CSP 改动、任何 vendor 入库（等 §7 授权与阶段 0 体积实测）。
- 下一次进来先看：§7 的授权结论 → 阶段 0 的体积/CSP 实测 → 再排阶段 1–2。

### 2026-09-21 轮 2 — 交付严格度与待决项

- 用户指示：①「有什么需要我决定的解释后提问」；②「我们这个是开发版，不用考虑什么兼容等等问题」。
- 落实：§1 非目标加"不承担兼容负担"（并写明**许可与安全两类不因此免掉**）；D-1 的反方措辞按事实校准
  （AGPL 是聚合关系 + 网络条款，不是"传染整个部署"这种过强表述）。
- 待用户拍板的四项（见 §5 D-6 后的问答）：§7 的 CSP 授权、覆盖范围（预设档位）、产物交付方式、入口形态。
- 未动代码。

### 2026-09-21 轮 3 — 用户接受全部推荐（5 项）与文档审计

- 用户指示：「接受你的意见，文档化，然后确定一下文档都考虑到、都合理吗」。
- 落实：§5 六项决策的状态全部改成"已定（用户 2026-09-21 确认）"；新增 **D-7**（实施许可与并行：`npm pack` 到临时目录、
  阶段 1 并行开工）；§7 记入**授权**（选 (a)、只放宽预览页）与两条实现要点（CSP 是文档级策略；vendor 反该长缓存）；
  新增 **§9 落地细节清单（G1–G12）**；§6 的两行前置改成"已许可/已授权"。
- 审计结论：文档**已覆盖**目标、术语、事实（含实测体积阶梯）、决策与依据、阶段与验收、授权与后果、同步清单、落地细节、过程日志；
  同时**发现并补齐 12 处落地细节**（G1–G12），其中 **G3 仍需用户拍板**（新增文案进两版 `messages.js` 会触发对等守卫 → 要动 V2 一个文件；
  或单开 V1 文件并说明为何不算违反"文案单点"）。
- 未动代码。

### 2026-09-21 轮 4 — 复审：按实测把方案重新过一遍（发现 3 处硬伤 + 补齐实测数字）

- 触发：用户「充分详实再一次评估一下这个计划」。
- 做法（全程只读，另加一次**临时**改 `_headers` 的本地实验，已逐字节还原）：
  ① 读库源码核对 CSP 依赖（`new Worker` / `createObjectURL` / `srcdoc` / `WebAssembly` / `createElement('style')`）；
  ② `npm pack` 解包 `@file-viewer/assets-standard@3.1.2` 与 `@file-viewer/web`、`renderer-pdf`（**临时目录**）；
  ③ 读官方 `_headers` 与 limits 文档；④ 起 `wrangler dev` 实测 `_headers` 三条语义（合并 / 代理后仍生效 / 与 Worker 响应无关）。
- **硬伤 1（机制）**：§7 原本的"在 `_headers` 里另写一条更宽的 CSP 规则"**做不成** —— 同名字段逗号合并 ⇒ 两段策略 = 交集
  （实测：`/ui_v1/js/api.js` 得到 `…, default-src 'none'; script-src 'self' TESTMARKER-A`），同规则里 `!` 取消再重设也无效。
  ⇒ 新 **D-8**：预览页的响应由 Worker 出（官方文档：Worker 生成的响应不套 `_headers`），代价是其余安全头要自己逐条补（G13）。
- **硬伤 2（对象）**：阶段 0 原写 `npm pack @file-viewer/web-full` —— 它是 `preset-all`（225.07 MB/2 961 文件，依赖链含
  `@flyfish-dev/cad-viewer` = **AGPL-3.0-only**），与 D-1「不做 CAD」直接冲突（vendoring 它＝分发 AGPL 运行时）。
  ⇒ 阶段 0 改为**离线构建标准档**（Vite + `@file-viewer/web` + `preset-standard` + 插件 `copyAssets`），并禁止装 `-full`（G14）。
- **硬伤 3（缺环）**：计划没有回答"产物怎么来"。实测：`@file-viewer/web` **只有壳**（0.82 MB/18 文件，不含 renderer），
  renderer/preset 必须由打包器装配；且 `new Worker(new URL('./x.worker.js', import.meta.url))` 只有 Vite 会重写成可部署资产。
  ⇒ 补 D-3 的交付形态（离线构建 + 配方入库）与 G14/G19。
- **补齐的实测数字**（§3）：资源载荷 11.98 MB/314 文件（pdf 9.19 MB/299：worker 2.04 + 168 cmaps + 101 CJK woff2 + wasm）；
  资产只有 5 组；清单自带 `packageVersion`/`copyGroups`/`profileManifestSha256` ⇒ 守卫可做强（G10）；许可文件随载荷；
  平台上限 20 000 文件 / 单文件 25 MiB；本仓库 `core.autocrlf=true` 且无 `.gitattributes`（G15）。
- **CSP 放宽项修正**：原清单漏 `frame-src 'self'`（email/html/xml 的 `srcdoc` iframe），且 `worker-src` 与 `media-src`
  都必须带 `blob:`（archive 的 blob worker、音视频的 blob `src`）；`style-src 'unsafe-inline'` 确实必需且**库不支持 nonce**
  ⇒ 脚本侧仍是 `script-src 'self' 'wasm-unsafe-eval'`（无 `unsafe-inline`），攻击面描述相应收窄（§7）。
- 新增待拍板 3 项：D-8（机制修正，**授权本身不变**）、D-9（统一 `fetch`→`File`，放弃 PDF Range 流式）、D-10（`toolbar` 收敛）。
- 未动代码、未动 vendor、未改 `_headers`（实验后已还原，哈希一致）。

### 2026-09-21 轮 5 — 五项待决项的用户裁定

- 用户裁定（「解释后提问」）：① CSP 出口＝**放宽写进 `/*`、全站生效**（取代轮 4 前的「只放宽预览页」）；② 取字节＝**统一 `fetch` → `File`**；
  ③ 库工具栏＝**关 `download`/`print`/`exportHtml`，留 `zoom`/`search`**；④ 装配档位＝**`preset-standard` 全档**；⑤ 文案落点＝用户反问「`messages.js` 为什么不放进 `ui_shared`」。
- 落实：D-1 补装配档位段；**D-8 整节改写**（全站放宽 + 后果逐条 + 执行前熔断 + 作废 Worker 分支与「逐条补安全头」）；
  D-9/D-10 转「已定」；§6 阶段 3 的验收随之改（删掉「列表页 CSP 不变」）；§7 授权记录、G4、G13 同步。
- ⑤ 的答复（代码依据）：两版 `messages.js` 从首条 `import` 起逐字一致（**3 222 字符**，本轮复测），但它
  `import { typeLabel, truncateText } from './format.js'`（V1:23 / V2:12），而两版 `format.js` 是**有意不同**的
  （UTF-16 码元 vs 字素簇；`AGENTS.md` §1、`docs/archive/AUDIT-v1-v2-divergence.md` §5.3）⇒ 搬进共用层只有两条路：
  ① 抹平该差异（推翻已登记的决定）；② 让共用层反向 `import` 某一版的 `format.js`（红线禁止，且 V2 会被迫依赖 V1）。
  故仍推荐进两版 `messages.js`；若接受「单消费的纯文案模块」，可在共用层新开 `ui_shared/js/viewer-messages.js`
  （它不 import `format.js` ⇒ 不违反 §3.4 的规定、也不触对等守卫），代价是从此多一个文案点。
- **同日追加（解释后二次确认）**：用户看完 CSP 的大白话解释与 A/B 代价对比后**最终选 A（只放宽预览页）**——
  即 D-8 回到"预览页响应由 Worker 出、`_headers` 的 `/*` 保持零放宽"；B（全站放宽）作废但**保留在案**（它是"一处生效 vs 全站变宽"的取舍，
  后人不要以为没考虑过）。这条正是轮 4 前已授权的那一档，**不是新的降安全动作**。
- `messages.js` 的搬法：用户定**工厂注入**（`ui_shared/js/messages.js` 导出 `createMessages({ typeLabel, truncateText })`，
  两版各留瘦 shim，5 个导出名与 20 余处调用点零改动、两版 `format.js` 一字不动），并指示"现在是开发版" ⇒ 不为兼容留双路
  （V1 那份"为什么自己有一份"的旧文件头注释直接删掉）。
- 未动代码；`public/_headers` 与 `messages.js` 都还没碰 —— 等用户给"开工"信号后按 §6 阶段顺序落地。

**轮 5 订正（同日晚，实测后自我纠正）**：我在问答里曾说"`messages.js` 依赖的两版 `format.js` 有意不同（码元 vs 字素簇）"——
逐函数比对后**不成立**：`truncateText`/`charCount`/`typeName` 两版逐字相同、`TYPE_LABELS` 相同，只有 `typeLabel` 差一个 `?? '未知'` 兜底；
§5.3 那条差异在别处（服务端 `query.ts` 按码元、V1 预览尺寸取服务端 `size`、V2 用 `charCount()`）。
⇒ 用户的"搬进共用层"因此是**低代价、可保行为**的（把 `typeLabel`+`truncateText` 一起提到共用层、两版 `format.js` 再导出，调用点零改动），
G3 行已按此改写；守卫与文档的连带改动列在该行里。

## 11. 跳出来看：这个决定本身值不值（2026-09-21 轮 5 末，用户提问「这样实现合理吗、合适吗」）

**结论先行**：计划本身（工程侧）没问题；但「现在就上 `file-viewer`」这个决定，按**收益 / 成本 / 风险 / 可逆性**四把尺子量，
**不划算**。更便宜的第一方方案能覆盖剪贴板里最常看的那几类，而且它是 `file-viewer` 方案的**真子集**
（同一个弹窗、同一处判据、同一套 A 档 CSP 机制、同一份文案）⇒ 先做它**不产生返工**。

### 11.1 四把尺子

| 尺子 | 便宜档（第一方：用浏览器自带的阅读器/播放器） | `file-viewer`（原计划 D） |
|---|---|---|
| 覆盖 | 文本 `<pre>`、图片 `<img>`（今天就有）+ **PDF**（浏览器自带阅读器）+ **音视频**（`<video>/<audio>`）；其余仍下载 | 上面全部 **+ docx/xlsx/pptx/odt/rtf、zip/rar/7z、eml/msg/mbox、OFD、HEIC、MIDI…** |
| 一次性成本 | 弹窗里的三档内容（含可复用的判据与机制）+ 列表页 CSP 加 2 条（`frame-src 'self'`、`media-src 'self'`） | 同一张页 **+ 2.8–12 MB 第三方入库 + 一次性离线构建工具链与配方 + 预检清单 + 许可声明 + 守卫 + 文档** |
| 永久成本 | 无 | 每次升级换目录名重建；git 历史不可逆地长胖；许可/安全声明要维护；CSP 特例分支要维护 |
| 风险 | 近乎零（PDF/媒体跑在**浏览器自己的沙箱**里，不是我们源上的 JS） | **第三方解析器在我们源上执行**：手里有会话 Cookie、能打 `/ui/api/*`（读全部历史、还能 `clear`）⇒ 最坏后果是「一份构造的文档读走或清空你的整份剪贴板历史」 |
| 可逆性 | 删一个分支 | 删目录 + 一个分支可回滚，但 git 历史与构建流程回不去 |

### 11.2 便宜档的实测依据（不是设想）

- **PDF**：`application/pdf` 在内联白名单里 ⇒ UI 数据端点回 `content-type: application/pdf` + `content-disposition: inline` + `nosniff`
  + `accept-ranges: bytes`（`src/ui/routes.ts:379-393`、`src/contentTypes.ts`）⇒ **新标签直接看**（**零 CSP 改动**，因为是顶层导航），
  或在**弹窗**里 `<iframe>` 嵌（列表页加 `frame-src 'self'` 即可，与 D-8(A) 的机制一致）。
- **音视频**：`attachment` 只影响"直接导航"，**不影响子资源加载** ⇒ 弹窗里 `<video>/<audio>` 直接播，
  Range/206 服务端已有（只需该页加 `media-src 'self'`）。
- ⇒ **服务端的加固一行都不用动**：内联白名单与 `fileHeaders` 那次存储型 XSS 加固的判据原样保留。

### 11.3 一个关键数字：PDF 占载荷的 77%

`assets-standard` 11.98 MB / 314 文件里，`vendor/pdf/` 独占 **9.19 MB / 299 文件**（`pdf.worker.mjs` 2.04 MB + 168 个 cmaps + 101 个 CJK woff2 分片 + wasm + 4 个标准字体）。
⇒ **去掉 `renderer-pdf` 后，载荷只剩 2.78 MB / 15 文件**。而 PDF 恰恰是"浏览器自带阅读器"处理得最好的格式
（流式 Range、搜索、打印、缩放，而且全在浏览器自己的沙箱里）。
⇒ 若最终仍要上 `file-viewer`，**也不该装 pdf 渲染器**：把 PDF 交给原生阅读器，把第三方限制在"确实无解"的那几类（Office / 压缩包 / 邮件 / OFD）。

### 11.4 什么时候"直接上 D"才有道理

当主场景确实是「在**没有 Office、没有解压工具**的机器上（平板、手机、别人的电脑）需要看 docx/xlsx/zip」——这时它的价值成立，而这份计划已经就绪。
若主场景是「设备之间搬运 + 最终在桌面端用原生应用打开」，那么 D 买到的是"少点一次下载"，而风险与重量是**永久**的。

### 11.5 建议的路径

1. **先做便宜档**（PDF + 音视频 + 现有的文本/图片，零第三方字节）；
2. 用一段时间，观察是否真的需要 Office/压缩包预览；
3. 若确实需要，再按本计划上 `file-viewer`，但**按 §11.3 去掉 pdf 渲染器**、并按 D-8(A) 只放宽那一页。

第 1 步产生的每一件东西（弹窗里的三档内容、`viewerRoute()` 判据、A 档 CSP 机制、`i18n`/文案）在 D 里**全部复用**
⇒ 顺序反过来**不浪费**：便宜档就是 D 的第一个阶段，而不是它的岔路。

### 11.6 裁定（同日）：PDF 交给浏览器自带的（用户决定）

用户读完 §11 后裁定：**把 PDF 从库里拿掉，用浏览器自带的阅读器**，并按此改计划。已落实的位置：

- **D-1 装配档位**：`preset-standard` **减去 `renderer-pdf`** ⇒ 载荷 11.98 MB/314 文件 → **≈2.78 MB / 15 文件**（省掉 77%）；
- **D-4 判据**：从三档扩成**五档**（`inline` / `native-pdf` / `native-media` / `document` / `download`）—— 常见音视频也归原生，
  库里只留"浏览器确实做不到"的几类；并写明**不要**为此去放宽服务端的内联白名单（`attachment` 不影响子资源加载）；
- **D-5 入口**：**不新增页面**，弹窗同时承担"浏览器自带阅读器 + 自带播放器 + 库"三种内容；CSP 放宽（`frame-src`/`media-src`）正是为它们服务的，且落点是列表页那一张 HTML；
- **§6 阶段 0/2**：构建用**显式 `formats`（不含 pdf）**，产物里出现 `vendor/pdf/**`/pdfjs 即算失败，守卫同步加这条断言；
- **§7**：`frame-src 'self'` 的主要用途变成"我们自己的 PDF iframe"，`media-src` 的主要用途变成"原生播放"（库的 `blob:` 只在装了 media 渲染器时才需要）；
- **§9**：新增 **G24**（原生 PDF/媒体的实现与验证：探针要验"真渲染"，防白屏假通过）；**G21** 顺手定了三个零资产渲染器（`text`/`image`/`media`）**默认不装**；
  **G22** 的许可清单随之收缩（pdfjs 与字体许可随 pdf 一起去掉，别为已移除的包写声明）。

**风险陈述不变**：省掉的是**载荷**，不是**风险面** —— 留下来的 Office/压缩包/邮件解析器仍然跑在**我们的源**上、手里仍有会话 Cookie 与 `/ui/api/*`（读历史、`clear`）。
真要压这条，只有 §7 的 (c) 独立来源隔离，本轮不做。

**同日再收口（用户第二句）**：「**不要打开新的页面预览**，详细的就像现在弹窗预览 Office 等新的」⇒ **D-5 改为统一走现有对话框**：
- **不新增页面**：无 `view.html`、`DEEP_LINK` 语义不变、资源数只增第三方文件、**G11 作废**（CI 冒烟无需新增断言）；
- **CSP 放宽的落点随之确定**：从"独立预览页"改成**列表页那一张 HTML**（`/ui_v1/` 与 `/ui_v1/index.html`，仍是 Worker 出响应；V2 / 登录页 / 跳转壳 / 站点根仍零放宽）；
- **新增两条落地项**：**G25**（弹窗内的挂载/销毁契约：动态 `import()`、稳定高度、**布局就绪后再挂载**防白屏、随 `discardBody()` 一起 `destroy()`、失败落回只下载）、**G26**（守卫断言"放宽只落在列表页这一条路径"）；
- **如实记下的代价**：失败隔离弱于独立页（库崩在列表页的弹窗里）、常驻页面必须管好 worker/canvas 的销毁；
- **一个被证伪的担心**：动态 `import()` 不会被 `ui-guard` 的预载闭包判据抓住（该正则不匹配 `import(`），所以"首屏零字节"与守卫不冲突 —— 这一条已核过源码。

### 2026-09-21 轮 5 末 — 用户走查后的两处收口

- 用户提问「跳出来评估现在的预览实现合理吗、合适吗」⇒ 新增 **§11**（四把尺子 + 便宜档的实测依据 + "PDF 占载荷 77%"这个关键数字 + 顺序建议）。
- 用户裁定：**PDF 交给浏览器自带的阅读器，`file-viewer` 不承担 PDF** ⇒ 按 §11.6 改了 D-1/D-4/D-5/§6/§7/§9（含新 G24、G21 的选装决定）。
- 结论未变的部分：仍要上 `file-viewer`（覆盖 Office/压缩包/邮件/OFD），只是**装配窄了、载荷小了、原生优先**。

### 2026-09-21 轮 5 末（第二次收口）— 不新增页面，统一走现有弹窗

- 用户指示：「不要打开新的页面预览，详细的就像现在弹窗预览 Office 等新的」。
- 落实：**D-5 整节改写**（统一对话框；取消 `view.html`、`DEEP_LINK` 不变、新增三条代价）；**D-8 整节改写**（放宽落点＝列表页 HTML）；
  §6 阶段 3/4/5 验收改写（含"首屏请求里没有 vendor 任何字节""关闭后销毁干净"）；§8 同步清单（无新页面／CI 不必改）；
  §9：**G11 作废**、G23/G24 改成弹窗口径、**新增 G25/G26**；§11.6 增补本裁定。
- 已核源码的一条（免得白担心）：`ui-guard` 的 import 闭包正则 `import\s+(?:[\s\S]*?\sfrom\s+)?['"]…` **不匹配 `import(`** ⇒ 动态导入的 vendor 既不会被要求进 `modulepreload`，也不会进 V1 的模块闭包。
