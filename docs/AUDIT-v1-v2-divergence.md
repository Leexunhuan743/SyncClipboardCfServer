# 审计（第二轮）：两版分歧 / 竞态 / 生命周期 / 边界 / 无障碍 / 契约（2026-09-18）

> **第一轮**（缺失状态、不可达展示、文档担保）见 [`AUDIT-missing-states.md`](AUDIT-missing-states.md)；
> 本轮换**七个完全不同的镜头**，两轮零重叠（少数条目是第一轮的补充证据，会注明）。
>
> **方法**：七路并行通读 —— 竞态/重入、生命周期与资源、边界与数值、无障碍实质、
> 服务端契约的两条缝、V1↔V2 定向分歧核对、安全与注入面。共约 18,000 行 JS + 6,500 行 CSS。
> **每一条都由主代理人独立逐行复核**（读两侧原文、验算符号约定、按 CSS 值复算、反向核对生产者）。
>
> **纪律**：只登记能逐行举证的；区分「确认」与「疑似」；不报风格/命名/性能；
> **本轮没有起 dev server、没有跑全量套件、没有做浏览器实测**（用户明确"不要跑门禁"），
> 所以凡需要真实渲染才能定案的都标成"疑似"。

---

## 0. 本轮最重的结论：两版之间存在**方向性**的退化

第一轮只撞到一次"V2 是退化的一方"（删行后的焦点链）。本轮七个镜头**各自独立**又撞到同一件事，
而且这次是**成规模**的：**V1 修过的坑，V2 里原样留着**——很多还带着 V1 那段"此前的失败形态"的注释。

原因是结构性的，不是谁粗心：

- 两版**独立实现、没有共享代码**（V1 自包含是硬约定，见 `AGENTS.md` §3），所以修一处**不会**连带另一处。
- V1 的修复历史以**注释**形式留在 V1 的源码里（本仓库注释密度极高，"此前…（实测）…现在…"随处可见），
  而**没有任何机制**保证 V2 会看到它们。`docs/progress.md` 按轮次记，读的人不会去比对两版。
- V2 曾经长期是"主推版本"，后来降级为开发测试版（2026-09-18 定位调整）⇒ 维护重心倒向 V1 之后，
  V2 反而成了**修复的净流出方**。

> ⇒ **可执行的推论**：以后任何"V1 修好的坑"，都应当**同时在 V2 上查一遍**；否则 V2 会持续变差，
> 而 `docs/ui-v2-audit.md` 那份"V2 已通过审计"的记录会越来越不成立。

---

## 1. V1 修过、V2 仍有（确认，按用户可见度排序）

| # | V1 的修复（行号 + 注释关键句） | V2 现状 | V2 用户遭遇 |
|---|---|---|---|
| 1.1 | `ui_old/js/main.js:1049` 「**正在输入时不覆盖**」：`const editing = document.activeElement instanceof HTMLInputElement; if (!editing) info.open(fresh)` | `ui/js/ui/drawer.js:344`（+ `:332-333`）**无条件** `retentionInput.value = …`；由 `boot.js:378` 的 `drawer.update()` 触发，而它在**每 10 秒轮询**里被调用（`boot.js:648`）⇒ 全文件无 `activeElement` 守卫 | 抽屉开着、正在填「保留天数 / 最大条数 / 自定义起止日期」时，约 10 秒后输入被重置回服务端旧值 —— **用户填的东西静默丢失**，看起来像"填不进去" |
| 1.2 | `ui_old/js/main.js:326` 「用 replace 而不是 push：这是界面的**自我修正**，不该进浏览器的后退历史」 | `ui/js/boot.js:510` `setFilters({ page: lastPage }, { push: true })`（夹取逻辑本身 `:508-512` 与 V1 一致） | 打开/分享 `?page=999` 这类链接时多压一条历史记录；按后退回到越界页 → 又自校正一次 → **后退循环** |
| 1.3 | `ui_old/js/signalr.js:26-29` 「此前这里是**永久停手**…唯一的恢复路径是切一次标签页」+ `:86-98` 的 `RETRY_COOLDOWN_MS`（10 分钟冷却后清零重试）+ `:187-189` 在 `start()` 里归零 `retryDelay` | `ui/js/push.js:78-86` `if (stopped \|\| retryTimer \|\| failures >= MAX_CONSECUTIVE_FAILURES) return;` —— 全文件无 `cooldownTimer`/`RETRY_COOLDOWN_MS`，`start()`（`:165-168`）也不重置 `retryDelay` | 推送连续断 5 次后**永久**停在轮询档（请求量从 60s 看门狗退回 10s 档，约 ×6），只有隐藏再显示标签页才恢复 |
| 1.4 | `ui_old/js/api.js` 的 `requestBlob`/`fetchData`（带 30s 超时 + signal + 401 跳登录），`main.js:879-883` 的注释逐字描述「按钮一直转圈且点不动」 | `ui/js/boot.js:817` `await fetch(api.dataUrl(item), { credentials: 'same-origin' })` —— **裸 fetch**，无超时、无 signal、无 `handleAuthError`；上层按钮走 `setPending`（`ui/toast.js:104-116` 默认 `disabled=true`） | 预览图片后点「复制图片」而网络半开时，按钮**永久转圈且永久不可点**；会话过期也只显示「取图片失败」，不回登录页 |
| 1.5 | `ui_old/js/components/header.js:63-67` 「`aria-live` **不能挂在按钮上**…用一个视觉隐藏的 status 区域承载**状态词**（不带解释：状态抖动时一长句念不完）」，且只在真的变化时改写 | `ui/js/ui/appbar.js:32` 把 **`role="status"`** 放在 `.sync` 上，而 `:124` 写进去的是 `${base} · ${ago}`（**带相对时间**） | 读屏用户**每约一分钟**被主动打断一次（`formatAgo` 跨分钟档就变），念"实时同步中 · N 分钟前"，永远念不完 |
| 1.6 | `ui_old/js/components/toast.js:32` **没有**逐条 `role`（宿主 `index.html:157` 已有 `aria-live="polite"`） | `ui/js/ui/toast.js:31-35` 的注释**逐字**写着「不再给每条提示加 `role="status"`…在里面再嵌一个实时区域会造成**同一句话被播报两遍**（外层 atomic=false、内层 role=status 隐含 atomic=true，两个区域各播一次）」 | ← **反了**：V1 `components/toast.js:32` 仍是 `role: error ? 'alert' : 'status'`，叠在宿主的 `aria-live="polite"` 里 ⇒ **V1 的提示每条被播报两遍**（错误那条还会打断朗读） |
| 1.7 | `ui_old/js/components/pagination.js:44` 「跳完就清空并**交还焦点**」→ 实际 `:46` `jump.blur()` | `ui/js/ui/pager.js:43-46` 的注释「这里原来还有一个 `event.target.blur()`：跳页后焦点会掉回 `<body>`…键盘用户下一次 Tab 从文档开头重来」⇒ V2 已删 | ← **反了**：V1 的 `blur()` 只是把焦点丢回 `<body>`（注释说"交还焦点"是错的，它交还给浏览器）⇒ V1 键盘用户跳页后要从文档开头重新 Tab |
| 1.8 | `ui_old/js/format.js:52-63`：未来时间戳显式分档（「N 分钟后 / 小时后 / 天后 / 日期」），注释「把这种值画成一个时刻，等于把『这台设备的时钟可能不对』这条线索**藏掉**」 | `ui/js/format.js:60` `if (diff < 0) return formatClock(new Date(ms));`（注释自称"时钟偏差：显示绝对时刻"） | 一条 2035 年的记录行内显示成 **`09:03`**，读起来像"今天早上刚发生的"（V1 的注释里记的正是这张截图） |
| 1.9 | `ui_old/js/filters.js:62-73` 的 `addDays()`（日历运算），注释「常数 24 小时在跨夏令时切换的时区里会落偏一小时…没有理由留一个『**只在别人的时区里错**』的算法」 | `ui/js/filters.js:81,83` `startOfDay(now) - 6 * DAY_MS` / `- 29 * DAY_MS`；`:113` `date.getTime() + DAY_MS` | 有夏令时的时区里，「近 7 天 / 近 30 天」的边界落在切换日的 23:00 或 01:00 ⇒ **静默多/少一整天的记录**；自定义范围的「到」同理偏一小时 |

## 2. 反向：V2 修过、V1 仍有（确认）

| # | V2 的修复 | V1 现状 | V1 用户遭遇 |
|---|---|---|---|
| 2.1 | `ui/js/boot.js:530-534` 的守卫 `if (!(error instanceof ApiError) \|\| error.status >= 500) setStale(true)`，注释「原来任何非 2xx 都会点亮那条横幅：搜索词超过 48 字节触发的 400 会让用户看到『与服务器暂时失去联系』—— 服务器好好的…用户会去**重启服务**（实测抓到）」 | `ui_old/js/main.js:354` **无条件** `setStale(true)`（搜索串本地只截 200 字符，服务端上限 48 **字节** ⇒ 49–200 字符必然 400） | V1 里搜索词过长会同时弹出「搜索词过长…」与「与服务器暂时失去联系，页面上的内容可能不是最新的」两种说法 |
| 2.2 | `ui/js/theme-init.js:8-9` 注释「不读 `getComputedStyle`（V1 的写法）：此刻样式表还没加载…永远停在 HTML 里那个静态值上」+ 运行期 `theme.js:21-23` 也用显式映射 | `ui_old/js/theme-init.js:16-17` `getComputedStyle(document.documentElement).getPropertyValue('--bg')`；运行期 `main.js:1059-1063` 同样 | V1 的移动端浏览器顶栏/状态栏颜色停在 HTML 静态值、不跟主题；应用内切主题后 `theme-color` 慢一拍 |
| 2.3 | `ui/js/ui/pager.js:39-48` 已不调 `blur()` | `ui_old/js/components/pagination.js:46` `jump.blur()`（见 1.7） | V1 键盘用户跳页后焦点丢失 |

## 3. 竞态 / 重入 / 写回（确认）

- **3.1 [V2] 确认删除后按 Esc / 点 ✕ / 点取消，服务端已删但界面当作"没删"**
  `ui/js/ui/dialog.js:39`（✕）、`:179`（取消）、Esc → 都走 `:92-95` 的 `close → settle(null)`，
  而 `setPending` 只 disable 了**确认键**（`:190`）⇒ 请求在途时那三条路仍可用。
  上层的收行/清选择集/刷新全在 `if (!ok)` **之后**（`boot.js:723-734`、`:990-994`、`:1050-1053`）。
  后果：记录已删，行却留在列表里（批量删除时还写着「已选 N 条」），**要到下一次轮询（≤10s）才无声消失**。
  对照：V1 把本地收行放在 `action` **体内**（`ui_old/js/main.js:559-567`、`:774-779`），Esc 也自洽。

- **3.2 [V1] 200 + 非 JSON 的响应被静默当成空列表**（第一轮的同类，但**换了个成因**）
  `ui_old/js/api.js:82-86` `try { payload = JSON.parse(text) } catch { payload = {} }` —— 只在 `!response.ok` 时才抛（`:89-96`）。
  ⇒ 一个 **200 但 body 不是 JSON** 的响应（拦截式代理/门户认证页/被静态层以 200 回的 HTML）
  会让 `api.list` 读到 `raw.total ?? 0` = 0、`items` = [] ⇒ 界面**又一次**写下「还没有任何记录」，且**没有任何错误提示**。
  对照：V2 `ui/js/api.js:46-49` 在同一处 `throw new ApiError(502, '服务器返回了无法读取的数据，请刷新后重试。')`。
  > 这条与 `docs/frontend-checklist.md:65` 记的那类事故同源（"静态资源全部 200、页面永远停在骨架屏上"）。

- **3.3 [V1] `debounce` 没有 `cancel`，清空搜索会多发一次请求**
  `ui_old/js/dom.js:59-65` 返回的箭头函数只有 `clearTimeout`+`setTimeout`，没有 `cancel`；
  而 `ui_old/js/components/toolbar.js:157-164`（Esc）、`:174-179`（清空按钮）、`:152-156`（原生 search 事件）
  都**直接**调 `onSearch(...)`，无法取消已排期的那次 ⇒ 260ms 后它再读一次已空的输入框又发一次。
  对照：V2 `ui/js/dom.js:73` 有 `debounced.cancel`，且 `ui/omnibox.js` 的五处（Esc/清空/Enter/setValue/提交）全都先 cancel。

- **3.4 [两版] 写操作与在途刷新交错时，刚点亮的行会被旧快照盖回**（疑似）
  列表响应若"读于 PATCH 之前、落于其响应之后"，`reconcile` 会按签名重建该行 ⇒ 收藏状态弹回未点。
  `patchItem` 不参与 `listGate`（`ui/js/ui/board.js:695-699` / `ui_old/js/components/list.js:506-514`），两版都没有
  "本行有写在进行中"的标记。构造这条时序需要一次更慢的列表响应，故列为疑似。

## 4. 生命周期与资源（确认）

- **4.1 [V1] 模块级副作用在"同一文档求值两次"场景下会重复**
  `ui_old/js/main.js:1196-1205`：`initNoticeBar()`（`:1198`）跑在 `dataset.appBooted` 守卫（`:1204`）**之前**；
  更关键的是 `:61-103` 的模块级构造（`createToasts`/`createConfirm`/`createPreview`/`createInfo`/`createPushChannel`），
  而 `confirm.js:113`、`preview.js:58`、`info.js:198` 各自在**构造时** `document.body.append(dialog)` ⇒
  第二次求值会再往 `body` 塞 3 个常驻 `<dialog>` 子树 + 再绑一次宿主提示条。
  对照：V2 把这些创建全搬进了 `boot.js` 的守卫之后（`:84-86`、`:230-275`，append 在 `ui/dialog.js:54`、`ui/drawer.js:39`）。
  **影响分级**：`initNoticeBar` 重复挂的是幂等监听（后果可忽略）；孤儿 `<dialog>` 子树是纯浪费；
  **登录页完全没有等价守卫**（`ui_old/js/login.js`）⇒ 同一场景下一次提交可能打两次 `POST /ui/api/login`。
  触发场景（同一文档模块图两份）在 `docs/ui.md:424` 有记录，属"实测触发过但罕见"。

- **4.2 [两版] 关闭预览后不清正文，整段全文留在常驻 `<dialog>` 里**
  V1 `ui_old/js/components/preview.js:211` `close: () => dialog.close()` 无清理；正文只在**下次 open** 时才 `replaceChildren`（`:122-124`）。
  V2 `ui/js/ui/dialog.js:315` 同样只结算不开清（`clear(body)` 在 `:125-126`，即下次 open）。
  ⇒ `dialog` 是启动期创建、常驻 `body` 的节点，里面那棵 `<pre>` + 各动作按钮的闭包会一直抓住**完整的一条记录**。
  单条上限：V2 `api.js:72` 的 8 MiB（UTF-16 下约 16 MB），V1 的 `request()` 连这个上限都没有。
  只要用户不再预览第二条，这段内存到页面销毁都不释放。**严重度**：不是泄漏代码，是"峰值驻留"。

- **4.3 [V2] 空态/错态期间不释放上一页的行**（疑似，记为观察）
  `ui/js/ui/board.js:293-310` 的三个早退分支 `root.replaceChildren(head, …)` 把整张 table 摘掉，
  但行仍在 `tbody` 里、而 `tbody` 被闭包常量 `boardNode` 长期引用（`:312` 会原样装回去）。
  这是**有意的行复用池**，我无法证明它会持续增长，只证明"空态停留期间不释放"。

## 5. 边界与数值（确认）

- **5.1 [V2] 时钟差的方向说反了（诊断信息，会指导用户改错的一侧）**
  `ui/js/format.js:137-143`：`minutes = Math.round(offsetMs/MINUTE)`，`dir = minutes > 0 ? '快' : '慢'`，
  文案 `服务端${dir} N 分钟`。而 `offsetMs` 是 **`Date.now() − Date.parse(serverTime)`（本机 − 服务端）**
  （`boot.js:557`、`:632`），消费点 `ui/drawer.js:395` 直接传、**不取负**。
  ⇒ 本机快 10 分钟时，界面写「**服务端快 10 分钟**」——方向正好相反，且下面那句还劝用户"校准其中一侧"。
  对照：V1 的 `clockOffsetMs` 是 `server − Date.now()`（`ui_old/js/main.js:435`、`:1109`），
  文案 `本机时钟${seconds >= 0 ? '慢' : '快'}`（`ui_old/js/components/info.js:232`）—— **正确**。
  （这条把"两版对同一概念用了相反的符号约定"也暴露出来了。）

- **5.2 [V1] `formatSize(0)` 输出 `—`，且小于 1 KB 时不取整**
  `ui_old/js/components/stats.js:88` `storage.set(formatSize(Number(stats.totalFileSizeMB ?? 0) * 1024 * 1024))`；
  `ui_old/js/format.js:24` `if (!Number.isFinite(n) || n <= 0) return '—'`（把真实的 0 与"无效"并成一档），
  `:25` `return \`${n} B\``（不取整）。
  ⇒ 全新实例（或记录已被清空）的「存储占用」显示成 **`—`**（读作"取不到/坏了"），而同一行「记录 0 条」「已收藏 0 条」都是 `0`；
  总量不足 1 KB 时会打印出 `104.85760000000001 B` 这种浮点积。
  对照：V2 对同一字段显式给 `'0 B'`（`ui/js/ui/overview.js:161`）。
  另注 `docs/upstream-issues.md:304` 记着上游 `catch {}` 会让 `totalFileSizeMB` 静默变 0 —— 那个 0 是"真值"，更不该画成破折号。

- **5.3 [两版] 按 UTF-16 码元切分剪贴板文本 ⇒ 可能切出半个代理对**
  `ui/js/messages.js:17` / `ui_old/js/messages.js:28` 的 `(item.text ?? '').slice(0, 40)`、
  `ui/js/ui/row.js:142` 的 `text.slice(0, 80)` 都是码元切分；全仓无 `Intl.Segmenter`/`codePointAt`/`normalize`。
  ⇒ 第 40（或第 80）个码元落在代理对中间时（如 39 个 ASCII + 一个 emoji），删除确认框与行内 `aria-label` 会渲染出 **`�`**。
  同族：`boot.js:791` / `ui_old/js/main.js:859` 用 `.length` 报「已复制 N 个字符」——10 个 emoji 会报成 **20 个字符**。
  （`ui_old/js/messages.js` 与 V2 的同名文件有"逐字一致"的对等守卫，改要两版一起改。）

- **5.4 [V2] 分组标题与行内时间用了**不同**的字段**
  `ui/js/ui/board.js:330` 的分组按 `createTime`，而 `ui/js/ui/row.js:184` 显示的是
  `lastAccessed ?? lastModified ?? createTime` ⇒ 一条刚被同步过的旧记录会同时出现
  「3 天前」的分组标题与「刚刚」的行内时间。

## 6. 无障碍实质（确认）

- **6.1 [V2] ≤720px 下，列表头被"视觉隐藏但仍在无障碍树里" ⇒ 键盘 Tab 会落进一个看不见的按钮**
  `ui/css/board-v2.css:695-705` 对 `.board__head-row` 用 `position:absolute` + 1×1 + `overflow:hidden` + `clip-path`，
  注释说明意图是「视觉上仍然不占地方，但仍在**无障碍树**里」（为保住列名与全选）。
  但里面那个真的 `<button class="sort-btn">`（`ui/js/ui/board.js:96-106`、`:117-122`）**也随之留在 Tab 顺序里**，
  焦点环被父级 `overflow:hidden` 一并剪掉 ⇒ 看不出焦点在哪，按 Enter 会异步改排序且无可见反馈。
  该 `@media` 块（至 `:794`）里没有任何 `.sort-btn` 的遮盖规则。

- **6.2 [V2] 触屏命中区只有部分控件达标**
  `ui/css/tokens-v2.css:174-176` 自己写着 `--hit-min: 44px /* 触屏最小命中区，不可下调 */`，
  但 V2 的 5 处 `(pointer: coarse)` 分支只把 `--hit-min` 兑现到 **3 个控件**：
  `.check`（`overlay-v2.css:248-249`）、`.board-head__select`（`board-v2.css:65`）、`.icon-btn::before`（`board-v2.css:500-501`）。
  `.btn` / `.btn--sm` / `.chip` 在 coarse 下仍停在 **28–40px**
  （`--control-h-sm: 28px`、`--control-h: 40px`，`tokens-v2.css:174,273`）。
  ⇒ **宽度 >720px 的触屏设备**（平板横屏、触屏笔记本）上，分页「上一页/下一页」、批量条的 5 个动作、
  抽屉里的「保存保留策略 / 清空回收站」都是小目标（其中还有删除）。
  对照：V1 有 **7** 处 coarse 分支，`components.css:1654-1719` 逐控件（`.btn`/`.input`/`.select`/`.icon-btn`/
  `.segmented__item`/`.check-wrap`/`.th-sort`/`.search__clear`/`.row-actions__slot`）抬到 44px。

- **6.3 [V2] ≤720px 的表格丢了行列语义**（疑似，需量无障碍树）
  `ui/css/board-v2.css:707-713`、`:723-727`、`:729-739` 把 `table/tbody/tr/td` 改成 `block/flex/grid`，
  而 `ui/js/ui/board.js:30` 建表时**没有任何 `role`**（只有 `<th scope>`）。⇒ 卡片流下读屏可能不再报"第几列/表头"。
  对照：V1 `components.css:1759` 的注释写明「因为改动了 display，表格的隐式语义会丢失——行/单元格/表头的 role 已在
  `list.js` 显式补齐」，且 `list.js:298-320`、`:246`、`:453`、`:544-563` 确实逐格补了 `role`。

## 7. 服务端契约的两条缝（确认）

- **7.1 [V2] 批量删除丢弃服务端的 `failed` 计数**
  服务端批量写返回 `{ updated, failed }`（`src/ui/routes.ts:503-511`）。V2 的**删除**分支完全不读它，
  直接 `toasts.ok(\`已删除 ${items.length} 条\`)`（`ui/js/boot.js:994`）；
  而**同文件的通用分支**会读（`:1025-1028`「完成 N 条，M 条未生效」），V1 的 `runBatch` 更会在 `failed` 非零时抛错
  （`ui_old/js/main.js:619-623`）。⇒ 批量删除里若有记录已被别处删/恢复，界面仍报"已删除 N 条"，用户以为全成功。

- **7.2 [V2] `tz` 是一个恒被丢弃的死参数**
  `ui/js/api.js:212-213` 向 `/ui/api/overview` 发 `tz`，而该端点在服务端只调 `readDeletedFlagOr400`
  （`src/ui/routes.ts:624`）**全程不读 `tz`**；V1 的 overview 不发该键（`ui_old/js/api.js:271-272`）。
  ⇒ 只在日志里制造"好像按本地时区算过"的错觉。（`/ui/api/activity` 的 `tz` 是被读的，别混淆。）

- **附：两边对齐、无需动的**：`page/pageSize/sort/order/types/deleted/after/before/search` 的键名与取值集合
  逐条对上了（表见 §9）；`PATCH` 的 `{starred|pinned|isDelete}` 字段名与服务端完全一致，
  且 `isDelete: false` 的语义两边都是"恢复"（服务端判 `== null`，不会被当缺省忽略）——
  **没有乐观锁缺口**（服务端自算 version，不接受客户端传的 version/lastModified）。

## 8. 安全与注入：**没有发现可举证的注入缺陷**

这一节的结论是"没有"，对安全基线同样重要（**逐项都做了全量检索，不是抽样**）：

- **`innerHTML` / `outerHTML` / `insertAdjacentHTML` / `createContextualFragment` / `document.write` /
  `new Function` / `eval` / 字符串版 `setTimeout`：全树 0 处**（只命中注释 —— 而注释本身正是在声明"不提供插入 HTML 的途径"）。
  唯一的 HTML 构造入口 `el()` 把文本走 `textContent`/`createTextNode`，`svg()` 只吃 `icons.js` 的常量路径表。
- **URL/属性注入：无**。所有"数据 → URL"都经 `encodeURIComponent` 或 `URLSearchParams`
  （`dataPath` 逐段编码 → `<img src>`；`?next=` 用 `new URL().origin` 全等判定；`redirectToHash` 恒同源片段）。
  `setAttribute` 的**键**全是静态字面量。
- **`target="_blank"`：5 处全部带 `rel="noreferrer noopener"`**；另有 `Cross-Origin-Opener-Policy: same-origin`。
- **`postMessage` / `MessageChannel` / `window.opener`：0 处**。唯一的跨源消息面是 WebSocket，
  `event.data` 只 `JSON.parse` 取 `type` 后丢弃，参数从不进 DOM。
- **`localStorage` 的 3 个键**（主题/密度/提示条）读侧全部等值白名单，且只写 `dataset`/`hidden`/`textContent`。
- **剪贴板失败文案不含正文**（只报字符数或"是否 https + 退路说明"）；`console.warn` 只打 `error.message`。
- **两处 CSP 与实际能力一致**：`style-src 'self'` 成立（两份 HTML 无内联 `<style>`/`style=`；JS 里的 `node.style.*` 是 CSSOM，不受 style-src 约束）；
  `img-src 'self' data:` 成立（没有 `blob:` 图片）；`script-src 'self'` 成立；`connect-src 'self' wss: ws:` 够用。
  404 页的 `style-src 'self' 'unsafe-inline'` 与它那一段静态内联样式精确对应，且该页无任何用户数据。
- **服务端不信任客户端 hash**：`src/profile.ts` 对 Text/File/Image/Group 各自重算摘要并比对 ⇒ `item.hash` 恒为十六进制，
  这同时封死了"哈希字段被塞任意串"的可能。会话 Cookie 是 `HttpOnly; SameSite=Strict; Path=/`（https 下加 `Secure`）。

**两处边界（疑似，不是漏洞）**：
1. `ui_old/js/format.js:115-127` 的 `safeFileName` 未拦 **Windows 保留设备名**（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`）
   —— `../`、控制字符、结尾点/空格、`:`、超长**都已挡住**；保留名只会让 OS 拒绝或改写，不构成越权。
2. hub 票据 token 进了 **WebSocket 的 URL 查询串**（`src/ui/routes.ts:558` → `ui/js/push.js:113`）。
   它不进 `location`、不进历史记录与 `Referer`（WS URL 不参与导航），故不满足"被分享链接带走"的成立条件；
   但可能落进中间层访问日志。**页面 URL 本身是干净的**（深链接只含 SHA-256 十六进制摘要）。

## 9. 复核中剔除 / 降级的结论

| 候选 | 处理 |
|---|---|
| 「V2 时钟差方向反了」 | **保留，但我先按符号约定验算过**：V2 的 `offsetMs` 是"本机 − 服务端"、文案却写"服务端快/慢"，V1 的约定与文案**都相反且自洽** ⇒ 判定成立（见 §5.1），不是两个约定各自正确 |
| 「V1 `initNoticeBar` 重复挂监听」 | **降级**：监听器是幂等的（`bar.hidden = true` + 写一次 localStorage），重复挂的后果可忽略。真正有影响的是登录页没有幂等守卫（见 §4.1），已如实标注 |
| 「V2 `board.js` 早退不清 `rowMap` 会持续增长」 | **降级为观察**：那是有意的行复用池，`rowMap` 由后续对账清理，无法证明持续增长 |
| 「V2 `board.js` 的 260ms 兜底 drop 可能删掉新条目」 | **未收录**：构造不出可复现的时序（删除成功后服务端不会再返回该 key） |
| 「V1 `toolbar.js:276` 的 `reduce` 在字符串输入下会拼接」 | **未收录**：`src/types.ts`/`db.ts` 保证该字段是 number，无触发路径 |
| 「`--fs-display` 令牌无人用」等文档类问题 | 属**第一轮**，见 `AUDIT-missing-states.md` §5.3，不重复 |

## 10. 全轮核对为"两版都成立"的（避免后人重复劳动）

- 「最新请求胜出」竞态守卫（`latest.js` 两版同构，V2 注明从 V1 原样保留）；`AbortController` 都接上了 signal、
  都有超时清理（**唯一例外见 §1.4 的 V2 裸 fetch**）。
- 轮询不会翻倍（`schedulePoll` 先 `clearTimeout`），同一时刻至多一个在飞请求；两版的 `window`/`document` 级监听
  都注册在各自防线之后；逐行监听都挂在行上、随节点回收（没有"挂在长期存活容器上、每次渲染挂一遍"）。
- 写操作失败**不回滚错**：两版 `toggleFlag` 失败都不写 store、不 `patchItem`，`flashOk` 只在成功时执行。
- 批量分片的部分失败如实上报（除 §7.1 那一处例外）。
- `parseInt` 无基数/后缀垃圾：两版全是 `Number.parseInt(raw, 10)` 且外面套 `/^\d+$/` 纯整数校验。
- **两版前端零个 `Array.prototype.sort`**（排序全部下推服务端）⇒ "比较函数不稳定导致翻页乱序"这条形状在本仓库不存在。
- `Math.round(x/max*100)`：两版都先 `Math.max(1, …)` 兜 `max=0`，且 `value ≤ max` 恒成立。
- 对比度：按 WCAG 相对亮度公式**纯 CSS 值复算**了两版各浅/深主题的 9 类文本，**全部 ≥ 4.5:1**，与 `docs/ui.md:641` 的主张相符。
- `reduced-motion` 的"不动且完整"成立：两版都把动画声明在 `no-preference` 内或把时长归零，
  且对 `animation-fill-mode: forwards` 停在 `opacity:0` 的离场动效都有 JS 兜底（`ui_old/js/components/list.js:860`、`ui/js/ui/board.js:492-493`）。
- 焦点：两版的对话框**初始焦点**都落到合理位置（不是 `<body>`、不是危险按钮）；全仓**无正数 `tabindex`**。
- 表单：`aria-describedby`/`aria-labelledby` 指向的 id **逐个存在**；`min`/`max` 与前端 clamp 一致。
- 历史缺陷复核（**截至本轮开头**）：第一轮 §1.3/§1.4/§1.5 三条的原文未动、仍在，无新增残留 ——
  这三条随后已在本文件 §12 的修复轮里改掉（不写这句，本节会与 §12 "已修" 打架）。

## 11. 优先级建议（本轮新增，接第一轮 §9）

| 序 | 项 | 理由 |
|---|---|---|
| 1 | §1.1 抽屉未保存输入被轮询改写 | **用户的输入静默丢失**，且 10 秒内必现；修法就是 V1 那行 `editing` 守卫 |
| 2 | §4.1 的登录页无幂等守卫 | 同一场景下**一次提交两次 POST** |
| 3 | §1.3 推送永久停手 | 请求量退化到约 6 倍，且无自愈路径（V1 的冷却逻辑是现成的） |
| 4 | §1.4 裸 fetch 让按钮永久转圈 | 只能关对话框；会话过期也不跳登录 |
| 5 | §3.1 取消/✕/Esc 与在途删除的竞态 | 服务端已删、界面说没删，要等 10 秒才自洽 |
| 6 | §3.2 V1 的 200+非 JSON 静默变"零条" | **又一次"还没有任何记录"式假话**，且无任何错误提示 |
| 7 | §5.1 时钟差方向说反 | 诊断信息会指导用户改错的一侧（"同步不动"的排查路径） |
| 8 | §1.2 越界夹取误用 `push:true` | 后退循环 |
| 9 | §6.1 / §6.2 无障碍两处 | 键盘落到看不见的按钮；触屏小目标（含删除） |
| 10 | §5.2 / §5.3 / §5.4 显示类 | 0 B 显示成 `—`、半个代理对、分组与行内时间口径不一致 |
| 11 | §1.5 / §1.6 / §1.7 / §1.8 / §1.9 / §2.x | 逐条对齐两版即可，改动小、收益确定 |

> **本文件只登记，不构成"已实施"记录**。哪一条被采用了，在 `progress.md` 新起一节写清楚
> （与 `AUDIT-redundancies.md` §14/§15 同体例）；改完代码按 `AGENTS.md` §1 同步文档。
>
> **两条跨轮次的操作性结论**：
> ① **V1 修好的坑要同时在 V2 查一遍**（§0），否则 V2 会持续净流失修复；
> ② **"审计结论"本身要逐条复核** —— 第一轮剔除了 1 条引用错文件的，本轮把 2 条降级、3 条未收录（§9）。
---

## 12. 实施记录（2026-09-18，第二轮修复落地）

口径同 `docs/AUDIT-redundancies.md` §14/§15：**本节是"已实施 / 明确不改"的唯一执行记录**。
过程叙述在 `docs/progress.md` §88。

| 条目 | 状态 | 落点 |
|---|---|---|
| 第一轮 `AUDIT-missing-states.md` 的 §1.3/§1.4/§1.5 与 §3.1（V1 修过、V2 仍有：抽屉未保存输入被轮询重置 / 推送断 5 次永久停手 / `copyImage` 裸 `fetch` / 越界夹取 `push:false` / `.overview__ghost` 首绘 / pager·board 加载档 / `neighborButton` 图标名） | **已修** | `ui/js/ui/drawer.js`、`ui/js/push.js`、`ui/js/boot.js`、`ui/js/ui/pager.js`、`ui/js/ui/board.js`、`ui/js/ui/overview.js` |
| §2 V2 修过、V1 仍有（200+ 非 JSON 静默成空列表 / `setStale` 无条件点亮「失去联系」/ toast 每条播报两遍 / `debounce` 无 `cancel` / 跳页 `blur()` 丢焦点 / `formatSize(0)` → `—`） | **已修** | `ui_old/js/api.js`、`main.js`、`components/toast.js`、`components/toolbar.js`、`dom.js`、`components/pagination.js`、`format.js` |
| §3 竞态/重入：登录页被重复求值、`dialog` 在异步删除中被 Esc/`✕` 关掉 | **已修** | 两版 `login.js`（`appBooted` 幂等守卫）、`ui/js/ui/dialog.js`（`canClose`） |
| §5.1 时钟差方向说反 | **已修**（文案改为直接点名「本机」，不再让读者倒推符号约定） | `ui/js/format.js` 的 `describeClockSkew` |
| §5.2 `formatSize(0)` | **已修**（`0 B`；小于 1 KB 也取整） | `ui_old/js/format.js` |
| §5.3 按 UTF-16 码元切分 / 计数 | **已修**：新增 `truncateText()` / `charCount()`（优先 `Intl.Segmenter` 的字素簇，退回 `Array.from` 的码点）；6 处 `.length`（`ui/js/boot.js`×2、`ui_old/js/main.js`×4）与 2 处 `slice(0, 40/80)` 全部改用它 | 两版 `format.js`、两版 `messages.js`、`ui/js/ui/row.js`、`ui/js/boot.js`、`ui_old/js/main.js` |
| §5.4 分组标题与行内时间用了不同字段 | **已修**（行内时间改用 `createTime`，与分组键同源） | `ui/js/ui/row.js` |
| §6.1 ≤720 列表头里那个"看不见但 Tab 得到"的排序按钮 | **已修**（`.board__head-row .sort-btn { visibility: hidden }`，退出 Tab 顺序） | `ui/css/board-v2.css` |
| §6.2 触屏命中区只有 3 个控件达标 | **已修**（coarse 下 `--control-h` / `--control-h-sm` 提到 `--hit-min`） | `ui/css/tokens-v2.css` |
| §7 服务端契约的两条缝 | **未改**（不在无授权的范围内做协议/服务端改动） | —— |
| §8 安全：没有可举证的注入缺陷 | **不重复做** | —— |
| 无障碍：状态区 `sr-only`、表格语义 `role`、窄屏刷新入口 | **已修** | `ui/js/ui/appbar.js`、`ui/js/ui/board.js`、`ui/js/ui/row.js`、`shell-v2.css` |

### 12.1 修复过程中**新发现**的一条（§5.3 的附带）

`--fs-display` 是**孤儿令牌**：定义在 `tokens-v2.css`、被 `shell-v2.css` 的 `≤380px` 分支改过、
在 `overview.js` 的注释里被当作"主数字的字号"引用 —— 但 `.overview__value` 实际挂的是
`--fs-title`（**17px**）。⇒ 那条「极窄时数字降一档、避免换行」**是死规则**。

**本轮不动视觉**（把主数字改成 24–30px 是设计决策，不是修缺陷），只把事实写进
`overview.js` 的注释与 `shell-v2.css` 的规则上方，并在 `docs/ui-v2-design.md` 的令牌表里
标注"当前无消费者"、在 `docs/ui-v2-audit.md` 的"未使用令牌已清零"后补例外。
**留给下次的定案**：让主数字用回 `--fs-display`，或删掉令牌与那条 `@media`。

### 12.2 明确不改

| 条目 | 理由 |
|---|---|
| §3 里构造不出触发路径的两条（260 ms 兜底 drop 的时序、`toolbar.js` 的 `reduce` 拼接） | §9 已降级 |
| `ui_old/js/components/preview.js` 的「N 个字符」 | 它读的是**服务端 `size` 字段**，不是 `text.length`；改它要动服务端语义 |
| 服务端 `src/ui/query.ts` 的 `truncateText` | 它按**码元**计的 500 是协议上限（`UI_LIST_TEXT_LIMIT`），与展示层口径不同 —— **不要合并这两个函数** |
| 删掉的是**最后一行**（列表变空）时焦点仍落 `<body>` | `removeItem` 此刻拿不到空状态的主按钮（那要等渲染完成）；V1 有这一档、V2 没有，见 `board.js` 的 `neighborButton` 注释 |

