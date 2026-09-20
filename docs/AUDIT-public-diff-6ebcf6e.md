# public/ 变更审计：`6ebcf6e` → `da1ee44`

> **审计对象**：`public/` 从基线 `6ebcf6e` 到当时 HEAD `da1ee44` 的**全部**变更。
> **产出**：本文档。逐文件、逐 hunk 列出，并逐条给出核实结论。
> **口径声明**：本轮**按用户要求未运行任何测试**（未起 dev server、未跑 vitest、未跑 tsc/eslint）。
> 因此本文档里所有"核实"都指**静态核实**（逐字比对源码/注释/事实），**不构成"门禁已过"**——
> 按 `AGENTS.md` §1 的惯例，未验证的部分在提交信息里也必须写明"未验证"。

---

## 0. 为什么会有这份审计

基线之后的这一串提交（22 笔）里，`public/` 的改动量是 90 个文件、208 个 hunk、4708 行 diff。
其中**主体是一次目录改名**（`ui_old` → `ui_v1`、`ui` → `ui_v2`、`/ui/` 收成跳转壳），
但改名之外还夹着大量**注释改写**——按 `AGENTS.md` §1，本仓库的注释是**被测试与文档引用的事实**，
注释漂移的代价与代码漂移相同。故本审计把"注释是否与代码一致、是否与事实一致"与代码逻辑一并核。

## 1. 核实方法（可复算）

| 步骤 | 做什么 | 判据 |
|---|---|---|
| 1 | `git diff 6ebcf6e..HEAD -- public/` 逐 hunk 拆开编号 | 90 文件 / 208 hunk |
| 2 | 每个 hunk 的「上下文行 + 新增行」按原序拼成串，在 `HEAD` 版本文件里找**连续子串** | 命中 ⇒ 该 hunk 与 HEAD 完全一致（205/208 命中；另 3 个是整文件删除） |
| 3 | 对 hunk 里的**每一处事实性断言**（行号引用、数字、指代、因果）回到当前源码逐条复核 | 见 §4 |
| 4 | 对确认的失实注释 / 真缺陷出补丁，**匹配唯一 + 写回读回校验**后落地 | 见 §4 |
| 5 | **覆盖率对账**：`--shortstat` / `--numstat` 与本文档台账的「文件数 / +行 / −行」三方比对 | 见 §7.1（100%） |
| 6 | **站内引用核验**：`docs/*.md`、`§N`、`/ui*` 资源路径、`modulepreload` 闭包逐条落盘核对 | 见 §7.2～§7.4 |
| 7 | **断言抽取**：`文件:行`、反引号标识符、算术等式从 208 个 hunk 里抽出来复算 | 见 §7.4 / §7.5 |

**机械核实的结果：`MISMATCH = 0`。** 即这 208 个 hunk 里的**每一行**都确实落在当前 `HEAD` 上——
没有"diff 里写了、代码里没有"的幽灵变更。

> 复核脚本：`.audits/_hunkverify.mjs`（输出 `.audits/hunks.txt`、`.audits/hunks-summary.txt`）；
> 台账生成脚本：`.audits/_gendoc.mjs`；补丁器：`.audits/_patch.mjs`。
> 这三个脚本与原始 diff 都在 `.audits/`（未进版本库）。
> 本轮（事实复核）另加：`_coverage2.mjs`（覆盖率）、`_assetpaths.mjs`、`_preload.mjs`、
> `_docrefs.mjs`、`_claims.mjs`、`_arith.mjs`、`_eqs.mjs`、`_v1coarse.mjs`。

---

## 2. 按文件总览（90 项）

```
M=修改  A=新增  D=删除  R*=改名（R100 = 正文逐字未动，只有路径变）
hunk 列为 0 的行 = 纯改名，没有任何正文改动。
```

| 文件 | 变更性质 | hunk 数 | 核实 |
|---|---|---|---|
| `public/_headers` | 修改 | 2 | ✅ |
| `public/ui/index.html` | 修改 | 2 | ✅ |
| `public/ui/js/next-target.js` | 删除 | 1 | ✅ |
| `public/ui/js/redirect-hash.js` | 修改 | 1 | ✅ |
| `public/ui_old/README.md` | 删除 | 1 | ✅ |
| `public/ui_old/css/archive.css` | 删除 | 1 | ✅ |
| `public/ui_v1/README.md` | 新增 | 1 | ✅ |
| `public/ui_v1/apple-touch-icon.png` | 改名 ← `public/ui/apple-touch-icon.png` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/css/auth.css` | 改名 ← `public/ui_old/css/auth.css` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/css/base.css` | 改名 ← `public/ui_old/css/base.css` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/css/components.css` | 改名 ← `public/ui_old/css/components.css` | 4 | ✅ |
| `public/ui_v1/css/layout.css` | 改名 ← `public/ui_old/css/layout.css` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/css/motion.css` | 改名 ← `public/ui_old/css/motion.css` | 1 | ✅ |
| `public/ui_v1/css/tokens.css` | 改名 ← `public/ui_old/css/tokens.css` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/favicon-32.png` | 改名 ← `public/ui/favicon-32.png` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/favicon.svg` | 改名 ← `public/ui/favicon.svg` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/index.html` | 改名 ← `public/ui_old/index.html` | 3 | ✅ |
| `public/ui_v1/js/api.js` | 改名 ← `public/ui_old/js/api.js` | 3 | ✅ |
| `public/ui_v1/js/clipboard.js` | 改名 ← `public/ui_old/js/clipboard.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/js/components/confirm.js` | 改名 ← `public/ui_old/js/components/confirm.js` | 6 | ✅ |
| `public/ui_v1/js/components/header.js` | 改名 ← `public/ui_old/js/components/header.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/js/components/info.js` | 改名 ← `public/ui_old/js/components/info.js` | 1 | ✅ |
| `public/ui_v1/js/components/list.js` | 改名 ← `public/ui_old/js/components/list.js` | 10 | ✅ |
| `public/ui_v1/js/components/pagination.js` | 改名 ← `public/ui_old/js/components/pagination.js` | 2 | ✅ |
| `public/ui_v1/js/components/preview.js` | 改名 ← `public/ui_old/js/components/preview.js` | 2 | ✅ |
| `public/ui_v1/js/components/row-content.js` | 改名 ← `public/ui_old/js/components/row-content.js` | 1 | ✅ |
| `public/ui_v1/js/components/stats.js` | 改名 ← `public/ui_old/js/components/stats.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/js/components/toast.js` | 改名 ← `public/ui_old/js/components/toast.js` | 1 | ✅ |
| `public/ui_v1/js/components/toolbar.js` | 改名 ← `public/ui_old/js/components/toolbar.js` | 5 | ✅ |
| `public/ui_v1/js/dom.js` | 改名 ← `public/ui_old/js/dom.js` | 1 | ✅ |
| `public/ui_v1/js/filters.js` | 改名 ← `public/ui_old/js/filters.js` | 1 | ✅ |
| `public/ui_v1/js/format.js` | 改名 ← `public/ui_old/js/format.js` | 2 | ✅ |
| `public/ui_v1/js/icons.js` | 改名 ← `public/ui_old/js/icons.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/js/latest.js` | 改名 ← `public/ui_old/js/latest.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/js/login.js` | 改名 ← `public/ui_old/js/login.js` | 3 | ✅ |
| `public/ui_v1/js/main.js` | 改名 ← `public/ui_old/js/main.js` | 21 | ✅ |
| `public/ui_v1/js/messages.js` | 改名 ← `public/ui_old/js/messages.js` | 2 | ✅ |
| `public/ui_v1/js/next-target.js` | 改名 ← `public/ui_old/js/next-target.js` | 1 | ✅ |
| `public/ui_v1/js/signalr.js` | 改名 ← `public/ui_old/js/signalr.js` | 2 | ✅ |
| `public/ui_v1/js/store.js` | 改名 ← `public/ui_old/js/store.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/js/theme-init.js` | 改名 ← `public/ui_old/js/theme-init.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v1/login.html` | 改名 ← `public/ui_old/login.html` | 2 | ✅ |
| `public/ui_v1/manifest.webmanifest` | 改名 ← `public/ui_old/manifest.webmanifest` | 1 | ✅ |
| `public/ui_v2/app/index.html` | 改名 ← `public/ui/app/index.html` | 4 | ✅ |
| `public/ui_v2/app/login.html` | 改名 ← `public/ui/app/login.html` | 3 | ✅ |
| `public/ui_v2/apple-touch-icon.png` | 改名 ← `public/ui_old/apple-touch-icon.png` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/css/base-v2.css` | 改名 ← `public/ui/css/base-v2.css` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/css/board-v2.css` | 改名 ← `public/ui/css/board-v2.css` | 7 | ✅ |
| `public/ui_v2/css/overlay-v2.css` | 改名 ← `public/ui/css/overlay-v2.css` | 5 | ✅ |
| `public/ui_v2/css/shell-v2.css` | 改名 ← `public/ui/css/shell-v2.css` | 7 | ✅ |
| `public/ui_v2/css/tokens-v2.css` | 改名 ← `public/ui/css/tokens-v2.css` | 4 | ✅ |
| `public/ui_v2/favicon-32.png` | 改名 ← `public/ui_old/favicon-32.png` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/favicon.svg` | 改名 ← `public/ui_old/favicon.svg` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/api.js` | 改名 ← `public/ui/js/api.js` | 5 | ✅ |
| `public/ui_v2/js/boot.js` | 改名 ← `public/ui/js/boot.js` | 21 | ✅ |
| `public/ui_v2/js/clipboard.js` | 改名 ← `public/ui/js/clipboard.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/dom.js` | 改名 ← `public/ui/js/dom.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/filters.js` | 改名 ← `public/ui/js/filters.js` | 3 | ✅ |
| `public/ui_v2/js/focus.js` | 改名 ← `public/ui/js/focus.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/format.js` | 改名 ← `public/ui/js/format.js` | 4 | ✅ |
| `public/ui_v2/js/icons.js` | 改名 ← `public/ui/js/icons.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/keys.js` | 改名 ← `public/ui/js/keys.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/latest.js` | 改名 ← `public/ui/js/latest.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/login.js` | 改名 ← `public/ui/js/login.js` | 5 | ✅ |
| `public/ui_v2/js/menus.js` | 改名 ← `public/ui/js/menus.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/messages.js` | 改名 ← `public/ui/js/messages.js` | 1 | ✅ |
| `public/ui_v2/js/next-target.js` | 新增 | 1 | ✅ |
| `public/ui_v2/js/paths.js` | 改名 ← `public/ui/js/paths.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/push.js` | 改名 ← `public/ui/js/push.js` | 5 | ✅ |
| `public/ui_v2/js/spark.js` | 改名 ← `public/ui/js/spark.js` | 1 | ✅ |
| `public/ui_v2/js/state.js` | 改名 ← `public/ui/js/state.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/theme-init.js` | 改名 ← `public/ui/js/theme-init.js` | 1 | ✅ |
| `public/ui_v2/js/theme.js` | 改名 ← `public/ui/js/theme.js` | 1 | ✅ |
| `public/ui_v2/js/ui/appbar.js` | 改名 ← `public/ui/js/ui/appbar.js` | 7 | ✅ |
| `public/ui_v2/js/ui/batchbar.js` | 改名 ← `public/ui/js/ui/batchbar.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/ui/blank.js` | 改名 ← `public/ui/js/ui/blank.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/ui/board.js` | 改名 ← `public/ui/js/ui/board.js` | 7 | ✅ |
| `public/ui_v2/js/ui/button.js` | 改名 ← `public/ui/js/ui/button.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/ui/dialog.js` | 改名 ← `public/ui/js/ui/dialog.js` | 8 | ✅ |
| `public/ui_v2/js/ui/drawer.js` | 改名 ← `public/ui/js/ui/drawer.js` | 9 | ✅ |
| `public/ui_v2/js/ui/filters.js` | 改名 ← `public/ui/js/ui/filters.js` | 2 | ✅ |
| `public/ui_v2/js/ui/ghost.js` | 改名 ← `public/ui/js/ui/ghost.js` | 1 | ✅ |
| `public/ui_v2/js/ui/menu.js` | 改名 ← `public/ui/js/ui/menu.js` | 1 | ✅ |
| `public/ui_v2/js/ui/omnibox.js` | 改名 ← `public/ui/js/ui/omnibox.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/ui/overview.js` | 改名 ← `public/ui/js/ui/overview.js` | 3 | ✅ |
| `public/ui_v2/js/ui/pager.js` | 改名 ← `public/ui/js/ui/pager.js` | 2 | ✅ |
| `public/ui_v2/js/ui/row.js` | 改名 ← `public/ui/js/ui/row.js` | 5 | ✅ |
| `public/ui_v2/js/ui/rowops.js` | 改名 ← `public/ui/js/ui/rowops.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/js/ui/toast.js` | 改名 ← `public/ui/js/ui/toast.js` | 0 | ✅ 纯改名，正文逐字未动 |
| `public/ui_v2/manifest.webmanifest` | 改名 ← `public/ui/manifest.webmanifest` | 1 | ✅ |

---

## 3. 逐 hunk 台账（208 条）

图例：**形状** `增`/`改`/`删`；**核实** 列 `✅` = 与 HEAD 逐字一致，**且**该 hunk 注释里的可量断言
已复算（两层含义与判据见 §1 与 §7；标"实测"的数值只做了**内部自洽核对**，这条边界写在 §7.5 末），
`⚑` = 该 hunk 引入的文本被本轮判定为失实/有缺陷并已替换（明细见 §4）。
末列是该 hunk 的第一条实质变更（截断）。

- 待核：**208**
- 已核且无需改：**188**
- 已核并已修：**17**（⚑）
- 整文件删除（无需逐行核内容，只核"删对了"）：**3**
- 未核：**0**
- **第二轮独立复核**（§8，2026-09-20）：**208 / 208 逐处重读**；其中 17 处 `⚑` 回**当前工作区代码**复核，
  结论 **17 / 17 成立**；本轮新查 **F-13**（代码）/ **F-14**、**F-15**（本文档自身）。
  凡标 `✅` 的含义仍是 §1 那两层（机械逐字一致 + 可量断言复算），**不含"门禁已过"**（见 §6 / §8.4）。

| # | 文件 | 位置 | 形状 | 核实 | 变更摘要 |
|---|---|---|---|---|---|
| 001 | `public/_headers` | 新 1,18 | 改 | ✅ | # 为什么需要它：Worker 只把静态资源转回去、自己不设头，所以这批文件的响应头只能在这里声明。两件事： |
| 002 | `public/_headers` | 新 23,48 | 改 | ✅ | # ── 无指纹的 JS/CSS 必须重验证；引入构建指纹后才可改成长缓存 ── |
| 003 | `public/ui/index.html` | 新 7,22 | 改 | ✅ | <link rel="icon" href="/ui_v2/favicon.svg" type="image/svg+xml" /> |
| 004 | `public/ui/index.html` | 新 31,13 | 改 | ✅ | 目标地址必须与 \`src/routes/webdav.ts\` 的根跳转一致。 |
| 005 | `public/ui/js/next-target.js` | 整文件删除 | 删 | ✅ | - // 登录后「下一跳」的判定（纯函数，无 DOM、无网络 —— 因此可以被测试直接覆盖）。 |
| 006 | `public/ui/js/redirect-hash.js` | 新 1,12 | 改 | ✅ | // 为什么需要它：\`/ui/\` 的唯一职责是把人送到默认界面 \`/ui_v1/\`。那一页的 \`<noscript>\` 里有一条 |
| 007 | `public/ui_old/README.md` | 整文件删除 | 删 | ✅ | - # \`public/ui_old/\` — V1 界面（**默认界面**） |
| 008 | `public/ui_old/css/archive.css` | 整文件删除 | 删 | ✅ | - /* 顶部提示条（V1 专用） |
| 009 | `public/ui_v1/README.md` | 新 1,53 | 增 | ✅ | # \`public/ui_v1/\` — V1 界面（**默认界面**） |
| 010 | `public/ui_v1/css/components.css` | 新 1008,12 | 改 | ✅ | * 同一列里每个动作的位置不随记录类型变 —— 四个槽位（预览 / 复制 / 下载 / 删除）恒定， |
| 011 | `public/ui_v1/css/components.css` | 新 1552,8 | 改 | ✅ | /* ============ 骨架屏（数据未落地时的占位，保留布局不跳）============ |
| 012 | `public/ui_v1/css/components.css` | 新 1561,34 | 改 | ✅ | /* 显式写回 display:none —— 上面那条 \`display: flex\` 会盖掉 \`[hidden]\` 的 UA 样式 |
| 013 | `public/ui_v1/css/components.css` | 新 1908,47 | 增 | ⚑ | /* ---- 骨架行 = 一张卡片的盒模型（2026-09-20，docs/progress.md §94 第 16 行）---- |
| 014 | `public/ui_v1/css/motion.css` | 新 24,7 | 改 | ✅ | * 这一族在 V1 里**没有任何实现**，而且是刻意的：\`public/ui_v1/js\` 里没有 rAF、没有插值循环、 |
| 015 | `public/ui_v1/index.html` | 新 18,50 | 改 | ✅ | <link rel="icon" href="/ui_v1/favicon.svg" type="image/svg+xml" /> |
| 016 | `public/ui_v1/index.html` | 新 70,26 | 改 | ✅ | <!-- 统计条：三个真实数字，由 js/components/stats.js 填充。 |
| 017 | `public/ui_v1/index.html` | 新 145,6 | 改 | ✅ | <script type="module" src="/ui_v1/js/main.js"></script> |
| 018 | `public/ui_v1/js/api.js` | 新 5,26 | 改 | ✅ | // ===== 挂载点：页面在 \`/ui_v1/\`、接口在 \`/ui/api/\`，两者不是同一个前缀 ===== |
| 019 | `public/ui_v1/js/api.js` | 新 78,19 | 改 | ✅ | // 「状态码是 2xx」与「body 是 JSON」是**两件事**。此前这条 catch 把解析失败静默折成 \`{}\`， |
| 020 | `public/ui_v1/js/api.js` | 新 102,11 | 增 | ✅ | // 失败响应走上面那条分支（它的文案来自 payload.detail / statusText）； |
| 021 | `public/ui_v1/js/components/confirm.js` | 新 15,11 | 增 | ✅ | // 「有请求在飞」的旗子：\`setPending(okButton, true)\` 只 disable 了**确认键**， |
| 022 | `public/ui_v1/js/components/confirm.js` | 新 27,13 | 增 | ✅ | // 在途时 ✕ 与「取消」都**不算**取消：请求已发出，关掉对话框只会让调用方 |
| 023 | `public/ui_v1/js/components/confirm.js` | 新 41,7 | 改 | ✅ | onclick: tryDismiss, |
| 024 | `public/ui_v1/js/components/confirm.js` | 新 50,7 | 改 | ✅ | onclick: tryDismiss, |
| 025 | `public/ui_v1/js/components/confirm.js` | 新 94,17 | 改 | ✅ | busy = true; |
| 026 | `public/ui_v1/js/components/confirm.js` | 新 116,15 | 改 | ✅ | // **Esc 在途时必须挡下**：\`cancel\` 是可取消事件，\`disabled\` 挡不住它 —— |
| 027 | `public/ui_v1/js/components/info.js` | 新 520,11 | 改 | ⚑ | // 与上面的 \`!info\` 分支同一条判据：有快照的调用方会先 \`open(fresh)\`，刷新失败时再 |
| 028 | `public/ui_v1/js/components/list.js` | 新 16,16 | 增 | ✅ | import { DEFAULT_FILTERS } from '../filters.js'; |
| 029 | `public/ui_v1/js/components/list.js` | 新 247,8 | 改 | ✅ | // 为什么需要：活跃视图一行**最多 7 个**可聚焦控件（复选框 + 至多 4 个行内动作 + 收藏/置顶）， |
| 030 | `public/ui_v1/js/components/list.js` | 新 324,51 | 改 | ✅ | // 骨架：数据还没落地时的占位。\`role="status"\` 而不是 \`alert\`——它是一段持续状态， |
| 031 | `public/ui_v1/js/components/list.js` | 新 419,20 | 增 | ✅ | // 最近一次 \`update()\` 收到的 filters：\`removeItem()\` 收掉本页最后一行时也要用它（空态文案由 |
| 032 | `public/ui_v1/js/components/list.js` | 新 591,20 | 改 | ✅ | function renderHead({ total, filtered, selection: selected, loading = false }) { |
| 033 | `public/ui_v1/js/components/list.js` | 新 724,24 | 改 | ⚑ | // 「还没到」与「真的没有」是两件事（2026-09-18 修）。 |
| 034 | `public/ui_v1/js/components/list.js` | 新 766,9 | 改 | ✅ | lastFilters = filters; |
| 035 | `public/ui_v1/js/components/list.js` | 新 785,20 | 改 | ✅ | lastHead = { total, filtered, loading: false }; |
| 036 | `public/ui_v1/js/components/list.js` | 新 821,9 | 改 | ✅ | // 展开 \`lastHead\` 而不是逐个字段抄：头栏的口径（总数/是否筛选中/是否加载中）只该有 |
| 037 | `public/ui_v1/js/components/list.js` | 新 872,23 | 改 | ✅ | // \`.empty\` 建出来时是**空的**，内容只在 \`update()\` 的空结果分支里填（见那处）。删掉本页 |
| 038 | `public/ui_v1/js/components/pagination.js` | 新 41,12 | 改 | ✅ | // 清空输入框（留着会让人以为「还没跳」），但**不 \`blur()\`**（2026-09-18 修）： |
| 039 | `public/ui_v1/js/components/pagination.js` | 新 66,28 | 改 | ⚑ | update({ page, pageSize, total, loading = false }) { |
| 040 | `public/ui_v1/js/components/preview.js` | 新 54,46 | 改 | ✅ | dialog.addEventListener('close', () => { |
| 041 | `public/ui_v1/js/components/preview.js` | 新 151,11 | 改 | ✅ | // 文本显示「字符数」，其余类型显示字节数——一个 27 B 的文本说"27 B"远不如说"27 个字符"有用。 |
| 042 | `public/ui_v1/js/components/row-content.js` | 新 23,7 | 改 | ✅ | // 这种自相矛盾。V2 的缩略图用的就是这个判据（public/ui_v2/js/ui/row.js）。 |
| 043 | `public/ui_v1/js/components/toast.js` | 新 27,14 | 改 | ✅ | // **不给每条提示加 \`role\`**（2026-09-18 修）：宿主（\`index.html\` 的 \`#toasts\`）已经是 |
| 044 | `public/ui_v1/js/components/toolbar.js` | 新 65,7 | 改 | ✅ | // V2 的那枚 chip 一直写的就是 \`收藏\`（\`public/ui_v2/js/ui/filters.js\`），而同一个词在行内 |
| 045 | `public/ui_v1/js/components/toolbar.js` | 新 130,18 | 改 | ✅ | // 「立刻结算」的那几条路径（Esc / 清空按钮 / 原生 search 事件）必须先 \`cancel()\`： |
| 046 | `public/ui_v1/js/components/toolbar.js` | 新 159,7 | 改 | ✅ | searchNow(searchInput.value.trim()); |
| 047 | `public/ui_v1/js/components/toolbar.js` | 新 167,7 | 改 | ✅ | searchNow(''); |
| 048 | `public/ui_v1/js/components/toolbar.js` | 新 181,7 | 改 | ✅ | searchNow(''); |
| 049 | `public/ui_v1/js/dom.js` | 新 56,22 | 改 | ✅ | /** |
| 050 | `public/ui_v1/js/filters.js` | 新 4,7 | 改 | ✅ | // range=all\|today\|7d\|30d —— 预设，边界在每次请求时按"现在"重算（页面开一整天也不会停在旧窗口） |
| 051 | `public/ui_v1/js/format.js` | 新 21,19 | 改 | ✅ | if (!Number.isFinite(n)) return '—'; |
| 052 | `public/ui_v1/js/format.js` | 新 95,44 | 增 | ✅ | /** |
| 053 | `public/ui_v1/js/login.js` | 新 2,17 | 改 | ✅ | // ===== 文档级幂等守卫（2026-09-18 补）===== |
| 054 | `public/ui_v1/js/login.js` | 新 54,14 | 改 | ✅ | async function submitLogin(event) { |
| 055 | `public/ui_v1/js/login.js` | 新 94,20 | 改 | ✅ | } |
| 056 | `public/ui_v1/js/main.js` | 新 5,11 | 改 | ✅ | import { api, ApiError, handleAuthError, redirectToLogin, PAGE_BASE } from './api.js'; |
| 057 | `public/ui_v1/js/main.js` | 新 45,10 | 增 | ⚑ | // 首屏数据还没落地。列表组件据此画骨架、而不是画空状态 —— 没有这一位时， |
| 058 | `public/ui_v1/js/main.js` | 新 119,20 | 增 | ✅ | /** |
| 059 | `public/ui_v1/js/main.js` | 新 158,26 | 增 | ✅ | // 哪些筛选字段会**改变结果集的成员资格**：变了它们，选择集里的旧快照可能已不在新结果里， |
| 060 | `public/ui_v1/js/main.js` | 新 204,9 | 改 | ✅ | // 回收站是范围切换：进出都回到第 1 页。选择集由 \`setFilters\` 统一清（\`deleted\` 在 |
| 061 | `public/ui_v1/js/main.js` | 新 309,15 | 改 | ⚑ | pagination.update({ |
| 062 | `public/ui_v1/js/main.js` | 新 333,13 | 改 | ✅ | // 取数期间列表画什么，取决于"手上有没有旧内容"： |
| 063 | `public/ui_v1/js/main.js` | 新 367,7 | 改 | ⚑ | store.set({ items: page.items, total: page.total, flashKeys, loading: false }); |
| 064 | `public/ui_v1/js/main.js` | 新 375,10 | 改 | ⚑ | // 失败也要把 loading 收掉：否则「加载失败 + 重试」之上还压着一层骨架， |
| 065 | `public/ui_v1/js/main.js` | 新 413,7 | 改 | ✅ | if (serverUnreachable(error)) setStale(true); |
| 066 | `public/ui_v1/js/main.js` | 新 432,15 | 改 | ✅ | // 失败**不阻断首屏**：列表那一份是单独取的，统计条与排障条留空即可；也不打开失联横幅 —— |
| 067 | `public/ui_v1/js/main.js` | 新 546,8 | 改 | ✅ | // 收藏 / 取消收藏）读的正是选择集里的对象。只更新列表而不更新它，就会出现 |
| 068 | `public/ui_v1/js/main.js` | 新 772,7 | 改 | ✅ | \`已复制 ${texts.length} 条文本（${charCount(payload)} 个字符\` + |
| 069 | `public/ui_v1/js/main.js` | 新 837,7 | 改 | ✅ | // 打开预览时把这一条写进 URL 的 hash：链接可以直接分享或收藏（\`/ui_v1/#Text-<hash>\`）。 |
| 070 | `public/ui_v1/js/main.js` | 新 889,7 | 改 | ✅ | toasts.info(\`已复制 ${charCount(text)} 个字符\`); |
| 071 | `public/ui_v1/js/main.js` | 新 976,7 | 改 | ✅ | toasts.info(\`已复制最近一条（${charCount(text)} 个字符）\`); |
| 072 | `public/ui_v1/js/main.js` | 新 1054,7 | 改 | ✅ | toasts.info(\`已下载 ${name}（${charCount(text)} 个字符）\`); |
| 073 | `public/ui_v1/js/main.js` | 新 1145,10 | 增 | ✅ | // 首屏合成快照一次都没落地时补一次（\`refreshOverview\` 的注释里原本就承诺了这件事， |
| 074 | `public/ui_v1/js/main.js` | 新 1164,7 | 改 | ✅ | if (serverUnreachable(error)) setStale(true); |
| 075 | `public/ui_v1/js/main.js` | 新 1201,17 | 改 | ✅ | // 同一文档里被重复求值（例如应用被以 \`/ui_v1\` 与 \`/ui_v1/\` 两个 URL 同时加载时， |
| 076 | `public/ui_v1/js/main.js` | 新 1233,17 | 增 | ✅ | // 这一帧画的是**骨架**，不是空状态：store 的 \`loading\` 初始为 true，列表据此走加载档。 |
| 077 | `public/ui_v1/js/messages.js` | 新 9,7 | 改 | ✅ | // V1（\`public/ui_v1/\`）是**默认界面/产品面**，必须完全自包含：V2（\`public/ui_v2/\`）是开发测试版、 |
| 078 | `public/ui_v1/js/messages.js` | 新 20,14 | 改 | ✅ | import { typeLabel, truncateText } from './format.js'; |
| 079 | `public/ui_v1/js/next-target.js` | 新 16,15 | 改 | ✅ | // 解析成功但指向**登录页自身**时同样回落：否则登录成功后会再落到登录页（多一跳）。 |
| 080 | `public/ui_v1/js/signalr.js` | 新 19,7 | 改 | ✅ | // 连续失败到这一次数就**停下快速重连**（不是永久放弃，见下面的冷却）。动机：环境若根本不支持 WebSocket（或被 CSP / 代理稳定阻断）， |
| 081 | `public/ui_v1/js/signalr.js` | 新 111,10 | 改 | ✅ | // \`pending\` 那一支：\`stop()\` 已把 socket 置空、而新一次 start() 正在取票据，旧连接的 close |
| 082 | `public/ui_v1/login.html` | 新 17,27 | 改 | ✅ | <link rel="icon" href="/ui_v1/favicon.svg" type="image/svg+xml" /> |
| 083 | `public/ui_v1/login.html` | 新 93,6 | 改 | ✅ | <script type="module" src="/ui_v1/js/login.js"></script> |
| 084 | `public/ui_v1/manifest.webmanifest` | 新 4,14 | 改 | ✅ | "start_url": "/ui_v1/", |
| 085 | `public/ui_v2/app/index.html` | 新 20,60 | 改 | ✅ | <link rel="icon" href="/ui_v2/favicon.svg" type="image/svg+xml" /> |
| 086 | `public/ui_v2/app/index.html` | 新 116,10 | 改 | ✅ | 它是 \`position: fixed\` 悬浮的，所以位置不影响观感。 |
| 087 | `public/ui_v2/app/index.html` | 新 132,9 | 改 | ✅ | <!-- 2026-09-18 定位翻转后这一条改叫「默认界面」：\`/ui_v1/\` 是默认入口（ADR D17）， |
| 088 | `public/ui_v2/app/index.html` | 新 156,6 | 改 | ✅ | <script type="module" src="/ui_v2/js/boot.js"></script> |
| 089 | `public/ui_v2/app/login.html` | 新 12,22 | 改 | ✅ | <link rel="icon" href="/ui_v2/favicon.svg" type="image/svg+xml" /> |
| 090 | `public/ui_v2/app/login.html` | 新 43,7 | 改 | ✅ | <!-- 「开发测试版」是常驻标记（2026-09-18 起默认界面是 V1 \`public/ui_v1/\`）： |
| 091 | `public/ui_v2/app/login.html` | 新 103,6 | 改 | ✅ | <script type="module" src="/ui_v2/js/login.js"></script> |
| 092 | `public/ui_v2/css/board-v2.css` | 新 373,14 | 改 | ✅ | /* 紧凑模式下正文只画一行（2026-09-18 修）。 |
| 093 | `public/ui_v2/css/board-v2.css` | 新 525,13 | 改 | ✅ | /* 「置顶」的选中态**不在这里**（2026-09-18 删掉了一条死规则）。 |
| 094 | `public/ui_v2/css/board-v2.css` | 新 602,30 | 改 | ✅ | /* 骨架行高 = **真实行高**，不是 --row-h（2026-09-19 修，审计报告 §10.1）。 |
| 095 | `public/ui_v2/css/board-v2.css` | 新 691,15 | 增 | ✅ | /* 卡片档的缩略图边长。它不只是缩略图的尺寸：**卡片的高度下限就是它撑出来的** |
| 096 | `public/ui_v2/css/board-v2.css` | 新 739,16 | 增 | ⚑ | /* 但**里面那个真的按钮**不能照抄这一套（2026-09-18 修）：\`.sort-btn\` 仍在 Tab 顺序里， |
| 097 | `public/ui_v2/css/board-v2.css` | 新 824,12 | 改 | ✅ | /* 封面图：缩略图在卡片里放大到 48px（桌面档 40px 看不出是什么）。 |
| 098 | `public/ui_v2/css/board-v2.css` | 新 838,54 | 增 | ✅ | /* ── 骨架行 = 一张卡片（2026-09-19 修 N-16 / docs/progress.md §94 第 13 行）── |
| 099 | `public/ui_v2/css/overlay-v2.css` | 新 175,8 | 改 | ✅ | * 用一个固定值（内联 SVG 里的 \`#857d71\`，一个中性灰；它与 \`--c-warm-500\`（\`#827a6e\`） |
| 100 | `public/ui_v2/css/overlay-v2.css` | 新 252,13 | 改 | ✅ | * 只用于"状态"，不用于"分类"（分类由类型色条承担）。故只有两个语义： |
| 101 | `public/ui_v2/css/overlay-v2.css` | 新 273,6 | 删 | ✅ | - .tag[data-tone="star"] { |
| 102 | `public/ui_v2/css/overlay-v2.css` | 新 1098,35 | 改 | ✅ | /* ── 窄屏：批量条与提示条都要让开安全区 ── |
| 103 | `public/ui_v2/css/overlay-v2.css` | 新 1136,7 | 改 | ✅ | bottom: calc(var(--sp-4) + env(safe-area-inset-bottom, 0px)); |
| 104 | `public/ui_v2/css/shell-v2.css` | 新 3,7 | 改 | ✅ | * 改名必须同步改 \`public/ui_v2/js/\`（\`test/ui-contract.test.ts\` 的双向类名守卫会拦下漏改的一半）。 |
| 105 | `public/ui_v2/css/shell-v2.css` | 新 85,11 | 改 | ✅ | * 因此色相差异要够大（青=实时、琥珀=轮询、灰=还没握过手）。 |
| 106 | `public/ui_v2/css/shell-v2.css` | 新 121,15 | 增 | ✅ | /* 握手中的过渡态（2026-09-18 补）：此前这一档**没有任何规则** —— \`connecting\` 能写进 |
| 107 | `public/ui_v2/css/shell-v2.css` | 新 424,14 | 增 | ✅ | /* 搜索在途：\`ui/omnibox.js\` 的 \`setBusy()\` 会写 \`data-busy\`，而此前**没有任何 CSS 消费者** |
| 108 | `public/ui_v2/css/shell-v2.css` | 新 655,21 | 改 | ✅ | /* ── 断点：两档（外加一档"极窄"） |
| 109 | `public/ui_v2/css/shell-v2.css` | 新 787,21 | 改 | ✅ | /* \`刷新\` 在窄屏**移到顶栏**（\`appbar.js\` 那个 \`data-when="narrow"\` 的图标按钮）： |
| 110 | `public/ui_v2/css/shell-v2.css` | 新 810,8 | 改 | ✅ | /* 文件尾曾有一条 \`@media (max-width: 380px) { :root { --fs-display: 1.5rem } }\`（"极窄时数字 |
| 111 | `public/ui_v2/css/tokens-v2.css` | 新 92,9 | 改 | ✅ | * （\`--r-xl\` / \`--z-dialog\` / \`--dur-instant\` / \`--ink-inverse\` 就是后者，已删；2026-09-20 |
| 112 | `public/ui_v2/css/tokens-v2.css` | 新 112,13 | 改 | ✅ | /* 输入控件的"内凹"影。为什么单独一个令牌而不是复用 \`--shadow-xs\`（那是"浮起来"）： |
| 113 | `public/ui_v2/css/tokens-v2.css` | 新 131,18 | 改 | ✅ | * V2 把两端拉开：micro 11 → title 17，并显式定义四档行高（V1 只有两档）。 |
| 114 | `public/ui_v2/css/tokens-v2.css` | 新 280,13 | 改 | ⚑ | /* 两个控件高度令牌此前停在 40 / 28px —— **都低于**上面写着"不可下调"的 \`--hit-min: 44px\`。 |
| 115 | `public/ui_v2/js/api.js` | 新 21,7 | 改 | ✅ | { method = 'GET', body, signal, textResponse = false, blobResponse = false, timeoutMs =… |
| 116 | `public/ui_v2/js/api.js` | 新 37,10 | 增 | ✅ | // 二进制响应（记录的数据文件）：成功时**不读文本** —— 把 8 MiB 的文件读成字符串再转回 Blob |
| 117 | `public/ui_v2/js/api.js` | 新 159,18 | 增 | ✅ | /** |
| 118 | `public/ui_v2/js/api.js` | 新 224,14 | 改 | ✅ | * |
| 119 | `public/ui_v2/js/api.js` | 新 256,7 | 改 | ✅ | location.replace(\`/ui_v2/app/login.html?next=${next}\`); |
| 120 | `public/ui_v2/js/boot.js` | 新 28,7 | 改 | ✅ | import { typeLabel, formatRelative, formatSize, charCount } from './format.js'; |
| 121 | `public/ui_v2/js/boot.js` | 新 62,7 | 改 | ✅ | // 同一文档重复初始化保护：应用若被以 \`/ui_v2/app\` 与 \`/ui_v2/app/\` 两个 URL 同时加载， |
| 122 | `public/ui_v2/js/boot.js` | 新 112,9 | 增 | ✅ | /** 后台标签里"错过了变更"的旗子：标记被照常推进，但刷新被 visibility 挡住， |
| 123 | `public/ui_v2/js/boot.js` | 新 141,9 | 增 | ✅ | // 窄屏的刷新入口（宽屏由筛选条里那个按钮承担 —— ≤720px 时它被隐藏， |
| 124 | `public/ui_v2/js/boot.js` | 新 156,9 | 改 | ✅ | // 回收站是范围切换：选择集由 \`setFilters\` 统一清（\`deleted\` 在 \`MEMBERSHIP_KEYS\` 里， |
| 125 | `public/ui_v2/js/boot.js` | 新 320,8 | 增 | ⚑ | // 分页也要能区分「还没到」与「真的没有」（见 ui/pager.js） |
| 126 | `public/ui_v2/js/boot.js` | 新 372,7 | 增 | ⚑ | loading: current.loading, |
| 127 | `public/ui_v2/js/boot.js` | 新 452,25 | 增 | ✅ | // 哪些筛选字段会**改变结果集的成员资格**（F3）：变了它们，选择集里的旧快照可能已不在 |
| 128 | `public/ui_v2/js/boot.js` | 新 530,10 | 改 | ✅ | // \`push: false\`：这是界面的**自我修正**，不该进浏览器的后退历史 —— |
| 129 | `public/ui_v2/js/boot.js` | 新 662,16 | 改 | ✅ | // 变更标记变了：说明别处写了数据。**可见时**整页刷新 + 给新行闪一次； |
| 130 | `public/ui_v2/js/boot.js` | 新 729,17 | 改 | ⚑ | // 这一行若在选择集里，选择集里那份也要换成新对象（F5）：批量条的方向与文案 |
| 131 | `public/ui_v2/js/boot.js` | 新 768,9 | 改 | ✅ | // 第二个参数是**邻居行里要找的那个图标名**，不是动作名：删除的发起控件是 \`⋯\` 菜单， |
| 132 | `public/ui_v2/js/boot.js` | 新 790,8 | 改 | ✅ | // 同上：恢复的发起控件是行内的「恢复」（图标名就是 \`undo\`） |
| 133 | `public/ui_v2/js/boot.js` | 新 833,7 | 改 | ✅ | toasts.ok(\`已复制 ${charCount(full.text)} 个字符\`); |
| 134 | `public/ui_v2/js/boot.js` | 新 859,9 | 改 | ✅ | // 走 \`api\` 层而不是裸 \`fetch\`：带超时、可取消、401 会跳登录（见 \`api.blobData\` 的说明）。 |
| 135 | `public/ui_v2/js/boot.js` | 新 873,11 | 增 | ✅ | if (handleAuthError(error)) return false; |
| 136 | `public/ui_v2/js/boot.js` | 新 925,7 | 改 | ✅ | \`${charCount(full.text)} 个字符 · ${formatRelative(full.lastAccessed ?? full.createTime)}\`, |
| 137 | `public/ui_v2/js/boot.js` | 新 1028,28 | 改 | ✅ | // 服务端的返回值必须**接出来**：\`confirm.ask\` 的 \`action\` 只关心成败，而批量写会回 |
| 138 | `public/ui_v2/js/boot.js` | 新 1145,12 | 改 | ✅ | // 模态 = 对话框 **或** 菜单。菜单**不是** \`<dialog>\`（\`ui/menu.js\` 顶部写了为什么弃用它）， |
| 139 | `public/ui_v2/js/boot.js` | 新 1217,12 | 增 | ✅ | // 回前台先补后台错过的变更（见 missedWhileHidden），再重连推送、再轮询。 |
| 140 | `public/ui_v2/js/boot.js` | 新 1262,7 | 改 | ✅ | * 深链接 \`#Text-<hash>\`：hash 空闲（筛选状态走 query string），打开即预览那一条。 |
| 141 | `public/ui_v2/js/filters.js` | 新 63,6 | 删 | ✅ | - const DAY_MS = 86_400_000; |
| 142 | `public/ui_v2/js/filters.js` | 新 70,29 | 改 | ✅ | /** |
| 143 | `public/ui_v2/js/filters.js` | 新 122,8 | 改 | ✅ | // \`edge='end'\` 交的是**次日 00:00**，同样走日历运算（跨夏令时的那一天不是 24 小时） |
| 144 | `public/ui_v2/js/format.js` | 新 21,9 | 改 | ✅ | // 取整：调用方传进来的常常是浮点积（\`MB × 1024 × 1024\`），不取整会写出 |
| 145 | `public/ui_v2/js/format.js` | 新 59,20 | 改 | ✅ | // 未来时间戳不是臆想：官方客户端所在机器的时钟偏快时，服务端就存下未来时间戳 |
| 146 | `public/ui_v2/js/format.js` | 新 119,44 | 增 | ✅ | /** |
| 147 | `public/ui_v2/js/format.js` | 新 186,20 | 改 | ✅ | /** 把毫秒差说成「本机时钟快 / 慢 N 分钟」——时钟差用它。\`null\` 表示无法判定。 |
| 148 | `public/ui_v2/js/login.js` | 新 5,17 | 增 | ✅ | // ===== 文档级幂等守卫（2026-09-18 补）===== |
| 149 | `public/ui_v2/js/login.js` | 新 23,6 | 删 | ✅ | - passwordToggle.addEventListener('click', () => { |
| 150 | `public/ui_v2/js/login.js` | 新 57,8 | 改 | ✅ | // 提交处理：写成具名函数，才能在下面的守卫里按需接线（见顶部的 \`DUPLICATE_EVAL\`）。 |
| 151 | `public/ui_v2/js/login.js` | 新 79,7 | 改 | ✅ | const next = resolveNext(new URLSearchParams(location.search).get('next'), location.ori… |
| 152 | `public/ui_v2/js/login.js` | 新 87,37 | 改 | ✅ | } |
| 153 | `public/ui_v2/js/messages.js` | 新 9,14 | 改 | ✅ | import { typeLabel, truncateText } from './format.js'; |
| 154 | `public/ui_v2/js/next-target.js` | 新 1,36 | 增 | ✅ | // 登录后「下一跳」的判定（纯函数，无 DOM、无网络 —— 因此可以被测试直接覆盖）。 |
| 155 | `public/ui_v2/js/push.js` | 新 19,16 | 改 | ✅ | // 连续失败到这一次数就**停下快速重连**（不是永久放弃）。动机：环境若根本不支持 WebSocket |
| 156 | `public/ui_v2/js/push.js` | 新 60,7 | 增 | ✅ | let cooldownTimer = 0; |
| 157 | `public/ui_v2/js/push.js` | 新 80,23 | 改 | ✅ | clearTimeout(cooldownTimer); |
| 158 | `public/ui_v2/js/push.js` | 新 112,12 | 改 | ✅ | // \`pending\` 那一支：\`stop()\` 已把 socket 置空、而新一次 start() 正在取票据，旧连接的 close |
| 159 | `public/ui_v2/js/push.js` | 新 190,11 | 增 | ✅ | // 退避也要归零：连断几次后切走再切回来，第一次重连不该还等在上次的 60 秒上限上 |
| 160 | `public/ui_v2/js/spark.js` | 新 28,7 | 改 | ✅ | // 柱宽 = 扣掉柱间间距后的宽度 / 根数；间距固定 2px（不随根数缩放）。 |
| 161 | `public/ui_v2/js/theme-init.js` | 新 5,15 | 改 | ✅ | // 3. 不读 \`getComputedStyle\`（V1 的写法）：本文件与 \`theme.js\` 都用**显式映射**， |
| 162 | `public/ui_v2/js/theme.js` | 新 6,11 | 改 | ✅ | // 与 \`tokens-v2.css\` 的 \`--bg\` 一致。原注释给的理由是「切换后 \`getComputedStyle\` 会立即返回 |
| 163 | `public/ui_v2/js/ui/appbar.js` | 新 10,14 | 改 | ✅ | * onFocusSearch: () => void, onRefresh: () => void }} handlers |
| 164 | `public/ui_v2/js/ui/appbar.js` | 新 26,23 | 改 | ✅ | // 同步状态：点 + 文案。\`data-state\` 是**视觉**的唯一判据（见 shell-v2.css）。 |
| 165 | `public/ui_v2/js/ui/appbar.js` | 新 55,13 | 增 | ✅ | // 刷新入口**也只在窄屏出现**（2026-09-18 补）：宽屏它留在筛选条里（那里离列表更近）， |
| 166 | `public/ui_v2/js/ui/appbar.js` | 新 69,7 | 增 | ✅ | refreshBtn, |
| 167 | `public/ui_v2/js/ui/appbar.js` | 新 89,13 | 改 | ✅ | // 没有 \`offline\` 这一档：轮询**一直在跑**，所以通道断着时用户能看到的事实就是"定时检查中" |
| 168 | `public/ui_v2/js/ui/appbar.js` | 新 111,7 | 改 | ✅ | // 「开发测试版」是**常驻**标记（2026-09-18 定位调整：默认界面变成 V1 \`public/ui_v1/\`， |
| 169 | `public/ui_v2/js/ui/appbar.js` | 新 131,21 | 改 | ✅ | // \`data-state\` 只有三档可达（色相定义见 \`shell-v2.css\`）： |
| 170 | `public/ui_v2/js/ui/board.js` | 新 27,17 | 改 | ⚑ | // 这里的 \`role\` 全是**显式写出隐式语义**，一个都不改变表格模式下的行为。 |
| 171 | `public/ui_v2/js/ui/board.js` | 新 94,9 | 改 | ✅ | el('th', { class: \`board__head-cell ${className}\`, scope: 'col', role: 'columnheader' }… |
| 172 | `public/ui_v2/js/ui/board.js` | 新 116,7 | 改 | ✅ | 'aria-label': '全选（本页全部记录）', |
| 173 | `public/ui_v2/js/ui/board.js` | 新 249,8 | 改 | ✅ | row = el('tr', { class: 'daymark', dataset: { group: group.key }, role: 'row' }, [ |
| 174 | `public/ui_v2/js/ui/board.js` | 新 287,18 | 改 | ✅ | // 三档而不是两档（2026-09-18 修）：\`loading\` 之外还有 **\`error\`**，而失败时条数是**未知**的 —— |
| 175 | `public/ui_v2/js/ui/board.js` | 新 307,9 | 增 | ✅ | // 行高等式（2026-09-19 修，审计 §10.1）：真实行 = calc(var(--row-h) + var(--sp-3) + 1px)， |
| 176 | `public/ui_v2/js/ui/board.js` | 新 547,20 | 改 | ✅ | /** |
| 177 | `public/ui_v2/js/ui/dialog.js` | 新 18,13 | 改 | ✅ | * closeLabel?: string, onClose?: () => void, canClose?: () => boolean }} spec |
| 178 | `public/ui_v2/js/ui/dialog.js` | 新 40,11 | 改 | ✅ | // 走同一条守卫：在途时这个 ✕ 不算"取消" |
| 179 | `public/ui_v2/js/ui/dialog.js` | 新 70,9 | 增 | ✅ | // 在途时不许从旁边溜走：结算成 \`null/false\` 会让调用方以为"用户取消了"， |
| 180 | `public/ui_v2/js/ui/dialog.js` | 新 99,57 | 增 | ✅ | // 平台给的 Esc：\`cancel\` 事件是**可取消的**，在途时必须挡在这里 —— |
| 181 | `public/ui_v2/js/ui/dialog.js` | 新 202,9 | 增 | ✅ | // 在途时不许从旁边溜走：结算成 \`null/false\` 会让调用方以为"用户取消了"， |
| 182 | `public/ui_v2/js/ui/dialog.js` | 新 223,15 | 增 | ✅ | // 「有请求在飞」的旗子：\`setPending(confirm, true)\` 只 disable 了**确认键**， |
| 183 | `public/ui_v2/js/ui/dialog.js` | 新 252,19 | 改 | ✅ | // **整个在途期间把"取消"那三条路也关掉**（2026-09-18 修）：它们此前仍然可用， |
| 184 | `public/ui_v2/js/ui/dialog.js` | 新 278,7 | 改 | ✅ | * action?: () => Promise<unknown> }} spec |
| 185 | `public/ui_v2/js/ui/drawer.js` | 新 10,7 | 改 | ✅ | import { formatAbsolute, describeClockSkew, typeLabel } from '../format.js'; |
| 186 | `public/ui_v2/js/ui/drawer.js` | 新 123,15 | 增 | ✅ | // 渲染时记下两件"这一栏的当前状态"，保存路径要用： |
| 187 | `public/ui_v2/js/ui/drawer.js` | 新 175,28 | 改 | ⚑ | retentionSource.textContent = \`${label}只能填 0–${max} 之间的整数；空值的意思见下方说明。\`; |
| 188 | `public/ui_v2/js/ui/drawer.js` | 新 295,30 | 改 | ✅ | /** |
| 189 | `public/ui_v2/js/ui/drawer.js` | 新 326,40 | 改 | ✅ | text: !loaded |
| 190 | `public/ui_v2/js/ui/drawer.js` | 新 367,7 | 增 | ✅ | dataset: dominant ? { kind: dominant.kind } : {}, |
| 191 | `public/ui_v2/js/ui/drawer.js` | 新 390,8 | 改 | ✅ | setInputValue(afterInput, toDateInput(filters.after)); |
| 192 | `public/ui_v2/js/ui/drawer.js` | 新 399,72 | 改 | ✅ | // 分钟 → 天。两件事都在这里定： |
| 193 | `public/ui_v2/js/ui/drawer.js` | 新 603,3 | 删 | ✅ | - function round(value, digits) { |
| 194 | `public/ui_v2/js/ui/filters.js` | 新 4,7 | 改 | ✅ | // ③ 顶栏：搜索、刷新（两者都**只在窄屏**，宽屏有各自的常驻控件）、主题、登出 |
| 195 | `public/ui_v2/js/ui/filters.js` | 新 90,11 | 改 | ⚑ | // 直接把处理器挂上去会让**浏览器传进来的 MouseEvent** 被当选项对象解构（那是隐患）。 |
| 196 | `public/ui_v2/js/ui/ghost.js` | 新 3,19 | 改 | ✅ | // ⚠️ 行数必须**尽量接近真实页大小**（2026-09-16 实测）：骨架行高与真实行同高（2026-09-19 起由 \`board-v2.css\` 真正保证 |
| 197 | `public/ui_v2/js/ui/menu.js` | 新 50,10 | 改 | ✅ | // 开态**只由原生 \`hidden\` 表达**（配 CSS 的 \`.menu[hidden]\` 与 \`.menu-backdrop[hidden]\`）。 |
| 198 | `public/ui_v2/js/ui/overview.js` | 新 30,11 | 改 | ✅ | // 标签写「活跃记录」：这个数字是 \`boot.js\` 传下来的 \`stats.activeCount\`（**活跃**口径， |
| 199 | `public/ui_v2/js/ui/overview.js` | 新 84,15 | 改 | ✅ | * 为什么不是一个破折号「—」：不确定的时候给一条淡色的小骨架条，它同时表达了"这里将会有一个 |
| 200 | `public/ui_v2/js/ui/overview.js` | 新 102,20 | 改 | ✅ | // |
| 201 | `public/ui_v2/js/ui/pager.js` | 新 34,7 | 改 | ✅ | 'aria-label': '跳至页码', |
| 202 | `public/ui_v2/js/ui/pager.js` | 新 69,23 | 改 | ⚑ | update({ page, pageSize, total, loading = false }) { |
| 203 | `public/ui_v2/js/ui/row.js` | 新 7,7 | 改 | ✅ | import { typeLabel, formatSize, formatRelative, formatAbsolute, previewText, previewIsE… |
| 204 | `public/ui_v2/js/ui/row.js` | 新 66,18 | 改 | ✅ | // \`role\` = 显式写出隐式语义：≤720px 时这些单元格的 \`display\` 变成 block/grid， |
| 205 | `public/ui_v2/js/ui/row.js` | 新 130,13 | 改 | ✅ | // \`data-empty\` 是 CSS 的空占位判据。用字面属性名而不是 \`dataset\` 对象：\`dataset\` 里值为 null |
| 206 | `public/ui_v2/js/ui/row.js` | 新 144,7 | 改 | ✅ | 'aria-label': \`预览${typeLabel(item.type)}：${truncateText(text, 80)}\`, |
| 207 | `public/ui_v2/js/ui/row.js` | 新 186,13 | 改 | ✅ | // 与**分组标题同一个字段**（\`createTime\`，2026-09-18 修）。 |
| 208 | `public/ui_v2/manifest.webmanifest` | 新 4,14 | 改 | ✅ | "start_url": "/ui_v2/app/", |

---

## 4. 核实中发现的问题与修复（12 条：F-1…F-9、F-11 是查出的问题；F-10、F-12 是对本节自己的勘误）

§4 分两类：**在 diff 内**（这条错误文本就是本轮提交新写/改写的，属"这一串提交自己引入"）
与 **diff 外**（错在更早就存在，是审到这两个文件时顺带发现的）。两类都在本轮修掉了；
区别只在于"该由谁负责"，故逐条标明。

| 编号 | 类型 | 在 diff 内？ | 位置 | 一句话 |
|---|---|---|---|---|
| F-1 | 行号引用腐烂 | ✅ 是 | `public/ui_v2/js/ui/filters.js` | 注释指向 V1 `main.js:222`，该行不是那个处理器 |
| F-2 | 行号引用腐烂 | ✅ 是 | `public/ui_v2/js/boot.js` | 注释指向 V1 `main.js:538-544`，那段不含所声称的内容 |
| F-3 | 行号引用腐烂 | ✅ 是 | `public/ui_v2/js/ui/drawer.js` | 注释指向 `src/ui/maintenance.ts:102`，该行是 `checkedAt` |
| F-4 | 行号引用腐烂 | ❌ 否（早于基线） | `public/ui_v1/js/main.js` | 注释自指 `:371`，该行是 `return;`（守卫在 `:439`） |
| F-5 | 数字没复算 | ✅ 是 | `public/ui_v2/css/tokens-v2.css` | "V1 有 7 处 coarse 分支" —— 实测 4 个媒体块 / 14 条 `var(--hit-min)` 声明 |
| F-6 | 因果链讲反 | ⚠️ 半（第二处在 diff 内） | `public/ui_v1/js/components/info.js` ×2 | 声称"**有快照**的调用方会在失败时 `open(null)`"，而那条路挂在 `if (!cached)` 上 |
| F-7 | 指代不实 | ✅ 是 | `public/ui_v1/css/components.css` | 骨架等式里的行间距说是 `var(--sp-1)`，实为字面量 `4px` |
| F-8 | **真缺陷** | ✅ 是 | `ui_v1/js/main.js` + `components/{list,pagination}.js` | 首屏失败时列表说"加载失败"、分页还说"正在加载…" |
| F-9 | **两版不同答** | ✅ 是 | `ui_v2/js/boot.js` + `ui/pager.js` | V1 补了失败档，V2 的 pager 没有 ⇒ 两版对"是不是失败态"不同答 |
| F-10 | **本节自审勘误** | — | 本文件 §4 | F-4 / F-5 / F-6 三处第一稿量错或说过头，已改正（见 §4 末） |
| F-11 | **交叉引用指错文档** | ✅ 是 | `ui_v2/css/board-v2.css`、`ui_v2/css/tokens-v2.css`、`ui_v2/js/ui/board.js` | 三处写「`AUDIT-missing-states.md` §6.1/6.2/6.3」，而该文档 §6 没有子节；§6.x 实属 `docs/archive/AUDIT-v1-v2-divergence.md` |
| F-12 | **本节自审勘误（二）** | ✅ 是 | `public/ui_v2/css/tokens-v2.css` | F-5 改成「`var(--hit-min)` 声明共 14 条」后**边界未写明**：全文件实数 15 条 |

### F-1 行号引用腐烂：V2 `ui/filters.js` 指向 V1 `main.js:222`

- **原文**：`与 V1 `main.js:222` 的同名处理器一致`
- **核实**：`ui_v1/js/main.js` 第 222 行**不是** `onClearFilters`（改名后整体位移，那一行是别的东西）。
  真正同源的处理器是 `onClearFilters`，其可检索特征是 `setFilters({ ...DEFAULT_FILTERS }, …)`。
- **修法**：去掉行号，改指函数名 + 语句特征。**理由**：行号会被下一次改动再弄坏，标识符不会。

### F-2 行号引用腐烂：V2 `boot.js` 指向 V1 `main.js:538-544`

- **原文**：`V1 `main.js:538-544` 同源`
- **核实**：那一区间讲的是 `store.items`，**不含**"选择集同步"这件事。对应段落在 `toggleFlag` 里。
- **修法**：去掉行号，改成"在 `ui_v1/js/main.js` 的 `toggleFlag` 里（\"这一行如果在选择集里…\"那一段）"。

### F-3 行号引用腐烂：V2 `ui/drawer.js` 指向 `src/ui/maintenance.ts:102`

- **原文**：`（`src/ui/maintenance.ts:102`）`
- **核实**：第 102 行落在**另一个端点**的响应体里 —— 那是 `GET` 清理状态返回的 `checkedAt`。
  "缺省字段 = 不改动"那段注释在 **:111-112**，紧挨着 `app.put('/ui/api/settings', …)`（**:113**）。
- **修法**：改指 `PUT /ui/api/settings` 那段注释（可 grep 的锚点，且不会因行数变动而失效）。

### F-4 行号引用腐烂：V1 `main.js` 自指 `:371`

- **原文**：`（同一类缺陷 refreshStats 在 `:371` 有显式守卫）`
- **核实**：`:371` 只是 `return;`（某个早退分支的尾巴），不是守卫。真正的守卫在 **:439**：
  `if (view !== store.get().filters.deleted) return;`。
- **修法**：把守卫语句**原样写进注释**，去掉行号。

### F-5 数字与代码不符：V2 `tokens-v2.css`「V1 有 7 处 coarse 分支」

- **原文**：`V1 有 7 处 coarse 分支逐控件抬到 44px`
- **核实**（两条都可机械复算）：
  - `public/ui_v1/css/components.css` 里 `@media (pointer: coarse)` 的**媒体块共 4 个**
    （`:583`、`:1033`（与 `max-width:720px` 合并）、`:1672`、`:1950`（与 `max-width:860px` 合并））；
  - 这些块里**用 `var(--hit-min)` 的声明共 14 条**，分布在 10 组选择器上：
    `.btn`/`.input`/`.select`（共用一条）、`.status`×2、`.icon-btn`×2、`.segmented__item`、
    `.check-wrap`×2、`.row-actions__slot`×2、`.th-sort`、`.search__clear`×2、
    页脚的 `.footer-links__item`；另有 `.skeleton__row` 的 `height: calc(… + var(--hit-min))` 用到它，
    但那是骨架行高、不是命中区。
  - **"7" 与两者都不符**：全文含 `pointer: coarse` 的**行**恰好 7 行，其中 3 行是注释
    —— 所以这个 7 是"字符串出现的行数"，不是块数、也不是控件数。
- **修法**：把数字换成可复算的两个（4 个媒体块 / 14 条 `var(--hit-min)` 声明）并列出覆盖范围。
  **注意这 14 条是"用 `var(--hit-min)` 的声明"，不是"`--hit-min` 自己的声明"**（它的声明在 `css/tokens.css`）
  —— 措辞上分得清，才是可复算的。

### F-6 因果链讲反：V1 `components/info.js` 两处「刷新失败时再 `open(null)` 覆盖它」

- **原文**（两处）：`已经有快照的调用方会先开壳、再在刷新失败时用 open(null) 覆盖它`
  / `有快照的调用方会先 open(fresh)，刷新失败时再 open(null) 覆盖它`
- **核实**：`main.js` 的 `openInfo`（**:1088**）里 `open(null)` **确实存在**，但它在 `if (!cached)` 上
  （**:1107**）—— 也就是说 **只有"一条快照都没有"时才走它**；**有快照时失败什么都不做**
  （`:1094` 已经把壳开在那儿，`:1104` 的 `catch` 在 `cached` 为真时不调 `open`）。
  真实的两条路是：
  - 有快照 —— `open(cached)`（:1094）→ `open(fresh)`（:1103）；
  - 无快照 —— 失败时 `open(null)`（:1107）；用户点「重试」(`onRetry: () => openInfo()`) 会原样再走一遍。
  **结论（`if (!dialog.open) dialog.showModal()`）是对的**，被讲错的是"第二次为什么发生"：
  原注释把两条路搅成一条，还说成"有快照的调用方"会走 `open(null)` —— 与 `if (!cached)` 正好相反。
- **修法**：把两条路分开写清。（第一轮只写了 `cached → fresh` 那条，**漏掉了真实存在的 `open(null)` 那条**，
  第二轮补上 —— 这条勘误记在台账 §4 末尾。）

### F-7 指代不实：V1 `components.css` 卡片骨架注释里的 `row-gap` 来源

- **原文**：`+ `var(--sp-1)`    它的 row-gap（卡内「内容行」与「操作行」之间）`
- **核实**：`tr.row` 那条规则里写的是**字面量** `gap: 4px var(--sp-2)`，
  与 `--sp-1` **同值但不同源**。注释把它说成 `var(--sp-1)` 会让人以为改令牌就能牵动行高
  （而这条等式是骨架行高与真实行高对齐的依据，牵动不得）。
- **修法**：如实写"是字面量、与 `--sp-1` 同值不同源"，并指向本段末尾那条约定。

### F-8 V1：首屏失败时列表与分页自相矛盾（**真缺陷**）

- **现象**：`refresh()` 失败时把 `loading` 收掉、调 `list.showError()` 画出「加载失败 + 重试」，
  但**不调** `render()`（那会让 `list.update()` 把错误态换成空状态）。于是分页那一格
  永远停在加载档写下的「正在加载…」——**同一屏上，上面说"加载失败"、下面说"正在加载"**。
- **第二处**：失败之后，用户点任一筛选 chip（`setFilters` 会先 `render()` 一次再发请求）
  会把「加载失败 + 重试」整块换成「还没有任何记录」。**条数明明未知，界面却给了确定结论，
  而且把唯一的重试入口抹掉了。**
- **谱系**（这一条不是新问题，是同一族缺陷的**第三例**）：`docs/AUDIT-missing-states.md` §1.1 修的是
  分页的**加载档**（首屏那帧写「没有可显示的记录」）、§1.2 修的是**头栏**在失败时仍写「正在加载…」，
  `docs/progress.md` §85.6 把教训写成了「给一个组件补状态档时，要同时检查这个组件的**每一处出口**」。
  本轮发现的是**同一族的第三处出口**：分页**范围文本**在失败时既没被改成加载档、也没被改成空档，
  而是**根本没有被重绘**。`AGENTS.md` §1 里那条关于"过一遍每一处出口"的警告，说的正是这件事。
- **修法**（本轮的实现）：
  1. `store` 增加 `error` 字段（`main.js`）：成功清空、失败写入 `describeListError` 的结果；
  2. 抽出 `renderPagination()` —— 分页那一格的**唯一**绘制点，`render()` 与失败路径共用；
  3. `list.update()` 增加"失败且无数据 ⇒ 保持错误态"的出口；
  4. `components/pagination.js` 增加 `unknown` 档：**什么都不说**（加载档与空档那两句都不成立）。
- **判据对齐**：V1 的 `list.update` 用 `state.error && items.length === 0`，
  **正是** V2 `boot.js` 的 `boardState()` 那一条——两版对"现在是不是失败态"必须同答。

### F-9 V2 的同一处：pager 也要有失败档（**改一版必须问另一版**）

- **核实**：V2 `ui/pager.js` 与 V1 `components/pagination.js` 是同一件事的两份实现。
  V1 补了失败档而 V2 不补，等于把"两版同答"这条约定亲手破掉。
- **修法**：`pager.update` 同样接 `error`，同样出 `unknown` 档；
  两个调用点（`boot.js` 两处）分别传 `boardState(current) === 'error'`——
  **判据与列表共用同一个函数**，而不是各写一份`state.error` 的判据。

### F-10 对 §4 自己三处断言的勘误（本轮自查，2026-09-20 补）

`docs/AUDIT-missing-states.md` §6 那条"**审计员的话本身也是一个需要被验证的断言**"同样适用于本节。
本轮写完 §4 之后，把 §4 里每一条**可量的事实**再量了一遍，三处要改：

| 位置 | 第一稿写的 | 实测 | 处置 |
|---|---|---|---|
| F-4 | "`:371` 是 `render();`" | `:371` 是 `return;`；守卫在 **:439** | 已改正 |
| F-5 | "`--hit-min` 声明共 14 条"；"7 处是估的" | 14 = 用 `var(--hit-min)` 的**声明条数**（`--hit-min` 自己的声明在 `tokens.css`）；而 **7 = 全文里含 `pointer: coarse` 的「行」数**（其中 3 行是注释），媒体块实为 **4** 个 | 已改正 + 已把注释改成可复算的两个数 |
| F-6 | "调用方**没有** `open(null)` 这条路径" | **说过头了**：`open(null)` 在 `:1107`，只是挂在 `if (!cached)` 上 | 已改正；第一轮的替换因此漏掉这条路，第二轮把它补回注释 |

**教训**：F-6 这条尤其值得记 —— 第一轮的判定方向是对的（原注释确实说反了），
但**力度用过了**（"没有这条路径"vs"只有无快照时才走这条路"）。
判定写得比证据更硬，会让下一个照它去改的人**删掉一段其实有用的代码**。
写"缺陷"时，措辞要正好停在证据允许的位置。

### F-11 交叉引用指错文档：三处 `§6.x` 挂在 `AUDIT-missing-states.md` 上

**查出的方式**：不是读代码读出来的，是把 208 个 hunk 里的 `docs/*.md` + `§N` 全抽出来落盘核对
（`.audits/_docrefs.mjs`）。66 处里 63 处命中，3 处未命中，且未命中的三处**指向的是同一个错**：

| 引用位置 | 注释里写的 | 该文档里实际有什么 |
|---|---|---|
| `public/ui_v2/css/board-v2.css:747` | `docs/AUDIT-missing-states.md` §6.1 | 该文档 §6 是「复核中**剔除**的结论」，**且全文没有 §6.x** |
| `public/ui_v2/css/tokens-v2.css:292` | 同上 §6.2 | 同上 |
| `public/ui_v2/js/ui/board.js:35` | 同上 §6.3 | 同上 |

而这三个章号**确实存在**，只是在另一份文档里 —— `docs/archive/AUDIT-v1-v2-divergence.md` §6「无障碍实质（确认）」：

- **§6.1**「≤720px 下，列表头被"视觉隐藏但仍在无障碍树里" ⇒ 键盘 Tab 会落进一个看不见的按钮」
  —— 正是 `board-v2.css` 那条 `.board__head-row .sort-btn { visibility: hidden }`；
- **§6.2**「触屏命中区只有部分控件达标」—— 正是 `tokens-v2.css` 那条 coarse 块；
- **§6.3**「≤720px 的表格丢了行列语义」—— 正是 `board.js` 那条 `role`。

**决定性旁证**：divergence §12 的实施记录表里，两条记录的**第一格就写着**「`§6.1` ≤720 列表头里那个…」
与「`§6.2` 触屏命中区只有 3 个控件达标」，**落点正是 `ui/css/board-v2.css` 与 `ui/css/tokens-v2.css`**
—— 与出问题的那两个文件的引用一一对应。所以"配错对"是确定的，不是猜的。

**引入提交**：三处全部由 `e3858cd`（三个界面挂载点改名那笔）引入 —— `git log -S` 三查三中。
**处置**：三处文档名改成 `docs/archive/AUDIT-v1-v2-divergence.md`，章号不动。

**这类缺陷为什么值得单列**：它比行号腐烂（F-1…F-4）更隐蔽 ——
行号腐烂时"内容对不上"，读者一眼能看出；而这里**文档名对、章号对、内容也对**，
只有"配错了对"。顺着它去翻的人会翻到一份讲别的事的文档，
然后**合理地**把结论读反（例如把"已剔除的结论"当成"已确认的缺陷"）。

### F-12 自审勘误（二）：F-5 改后的数字边界没写明

F-5 把注释从"V1 有 7 处 coarse 分支"改成"媒体块共 4 个，用 `var(--hit-min)` 的声明共 14 条"。
本轮把这两个数**又机械量了一遍**（`.audits/_v1coarse.mjs`）：

- 含 `pointer: coarse` 的 `@media` 块 = **4** ✅（第一版按 `@media (pointer: coarse)` 精确匹配只数出 2，
  漏了 `(max-width: 720px), (pointer: coarse)` 与 `and (pointer: coarse)` 两种组合写法）
- 用 `var(--hit-min)` 的声明 = **15**，不是 14。

差的那一条是 `components.css:1952` 的 `.skeleton__row` 的高度 `calc(… + var(--hit-min))` ——
它是骨架行的**高度**，不是命中区。⇒「14 条」**成立**，但**边界必须写出来**，
否则读者一数就是 15，然后会合理地怀疑整段注释。已改成：

> 用 `var(--hit-min)` 的声明共 15 条 —— 14 条是**命中区**（…），第 15 条是
> `.skeleton__row` 的**高度**（粗指针卡片档），不是命中区。

**教训（与 F-10 同源，方向相反）**：F-10 是"力度用过了"，这一条是**精度不够**——
两个数都对，但没写清"哪个范围里的 14"。**只要一个数字需要读者自己去猜它的边界，它就已经错了。**

---

## 5. 复核结论

1. **改名本身是干净的**：所有 `R100` 文件正文逐字未动；`R*` 的非 100 项改的都是**文件头注释**
   （解释"这一份为什么在这里"）与路径字符串，没有顺手改逻辑。
2. **注释改写总体质量高于代码**：本轮 22 笔里大量精力花在把"为什么这样写"补进注释，
   方向是对的；问题集中在三种：
   - **行号引用会腐烂**（F-1…F-4）：改名把行号整体挪了位，而注释里的 `文件:行` 只改了文件名没改行号，
     或改了行号但指向的那一行已经不是原来那段代码。**这是本轮最成体系的缺陷**——
     故本轮的修法一律是**去掉会腐烂的行号**，改成指向**可检索的标识符/语句**（`函数名`、那条 `if`）。
   - **数字没人复算**（F-5）："V1 有 7 处 coarse 分支"是估的，实际用 `var(--hit-min)` 的声明 **15** 条，其中 14 条是命中区（差的那条是骨架行**高度**，见 F-12）。
   - **因果链讲反**（F-6）：把"调用方会 `open(cached)` → `open(fresh)`"错记成"刷新失败时 `open(null)`"——
     调用方根本没有这条路径，读者照它去改会改坏。
   - **交叉引用指错文档**（F-11）：三处把 `§6.1/6.2/6.3` 挂在 `AUDIT-missing-states.md` 上，
     而那三个章号属于 `docs/archive/AUDIT-v1-v2-divergence.md`。
     **比行号腐烂更隐蔽**：文档名、章号、内容三样各自都对，只有"配错了对"——
     顺着它去翻的人会翻到一份讲别的事的文档，然后**合理地**把结论读反。
3. **一处真缺陷**（F-8）：V1 首屏失败时，分页永远停在「正在加载…」，与正下方的「加载失败」自相矛盾；
   且失败后任何一次重绘都会把错误态刷成「还没有任何记录」（条数未知却给出确定结论，并抹掉重试入口）。
   V2 有对应的 `boardState()` 判据，V1 没有——**这是两版对"现在是不是失败态"给出不同答案**。
4. **两版同步已处理**（F-9）：pager / pagination 的失败档同时落在 V1 与 V2，
   判据分别接到 `renderPagination` 与 `boardState()`，保证两版同答。
5. **本节自己也过了一遍复核**（F-10）：`docs/AUDIT-missing-states.md` §6 那条
   "审计员的话本身也是一个需要被验证的断言"适用于本文档 —— 三处第一稿的断言（F-4 的行号内容、
   F-5 的数字口径、F-6 的"没有这条路"）在自查中被改正；其中 F-6 是**力度用过了**，
   比"没查到"更危险（照它去改会删掉一段有用的代码）。

## 6. 未决 / 留给下一轮

- **F-1 提到的语义不一致仍未定论**：V2 清空筛选与空状态里的「清除筛选」对 `keepView` 取值相反
  （前者回活跃列表、后者留在回收站）。本轮只修了**指向错的注释**，没有改行为——
  要统一需要先定"哪种才是对的"，属产品决策（`docs/AUDIT-commit-9b4cdca.md` §P2 记的就是这件事）。
- **`.audits/` 下的脚本与 diff 未进版本库**：它们是本轮的证据链，若需要复算请保留。
- **门禁未跑**：本轮按用户要求不跑测试。落地后需要补跑：
  `tsc --noEmit`、`eslint public/ui_v2/js public/ui_v1/js`、22 套件、以及 V1/V2 的真实浏览器探针。

---

## 7. 事实复核台账（数值 / 推导 / 交叉引用）

§1 第 2 步只证明了「**每一行都落在 HEAD 上**」（逐字一致），**不等于「注释里说的话是真的」**。
本节把 208 个 hunk 里的**可量断言**全抽出来机械复算，逐条给判据。
脚本都在 `.audits/`，输出同名 `.txt`（未进版本库）。

### 7.1 覆盖率对账（先证明「一处没漏」）

三个互相独立的 git 口径比对，**全部相等**：

| 口径 | 结果 |
|---|---|
| `git diff --shortstat 6ebcf6e..HEAD -- public/` | 90 files changed, **+1706 / −773** |
| `git diff --numstat` 逐文件累加 | **+1706 / −773** |
| 本文档台账（§2 的 90 项 + §3 的 208 个 hunk） | 57 个有 hunk 的文件 = **+1706 / −773** |

差额恰好是两类**结构上不可能有 hunk**的项：**33 条 `similarity index 100%`**（这是 `git diff`
里可以直接数出来的口径），其中 **4 个二进制 PNG**（`--numstat` 记为 `-`、不记行数），
余 **29 个是正文逐字未动的文本改名**（`--numstat` 记 `0/0`）。**57 + 29 + 4 = 90** ⇒ 覆盖 **100%**。

> ⚠️ **措辞边界（2026-09-20 独立复核时订正）**：这里原来写的是"**29 个 `R100` 纯改名**"——
> 而 `similarity index 100%` 在 diff 里**是 33 条**（那 4 个 PNG 同样被 git 记为 100%）。
> 数字与三类划分都没变，**错的只是标签的边界**："R100"对其中 29 条成立，对全部 33 条也成立，
> 于是读者一数是 33、与"29 个 R100"对不上。与 F-12 是同一条教训：**数字要连范围一起写。**

（脚本 `.audits/_coverage2.mjs`。第一版两处写错过：没展开 `{old => new}` 的改名语法 ⇒ 误报 33 个"缺文件"；
`+++ /dev/null` 时把 key 清掉 ⇒ 丢掉 169 行。两处都是脚本的错，不是 diff 的错。）

### 7.2 站内引用（一）：文档与章节号

新增注释引用了 **10 份 `docs/*.md`，全部存在**；
**66 处 `§N` 章节引用，63 处命中，3 处未命中 ⇒ F-11**。

（脚本 `.audits/_docrefs.mjs`。它必须同时接受四种写法：`§N`、`## N.`、`| N |`、
以及**粗体条目** `- **N.M …**` —— 本仓库的审计文档习惯把子节写成粗体条目
（如 divergence 的 §3.3 / §7.2），只按标题匹配会误报。）

### 7.3 站内引用（二）：资源路径与 `modulepreload`

- 新增行里出现 **85 个 `/ui*` 站内路径**，**83 个在 `public/` 下落盘存在**。余下 2 个是
  `/ui_v1/login` 与 `/ui_v2/app/login` —— 它们是**路由**不是文件（`login.html` 由 worker 送），
  `next-target.js` 做规范路径比较正是要用字符串本身。**正常，不是缺陷。**
- V2 `app/index.html` 的 **32 条 `modulepreload`**：指向不存在文件的 **0** 条。
- 更强的一条：**把静态 `import` 闭包算出来，与预载清单做对称差**。
  `boot.js` 闭包 **33** 个模块 vs 预载 **32** 条，差的唯一一个是**入口 `boot.js` 自己**
  （`<script type="module" src>` 加载，本就不该预载）；`login.html` 是 5 vs 4，同理。
  ⇒ **0 条依赖瀑布、0 条白拉文件**，AGENTS.md §1 那条"少一项 / 多一项都不报错"的规则机械通过。

（脚本 `.audits/_preload.mjs`。它**必须允许跨行 `import`**：本仓大量 `} from './x.js';` 收尾的
多行导入块，第一版正则按"不许跨行"写，把 `messages.js` 误报成"白拉的文件"。）

### 7.4 站内引用（三）：`文件:行`

从 208 个 hunk 里抽到 **5 处** `文件:行` 形式的引用（其余同类已在上一轮改成指向标识符）：
**5 处全部有效**（文件存在、行号在范围内）——
`ui/overview.js:63`、`main.js:538-544`、`signalr.js:117`、`src/ui/maintenance.ts:102`、`main.js:222`。

> ⚠️ **这一项只判"文件在不在、行号越没越界"，不判"那一行是不是讲的这件事"。**
> 后者正是 F-1…F-4 暴露的问题，靠人工逐条读出来。
> （脚本 `.audits/_claims.mjs`；它另外核了 469 个反引号标识符，唯一的"缺失"
> 是 `0c0a49d` 这个提交哈希被正则切成了 `c0a49d` —— 噪声。）

**落地之后的实数（2026-09-20 独立复核时补）**：上面这张表列的是**改动前**抽出来的 5 处，
其中 3 处 —— `main.js:538-544`、`src/ui/maintenance.ts:102`、`main.js:222` —— 正是 §4 的
F-1 / F-2 / F-3 **判定为腐烂并换成标识符锚**的那三条。换完之后 `public/**` 里只剩 **2 处**
`文件:行`，本轮**逐行读过、内容与之相符**（不是"只没越界"）：

| 现存引用 | 所在处 | 指向的那一行实际是什么 |
|---|---|---|
| `ui/overview.js:63` | `ui_v2/css/shell-v2.css` | `// 类型分布**已从这里移除**（2026-09-15 第二轮）。` ✅ 正是它被引用的那件事 |
| `signalr.js:117` | `ui_v2/js/push.js` | `if (pending \|\| (socket !== null && socket !== nextSocket)) return;` ✅ 正是"V1 那一支" |

⇒ 可复算的判据：`grep -nE '[A-Za-z0-9_.-]+\.(js|ts|css|md|html):[0-9]' -r public/` 现在**只有这两条命中**。
**上面那张"5 处"的表是历史快照，别再照它去找 `main.js:222`。**

### 7.5 算术与推导

208 个 hunk 里含「等号 + 数字」的新增行共 **201 行**，但**绝大多数不是断言**
（是 `href="…"` / `src="…"` / `const X = N;` 这类代码）。真正的推导等式 **7 条**，逐条复算，
连同它们依赖的 token 一起核：

| 位置 | 注释里的等式 | 复算 | 依赖的常量（已核到行） |
|---|---|---|---|
| V1 `components.css`（表格档骨架行） | `8+8+1+30` = 47px | ✅ 47 | `.table td` `padding: 8px`（:687）+ `border-bottom: 1px`（:688）+ 行内最高的 `.icon-btn` `height: 30px`（:1044） |
| V1 `components.css`（卡片档骨架行） | `2*10 + 1 + var(--sp-1) + 48 + 30` = 103px | ✅ 103 | `tr.row` `padding: 10px`（:1861）、`border-bottom: 1px`（:1862）、`gap: 4px`（:1860，**字面量**）、`--sp-1: 4px`（tokens.css:84） |
| 同上（`48` 的拆解） | `48 = 22 + 2 + 2 + 22` | ✅ 48 | `__line` `min-height: 22px`（:931）、`__body` `gap: 2px`（:917）、`__meta` `margin-top: 2px`（:980）、**`__meta` 自身高 = 它第一个孩子 `.chip` 的 `height: 22px`（:615）** |
| 同上（粗指针） | `103 + (44 − 30)` = 117px | ✅ 117 | `--hit-min: 44px`（tokens.css:113） |
| V2 `board-v2.css`（行高等式） | `(--row-h − --sp-3) + 2×--sp-3 + 1` = `--row-h + --sp-3 + 1` | ✅ 代数恒等 | 实测 `--row-h=64 → 77`、`--row-h=52 → 65`。代回要求 `--sp-3 = 12`，与 tokens-v2.css:164 一致 ⇒ **两档自洽** |
| V2 `board-v2.css`（卡片档骨架行） | `125 = 2×12 + 2 + 2×4 + 48 + 8 + 1 + 34`；`135` = 同式但 `--control-h` 取 44 | ✅ 125 / 135 | `--sp-1/2/3 = 4/8/12`（tokens-v2.css:162-164）、`--control-h: 34px`（:184）、粗指针块 `--control-h: var(--hit-min)`（:293） |
| V2 `board-v2.css`（分组标题量级） | `50×125 + 49×8 = 6642`，实测 6683.05，差 41px | ✅ 6642 / 差 **41.05** | 差值归因于分组标题 `.daymark` + 它自己的间距 —— **归因是解释性的，未单独实测** |

**同一处的"差值"还有三条互证**（都在 `board-v2.css` 的注释里）：

| 注释里的说法 | 复算 | 结论 |
|---|---|---|
| 修前"骨架仍 64px（差 **61px**）" | 125 − 64 = **61** ✅ | 自洽 |
| 修前"每行差 **13px**、50 行满页差 **650px**" | 77 − 64 = **13** ✅；50 × 13 = **650** ✅ | 自洽 |
| 修后"每行差 **48 / 58px**" | 125 − 77 = **48** ✅；135 − 77 = **58** ✅ | 自洽 |

**一条必须写明的边界**：上表里凡标注「实测」的数字（47 / 103 / 117 / 77 / 65 / 125 / 135 /
6642 / 6683.05 / CLS 0.90 / 384 / 3930 / 804 / 4454），本轮**没有起浏览器**
（用户明确要求不跑测试/门禁）。对这些数做的是**内部自洽性核对**：
例如 77 与 65 必须要求同一个 `--sp-3`、125 与 135 只能差 `--control-h`、
`48 = 22+2+2+22` 必须落到真实存在的 CSS 值上。

**内部自洽只能证伪、不能证实。** 要证实仍需 §6 那条待补的浏览器探针。
这一条与 `docs/AUDIT-missing-states.md` §8 的口径一致（那里也把"需真实渲染"的项单列）。

### 7.6 与 V1/V2 两版判据有关的一条（F-8/F-9 的验收口径）

F-8/F-9 修的是"**两版对『现在是不是失败态』必须同答**"。本轮只做了静态核对：
V2 的判据是 `boot.js` 的 `boardState()`，V1 的判据是 `main.js` 的 `store.error`
加 `components/list.js` 的 `error && items.length === 0`。
**两句是否真的同答，要跑两版的浏览器探针才能定** —— 记在 §6。

---

## 8. 独立复核（第二轮，2026-09-20）：把上面这份台账再验一遍

`docs/AUDIT-missing-states.md` §6 那条"**审计员的话本身也是一个需要被验证的断言**"，
上一轮已经用在 §4 自己身上（F-10 / F-12）。这一轮把它用在**整份台账**上：
不跑脚本、不跑测试（用户本轮再次明令"禁止跑测试、禁止脚本"），
只做**读**——重读 diff、重读代码、重算可复算的数。

### 8.1 范围先重算（不靠上一轮的数）

| 口径 | 命令 | 本轮读数 | 台账声称 | |
|---|---|---|---|---|
| 文件数 | `git diff --shortstat 6ebcf6e..HEAD -- public/` | `90 files changed` | 90 | ✅ |
| ±行数 | 同上 | `+1706 / −773` | +1706 / −773 | ✅ |
| hunk 数 | 数 `.audits/public.diff` 里的 `@@` 行 | **208** | 208 | ✅ |
| 文件头数 | 数同一份文件里的 `diff --git` 行 | **90** | 90 | ✅ |
| diff 总行数 | 读到该文件的最后一行 | **4708** | 4708 | ✅ |

### 8.2 逐处重读的覆盖与结论

- **90 个文件里 57 个带正文改动**的那一批，本轮把 diff **整份读完**（4708 行），
  逐个 hunk 判定"这个改动合不合理"，而不是抽读；
- **17 处 `⚑`（§3 标为"已核并已修"）**逐个回到**工作区的当前代码**复核，结论：**17/17 的修法成立**。
  其中三处是"接线类"，光看 diff 看不出对不对，必须看调用方：
  - `list.js` 的 `if (state.error && items.length === 0) return;` —— 落在 `loading` 档**之后**，
    所以**不是死代码**（若放在 `if (state.loading && items.length === 0)` 之前，它会把骨架档吃掉）；
  - `main.js` 的 `renderPagination()` 是**函数声明**（提升），失败路径里在 `render()` 之外单独调它，
    与 `store.set({loading:false, error})` 同一次 tick，所以"停在与列表相反的档上"这条被真正关掉；
  - V2 的两个 `pager.update(...)` 调用点**都**补了 `error: boardState(current) === 'error'`
    （`boot.js` 里 `pager.update(` 一共就是 2 处，已数过），且 `boardState` 的判据
    （`current.error && current.items.length === 0`）与 V1 那句**逐字同义** ⇒ F-9 的"两版同答"在**静态层面**成立。
- **`⚑` 之外的 188 处**里，凡注释带**可量断言**的（数字、等式、指代、因果、交叉引用）本轮逐条回算，
  抽查到的全部成立，例如：骨架两条等式（`8+8+1+30 = 47`、`2*10+1+4+48+30 = 103`、`103+(44−30) = 117`
  与 V2 的 `24+2+8+48+8+1+34 = 125` / `135`）、`var(--hit-min)` 的 15 条声明（14 命中区 + 1 骨架行高）、
  `pointer: coarse` 的 4 个媒体块、V1 的 5 个可排序列（类型/大小/创建/修改/访问）、
  `.row-actions` 四个固定槽位、`.tag` 的两个生产者、`#toasts` 的 `aria-live="polite"` + `aria-atomic="false"`、
  `.empty` 的上下 `var(--sp-8) = 64px`（⇒ 128px 空白）、`--shadow-inset` 的 0 个消费者。
- **`.audits/` 脚本产出的三条"站内引用"结论**（文档名 + `§N`、`/ui*` 资源路径、`modulepreload` 闭包）
  本轮**不重跑**（禁脚本），改为按台账结论采信；它们各自都已写明判据与脚本名，属**可复算**而非**已复核**。

### 8.3 本轮新查出 3 处（F-13…F-15）

| 编号 | 类型 | 位置 | 一句话 |
|---|---|---|---|
| **F-13** | **同一文件里两条注释互相矛盾** | `public/ui_v2/css/shell-v2.css` | 断点块（2026-09-19 写）还并列着"≤380：只降字号（见文件末尾那档）"并声称宽度档"只有 `720` / `380` 两条"，而那条 `≤380` 已由**次日**的改动删除、文件末尾现在写的是"曾有一条…已删" |
| **F-14** | **台账没跟上自己的处置** | 本文档 §7.4 | 表里仍列着"5 处 `文件:行`"，其中 3 处正是 §4 判为腐烂并**已替换**的那三条 ⇒ 实数只剩 2 处 |
| **F-15** | **标签的边界没写清** | 本文档 §7.1 | 把 29 项称作"`R100` 纯改名"，而 diff 里 `similarity index 100%` **是 33 条**（4 个 PNG 也算）|

#### F-13：`shell-v2.css` 的断点注释与"次日"的删除互相矛盾

- **原文**（断点块，两处）：
  ① `≤380：只降字号（见文件末尾那档）`；
  ② 「两句都已不成立：全文件**没有**任何中屏区间块（只有 `max-width: 720px` / `380px` 两条）」
- **核实**：`grep -nE '1080px|380px' public/ui_v2/css/` 的三条命中**全部在注释里**；
  真正的宽度档只剩 `@media (max-width: 720px)`（`shell-v2.css:673`）一条。
  那条 `@media (max-width: 380px) { :root { --fs-display: 1.5rem } }` 于 **2026-09-20**
  随孤立的 `--fs-display` 一起被删（`tokens-v2.css:137-140` 与 `shell-v2.css:813-817` 都记着），
  而断点块是 **2026-09-19** 写的、没跟着改。
- **为什么值得单列**：这不是"行号腐烂"（没有任何行号），而是**同一个文件里两条注释对同一件事
  给出相反答案** —— 读者按上面那段去找"文件末尾那档"的降字号规则，会读到一段"它已经删了"的说明。
  上一轮的 F-11（配错文档名）记的是文档间同型的问题，这一条是**文件内**的。
- **修法**：断点块改成"两档、宽度档只有 `720` 一条"，并把"≤380 那档次日被删"就地写明、指向文件末尾那段。

#### F-14 / F-15：已在 §7.1 与 §7.4 原地订正

两处都不是"代码错了"，而是**这份台账自己**没跟上自己 §4 的处置（F-14）与**标签范围**
没写全（F-15）。订正内容就在那两节里（各带一条 ⚠️ 说明与可复算判据）。

### 8.4 本轮**仍然没有**核实的（边界，别把它读成"已过"）

1. **门禁一条都没跑**（用户本轮明令禁止）：`tsc --noEmit`、`eslint`、22 个套件、两版浏览器探针。
   所以 §4 F-8 / F-9 的**行为面**、以及所有标注"实测"的数字（47 / 103 / 117 / 65 / 125 / 135 /
   CLS 0.90 / 6642 / 6683.05 / 384 / 3930 / 804 / 4454），本轮给的是**内部自洽复核**，不是"看过它真的这样"。
2. **`.audits/` 里的九个脚本本轮未重跑**（禁脚本）⇒ §7.2 / §7.3 / §7.5 的覆盖率与闭包结论，
   本轮只做了"台账内部自洽"级别的复核。
3. **工作区里那批未提交的修复**（12 个 `public/` 文件）本轮读的是**当前代码**而非 diff ——
   它们尚未提交，因此**不在 `6ebcf6e..HEAD` 这个范围里**；本文档的台账描述的是**已提交**的 diff，
   `⚑` 标的是"它上面又叠了一次修复"。

