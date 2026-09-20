# 审计：两套前端的「缺失状态 / 不可达展示」类缺陷（2026-09-18）

> **起因**：修掉 V1 首屏那句「还没有任何记录」之后（过程见 `progress.md` §85），用户要求
> 「全面阅读两个前端，看看有什么这两个 bug 等类似的问题」。本文件是那次审计的结果。
>
> **与 `AUDIT-redundancies.md` 的分工**：那一份找的是「**多余**」（死代码、重复实现、冗余兼容层）；
> 这一份找的是「**缺失**」—— 缺一档状态、缺一个生产者、声明了却画不出来。两者是**相反方向**的判据，
> 而那正是 §85 那个缺陷能活过前面几轮审计的结构性原因（详见 §0.2）。

---

## 0. 口径

### 0.1 找的是这五类（A–E）

这五类不是五个问题，而是**同一个根因的五个面**：界面把「未知」渲染成了「已知」，
或者更一般地 —— **代码里说的、和它实际做的不是一回事**。

| 类 | 判据 |
|---|---|
| **A 缺失状态 / 哨兵值复用** | 某个条件、字段或初值同时承担两个含义（「未知/还没到」与「确实是空/否/0」）。典型形状：`x.length === 0`、`x === null`、`x \|\| 默认值`、布尔初值、`0`/`''` 被当作「还没取到」。**判据**：对每个由状态驱动的渲染函数，**枚举它在运行时可能处于的状态**，逐个检查是否有互不相同、且各自真实的表现。 |
| **B 不可达 / 从未被绘制的 UI** | 标记或样式存在，但在任何可达路径上都画不出来。典型形状：节点在首次绘制前被替换/清空、选择器里的类名或 `data-*` 值**没有生产者**、可见性由永不成立的条件控制、初始状态属性无人清掉。**判据**：对每个存在的元素问「谁把它变可见？那条路径走得到吗？」；对每条 CSS 规则问「这个键有生产者吗？」 |
| **C 注释与实现相反** | 注释声称的行为代码没做；或注释说「某处有守卫/兜底」，而那条守卫在别的分支、或根本不存在。 |
| **D 占位值与真实值不可区分** | 加载中用 `0`、`—`、空串、默认文案渲染，读起来与真实数据一样。 |
| **E 现状文档的声明与实现不符** | 这是让 §85 那个缺陷长期不被发现的那一层（见 §0.2），故单列一类，且**每条都要能机械核对**。 |

### 0.2 为什么必须有 E 类：文档担保是上一轮的"消音器"

§85 那个缺陷逃过好几轮通读，主要不是因为难读，而是因为**三条文档互相印证"它已经有了"**：
`docs/ui.md` §9.3 写着 loading = 骨架屏、`docs/frontend-checklist.md` §14 写着"状态矩阵完整"、
而 `index.html` 里确实躺着一段 `.skeleton`。于是任何读文档下结论的人**都会跳过它**。

**结论：凡是文档声明"某状态已实现 / 某处已修 / 某令牌在用"的，都必须去代码里找一个生产者。**

### 0.3 范围与方法

- 范围：`public/ui_old/**`（V1，默认界面/产品面）与 `public/ui/**`（V2，开发测试版）的全部
  JS / CSS / HTML，约 **18,000 行**；以及 6 份前端相关文档。
- 方法：四路并行通读（V1 JS / V2 JS / 两版 CSS+HTML / 文档一致性），
  产物共 25 条候选；**每一条都由主代理人独立逐行复核**（读原文、算特异性、反向核对生产者），
  复核中**剔除 1 条**、**降级若干条**为"疑似"（见 §6）。本文件只列**复核通过的**。
- **本轮没有起 dev server、没有跑全量套件、没有做浏览器实测**（用户明确"不要跑门禁"）。
  所有结论都是**静态核对**（读代码 + 反向核对生产者 + 数文件），因此凡需要真实渲染才能定案的
  都放进 §8「拿不准」，不写进确认项。

---

## 1. 与刚修的那个缺陷**同形**的（最高优先）

这五条的成因与 §85 完全一致：`「未知」被渲染成一个确定的结论`。

### 1.1 [V1] 分页写着「没有可显示的记录」—— **已修**

- **位置**：`public/ui_old/js/components/pagination.js:69,76`（修前）
- **形状**：`update({ page, pageSize, total })` **没有加载档**。`total === 0` 同时表示「还没到」与
  「真的一条都没有」。而 `main.js` 的 `render()` 在 `render()` 首帧就被调用，那时 `store.total` 的初值正是 `0`。
- **用户看到**：首屏加载期间，屏幕下方的分页条写着「**没有可显示的记录**」+「第 1 / 1 页」，
  上一页/下一页都置灰 —— 与列表写的「还没有任何记录」是同一个谎，只是换了个控件。
- **为什么上一轮漏了**：§85 补的是列表的骨架档，而分页是**另一个组件**、有自己的一份 `total === 0` 判据。
  这正是本文档要抓的形状：**同一个哨兵值会在多个组件里各写一遍。**
- **修法**：`update()` 增加 `loading` 入参；`pending = loading && total === 0` 时范围文本给
  「正在加载…」、页码标签留空（不再写「第 1 / 1 页」）。`main.js` 的 `render()` 把 `state.loading` 传下去。

### 1.2 [V1] 头栏说「正在加载…」、正文说「加载失败」—— **已修（这条是上一轮改动自己引入的）**

- **位置**：`public/ui_old/js/components/list.js:782`（修前）
- **形状**：`showError()` 只做 `setView('empty')` + 填错误态内容，**不改头栏**；
  而最后一次 `renderHead()` 是**加载档**写入的（`lastHead = { …, loading: true }` ⇒ 「正在加载…」）。
  失败路径不调 `render()`（见 `main.js` 的 catch），于是那两句话同时留在屏幕上。
- **用户看到**：同一条横线上，上面写「正在加载…」、下面写「加载失败 / <原因> / 重试」——
  一边说还在取、一边说已经失败。
- **修法**：`showError()` 里把头栏的条数清空（失败时条数是**未知**的，故既不给数字也不给替代文案，
  说明由错误态正文单独承担）。
- **教训**：**给一个组件补状态档时，要同时检查"这个组件的每一处出口"**。加档只改了 `update()`，
  而 `showError()` 是另一个出口。

### 1.3 [V2] `.overview__ghost` **从未被绘制**，而设计文档把它记成"已修"

- **位置**：`public/ui/js/ui/overview.js:32`、`:95-106`；文档担保在 `docs/ui-v2-design.md:520`
- **形状**：
  - `totalValue` 构造时写死 `text: '—'`（`:32`）。
  - `setValue()`（`:95-106`）的"没变化就不动 DOM"判据是
    `const shown = node.dataset.value ?? null; if (shown === nextText) return;`。
  - 首次调用时 `node.dataset.value` 是 **`undefined`**（`dom.js:23` 的 `text` 只写 `textContent`，
    **不写 `dataset`**）⇒ `shown = null`；而首次传入的 `text` 也是 `null`
    （`boot.js:342` 的 `stats?.activeCount ?? null`，store 的 `stats` 初值是 `null`）⇒ `null === null`
    ⇒ **在 `node.append(placeholder())` 之前就 return 了**。
  - 那个 `—` 于是留了下来，`.overview__ghost` 一次都没出现过。
  - 它唯一可能被走到，是"先有数字、`stats` 再变回 `null`"—— 而 `stats` 只在 `boot.js:560` 被写成一个对象，
    **从不写回 `null`** ⇒ `placeholder()` **不可达**。
- **用户看到**：首屏加载期间概览带第一格是「**—** 活跃记录」（读起来像"一条活跃记录都没有"），
  「最近同步」「存储占用」两格是**空白**；而同一时刻下面的列表正在画骨架行。
- **为什么它长期不被发现（与 §0.2 同构）**：`docs/ui-v2-design.md:520` 把这条记成
  「修法：未加载时给淡色骨架条（`overview__ghost`）」—— **文档替它做了担保**，而这段代码
  从未被执行过。这与 V1 那次（`index.html` 里的静态骨架 + 三条文档担保）是**同一个机制**。
- **附带的两处数字失准**（同一条注释里）：`overview.js:86` 说主数字是 `--fs-display`（24–30px），
  而 `shell-v2.css:282` 的 `.overview__value` 用的是 `--fs-title`（**17px**，
  `tokens-v2.css:135`）；且 `--fs-display` 在全 `public/` 里**零个 `var()` 消费者**（见 §5.3）。
- **状态**：本轮（第一轮审计）**未修**；**随后已修**，见 §10 的对照表（`ui/js/ui/overview.js` 的
  `placeholder()` 接进首绘）。当时给的最小修法：让首次调用也走一遍 `placeholder()`（例如把判据换成
  `if (node.dataset.value === (nextText ?? '')) return;` —— 首次 `undefined !== ''` 即会绘制）。

### 1.4 [V2] 分页写着「共 0 条」

- **位置**：`public/ui/js/ui/pager.js:73,79-80`
- **形状**：与 1.1 同形。`update({ page, pageSize, total })` 没有加载档；
  `pages <= 1 ? '共 ' + (total ?? 0) + ' 条'`，而 `store.total` 初值是 `0`（`boot.js:92`）。
- **用户看到**：`boot.js:1102-1103` 的 `store.patch({ loading: true }); render();` 是第一句，
  `render()` 会走到 `pager.update` ⇒ 首屏加载期间页脚写「共 0 条」。
- **可对照**：`public/ui/js/ui/filters.js:149` 对同一个"未知的 total"的处理是
  `Number.isFinite(total) ? String(total) : ''` —— **留空**。分页条是漏掉的那一处。

### 1.5 [V2] 错误态的列表头写着「0 条记录」

- **位置**：`public/ui/js/ui/board.js:283-284`
- **形状**：计数档只有两档 —— `state === 'loading' ? '…'`，**否则** `String(total ?? 0)`。
  而 `error` 也是"否则"。
- **用户看到**：首屏列表请求失败时，列表头写「**0 条记录**」、正文写「加载失败」。
- **可对照**：`state === 'empty'` 时写「0 条记录」是**对的**（那确实是空）；
  错的是 `error` 跟着一起走。缺的是"错误"这一档（与 §85 缺的那一档同源）。

---

## 2. [A] 哨兵值复用（除 §1 之外）

### 2.1 [V1] 统计条在 overview 首屏失败后**永久空白**，而注释说轮询会补齐

- **位置**：`public/ui_old/js/components/stats.js:84`（`if (!stats) return;`）+
  `public/ui_old/js/main.js:400-401`（注释）
- **形状**：`stats === null` 同时表示「首屏还没到」与「取数失败」。组件内部**没有**这两档，
  `null` 时三个数字与「全库 N 条」保持构造时的空白。
- **关键的第二半**：注释写「统计条与排障条留空即可（**下一次轮询会把后两样补齐**）」——
  但 `pollOnce()`（`main.js:1089-1124`）只做三件事：写时钟差、写"最近一次变更"、
  调 `stats.setHealth(...)`。它**从不**重取统计。全仓 `refreshStats()` 的调用点只有
  `setFilters()` 的视图切换（`:164`）与五次写操作（`:517/558/578/619/770/790`）。
- **用户看到**：只要首屏那次 `/ui/api/overview` 失败一次（一次网络抖动即可），统计条会一直空着
  —— 用户分不清"库里是 0"还是"坏了"，而注释向读代码的人担保它会自愈。
- **状态**：本轮（第一轮审计）**未修**；**随后已修**，见 §10 的对照表（`ui_old/js/main.js` 的 `pollOnce`
  里补了 `refreshOverview()`）。当时那条"真修法"（把错误/加载两档纳入 store，与 `progress.md` §85.4
  第 1 条同一件事）截至目前仍未做。

### 2.2 [V2] 抽屉把"没取到"当成"从来没有过"（两处）

- **位置**：`public/ui/js/ui/drawer.js:283`（活动趋势）、`:363`（清理状态）
- **形状**：
  - `:283` `const days = Array.isArray(activity) ? activity : []` —— `activity === null`
    （还没取到 / 取失败）与 `[]`（确实没有活动）被压成同一个 `[]`，于是 `:291`/`:295` 都写
    「还没有数据」/「还没有活动数据。」。而 `refreshActivity()` **全仓只被调用一次**
    （`boot.js:1133`），失败被静默吞掉（`:606`）且**永不重试** ⇒ 一次瞬时失败 = 永久"从没用过"。
  - `:363` `if (!cleanup || !cleanup.lastRunAt)` —— `info === null` 时渲染**断言式**文案
    「清理任务还没有运行过。它由 Cron 每 20 分钟触发一次…」，把"我不知道"说成"它没跑过"。
    `info` 只由 `refreshOverview()` 写入，失败路径既不设也不清（`boot.js:566` / `:577-581`）。
- **可对照**：概览带那边对 `activity` 有守卫（`overview.js:126-134`，只在 `activity.length > 0` 时画），
  抽屉这边没有 —— **同一个 store 字段，两个消费者，只有一处分了档。**

### 2.3 [V2] 顶栏把「未连接」折成「定时检查中」

- **位置**：`public/ui/js/ui/appbar.js:115`（`STATE_TEXT` 在 `:73-78` 定义了四档）
- **形状**：`pushState === 'live' ? 'live' : pushState === 'connecting' ? 'connecting' : 'poll'`
  —— `'offline'` 落进 `'poll'`。于是 `STATE_TEXT.offline`（「未连接」）**永远画不出来**，
  `data-state="offline"` 也只在构造时存在一瞬（`:32` 的初值），而 CSS 只有
  `live`/`poll` 两条（`shell-v2.css:110,115`）—— `connecting`、`offline` 两档**连点色都没有**。
- **用户看到**：推送通道被代理/CSP 稳定挡掉时，顶栏写「定时检查中」而不是「未连接」。
- **注意**：轮询确实在跑，所以「定时检查中」不是事实错误；真正的问题是**那一档 UI 不存在**，
  以及 `:113-114` 的注释写着与代码相反的话（见 §4.2）。

---

## 3. [B] 不可达 / 从未被绘制的 UI（除 §1.3 之外）

### 3.1 [V2] 删行/恢复后焦点**必然掉到 `<body>`**，且注释承诺的兜底不存在

- **位置**：`public/ui/js/ui/board.js:532-541`（`neighborButton`）、`:494`；调用点 `boot.js:729`、`:749`
- **形状**：`neighborButton(row, action)` 查 `.icon-btn[data-icon="${action}"]`，而两个调用点传的是
  `'delete'` / `'restore'` —— **这两个 `data-icon` 值没有任何生产者**：行内按钮的图标只有
  `undo / copy / download / star / dots`（`ui/rowops.js:58,72,84,96,105`）。
  于是 `nextFocus` 恒为 `null`，`if (nextFocus) nextFocus.focus()` 是死路。
- **同时是 C 类**：`board.js:532` 的注释写「都找不到时交给第一行的选择框」，
  而函数体最后是 `return null` —— 那条兜底**在代码里不存在**。
- **用户看到**：用键盘在回收站点「恢复」、或经 `⋯` 菜单删一行后，焦点落到 `<body>`，
  下一次 Tab 从页面开头重来。
- **为什么值得注意**：`board.js:474-479` 的注释**正是**在说要防止这件事，而 V1 有完整的
  `restoreFocus()` 链条（邻居行同一操作 → 空状态主按钮 → 表头全选框，见 `ui_old/js/components/list.js`）。
  **V2 是退化的一方。**

### 3.2 [V2] 四条"有 CSS、无生产者"的死规则

每一条都做了**反向核对**（在 `public/**` 的 JS 与 HTML 里找生产者），逐条列出证据：

| 位置 | 选择器 | 核对结果 |
|---|---|---|
| `public/ui/css/board-v2.css:377` | `.entry__text[data-lines="1"]` | 全仓唯一的 `data-lines` 生产者是 `ui/row.js:134` 的字面量 **`'2'`**；密度切换（`tokens-v2.css:262-265`）只改 `--row-h`，不写这个属性。⇒ 这一档"单行模式"在任何视口/密度下都不可能出现 |
| `public/ui/css/board-v2.css:525` | `.icon-btn[data-icon="pin"][aria-pressed="true"]` | 行内 `.icon-btn` 由 `ui/button.js:24-46` 生产，图标集见上（无 `pin`）。`menus.js:36` 的 `pin` 是**菜单项**、`batchbar.js:42` 是 `.btn--sm`，都不产生 `data-icon`。⇒ 注释 :522-524 说的"置顶与收藏是两个独立维度"在行内不成立（**V1 有**这个按钮，是 V2 重构后的遗留） |
| `public/ui/css/overlay-v2.css:662,666,670,674` | `.bar__fill[data-kind="Text"\|"Image"\|"File"\|"Group"]` | `ui/drawer.js:308-311` 建 `.bar__fill` 时**只写 `style: { width }`**，不写 `data-kind`。⇒ 抽屉活动趋势的柱子永远是默认强调色 |
| `public/ui/css/overlay-v2.css:270,275` | `.tag[data-tone="star"]`、`.tag[data-tone="pin"]` | `.tag` 的生产者只有 `ui/row.js:194`（无 tone）与 `:197`（`warn`）。⇒ 注释 :253-255 承诺的"强调（收藏/置顶）"那一档语义从未绘制 |

### 3.3 [V2] 反向的一条：JS 写了 `data-busy`，CSS 里没有这个消费者

- **位置**：生产端 `public/ui/js/ui/omnibox.js:121-124`（`setBusy`），消费者**不存在**
- **形状**：`omnibox.js:116-119` 的注释写「这里只标记 `data-busy`（**把图标降透明**）」，
  而 `public/ui/css/*.css` 里 `data-busy` 只有一条：`.board[data-busy]`。
- **可达性**：`boot.js:350` 每次 `render()` 都调 `omnibox.setBusy(current.loading)`（含 10 秒轮询），
  所以属性**一直被写**，只是没人消费 ⇒ 注释承诺的那一格视觉从未出现。

### 3.4 [V2] ≤720px 时"刷新"入口**不存在**

- **位置**：`public/ui/css/shell-v2.css:767`（`@media (max-width: 720px) { .filters > .icon-btn { display: none } }`）
- **形状**：该规则命中的是筛选条里的刷新按钮（`ui/filters.js:99-112` —— `refreshBtn` 是 `.filters` 的
  **直接子节点**，已核对 `:105-113` 的结构）。注释（`:765-766`）说「`刷新` 在窄屏**收进抽屉的一部分**」，
  但 `drawer.js` 里**没有**刷新控件（全文件只在无关注释里出现"刷新"二字）；顶栏也没有
  （`appbar.js` 只有 搜索/主题/设置/登出）。
- **用户看到**：手机上（≤720 是几乎全部手机）唯一的刷新手段是等 10 秒自动轮询 ——
  刷新回调只另挂在键盘快捷键 `r` 上（`boot.js:1089` → `keys.js:42-45`），而触屏没有键盘。
- **同时是 C 类**：`ui/filters.js:7` 的注释写「③ 顶栏（随时可用）：搜索、**刷新**、主题、登出」，
  描述的是一个**从未实现**的分层。

### 3.5 [V2] ≤720px 时同步状态只剩一个色点，而注释说的 `aria-label` 不存在

- **位置**：`public/ui/css/shell-v2.css:771-772`（`.sync__label { display: none }`）
- **形状**：注释写「顶栏只留状态点，文案靠 `title`/`aria-label`」。核对 `ui/appbar.js`：
  `title` 确实写了（`:128`），但**从没给 `.sync` 设过 `aria-label`**（`:110` 那行设的是主题按钮）。
  而 `display: none` 会把 `syncLabel` 整段移出无障碍树 ⇒ `.sync`（`role="status"`，`:32`）
  在 ≤720 下对外只剩一个空状态区。
- **备注**：判为**确认**的是"注释与实现不符"这一半；读屏实际能拿到多少（部分 AT 会暴露 `title`）
  需要量无障碍树，属于 §8。

---

## 4. [C] 注释与实现相反

§3.1 / §3.4 / §3.5 各含一条，此处只列其余。

### 4.1 [V1] 「下一次轮询会把后两样补齐」

`public/ui_old/js/main.js:400-401`。核对见 §2.1 —— `pollOnce()` 从不重取统计，
也取不到 `info`（清理状态），所以"补齐"这件事不会发生。

### 4.2 [V2] 「`connecting` 是过渡态，展示上与 `offline` 分开」

`public/ui/js/ui/appbar.js:113-114`。核对见 §2.3 —— 代码把 `offline` **并进** `poll`，
而 `connecting` 虽然能写进 `data-state`，却没有对应的 CSS 档。

### 4.3 [V2] 「首屏骨架：**必须在这里画**」

`public/ui/js/boot.js:1120-1126`。注释说「`render()` 只在数据落地后才跑，而它之前 `.board-area` 一直是空的」，
但**同一次 `initialize()` 的第一条语句**就是 `store.patch({ loading: true, error: null }); render();`
（`:1102-1103`），而 `render()` 在 `state === 'loading'` 下已经会 `root.replaceChildren(head, renderGhost(rows))`
（`ui/board.js:293-301`）⇒ 骨架在 `await api.session()` **之前**就画好了，`:1127` 那次是重复绘制。

- **后果**：没有可见差异（结果是对的）。危害是**它对下一个读代码的人撒谎**：
  照这段注释，任何人都会以为"删掉 1127 行会让骨架消失"，从而不敢动那段。

### 4.4 [V2] 「主数字用的是 `--fs-display`（24–30px）…改成 skeleton」

`public/ui/js/ui/overview.js:86-89`。三处与实现不符：字号是 `--fs-title`（17px）、
`--fs-display` 零消费者、skeleton 从不绘制（§1.3）。

### 4.5 [V2] 「都找不到时交给第一行的选择框」

`public/ui/js/ui/board.js:532`。核对见 §3.1 —— 函数体是 `return null`。

---

## 5. [E] 现状文档的声明与实现不符

**这一节最要紧**：审计报告、设计文档、README 都是别人（和代理）下结论时的**前提**。

### 5.1 `README.md:412` 与 `docs/ui.md:146,655`：js/css 的缓存策略

- **文档**：README「js/css 的短 TTL + `stale-while-revalidate`（无指纹 ⇒ 部署后有 **≤5 分钟**的新旧混用窗口）」
  （写在**安全基线**表里）；`docs/ui.md:146`「js/css 的短 TTL + `stale-while-revalidate`」；
  `docs/ui.md:655`「实测响应头：…`cache-control: public, max-age=300, stale-while-revalidate=86400`（js/css）」。
- **实际**：`public/_headers:20-34` 对 `/ui/js/*`、`/ui/css/*`、`/ui_old/js/*`、`/ui_old/css/*`
  写的是 `Cache-Control: public, no-cache, must-revalidate` —— **没有 TTL、没有 SWR**。
  （图标/manifest 那几行确实仍是 `max-age=86400, stale-while-revalidate=604800`，那部分文档没错。）
- **差异性质**：数字过时 / 措辞误导。**"≤5 分钟新旧混用窗口"这件事已经不存在**（现在是每次重验证），
  而它写在安全基线里，读者最容易照它去"修"缓存。
- **附带**：`docs/ui-v2-audit.md:96`（A-27「已修：SWR=60 → 最坏 ≈6 分钟」）与 `:214`
  （「JS/CSS `max-age=300, stale-while-revalidate=60`（A-27 的修复在线上生效）」）是**同一件事的历史快照**，
  方向没错、值已经不存在。审计文档按轮次记，这类可以保留，但**现状文档（README / ui.md）必须改**。

### 5.2 `docs/ui.md` 内部自相矛盾两处

- `:624-629`（§9.9 触屏平板）：写粗指针下操作列「4×44 + 3×**4** 间距 = 188px 内容宽…= **212px**」，
  并在同段强调"810px 下操作列 88 → **212px**"。
  实际 `public/ui_old/css/tokens.css:116` 是 **`--col-actions-coarse: 230px`**（间距已由 4 提到 10），
  而**同一文档** §3.3 第 17 条（`:257`）写的正是 230px。
- `:153` 说 V1 字号阶梯是「13/14/16/18 + 数字档，12px 档已合并」；`:408` 又说
  「层级由字号阶梯（**12/13/14/18/30px**）承担」。实际 `tokens.css:64-79` 只有 **13/14/16/18**
  （"数字档" `--fs-stat` 已在 2026-09-18 删掉，只剩注释）。
  ⇒ 同一文档两个口径，**两个都不对**。

### 5.3 `--fs-display` 是"未使用令牌"，而 `docs/ui-v2-audit.md:180` 说未使用令牌已清零

- **文档**：`docs/ui-v2-design.md:199` 把 `--fs-display` 的用途写成"概览带主数字（24 → 30px）"；
  `docs/ui-v2-audit.md:180` 写「未使用令牌：只剩上面两个**有理由**的组」。
- **实际**：`var(--fs-display)` 在全 `public/**` 里 **0 命中**（只有定义 `tokens-v2.css:134`、
  一处 `@media` 覆盖 `shell-v2.css:784`、以及 `overview.js` 的注释各出现一次）。
  概览带主数字用的是 `--fs-title`。
- **顺带发现一个守卫缺口**：`test/ui-guard.test.ts` 的"令牌不空转"断言只扫 **V1**
  （`V1_DIR = 'public/ui_old'`），**V2 不在守卫范围内** —— 所以这条漂移不会有任何东西报警。

### 5.4 `docs/ui-v2-design.md` §5 组件词汇表（自述"测试按此校验"）里的类名/属性不存在

- **文档**：`:237-266` 是一张「组件 → 类名 → 状态属性」表，并声明"测试按此校验"。
- **实际**（全部按 `public/**` 全量检索）：
  - `.spark` → 实际类名是 `.overview__spark`（`ui/overview.js:44`）；
  - `.preview-cell` → 不存在；预览是 `.entry`/`.entry__text`/`.entry__thumb`/`.entry__kind`（`ui/row.js:140+`）；
  - `.menu` 的 `data-open` → 只在 `ui/menu.js` 被 `removeAttribute`，**没有 setter、也没有 CSS 消费者**
    （开关走 `panel.hidden`，见 `menu.js:166`）;
  - `.batchbar` 的 `data-count` → 全仓 0 命中（计数是 `.batchbar__count` 文本，`ui/batchbar.js:20`）；
  - 抽屉的 `data-open` → 实际用原生 `[open]`（`overlay-v2.css:1075`）。

### 5.5 数字过时：目录树里的 V1 文件计数、以及两处控件尺寸

- `docs/ui-v2-design.md:363`：「`ui_old/` 内是 V1 的全部文件，含它自己的 **6 张样式表与 23 个 JS 模块**」
  —— 实际 **7** 张 CSS（`archive/auth/base/components/layout/motion/tokens.css`）与 **24** 个 JS。
- `docs/frontend-checklist.md:428`：「V2 保留 **30px** 视觉尺寸、用 `::before` 把命中区撑到 44px」
  —— V2 的 `.icon-btn` 是 `width: var(--control-h)`（`board-v2.css:464`），
  而 `--control-h: 34px`（`tokens-v2.css:174`；粗指针 40px，`:273`）。
- `docs/ui.md:560`（V1 章节内）：把首帧主题脚本写成 `/ui/js/theme-init.js` —— V1 的是
  `/ui_old/js/theme-init.js`（`public/ui_old/index.html:61`）。同文档 `:152` 写的是对的。

---

## 6. 复核中**剔除**的结论（审计也要被审计）

本节单独列出来，因为"审计员的话本身是一个需要被验证的断言"——这次审计正是为了这个教训。

| 候选 | 剔除理由 |
|---|---|
| 「`docs/ui-v2-audit.md:520` 记着 `overview__ghost` 已修，实际没修」 | **文件/行号张冠李戴**：`docs/ui-v2-audit.md` 只有 **239** 行，且全文不含 `overview__ghost`。那条声明的真实位置是 `docs/ui-v2-design.md:520`（已改到 §1.3） |
| 「`docs/ui-v2-design.md:363` 说 V1 是"冻结存档、加弃用横幅"，与现状相反」 | **引文不实**：`:363` 那一行的原文里没有"弃用横幅"；"冻结"二字出现在 `:362` 的目录树行与 `:27-32` 的**已作废段落**（该段落头部自己声明"已被紧随其后的两条更新取代…**2026-09-17 更新：V1 不再冻结**"）。故只保留该行的**文件计数错误**（§5.5），不把"定位相反"算作缺陷 |
| 「V1 触屏对比度/几何数字（239/278/106px）算不出来」 | 需要真实渲染才能复算，本轮不起浏览器 ⇒ 移入 §8 |
| 「`.overview` 高度文档写 56px、§13.3 实测 74px、令牌 60px」 | 无法在不渲染的情况下判定 74px 是否为 padding 后的实际框高 ⇒ §8 |

---

## 7. 已核实为相符（覆盖清单）

写出来是为了避免后人重复劳动，也为了标出**这次审计的边界**。

- **V1**：`main.js` 的 boot/refresh/refreshOverview/refreshStats/pollOnce/setFilters 顺序与注
  释（除 §4.1 那条）、latest-gate 四处、`data-busy` 的加/清、`signalr.js` 的退避状态机、
  `list.js` 的 `setView()` 三态互斥与 `restoreFocus()` 焦点链、`filters.js` 的 URL 往返、
  `format.js` 的相对时间档、`api.js` 的 30s 超时与 401 跳转、`preview.js`/`info.js` 的对话框开合。
- **V2**：`board.js` 的四态分支与骨架行数判据（`loading`/`empty` 两档正确，`error` 见 §1.5）、
  `A-02` 的 CLS 修复行为、`A-25` 的越界页码夹回、`§84.1` 那五条（趋势图特异性、`parseInt`→`null`、
  确认框初始焦点、就地重填保焦点、CLS 注释）逐条核对**未见残留**、`ui/filters.js` 对未知计数留空、
  `batchbar`/`omnibox`/`dialog`/`focus.js`/`latest.js`/`keys.js` 的状态分档。
- **CSS 的 `[hidden]` 契约**：逐条核对了两个版本里 20 处会被 `hidden` 切换的元素，**全部**落在
  `base.css:22` / `base-v2.css:115` 的 `[hidden] { display: none !important }` 兜底上，
  4 张页面都加载了兜底层，且**全仓不存在 `display: <非 none> !important` 的反压**。
- **CSS 特异性**（§85 那类先例）：把两版所有 `display`/`visibility`/`opacity:0`/`height:0` 的
  覆盖关系逐对比过特异性和位置，**未发现新的"可见规则被压死"**；V2 的 `.overview__spark`
  已是同形选择器（`shell-v2.css:180` vs `:710`，同为 (0,3,0)、后者更晚）⇒ 已修。
- **数字口径**：`public/` 资源数 **89**、`test/*.test.ts` **22**、`docs/design.md` 的套件清单、
  `docs/ui.md` §5 端点表 18 条 == `ui-guard` 的 `EXPECTED_API_ROUTES`、V1 的
  `modulepreload` 清单 == import 闭包 —— 全部相符。

---

## 8. 未做 / 拿不准

1. **浏览器实测一律没做**（用户"不要跑门禁"）。因此下列都只能算"静态上成立"：
   `shell-v2.css:771` 的同步状态在 ≤720 下读屏能拿到多少（§3.5）、
   `.overview__ghost` 修复后的实际观感、V1 触屏几何与对比度数字。
2. **`docs/ui.md` §9.9 那批需要复算的几何/对比度数字**：文档给了可复算的公式，但复算要真实渲染。
3. **`docs/upstream-issues.md` 与 `ui-v2-design` §12.2 的历史快照**：它们是按轮次记的，
   本轮只标注了"当作现状读会误导"，没有逐条核对是否已被后续章节取代。
4. **两版 `messages.js` 的"逐字一致"**：守卫（`ui-guard.test.ts:455-469`）比较的是**函数体**，
   两份文件的头注释本来就不同 ⇒ `AGENTS.md` §3 的"两份必须逐字一致"表述与守卫范围有细微出入。未定性。

---

## 9. 修复优先级建议（按"会不会对用户撒谎 / 会不会让人基于错误前提动手"排）

| 序 | 项 | 理由 |
|---|---|---|
| 1 | §1.3 V2 `.overview__ghost` | 与 §85 同形；且**设计文档担保它已修** —— 不修的话下一次审计还会被它骗过一次 |
| 2 | §1.4 / §1.5 V2 分页与错误态头栏 | 同一条根因在 V2 的两个出口上各留一份 |
| 3 | §3.1 V2 焦点掉到 `<body>` | 唯一一条**键盘用户直接受影响**的功能性缺陷（V1 已做对，V2 退化） |
| 4 | §2.2 V2 抽屉的两处"不知道→断言否定" | 会把"取数失败"讲成"从来没用过这台服务器" |
| 5 | §5.1 缓存策略的现状文档 | 写在安全基线里，读者会照它动手 |
| 6 | §3.4 ≤720 的刷新入口 | 手机上刷新入口不存在（改法要先定：放回顶部还是进抽屉） |
| 7 | §3.2 / §3.3 死规则与死钩子 | 不影响用户，但每条都会让下一个读代码的人以为"这里已经做了" |
| 8 | §4 各条注释订正 | 零成本、且直接降低下一轮的误判概率 |

> **注意**：本文件只登记，**不构成"已实施"记录**。哪一条被采用了，在 `progress.md` 新起一节写清楚
> （与 `AUDIT-redundancies.md` §14/§15 同体例）；改完代码要按 `AGENTS.md` §1 同步文档。
---

## 10. 实施记录（2026-09-18 修复轮）

与 §9 的建议逐条对应；**本节是"已实施 / 未实施"的唯一执行记录**。过程叙述在 `docs/progress.md` §88。

| 条目 | 状态 | 落点 / 说明 |
|---|---|---|
| §1.1 V1 分页「没有可显示的记录」 | 已修（早于本轮） | `ui_old/js/components/pagination.js` + `store.loading` |
| §1.2 V1 头栏「正在加载…」与正文「加载失败」并存 | 已修（早于本轮） | 同上（`setView()` 是唯一开关） |
| §1.3 V2 `.overview__ghost` 从未被绘制 | **已修** | `ui/js/ui/overview.js` 的 `placeholder()` 接进首绘 |
| §1.4 V2 分页「共 0 条」 | **已修** | `ui/js/ui/pager.js` |
| §1.5 V2 错误态的列表头「0 条记录」 | **已修** | `ui/js/ui/board.js` 的三态计数 |
| §2.1 V1 统计条首屏失败后永久空白 | **已修** | `ui_old/js/main.js` 的 `pollOnce` 里补 `refreshOverview()` |
| §2.2 V2 抽屉把"没取到"当成"从来没有过" | **已修** | `ui/js/ui/drawer.js`（`loaded` 标记 + `info` 空判） |
| §2.3 V2 顶栏把「未连接」折成「定时检查中」 | **已修** | `ui/js/ui/appbar.js`（删掉无生产者的 `offline`，另补 `connecting` 的 CSS 档） |
| §3.1 V2 删行/恢复后焦点掉 `<body>`（`neighborButton` 收到不存在的 `data-icon`） | **已修**（调用点改传真实图标名）；**残留一档**：删掉最后一行时邻行不存在，见 `docs/archive/AUDIT-v1-v2-divergence.md` §12.2 | `ui/js/ui/board.js`、`ui/js/boot.js` |
| §3.2 V2 四条"有 CSS、无生产者"的死规则 | **已修** | `board-v2.css`（`data-lines`、`[data-icon="pin"][aria-pressed]`）、`overlay-v2.css`（`data-tone="star"/"pin"`）；`.bar__fill[data-kind]` 改为**补上生产者**（`ui/js/ui/drawer.js` 按当天主类型写 `data-kind`） |
| §3.3 JS 写了 `data-busy` 而 CSS 无消费者 | **已修** | `shell-v2.css` 补 `.omnibox[data-busy] .omnibox__icon` |
| §3.4 ≤720px 没有"刷新"入口 | **已修** | `ui/js/ui/appbar.js` 的窄屏刷新按钮 + `ui/js/boot.js` 接线 |
| §3.5 ≤720px 同步状态只剩色点、注释说的 `aria-label` 不存在 | **已修** | `ui/js/ui/appbar.js` 的 `sr-only role="status"` 区域 |
| §4.1 V1「下一次轮询会把后两样补齐」 | **已修**（把注释承诺的那段代码补上，见 §2.1） | `ui_old/js/main.js` |
| §4.2 V2「`connecting` 与 `offline` 分开」 | **已修**（`offline` 已不存在，注释与 CSS 同步） | `ui/js/ui/appbar.js`、`shell-v2.css` |
| §4.3 V2「首屏骨架必须在这里画」 | **已修**（注释与 `render()` 的真实时序对齐） | `ui/js/boot.js` |
| §4.4 V2「主数字用的是 `--fs-display`（24–30px）」 | **只改注释，不动视觉** —— 注释改成"按设计**该**用 `--fs-display`"，并把"实际是 `--fs-title`（17px）"这条分歧写在注释里；改字号是设计决策，见 `docs/archive/AUDIT-v1-v2-divergence.md` §12.1 | `ui/js/ui/overview.js` |
| §4.5 V2「都找不到时交给第一行的选择框」 | **已修**（注释不再承诺不存在的兜底；未覆盖的那一档写进注释，见 §3.1） | `ui/js/ui/board.js` |
| §5.1 README / `docs/ui.md` 的 js·css 缓存策略 | **已修**（改成 `no-cache, must-revalidate` 的实况；"≤5 分钟混用窗口"已不存在） | `README.md`、`docs/ui.md` ×2 |
| §5.2 `docs/ui.md` 内部自相矛盾（212px / 字号阶梯） | **已修**（→ **230px**；字号统一为 **13/14/16/18**） | `docs/ui.md` ×5 |
| §5.3 `--fs-display` 是"未使用令牌" | **已修文档**（`ui-v2-audit.md` 补例外、`ui-v2-design.md` 令牌表标注"无消费者"、`overview.js` 注释写明分歧） | 见 `docs/archive/AUDIT-v1-v2-divergence.md` §12.1 |
| §5.4 `docs/ui-v2-design.md` §5 词汇表里的类名/属性不存在 | **已修**（`.spark`→`.overview__spark`；`.preview-cell`→`.entry`/`.item`；`.menu` 的 `data-open`→原生 `hidden`；`.batchbar` 的 `data-count`→`.batchbar__count`；抽屉 `data-open`→原生 `[open]`；`.sync` 的 `offline`→`connecting`） | `docs/ui-v2-design.md` |
| §5.5 数字/路径过时 | **已修**（V1 文件计数 6/23 → **7/24**；`--control-h` 30px → **34px**；`/ui/js/theme-init.js` → **`/ui_old/js/theme-init.js`**） | `docs/ui-v2-design.md`、`docs/frontend-checklist.md`、`docs/ui.md` |

**未做**：§7 的浏览器实测、§8 里"拿不准"的条目（其一是 §4.5 的同族）。
理由：探针要真实的浏览器与 dev server，而本轮按用户指令**不跑门禁**（环境与判据见 `docs/ui.md` §11）。

**一个自查到的失误**：本轮代码注释里原本写的是 2026-09-**19**（比真实日期**晚**一天），
28 处已全部订正为 2026-09-**18**，与 §85~§87、两份审计文档、`.workbuddy/memory/2026-09-18.md` 一致。

