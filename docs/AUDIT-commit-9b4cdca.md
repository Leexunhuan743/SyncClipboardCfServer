# 审核报告：`9b4cdca` —「fix(ui): 解除 ui_old 跨目录依赖并校准全文档真实代码」

- 提交：`9b4cdca14ef0d11cc58a553014eea6c6bda467ec`（2026-09-18 15:46，当前 HEAD，工作区干净）
- 规模：17 文件 / +237 −101
- 审核方式：逐行读 diff + 交叉核对服务端实现 + 跑本地质量门（typecheck / lint / vitest）

---

## 1. 结论

**功能改动基本正确、可合入**：本次的三个代码面（V1 自包含、V2 空状态/概览口径、探针校准）都经得起核对，
没有行为回归。但**「校准文档」这一半没做完，而且自己引入了新的不一致**：4 处文档/注释与真实代码不符，
1 处守卫反而变弱，1 处改动只覆盖了两个同名入口中的一个。

按严重度：**P1 × 1、P2 × 3、P3 × 3**，无 P0。

---

## 2. 实测结果（可复现）

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc --noEmit + eslint） | ✅ 0 错误 |
| `vitest run test/ui-input.test.ts test/ui-guard.test.ts test/ui-logic.test.ts` | ✅ 3 文件 / 77 测试全通过 |
| `npm test` | 15 文件通过、**7 文件失败（20 测试）**，全部为 `connect ECONNREFUSED 127.0.0.1:8787` |

失败原因归类：29 条 `Caused by: ECONNREFUSED`，即这 7 个套件是需要 `npm run dev` 起本地 dev server 的
**集成套件**，与本次改动无关（无任何断言失败）。合计 266 通过 / 110 跳过。
顺带确认 README 里「test/ 全部 22 个套件」与 vitest 实测的 22 个测试文件一致。

**服务端侧交叉验证（提交声称的事实为真）**

- `/ui/api/overview` 确实解析 `deleted`：`src/ui/routes.ts:585`（`parseDeletedFlag`），返回
  `byType: deleted ? views.byDeleted : views.byActive`（`:596`）。
- `GET /` 浏览器分支确实 302 到 `/ui_old/`：`src/routes/webdav.ts:40` —— `protocol.md` 的修正属实。
- `package.json` 版本 `1.25.2` 与 `design.md` §10 一致。

**前端侧交叉验证**

- `emptyStateKind` 优先级（filter 先于 trash）正确，`anyFilter` 的重复实现已删且无遗留引用
  （`board.js` 只有 `renderEmpty` 一处用）。`blank.js` 三种 kind 齐备，探针读的 `.blank[data-kind]` 存在。
- V1 已无任何代码级跨目录引用：`public/ui_old/**` 全量搜索只剩 3 处**注释**提到 `public/ui/js/...`。
  `index.html` 的 modulepreload 清单与 V1 自身 import 闭包一致（V1 自己的 `format.js` 仍在 :46）。
- V1 `main.js:17-72` 新增的 5 个函数与 V2 `public/ui/js/messages.js` **逐字相同**（今天为止）。
- 探针 4 → 5 是**真修正**：V2 一行 = 1 checkbox（`row.js:57`）+ 1 预览按钮（`row.js:135`）
  + 3 个行内按钮（`rowops.js`：主操作 + 收藏 + `⋯`）= 5。
- 登录页断言改成 `username` 是**真修正**：`public/ui/js/login.js:67` 空提交时
  `showError('请填写用户名。', userInput)`，焦点与 `aria-invalid` 都在 `#username`。
- `api.js` 的 diff 是**纯缩进修复**（`request()` 的 try 块此前缩进错位），无行为变化。

---

## 3. 问题清单

### P1 — V1/V2 文案副本重新分叉，且不再有任何守卫或测试

本次把上一轮「两版共用 `messages.js`」整套回退成 V1 本地副本。自包含的目标正当（V2 是实验版、可能被删），
但代价没有被兜住：

1. V1 的副本是 `main.js` 里的**私有函数**，不导出 ⇒ `test/ui-logic.test.ts` 只覆盖 V2 那一份
   （`test/ui-logic.test.ts:20` 从 `public/ui/js/messages.js` import），**V1 的副本零测试**。
2. 旧守卫「V1 的文案来自两版共用的那一份」被换成自包含断言 ⇒ **漂移不再被守卫**。
3. 仓库自己的结论是「两份必然漂移」（原 `messages.js` 头部注释），而 V2 是**实验场**，
   下一轮改 V2 文案时 V1 会静默偏离，删除语义句（「带数据文件的记录软删时立即清数据文件」）正是最不能漂的那类。

建议（二选一）：
- （推荐）把 V1 副本提成 `public/ui_old/js/messages.js`（仍自包含，但可导出 ⇒ 可测），
  并加一条**对等守卫**：`V1 副本 === V2 副本`（在 V2 被删之前一直钉住，真要删 V2 时连守卫一起删）；
- 或在 `docs/ui.md` §2 明确写下「**有意接受**两版文案各自演进、漂移由人工 review 兜底」——
  现在只写了「完全自包含」，没写风险，下一个人会以为这是免费的。

### P2 — `docs/ui.md` §3.1 丢了 `js/components/info.js`（本次引入的文档退化）

hunk 删了 3 行（preview 旧版 / confirm / **info**）、只补回 2 行。grep 实证：`info.js` 在 `docs/ui.md`
中**已完全不存在**，而 `public/ui_old/js/components/info.js` 存在、被 `main.js:81` import、
被 `index.html:57` 预载。README 明确写「文件清单以 docs/ui.md §3 为准（避免四处各列一份、加文件时漏更新）」，
所以这个「唯一事实源」现在少一个文件。看起来是重排三行时的编辑事故。
（这也解释了为什么没被拦住：`test/docs.test.ts` 钉的是「22 个套件 / 87 个资源」这类**计数**，
不校验 §3 表格的行内容 —— 它照样通过。）

### P2 — `progress.md` §81.1.4 归错轮次，且 `appbar.js` 里留着被自己否定的注释

- §81.1.4 写「`appbar.js` 中品牌名 `brand__name` 与工作空间主标题 `h1` 解耦」为本轮工作；
  但本 commit **没碰 appbar.js**。`git log -S brand__name` / `-S workspace-heading__title`
  实证这两处都来自 **`27826ed`**（V2 重做那轮）。
- 反过来，`public/ui/js/ui/appbar.js:19-21` 的注释至今写着「品牌名就是这一页的 `<h1>` … 用 `<h1>`
  而不是 `<span>`」，而 `:22` 造的是 `<span class="brand__name">`，真正的 h1 在
  `public/ui/app/index.html:87`（`.workspace-heading__title`）。一个以「校准全文档」为目的的提交，
  漏掉了它正在讨论的那个文件里的直接矛盾。

### P2 — 两处「清除筛选」行为不一致（改动只覆盖了一个调用点）

- `board.js:411`：空状态按钮 → `onClearFilters({ keepView: true })` ⇒ **留在回收站**。
- `ui/filters.js:92`：工具栏按钮 → `onclick: handlers.onClearFilters`，把 **MouseEvent** 直接当参数传进
  `resetFilters({ keepView = false } = {})`，解构 Event 得 `keepView === undefined` ⇒ false；
  而 `isDefaultFilters` 把 `deleted: true` 视为非默认（`filters.js:206`），所以回收站里这个按钮是**可见的**。

结果：同名的两个「清除筛选」，一个留在回收站、一个把你踢回活跃列表。改动引入了一条原则
（§81.1.2「清除筛选保持所在视图」）却没把第二个入口对齐。修法：`onclick: () => handlers.onClearFilters()`
（顺带消掉「事件对象被当选项解构」这个隐患）。

### P3 — 探针并没有验证本次修复的核心

`states.mjs` 那条断言「回收站类型计数使用删除记录口径」读的是 `.chips .chip__num` 的**第一个**，
即「全部」chip，其值来自 `boot.js:357-359` 的 `current.stats.deletedCount`，而 `stats` 出自
`db.statistics()`（`src/db.ts:363`，**与视图无关**的一条全表聚合）——它根本不经过 overview 的 `deleted` 参数。
真正受 `deleted` 影响的是**按类型**的四个 chip（`countsForView` → `stats.byType`）。
⇒ 该断言在 `overview` 忽略 `deleted` 时**照样通过**。
建议补一条：读 `.chip[data-kind="Image"] .chip__num` 与 `statistics?deleted=1` 的 `byType.Image` 对比。

### P3 — 自包含守卫的覆盖面窄于同类守卫

新守卫只查 `js/main.js` 与 `index.html`。同一文件里已有「扫遍 V1 全部 JS」的先例
（`ui-guard.test.ts:307` 的 `/ui_old/api` 断言，还专门用 `files.length > 15` 钉住枚举有效性）。
跨目录依赖同理应扫全部 23 个 V1 JS + 两张页面。另外 `not.toContain("from '../ui/")` 是**空断言**：
从 `public/ui_old/js/` 出发 `../ui/` 指向不存在的 `public/ui_old/ui/`，写 `../../ui/` 才有意义。

### P3 — `design.md` §4 新增的 V2 目录树漏 3 个文件

新增行 `js/ # api / boot / … / theme / ui/*`（`design.md:134`）缺 `next-target.js`、`redirect-hash.js`、
`theme-init.js`（`git ls-files` 实证）。同一 hunk 里 V1 的清单是逐字精确的，V2 反而不全 —— 不对称。

---

## 4. 附带建议（非阻塞）

- `design.md` 用 `D17 (界面定位)` / `D17 (请求体上限)` 并立消歧，现行下游引用（`progress.md:5267`、
  `ui-v2-audit.md:5`）都能对上；但裸写「D17」的旧条目（`progress.md:1173/2821/4732`）依然歧义。
  若有机会，重编号（D17/D19）比带主题后缀更省事。
- V1 的 `main.js` 现在把 6 个函数定义**夹在 import 语句之间**（`:16-72` 在 `:73` 的 import 之前）。
  ES module 会提升 import，所以能跑，ESLint 也没拦；但读起来像事故现场，建议至少挪到 import 块之后。

---

## 5. 建议的收口动作（按优先级）

1. 决定 V1 文案副本的走向（提文件 + 对等守卫 / 或显式写下接受的漂移风险）。← 唯一需要设计决定的一项
2. 把 `js/components/info.js` 一行补回 `docs/ui.md` §3.1。
3. 删掉 `appbar.js:19-21` 的过时注释，并订正 `progress.md` §81.1.4 的轮次归属。
4. `ui/filters.js:92` 改成 `() => handlers.onClearFilters()`，让两个「清除筛选」行为一致。
5. 探针加按类型 chip 的断言；自包含守卫生成「扫全部 V1 JS」的版本。

---

## 6. 处置记录（本报告的 8 条已全部落地）

> 本报告的事实性断言**已逐条独立复核，8 条全部成立**（含 `git log -S` 的归属核对、
> `ui-guard.test.ts:354-360` 的空断言、`docs/ui.md` 里 `info.js` 的缺失、`info.js` 被
> `main.js:81` import 且被 `index.html:57` 预载）。据此按"吸收合理意见"落地如下。

| 本报告条目 | 处置 | 落地方式 |
|---|---|---|
| **P1** V1/V2 文案副本分叉且无守卫 | ✅ **采纳推荐方案**（提文件 + 对等守卫） | 新建 `public/ui_old/js/messages.js`（V1 自包含副本，可被 import ⇒ 可测）；`main.js` 改 import；`index.html` 补 modulepreload；`docs/ui.md` 资源数 87 → 88；新增对等守卫「V1 的 messages.js 与 V2 的逐字一致」（从 `import { typeLabel }` 起逐字比对，**因此也覆盖两版共有的私有函数 `describeTarget`**；比较前归一换行，避免行尾差异造成无意义红灯）。同时修掉 V1 里那两处"两版共用 messages.js"的错误注释 |
| **P2** `docs/ui.md` §3.1 丢了 `js/components/info.js` | ✅ 已补 | 同时补上一行 `js/messages.js`（新文件）。注意该表描述的是 **V1** —— 这一点顺带推翻了 `AUDIT-redundancies.md` 的 D-05 里"要改 `docs/ui.md:159`"的连带建议（那行本来就对） |
| **P2** `progress.md` §81.1.4 归错轮次 + `appbar.js` 留着被自己否定的注释 | ✅ 已改 | `progress.md` 的该条重写为**本轮真实改动**（`app/index.html` 补工作区 `<h1>`），并注明 `appbar.js` 的解耦出自 `27826ed`；`appbar.js:19-21` 的注释改为与 `:22` 的 `<span>` 一致 |
| **P2** 两处「清除筛选」行为不一致 | ✅ 已改 | `ui/filters.js` 改 `onclick: () => handlers.onClearFilters()`，顺带消掉"MouseEvent 被当选项对象解构"这个隐患；注释写明两处入口的语义 |
| **P3** 探针没验证本次修复的核心 | ✅ 已补 | `states.mjs` 增加按类型 chip 的读取与断言："回收站按类型 chip 用的是删除记录口径（overview 必须透传 deleted）"，并注明**为什么**只比「全部」chip 测不出来 |
| **P3** 自包含守卫覆盖面窄 + 空断言 | ✅ 已重写 | 改为**解析全部 V1 JS 的 import 是否逃出目录**（结构性判据，不受注释影响）+ 检查两张页面的 `<script src>`/`<link href>` 是否指向 `/ui/`。**范围收紧一处**：不查 `<a href>` —— 提示条指向 `/ui/app/` 的导航链接是有意的（原报告未区分，直接照做会误报） |
| **P3** `design.md` §4 的 V2 目录树漏 3 个文件 | ✅ 已补 | `next-target.js` / `redirect-hash.js` / `theme-init.js` |
| **附带建议** `main.js` 的 6 个函数夹在 import 之间 | ✅ 顺带解决 | 提成 `messages.js` 后，函数定义不再夹在 import 块中间 |
| **附带建议** 裸写「D17」的旧条目歧义（建议重编号 D17/D19） | ⬜ 未做 | 属历史文档的批量重编号，牵动 `progress.md` 多处引用；本轮不做（如要做建议单独一轮） |

### 6.1 顺带发现的另一件事（本报告未提）

`test/ui-contract.test.ts` 的文件头（`:5-8`）写着 V1 的契约守卫"文案表与 V2 共用同一份""页面/资源清单在 `ui-guard` 里已经逐条核对过"——**前者在本报告 P1 落地后已不成立**（V1 有自己的 `messages.js`），后者原本也不成立（V1 当时没有 modulepreload 闭包守卫）。本轮已把该注释改准，并补上了实际缺失的守卫。这类"注释描述的分工与事实不符"和本报告 P2 第二条是同一形态：**以校准文档为目的的改动，容易漏掉正在讨论的那个文件**。

