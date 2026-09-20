# 前端走读报告（第三轮）：跨版漂移与遗留缺陷 —— 2026-09-19

> 性质：**只读走读**，不是修复。本文件只回答"还有什么没被前两轮盖住"，每条给 `文件:行` 证据与一条最小修法。
> 前两轮（`AUDIT-missing-states.md` 找"缺失"、`docs/archive/AUDIT-v1-v2-divergence.md` 找"分歧"）已在 `d0c58bd` 落地，
> 本报告刻意**不重复**它们已登记的条目（如 V2 `removeItem` 删末行焦点落 `<body>`，见 `AUDIT-missing-states.md` §3.1）。
>
> 与前两轮的分工：它们是"按判据全库扫"，这一轮是"**对侧已有验证过的修法，本侧漏了没**"的定向比对 ——
> 两版同一份 `messages.js` 由对等守卫钉着，但**行为**没有守卫：一版修好的缺陷，另一版往往还留着。

## 0. 结论速览

| # | 级别 | 现象（一句话） | 处 | 修法来源 |
|---|---|---|---|---|
| F1 | 🔴 缺陷 | 后台标签错过的变更**回前台不立即自愈**：标记已被推进 ⇒ 不补刷，闪帧永久丢失（数据最迟下一个可见轮询周期拉齐） | `ui/js/boot.js` | V1 `missedWhileHidden` 同一份判据 |
| F2 | 🔴 缺陷 | 销毁性确认框在**请求在途**时可被 Esc 关闭 ⇒ `ask()` 结算成"取消"，删除已生效而界面收行/刷新被整段跳过 | `ui_old/js/components/confirm.js` | V2 `dialog.js` 的 `canClose`（d0c58bd） |
| F3 | 🔴 缺陷 | 选择集跨**类型/收藏/时间范围**筛选残留：切走 chip 后仍能"删除选中"那些**看不见**的行 | **两版**（V1 在选择条常驻，更危险） | 两版都在 `setFilters` 统一清（见 §3 的自我修正） |
| F4 | 🟠 漂移 | 概览快照失败就点亮失联横幅 —— 列表可能好好的，一张锦上添花把整页标成"可能不是最新" | `ui/js/boot.js:589` | V1 刻意不这么做（`main.js:421-423`） |
| F5 | 🟠 缺陷 | 收藏/置顶成功后，**选择集里那份对象不同步**：选择条的方向按旧快照算（"已置顶还说置顶"） | `ui/js/boot.js:702` | V1 `main.js:538-544` 同步选择集 |
| F6 | 🟡 隐患 | `createLatestGate.begin()` 的竞态靠"先 begin 再 await"的调用纪律维持，无机制断言 | 两版 `latest.js` | 见 §4 |
| F7 | 🟡 漂移 | 轮询失败后的**下一次排程**两版挂在不同位置（V1 在调用方、V2 在 `finally`），时序 dependency 不对称 | 见 §4 | 对齐即可 |
| F8 | 🟡 优化失效 | 切排序字段时 `dayMap` 被**整体清空**（`groupCounts` 为 null 的分支），分组节点复用失效 | `ui/js/ui/board.js:411` | 见 §4 |

---

## 1. F1 —— V2 后台标签错过的变更：回前台不立即自愈

**证据**
- `ui/js/boot.js:634-667`：`pollOnce()` 在变更标记变化时**无条件** `refresh()` + `refreshOverview()`，不判 `document.visibilityState`。
- 同文件 `:1174-1187` 的 `visibilitychange`：回前台只做 `pushChannel.start()` + `void pollOnce()`，**没有补刷**。
- 对照 V1 `ui_old/js/main.js:1115, 1142-1150, 1297-1301`：专设 `missedWhileHidden` 旗子，后台时只记旗不刷新，回前台先补一次再轮询。

**机理**：浏览器对隐藏标签的 `setTimeout` 节流（≥1s/分钟级）会让"不可见时的整页刷新"白跑；更关键的是 **marker 已被照常推进**，回前台那一刻 `unchanged` 为真 ⇒ 不补刷。列表停在离开时的样子，且**丢掉的"新行闪帧"永远补不回来**。

> 复核修正（2026-09-19 子代理）："永久"略严 —— `visibilitychange` 的 visible 分支会 `schedulePoll()`（`boot.js:1186`），可见态下 `POLL_VISIBLE`（10s）轮询仍在跑，故列表最迟在**下一个可见轮询周期**被拉齐；真正不可恢复的是**及时性与闪帧**，而不是数据本身。结论仍成立（缺补刷路径、丢闪帧），措辞从"永久不自愈"放宽为"回前台不立即自愈、且闪帧永久丢失"。

**修法（移植 V1）**：`pollOnce` 的 changed 分支里 `visible` 才刷新、`hidden` 只置 `missedWhileHidden = true`；`visibilitychange` 可见分支里若旗子为真则先 `refresh({silent:true, flash:true})` 再 `pollOnce()`。

## 2. F2 —— V1 确认框在途时可被 Esc 关闭（"以为取消了，其实删成了"）

**证据**
- `ui_old/js/components/confirm.js:91-104`：在途时只 `cancelButton.disabled = true; closeButton.disabled = true`。
- 同文件 `:110`：`dialog.addEventListener('cancel', () => settle(false))` —— **Esc 的 `cancel` 事件不被 `disabled` 挡住**，照样结算成 `false`。
- 调用方 `ui_old/js/main.js:567-593`（`deleteItem`）：`if (!ok) return false` 早退，于是 `list.removeItem` / `refreshStats` / `refresh({silent:true})` / toast **整段被跳过**，直到 ≤10 秒后下一次轮询才无声收掉那一行。

**对照**：V2 在 d0c58bd 已修同一处 —— `ui/js/ui/dialog.js` 的 `canClose` 同时在三处出口（✕ onclick / 取消按钮 / `cancel` 事件）拦截，`cancel` 用 `event.preventDefault()` 挡下。审计文档把这条记在 divergence §3.1 的 **V2 侧**，本报告确认 **V1 是它的另一半**。

**修法（移植 V2）**：给 `createConfirm` 加 `busy` 旗子；`ask` 接 `canClose`（默认 `() => !busy`）；`cancel` 事件里 `if (!canClose()) event.preventDefault()`，✕ 与取消按钮的 onclick 同样先过 `canClose()`。失败时 `busy = false` 放开。

## 3. F3 —— V1 选择集跨筛选残留（能对看不见的行执行批量删除）

**证据**
- `ui_old/js/main.js:194-198`：`onToggleDeleted`（进出回收站）清了选择集。
- 但 `:190-208` 的 `onTypes` / `onToggleStarred` / `onRange` / `onSort` / `onPageSize` **都不清**。
- 选择集是跨页保留的（`:56` 注释写明是设计），批量删除按选择集逐条在服务端执行（`runBatch` → `api.batchUpdate`）。
- 于是：选 3 条文本 → 点「图片」chip → 选择条仍显示"已选 3 条"→ 点「删除选中」把列表里**看不见**的 3 条文本删掉。

**对照**：V2 在 `boot.js:156-159` 只清了 `onToggleDeleted`；但其 `setFilters`（`:452-477`）被所有筛选动作共用 —— **经复核 V2 的 `setFilters` 本体也不清选择集**，清选择集只发生在 `onToggleDeleted` 与 `resetFilters`。故本条的正确口径是：**两版都只对"进出回收站/复位"清选择集，其余筛选变更都残留**；V1 更危险只是因为它的"删除选中"在选择条上常驻。

**修法**：在 `setFilters` 里对"会改变结果集成员资格"的 patch（types/starred/range/after/before/deleted/**search**）统一清选择集；排序/翻页/页大小不清（它们不改变集合）。两版同一判据。

> **2026-09-19 复查补正**：上面这份初版清单与 §6 的实施记录都把 `search` 归为"不改变集合"，**那是错的** ——
> 服务端为它生成 `Text LIKE ?`（`src/ui/query.ts:196-202`），被它滤掉的行看不见、却仍留在选择集里，
> 与 F3 **完全同型**（勾选若干行 → 搜索 → 批量删除 = 对看不见的行动手）。`search` 已补入两版的
> `MEMBERSHIP_KEYS`，两版注释与本节同一次改掉。

## 4. 其余条目（隐患 / 漂移）

**F4 · 失联判据分叉** —— V2 `refreshOverview()` 失败即 `setStale(true)`（`boot.js:589`）；V1 在同一路径刻意不这么做 —— 证据在 `main.js:421-423` 的函数头注释（"失败不阻断首屏…**也不打开失联横幅**"），其失败路径（`:467-473`）只 `console.warn`。**定一个口径**：建议按 V1 —— 失联横幅只属于列表与轮询这两条关键路径。

**F5 · V2 选择集对象不同步** —— `boot.js:702-715` 的 `toggleFlag` 只更新了 `items` 里那份，**没同步 `selection` 里那份**；选择条的方向文案读的是选择集对象。V1 在 `main.js:538-544` 明确同步了选择集（注释写的就是这个坑）。**修法**：`toggleFlag` 成功后若 `selection.has(key)` 就把选择集里那份换成 `next`。

**F6 · `latest.js` 竞态靠纪律维持** —— `begin()` 先 `controller?.abort()` 再 `seq += 1`：abort 是同步派发的，但"旧请求在 abort 回调与 seq 递增之间走到 `isCurrent`"这条不变式目前全靠"所有调用点都先 begin 再 await"维持。当前无实际触发路径；若担心，给 `isCurrent` 加一句 `ticket.seq === seq && !ticket.signal.aborted`。

**F7 · 轮询排程位置不对称** —— V1：`schedulePoll` 的回调里 `await pollOnce(); schedulePoll();`（`main.js:1163-1166`）；V2：`pollOnce` 的 `finally` 里 `schedulePoll()`（`boot.js:665`）。两者都正确，但 V1 的 `visibilitychange` 可见分支 `void pollOnce(); schedulePoll();` 未 await 就排程，与定时器链并存一瞬（由 `schedulePoll` 开头的 `clearTimeout` 收掉）。对齐成 V2 的 `finally` 形态更省一条纪律。

**F8 · 分组节点复用在"切排序"时失效** —— `ui/js/ui/board.js:411`：`grouped` 为 false 时 `countGroups` 是 `null`，清理条件 `!groupCounts?.has(key)` 恒真 ⇒ `dayMap` 整体清空；切回时间排序时全量重建。正确（不残留）但复用失效。修法：只在 `grouped` 为 true 时做增量清理，false 时保留 `dayMap` 不动。

---

## 5. 复核记录

| 日期 | 复核人 | 范围 | 结论 |
|---|---|---|---|
| 2026-09-19 | 走读作者 | 全部 8 条 | 初版 |
| 2026-09-19 | 子代理（独立复核） | F1–F8 逐条对代码原文 | **8/8 论断成立**；3 处引证修正（F1 措辞放宽、F4 行号改为 `main.js:421-423`、F8 路径补为 `ui/js/ui/board.js`），均已回填 |

---

## 6. 实施记录（2026-09-19）

按"对侧已有验证过的实现可移植"的原则落地 **F1 / F2 / F3 / F5** 四条；F4 / F6 / F7 / F8 属隐患与优化失效，按"最简即默认"未连带改动。

| # | 落地 | 改了什么 |
|---|---|---|
| F1 | ✅ V2 `boot.js` | 新增 `missedWhileHidden` 旗子：`pollOnce` 的 changed 分支按 `visibilityState` 分流（可见即刷新、隐藏只记旗），`visibilitychange` 可见分支先补刷再重连推送。移植 V1 同名机制。 |
| F2 | ✅ V1 `confirm.js` | 新增 `busy` 旗子：在途时 ✕ / 取消按钮经 `tryDismiss` 被挡（`if (busy) return`），Esc 的 `cancel` 事件用 `event.preventDefault()` 拦截。移植 V2 `dialog.js` 的 `canClose` 语义。 |
| F3 | ✅ 两版 | 两版各自加 `MEMBERSHIP_KEYS = ['types','starred','deleted','range','after','before','search']`，在 `setFilters` 里统一清选择集；`onToggleDeleted` 里原来各清一份的代码删除（同一件事两处写必然漂移）。排序/翻页/页大小**不清**（不改变集合）；**`search` 要清** —— 见 §3 的复查补正（初版误记为"不改变成员资格"，实际服务端为它生成 `Text LIKE ?`）。 |
| F5 | ✅ V2 `boot.js` | `toggleFlag` 成功后若 `selection.has(key)` 就把选择集里那份换成归一化后的 `next`，并 `board.syncSelection` —— 移植 V1 `main.js:538-544`。 |

**门禁**：`tsc --noEmit` 0 错、`eslint public/ui/js public/ui_old/js` 0 告警、`vitest run`（ui-logic / ui-guard / ui-contract / ui-input / ui-activity / next-target 六套件）**107/107 过**。未跑全量 22 套件（多数要求 8787 端口的 dev server 在本地未起）；未做 `docs/ui.md` §11 的浏览器探针。

**遗留（明确不做）**：F4（失联判据分叉）需先定"概览失败算不算失联"的口径；F6/F7 是纪律维持的时序，当前无触发路径；F8 是优化失效而非正确性问题。四条都在 §4 留了判据，将来要动时按那里改。
