# SyncClipboard CfServer 代码审计报告：冗余、重复实现、死代码与可优化点

> **审计前提**：本项目是**从未正式发布的测试开发版**，不需要保留向后兼容与历史升级包袱，可以放心做破坏性清理。
> **审计范围**：`src/**`（29 个 TS）、`test/**`（28 个）、`public/ui/**`（V2）、`public/ui_old/**`（V1）、`docs/**`（13 个）、`tools/**`、根配置与构建脚本、`.github/workflows/deploy.yml`。
> **审计日期**：2026-09-18
> **性质**：**只做分析与文档产出，未改动任何业务代码。** 本次审计在版本库中只新增/改写本文件一个文件。
> **修订说明**
> **第一轮**：经 4 个独立子代理复查（事实核验 / 遗漏与误判 / 可落地性与风险 / 内部一致性）后修订。复查发现的 1 处实质事实错误与 5 处小偏差已全部修正；复查补充的落地约束已并入正文与 §12。
> **第二轮（2026-09-18 晚）**：新增**上游 C# 源码对照**（`C:\Users\leeexx\Documents\NewProject\SyncClipboard`，检出 HEAD = `28c7e5963b8329e40586175eeeda326597c3e732`，**与本文所述基线 `28c7e596` 逐字一致**——已核对 `.git/refs/heads/master`）。据此新增 §13「上游对照：兼容性结论」，并**按两条已定定位重排优先级**：`public/ui_old` = 产品/默认界面；`public/ui`（V2）= 开发版、**允许以后破坏性重构**。因此：V2 内部死代码从 P0 **降级**；"把 V1 的三处修复回移到 V2"改写为"**写进 V2 重写的验收清单**"；§10 的三选一产品决策改为**已定策略**；并补齐原先遗漏的 **V1（产品面）死代码**（D-13）。
> **第三轮（2026-09-18 晚，与 `docs/AUDIT-commit-9b4cdca.md` 合并后执行）**：本文不再只是审计报告，**已按 §14 落地了一批改动**（P0-a 全部 + P1 的主要项 + V2 的零成本项）。§14 是唯一的执行记录，并登记了**三处对本文自身判定的勘误**（O-08g、D-05 的文档连带、D-13 的 export 收敛）与**明确不改**的清单。**读 §2 的路线图时请配合 §14 一起看** —— 路线图描述的是"应该怎么做"，§14 描述的是"已经做了什么、以及哪些刻意没做"。

---

## 目录

- [0. 方法与证据等级](#0-方法与证据等级)
- [1. 总体结论](#1-总体结论)
- [2. 处理优先级路线图](#2-处理优先级路线图)
- [3. 前置必读：对既有审计文档的勘误](#3-前置必读对既有审计文档的勘误)
- [4. 死代码（D-01 ~ D-13）](#4-死代码d-01--d-13)
- [5. 兼容层与适配代码（C-01 ~ C-09）](#5-兼容层与适配代码c-01--c-09)
- [6. 冗余与重复实现（R-01 ~ R-08）](#6-冗余与重复实现r-01--r-08)
- [7. 可优化点（O-01 ~ O-09）](#7-可优化点o-01--o-09)
- [8. 测试套件（T-01 ~ T-10）](#8-测试套件t-01--t-10)
- [9. 文档 / 构建 / CI（M-01 ~ M-07）](#9-文档--构建--cim-01--m-07)
- [10. 双前端：定位已定（V1 产品 / V2 开发版）与 N-01 ~ N-05](#10-双前端定位已定v1-产品--v2-开发版与-n-01--n-05)
- [11. 待确认清单（含验证方式）](#11-待确认清单含验证方式)
- [12. 变更影响面与验证清单](#12-变更影响面与验证清单)
- [13. 上游对照：兼容性结论（基线 28c7e596）](#13-上游对照兼容性结论基线-28c7e596)

---

## 0. 方法与证据等级

**通读方式**：`src/**` 全部 29 个文件、根配置（`package.json` / `wrangler.toml` / `tsconfig.json` / `vitest.config.ts` / `eslint.config.js` / `schema.sql` / `.dev.vars*` / `.gitignore` / `public/_headers`）、`README.md` 由主审计人**逐行通读**；`test/**`、`public/ui/**`、`public/ui_old/**`、`docs/**`、`tools/**`、`.github/workflows/**` 由 4 个并行子代理**各自穷尽通读全部文件**（无抽样、无跳过）并返回带行号的证据，主审计人再对高影响结论逐条独立复核。

**证据分级**（全文条目均标注）：

| 标记 | 含义 |
|---|---|
| `[已复核]` | 主审计人亲自打开该行 / 对该符号做了全仓检索确认，或经复查子代理逐行验证 |
| `[通读]` | 由穷尽通读该文件的子代理提供，行号与代码片段随报告交出；未逐条复核，但来源是该文件的完整阅读而非抽样 |
| `[待确认]` | 静态阅读无法定论，需按 §11 的方式实测 |

**条目模板（§4~§9 的正文条目统一采用）**：文件与位置 / 类别 / 严重级别 / 具体说明 / 建议方案与预期收益 / 改动风险与注意事项。
**表格式简写**：§5.B、§7 的 O-08 表、§8 的 T-10 表采用表格承载，列即要素——凡表格缺失的要素（如 O-08 原缺"建议/收益/风险"）已在本次修订中补齐列。

**外部编号释义**（本文条目编号 D-/C-/R-/O-/T-/M-/N- 与外部体系的编号形近，避免混淆）：

| 外部编号 | 出处 | 含义 |
|---|---|---|
| `F1`~`F33` | `src/**` 注释、`test/fixes.test.ts`、`test/fix-regressions.test.ts` | 一轮"核心契约加固 + 审计"中登记的缺陷编号 |
| `G1`~`G6` | `test/hardening.test.ts`、`src/**` 注释 | 同一轮审计的"审计残余"条目编号 |
| `ADR D1`~`ADR D18` | `docs/design.md` | 设计决策记录（**与本文 D-01~D-12 无关**） |
| `upstream-defects.md D1` | `docs/upstream-defects.md` | 上游缺陷的处置条目编号 |
| `§NN` | `docs/progress.md` | 该文件的轮次小节号 |

**一处工具教训**：最初用 PowerShell `(Get-Content … | Measure-Object -Line).Lines` 统计行数，结果**系统性低估约 7%**（它给 `src/index.ts` 报 270 行，而逐行读取实际为 289 行）。因此本报告**不采用**该次统计；所有行数/行号来自逐行读取（Read 的行号）或 `grep -c '^'`——后者已用 `test/fixes.test.ts` = 1085 行、`docs/progress.md` = 5278 行、`README.md` = 504 行与逐行读取交叉验证一致。

---

## 1. 总体结论

**这个项目的工程质量高于它自己的"测试开发版"定位。** 它不是一个堆满历史包袱的仓库：`src/` 的每一处"看起来奇怪"的写法，绝大多数都能在 `docs/protocol.md` 的差异表或 `docs/design.md` 的 ADR 里找到**明确的、有实测支撑的决策记录**（路径大小写归一、三种 SignalR 传输、哈希与上游逐字节对齐、宽松 catch 对齐上游等）。真正属于"无价值残留"的死代码总量**远小于**项目体量。

**本报告的核心结论与常见的"大清理"预期不同：**

1. **可安全删除的死代码是"零散的"，不是"成片的"**：§4 共列 **12 条**，其中 10 条为 Low（未引用的导出、未调用的方法、无生产者的 CSS 规则、不可达分支、引用了不存在路径的条件）、2 条为 Medium（D-05 注释与事实相反、D-08 是一个真实的**功能缺口**而非冗余）。合计约 200~300 行。其中 D-05 与 D-08 处置方式不同，**不应与纯删除项混在一起执行**（见 §2）。
2. **最大的"冗余体积"是双前端并立（`public/ui` 与 `public/ui_old`）**，但**这不是可以单方面"清理"的对象，而是一个产品决策**：两版各有对方**缺失的修复**（见 §10.1c），且 `docs/ui.md` 明确记录了保留理由。既有审计文档把它判为 P0「直接删除 V2」，并顺带主张删除三个服务端端点——**后一条是事实错误**（那三个端点 V1 也在用，删掉会打断默认界面，且会撞 `test/ui-guard.test.ts` 的路由盘点断言）。见 §3、§10。**（第二轮更新：定位已定 —— `ui_old` 是产品/默认界面，`public/ui` 是允许破坏性重构的开发版；因此**不要删任何一版、也不要跨版抽公共模块**，改为「产品面优先 + 把 V1 已修缺陷写进 V2 重写验收清单」。见 §10.2、§13.3、N-05）**
3. **收益最高的技术改动不是删除，而是修两处具体缺陷**：① `/ui/api/overview` 每次请求把 `statistics` / `countByTypeViews` / `totalHistorySize`（R2 全桶扫描）**各重复执行一次又一次**；② V2 前端**回退了 V1 已修的三个缺陷**。这两项的收益（性能与正确性）比删掉几百行死代码更直接。见 §7 O-01、§10.1c。**第二轮的两点更新**：① 统计端点 `/api/history/statistics` **官方客户端并不调用**（已对 `OfficialAdapter.cs` 全文件 Grep 确认），所以 O-01/O-02 是「让自己界面变快」，**不是兼容问题**（§13.2 #7）；② V2 那三处按已定定位不再"回移"，而是**写进重写验收清单**（§10.2 第 4 条、§13.3、N-05）。
4. **测试套件是"重复实现"最集中的地方**，而不是产品代码：内存 D1 替身 4~5 份、multipart 构造器 5 份、递归 walker 3 份（其中 2 份在同一个文件里）、`stripComments` 3 份；还有一处**高危**——`test/hardening.test.ts` 逐行复刻了 `src/ui/session.ts` 的密钥派生管线用于伪造会话。见 §8。
5. **文档层有真实的时效性风险**：`docs/progress.md` 已 5,278 行（按轮次累积的历史快照），其中把 `ui_old` 描述为「冻结存档」的段落已被后续 §70「V1 成为默认界面」推翻；而 `test/docs.test.ts` 把 `README.md` / `design.md` / `ui.md` / `deploy.yml` 的「22 个套件」「87 个资源」做成了**会红的断言**——改文档与改代码必须同步。见 §9。

6. **「对齐上游」的投入是真的 —— 已经过上游源码验证**：第二轮把 `src/` 里所有"为对齐上游 ASP.NET Core 而多出来"的实现逐条落到上游 C# 源码上（基线 `28c7e596`，**并已核对上游检出 HEAD 与该基线逐字一致**）——三种 SignalR 传输（`Web.cs:38` 只有 `AddSignalR()`）、批量 500（`HistoryManagerHelper.cs:19/66`）、File→Image 提升（`Profile.cs:237-239`）、5 个从不写入的镜像列（`HistoryRecordEntity.cs:18-19,44-46` + `Mapper.cs:22` 仅置 `ExtraData=null`）、统计口径=遍历磁盘求和（`HistoryService.cs:653-663`）、软删逐条广播 / 硬删不广播（`HistoryService.cs:614-618` vs `:516-536`）、工作目录命名与拒路径分隔符（`Profile.cs:162-170`）、`/api/version` 的真实取值 `3.2.0`（`Directory.Build.props:4`）——**逐条对上**。⇒ 这些**不是包袱**；既有审计文档点名的 `src/pathCase.ts`、SSE/长轮询、`tools/ab-upstream-probe.ps1`、限速系统**尤其不要清**。详见 §13。
7. **一项有用的反向事实**：官方客户端（SyncClipboard 类型）实际只用「`/api/version` + `SyncClipboard.json` + `/file/*` + `PROPFIND` + `/api/history`（query / 单条 / data / PATCH / POST）」这一小片端点面——**`/api/history/statistics` 与 `/api/history/clear` 客户端都不用**（后者只有本站界面用），且 `PROPFIND` 的响应体在默认配置下**从不被解析**（只判状态码）。这既解释了若干"看起来多余"的实现为何无害（§13.2 #7、#11），也意味着改动这些端点**不需要担心打断客户端**。

> **两条排序是刻意不同的，请不要混读**：
> - **收益排序**（做什么最值）：修 O-01 / 回移三处前端修复 → 抽共享实现 → 删零散死代码 → 定双前端方向。
> - **执行风险排序**（先做什么最安全）：删零散死代码（P0，零风险）→ 抽共享实现 → 修缺陷 → 产品决策 → 兼容层取舍。
> 具体分级见 §2。

**一句话**：**零风险先行**——先清产品面死代码（P0-a）→ **收益最高**——修两处缺陷（P1）→ 抽共享实现（P2/P3）→ 双前端按既定定位收尾（P4：产品面优先、V2 只做零成本项、把 V1 已修缺陷写进重写验收清单）→ 兼容层只在"愿意放弃对上游逐字对齐"时才动（P5）。

---

## 2. 处理优先级路线图

> 说明：本表的"优先级"是**执行顺序/风险排序**（P0 最先、风险最低）；每条发现自带的"严重级别"是**影响程度**。两者是两套标尺，刻意不同——例如 M-01 影响面是 High，但它的执行风险极低（属"须知"而非"任务"）。

| 优先级 | 阶段 | 条目编号 | 目标 | 预期收益 | 主要风险 |
|---|---|---|---|---|---|
| **P0-a** | 零风险死代码清理（**产品面 `ui_old` + `src/` 共用**） | **D-01、D-02、D-03、D-04、D-12、D-13** | 删除无引用导出/未调用方法/不可达分支/死 id/死配置 | 净删约 100 行；消除"注释与事实相反"与"死 id/死导出" | 极低。**两处注意**：D-04 需同一次改完 3 处；D-13 中部分 `export` 可能被测试依赖，须逐条按 §4 D-13 的标注核对 |
| **P0-b** | V2 内部死代码清理（**已降级，可选**） | **D-05、D-06、D-07、D-09、D-10、D-11** | 同上，但对象是 V2 | 净删约 100~150 行 | 极低，**但价值低**：V2 允许破坏性重构，这些多半会随重写自然消失（§10.2）。**除非确认 V2 近期不重写，否则不必单独做**。其中两处仍值得顺手修：D-05（V2 注释与事实相反 + 与 `docs/ui.md:159` 口径冲突）、D-06（注释为一个不存在的 API 辩护） |
| **P1** | 修缺陷（收益最高，**产品面优先**） | **O-01（含 O-02）、O-07、D-08、O-06、T-01、§13.3 三处修复** | ① `overview` 去重查询（产品面性能）② V2 补 `retryAfterSeconds` ③ 修测试复制生产 crypto ④ **把三处「V1 已修 / V2 回退」的缺陷写进 V2 重写的验收清单** | ① 首屏 R2 全桶扫描从 2×N 降到 N ② 429 时能看到还要等多久 ③ 消除安全测试的失真风险 ④ 让 V2 重写不再带回这三个已知缺陷 | 低—中。**两处硬约束**：O-02 改 D1 聚合会构成**未登记的协议偏离**（上游证据见 §13.2）；改 `api.js` 超时会撞 `test/ui-input.test.ts:181`。O-01 若**只做去重、不改统计口径**，风险低 |
| **P2** | 抽共享实现（产品代码） | **R-01 ~ R-08、O-03、O-08a/b/d/e/h/i/j/k、C-09** | 合并同源工具函数与薄封装 | 删约 200~250 行；消除"两处各写一份→迟早分叉" | 低—中。R-01 涉及协议序列化，**必须先补 golden 测试**；R-05 必须精确保留 `pages` 记账语义 |
| **P3** | 抽共享夹具（测试） | **T-02 ~ T-06、T-10a/b/f/h** | 内存 D1 / multipart / zip / walker / stripComments 归一 | 删约 400~600 行；消除测试与生产的算法复制 | 低—中。T-06 需**拆成"JS 归一 + CSS 单独处理"**（两种语言，判据不可共用） |
| **P4** | 双前端**已定策略下的收尾**（不再是"待决策"） | **N-01、N-02、N-03、N-05、R-08、O-08d**（C-01/C-02 见下方「明确不做」） | 定位已由项目方明确：**`public/ui_old` = 产品/默认界面；`public/ui`（V2）= 开发版，允许以后破坏性重构**。因此不做 A/B 收敛，改为"补 V1（产品面）的守卫与缺口 + 把 V2 的验收基线钉住" | 保住产品面质量；让 V2 重写有明确的验收清单 | 中。**§10.2 的路线 A/B（收敛到任一版）当前均不做**——理由与完整连带改动清单保留在 §10.2 备查（含两处必须知道的地雷：路线 B 的 302 目标应为 `/ui/app/` 而非 `/ui/`；删除任一前端目录都会让 `npm run lint` 因 CLI 路径不存在而红，见 M-07） |
| **P5** | 兼容层取舍（**不是清理**） | **C-03 ~ C-08、O-05**（O-04 见下方「明确不做」） | 逐项决定是否放弃某条"对上游逐字对齐"的契约 | 视决策而定 | **高**：会变成"有意偏离上游"，需同步改 `docs/protocol.md` 差异表与多条测试。**动手前先读 §13**（上游证据已核验到位） |
| **P6** | 文档 / CI 时效 | **M-01 ~ M-07** | 给历史文档加导航、修正既有审计文档、登记文档-测试硬耦合点 | 消除"旧快照被当现状引用"的误判源 | 极低 |

**明确不做（已在正文登记原因，非遗漏）**：

| 条目 | 位置 | 为什么不做 |
|---|---|---|
| O-04 | `src/profile.ts:244-271` | PUT 路径全量内存缓冲是**已登记的架构限制**：`README.md:439-441`、`docs/design.md` §7.1、`docs/progress.md` §48.4 都记有"R2 无 move/rename、峰值≈文件大小"的推导与"改成流式＝架构级改动、当前不做"的结论。**不要因"顺带优化"而降低其等级** |
| O-08c | `src/ui/routes.ts:158-189` | `parseRangeHeader`/`resolveRange` 是"有意的最小实现"（不做多段 Range、不做 If-Range），实现正确、注释充分 |
| C-05 | `src/db.ts:274-284` vs `src/ui/query.ts:196-202` | 协议面不转义 / UI 面转义是**有意分面**，两侧都有注释与 `docs/protocol.md` §10 登记。**不建议统一** |
| C-06 | `src/db.ts:149-153` | hash 等值匹配（上游是 LIKE 模式）属有意偏离，处置决定已记在 `docs/upstream-defects.md` 的 D1 |
| §5.C 全部 | 前端/后端运行环境适配 | 移除会让代码在真实运行环境里坏掉（不是"少一个历史包袱"） |
| **§10.2 路线 A / 路线 B** | 双前端 | 定位已定：`ui_old` = 产品/默认界面，V2 = 开发版且**允许破坏性重构**。⇒ **当前不收敛**。A/B 都要连带改 6+ 处"文档-测试硬耦合"、删/改 6~8 个测试文件、改 `package.json` 的 lint 路径，而 V2 本身还可能被重写——当前规划下收益为负。完整清单保留在 §10.2，供将来真要收敛时直接取用 |
| C-01 / C-02 | `public/ui/index.html` + `redirect-hash.js`；`public/ui/js/filters.js:123-128` | 都属 V2。V2 既然允许破坏性重构，**删 V2 内部的小壳子不如等重写**。C-02 另需先按 §11 #5 确认语义 |

---

## 3. 前置必读：对既有审计文档的勘误

本仓库在本次审计前**已存在一份同名文档**（`docs/AUDIT-redundancies.md`，353 行，日期 2026-09-18）。它结构完整、方向有价值，但**其"文件:行"引用错误率很高**。本节先给出勘误，因为**照抄它的行号会改错文件**（最危险的一条是会把 5 个**活跃列**当死列删除）。

### 3.1 核对结果

| # | 旧文档断言 | 核对结果 | 实际位置 / 说明 |
|---|---|---|---|
| 1 | `src/pathCase.ts` 共 86 行 | ✅ 符合 `[已复核]` | 逐行读取为 86 行 |
| 2 | `test/fixes.test.ts` 1,085 行 | ✅ 符合 `[已复核]` | `grep -c '^'` = 1085 |
| 3 | `test/fix-regressions.test.ts` 892 行 | ✅ 符合 `[通读]` | 892 |
| 4 | `src/cleanup.ts` 639 行 / `src/rateLimit.ts` 350 行 | ✅ 符合 `[已复核]` | 639 / 350 |
| 5 | `schema.sql:8-10, 16-18` 是「死列」 | ❌ **实质错误，危险** `[已复核]` | L8=`Size`、L9=`TransferDataFile`、L16=`LastModified`、L17=`Stared`、L18=`Pinned` —— **全部是被读写的活跃列**。真正的死列在 **L10 `TransferDataSha256`、L11 `TransferDataMd5`、L19 `"From"`、L20 `Tags`、L21 `ExtraData`** |
| 6 | `src/db.ts:44-70, 89, 102, 213, 227` 是「6 个死列相关」 | ❌ 表述错 `[已复核]` | 这些行确实都是 **`FilePaths`** 相关（`DbRow.FilePaths` / `JSON.parse` / `JSON.stringify` / INSERT / UPDATE）。**但那 5 个死列在 `db.ts` 里根本不存在**（`DbRow` 与 `entityParams` 都不含），所以"删这 6 处"的说法自相矛盾 |
| 7 | `src/profile.ts:240-255` 是「PUT 全量内存缓冲」 | ❌ 行号错位 `[已复核]` | 真正的缓冲块在 **L244-271**：`getTemp`=L249、`new Uint8Array(await temp.arrayBuffer())`=**L261**、`validateAndPersistData`=L263、`deleteTemp`=L270。240-255 恰好**不含**它引为证据的 `arrayBuffer()` 那一行 |
| 8 | `src/ui/routes.ts:546-590` = `/ui/api/overview`；`528-544` = `/activity`；`602-635` = `/batch-meta` | ❌ 行号全错 `[已复核]` | 实际：`statistics` L530-551、`info` L553-556、`activity` **L563-572**、`overview` **L583-602**、`poll` L604-611、`batch-meta` **L617-652** |
| 9 | `src/storage.ts:182-194` 是 `totalHistorySize` | ❌ 错 `[已复核]` | `totalHistorySize` 在 **L199-210**；182-194 是 `deleteHistoryDirs` 的内部 |
| 10 | `totalHistorySize` 的调用点是 `routes/history.ts:167`、`ui/routes.ts:60, 503` | ❌ 全错 `[已复核]` | 全仓调用点**恰为 4 处**：`routes/history.ts:233`、`ui/routes.ts:75`、`ui/routes.ts:540`、`ui/routes.ts:586` |
| 11 | `src/serialization.ts:260-350` 并存 `entityToDto`/`entityToDtoWire` | ✅ 符合 `[已复核]` | `entityToDto`=L262-277、`entityToDtoWire`=L280-295、`historyDtoToJson`=L313-328 |
| 12 | `src/types.ts:80-97` 是 `HistoryRecordEntity` | ⚠️ 偏移 2 行 `[已复核]` | 实际 L83-99 |
| 13 | `src/env.ts:18-20` 是 `ENFORCE_STRONG_CREDENTIALS` | ❌ 错 `[已复核]` | `ENFORCE_STRONG_CREDENTIALS` 在 **L16**；L17-19 是 `UI_ENABLED` |
| 14 | `src/cleanup.ts:320-335` 是「逐条 DO 广播」 | ⚠️ 未命中 `[已复核]` | 广播调用在 **L386** |
| 15 | `tsconfig.json:17` include 含不存在的 `scripts` | ✅ 符合 `[已复核]` | L17 = `"include": ["src", "test", "scripts"]`，`scripts/` 目录不存在 |
| 16 | `public/ui` 是应删除的 V2、`public/ui_old` 才是主流界面 | ⚠️ **半对**：定位对、结论过度 `[已复核]` | 「`ui_old` 是默认界面」**属实**。但「应删除 `public/ui`」与文档意图冲突：`eslint.config.js:15` 称 V2「重写中」、`docs/ui.md:135-137` 列出**保留 V2 的理由** |
| 17 | 删 V2 时应一并删除 `/ui/api/overview`、`/activity`、`/history/batch-meta` | ❌ **事实错误，危险** `[已复核]` | 三者**都被 V1（默认界面）真实调用**：V1 `api.js:216`/`main.js:439`（overview）、`api.js:248`/`main.js:494`（activity）、`api.js:225`/`main.js:722`（batch-meta）。删除会打断默认界面，并撞 `test/ui-guard.test.ts:80-84` 的路由盘点断言 |
| 18 | `tools/ab-upstream-probe.ps1`「完成历史使命，建议归档或移除」 | ❌ 与文档冲突 `[通读]` | 它是 `docs/design.md` ADR **D10** 与 §12 正式登记的「真上游 A/B 守卫」；`docs/protocol.md` §10 多条"有意偏离"的唯一实测依据。**不应按死工具处理** |
| 19 | `.github/workflows/deploy.yml:255-275` 限速变量 | ⚠️ 边界错 `[通读]` | 文件存在（470 行），但限速四参数的 `resolve_int` 在 **L271-276** |
| 20 | `src/durable/SyncClipboardHub.ts:237-285`(SSE) / `287-395`(长轮询)、`src/hub.ts:17-30` | ⚠️ 区间近似 `[已复核]` | SSE 在 L243-293、长轮询 L295-391；`AVAILABLE_TRANSPORTS` 在 `hub.ts:27-31` |
| 21 | 「全仓 7,400+ 后端 / 8,500+ 前端 / 12,000+ 测试行」 | ⚠️ 无法核实 | 未做全量求和；量级方向可信 |

### 3.2 结论

- **行数类断言**（#1-4）：全部准确。
- **行号类断言**（#5、7、8、9、10、13）：错误集中在**跨几十行的错位**，不是 ±1 漂移。
- **结论类误判（#17）最危险**：把"V2 专用端点"当成"V2 的附属物"一起删，会打断默认界面；
- **#5 若被照抄，会删掉 5 个活跃列**（`Size`/`TransferDataFile`/`LastModified`/`Stared`/`Pinned`），造成功能损坏。
- **处理方式**：本文件**取代**旧文档成为审计结论的唯一出处。

### 3.3 旧文档已不在版本库（重要）

**已核实**：`docs/AUDIT-redundancies.md` **从未被 git 跟踪**（`git ls-files docs` 的 12 个文件中不含它；`git status` 显示为未跟踪；`git log --all -- 该路径` 无输出）。本次修订是**就地覆盖**，因此旧文档原文已不可从 git 历史找回。

**因此，若你曾读过旧文档，无法在本文中找到逐条对应关系**。下表是**基于旧文档章节顺序的推测性骨架**（仅供你凭记忆对照，非精确映射——旧编号只在旧原件里才有）：

| 旧编号（推测） | 旧结论方向 | 本文处置 |
|---|---|---|
| 发现 3.1 / 3.2 | 前端冗余 | 并入 §10（双前端决策）；其中"两版工具函数重复"并入 §6.2 |
| 发现 4.1 / 4.2 / 4.3 | D1 镜像死列 / FilePaths 冗余 / schema 清洗 | §5.B **C-09**（死列，已核准）、**R-06 与 O-02**（FilePaths/体积）、**C-08**（清洗 DELETE）。⚠️ 旧 4.1 的**行号已证伪** |
| 发现 5.1 / 5.2 / 5.3 | pathCase / V2 专用端点 / 序列化多轨 | **C-03**（pathCase，判为需决策非清理）、旧 5.2 **已推翻**（端点被 V1 使用）、**R-01** |
| 发现 6.1 / 6.2 | SSE+长轮询 / 双通道鉴权 | **C-04**（判为需决策非清理）；双通道鉴权**不判为冗余**（见 §5.C 说明） |
| 发现 7.1 / 7.2 | R2 全桶统计 / PUT 内存缓冲 | **O-02**、**O-04**（后者明确不做） |
| 发现 8.1 / 8.2 | 逐条广播 / 游标过度设计 | **O-05**（需决策）、**O-03** |
| 发现 9.1 / 9.2 | 限速过载 / 弱凭据双模式 | **C-07**（弱凭据，保留）；限速**不判为冗余**（见 §5.C 说明） |
| 发现 10.1 / 10.2 / 10.3 | 测试重叠 / tsconfig / 探针 | **T-07 ~ T-10h**、**D-12**（已核准）、**M-04**（**已推翻**："不是死工具"） |

**两处旧结论已被彻底推翻，请优先注意**：旧「发现 5.2」（删三个端点）与旧「发现 10.3」（删 A/B 探针）。

---

## 4. 死代码（D-01 ~ D-13）

> 「死代码」= 全仓无引用、不可达分支、或引用了不存在路径的代码。**不含**"有意保留以对齐上游"的实现（那些在 §5）。

### D-01 `basicAuthMiddleware` —— 定义了但全仓无人使用
- **位置**：`src/auth.ts:202-208` `[已复核]`
- **类别**：死代码（未引用导出）
- **严重级别**：Low
- **说明**：全仓检索仅命中定义处，无任何 import。鉴权实际走 `authFailure()`（协议面，`src/index.ts:165`）与 `uiAuthMiddleware()`（UI 面，`src/ui/guard.ts:50`）。这个 Hono 中间件是早期方案（"用中间件做 Basic 鉴权"）的遗留。
- **建议方案与预期收益**：删除该导出。删 7 行；消除"看起来是鉴权入口、实际不生效"的误导（安全代码里最不该有的误导）。
- **改动风险与注意事项**：无。已确认无动态引用。（注：`src/**` 不在 `eslint` 覆盖范围内，`tsconfig` 亦未开 `noUnusedLocals`，所以删它不会有工具报错——同样地，也不会有工具提醒你漏删。）

### D-02 `src/db.ts` 的转出导出无人消费
- **位置**：`src/db.ts:575` `export { entityToDto, entityToUpdateDto, toIso };`（连带 `src/db.ts:12` 的 import）`[已复核]`
- **类别**：死代码（未引用转出 + 未用 import）
- **严重级别**：Low
- **说明**：全仓 `from './db'` / `from '../db'` 的导入清单（src 下 8 处 + test 2 处）导入名均为 `HistoryDb`/`basename`/`BadRequestError`/`DbRow`/`rowToEntity`/`shouldUpdate`，**无一处导入这三个**。且 `db.ts:12` 的 `import { toIso, entityToDto, entityToUpdateDto, fromIso }` 中，前三个在 db.ts 内**仅出现在第 12、575 行**，无调用点。
- **建议方案与预期收益**：删除 L575，并把 L12 的 import 收窄为 `import { fromIso } from './serialization';`。删 4 行；消除"db 是 DTO 序列化的第二入口"的错觉。
- **改动风险与注意事项**：无。**务必保留 `fromIso`**（它在 L409/L426 被调用）。

### D-03 `RENDERABLE_TYPES` 里有一个不可达类型
- **位置**：`src/contentTypes.ts:73-79`（`'text/xml'` 在 L77）`[已复核]`
- **类别**：死代码（不可达表项）
- **严重级别**：Low
- **说明**：`CONTENT_TYPES` 表（L10-62）**没有任何扩展名映射到 `text/xml`**：`xml` → `application/xml`（L33），`xhtml` → `application/xhtml+xml`（L37）。`contentTypeOf` 只返回表内值或 `application/octet-stream`，故这一项永远不可能被命中。
- **建议方案与预期收益**：删除 `'text/xml'`。让"哪些类型被强制下载 + 加 CSP"的清单与实际可达集合一致。
- **改动风险与注意事项**：无。`test/fixes.test.ts:918` 只测 `doc.xml → application/xml`（仍被加固），删它不影响该用例。

### D-04 `MultipartPart.filename` 被解析但无人消费
- **位置**：`src/multipart.ts:8`（字段声明）、`:90`（赋值）、`:142-143`（`extractParam` 取 filename）`[已复核]`
- **类别**：死代码（未消费字段 + 连带的无用解析）
- **严重级别**：Low
- **说明**：全仓 `\.filename` 在 `src/` 下**只有这两处赋值**，无读取点（其余命中在 `test/*` 的测试自建夹具对象上，与 `MultipartPart` 无关）。上传路径取的是 `name` 与 `content`（`src/routes/history.ts:331-333`）。
- **建议方案与预期收益**：删除字段声明、赋值、以及 `parseContentDisposition` 中的 filename 提取（保留 `name`）。删约 5 行 + 每个 part 少一次正则。
- **改动风险与注意事项**：**必须同一次改完 3 处**（L8/L90/L142-143），否则类型与赋值不一致会 tsc 红。另注意 `src/multipart.ts` 整模块是 §5.C 的"运行环境型适配"、**必须保留**——本项只删字段，不要顺手改动其余解析逻辑。

### D-05 V2 的 `api.batchMeta()` 无调用者，且注释与事实相反
- **位置**：`public/ui/js/api.js:174-186`（定义在 L180）`[已复核]`
- **类别**：死代码 + 注释错误 + **文档连带**
- **严重级别**：Medium
- **说明**：JSDoc 写「目前界面没有这个入口，故**不导出**（需要时再加回来，服务端端点一直在）」，但它是 `export const api = {...}`（L116）的成员，**必然导出**。V2 内无任何 `api.batchMeta(` 调用；只有 V1 在用（`public/ui_old/js/main.js:722`）。服务端端点 `/ui/api/history/batch-meta` 存在且被 V1 依赖，**不能删端点**。**另有一层矛盾**：`docs/ui.md:159` 把 V2 的 `api.js` 描述为"批量取全文 `batchMeta()`"，而 `docs/ui-v2-audit.md:179` 又声称 `batchMeta` 已删——两处文档自相矛盾，代码是第三种状态。
- **建议方案与预期收益**：删除 V2 的 `batchMeta`。删约 13 行；同时**消除三处口径不一致**。
- **改动风险与注意事项**：**必须同一变更内同步 `docs/ui.md:159`**（否则删完就制造一份"与代码相反的文档"，正是本条批评的形态）。`docs/ui-v2-audit.md:179` 是一次性审计件（§9 M-02 同类），可不动或加历史标注。**不要删服务端端点**（V1 在用）。

### D-06 V2 的 `store.update()` 无调用者
- **位置**：`public/ui/js/state.js:25-28` `[已复核]`
- **类别**：死代码（未调用方法）
- **严重级别**：Low
- **说明**：全仓检索 `store.update` **零命中**（`store.patch` 有约 21 处调用）。`eslint.config.js` 的 `no-unused-vars` 不报未使用的**对象成员**，故 lint 抓不到。而 `state.js` 文件头注释（L5）专门为它写了理由（"用于 `filters` 这类只改一个字段的高频路径"），实际没有这样的调用点。
- **建议方案与预期收益**：删除 `update()`。删 4 行。
- **改动风险与注意事项**：**必须同步修正 `state.js` 文件头 L5 的注释**，否则注释仍在为一个不存在的 API 辩护。

### D-07 V2 的 `board.focusFirst()` / `overview.setLastSync()` 无调用者
- **位置**：`public/ui/js/ui/board.js:501-503`、`public/ui/js/ui/overview.js:151-155` `[已复核]`
- **类别**：死代码（未调用方法）
- **严重级别**：Low
- **说明**：两者均只命中定义处。`board.js` 已有 `captureFocus`/`restoreFocus` 机制（与 `focusFirst` 功能重叠）；`overview` 的更新一律走 `overview.update({...})`（`boot.js:338-347`）。
- **建议方案与预期收益**：删除两者（或把 `setLastSync` 用在 `pollOnce` 的"无变更"分支以减少整条重画——那属优化，见 O-08）。删约 8 行。
- **改动风险与注意事项**：无。

### D-08 V2 `messages.js` 的 429 精细文案是死分支（因 V2 `api.js` 从不填 `retryAfterSeconds`）
- **位置**：`public/ui/js/messages.js:83-88`（读该字段在 L84）↔ `public/ui/js/api.js:8-15,44-47`（构造与抛出时均未附带该字段）`[已复核]`
- **类别**：**功能缺口** + 死代码（不可达分支）
- **严重级别**：Medium（**本条是修复项，不是删除项**）
- **说明**：`messages.js:82` 的注释断言「`api.js` 已把它带进 `error.retryAfterSeconds`」，但全仓检索 `retryAfterSeconds` 在 `public/ui/` 下**只出现在 `messages.js:82,84`**。于是 `Number(undefined)` = NaN → L85 的通用文案恒命中，L86-87 的两条精细文案（"请在 N 秒后重试"）**永远不可达**。对照：V1 是完整实现的（`public/ui_old/js/api.js:21-27` 构造时带入、L80 从 `Retry-After` 解析；`main.js:60` 读取）。
- **建议方案与预期收益**：在 V2 `api.js` 的 `request()` 里补 `retryAfterSeconds`（从 `response.headers.get('retry-after')` 解析，或作为 `ApiError` 构造参数）——**推荐照搬 V1 的可用实现**。修一个真实的功能缺口（429 时用户看不到还要等多久）。
- **改动风险与注意事项**：**原先认为"需同步 `test/ui-logic.test.ts`"，经复查不成立**——该文件对 `describeListError` 的用例（约 L367-377）只传 `{status,message}`，**没有任何 retryAfterSeconds 断言**。真正的漏项是反向的：**补了字段后 L86-87 首次变成可达，应新增一条 429 + `Retry-After` 的用例**，否则"补了但没人验证"。

### D-09 V2 `next-target.js` 判断了一个不存在的路径
- **位置**：`public/ui/js/next-target.js:22` `[已复核]`
- **类别**：死代码（引用了不存在的路径）
- **严重级别**：Low
- **说明**：`if (url.pathname === '/ui/login.html' || url.pathname === '/ui/app/login.html') return fallback;` —— V2 的登录页在 `/ui/app/login.html`；`/ui/login.html` **不存在**（全仓 `login.html` 只有 `public/ui_old/login.html` 与 `public/ui/app/login.html`）。故前半个条件恒假。
- **建议方案与预期收益**：删除 `'/ui/login.html'` 判断。删 1 个条件。
- **改动风险与注意事项**：**原标注为"待确认"，现已确认无测试风险**——`test/next-target.test.ts` 只断言 `/ui/app/login.html`（L22/L64），**没有** `/ui/login.html` 用例。唯一行为变化：删除后 `?next=/ui/login.html` 会返回该路径（404 页）而不是回落 `/ui/app/`。建议删除后补一条"指向不存在路径仍回落"的用例，或保留该条件并在注释里写明它是防御性的。

### D-10 V2 中"只定义、无生产者"的 CSS 规则
- **位置**（各自独立，可分别删；行号 `[已复核]`）：
  - `public/ui/css/overlay-v2.css:662-674` `.bar__fill[data-kind="Text"|"Image"|"File"|"Group"]`
  - `public/ui/css/board-v2.css:377` `.entry__text[data-lines="1"]`
- **类别**：死代码（无生产者的 CSS 规则）
- **严重级别**：Low
- **说明**：
  - `.bar__fill`：`drawer.js:273-277` 建它时只给 `class` 与行内 `width`，**从不写 `data-kind`**。全仓写 `dataset: { kind }` 的位置是 `ui/row.js:118`（`.entry__kind`）、`ui/filters.js:45`（类型 chip）、`ui/blank.js:39` 与 `ui/blank.js:60`（`.blank`）——**没有一处作用于 `.bar__fill`**。故这 4 条配色规则全部不命中，活动条恒为 `--accent`。
  - `[data-lines="1"]`：`ui/row.js:130` 只写 `'data-lines': '2'`，无 `"1"` 的写入点。
- **建议方案与预期收益**：删除这 5 条规则（约 15 行）。
- **改动风险与注意事项**：
  - **`test/ui-contract.test.ts` 的属性契约是单向的**（只断言"CSS 消费的属性必须有生产者"），**删 CSS 属性选择器只会移除消费者，不会让守卫变红**；且各基类规则仍在（`.bar__fill` 在 overlay-v2.css:654、`.entry__text` 在 board-v2.css:357、`.tag` 在 overlay-v2.css:256、`.control` 在 ~145）。已逐条核对，**删除安全**。
  - 但会留下两处"行内不一致"：① 删 `[data-lines="1"]` 后 `data-lines` 从 CSS 完全消失，而 `row.js:130` 仍写 `'data-lines': '2'` → **生产者变成无消费者**（守卫不查这个方向，不会红，但会留下"JS 写了一个 CSS 不认的属性"）；② `board-v2.css:323` 的注释说"类型词用 `data-kind` 上色，**与左侧色条同源**"，删掉 `.bar__fill` 配色后该注释失真，且 `--kind-*` 令牌在抽屉里失去消费者（**V2 没有"令牌不空转"守卫**，那条只在 `ui-guard.test.ts` 里且只扫 V1）。建议连同这两处注释一并处理。

### D-11 V2 中"无外部消费者"的导出、图标与规则
- **位置与说明**（同一形态，建议一并处理；行号 `[通读]`）：

  | 项 | 位置 | 说明 |
  |---|---|---|
  | 三个图标 | `public/ui/js/icons.js:58-64`（`arrowUp`/`arrowDown`/`external`） | **V2 内**无引用（`iconPaths`/`iconForKind` 的清单里都不含）。⚠️ **注意范围**：V1 有自己的 `icons.js` 且在用 `arrowUp`（`ui_old/js/icons.js:35` 定义、`ui_old/js/components/list.js:224` 调用），故"全仓无引用"不成立——只有 V2 的这三条是死的 |
  | `ICONS` / `FILLED` | `public/ui/js/icons.js:10,99` | 仅同文件（L103/L108）使用 |
  | `formatDate` | `public/ui/js/format.js:47` | 仅同文件（L67/75/102/104）使用 |
  | `createDialog` | `public/ui/js/ui/dialog.js:23` | 仅同文件（L161/230）使用；`boot.js:49` 只 import `createConfirm, createSheet` |
  | `THUMB_MAX_BYTES` | `public/ui/js/ui/row.js:17` | 仅同文件（L216）使用 |
  | `drawer.close` | `public/ui/js/ui/drawer.js:429` | `boot.js` 只调 `drawer.open()/focusRange()/update()` |
  | `.sr-only` | `public/ui/css/base-v2.css:140-149` | V2 内无使用者（**V1 在用**：`ui_old/js/components/header.js:67`、`ui_old/js/components/list.js:306,309`） |
  | `.control[data-icon]` | `public/ui/css/overlay-v2.css:167-169` | `data-icon` 只写在 `.icon-btn` 上；`.control` 元素（`board.js:47`、`drawer.js:62/71/82`、`ui/filters.js:79`）均无该属性 |
  | `.tag[data-tone="star"/"pin"]` | `public/ui/css/overlay-v2.css:270-278` | `.tag` 唯一 tone 写入点是 `ui/row.js:193` 的 `'data-tone': 'warn'` |
  | `data-app="history"/"login"` | `public/ui/app/index.html:2`、`public/ui/app/login.html:2` | V2 无 CSS/JS 消费者（只在 V1 的 `auth.css` 里被消费） |
  | `id="main"` | `public/ui/app/index.html:83` | 无 `#main` 选择器与 `getElementById('main')` |
  | 历史注释 | `public/ui/js/boot.js:1065-1070` | "这里原来有个 `pruneSelection()` 空函数…空壳删掉"——按"不需要历史包袱"的前提可精简 |

- **类别**：死代码（未引用导出 / 无生产者规则 / 未消费属性）+ 陈旧注释
- **严重级别**：Low
- **建议方案与预期收益**：逐项删除（多数只需去掉 `export` 关键字，不必删函数体）。合计约 40~60 行 + 4 条 CSS 规则；收敛"公开 API 面"。
- **改动风险与注意事项**：无。**`test/ui-contract.test.ts` 的"Node ESM 原生解析"用例会兜住误删导出**（导入方会 SyntaxError），有机器兜底。**删除 `.sr-only` 需同步 `docs/ui.md:571`**（该处声称 `.sr-only` 被使用）。`arrowUp/arrowDown` 若将来要做排序指示器可再加回，但**不能为了"可能用得上"留着**。

### D-12 `tsconfig.json` 的 include 含不存在的目录
- **位置**：`tsconfig.json:17` `[已复核]`
- **类别**：死配置
- **严重级别**：Low
- **说明**：`"include": ["src", "test", "scripts"]`，但仓库中**没有 `scripts/` 目录**。
- **建议方案与预期收益**：改为 `["src", "test"]`。配置与实际一致。
- **改动风险与注意事项**：无（唯一影响是 `tsc` 少扫一个不存在的目录）。

### D-13 V1（`public/ui_old`，**产品面**）的死 id 与无外部消费者的导出
> **本轮补充**：第一轮审计的 §4 只覆盖了 V2（D-05~D-11）。既然 `ui_old` 是产品/默认界面，**它的死代码比 V2 的更值得清**。以下逐条经 Grep 全仓复核 `[已复核]`。

- **位置与说明**：

  | 项 | 位置 | 证据 |
  |---|---|---|
  | 死 id `skeleton` | `public/ui_old/index.html:100` | 全仓唯一出现处；样式走**类** `.skeleton`（`css/components.css:1552`），无 `#skeleton` 选择器、无 `getElementById('skeleton')`（节点在 `js/main.js:1231` 被整体 `replaceChildren` 移除，不需要按 id 定位） |
  | 死 id `preview-meta` | `public/ui_old/js/components/preview.js:24` | 全仓唯一出现处；该文件只用了 `preview-title` |
  | 死 id `search` | `public/ui_old/js/components/toolbar.js:127` | 无 `#search` 选择器、无 `label[for="search"]`（输入框用 `aria-label`，见 `toolbar.js:129`） |
  | 无外部消费者的 `export` | `js/api.js:103 normalizeItem`、`js/api.js:116 buildQuery` | 均只被本文件消费（`normalizeItem` → 140/146/164/169/232；`buildQuery` → 137/155/207） |
  | 同上 | `js/signalr.js:33 parseFrames`、`:42 classifyMessage` | 只被本文件 `:142/:143` 消费 |
  | 同上 | `js/clipboard.js:14 isImageName`、`:21 canWriteText`、`:57 canWriteImage` | 只被本文件 `:28/:33/:69` 消费 |
  | 同上 | `js/filters.js:41 startOfDay`、`js/icons.js:4 ICONS` | 分别只被 `:64/66/68`、`:68` 消费 |

- **类别**：死代码（死 id / 无外部消费者的导出）
- **严重级别**：Low
- **建议方案与预期收益**：删除三个死 id；把无外部消费者的 `export` 关键字去掉（**函数体保留**，它们仍在本文件内被调用）。合计约 12 行；收敛 V1 的对外导出面——`ui_old` 是产品面，公开面越窄越不容易在改动时误伤。
- **改动风险与注意事项**：
  - **必须先核对的"不是死代码"清单**（这些导出被测试依赖，**不可删**）：`test/ui-guard.test.ts:21` 从 V1 `api.js` 导入 `API_BASE`、`api`、`itemPath`；`test/ui-logic.test.ts:26` 从 V1 `components/info.js` 导入 `retentionText`、`retentionEffectiveText`；`test/ui-logic.test.ts:30` 从 V1 `format.js` 导入 `downloadNameForText`、`safeFileName`。`filters.js:27 PAGE_SIZES` 也被 `components/toolbar.js:10/200` 跨文件使用，**不是死的**。
  - **V1 的 CSS 没有死类**（子代理对 7 张样式表实测：176 个类名全部有引用，抽样中唯一"命中不到"的 `star-btn`/`pin-btn` 实为 `list.js:464` 动态拼接）——**不要对 V1 的 CSS 做"死类清理"**，那会删掉在用的规则。

---

## 5. 兼容层与适配代码（C-01 ~ C-09）

> **关键区分**：本项目的"兼容层"里，**绝大多数是"有意对齐上游 ASP.NET Core"的协议契约**，它们在 `docs/protocol.md`（唯一权威）的差异表或 `docs/design.md` 的 ADR 里有登记，并有 A/B 实测支撑。**删除它们不是"清理"，而是"主动放弃对上游的逐字对齐"**——属产品决策（§2 的 P5），不是冗余审计的处置对象。
> 本节把三类分开：**5.A 真·遗留适配**（可清理）／**5.B 上游契约型兼容**（需决策）／**5.C 运行环境型适配**（应保留）。

> **本轮新增**：上述"对齐上游"的断言已**逐条落到上游 C# 源码**上核验（基线 `28c7e596`），结论见 **§13**。
> 另需说明职责边界：**偏离的"登记"由 `docs/protocol.md` §10 负责**（该表已把每一条差异带到上游 `file:line`，质量很高）；**本文不重复登记**，只回答一个问题——**"动这一项会不会影响兼容"**（§13 的判定列）。

### 5.A 真·遗留适配（可清理）

#### C-01 V2 的 `/ui/` 跳转壳与 fragment 中继脚本
- **位置**：`public/ui/index.html:33-38`（canonical + `<script src="/ui/js/redirect-hash.js">` + `<noscript>` meta refresh）、`public/ui/js/redirect-hash.js:11` `[通读]`
- **类别**：兼容层（重定向壳）
- **严重级别**：Medium
- **说明**：`/ui/` 这一页的唯一职责是把人送到 `/ui_old/`，与 `src/routes/webdav.ts:38-41`（根路径 302 → `/ui_old/`）重复表达了同一件事。`redirect-hash.js`（12 行）只为把 `#Type-hash` 一起带过去而存在。
- **建议方案与预期收益**：若接受"`/ui/` 直接由 Worker 302 到 `/ui_old/`"，可删掉该 HTML 与脚本；删约 50 行、少一跳。
- **改动风险与注意事项**：中——① `test/ui-guard.test.ts:456-472` 的"默认界面入口链一致"用例会读 `public/ui/index.html` 的 meta refresh 与 canonical（要求 `rootRedirect === '/ui_old/'` 且与这两者三者相等），改动需同步该守卫；② **`#fragment` 的传续能力必须有新落点**，否则 `/ui/#Text-<hash>` 深链接会静默退化为列表页。

#### C-02 V2 的"早于 range 参数的旧链接"兼容分支
- **位置**：`public/ui/js/filters.js:123-128` `[通读]`
- **类别**：兼容层（对自身历史 URL 的兼容）
- **严重级别**：Low
- **说明**：注释明说这是为「早于 `range` 参数的旧链接」保留的还原分支。按"从未正式发布"的前提，这类 URL 只可能来自开发者自己的书签。
- **建议方案与预期收益**：删约 6 行。
- **改动风险与注意事项**：**待确认后再删**（§11 #5）——该分支与 `rangeBounds`（L66/81/83）耦合：`rangeBounds` 只对 `range === 'custom'` 使用 `after`/`before`，所以这个分支实际是"让带 after/before 的手写 URL 仍生效"的**唯一途径**。直接删除会让这类 URL 静默变成 `range=all`。

### 5.B 上游契约型兼容（**需产品决策，不是清理对象**）

| 编号 | 位置 | 类别 | 严重级别 | 性质与说明 | 若移除的风险 | 建议与收益 |
|---|---|---|---|---|---|---|
| **C-03** | `src/pathCase.ts`（86 行）+ `src/index.ts:196-205` 的入口重写 | 兼容层（协议） | **High** | 对齐 ASP.NET Core「路由**字面段**大小写不敏感」。2026-09-15 用官方 v3.2.0 服务端发布件 A/B 实测确认 | 破坏 `/API/version`、`/SyncClipboard.JSON` 等；`test/protocol.test.ts` 有 20+ 用例 + 一条"归一表必须覆盖协议面全部字面段"的守卫会红；需同步删 `docs/protocol.md` 差异表行 | **保留**（除非愿意放弃逐字对齐）。若放弃：删 86 行 + 简化入口 |
| **C-04** | `src/durable/SyncClipboardHub.ts:243-293`(SSE)、`295-391`(长轮询)、`52-53`(队列上限)、`src/hub.ts:27-31`(`AVAILABLE_TRANSPORTS`) | 兼容层（协议） | **High** | 对齐上游 `services.AddSignalR()` 宣告的三种传输与**宣告顺序**；`design.md` ADR **D6** 明确"已定" | `negotiate` 载荷不再与上游逐字一致（`F13` 明确记录"不再自行收敛为 Text"，正是为防止有人这么改）；`test/transports.test.ts`（约 7 条）、`test/fix-regressions.test.ts` 的 F32（断言 `availableTransports` 长度为 3）、`test/rate-limit.test.ts` 的长轮询队列封顶节会红 | **保留**。若放弃：约可减 250 行 |
| **C-05** | `src/db.ts:274-284`（协议面 **不转义** LIKE 元字符）vs `src/ui/query.ts:196-202`（UI 面转义） | 有意分面 | Medium | 协议面**有意对齐上游**（`HistoryService.cs:153` 同样不转义）；UI 面有意收紧（用户搜 `100%` 不该退化成匹配任意） | 统一任一侧都会造成"与上游不一致"或"搜索语义退化" | **明确不做**（见 §2）。两侧注释与 `docs/protocol.md` §10 已登记 |
| **C-06** | `src/db.ts:149-153`（`LOWER(Hash)=LOWER(?)` 等值匹配，上游把 hash 当 LIKE **模式**） | 有意偏离 | Medium | 处置决定记在 `docs/upstream-defects.md` 的 D1 | 改动会破坏已登记结论 | **明确不做**。**`[待确认]`**：该差异**未找到对应测试覆盖**（§11 #12） |
| **C-07** | `src/auth.ts:15-25,107-136` + `src/env.ts:16`（弱凭据"只告警不阻断" + `ENFORCE_STRONG_CREDENTIALS` 双模式） | 过渡期开关（`F1`） | Low | "上线前收紧"的正常设计 | 若已确定轮换完成，可把默认改为 fail-closed 并删软告警分支；但这会改变"本地默认行为"，需同步 `README.md:252`、`wrangler.toml`、`deploy.yml`、`src/env.ts` | **保留现状**；若要收紧，建议只改默认值而不删分支（保留可回退能力） |
| **C-08** | `schema.sql:26-35`（建唯一索引前的历史重复行清洗 `DELETE`） | 一次性迁移补丁 | Low | 对全新库无意义；但**幂等、零风险** | 若线上库**曾有**重复行，删掉清洗会让 `CREATE UNIQUE INDEX` 失败 | 删可简化部署脚本。**先按 §11 #7 确认线上无重复行** |
| **C-09** | `schema.sql:10,11,19,20,21`（**5 个从未写入的镜像列**：`TransferDataSha256`、`TransferDataMd5`、`"From"`、`Tags`、`ExtraData`） | 死列（镜像上游） | Low | 与上游"只建列从不写入"一致（`docs/upstream-parity.md:72` 已登记"两侧都只建列、从不写入 ⇒ 无行为差异"）。`"From"` 因是 SQLite 关键字还需引号 | **低**：这 5 列在 `DbRow`、`entityParams`、`INSERT_SQL`、`UPDATE` 里**都不存在**，删除不触及任何读写路径 | **可直接删除**（§2 归 P2）。删掉可顺带消除 `"From"` 的引号转义负担。**注意**：`FilePaths` **不在其列**——它被写入并被用于推导 `hasData`（见 R-06、§9 M-03） |

### 5.C 运行环境型适配（应保留，**不要清理**）
- `public/ui_old/js/api.js:38-53`：手写 `AbortController` 中继以回避 `AbortSignal.any`（零构建、要能跑旧内核）`[通读]`
- `public/ui*/js/clipboard.js`：`navigator.clipboard` → `document.execCommand('copy')` 降级链 `[通读]`
- `public/ui*/css/*`：`@supports` / `color-mix` / `:has` / `@starting-style` / `linear()` / `overflow: clip` / `backdrop-filter` 特性探测与静默降级 `[通读]`
- `src/multipart.ts` 整个模块（`undici` 的 `Request.formData()` 要求带引号的 name/filename，而 .NET HttpClient 生成无引号形式）`[已复核]`
- `test/**` 中为"共享实例不可重置""proxy 出网""零构建前端不在 tsconfig 内"而加的适配（`@ts-expect-error`、注入全局 `WebSocket`、`harnessStorageGap` 等）`[通读]`
- **另两处刻意保留、经复查确认"当前实现正确、不是冗余"**：
  - **WS 鉴权的双通道**（negotiate 登记 token `?id=` + Basic 头，`src/hub.ts:120-138` / `SyncClipboardHub.ts:577-629`）：`.NET` 客户端在 WS/SSE/长轮询上都带 `Authorization`，而**浏览器不能给 WebSocket 设请求头**——这是 `/ui/api/hub-ticket` 存在的真正理由。两条通道都是必需的。
  - **认证失败限速**（`src/rateLimit.ts` 350 行 + DO 内约 60 行）：它在 `README.md:403`、`docs/design.md` §7.1 有完整设计说明，是"失败路径不写 D1"这一明确取舍的产物。**并非冗余**（旧审计曾建议整体简化，本报告不采纳）。

> **判断原则**：`.C` 类的共同特征是——**移除它会让代码在真实运行环境里坏掉**，而不是"少一个历史包袱"。把这类当冗余清理是本报告最想避免的误伤。

---

## 6. 冗余与重复实现（R-01 ~ R-08）

### 6.1 产品代码

#### R-01 `serialization.ts` 同源字段被写了三遍
- **位置**：`profileDtoToJson` (`src/serialization.ts:141-154`) 与 `profileDtoToWire` (L298-311)；`entityToDto` (L262-277)、`entityToDtoWire` (L280-295)、`historyDtoToJson` (L313-328) `[已复核]`
- **类别**：冗余与重复实现
- **严重级别**：Medium
- **说明**：*两对*函数各自维护**同一组字段与同一条"size 为 null 时整键省略、dataName 为 null 时保留 null"的序列化规则**，区别仅是"输出 string"还是"输出 object"、"type 是数字还是枚举字符串"。`historyDtoToJson` 是同一字段集的第三次展开。
  **三个函数都不能删**（经复查确认）：`entityToDto`（**数字**枚举）有 5 处消费者（`src/routes/history.ts:247/302/340`、`src/ui/query.ts:232`、`src/profile.ts:423/460`）；`entityToDtoWire`（字符串枚举对象）喂 SignalR 广播；`historyDtoToJson`（字符串枚举文本）喂协议面。
- **建议方案与预期收益**：收敛为"**一个 wire 形状构造器** + 薄包装"：`dtoWire(entity)` 返回对象；`JSON.stringify(dtoWire(e))` 即 JSON 文本。删约 40~60 行；序列化规则单点维护。
- **改动风险与注意事项**：**中，且必须补前置测试**——这是**协议面契约**（`docs/protocol.md` §2-3 逐字规定），而现有测试（`test/protocol.test.ts`、`test/dto-validation.test.ts`）**只做 `JSON.parse` 后按字段比对，没有任何对 JSON 文本的逐字/键序断言**，所以"有测试覆盖"这句话对协议契约**不成立**。前置动作：先加 golden 测试（对三个函数产出的**完整 JSON 字符串**做 `toBe`，覆盖 `size=0`、`size` 省略、`dataName=null` 保留 null 等边界），再重构。

#### R-02 三种薄解析器在协议面与 UI 面各写一份
- **位置与配对**（均 `[已复核]`）：

  | 形态 | 协议面 | UI 面 | 差异 |
  |---|---|---|---|
  | 整数解析 | `src/routes/history.ts:76-82` `parseCSharpInt32` | `src/ui/query.ts:82-88` `parseIntParam` | 前者"越界即非法"（→400），后者"越界即**钳制**" |
  | 布尔解析 | `src/routes/history.ts:66-72` `parseBoolOrNull` | `src/ui/query.ts:90-96` `parseBoolParam` | 语义完全一致（空→null，非 true/false→抛错）——**纯重复** |
  | 时间解析 | `src/routes/history.ts:57-61` `parseDateOrNull` | `src/ui/query.ts:99-110` `parseTimeParam` | 后者额外接受 epoch 毫秒 |
  | 第三处整数解析 | `src/ui/routes.ts:58-64` `readIntParam`（越界即非法） | —— | 与 `parseIntParam` **语义相反**，两个函数并存在同一命名空间下 |

- **类别**：冗余与重复实现
- **严重级别**：Medium
- **说明**：`readIntParam` 与 `parseIntParam` 语义**相反**，两处各自的注释都在解释"为什么我和另一个不一样"。
- **建议方案与预期收益**：布尔解析合并为一份（放 `src/serialization.ts` 或新增 `src/parse.ts`）；整数解析保留"钳制"与"拒绝"两个语义**但在同一模块并列**，由调用方显式选择。删约 25 行 + 消除"同名不同义"陷阱。
- **改动风险与注意事项**：低（有 `test/query-filters.test.ts` / `test/ui.test.ts` 覆盖），但**合并时必须保留各自的错误类型**（协议侧抛 `Error`/`BadRequestError`、UI 侧抛 `InvalidQueryValueError` → 400 映射），否则 400/500 会互换。

#### R-03 `truncateText` 与 `snippet` 是同一函数的两个副本
- **位置**：`src/ui/query.ts:221-227`（`truncateText`）与 `src/ui/maintenance.ts:55-61`（`snippet`）`[已复核]`
- **类别**：冗余与重复实现
- **严重级别**：Low
- **说明**：两者逐行等价（slice 后回退半个代理对）。`maintenance.ts:54` 的注释明确记录了这是**有意的复制**："这三行复制比为一个字段扩大导出面便宜"。
- **建议方案与预期收益**：导出 `truncateText`（从 `query.ts` 转出或放入新的 `src/ui/text.ts`），`maintenance.ts` 改为 import。删 7 行。
- **改动风险与注意事项**：无。建议顺带补一条代理对边界用例（否则"截断不回退半个代理对"这条规则仍只有一处被测）。

#### R-04 四个路由模块各自重复 `{db, storage}` 工厂
- **位置**：`src/routes/history.ts:225-228`、`src/routes/webdav.ts:24-27`（这两处局部函数名为 **`handlers`**）、`src/ui/routes.ts:194-197`、`src/ui/maintenance.ts:67-70`（这两处为 **`stores`**）`[已复核]`
- **类别**：冗余与重复实现
- **严重级别**：Low
- **说明**：四处逐字相同的 `({ db: new HistoryDb(c.env.DB), storage: new R2Storage(c.env.R2) })`。`maintenance.ts:66` 的注释还专门解释了"与 routes.ts 的同名局部函数一致"——即在**注释里承认了重复**。
- **建议方案与预期收益**：抽到 `src/db.ts` 或新增 `src/stores.ts`。删约 12 行；将来若给这两个对象加参数只需改一处。
- **改动风险与注意事项**：无（无参数注入，不存在循环依赖）。

#### R-05 R2 分页循环在 `storage.ts` 里出现 6 次
- **位置**：`listTempObjects`(81-87)、`listHistoryObjectKeys`(129-133)、`listHistoryObjectsByDir`(146-159)、`deleteHistoryDirs`(184-195)、`totalHistorySize`(202-208)、`deletePrefix`(214-220) `[已复核]`
- **类别**：冗余与重复实现
- **严重级别**：Medium
- **说明**：`do { const listed = await bucket.list({prefix, cursor}); …; cursor = listed.truncated ? listed.cursor : undefined } while (cursor)` 这一模式被复制了 **6 次**，只有"对每个 object 做什么"不同。
- **建议方案与预期收益**：抽 `iterateHistoryObjects(prefix, cb)`（或返回 `{objects, pages}` 的核心函数），各方法只传回调。删约 40 行；**降低"改分页语义时漏改某一处"的风险**（这类漏改在本仓库历史上造成过"每小时清空 history/"的严重故障，见 `storage.ts:29`、`cleanup.ts:448` 的 F33 注释）。
- **改动风险与注意事项**：**中，且有一条硬约束**——必须**精确保留 `pages` 语义**：`pages++` 要在**每一次 `bucket.list` 调用**后执行（含末页与页内 0 对象的页），因为 `cleanup.ts:308-316` 的 `historyGroups` 用 `run.budget.spend(Math.max(pages, 1))` 记账。若新迭代器改成"按对象数估算页数""只数非空页"或加 limit 提前退出，会让**自记账少于实际** → `test/cleanup-budget.test.ts:286` 的 `measured <= result.subrequests` 直接红；若让 `historyGroups` 绕过 `run.sweep` 缓存 → 同文件 `:310` 的 `expect(f.bucket.listCalls).toBe(1)` 也会红。另：`deleteHistoryDirs`/`deletePrefix` 目前**不记账**，统一后**不要顺手给它们加记账**（会改变其它用例的子请求计数）。

#### R-06 `totalHistorySize()` 与另外两个 R2 全桶扫描功能重叠
- **位置**：`src/storage.ts:199-210`、`126-135`、`142-161` `[已复核]`
- **类别**：冗余实现 + 可优化点（见 O-01/O-02）
- **严重级别**：Medium
- **说明**：三个方法都做"列举整个 `history/` 前缀"，只是聚合方式不同（求和 / 收 key / 按目录分组）。同一请求内可能先后触发两次列举（见 O-01）。
- **建议方案与预期收益**：见 O-01/O-02 的处理（若统计改走 D1 聚合，`totalHistorySize` 可整个删除）。
- **改动风险与注意事项**：见 O-02（**涉及协议面对外值，不是纯性能优化**）。

#### R-07 `assertHashForPath` 与 `isValidProfileHash` 是同一条校验的两个形态
- **位置**：`src/storage.ts:21-25`（抛错）vs `src/types.ts:121-123`（返回 bool）`[已复核]`
- **类别**：冗余与重复实现
- **严重级别**：Low
- **说明**：`hash.includes('/') || hash.includes('\\')` 这条判据有两份。分层是**有意的**（路由层给 400、storage 层做最后防线），但判据本身应单点。
- **建议方案与预期收益**：`assertHashForPath` 改为 `if (!isValidProfileHash(hash)) throw …`。判据单点。
- **改动风险与注意事项**：无（有 F31 用例覆盖）。**分层要保持**，只合并判据表达式。

#### R-08 V1 的 6 个用户文案函数与 V2 `messages.js` 逐字重复，且注释与事实相反
- **位置**：`public/ui_old/js/main.js:17-72`（`describeTarget` 17-23、`deleteConfirmSpec` 25-34、`batchDeleteConfirmSpec` 36-43、`clearHistorySpec` 45-52、`describeListError` 54-66、`clipboardFailureHint` 68-72）↔ `public/ui/js/messages.js:15-109` `[已复核]`（逐行比对确认函数体逐字相同，只有注释/JSDoc 不同）
- **类别**：冗余与重复实现 + 注释错误
- **严重级别**：Medium
- **说明**：这 6 个函数共约 56 行，在两版中**逐字相同**。更严重的是：`main.js` 有多处注释宣称这些文案在「**两版共用**的文案表里」「**只有一份**（两版共用的 `messages.js`）」（`main.js:381-382`、`main.js:561`），而 **V1 目录里没有 `messages.js`**，且 `test/ui-guard.test.ts:354-360` 的守卫**明令禁止** V1 跨目录依赖 `public/ui`。⇒ 注释与事实相反，且这份重复**必然漂移**——而它涉及删除/清空这类破坏性操作的用户告知（写错的代价是"误导用户以为内容还在"，`messages.js:1-9` 自己这么写）。
- **建议方案与预期收益**：新建 `public/ui_old/js/messages.js`（内容即这 6 个函数），`main.js` 改为 import；同步更新 `ui_old/index.html` 的 modulepreload 清单与那两处注释。消除语义漂移风险（这是"重复实现"里**后果最重**的一处）；顺带让 V1 也能被 `test/ui-logic.test.ts` 直接断言这些文案。
- **改动风险与注意事项**：**中**。新增文件会触碰：① `ui_old/index.html` 的 modulepreload（约 19 项，**人工维护、无守卫**）；② `docs/ui.md:139` 的"共 87 个资源"（→88，被 `test/docs.test.ts:101-107` 断言）；③ eslint glob 已覆盖 `public/ui_old/js/**`，无需改。改动前需跑 `npm run check && npm test`。

### 6.2 前端 V1/V2 之间的重复
- `clipboard.js`、`latest.js`：两版**几乎逐字相同**（`clipboard.js` 两版各 94/95 行、函数体 14-94 行一致；`latest.js` 的 `createLatestGate` 一致）`[通读]` `[已复核]`
- `dom.js` 的 `el()` / `debounce()`：相同；其余见 §10.1d 的逐文件差异表
- **`test/manual/states.mjs`（约 66KB）只覆盖 V2**；V1 的交互状态探针只有 `probe-ui-old.mjs` `[通读]`

---

## 7. 可优化点（O-01 ~ O-09）

### O-01 `/ui/api/overview` 每次请求把同一批重查询各跑一遍（**首屏性能**）
- **位置**：`src/ui/routes.ts:583-602`（`overview` 处理体）与 `src/ui/routes.ts:72-121`（它调用的 `deploymentInfo`）`[已复核]`
- **类别**：性能 + 冗余实现
- **严重级别**：**High**（每次首屏 / 每次轮询发现变更 / 每次写操作后都会命中）
- **说明**（逐行读出的调用链，已由复查子代理独立复核）：
  - `overview` 在 **L586** `await storage.totalHistorySize()`（第 1 次），在 **L587-592** 的 `Promise.all` 里再跑 `db.statistics(...)`（第 1 次）、`countByTypeViews(...)`（第 1 次）、`readChangeMarker(...)`、`deploymentInfo(...)`；
  - `deploymentInfo` 内部 **L75** `storage.totalHistorySize()`（第 2 次）、**L76-81** 的 `Promise.all` 里 `db.statistics(...)`（第 2 次）、`countByTypeViews(...)`（第 2 次）、`db.getMetaValues(...)`、`readRetentionSettings(...)`。
  - ⇒ 单次 `/ui/api/overview` = **2 × `totalHistorySize`（R2 全桶列举）+ 2 × `statistics` + 2 × `countByTypeViews` + 1 × `readChangeMarker` + 1 × `getMetaValues` + 1 × `readRetentionSettings`**。
- **建议方案与预期收益**：把 `deploymentInfo` 拆成两层——`deploymentStats()`（bytes/stats/views）与 `deploymentMeta(env, origin)`（retention/meta/version/hubTransports）；`overview` 调 `deploymentStats()` 一次后把结果传给 `deploymentMeta`；`/ui/api/info` 自己调 `deploymentStats()`。首屏 R2 子请求从 2×N 降到 N，聚合查询减半。
- **改动风险与注意事项**：
  - **`deploymentInfo` 同时被 `/ui/api/info` 单独调用**（`src/ui/routes.ts:555`），所以不能把 `{bytes,stats,views}` 做成**必填参数**——否则 info 那一路也得先算一遍，省不到任何东西。必须按上面的"两层拆分"做。
  - 当前 `overview` 顶层 `stats` 与 `info.storage` 来自**两次独立扫描**，合并后变同源。这是改善，但**改变了"同一次请求内两处可能不一致"的既有行为**（无测试覆盖，风险低）。
  - **顺手可修的一处**：`overview`（L585）的 `parseDeletedFlag` **没有 try/catch**，而 `/ui/api/statistics`（L532-539）有 → 非法 `deleted` 值时 overview 会 **500** 而 statistics 会 400。建议一并统一。

### O-02 统计体积用 R2 全桶扫描，而 D1 里已有 `Size` 列（**但改动会构成协议偏离**）
- **位置**：`src/storage.ts:199-210`（实现）；调用点 `src/routes/history.ts:233`、`src/ui/routes.ts:75`、`src/ui/routes.ts:540`、`src/ui/routes.ts:586` `[已复核]`
- **类别**：性能 + **契约变更**（不是纯性能优化）
- **严重级别**：**High**（但性质见下）
- **说明**：`/api/history/statistics`（**官方协议端点**，客户端会调）、`/ui/api/statistics`、`/ui/api/info`、`/ui/api/overview`（×2）都走它。改成 D1 聚合（`SELECT COALESCE(SUM(Size),0) … WHERE IsDeleted=0`）能消掉全部 R2 扫描，**但会改变对外语义，差异有三条**：
  1. **D1 会多算内联文本**：`src/profile.ts:139/310` 对 Text 记录写入 `size = 文本字节数`（`defaultInlineSize`），而这些记录**没有 R2 对象**。`SUM(Size)` 会把它们算进去，R2 扫描不会。
  2. **D1 会少算孤儿对象**：R2 扫描含孤儿，D1 不含。而 `/ui/api/integrity`（`src/ui/maintenance.ts`）**恰以"记录有数据但 R2 无对象"为判据** → 两个诊断面会长期互相打架。
  3. **这是协议面端点的对外值**：`docs/protocol.md:464` 明确登记"`totalFileSizeMB` = **按 R2 对象 size 求和**，与上游遍历目录**等价**"。改 D1 聚合 = **主动偏离上游** → 按本仓库自己的规矩，必须改 `docs/protocol.md` 的差异表并登记为"有意偏离"。
- **建议方案与预期收益**：
  - **方案 1（推荐，不改变协议语义）**：只做 O-01 的 `overview` 去重，`totalHistorySize` 保留 R2 扫描但**在单次请求内只算一次**。收益：首屏 R2 列举从 2×N 降到 N。
  - **方案 2（激进）**：改 D1 聚合。收益：4 个端点的 R2 扫描归零。代价：**未登记的协议偏离** + 上述两条口径差异，且需在 `docs/protocol.md` 登记。
- **改动风险与注意事项**：
  - **原稿把"跑 `test/ui.test.ts` 核对口径"写成了验证方式，这是错的**（经复查）：全仓 `grep totalFileSizeMB` 在 `test/` 下**只命中 `test/cleanup.test.ts:156-157`**（断言 `> 0`），`test/ui.test.ts` 里**一条都没有**。照原验证清单执行会得到"以为验过"的假绿。
  - 若走方案 2，**前置动作**：先写一条**双口径对照**用例——造一条带数据文件的记录 + 一条纯内联文本记录 + 一个孤儿对象，分别断言 R2 扫描值与 D1 聚合值，把差异钉住，再决定口径（或引入第三个字段区分）。

### O-03 `cleanup` 的 4 个游标键已不承担行为，只剩展示
- **位置**：`src/cleanup.ts:108-113`（`CLEANUP_META_KEYS.cursors`）、`197`（`ZERO_CURSORS`）、`567-575`（读）、`600-605`（递增/清零）、`618-624`（写回）；配套 `src/ui/routes.ts:113-118`（读来展示）`[已复核]`
- **类别**：复杂度 / 结构性（"看起来像断点续跑、实际不是"）
- **严重级别**：Medium
- **说明**：游标被读出、累加、写回、并在 UI 上展示，但**从不参与查询或截断判定**——`cleanup.ts:193-196` 自己解释了原因："候选集是单调消耗的…下一轮从游标'继续'不需要 SQL OFFSET"（真正的续跑信号是 `CleanupResult.truncated` 与各阶段的 `hasMore`）。也就是说，游标**当前是一个纯计数/展示量**，却以"断点续跑机制"的形态存在。
- **建议方案与预期收益**：二选一——① 保留"展示语义"但**改名与改注释**（如 `cleanup:lastBatchCount:<phase>`），让读代码的人一眼看出它不是续跑状态；② 若确认不需要展示，删掉这 4 个键与全部读写。**推荐 ①**：`README.md:364-366` 与 `docs/protocol.md` 已把"清理可观测面"写成对外能力。收益：②可删约 20 行 + 每轮少写 4 个 Meta 键；①可消除一个**严重的理解陷阱**（"有游标 ⇒ 一定在续跑"是很自然的误读）。
- **改动风险与注意事项**：低（不影响清理行为）；但删键会触碰 `test/cleanup*.test.ts` 对 Meta 的断言与 `README` 的可观测面描述。

### O-04 PUT 路径把整个对象读进内存（**已登记，明确不做**）
- **位置**：`src/profile.ts:244-271`（缓冲在 **L261**）`[已复核]`
- **类别**：性能 / 内存
- **严重级别**：Medium（**属"已评估、当前不做"的已知限制**）
- **说明**：`README.md:439-441`、`docs/protocol.md`(PUT/POST 差异行)、`src/requestLimits.ts:19-24` 都明确记录了"R2 没有 move/rename、上游用 `File.Move` 不读数据；本实现峰值 ≈ 文件大小"，并给出 48 MiB 上限 + 解压预算随请求体收缩的完整推导。
- **建议方案与预期收益**：**不动**。若要动，是"改成流式（架构级）"，已在 `docs/progress.md` §48.4 记有评估结论。登记价值：避免被当作"新发现的性能缺陷"重复处理。
- **改动风险与注意事项**：**高**（架构级）。

### O-05 清理任务软删路径逐条广播（**需决策**）
- **位置**：`src/cleanup.ts:384-390`（`for (const e of rows) await broadcast(...)`）`[已复核]`
- **类别**：性能（子请求配额）
- **严重级别**：Medium
- **说明**：软删每条记录 1 次 DO 广播。这正是 `SUBREQUEST_BUDGET` / `PHASE_RESERVE` / `MAX_BATCHES_PER_PHASE` 这套记账模型存在的原因（`cleanup.ts:46-93`）。
- **建议方案与预期收益**：可选——改为"每批一次聚合广播"或"不广播、依赖客户端轮询收敛"。可简化 `cleanup.ts` 大部（当前 639 行）；降低 Cron 子请求消耗。
- **改动风险与注意事项**：中——会成为**"有意偏离"**（上游 `OnRecordDeletedAsync` 是逐条广播）；`test/cleanup*.test.ts` 的多处断言依赖当前预算行为。**归 P5（取舍），不是清理。**

### O-06 V2 `api.js` 默认超时 20s 短于 V1 的 30s，而 `integrity` 可能不够
- **位置**：`public/ui/js/api.js:22`（20_000ms）vs `public/ui_old/js/api.js:35`（30s，注释解释"integrity 要列举一遍 R2，实测秒级"）`[通读]`
- **类别**：错误处理 / 稳健性
- **严重级别**：Medium
- **说明**：`api.integrity()`（`api.js:192`）与 `updateSettings`（L195）都走默认超时。R2 对象多时 20s 偏紧，失败后会被 `boot.js:250-254` 吞成提示。
- **建议方案与预期收益**：为 `integrity` **单列更长超时**。
- **改动风险与注意事项**：**不要全局改成 30s**——`test/ui-input.test.ts:175-183` 用假定时器推进 **20_000 ms** 并断言 `api.session()` reject `请求超时`；改成 30s 后该用例在 20s 时**不会 reject**，`await` 永不结算 → vitest 超时挂掉。给 `integrity` 单列超时则不影响该用例。

### O-07 V2 首屏对 `overview` 响应里不存在的 `activity` 字段做了无效读取
- **位置**：`public/ui/js/boot.js:568`（`activity: data.activity ?? state().activity`）↔ `src/ui/routes.ts:593-601`（overview 的返回键）`[已复核]`
- **类别**：死读取（一致性）
- **严重级别**：Low
- **说明**：`/ui/api/overview` 的返回键为 `stats`/`byType`/`byTypeActive`/`marker`/`info`/`serverTime`，**没有 `activity`**。因此 `data.activity` 恒为 `undefined`，那次独立请求（`boot.js:600` + `:1130`）**是必要的**，但 `boot.js:568` 的读取是**死读取**。原稿曾把这一条列为"重复请求"，经复核**该结论错误**（独立请求是必需的）。
- **建议方案与预期收益**：删除 `boot.js:568` 对 `data.activity` 的无效读取（保留 `state().activity`），或让 overview 真的返回 activity 并删掉独立请求——**二选一，不要既读一个不存在的字段又发一次请求**。
- **改动风险与注意事项**：低。

### O-08 其余结构性 / 复杂度项（逐项独立、低风险）

| 编号 | 位置 | 类别 | 级别 | 问题 | 建议 | 风险 |
|---|---|---|---|---|---|---|
| O-08a | `src/index.ts:74` 与 `:127` | 冗余 | Low | 尾斜杠归一那 1 行代码在两个中间件里各写一遍 | 抽 `normalizePath(c.req.path)` | 无 |
| O-08b | `src/index.ts:58/85/113/118/141/169`、`src/auth.ts:191`、`src/ui/guard.ts:38/46`、`src/durable/SyncClipboardHub.ts:158/167/189` | 结构性 | Low | "提前返回前必须 `drainRequestBody`"这一纪律被复制到约 13 个提前返回点，每处带 2~4 行同源注释 | 可考虑 `earlyReturn(request, response)` 助手 | 低，但助手要确保"读体 → 返回"顺序不变；**该纪律本身必须保留** |
| O-08c | `src/ui/routes.ts:158-189` | — | — | `parseRangeHeader`/`resolveRange` 有意只支持单段 Range、不做 If-Range | **明确不做**（实现正确、注释充分） | — |
| O-08d | `public/ui/js/boot.js`（1228 行） / `public/ui_old/js/main.js`（1287 行） | 结构性 | **Medium** | 两版最大的单文件都是"装配 + 数据 + 渲染"的集中点；V2 已把渲染拆到 `js/ui/*`，V1 未拆。V1 的 `actions`（约 L190-278）与 `preview/list/confirm/toasts` 有闭包耦合 | 优先抽 `messages.js`（R-08，零行为变化）；其次抽 `actions.js` | **高**：`createPreview` 在 `actions` 之前定义、`actions.onPreview` 又被 list 读取；modulepreload 与守卫也要同步 |
| O-08e | `public/ui/js/ui/overview.js:165-177` | 冗余 | Low | `formatSizeShort` 与 `format.js:21-33` 的 `formatSize` 是同一套单位换算（该文件**已 import** 了 `format.js` 的 `formatAgo`） | 改 import 复用；或保留并注明默认值语义不同（概览 0 显示 `0 B`、列表 0 显示 `—`） | 低（改默认值会改"0 字节"的显示） |
| O-08f | `public/ui/js/ui/omnibox.js:5,7` | 冗余 | Low | 从同一模块 `../dom.js` 分了**两条** import 语句 | 合并为一条 | 无 |
| O-08g | `public/ui/css/shell-v2.css:210-213` 与 `:574-592` | ❌ **本行判定已推翻**（2026-09-18） | — | 原判"同一元素两条规则都写 `min-height: 70vh`"**不成立**：`#board-area` 是 HTML 里的**占位容器**，`.board-area` 是 JS 挂载时 `append` 进去的**子节点**（`boot.js:282` 的 `mounts.board.append(board.el)`，不是 `replaceWith`）。父子的 `min-height` 不会叠加，且**各管一个时刻**：父 → 首帧（子节点还不存在，CLS 修复的真正落点）；子 → 挂载后的空/骨架/错误态 | **不合并**。已把两条规则的注释改成准确表述（原先那条"首帧"注释挂在子节点上，与事实相反） | — |
| O-08h | `public/ui/js/ui/board.js:522`、`public/ui/js/ui/ghost.js:13` | 可读性 | Low | `function f() {  const x = …` 语句与左花括号同行、缺换行（eslint 不管格式） | 格式化 | 无 |
| O-08i | `public/ui/js/ui/drawer.js:432-435`、`:245-390` | 可读性 | Low | 一段 JSDoc 落在 `return` **之后**（悬空注释，显然属于 L244 的 `paint()`）；`:245-390` 缩进为 2 空格而其余为 4 | 移动注释、统一缩进 | 无 |
| O-08j | `public/ui/js/login.js:65,71` | 冗余 | Low | `clearError()` 在同一个 submit 流程里连续调用两次（第二次冗余） | 删除 L71 | 无 |
| O-08k | `public/ui/js/ui/row.js:228` | 结构性 | Low | 手写 `/ui/api/history/${type}/${hash}/data`，绕过 `api.js:222-225` 的 `dataUrl()` 封装（为遵守"组件不 import api"的分层纪律） | 把路径构造抽成**纯函数**供两者共用（如 `js/paths.js`） | 低；需与"组件不碰网络"的分层意图权衡 |
| O-08l | `src/ui/query.ts:369-422` | — | Low | `readActivity` 用 `strftime(…CreateTime/1000 + ?2, 'unixepoch')`：表达式使 `CreateTime` 索引用不上（已有注释说明"候选集先被范围条件筛过"） | **当前可接受**，不动 | — |

### O-09 V1（产品面）比 V2 少的两处小修（修法可直接从 V2 照搬）
- **位置**：`public/ui_old/js/filters.js:117`（pageSize 无档位吸附）、`public/ui_old/js/next-target.js:10-20`（登录页自身回落缺失）`[已复核]`
- **类别**：可优化点（产品面可用性）
- **严重级别**：Low
- **说明**：
  - **pageSize 档位吸附**：V1 的 `filtersFromUrl` 用 `clampInt(…, 1, 500)`（`filters.js:117`），URL 手写 `?pageSize=37` 会被保留为 37，但下拉的档位集合是 `PAGE_SIZES = [20,50,100,200,500]`（`filters.js:27`）——于是下拉落到**空选**。V2 用 `nearest(PAGE_SIZES, …)` 把 37 吸附到最近的档位（V2 `filters.js:129-133`）。**已复核**：V1 `filters.js` 内无 `nearest`。
  - **next-target 登录页回落**：V1 对 `?next=/ui_old/login.html` 会原样返回该路径（多一跳，见子代理推演：登录成功后落到无 `?next` 的登录页 → 再算一次 → 才跳列表），V2 显式回落到默认页（V2 `next-target.js:22`）。
- **建议方案与预期收益**：从 V2 照搬这两处（各约 5~8 行）。消除产品面上两个可被用户看见的小瑕疵（下拉空选、多一跳）。
- **改动风险与注意事项**：低。但注意 `test/ui-logic.test.ts` 目前测的是 **V2** 的 `filtersFromUrl`/`rangeBounds`，**V1 侧没有对应用例** → 改完应补一条 V1 用例，否则这两个修复没有守卫。

---

## 8. 测试套件（T-01 ~ T-10）

> 测试层的"重复实现"比产品层严重得多；这里也是**唯一一处高危**（测试复制生产安全算法）。

### T-01 ⚠️ `test/hardening.test.ts` 逐行复刻了会话密钥派生管线
- **位置**：`test/hardening.test.ts:24-46`（`HKDF_SALT`/`HKDF_INFO` 常量 + `forgeSessionCookie` 的 HKDF→HMAC 全流程）↔ `src/ui/session.ts:12-63` `[已复核]`
- **类别**：冗余与重复实现（**测试复制生产实现**）
- **严重级别**：**High**（安全相关）
- **说明**：文件头注释（L10）自己写着"本文件用**与 `src/ui/session.ts` 完全相同的派生管线**伪造空口令令牌"。问题在于：若生产侧改用别的 KDF、别的盐/信息串、或改动编码，测试**会继续用旧算法伪造**，于是给出"空口令令牌被拒"的错误结论。这条测试的**判别力依赖人工同步**，而注释是唯一的同步机制。
- **建议方案与预期收益**：让 `src/ui/session.ts` 导出一个**无守卫的纯派生原语**（如 `deriveSessionKey(password)` 或 `signTokenWithPassword(password, payload)`），**并把 `HKDF_SALT`/`HKDF_INFO` 一起导出**（否则测试仍要复制两个常量，只解决一半）。这样"生产改了算法 → 测试立刻跟随"。收益：消除一处**安全相关**的测试失真风险。
- **改动风险与注意事项**：
  - **只导出无守卫的纯原语**，**不要**导出 `issueSessionFor(env, username)` 这类带 `isAuthConfigured` 守卫或依赖 `env.PASSWORD` 的高层函数——否则未配置 `env` 时测试**造不出攻击令牌**，`readSession` 返回 null 就变成"令牌根本无效"而非"fail-closed 生效"，**判别力被削弱**（这正是这条用例存在的意义）。
  - 保留 `hardening.test.ts:61-74` 的**阳性对照**（正确口令签发的同形令牌必须被接受），它防的是"一律返回 null"的假绿。
  - 建议给导出的原语补一条"与 `issueSession` 产物形状一致"的对照测试，防止导出物与真实签发路径再次分叉。

### T-02 内存 D1 替身被复制了 4~5 份
- **位置**：`test/fixes.test.ts:89-120`(`FakeD1`)、`test/dto-validation.test.ts:33-62`(`FakeD1`)、`test/cleanup-budget.test.ts:52-88`(`CountingD1`)、`test/ui-activity.test.ts:38-67`(`FakeD1`)、`test/fixes.test.ts:532`(`FaultD1`) `[通读]`
- **类别**：冗余与重复实现
- **严重级别**：Medium
- **说明**：前四份 `prepare/bind/all/first/run` 结构几乎逐行相同，只有 `CountingD1` 多了计数与故障注入（`FaultD1` 是故障注入变体）。差异点仅 `bind` 的参数类型（`unknown[]` vs `never[]`）。
- **建议方案与预期收益**：新建 `test/support/sqlite-d1.ts`，导出可配置（计数、故障注入）的工厂，各套件只保留差异。删约 120~150 行。
- **改动风险与注意事项**：低，但需统一 `bind` 的参数类型签名。**新增 `test/support/*.ts` 不会撞守卫**：`test/docs.test.ts` 的套件计数（L42-52、L68）与写库名单判据（L182-191）都只**非递归地**数 `test/` 顶层的 `*.test.ts`；`test/support/` 已存在（`target-guard.ts`）。

### T-03 .NET 风格的 multipart 构造器被复制了 5 份
- **位置**：`test/cleanup.test.ts:38-56`、`test/fix-regressions.test.ts:33-51`、`test/dto-validation.test.ts:127-143`、`test/limits.test.ts:44-56`(`multipartBody`)、`test/query-filters.test.ts:84-103`（内联拼接） `[通读]`
- **类别**：冗余与重复实现
- **严重级别**：Medium
- **说明**：注释都写「.NET HttpClient 风格（无引号 name=）」，形状略异。
- **建议方案与预期收益**：抽 `test/support/multipart.ts`，暴露"无引号（.NET）"与"带引号（RFC）"两个变体。删约 80~100 行。
- **改动风险与注意事项**：低。

### T-04 同名重复条目 zip 构造器被复制 2 次
- **位置**：`test/fixes.test.ts:231-244`(`buildZipWithDuplicateNames`) 与 `test/limits.test.ts:86-99`(`streamedDuplicateZip`) `[通读]`
- **类别**：冗余与重复实现
- **严重级别**：Low
- **说明**：两个函数**功能等价**（用 fflate 流式 `Zip` + `ZipPassThrough` 构造同名重复条目 zip），代码逐行近似，仅函数名与内容不同。
- **建议方案与预期收益**：抽 `test/support/zip.ts`。删约 15 行。
- **改动风险与注意事项**：低（两处断言内容不同，抽公共构造器即可）。

### T-05 递归列文件函数被复制 3 份（其中 2 份在同一个文件里）
- **位置**：`test/ui-contract.test.ts:47-58`(`listFiles`)、`test/ui-guard.test.ts:284-292`(`walkFiles`)、`test/ui-guard.test.ts:373-381`(`walk`) `[通读]`
- **类别**：冗余与重复实现
- **严重级别**：Medium
- **说明**：`ui-guard.test.ts` 内的 `walkFiles` 与 `walk` **函数体逐字相同**，只是名字不同——这是最容易当场消除的重复。加之 `ui-contract.test.ts` 的 `listFiles`，共 3 份。
- **建议方案与预期收益**：抽 `test/support/fs-walk.ts`；至少先把 `ui-guard.test.ts` 内两个合并。删约 30 行。
- **改动风险与注意事项**：无。

### T-06 `stripComments` 有 3 种不同实现，判据互不一致（**且 JS 与 CSS 不可共用**）
- **位置**：`test/docs.test.ts:175-177`（先剥行注释 `(^|[^:])\/\/`，再剥**任意位置**块注释）、`test/ui-contract.test.ts:74-78`（先剥**行首**块注释，再剥行注释）、`test/ui-guard.test.ts:417`（裸剥任意位置块注释，用于 **CSS**） `[通读]`
- **类别**：冗余与重复实现 + 脆弱实现
- **严重级别**：Medium
- **说明**：三者都是为规避"注释里出现 `/ui/*` 通配写法被当成块注释起始"的同一个坑（`ui-contract.test.ts:63-73` 详述：曾导致 `boot.js` 的 import 全段被吞、24 条 modulepreload 被误报为多余）。三处判据不同 ⇒ 同一文件被三个守卫以不同方式"去注释"。
- **建议方案与预期收益**：**只把两处 JS 判据归一**（建议采用 `ui-contract` 的"位置受限"版本，它对该坑有明确防御）；`ui-guard.test.ts:417` 的 **CSS 扫描单独保留**（CSS 没有行注释，但 `overlay-v2.css:183` 的 data URI 里有 `xmlns='http://www.w3.org/2000/svg'`，与 JS 版共用只是"巧合安全"）。删约 20 行；两个 JS 守卫行为一致。
- **改动风险与注意事项**：**中**。前置动作：① 归一前跑三个守卫并**记录"写库套件集合"基线**；② 归一后比对集合完全一致；③ 重跑两条承重的"检查器对自己不命中"断言（`docs.test.ts:214-219`、`ui-contract.test.ts:229-232`）；④ **不要在断言里新增内联正例夹具**（`docs.test.ts:207-209` 明确警告过"正例夹具本身会命中判据"）；⑤ 补一条 `stripComments` 自身的单测（含 `/ui/*` 通配、`http://`、行首/行中块注释、紧贴 `//`）。

### T-07 `test/signalr.test.ts` 与 `test/transports.test.ts` 大幅重叠
- **位置**：`test/signalr.test.ts:70-135`（握手 / PUT 双广播 / PATCH 广播 / 35s 心跳，均走 WebSocket）↔ `test/transports.test.ts:116-118`（WS 握手）、`:50-85`（PUT 双广播断言） `[已复核]`
- **类别**：冗余与重复实现
- **严重级别**：Medium
- **说明**：`signalr.test.ts` 的"连接+握手"与"PUT 触发双广播"两条已被 `transports.test.ts` 的 `expectBroadcastOverTransport('ws', …)` 覆盖。它独有的是"PATCH 触发广播"与"35s 心跳"。心跳用**真实时钟** `delay(35_000)`，让整份套件至少多 35 秒。
- **建议方案与预期收益**：把"PATCH 广播"与"心跳"迁入 `transports.test.ts`（或迁到 `test/manual/`），删掉 `signalr.test.ts`。少一个完整套件。
- **改动风险与注意事项**（**连带面比原稿写的更大，且原稿的行号有错**）：
  - **必改的"22 个套件"位置共 7 处**：`README.md:135`、`README.md:208`、**`README.md:465`**（原稿误写为 `README.md:547`，而 README 只有 504 行）、`docs/design.md:494`、**`docs/design.md:547`**（CI 段的"全部 22 个套件"，原稿漏了）、`docs/ui.md:631`、`.github/workflows/deploy.yml:56`。
  - **另必改 `README.md:152-153`**：写库套件名单里含 `signalr`，而 `test/docs.test.ts:223-239` 用 `toEqual` 比对"README 括号内名单 == 实际 import `./support/target-guard` 的套件集合"——不改这一条，套件数改完仍会红。
  - **心跳若迁入 `transports.test.ts`，必须单独给该用例加超时参数**（transports 的用例超时是 20s，而心跳用 `delay(35_000)` → 会直接超时）。若不迁而直接丢弃，则失去"服务端 35s 真实心跳"这条唯一覆盖（`ui-logic` 用假定时器覆盖的是**客户端**心跳）。

### T-08 从不被 `npm test` 采集的手动脚本
- **位置**：`test/manual/probe.mjs`、`shoot.mjs`、`states.mjs`（约 66KB）、`probe-ui-old.mjs`（约 66KB）、`test/live-signalr.mjs` `[通读]`
- **类别**：死代码（相对测试套件）/ 手动工具
- **严重级别**：Medium（去留需决策）
- **说明**：`vitest.config.ts` 未设 `include`，走默认 `**/*.{test,spec}.?(c|m)[jt]s?(x)`；这些 `.mjs` 文件名不含 `.test.` / `.spec.` ⇒ **从不被收集执行**（`test/docs.test.ts:68` 也只数 `*.test.ts`，`README.md:465` 把它们与"22 个套件"并列区分）。它们是 CDP 驱动本机浏览器的**零构建前端唯一可视化验证手段**：`probe.mjs`/`shoot.mjs`/`states.mjs` 打 V2（`/ui/app/`），`probe-ui-old.mjs` 打 V1。
- **建议方案与预期收益**：**不要单独删**。去留与 §10 的前端收敛决策绑定：若收敛到 V1，`states.mjs`/`probe.mjs`/`shoot.mjs` 失去目标（`shoot.mjs` 仍有 V1 段）。`live-signalr.mjs` 保留并明确标注为运维脚本（线上真实 WS 冒烟）。最多删约 4,000 行。
- **改动风险与注意事项**：中——① 删早了会失去零构建前端的回归能力；② **`test/docs.test.ts` 有一条 `tests.lines / business.lines > 0.3` 的比值断言（L262-265）**：manual 脚本约 4,000 行，删掉后测试总行数下降，**需复跑该断言**（当前估算仍能过，但不能凭感觉）。

### T-09 与"有意偏离上游"绑定的测试（**保留**，改动前必须知道）
- **位置** `[通读]`：`test/fix-regressions.test.ts:656-681`（F29：协议侧 `/file/{name}` **忽略 Range**，对齐上游 `EnableRangeProcessing=false`）；`test/ui.test.ts:827-977`（UI 侧 `/ui/api/.../data` **支持** 206/416，有意与协议面不同）；`test/hardening.test.ts:101-127`（G6：SearchText 48 字节上限，本实现主动加固）；`test/query-filters.test.ts:145-155`（协议面 `SearchText` **不转义** LIKE 元字符，对齐上游）
- **类别**：有意偏离的守卫（**不是冗余**）
- **严重级别**：—（登记价值）
- **说明**：这几处是"我们**故意**与上游不同"的机器可读记录。任何"统一两侧行为"的重构都会撞上它们。
- **建议方案与预期收益**：保留。**未覆盖的疑似偏离**：`src/db.ts:149-153` 的 hash 等值匹配（上游是 LIKE 模式）与 `src/ui/query.ts:196-201` 的 LIKE 转义，**未找到对应断言 —— `[待确认]`**（§11 #12）。建议补两条断言把这两处偏离钉住。
- **改动风险与注意事项**：若将来"统一两侧行为"，必须先改这几条测试与 `docs/protocol.md` 差异表，否则会得到一堆红而不明白原因。

### T-10 其余测试层问题

| 编号 | 位置 | 类别 | 级别 | 问题 | 建议 | 风险 |
|---|---|---|---|---|---|---|
| T-10a | `test/limits.test.ts:190-211` | 脆弱断言 | **Medium** | F9 用**墙钟计时**断言"拒绝路径是常数时间"（`expect(t61).toBeLessThan(50)`）。CI 冷启动/负载下会 flaky，且对功能正确性无贡献 | 降级为 `console.log` 观测（同文件已有），只保留功能性断言（`parseBoundary` 返回 null） | 低 |
| T-10b | `test/protocol.test.ts:157-204` | 脆弱实现 | **Medium** | 守卫用**正则读 `src/index.ts` 源码**提取路由。一旦 `index.ts` 改用变量拼路径或多行调用，守卫会**静默漏检** | 让 `index.ts` 导出路由表供测试枚举；若不改，**在注释里标明这是脆点**（当前限制是"入口不能导出 app"，见 `src/index.ts:3-6`） | 中（改 `index.ts` 导出形态受 Worker 模块格式约束） |
| T-10c | `test/cleanup-budget.test.ts:37` | 常量镜像 | Low | 在测试里**重新定义**平台常量 `PLATFORM_SUBREQUEST_LIMIT = 1000` | 改为 import 或注明"此值来自 Cloudflare 平台文档，非实现常量" | 低 |
| T-10d | `test/ui-guard.test.ts:53-72` | 手工镜像 | Low | 手工维护 18 条 `/ui/api/*` 路由清单；新增端点必须同步（注释称是刻意的"逼迫登记"） | 保留（**它就是"删端点会红"的那道守卫**，见 §10.2）；可改为从源码生成 + 人工分类白名单 | 低 |
| T-10e | `test/ui-logic.test.ts:11-30` | 构建适配 | Low | 为让零构建前端通过类型检查，逐行 `@ts-expect-error TS7016`；且该文件**同时** import V2 与 V1 的模块 | 若在 tsconfig 为 `public/**` 增独立 project 可移除 directive；V2 去留决定后 `:23-30` 的 import 需改 | 中（改 tsconfig 影响 `npm run check`） |
| T-10f | `test/query-filters.test.ts:35-59,117-142` | 复杂适配 | **Medium** | 为规避"共享真实实例的历史夹具污染分页"引入"远期时间锚点"策略，复杂度可观（根因是测试实例不可重置） | 若 CI/本地能用一次性实例可大幅简化；否则在注释里指向根因 | 中 |
| T-10g | `test/dto-validation.test.ts:334-363` | 替身保真度 | Low | `harnessStorageGap` 分支：只在"测试替身 vs 真实运行时"不一致时走的降级断言 | 保留（注明该分支永久豁免），或把该场景移到真实实例验证后删除 | 中（删会失去对 CRLF/NUL 头注入的覆盖） |
| T-10h | `test/fixes.test.ts`(1085) / `test/fix-regressions.test.ts`(892) | 重叠覆盖 | **Medium** | 两套件按 F 编号覆盖同一批缺陷（单元层 vs HTTP 层）。**分层合理**（`fixes` 含纯逻辑 F12/F30/F5，HTTP 层测不到），但 F2/F4/F7/F8/F9/F31 在两层各覆盖一次 | 保留分层；若要精简，优先合并 `fix-regressions` 中与单元层语义**完全重叠**的用例，并在 `docs/design.md` 写明两层的分工 | 中（改动牵动 F 编号体系与文档口径） |

---

## 9. 文档 / 构建 / CI（M-01 ~ M-07）

### M-01 ⚠️ `test/docs.test.ts` 把文档内容做成了会红的断言（**须知，不是任务**）
- **位置**：`test/docs.test.ts:81`（`CURRENT_STATE_FILES`）、`:84-96`（套件数）、`:101-107`（资源数）、`:113-126`（design.md 套件清单）、`:223-239`（README 的写库套件名单）、`:262-265`（测试/业务行数比值）、`:268`（progress.md 的 `### 代码规模`） `[通读]`
- **类别**：结构性耦合（不是缺陷，但必须知道）
- **严重级别**：High（影响面：任何文档/资源/测试文件的增删都可能红测试）
- **具体耦合点（已按复查修正）**：

  | 被断言的内容 | 断言行 | 必须同步的位置 |
  |---|---|---|
  | 「N 个套件」必须等于 `test/*.test.ts` 实际数（当前 **22**） | `docs.test.ts:84-96` | `README.md:135`、`README.md:208`、**`README.md:465`**、`docs/design.md:494`、**`docs/design.md:547`**、`docs/ui.md:631`、`.github/workflows/deploy.yml:56` |
  | `README.md`「写库套件默认只允许指向本机」后的名单 == 实际 import `./support/target-guard` 的套件集合（**7 个**） | `docs.test.ts:223-239` | `README.md:152-153` |
  | `docs/ui.md` 的「共 N 个资源」必须等于 `public/` 递归文件数（当前 **87**） | `docs.test.ts:101-107` | `docs/ui.md:139`（+ 其明细表，但明细**不被**校验） |
  | `docs/design.md` 的「套件清单」段必须逐个列出全部 22 个套件名（段落 = 到第一个空行） | `docs.test.ts:113-126` | `docs/design.md:494-509` |
  | `docs/progress.md` 必须包含 `### 代码规模` | `docs.test.ts:268` | `docs/progress.md` |
  | 测试/业务行数比值 > 0.3 | `docs.test.ts:262-265` | 受"删测试或删 `test/manual/*`"影响 |

- **建议方案与预期收益**：不要求改，但**必须写进贡献流程**：任何"增删测试套件 / 增删 `public/` 下任何文件 / 删 `test/manual/*`"的改动，都要按上表同步。也可考虑把"套件数"改为**自动生成**（`docs.test.ts` 已经会数）。
- **改动风险与注意事项**：低（文档层）。这条的价值在于**它是"改一行文档→CI 全红"的根源**，`eslint.config.js:16-19` 记录过一次同类事故。

### M-02 `docs/progress.md`（5,278 行）的历史快照会被误读为现状
- **位置**：`docs/progress.md:2960-2973`（称 `public/ui_old` 是"V1 **冻结存档**"、`public/` 只有 **37** 个文件）vs `docs/progress.md:4729`（§70：「定位翻转：V1 成为默认界面，V2 降为开发测试版（2026-09-18，用户决策）」） `[通读]`
- **类别**：文档时效性
- **严重级别**：Medium
- **说明**：`docs.test.ts:74-80` **刻意豁免**了 `progress.md`（"它按轮次记录，里面全是历史快照"），所以里面的"20 套件""37 个文件""V1 冻结"都不会红。问题在于**它仍在被当作现状引用**（旧审计文档正是这样把结论建立在 §52/§55 的旧快照上）。
- **建议方案与预期收益**：① 在 `progress.md` **文件头**加导航说明："本文件是按轮次的历史记录；现状以 `design.md`/`protocol.md`/`ui.md` 为准；V1/V2 定位见 §70"；② 或在 §70 之前的历史段落顶部加"当时状态"标注。消除"旧快照被当现状"这一误判源（本次审计中已实际发生一次）。
- **改动风险与注意事项**：极低。

### M-03 文档里与代码不一致的一处注释
- **位置**：`docs/design.md:197`（`FilePaths` 标注为「业务未用，保留镜像」）↔ 实际 `FilePaths` 被写（`src/db.ts:89`、`src/profile.ts` 多处）且被读（`src/db.ts:56-60`、`src/serialization.ts:273/291` 用于推导 `hasData`） `[已复核]`
- **类别**：文档与代码不一致
- **严重级别**：Low
- **说明**：`docs/upstream-parity.md:72` 列的"保留/从不写入"清单**不含** `FilePaths`，与 `design.md:197`、`schema.sql:12` 的口径不一致。
- **建议方案与预期收益**：统一为「`FilePaths` 在 `profile.ts` 写入、在 `serialization.ts` 用于推导 `hasData`；对外协议与前端 DTO 均不含该字段」。避免被当成死列删除。
- **改动风险与注意事项**：无。（注：删 `FilePaths` 不是完全不可行——`hasData` 可退化为 `transferDataFile !== ''`——但那要同步改 `serialization.ts:273/291` 及其测试，属另一项独立决策。）

### M-04 `tools/ab-upstream-probe.ps1` 是正式登记的守卫，**不宜按死工具处理**
- **位置**：`tools/ab-upstream-probe.ps1`（205 行）；被 `docs/design.md` ADR **D10** 与 §12、`README.md:466/471` 登记；`test/fix-regressions.test.ts:753` 注释引用 `[通读]`
- **类别**：工具（**不是死代码**）
- **严重级别**：Low（**旧审计的"应归档或移除"结论已被推翻**）
- **说明**：它做"官方 v3.2.0 服务端发布件 × 本实现"的逐条 A/B 探测（34 条状态码用例 + 18 个 negotiate 取值），退出码 = 未登记差异条数。运行前提较重（PowerShell 7 + 系统 `curl` + .NET/AspNetCore 8 运行时 + 官方发布件 + 本机 `wrangler dev`），因此**本机大概率跑不起来**，但这与"死代码"是两回事。
- **建议方案与预期收益**：**保留**；在脚本头补一行运行前提说明；`README.md:472` 可补一句"当前环境是否具备运行前提"。
- **改动风险与注意事项**：若误删，`docs/design.md` ADR D10/§12 的证据链会悬空，而 §5.B 的 C-03/C-04/C-06 等结论正建立在该证据之上。

### M-05 `README.md` 引用了一个不在版本库内的路径
- **位置**：`README.md:418`（「安全审计的完整账目在 `.audits/cfserver-audit-003/`」） `[通读]`
- **类别**：文档引用失效
- **严重级别**：Low
- **说明**：`.audits/` 被 `.gitignore` 排除（`.gitignore:14`），仓库内不存在该目录；`docs/security-fix-plan.md:3` 自己也说它"不在版本库内"。两处口径不一致。
- **建议方案与预期收益**：`README.md` 补一句"审计账目不在版本库内"，与 `security-fix-plan.md` 统一。
- **改动风险与注意事项**：无。

### M-06 `.github/workflows/deploy.yml`（470 行，唯一 workflow）
- **位置**：全文件 `[通读]`
- **类别**：CI
- **严重级别**：Low（其中 `deploy.yml:56` 的套件数是 M-01 的耦合点）
- **说明**：流程清晰（`quality`：typecheck + lint + 22 套件；`deploy`：schema → deploy → 凭据同步（可选）→ 冒烟）。冒烟同时断言 V1（`/ui_old/`）与 V2（`/ui/`、`/ui/app/`）可达（`deploy.yml:462-466`），且 `UI_ENABLED=false` 时两者都须 404 —— **都是当前有效的步骤**，不存在"为已删除功能部署"。
- **建议方案与预期收益**：本轮无需改动。
- **改动风险与注意事项**：若按 §5 的 C-07 或 O-05 简化限速，需要**四处同步**：`deploy.yml:216-224`（输入）、`:271-276`（校验）、`:304-313`（vars 名单）、`src/env.ts:24-27`（类型），外加密钥 `README.md:227-230`。若走 §10 路线 A/B，还必须去掉 `deploy.yml:462-464` 对应前端的 `check_asset`。

### M-07 ⚠️ `package.json` 的 lint 脚本是 CLI 路径参数 —— 删任一前端目录都会让 `npm run check` 红
- **位置**：`package.json:12` `"lint": "eslint public/ui/js public/ui_old/js"` `[已复核]`
- **类别**：构建配置（**旧审计完全未提**）
- **严重级别**：**High**（影响面：任何删除前端目录的改动）
- **说明**：`npm run lint` 把两个目录作为**命令行路径参数**传给 eslint，而**不是**只靠 `eslint.config.js` 的 `files` glob。一旦 `public/ui` 或 `public/ui_old` 被删除，eslint 会报 `No files matching the pattern` 并以**退出码 1** 结束 → `npm run check` 与 CI `quality` 步骤全红。这正是 `eslint.config.js:16-19` 记录过的历史事故（"脚本此前写死 `public/ui/js`，V1 一被改名，`npm run lint` 就报 `No files matching the pattern`"）。
- **建议方案与预期收益**：走 §10 路线 A/B 时，**必须同步修改 `package.json:12`**（删掉已删目录，或改为 `.` + 依赖 `eslint.config.js` 的 `files` glob）。收益：避免"删了静态文件、CI 却红在 lint"的困惑。
- **改动风险与注意事项**：低（改一行）。**注意**：`eslint.config.js:20` 的 `files` 也已覆盖两个目录，留着一个不存在的路径不会报错，但注释会失真。

---

## 10. 双前端：定位已定（V1 产品 / V2 开发版）与 N-01 ~ N-05

> 既有审计文档把它判为 P0「删除 V2」。**项目方已明确否定该判定**：`ui_old` 依旧是主流/默认界面（**产品面**），`public/ui`（V2）是**开发版、允许以后破坏性重构**。
> 本节据此给出：**10.1 事实**（含上游源码与官方客户端两侧的证据）、**10.2 已定策略** + 两条收敛路线（保留备查、**当前不做**）、**10.3 附带发现与新增策略项**（含 N-05 重写验收清单）。

### 10.1 事实

**（a）当前定位（多处一致）**：`ui_old` = **默认界面**（挂在 `/ui_old/`）；`public/ui` = **开发测试版**（挂在 `/ui/` 与 `/ui/app/`）。
依据：`wrangler.toml:82-88`、`src/index.ts:217-223`、`src/routes/webdav.ts:38-41`（根路径 302 → `/ui_old/`）、`src/ui/notFound.ts:68`、`public/_headers:26-34`、`README.md:41/251`、`docs/ui.md:120-130`、`docs/progress.md:4729`（§70，2026-09-18 用户决策）、`test/ui-guard.test.ts:456-472`（断言入口链一致）。

**（b）文档明确要保留 V2**：`eslint.config.js:15` 称 V2「**重写中**」；`docs/ui.md:135-137` 列出**保留 V2 的三个理由**（零构建对照基线 / 开发实验场 / 与协议零关系）`[通读]`。

**（c）V2 不是 V1 的超集 —— 它回退了 V1 已修的三个缺陷**（由两个子代理**独立**发现，主审计人已逐条确认 `[已复核]`）：

| # | 缺陷 | V1（已修） | V2（回退） | 后果 |
|---|---|---|---|---|
| 1 | **未来时间戳的显示** | `public/ui_old/js/format.js:56-63`：`if (diff < 0)` 分支区分"刚刚/N 分钟后/小时后/天后"，注释记录了实测缺陷——未来时间戳曾退回 `formatClock` 显示成「09:03」，看起来像"今天早上刚发生的" | `public/ui/js/format.js:60`：`if (diff < 0) return formatClock(new Date(ms));` —— **正是被修掉的那个行为** | 服务器时钟偏快时（`docs/protocol.md` 记录的常见场景），V2 列表把未来记录显示成一个绝对时刻，误导排障 |
| 2 | **跨夏令时的日期运算** | `public/ui_old/js/filters.js:47-58` 的 `addDays()` 用 `date.setDate()`（日历运算）；注释写明"常数 24 小时在跨夏令时会落偏一小时" | `public/ui/js/filters.js:66/81/83/113` 改用 `±DAY_MS` 常数 | 在夏令时地区，"近 7 天/近 30 天"的时间范围会落偏一小时 |
| 3 | **推送的冷却重连** | `public/ui_old/js/signalr.js:26-30,86-98,187-194`：`RETRY_COOLDOWN_MS=10min` 冷却重连；连续失败后**仍会重试** | `public/ui/js/push.js:79`：连续失败 5 次后**直接 return**（无冷却，不再重建）；`start()`（L160-169）不重置 `retryDelay`，也不清冷却计时器 | 被代理/CSP 稳定阻断的环境里，推送**不自愈**——`push.js:2` 的注释自称"从 V1 原样保留（含它踩过的那个 teardown 判据坑）"，而 V1 已修掉这个缺陷。⚠️ **准确表述**：并非"永久失效"，`push.js:24` 注释与 `boot.js:1146-1155` 的 `visibilitychange` 实现表明"切回前台会重新 `start()`"，故正确说法是"**在标签页保持可见期间不自愈；切走再切回或刷新才恢复，且恢复后退避可能仍停在 60 秒档**" |

**（d）两版同名文件的重复度（`[通读]` `[已复核]`）**：

| 文件对 | 结论 |
|---|---|
| `clipboard.js` | **几乎逐字相同**（函数体 14-94 行完全一致） |
| `latest.js` | **几乎逐字相同**（`createLatestGate` 一致） |
| `dom.js` | V2 是 V1 的超集（`el`/`debounce` 相同；V2 另有 `replayAnimation`/`clear`/`isTypingTarget`/`isTextInput` 与 `svg().filled`） |
| `format.js` | **双向差异**：V1 独有 `typeChipClass`/`safeFileName`/`downloadNameForText`/未来时间处理；V2 独有 `dayGroup`/`formatAgo`/`describeClockSkew`/`startOfDay` |
| `filters.js` | **双向差异**：V1 独有 `addDays`（DST 安全）；V2 独有 `SORT_FIELDS`/`RANGE_PRESETS`/`nearest`/`isDefaultFilters`/`viewOf` |
| `icons.js` | V1 独有 `push`/`connecting`；V2 独有 10+ 个（含 3 个本身还是死的，见 D-11） |
| `signalr.js` ↔ `push.js` | **V1 更新**（见上表 #3） |
| `theme-init.js` | **有意重写**（V2 改为硬编码颜色映射，理由是"首帧样式表未加载时 `getComputedStyle` 取不到自定义属性"）。⚠️ **该理由的时序前提本身待验证**（§11 #10）——V1 的该脚本是 `<head>` 里位于 `tokens.css` **之后**的经典阻塞脚本，按 HTML 规范前置样式表会阻塞它，故两种说法静态无法裁决 |
| 消息文案 | V1 内联 6 个函数 vs V2 `messages.js` **逐字重复**（见 R-08） |
| `main.js`(1287) ↔ `boot.js`(1228) + `ui/*`(16 个) | 架构级差异：V2 已拆分 |

**（e）服务端端点归属（纠正旧审计文档）** `[已复核]`：

| 端点 | V1 | V2 | 结论 |
|---|---|---|---|
| `/ui/api/overview` | ✅ `api.js:216` / `main.js:439` | ✅ `api.js:207` / `boot.js:552` | **两版共用** |
| `/ui/api/activity` | ✅ `api.js:248` / `main.js:494` | ✅ `api.js:214` / `boot.js:600` | **两版共用** |
| `/ui/api/history/batch-meta` | ✅ `api.js:225` / `main.js:722` | ❌ 有定义无调用（`api.js:180`） | **仅 V1 使用** |
| `/ui/api/statistics` | ✅ `api.js:205` / `main.js:411` | ❌ 完全不引用 | **仅 V1 使用** |
| 其余（session/login/logout/history/PATCH/batch-update/clear/integrity/settings/info/poll/hub-ticket/data） | 均使用 | 均使用 | 两版共用 |

⇒ **"这些端点是为 V2 开的"是错的**。若按旧文档执行，`/ui/api/overview`、`/activity`、`/batch-meta` 会被删掉，**立刻打断默认界面（V1）**；而且**删任何一条 `/ui/api/*` 路由都会让 `test/ui-guard.test.ts:80-84` 的 `EXPECTED_API_ROUTES` 盘点断言变红**（18 条 `toEqual`）。

### 10.2 定位已定（**不再是待决策项**）+ 两条收敛路线（**当前均不做**，清单备查）

> **项目方已明确（2026-09-18）**：`public/ui_old`（V1）**依旧是主流、是默认界面**（**产品面**）；`public/ui`（V2）是**开发版，以后可能会破坏性重构**。
> 因此本报告**不再把"双前端去留"列为待决策项**，改按下列策略执行：
> 1. **不删除任何一版**，也不为收敛做连带改动（下表的完整清单**保留备查**，将来真要收敛时可直接取用）。
> 2. **产品投入优先给 V1**：V1 的死代码（**D-13**）、V1 的守卫缺口（**N-01**）、V1 的功能小修（**O-09**）、V1 自己的文案模块（**R-08**）都值得做。
> 3. **V2 只做"零成本"的事**：V2 内部死代码（D-05~D-11）**降级为可选**——重写会自然消掉它们，单独清是浪费动作。
> 4. **V2 重写必须带走的验收项**：§13.3 的三条缺陷（它们是 V1 已经修好的，不能在重写中丢失第二次）。
> 5. **不要跨版抽公共模块**：不要把 V1 与 V2 的 `clipboard.js`/`latest.js`/`dom.js` 等合并为一个共享文件——V2 会重写，共享层会变成负担；而且 `test/ui-guard.test.ts:354-360` 本就**明令禁止 V1 跨目录依赖 `public/ui`**。
> 6. **R-08 的含义随之变化**：不是"让 V1 去共用 V2 的 `messages.js`"，而是"**让 V1 拥有自己的 `messages.js`**"，并修掉 V1 里那两处声称"两版共用"的错误注释（事实上 V1 目录里根本没有 `messages.js`）。

> **执行前必读（仅当将来真要收敛时）**：① 端点不能删（见 10.1e）；② 删除任一前端目录都要改 `package.json:12` 的 lint 路径（M-07）；③ 套件数与资源数有 7+1 处文档耦合（M-01）。

| 路线 | 动作 | 净删 | 必须先做 / 连带改动 |
|---|---|---|---|
| **A. 收敛到 V1（保默认界面）** | 删 `public/ui/**`、V2 专属测试、V2 探针；`redirect-hash.js` 与 `/ui/` 跳转壳一并移除；`deploy.yml` 冒烟去掉 V2 的三条 `check_asset` | ~6,000+ 行 | **连带测试文件（原稿遗漏 3 个）**：`test/ui-contract.test.ts`（顶部 import + `PAGES` 读 `public/ui/app/*.html`，整套失去目标）、`test/ui-input.test.ts`（全部 import 来自 V2）、`test/clipboard.test.ts`（import `public/ui/js/clipboard.js`——可改指 `ui_old` 的同名模块，需确认导出面一致）、`test/next-target.test.ts`（import V2 的 `resolveNext`，或改指 V1）、`test/ui-logic.test.ts`（6 条 V2 import + 6 个 describe）、`test/ui-guard.test.ts`（`readFileSync('public/ui/index.html')` 的入口链用例 L459、`run_worker_first` 四模式用例 L479-490）。**另**：`package.json:12`、`docs/ui.md:139`（87 个资源会大降）、`eslint.config.js:20` 的 `files` |
| **B. 收敛到 V2（把重写做完再切换）** | 先把 10.1c 的**三个 V1 修复回移**；再删 `public/ui_old/**` 与 V1 的守卫/探针 | ~7,000+ 行 | **⚠️ 原稿的"302 目标改 `/ui/`"是错的**：`/ui/` 是 `public/ui/index.html` 这个跳转空壳，其 meta refresh + canonical 指向 `/ui_old/` → 用户会被再送到**已删除的 `/ui_old/`**。正确做法是 **302 目标改 `/ui/app/`**，或同时删除空壳并把应用搬到 `/ui/`。**连带**：`public/ui/app/index.html:134` 的"默认界面"死链、`public/ui/index.html`、`src/index.ts` 与 `src/ui/notFound.ts` 的 `/ui_old/` 引用、`wrangler.toml` 的 `run_worker_first`（去 `/ui_old`）+ `test/ui-guard.test.ts:487` 的四模式断言、`public/_headers` 的 6 段 `/ui_old/*` 规则、`package.json:12`、`test/ui-guard.test.ts`（V1 前缀/契约两个 describe）、`test/ui-logic.test.ts:26/30`（V1 import）、`test/manual/probe-ui-old.mjs`。**前置**：三个修复 + **`#Type-hash` 深链接的新落点**（`redirect-hash.js` 只存在于 `/ui/` 空壳里） |
| **C. 明确定位为"默认 + 实验"共存（现状显式化）** | 不删；补两版缺口：V1 补 `messages.js`（R-08）、V2 补三个修复（10.1c）与 `retryAfterSeconds`（D-08）；在 `docs/ui.md` 写清"哪些改动要同时改两版" | 0（但修 4 个缺陷） | 明确承诺"双份维护"的成本。**注意**：新增 `ui_old/js/messages.js` 会让资源数 87→88；若为这些修复新增测试文件，套件数也会变 → 都要同步文档（M-01） |

### 10.3 附带发现与新增策略项（**产品面优先**）

- **N-01｜V1 缺两条守卫：modulepreload 闭包、挂载点字面量单一性**
  **先修正第一轮的表述**：V1 **并非"没有守卫"**。`test/ui-guard.test.ts` 里已有 V1 的「接口前缀与两页一致性」（`:281-330`，含"V1 源码里不得出现 `/ui_old/api`"——守的正是 2026-09-15 的真实事故）与「V1 的样式层契约」（`:370-491`，含令牌不空转 / `:active` / `aria-invalid` / 入口链 / `run_worker_first`），以及"页面引用的资源必须存在"（`:343-`）。
  真正缺的是**两条**：
  ① **`modulepreload 清单 == 该页入口的 import 闭包`**：V2 有（`test/ui-contract.test.ts:214-224`），V1 **没有**。注意 `ui-contract.test.ts:8` 声称"V1 的清单在 ui-guard 里已逐条核对过"，但 Grep 确认 **`modulepreload` 在 `test/` 下只出现在 `ui-contract.test.ts`**——那个说法不成立。
  ② **挂载点字面量单一性**：`public/ui_old/js/login.js:41`、`main.js:1094`、`api.js:270` 三处硬编码 `/ui_old`，而 `ui-guard.test.ts:294-325` 只把**接口前缀**收成单一字面量，**不管挂载点**。
  **级别**：Medium　**建议**：① 把闭包断言抽成可复用函数，对 V1/V2 两个目录各跑一次（或把 V1 两页加进 `PAGES`）；② 在 V1 `api.js` 增 `export const PAGE_BASE = '/ui_old'` 供那三处引用，并在 `ui-guard.test.ts` 补"挂载点字面量只允许出现在常量定义处"的断言。**风险**：中——`login.js:41` 的默认值还承担跨页契约；且 `ui-guard.test.ts:343` 的"资源存在性"用例是按 `/ui_old/` 前缀推导相对路径的，改常量时**不要动那个前缀的语义**。
- **N-02｜PWA manifest 指向 V2，与当前默认界面不一致**：`public/ui/manifest.webmanifest:7` 的 `start_url = /ui/app/`（V2），而默认界面是 V1 —— 装成 PWA 会直接进 V2。另 `manifest` 的 `theme_color`（`#0f766e`）与 HTML 静态值（`#f5f2ee`）及 `theme.js` 的 BG 映射语义混用。
  **级别**：Low　**建议**：随 §10 路线决定；若保 V1 需改 `start_url`。**风险**：低（影响已安装 PWA 的表现）。
- **N-03｜V1 硬编码了 4 个服务端常量、无守卫**：`public/ui_old/js/components/info.js:16-28`（保留期/条数上限的默认与最大值）与 `src/ui/maintenance.ts`、`src/cleanup.ts` 逐字同值但无自动校验。
  **级别**：Low　**建议**：补一条单测断言四值与服务端常量相等（与 `ui-guard.test.ts` 的"令牌不空转"同风格）。**风险**：低（若无守卫，服务端改上限后 V1 会"填了合法值却被本地拦下"）。
- **N-04｜V1 缺交互状态探针**：`test/manual/states.mjs`（选中态/批量条/浮层/reduced-motion）**全部指向 V2**（`/ui/app/`）；V1 只有 `probe-ui-old.mjs`（读值）。
  **级别**：Low　**建议**：把 `states.mjs` 的 URL 参数化（`--base-path`），而非复制一份 66KB 脚本。**风险**：中（参数化需逐个替换约 12 处硬编码 URL）。
- **N-05｜V2 重写的验收清单（新增，本轮最重要的流程项）**
  **级别**：Medium（流程）
  **说明**：既然 V2 允许破坏性重构，本报告里所有关于 V2 的结论（哪些是死代码、哪些是已回退的修复）最有价值的用法，不是"现在去清"，而是**变成重写的验收清单**，避免重写后再犯同一批错。
  **建议**：新增 `docs/ui-v2-rewrite-checklist.md`（或在 `docs/ui-v2-design.md` 顶部加一节），至少包含：
  1. **§13.3 的三条缺陷及其断言**（未来时间戳 / 跨 DST 日历运算 / 推送冷却重连）——**V1 已修，不能在重写中丢第二次**；
  2. **重写时不要照抄的现有实现**：V2 的三个死导出（`icons.js:10/99`、`format.js:47`、`ui/dialog.js:23`、`ui/row.js:17`）、三个死图标（`icons.js:58-64`）、5 条无生产者 CSS 规则（`overlay-v2.css:662-674`、`board-v2.css:377`）、死方法组（`state.js:25-28`、`ui/board.js:501-503`、`ui/overview.js:151-155`、`ui/drawer.js:429`）、死分支（`messages.js:83-88` 的 `retryAfterSeconds`）、不存在的路径判断（`next-target.js:22`）——见 §4 D-05~D-11；
  3. **`retryAfterSeconds` 契约**（D-08）：若重写保留 429 的精细文案，必须同时保留 `api.js` 对该字段的填充，否则文案再次变成死分支；
  4. **`modulepreload 清单 == import 闭包` 断言必须继续通过**（`test/ui-contract.test.ts:214-224`）——它是"新 HTML 配旧模块"这类故障的唯一机器守卫；
  5. **不要把 V1 的功能缺口带进 V2**（O-09 反向）：V2 已有 `pageSize` 档位吸附与 `next-target` 登录页回落，重写时别丢。
  **风险**：低。

---

## 11. 待确认清单（含验证方式）

| # | 事项 | 判断依据 | 验证方式（可直接执行） |
|---|---|---|---|
| 1 | ~~双前端去留方向~~ → **已定，不再是待确认项**：`ui_old` = 产品/默认界面；`public/ui`（V2）= 开发版，允许破坏性重构（§10.2） | 项目方 2026-09-18 明确 | 无需验证。**替代的待办**：V2 重写的**范围与验收清单**何时落地（见 N-05）——这是本轮唯一还"悬着"的前端事项 |
| 2 | **O-01/O-02：统计口径** | D1 聚合 = 活跃记录**声明**大小之和（**含内联文本、不含孤儿**）；R2 扫描 = 实际对象字节（含孤儿、不含内联文本） | ① 先跑双口径对照：造"带数据文件的记录 + 纯内联文本记录 + 一个孤儿对象"，分别读 `SELECT COALESCE(SUM(Size),0) FROM HistoryRecords WHERE UserId='default_user' AND IsDeleted=0` 与 `bucket.list({prefix:'history/'})` 求和；② **注意**：现有断言只在 `test/cleanup.test.ts:156-157`（`> 0`）——`test/ui.test.ts` 里**没有** `totalFileSizeMB` 断言；③ 若走方案 2，必须同步 `docs/protocol.md:464` 并登记为"有意偏离" |
| 3 | O-07：`/ui/api/overview` 是否返回 `activity` | **已复核：不返回**（返回键为 `stats/byType/byTypeActive/marker/info/serverTime`，`src/ui/routes.ts:593-601`）→ 本条已从"待确认"转为**已确认事实**，`boot.js:568` 是无效读取 | 复现（可选）：`curl -s -u "$SYNC_USER:$SYNC_PASS" "$BASE/ui/api/overview" | jq 'keys'` |
| 4 | D-09：`/ui/login.html` 分支是否被测试断言 | **已复核：未断言**（`test/next-target.test.ts` 只断言 `/ui/app/login.html`，L22/L64）→ 已从"待确认"转为**已确认** | 复现：`grep -n 'login.html' test/next-target.test.ts` |
| 5 | C-02：`filters.js` 的"旧链接兼容"分支能否删 | 它与 `rangeBounds` 耦合（只对 `range==='custom'` 用 after/before） | 手工构造 **无 `range` 参数**的 URL：`$BASE/ui_old/?after=2026-09-01T00:00:00.000Z&before=2026-09-10T00:00:00.000Z`，观察列表是否真的按该区间过滤；再决定"保留为手写 API 入口"还是"连同 `rangeBounds` 一起简化" |
| 6 | R-01：`entityToDto`（数字枚举）是否还有消费者 | **已复核：有 5 处**（`src/routes/history.ts:247/302/340`、`src/ui/query.ts:232`、`src/profile.ts:423/460`）→ **不能删**；可收敛的是"同一字段集写三遍"这件事 | 复现：`grep -rn 'entityToDto(' src/` |
| 7 | C-08：删除 `schema.sql` 的重复行清洗 `DELETE` 是否安全 | 对全新库无意义；但若**线上库曾有重复行**，删掉会让 `CREATE UNIQUE INDEX` 失败 | 对线上 D1 执行：`SELECT COUNT(*) FROM (SELECT UserId, Type, Hash FROM HistoryRecords GROUP BY UserId, Type, Hash HAVING COUNT(*) > 1);` —— 结果为 0 才可删 |
| 8 | T-06：`stripComments` 归一后三个守卫行为是否不变 | 三处判据不同，归一后某个文件可能从"被去注释"变成"没被去" | 归一后跑 `test/docs.test.ts` + `test/ui-contract.test.ts` + `test/ui-guard.test.ts`，并**人工核对两条元测试**（`docs.test.ts` 的「检查器不自命中」与 `ui-contract.test.ts` 的同名用例），比对"写库套件集合"与基线一致 |
| 9 | M-02：`progress.md` 是否还有其它"旧状态被当现状"的段落 | 仅做了关键词扫描，700–5200 行的散文段未逐行核验 | 检索式：`grep -n -E '冻结|存档|20 套件|37 个文件|待实现|未实现|已废弃' docs/progress.md`，逐条人工判读 |
| 10 | V1 `theme-init.js` 的 `getComputedStyle` 时序问题 | V2 注释断言"此刻样式表还没加载"；V1 的该脚本在 `<head>` 里、位于 `tokens.css` **之后**的**经典阻塞脚本** ⇒ 两种说法静态无法裁决 | 用 `test/manual/probe-ui-old.mjs --dark` 读 `document.querySelector('meta[name=theme-color]').content`，看它是否等于 `tokens.css` 的深色 `--bg` |
| 11 | 旧文档 §3.2 关于「前端 8,500+ 行」等聚合行数 | 未做全量求和 | 跑 `test/docs.test.ts` 的"代码规模统计"用例并读它的日志输出（它内部已对 `src`/`test`/`public` 求和）；或对 `src/**/*.ts`、`public/**`、`test/**` 分别求和 |
| 12 | **T-09：两处疑似"有意偏离"是否已有测试覆盖** | `src/db.ts:149-153`（hash 等值 vs 上游 LIKE 模式）与 `src/ui/query.ts:196-201`（UI 面 LIKE 转义）**未找到对应断言** | 检索式：`grep -rn -E 'LOWER\\(Hash\\)|ESCAPE' test/`；若无命中，则两处偏离无守卫——建议各补一条断言（如"带 `%` 的 hash 请求返回 404"、"搜 `100%` 不命中 `1000`"） |

| 13 | **C-09 删 5 个镜像列之前**：是否接受重建 D1 表 | 上游已核验：这 5 列**从未被写入**、对外 DTO **不暴露**（§13.2 #1）⇒ 删除对客户端 100% 不可见 | 决策项：若不想现在重建线上库，把它并到下一次 schema 变更一起做 |
| 14 | **O-01 去重时是否顺带统一 `parseDeletedFlag` 的 400/500** | `overview`（`src/ui/routes.ts:585`）**没有** try/catch，而 `/ui/api/statistics`（`:532-539`）有 ⇒ 非法 `deleted` 值下前者 **500**、后者 **400** | 复现：`curl -s -o /dev/null -w '%{http_code}\n' -u "$SYNC_USER:$SYNC_PASS" "$BASE/ui/api/overview?deleted=maybe"`（期望 400，当前应为 500） |
| 15 | **§13.2 #11 前提复核**：官方客户端是否真的不解析 `PROPFIND` 的 body | 已读 `OfficialAdapter.cs:46-52`（不传 `PreciseDelete`）+ `WebDavConfig.cs:26`（默认 `false`）+ `WebDavBase.cs:271-282`（`Test()` 只判 2xx） | 若要绝对确定，可在 `wrangler dev` 上用官方 v3.2.0 客户端做一轮 E2E，同时打开 `wrangler tail` 观察 `PROPFIND /file` 的响应体是否被消费（正常应看不到"客户端侧解析失败"类日志） |

---

## 12. 变更影响面与验证清单

**任何改动前**：`npm run check`（typecheck + lint）→ `npm run dev`（带 `--test-scheduled`）→ `npm test`。

**按改动类型的必跑项（含复查补充的 8 类"看起来零风险、其实会红"）**：

| 改动 | 必跑 | 额外注意 |
|---|---|---|
| 删/改任何 `test/*.test.ts`（如 T-07） | `npm test` | **必须同步 7 处套件数**：`README.md:135/208/465`、`docs/design.md:494/547`、`docs/ui.md:631`、`deploy.yml:56`；**外加 `README.md:152-153` 的写库套件名单**（`docs.test.ts:223-239` 是 `toEqual`） |
| 增删 `public/` 下任何文件（哪怕新建一个 20 行的 `messages.js`） | `npm test` | **必须同步 `docs/ui.md:139` 的"87 个资源"** |
| **删除任一前端目录（§10 路线 A/B）** | `npm run check` + `npm test` | **ⓐ 先改 `package.json:12` 的 lint CLI 路径（M-07）**，否则 `eslint` 报 `No files matching the pattern`、退出码 1；ⓑ 清理所有静态 import 该目录的测试文件（§10.2 路线 A/B 的清单）；ⓒ `deploy.yml:462-464` 的 `check_asset` |
| 改 `/ui/api/*` 路由集合 | `test/ui-guard.test.ts` | `EXPECTED_API_ROUTES`（`:53-72`）与 `PUBLIC_PROBES`（`:39-47`）是**双向盘点**，增删任何端点都会红 |
| 改 `wrangler.toml` 的 `run_worker_first` | `test/ui-guard.test.ts` | `:479-490` 的四模式断言 |
| 改 `src/routes/webdav.ts` 的 302 目标 / `public/ui/index.html` 的 meta+canonical | `test/ui-guard.test.ts` | `:456-472` 要求 `rootRedirect === '/ui_old/'` 且与 meta/canonical **三者相等**（**§10 路线 A/B 必撞**） |
| 改 V2 任一 `index.html`/`login.html` 的 modulepreload，或增删 V2 的 JS/import | `test/ui-contract.test.ts` | `:214-219`「预载清单 == import 闭包」（V2 有守卫；**V1 没有**，故改 V1 的预载清单目前不会被拦下） |
| 删 `test/manual/*.mjs`（T-08） | `npm test` | `docs.test.ts:262-265` 的 `tests.lines / business.lines > 0.3` 比值断言会随之变化 |
| 改 V2 `api.js` 的默认超时（O-06） | `test/ui-input.test.ts` | `:175-183` 用假定时器推进 **20_000 ms**；恢复到 30s 会让该用例挂住 |
| 改协议面序列化（R-01） | `test/protocol.test.ts` `test/dto-validation.test.ts` | **先补 golden 测试**（现有断言只按字段比对，不校验 JSON 文本） |
| 改 R2 统计（O-01/O-02） | `test/cleanup.test.ts`（唯一断言 `> 0` 之处） | **不要照原稿跑 `test/ui.test.ts`**（那里没有该断言）；走 D1 聚合需改 `docs/protocol.md:464` |
| 改清理（O-03/O-05/R-05） | `test/cleanup.test.ts` `test/cleanup-budget.test.ts` | 清理**物理删除 R2 对象**，历史上出过 F33 事故（每小时清空一次 history/）；改前先备份非生产实例；R-05 必须保留 `pages` 记账语义 |
| 改前端任一版 | `npm run lint` + `test/ui-contract.test.ts` / `test/ui-guard.test.ts` / `test/ui-logic.test.ts` | 零构建前端**不在** `tsconfig` 的 include 内，`tsc` 抓不到它的问题；lint 只开"可能真是缺陷"的规则 |
| 改 `src/ui/session.ts` 导出面 / `src/serialization.ts` 字段集 | `test/hardening.test.ts` / `test/protocol.test.ts` | 属**安全面 / 协议面**，改动前先看清 §8 T-01 与 §6 R-01 的前置要求 |
| 清理 **V2** 内部死代码（D-05~D-11） | `npm run check && npm test`（含 `ui-contract` / `ui-guard` / `ui-logic`） | **先确认 V2 是否即将重写** —— 若是，跳过（§10.2 第 3 条）。另：D-05 需同变更内改 `docs/ui.md:159`；D-11 删 `.sr-only` 需改 `docs/ui.md:571` |
| 清理 **V1** 死代码（D-13：3 个死 id + 8 个无用 `export`） | `npm run lint && npm test` | 去掉 `export` 前逐条核对 `test/ui-guard.test.ts:21`、`test/ui-logic.test.ts:26/30` 的导入清单（§4 D-13 已列"不可删"名单） |
| 给 V1 补守卫 / 改 V1 挂载点常量（N-01、O-09） | `test/ui-guard.test.ts`（V1 前缀与两页一致性、样式层契约） | `ui-guard.test.ts:343` 的"资源存在性"用例是按 `/ui_old/` 前缀推导相对路径的，改常量时**不要动那个前缀的语义** |
| 给 V1 加 `messages.js`（R-08） | 同上 + `npm test` | **资源数 87→88** → 必须同步 `docs/ui.md:139`（`test/docs.test.ts:101-107` 会断言）；`ui_old/index.html` 的 modulepreload 清单也要加一项 |
| 按 §13.2 动任何"对齐上游"的项（C-03~C-06、O-05） | `test/protocol.test.ts` `test/fix-regressions.test.ts` `test/transports.test.ts` | 这些是**主动放弃忠实性**的决策，不是清理；改动前先确认 `docs/protocol.md` §10 对应行已同步 |

**"看起来零风险、其实会红"的清单（给评审用）**：

| 改动 | 为什么看起来零风险 | 实际会红在哪 |
|---|---|---|
| 删除一个前端目录 | "只是删静态文件" | `npm run lint`（CLI 路径不存在，M-07）+ 多个 `test/*.ts` 的静态 import |
| 新建一个 `public/` 文件 | "不影响功能" | `docs.test.ts:101-107` 的资源数（87→88） |
| 删/加一个 `test/*.test.ts` | "少跑一个套件" | 7 处套件数 + `README.md:152-153` 写库名单 |
| 把某条 `/ui/api/*` 路由改名/挪位 | "路径还是同一个" | `ui-guard` 的 `EXPECTED_API_ROUTES` 盘点 |
| 从 `run_worker_first` 拿掉 `/ui_old` | "目录都删了当然删配置" | `ui-guard:479-490` 的四模式断言 |
| 改 `api.js` 的 `20_000` 常量 | "调个超时" | `ui-input.test.ts:181` |
| 302 目标改 `/ui/` | "默认界面换到 V2 嘛" | 空壳 meta-refresh 指向被删目录 + `ui-guard` 入口链断言（三重） |
| 删 `test/manual/*.mjs` | "它们从不被 vitest 采集" | `docs.test.ts` 的测试/业务行数比值 |
| 统一两个 `stripComments` | "去重复" | `docs.test.ts` 与 `ui-contract.test.ts` 的"检查器自命中"两条承重断言 |

---

## 13. 上游对照：兼容性结论（基线 28c7e596）

> **本节回答两个问题**：① 本文各条"对齐上游"的说法**是否真的对**（不再只依赖项目自己的注释与文档）；② **动这一项会不会影响兼容**。
> 说明：**偏离的"登记"是 `docs/protocol.md` §10 的职责**（该表质量很高，已把每条差异带到上游 `file:line`）；本节**不重复登记**，只给判定。

### 13.1 核对前提（已核实）

| 事项 | 证据 | 结论 |
|---|---|---|
| 上游修订版 | 读 `SyncClipboard/.git/refs/heads/master` = `28c7e5963b8329e40586175eeeda326597c3e732` | **与本文与项目文档所述基线 `28c7e596` 逐字一致** ⇒ 下列证据与项目的目标修订版同源，不是"另一个版本的结论" |
| `/api/version` 的真实取值 | `src/Directory.Build.props:4` `<VersionPrefix>3.2.0</VersionPrefix>`（`VersionSuffix` 空）→ `Shared/SyncClipboardProperty.cs:9-24` 取 `AssemblyInformationalVersion` 并截掉 `+` 之后 | 基线返回 **`3.2.0`**；CF 的 `wrangler.toml` `VERSION = "3.2.0"` 是逐字对齐 ✓ |
| 客户端下限检查会否因版本串失败而报错 | `RemoteServer/Adapter/OfficialServer/OfficialAdapter.cs:154` 的 `if (AppVersion.TryParse(...) && AppVersion.TryParse(...))` **无 `else`** | 解析失败即**静默跳过**——CF 的注释与 README 说法 ✓ |
| 官方客户端默认单文件上限 | `Models/UserConfigs/SyncConfig.cs:23` `MaxFileByte = 1024*1024*20` | 20 MB ✓ |

### 13.2 逐条判定（本文所有涉及兼容的条目）

| # | 审计条目 | 上游证据（`file:line`） | 官方客户端是否消费 | 动它之后的兼容影响 | 判定 |
|---|---|---|---|---|---|
| 1 | **C-09** 删 5 个镜像列（`TransferDataSha256`/`TransferDataMd5`/`From`/`Tags`/`ExtraData`） | `Models/HistoryRecordEntity.cs:18-19,44-46` 仅**声明**；全仓无非声明写点（唯一相关写操作是 `Models/Mapper.cs:22` `ExtraData = null`）；对外 `Models/HistoryRecordDto.cs:5-19` **不含**这些字段 | **否**（DTO 层不可见） | 对任何客户端**完全不可见** | ✅ **可删**（需重建 D1 表）。⚠️ `FilePaths` **不在此列**：`HistoryRecordDto.cs:34` 用它推导 `HasData`，与 CF `serialization.ts:273/291` 逐字同义 |
| 2 | **C-03** `src/pathCase.ts`（字面段大小写归一） | `Controllers/HistoryController.cs:14` `[Route("api/history")]` + `Web.cs:72` `MapControllers()` ⇒ ASP.NET Core 路由对**字面段**不区分大小写；`protocol.md:517` 有 A/B 实测 | 客户端恒用规范大小写（`OfficialAdapter.cs` 的 URL 全部取自字面量：`api/history/...`、`SyncClipboard.json`） | 删掉后**官方客户端不受影响**；但丢失"与上游一致"，且 `test/protocol.test.ts` 的 20+ 用例 + "归一表覆盖全部字面段"守约会红 | ⛔ **保留**（属"忠实性"投入，不是冗余）。若放弃须同步删 `protocol.md` 差异表行 |
| 3 | **C-04** SSE / 长轮询 / `AVAILABLE_TRANSPORTS` | `Web.cs:38` 只有 `services.AddSignalR()`（无 transport 配置）⇒ 三传输是 ASP.NET Core **默认**；`Hubs/SyncClipboardHub.cs:13-16` 纯监听 hub | **是**（SignalR 客户端按 `availableTransports` 顺序选，WS 不可用时才降级） | 删 SSE/LP 后，WS 被代理剥离的环境里**失去降级路径**；`test/transports.test.ts`（约 7 条）、`fix-regressions` 的 F32（断言 3 种）、`rate-limit.test.ts` 的长轮询封顶节会红 | ⛔ **保留**（`design.md` ADR D6 已定） |
| 4 | **C-05** 协议面搜索**不**转义 LIKE 元字符 | `Services/History/HistoryService.cs:153` `EF.Functions.Like(r.Text, $"%{searchText}%")`（无转义） | **是**（`POST /api/history/query` 带 `SearchText`） | 改成转义 = 与上游不一致（"上游能搜到、这里搜不到"） | ✅ **保持不转义**（UI 面转义是本站自有面，保留） |
| 5 | **C-06** hash 用等值匹配（上游是 LIKE **模式**） | `HistoryService.cs:252-256` `Query()` 用 `EF.Functions.Like(r.Hash, hash)`；`Shared/Profiles/Profile.cs:89-108` 的 `ParseProfileId` 用 `Enum.TryParse`（**大小写敏感**） | **是**（`GET /api/history/{profileId}`、`PATCH`、`/data`） | CF 更严格：第三方客户端发含 `%`/`_` 的 hash 时，上游会误命中同前缀记录、CF 返回 404 | ✅ **保持**（已登记于 `protocol.md:496` 与 `upstream-defects.md` D1） |
| 6 | **C-07** 弱凭据开关（含不使用上游的 `admin/admin` 默认值） | `Models/AppSettings.cs:5-6` 默认 `UserName/Password = "admin"`；`CredentialChecker/StaticCredentialChecker.cs` | —（不涉及协议形状） | CF 未配凭据时 fail-closed（500）；上游用默认口令可直接用 | ✅ **保留**（方向是更安全；已登记） |
| 7 | **O-02** `totalFileSizeMB` 改 D1 聚合 | `HistoryService.cs:638-683` `GetStatisticsAsync` 用 **`DirectoryInfo(_persistentDir).EnumerateFiles("*", AllDirectories).Sum(f => f.Length)`**（遍历磁盘文件求和），再 `Math.Round(bytes/1024/1024, 2)`，`bytes>0 && mb==0 ⇒ 0.01` | **否** —— 对 `OfficialAdapter.cs` 全文件 Grep，**没有任何 `statistics` 调用**；该端点只有 CF 的 Web 界面在用 | ① 对外值语义改变：D1 `SUM(Size)` **会多算内联文本**（`src/profile.ts:139/310` 给 Text 记录写"文本字节数"，而它没有 R2 对象）、**会少算孤儿对象**；② 仍是**协议面已登记口径**（`protocol.md:464`：`totalFileSizeMB = 按 R2 对象 size 求和`） | ⚠️ **只做 O-01 去重、不改口径**（推荐）。若改口径，必须同步 `protocol.md:464` 并补双口径对照用例。💡**副产品**：既然官方客户端不调该端点，O-02 的性能问题**实际只影响 CF 自己的 Web 界面** ⇒ "方案 1（去重）"的性价比比第一轮估计更高 |
| 8 | **O-05** 清理软删逐条广播 | `Shared/Utilities/HistoryManagerHelper.cs:44-52` 与 `:84-92`：每批内 `foreach → MarkForDeletionAsync` → `SaveChangesAsync` → `foreach → OnRecordDeletedAsync`；`HistoryService.cs:614-618` 的 `OnRecordDeletedAsync = NotifyProfileChangeAsync + DeleteProfileDataIfNeed` ⇒ **逐条广播**；而硬删走 `RemoveOutOfDateDeletedRecords`（`HistoryService.cs:516-536`）用 `RemoveRange`，**不经** `OnRecordDeletedAsync` ⇒ **硬删不广播** | 是（广播即推送语义） | CF 现状（软删 notify / 硬删不 notify）**与上游一致**；改成"不广播/聚合广播"是**主动偏离** | ⛔ **需决策**（不是清理项） |
| 9 | **R-06 / M-03** `FilePaths` 是否死列 | `HistoryRecordDto.cs:34` 用它推导 `HasData`；`Mapper.cs:23` 写入；`HistoryService.cs:199` 更新 | 间接（决定 `hasData`） | 删它会打断 `hasData` 推导 | ⛔ **不是死列，不可删**（除非同步把 `hasData` 退化为 `transferDataFile !== ''`） |
| 10 | **O-04** PUT 路径全量内存缓冲 | `SyncClipboardController.cs:207` `SetAndMoveTransferData` → `File.Move`（**不读数据**） | 是（上传大文件） | 差异已登记（`protocol.md:473`）；不改 | ⛔ **明确不做** |
| 11 | **PROPFIND 返回 207 multistatus** | `SyncClipboardController.cs:59-75` 的 `PropfindRoot()`/`FileFolderEnsure()` 均 `return Ok()`（200 空体） | **是，但只判状态码**：`WebDavBase.cs:271-282 Test()` 与 `:243-251 DirectoryExist()` 只 `EnsureSuccessStatusCode()`/查 404；**只有** `GetFolderSubList`（`WebDavBase.cs:321+`）解析 body，而它仅在 `PreciseDelete=true` 时被调用（`WebDavAdapter.cs:149-151`），且 `OfficialAdapter.cs:46-52` **不传** `PreciseDelete` ⇒ 默认 `false`（`WebDavConfig.cs:26`） | 对官方客户端是**无害超集**（2xx 即可）；对 WebDAV 模式的 opt-in 路径是**必需**——上游返回空体会让客户端的 `XmlDocument.LoadXml` 抛异常 | ✅ **保留**（CF 的实现比上游更完整） |
| 12 | **CF 的若干"对齐上游"实现是否真实** | 已逐条对上：`ImageTool.cs:5` 的 `ImageExtensions = [".jpg",".jpeg",".gif",".bmp",".png"]` ↔ CF `IMAGE_EXTENSIONS`；`Profile.cs:237-239` 的 File→Image 提升 ↔ CF `resolveCreateProfileType`；`Profile.cs:162-170` 的 `GetWorkingDirName` 拒分隔符抛 `ArgumentException` ↔ CF `isValidProfileHash`；`HistoryManagerHelper.cs:19/66` 的 `BatchSize = 500` ↔ CF `SOFT_DELETE_BATCH_LIMIT`；`HistoryCleaner.cs:42/64/86` 的 10min/12h/12h ↔ CF 注释；`AppSettings.cs:7-8` 的 1000/10080 ↔ `wrangler.toml`；`Env.cs:15` 的 `RequestServerVersion = "3.1.1"` ↔ CF README | — | — | ✅ **CF 的"对齐上游"是真实投入，不是自我陈述** ⇒ 这些不可当冗余删除 |

### 13.3 三条必须带进 V2 重写的缺陷（**不再回移到当前 V2**）

> 第一轮写的是"把 V1 的修复回移到 V2"。既然 **V2 允许破坏性重构**，回移到"即将被重写的代码"上收益很低；改为**写进重写的验收清单**，并**明确 V1 侧已正确、不要动**。

| # | 缺陷 | V1（产品面，已修**正确**） | V2 当前（回退） | **重写验收断言（建议）** |
|---|---|---|---|---|
| 1 | 未来时间戳的显示 | `ui_old/js/format.js:56-63` 区分"刚刚/N 分钟后/小时后/天后" | `ui/js/format.js:60` `if (diff < 0) return formatClock(new Date(ms))` | `formatRelative(now+60s)` 不得匹配 `/^\d{2}:\d{2}$/`，应为「1 分钟后」；补 `now+10s→刚刚`、`now+3h→3 小时后`、`now+40d→日期`。⚠️ 现有 `test/ui-logic.test.ts:172` **断言的正是被修掉的行为**，重写时必须一并改掉 |
| 2 | 跨夏令时的日期运算 | `ui_old/js/filters.js:47-58` 的 `addDays()`（`date.setDate()` 日历运算） | `ui/js/filters.js:66/81/83/113` 用 `±DAY_MS` 常数 | 在 `TZ=America/New_York` 下断言"近 7 天"跨 2026-11-01（DST 结束）时仍是本地 7 个日历日。⚠️ 现有用例在任何常见时区都**不跨 DST**，测不出该差异——必须固定 `TZ`，否则白写 |
| 3 | 推送的冷却重连 | `ui_old/js/signalr.js:26-30,86-98,187-194`（`RETRY_COOLDOWN_MS=10min` 冷却后仍重试） | `ui/js/push.js:79` 连续失败 5 次即 `return`（不再重建）；`start()`（L160-169）不重置 `retryDelay`、不清冷却计时器 | 用假定时器制造 5 次断开后，断言**仍会重试**（存在 10 分钟冷却定时器 / 推进 10 分钟后新建连接）。⚠️ 现有两条 push 用例都到不了 `failures>=5` 分支，**完全覆盖不到** |

### 13.4 结论（兼容性维度）

1. **本文 §4/§6/§7/§8 的可执行项里，没有一条会破坏官方客户端兼容。**
   - 死代码类（D-01~D-04、D-12、D-13）：全部是"无引用 / 无生产者 / 无消费者"，客户端不可见。
   - V2 内部死代码（D-05~D-11）：同上，且 V2 非默认界面。
   - 抽共享实现（R-01~R-08）：纯重构；**唯一需要前置工作的是 R-01**（协议序列化，必须先加 golden 测试）。
2. **真正会改变"与上游一致性"的只有四项**：C-03（pathCase）、C-04（SSE/长轮询）、C-05/C-06（匹配语义）、O-05（广播策略）。它们**全部是"有意对齐 / 有意偏离且已登记"**，属主动决策，**不是冗余清理**——这也是本项目最有价值的资产之一，不要误当包袱清掉。
3. **一项需要看清性质**：O-02 改 D1 统计口径 = 改变协议面**已登记值**；但**官方客户端根本不调用该端点**，所以它其实是"自我一致性"问题，不是客户端兼容问题。
4. **一项可以放心删**：C-09 的 5 个镜像列——上游同样**从不写入**、DTO 层**不暴露**，删除对客户端 100% 不可见。
5. **反向收获**：上游对照也验证了 CF 的一批"看似多余"的实现是**忠实移植**（三传输、批量 500、File→Image 提升、镜像列、文件名/工作目录规则、清理周期与软/硬删广播差异）。这些**都不该进清理清单**。

---

## 14. 处置记录（第三轮：本轮实际实施的改动）

> 本节是**执行记录**，不是审计发现。第三轮把本文与 `docs/AUDIT-commit-9b4cdca.md` 合并后落地。
> 只列"已改"与"明确不改"，未列出的条目即"尚未处理"。
> 验证：`npm run check`（tsc + eslint）0 错误；`npm run dev` 起本地 dev server 后 `npm test` → **22 个套件全通过**（当轮 401 用例；用例数刻意不固化，现状见命令输出）。

### 14.1 已实施（`src/`）

| 条目 | 改动 |
|---|---|
| **D-01** | 删 `src/auth.ts` 的 `basicAuthMiddleware` 与随之无用的 `hono` 类型导入 |
| **D-02** | 删 `src/db.ts:575` 的转出导出；`import` 收窄为 `{ fromIso }` |
| **D-03** | 删 `RENDERABLE_TYPES` 里不可达的 `'text/xml'`，并注明它为何不可能被命中 |
| **D-04** | 删 `MultipartPart.filename`（字段 / 赋值 / `parseContentDisposition` 的 filename 提取）；`parseContentDisposition` 改为直接返回 name 字符串 |
| **D-12** | `tsconfig.json` 的 `include` 去掉不存在的 `scripts` |
| **R-03** | `query.ts` 导出 `truncateText`；`maintenance.ts` 改 import，删本地 `snippet` |
| **R-04** | 新建 `src/stores.ts`，`routes/history.ts`、`routes/webdav.ts`、`ui/routes.ts`、`ui/maintenance.ts` 四处重复的 `{db, storage}` 工厂收敛为一份 |
| **R-07** | `storage.ts` 的 `assertHashForPath` 改用 `isValidProfileHash`（分层保留，判据单点） |
| **O-01** | `ui/routes.ts` 把 `deploymentInfo` 拆成 `deploymentStats()` + `deploymentMeta()`；`overview` 的统计层**只算一次**（单次请求的 R2 全桶列举从 2×N 降到 N） |
| **O-08a** | `index.ts` 抽 `normalizePath()`，两个中间件共用 |
| **T-01** | `ui/session.ts` 导出**无守卫**的纯原语 `deriveSessionKey()` / `signSessionToken()`；`test/hardening.test.ts` 删掉自己复制的那份派生管线 |
| **§11 #14** | 新增 `readDeletedFlagOr400()`，列表/统计/概览三个端点共用同一套 400 映射（此前 `overview?deleted=maybe` 会 500） |

### 14.2 已实施（V1 = 产品面）

| 条目 | 改动 |
|---|---|
| **R-08** | 新建 `public/ui_old/js/messages.js`（6 个用户文案函数，V1 自包含）；`main.js` 改 import 并**修掉两处"两版共用"的错误注释**；补 `index.html` 的 modulepreload；`docs/ui.md` 的资源数 87 → 88 |
| **N-01①** | 补 **V1 的「modulepreload == import 闭包」守卫**（此前只有 V2 有） |
| **N-01②** | `api.js` 新增 `export const PAGE_BASE = '/ui_old'`，`login.js` 默认落点、`api.js:redirectToLogin`、`main.js:logout` 三处改用常量；补 **「挂载点字面量只有一处 + 一处有理由的例外」守卫** |
| **N-01③** | 自包含守卫**重写**：原先只查 `main.js` + `index.html`，且 `from '../ui/` 是空断言。现在解析全部 V1 JS 的 import 是否逃出目录，并检查两张页面的 `<script src>` / `<link href>` 是否指向 `/ui/`（**不查 `<a href>`** —— 提示条指向 `/api/app/` 的导航链接是有意的） |
| **D-13（部分）** | 删三个死 id：`index.html` 的 `id="skeleton"`、`components/preview.js` 的 `id="preview-meta"`、`components/toolbar.js` 的 `id="search"` |
| **O-09** | ① `filters.js` 新增 `nearestPageSize()`：`?pageSize=37` 吸附到最近档位（此前会落到下拉空选）；② `next-target.js` 补登录页自身回落（`/ui_old/login.html` → `null`，由调用方取默认落点） |

### 14.3 已实施（V2 = 开发版，只做零成本项）

| 条目 | 改动 |
|---|---|
| **D-05** | 删 `api.batchMeta()`（V2 内零调用；注释还自称"不导出"而它必然导出） |
| **D-06** | 删 `state.js` 的 `store.update()`，并把文件头为它辩护的注释改成"为什么刻意不提供" |
| **D-07** | 删 `ui/board.js` 的 `focusFirst()` 与 `ui/overview.js` 的 `setLastSync()` |
| **D-08** | `api.js` 的 `ApiError` 带上 `retryAfterSeconds`（从 `Retry-After` 解析）—— 429 的两条精细文案**首次变成可达** |
| **D-09** | 删 `next-target.js` 对不存在的 `/ui/login.html` 的判断 |
| **O-06** | `request()` 增加 `timeoutMs` 参数（默认仍 20s），只给 `integrity` 放宽到 60s —— 不动默认值，因此不影响 `ui-input.test.ts` 的 20s 超时用例 |
| **O-07** | 删 `boot.js` 对 `data.activity` 的无效读取（overview 从不返回该键） |
| **O-08f/j** | `ui/omnibox.js` 合并同模块的两条 import；`login.js` 删第二次冗余的 `clearError()` |
| **O-08g** | 见 §7 的**推翻**记录：不改代码，只把两条 CSS 规则的注释改准 |

### 14.4 新增测试（防止修完就漂回去）

- `test/ui-guard.test.ts`：+3 条（V1 预载闭包 / V1 自包含重写 / 挂载点字面量）、+1 条 `messages.js` 对等守卫。
- `test/ui-logic.test.ts`：+1 条 429 精细文案（含"缺字段 → 通用文案"）。
- `test/ui-input.test.ts`：+2 条 `Retry-After` → `retryAfterSeconds` 的**接线**断言（只测消息侧会让两边各自"正确"却永远接不上）。

### 14.5 明确不改（连同理由，避免下一轮重复提议）

| 条目 | 为什么不改 |
|---|---|
| **D-13 的"去掉 9 个无外部消费者的 `export`"** | **收益为负**。这 9 个符号（`normalizeItem`/`buildQuery`/`parseFrames`/`classifyMessage`/`isImageName`/`canWriteText`/`canWriteImage`/`startOfDay`/`ICONS`）**在 V2 里都有同名导出，且都被测试按名字覆盖**（`ui-logic` / `clipboard`）。保持两版导出面**逐字相同**，意味着"任何 V2 单测都能原样改指 V1"—— 那是给产品面补测试覆盖最便宜的路（§10.2 路线 A 也依赖它）。为"收敛公开面"删掉它，等于把这条退路封死。死 id 部分照做（见 14.2）。 |
| **O-08e**（`overview.js` 的 `formatSizeShort` 复用 `formatSize`） | 两者默认值语义不同（概览 0 显示 `0 B`、列表 0 显示 `—`），合并会改显示。属"改行为换去重"，不是纯重构。 |
| **O-08h/i**（`board.js:522`/`ghost.js:13` 的换行、`drawer.js` 的悬空 JSDoc 与缩进） | 纯排版，eslint 不管。改动会污染 diff、且 V2 允许破坏性重构（重写自然消掉）。 |
| **O-01 的 O-02 部分**（统计改 D1 聚合） | 会构成**未登记的协议偏离**（§7 O-02、§13.2 #7）。本轮只做去重、不改口径。 |
| **§10.2 路线 A/B**（两版收敛） | 定位已定（V1 产品面 / V2 开发版），当前不做。 |
| **R-01 / R-02 / R-05 / R-06 / T-02~T-06 / T-07 / O-03 / O-05 / C-01~C-09** | 未处理。R-01（协议序列化）与 R-05（R2 分页循环）**必须先补前置测试**（见各自条目的"改动风险"）；C-03~C-08 是产品决策而非清理。 |

### 14.6 本轮对本文档自身的勘误

| # | 原判定 | 实际情况 |
|---|---|---|
| 1 | §7 **O-08g**：`#board-area` 与 `.board-area` 是"同一元素" | **不是**同一元素，是父子（`boot.js:282` `append`）。两条 `min-height` 各管一个时刻，**不合并**（§7 该行已标注推翻） |
| 2 | §4 **D-05** 说"必须同一变更内同步 `docs/ui.md:159`" | `docs/ui.md` 的那张表描述的是 **V1**，而 V1 的 `api.js` **确实**有 `batchMeta()`（被 `main.js` 调用）。该行无需改动 —— 原判定把 §3.2 的表误当成 V2 的了。（本轮删的是 **V2** 的 `batchMeta`。） |
| 3 | §4 **D-13** 论证"公开面越窄越好" | 见 14.5 第 1 行：与"两版导出面一致"冲突，本轮只做死 id 部分 |

---

## 15. 处置记录（第四轮：2026-09-18 晚，按"逐行通读"结论落地）

> 与 §14 的关系：§14 是第三轮（依据本文 + `AUDIT-commit-9b4cdca.md`）；本节是**第四轮** —— 由一次
> 独立的全仓逐行通读（V1/V2 全部前端文件 + 全部文档）驱动，约束仍是"只修逐行核实过、且不与既有决定
> 冲突的项"。过程叙事见 `docs/progress.md` §84。

### 15.1 已实施（代码）

| 条目 | 改动 |
|---|---|
| **O-08k** | 新建 `public/ui/js/paths.js`（纯函数 `dataPath(item, {download})`）：`api.js` 的 `dataUrl` 改为转发、`ui/row.js:228` 改用它 —— 分层纪律保住（`ui/*` 仍不 import `api.js`）。连带：`app/index.html` 与 `app/login.html` 各补一条预载、资源数 **88 → 89**、三处目录树同步（`docs/ui.md` §3 / `docs/design.md` §4 / `docs/ui-v2-design.md` §7） |
| 新发现（V2） | ① `shell-v2.css`：基础规则 `.main > .overview .overview__spark{display:none}`（特异性 0,3,0）**恒压过**末尾窄屏那档的裸类 `display:block`（0,1,0）⇒ 趋势图有数据、有 DOM、**可见高度恒为 0**（"桌面/中屏让位、窄屏独占一行"的原设计因此只剩前一半）；② `ui/drawer.js`：保留天数用裸 `parseInt` ⇒ `1.5`→1 天、`e`→`NaN`→JSON `null`（= 静默"清除覆盖"，与用户意图**相反**）→ 改 `^\d+$` + 上下界 + `aria-invalid`/`aria-describedby`；③ `ui/dialog.js`：确认框初始焦点找 `.btn--primary`，而确认键是 `.btn--danger`、正文只有 `<p>` ⇒ **谁都没聚焦** → `[data-autofocus]` 链；④ `ui/board.js`：内容变化的行**就地重填**（重建操作列）却不保焦点 ⇒ 焦点掉到 `<body>` → `captureFocus/restoreFocus`；⑤ `ui/ghost.js`：CLS 注释 0.91 → 0.90（与 `board.js`/`boot.js`/本文同值） |
| 新发现（V1 = 产品面） | ① `main.js:refreshOverview()` **没有 latest-gate**，且 `view` 在**落地那一刻**读 `filters.deleted` ⇒ 一份"活跃视图"的迟到快照会被盖上"回收站视图"的归属，`countsForView` 随之把活跃计数当回收站计数画出来（`refreshStats` 有这道守卫，这条路径没有）→ 新增 `overviewGate` + 请求时定格 + `aborted` 早退；② `copyImage` / `downloadItem` 此前**裸用 `fetch`** ⇒ 既无 30s 超时（半开连接时按钮永久转圈）也无 401 跳登录 → 新增 `api.fetchData()`（与 `request()` 共用同一套"调用方取消 + 超时"合成，计时器留到读完 body），`ApiError` 补 `payload` 字段；③ 5 处"注释与实现相反"订正 |

### 15.2 已实施（探针与测试）

- `test/manual/probe.mjs` 新增 **`sparkBox`（渲染盒）**：原 `sparkBars` 只数 DOM 条数，而 `display:none` 时它**照样是 14** —— 这正是 15.1 那条 CSS 缺陷长期没被发现的原因（**测量本身是错的，缺陷就不可见**）。另修 `firstRowOps` 的假阴性：`tr:first-of-type` 命中的是分组小标题 `.daymark`，该项**恒为空数组**。
- `test/ui-input.test.ts` **+3**：V1 `api.fetchData` 的超时 / `payload` 透传 / Blob + URL 逐段编码。

### 15.3 已实施（文档）

| 条目 | 改动 |
|---|---|
| **M-05** | `README.md:418` 与 `security-fix-plan.md` 的 `.audits/` 口径统一：明确"**不在版本库内**（`.gitignore:14`）"，并在该文 §五 补边界说明 —— 那批探针只存在于审计时的**本机工作区**，干净检出上会 `MODULE_NOT_FOUND`；§五 的长期价值是"判别实验的设计"，不是可执行脚本清单（当前可跑的替代证据是 `test/fix-regressions.test.ts` 与 `test/rate-limit.test.ts`） |
| 新增 `AGENTS.md` | 根目录**行为契约**（改代码顺手维护文档 / 完成定义 DoD / V1-V2 约定 / 协议红线 / 提交与推送规矩），并在 `README.md` §项目结构 与 §文档 登记、`docs/design.md` §4 目录树登记 |
| **M-01 的同族加固** | 把 `AGENTS.md` 纳入 `test/docs.test.ts` 的 `CURRENT_STATE_FILES` —— 它写下的**套件数**从此被守卫盯住（契约自己遵守契约，不靠自觉）；`test/docs.test.ts` 的"文档"规模口径同步含它 |
| 通读发现的 12 份文档失准 | 逐条订正，见下文"文档校准清单" |

**文档校准清单（第四轮）**：`ui.md`（§3.2 标题挂错版本；§5 端点表 15 → **18** 条，与 `ui-guard` 的 `EXPECTED_API_ROUTES` 对齐；`_headers` 移出 V1 表）；`ui-v2-design.md`（8 处套件数 + 三处令牌名/函数名 + `clients()` 已删）；`frontend-checklist.md`（messages 口径改为"V1 本地副本 + 对等守卫"；"未来时间戳未处理"改为"V1 已修 / V2 仍旧行为"；去掉已删的 460ms 档）；`protocol.md`（§11 表里混进的三行 4 列差异**上移回 §10**，§11 恢复纯 3 列参考表）；`upstream-parity.md`（头部"未运行上游服务端"—— 该结论此后被推翻两次）；`upstream-issues.md` / `upstream-defects.md`（条数口径统一为 21 条候选的四类分布，并注明"初版写作 16 已复刻 + 5 未复刻"）；`ui-v2-audit.md`（章节重号 → 序号单调）；`progress.md`（目录按 83 个标题重生成；修一处标题粘连在表格行尾的格式缺陷）；`security-fix-plan.md` / 本文（套件数）。

### 15.4 明确不做（第四轮新增，避免下轮重复提议）

| 条目 | 为什么不改 |
|---|---|
| V2 三处回退：**未来时间戳** / 跨 DST 日历运算 / 推送冷却重连 | 沿用 §13.3 与 N-05 的决定（"不回移，写进 V2 重写验收清单"）。注：未来时间戳在本机**可复现**（探针 `firstRowMeta` 读到 `DC168F2D…·17 B·09:03`），改它必须同时改 `test/ui-logic.test.ts:172` —— 那条断言钉的正是被修掉的行为 |
| V2 死代码（`appbar` 的 `offline` 态不可达、`.tag[data-tone=star\|pin]`、`.bar__fill[data-kind]`） | 按 §10.2 第 3 条：V2 允许破坏性重构，重写会自然消掉 |
| `row.js:228` 的 data URL 重复 | **已做**（见 15.1 的 O-08k），从待办中划掉 |

### 15.5 验证

`tsc --noEmit` 0 错 · `eslint public/ui/js public/ui_old/js` 0 告警 · **22 套件全绿**（当轮 405 用例；用例数刻意不固化）
· 真实浏览器实测：1440 ⇒ `sparkBox 0×0`（桌面让位，符合设计）；390 ⇒ `sparkBox 424×26`、`firstRowOps ["copy","star","dots"]`、`pageOverflow 0`、零 console 错误 · `ui-contract` 的「预载 == import 闭包」在新增 `paths.js` 后仍通过。

---

## 附：本次审计的产出

| 文件 | 动作 |
|---|---|
| `docs/AUDIT-redundancies.md` | 改写（本文件）。这是本次审计**唯一**的版本库改动 |

**只读引用（未改动）**：上游 C# 仓库 `C:\Users\leeexx\Documents\NewProject\SyncClipboard`（基线 `28c7e596`），仅用于 §13 的对照。

审计过程中的临时统计文件（`.audit-tmp-lines.txt`）已在得出结论后删除，未留在工作区。

**统计口径（第二轮修订后）**：死代码 **13 条**（D-01~D-13，其中 D-13 为 V1 产品面）、兼容层 **9 条**（C-01~C-09）、冗余 **8 条**（R-01~R-08）、可优化 **9 条**（O-01~O-09，O-08 含 a~l）、测试 **10 条**（T-01~T-10，T-10 含 a~h）、文档/构建/CI **7 条**（M-01~M-07）、前端附带发现与策略 **5 条**（N-01~N-05）。

**收敛后的行动建议（按已定定位）**：

- **产品面（`public/ui_old` + `src/`）——建议做**：D-13、D-01~D-04、D-12（零风险删除）；**O-01 去重**（首屏性能，收益最高）；N-01 / O-09 / R-08（V1 的守卫与缺口）；T-01（安全测试失真）。
- **开发版（V2）——只做"零成本"项**：D-05、D-06（两处"注释与事实相反"）；其余 D-07~D-11 等重写时自然消失（§10.2 第 3 条）。
- **必须写进 V2 重写验收清单**：§13.3 的三条缺陷 + N-05 的清单。
- **不要动**：§13.2 判为「保留 / 需决策」的全部项（C-03、C-04、C-05、C-06、C-07、O-04、O-05）——它们是与上游一致性或安全性的投入，**不是冗余**；其中 C-09 是唯一"可放心删"的（上游同样从不写入、DTO 不暴露）。


