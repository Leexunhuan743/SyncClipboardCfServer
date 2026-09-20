# `test/` 变更审计：`6ebcf6e` → `da1ee44`

> **审计对象**：`test/` 从基线 `6ebcf6e` 到当时 HEAD `da1ee44` 的**全部**变更。
> **产出**：本文档。逐文件、逐 hunk 列出，并逐条给出核实结论。
> **口径声明**：本轮**按用户要求未运行任何测试、未写任何分析脚本**（未起 dev server、未跑 vitest、
> 未跑 tsc/eslint、未跑 `test/manual/*.mjs`）。因此本文档里所有"核实"都指**静态核实**
> （逐字比对源码 / 注释 / 外部事实），**不构成"门禁已过"**——按 `AGENTS.md` §1 的惯例，
> 未验证的部分在提交信息里也必须写明"未验证"。
>
> 这是 `docs/AUDIT-src-diff-6ebcf6e.md`（§96，`src/` 91 处）与 `docs/AUDIT-public-diff-6ebcf6e.md`
> （§97，`public/` 208 处）的**第三份**，同一句用户指令、同一套口径，对象换成 `test/`。

---

## 0. 为什么会有这份审计

基线之后这一串提交（22 笔）里，`test/` 的改动量是 **14 个文件、79 个 hunk、+1242 / −227**。
与 `public/`（主体是一次目录改名）和 `src/`（主体是行为修复）都不同，`test/` 这一轮的构成是三类：

1. **改名跟随**（`public/ui/` → `public/ui_v2/`、`ui_old/` → `ui_v1/`）：绝大多数是 import 路径与
   注释里的地名，**判据是"有没有漏一处"**——漏一处就是 `tsc`/`vitest` 直接红，属于"不会静默通过"的那类；
2. **补缺口**：把此前"只有注释承诺、没有断言钉住"的东西变成真断言（骨架行高、预览关闭释放正文、
   `?next=` 的自指多跳、模块图规模从"弱下界"改成精确值）；
3. **订正失实叙述**：`ui-guard` 里那几段讲历史事故的注释本身被改名替换打偏过（改成了从未发生过的事），
   本轮把"历史名"写回并注明"不要随改名替换"。

判据与 `AGENTS.md` §1 同一条：**注释是本仓库被测试与文档引用的事实**。
`test/` 里的注释比别处更"承重"——它们常常在解释"这条断言为什么存在、修之前错在哪"，
所以本轮把"注释是否与代码一致、是否与事实一致"与断言逻辑一并核。

## 1. 核实方法（可复算，且不依赖脚本）

| 步骤 | 做什么 | 判据 |
|---|---|---|
| 1 | 把 `6ebcf6e..HEAD -- test/` 的 diff 导出成 `.audits/test.diff` | **一条 `git diff` 命令的重定向**，不是分析脚本；该文件在 gitignored 的 `.audits/` 下 |
| 2 | 数 `diff --git` 行 = 文件数、数 `@@` 行 = hunk 数、读到末行 = diff 总行数 | 14 / 79 / 2291 —— 与 `--shortstat` 的 14 files 一致 |
| 3 | 从第 1 行读到末行（整份读完），逐个 hunk 判"这处改动合不合理" | 见 §3（79 条逐行台账） |
| 4 | 把 hunk 里的**每一处事实性断言**拿回**当前**仓库核：标识符、路径、常量值、字符串、算术、外部文件 | 见 §7（分四类，每条给可复算判据） |
| 5 | 对确认失实的注释出补丁，改完读回 | 见 §4（T-1…T-4） |
| 6 | 单独读**工作区未提交**的 `test/**`（它不在 diff 范围内，但是"最新"的一部分） | 见 §8 |

**为什么"逐字一致"这一步在本文件里几乎是免费的**：`test/**` 的 diff 里绝大多数新行是
**被 import 路径改名**和**新增的断言**，它们要么在 `tsc`/`vitest` 的射程内（改名漏改 = 立刻红），
要么就是"新写的、必然在树上"。真正需要人读的是**注释里的因果与出处**（T-1…T-4 全部出自那里）。

## 2. 按文件总览（14 项）

```
M=修改  R*=改名（带正文改动）
hunk 列为 0 的行 = 只有路径变、正文逐字未动（本范围里没有这种文件）。
```

| 文件 | 变更性质 | hunk 数 | 核实 |
|---|---|---|---|
| `test/cleanup-budget.test.ts` | 修改 | 2 | ✅ |
| `test/clipboard.test.ts` | 修改 | 1 | ✅ |
| `test/docs.test.ts` | 修改 | 1 | ✅ |
| `test/manual/probe-ui-v1.mjs` | 改名 ← `test/manual/probe-ui-old.mjs` | 12 | ⚑ |
| `test/manual/probe.mjs` | 修改 | 8 | ⚑ |
| `test/manual/shoot.mjs` | 修改 | 2 | ✅ |
| `test/manual/states.mjs` | 修改 | 17 | ✅ |
| `test/next-target.test.ts` | 修改 | 3 | ✅ |
| `test/protocol.test.ts` | 修改 | 2 | ✅ |
| `test/rate-limit.test.ts` | 修改 | 1 | ✅ |
| `test/ui-contract.test.ts` | 修改 | 7 | ✅ |
| `test/ui-guard.test.ts` | 修改 | 17 | ✅ |
| `test/ui-input.test.ts` | 修改 | 2 | ✅ |
| `test/ui-logic.test.ts` | 修改 | 4 | ✅ |

**范围对账**：`git diff --shortstat 6ebcf6e..HEAD -- test/` = `14 files changed, 1242 insertions(+), 227 deletions(-)`；
上表 14 个文件的 hunk 数逐个相加 = **79**，与 diff 文件里的 `@@` 行数**相等** ⇒ 一处没漏。

---

## 3. 逐 hunk 台账（79 条）

图例：**形状** `增`/`改`/`删`；**位置** = 新文件的 `起,止` 行（`@@ … +c,d @@` ⇒ `c, c+d−1`）；
**核实** 列 `✅` = 与 HEAD 逐字一致，**且**该 hunk 里的事实性断言已复核（§7 给判据）；
`⚑` = 该 hunk 引入的注释被本轮判定为失实/自相矛盾并已替换（明细见 §4）。
末列是该 hunk 的第一条实质变更（截断）。

- 待核：**79**
- 已核且无需改：**76**
- 已核并已修：**3**（⚑：T-1 / T-2+T-3 同属一个 hunk / T-4）
- 未核：**0**
- 另：**T-5** 是本轮补丁**自己**的勘误（不在 hunk 台账里，见 §4）——它没有新增待改处，
  只把 T-4 的第一版改法纠正过来。

| # | 文件 | 位置（新） | 形状 | 核实 | 变更摘要 |
|---|---|---|---|---|---|
| 001 | `cleanup-budget.test.ts` | 15,21 | 改 | ✅ | import 补 `SETTINGS_META_KEYS`（键名取自实现同一个常量，免得测试自造键名） |
| 002 | `cleanup-budget.test.ts` | 458,534 | 增 | ✅ | 新增 `describe('关闭成因的措辞…')` 3 例：Meta / env / 内置默认三态 |
| 003 | `clipboard.test.ts` | 11,18 | 改 | ✅ | import 路径 `public/ui/` → `public/ui_v2/`（含 `@ts-expect-error` 说明） |
| 004 | `docs.test.ts` | 104,113 | 改 | ✅ | 注释：`public/` 现为**四部分**（V1 / V2 / 跳转壳 / 站点根两个文件） |
| 005 | `probe-ui-v1.mjs` | 1,15 | 改 | ✅ | 文件头：`/ui_old/` → `/ui_v1/`、用法里的文件名同步 |
| 006 | `probe-ui-v1.mjs` | 23,29 | 改 | ✅ | `URL_PATH` 默认 `'/ui_v1/'` |
| 007 | `probe-ui-v1.mjs` | 184,225 | 增 | ✅ | 新增 `Page.addScriptToEvaluateOnNewDocument`：包装 `getComputedStyle` + `MutationObserver` 观测 `theme-color` 首写 |
| 008 | `probe-ui-v1.mjs` | 501,550 | 增 | ✅ | 新增 `THEMECOLOR` / `THEMESWITCH` 两行读数（后者"设属性→读数→立刻还原"） |
| 009 | `probe-ui-v1.mjs` | 702,708 | 改 | ✅ | 注释里的示例 URL 改名 |
| 010 | `probe-ui-v1.mjs` | 798,890 | 增 | ⚑ | 新增 `SKELETON` 判据 + `runAudit` 改为**累计 findings**（判据此前只打印、不影响退出码） |
| 011 | `probe-ui-v1.mjs` | 1027,1114 | 增 | ✅ | 新增 `PRVCLOSE` 判据（关闭预览后正文/页脚必须释放；过渡期间不得先清） |
| 012 | `probe-ui-v1.mjs` | 1212,1218 | 改 | ✅ | 文本下载那段的用法示例改名 |
| 013 | `probe-ui-v1.mjs` | 1300,1306 | 改 | ✅ | `Page.navigate` 的 url 改名（A4 一键复位筛选） |
| 014 | `probe-ui-v1.mjs` | 1495,1514 | 改 | ✅ | 四处 `Page.navigate` 的 url 改名（回收站 / 空状态 / 部署信息 / 页脚悬停） |
| 015 | `probe-ui-v1.mjs` | 1546,1552 | 改 | ✅ | 页脚致谢那段的 url 改名 |
| 016 | `probe-ui-v1.mjs` | 1612,1619 | 增 | ✅ | 收尾新增 `AUDIT SUMMARY` 一行 + `process.exitCode`（findings 非空即 1） |
| 017 | `probe.mjs` | 6,24 | 改 | ⚑ | 文件头：加 `--touch` 用法与"判据化"说明（**含一句重复残片**，见 T-1） |
| 018 | `probe.mjs` | 32,52 | 增 | ✅ | 新增 `--touch` 开关 + `problems[]` 收集器 + `check()` |
| 019 | `probe.mjs` | 137,151 | 增 | ✅ | 开触摸模拟（只开 `setTouchEmulationEnabled`、**不动**视口语义） |
| 020 | `probe.mjs` | 207,219 | 改 | ✅ | `kinds` 改读**筛选条 chips** 的 `.chip__num`（此前读 `.kinds__item`，那个类已无生产者） |
| 021 | `probe.mjs` | 232,320 | 增 | ⚑ | 新增读数：`pointerCoarse` / `controlHSm` / `ghostH` / `rowModeH` / `cardMode` / `ghostWrap` / `overflowers` |
| 022 | `probe.mjs` | 327,335 | 增 | ✅ | 抽屉读数补 `retentionCount` / `retentionHints` / `retentionNote` |
| 023 | `probe.mjs` | 337,394 | 增 | ✅ | 新增 `PRVCLOSE` 读数段（V2 版） |
| 024 | `probe.mjs` | 399,507 | 增 | ✅ | 新增整块**判据**（check × 30 余条）+ `AUDIT` 一行 + `process.exitCode` |
| 025 | `shoot.mjs` | 199,208 | 改 | ✅ | 出图目标 `public/ui/app/` → `/ui_v2/app/`；注释同步 |
| 026 | `shoot.mjs` | 246,262 | 改 | ✅ | `--only old` → `--only v1`、`07-ui-old` → `07-ui-v1`、login/路径改名 |
| 027 | `states.mjs` | 207,213 | 改 | ✅ | 入口 url 改名 |
| 028 | `states.mjs` | 254,290 | 增 | ✅ | 新增**骨架行高 = 真实行高**几何断言（宽松 / 紧凑两档，含 `--row-h` 读数） |
| 029 | `states.mjs` | 346,352 | 改 | ✅ | 刷新后 url 改名 |
| 030 | `states.mjs` | 355,361 | 改 | ✅ | 密度持久化 url 改名 |
| 031 | `states.mjs` | 820,826 | 改 | ✅ | 回收站 url 改名 |
| 032 | `states.mjs` | 849,855 | 改 | ✅ | 回活跃视图 url 改名 |
| 033 | `states.mjs` | 882,888 | 改 | ✅ | 移动端度量 url 改名 |
| 034 | `states.mjs` | 902,908 | 改 | ✅ | 复位视口后的 url 改名 |
| 035 | `states.mjs` | 965,971 | 改 | ✅ | 减弱动效那段的 url 改名 |
| 036 | `states.mjs` | 1007,1013 | 改 | ✅ | 缺陷复现那节的 url 改名 |
| 037 | `states.mjs` | 1104,1113 | 改 | ✅ | 菜单开态判据改 `!menu?.hidden`（`data-open` 已删） |
| 038 | `states.mjs` | 1274,1280 | 改 | ✅ | 首屏错误那段的 url 改名 |
| 039 | `states.mjs` | 1290,1296 | 改 | ✅ | 回收站搜索那段的 url 改名 |
| 040 | `states.mjs` | 1300,1312 | 改 | ✅ | `statistics?deleted=1` → `deleted=true`（API 只认布尔，见 T-…§4 备注 / N-15） |
| 041 | `states.mjs` | 1341,1347 | 改 | ✅ | 登录页 url 改名 |
| 042 | `states.mjs` | 1377,1383 | 改 | ✅ | 空提交用例的 url 改名 |
| 043 | `states.mjs` | 1394,1451 | 增 | ✅ | `?next=` 用例改名 + **新增 N-8 判据**：自指登录页时"只加载一次"（`Page.frameNavigated` 计数） |
| 044 | `next-target.test.ts` | 5,48 | 改 | ✅ | import 两份（V2 + V1）；新增 `LOGIN_CANONICAL` 与"平台规范形态"说明 |
| 045 | `next-target.test.ts` | 57,63 | 改 | ✅ | 跨源同主机不同协议用例改名 |
| 046 | `next-target.test.ts` | 70,112 | 增 | ✅ | 登录页自身三种写法都回落 + **新增 V1 那份的 describe**（3 例） |
| 047 | `protocol.test.ts` | 115,122 | 改 | ✅ | 归一化夹具 `/ui/API/session` → `/ui_v2/API/session`，注释补"三个前缀都是我们自己的面" |
| 048 | `protocol.test.ts` | 176,182 | 改 | ✅ | 注释里的界面前缀改名 |
| 049 | `rate-limit.test.ts` | 127,134 | 改 | ✅ | 静态资源绑定注释：改成"界面那三面" |
| 050 | `ui-contract.test.ts` | 1,7 | 改 | ✅ | 文件头：扫描目标 `public/ui_v2/**`、V1 的守卫在别处 |
| 051 | `ui-contract.test.ts` | 38,45 | 改 | ✅ | `@ts-expect-error` 说明 + import 路径改名 |
| 052 | `ui-contract.test.ts` | 65,71 | 改 | ✅ | 剥注释那段事故叙述里的通配写法改名 |
| 053 | `ui-contract.test.ts` | 82,97 | 改 | ✅ | 注释重写：V2 落在 `public/ui_v2/`（`ui_v2` 这名字 2026-09-19 才有）；`JS_FILES`/`CSS_FILES` 根目录改名 |
| 054 | `ui-contract.test.ts` | 145,151 | 改 | ✅ | `PAGES` 的两个页面路径改名 |
| 055 | `ui-contract.test.ts` | 222,252 | 改 | ✅ | **弱下界 → 精确值**：`EXPECTED_GRAPH` = index 33/32/5、login 5/4/3 |
| 056 | `ui-contract.test.ts` | 311,317 | 改 | ✅ | 动态 import 报错信息里的路径切片改名 |
| 057 | `ui-guard.test.ts` | 17,41 | 增 | ✅ | `walkFiles` 从两个 describe 的局部副本**提到模块级**（第三份复用不再复制） |
| 058 | `ui-guard.test.ts` | 156,163 | 改 | ✅ | 注释：`run_worker_first` 的六个模式写全 |
| 059 | `ui-guard.test.ts` | 190,200 | 改 | ✅ | 开关用例的路径表 `ui` → `ui_v2`（保留裸 `/ui` 那一条） |
| 060 | `ui-guard.test.ts` | 235,313 | 改 | ✅ | 大段改名：V1 受开关约束那两条用例 + 历史叙述补"当时叫 `ui_old`" |
| 061 | `ui-guard.test.ts` | 322,354 | 改 | ✅ | **删掉 `NOTICE_KEY` 那条用例**（提示条已整体移除）+ 前缀名与自包含判据改名 |
| 062 | `ui-guard.test.ts` | 363,375 | 改 | ✅ | 自包含那段注释里的路径改名 |
| 063 | `ui-guard.test.ts` | 378,384 | 改 | ✅ | `moduleId()` 的前缀切片改名 |
| 064 | `ui-guard.test.ts` | 425,431 | 改 | ✅ | 预载清单正则 `/ui_old/` → `/ui_v1/` |
| 065 | `ui-guard.test.ts` | 437,443 | 改 | ✅ | 自包含用例标题改名 |
| 066 | `ui-guard.test.ts` | 447,483 | 改 | ✅ | 跨目录判据 `/ui/` → `/ui_v2/`（含义随改名一起变，注释已说明） |
| 067 | `ui-guard.test.ts` | 487,500 | 改 | ✅ | 挂载点白名单：`next-target.js` 的字面量改 `canonical(u.pathname) === '/ui_v1/login'` |
| 068 | `ui-guard.test.ts` | 503,515 | 改 | ✅ | 字面量扫描正则 `/ui_old/` → `/ui_v1/`（含 hits 下限的文案） |
| 069 | `ui-guard.test.ts` | 520,540 | 改 | ✅ | 样式层那节注释改「令牌不空转」的射程说明；`walk` → 模块级 `walkFiles` |
| 070 | `ui-guard.test.ts` | 557,562 | 删 | ✅ | 可点控件清单里删掉 `notice-bar__close`（提示条没了） |
| 071 | `ui-guard.test.ts` | 585,591 | 改 | ✅ | `aria-describedby` 扫描改用 `walkFiles` |
| 072 | `ui-guard.test.ts` | 595,608 | 改 | ✅ | 入口链：三处 → **两处**（提示条那一处随移除消失）+ `rootRedirect` 改 `/ui_v1/` |
| 073 | `ui-guard.test.ts` | 611,817 | 增 | ✅ | 新增三节：**V2 令牌不空转**（带 `KEPT_GROUPS` 豁免表）、**挂载点事实源三处**、**`_headers` 两条** |
| 074 | `ui-input.test.ts` | 1,16 | 改 | ✅ | 五个 import 路径改名（V2 + V1 各一份） |
| 075 | `ui-input.test.ts` | 154,160 | 改 | ✅ | `api.overview(undefined, { deleted: true, tz: -480 })` → 去掉 `tz` |
| 076 | `ui-logic.test.ts` | 1,6 | 改 | ✅ | 文件头：补"含用户可见的「字符」口径" |
| 077 | `ui-logic.test.ts` | 8,33 | 改 | ✅ | 七条 import 路径改名 + V1 那两条补 `truncateText`/`charCount` 别名 |
| 078 | `ui-logic.test.ts` | 163,183 | 改 | ✅ | **改断言**：未来时间戳从"退回 `hh:mm`"改成显式「N 分钟/小时/天后」 |
| 079 | `ui-logic.test.ts` | 585,702 | 增 | ✅ | 新增 `describe('字符口径（两版…）')`：截断不切代理对 / 计数按字素簇 / 回退支注入式验证 / 两版一致 |

---

## 4. 核实中发现的问题与修复（5 条，T-1…T-4 是查出的问题，T-5 是对本轮补丁自己的勘误）

前四条**全部在注释里**，没有一条在断言逻辑上——这与 `public/` 那轮（4 条行号腐烂 + 1 处真缺陷）
形态不同：`test/` 的断言本身在改名的当天就会被 `tsc` / `vitest` 逼着改对，
**没人逼的只有注释**。

| 编号 | 类型 | 位置 | 一句话 | 处置 |
|---|---|---|---|---|
| **T-1** | 注释**重复了一整句**（残片） | `test/manual/probe.mjs` 文件头 | 「在终端里长得一样，任何缺陷都不会让它变红。」出现两次，第二行是断句错误的残片；同段还混用了弯引号 | ✅ 删掉重复行、统一引号 |
| **T-2** | **指代不实**（把 V2 的机制写进 V1） | `test/manual/probe-ui-v1.mjs` 的 `SKELETON` 注释 | 声称 V1 表格档骨架绑 `height: var(--row-h)` —— 而 `--row-h` 是 **V2 的令牌**，`public/ui_v1/` 里**一处都没有** | ✅ 改成 V1 的真实机制（`.table td` 的盒模型 `8+8+1+30`） |
| **T-3** | **承诺不存在** | 同上，紧邻的一句 | 声称「`realMin ≠ realMax` 会一并报出来」——而该探针的 findings 分支**只看 `gap` 与 `skPitch`**，这两个数只打印、不影响退出码 | ✅ 改写为"出现在读数里（不进 findings）"并说明原因 |
| **T-4** | **数字内部不自洽** | `test/manual/probe.mjs` 的 `rowModeH` 注释 | 「少 1px：125 → 124 / 77 → 76.5」——77→76.5 是 **0.5px** | ✅ 把概括改成与两个读数相符的写法（两种模式各少多少、为什么） |
| **T-5** | **本轮自己的实施勘误** | 同上（T-4 的第一版补丁） | T-4 的第一版把 `board-v2.css` / `.ghost` 写成了**反引号**形式，而那一块**在模板字符串内部** ⇒ `node --check` 直接报 `missing ) after argument list`（正是那份文件自己警告过的 N-14 形态） | ✅ 去掉反引号，并在那块就地补一句"本块不许出现反引号" |

### T-1 文件头注释重复了一整句

- **原文**（`probe.mjs` 第 15–21 行）：
  ```
  // 2026-09-19 起：probe 不只打印，还在文件末尾用 check() **自己断言一批不变式**（审计 §3 F-3）；
  // 不达标会打印一行 AUDIT 失败清单并把退出码置 1 —— 此前「探针读到空数组」与「读到 1009」
  // 在终端里长得一样，任何缺陷都不会让它变红。
  // 在终端里长得一样，任何缺陷都不会让它变红。        ← 重复 + 残句
  ```
- **核实**：第 17 行已经把这句话说完了（`…此前 A 与 B 在终端里长得一样，任何缺陷都不会让它变红。`），
  第 18 行是它的**后半截**。`grep -n` 这条注释在文件里只出现这一处，不是"有意重复"。
- **修法**：删掉第 18 行；顺手把同段第 21 行的弯引号 `“修”` 改成直引号（该文件其余各处都用直引号，
  仓库里 `385a645` 也做过一次"统一引号"）。
- **为什么值得修**：它正好落在这份文件**解释"判据为什么存在"的那一段**里 —— 这一段是后人来查
  "这个探针到底钉了什么"的第一落点，读到一个断句错误的残句会以为下面还有没写完的话。

### T-2 / T-3：V1 的骨架探针注释借了 V2 的词、又承诺了一个不存在的报告

- **原文**（`probe-ui-v1.mjs` 的 `SKELETON` 判据说明）：
  ```
  // 判据取真实行的**最小值**：两档的真实行高都可能随内容漂，骨架该对齐的是设计保证的那一档
  // （表格档是 `height: var(--row-h)`；卡片档是每行都有的固定 48px 内容区 + 固定 30/44px 操作行）。
  // 最小值同时也是「行高不漂」的判据 —— 真漂了，realMin ≠ realMax 会一并报出来。
  ```
- **核实（T-2）**：`--row-h` 在 `public/ui_v1/` 下**零命中**（它只在 `public/ui_v2/css/tokens-v2.css` 里定义）。
  V1 表格档骨架的实际绑定写在 `public/ui_v1/css/components.css` 的 `.skeleton__row` 上：
  `height: 47px`，而 47 = `.table td` 的 `8+8+1+30`（`padding: 8px` + `border-bottom: 1px` +
  行内最高的 `.icon-btn` 30px）。同一节注释的**上一段**讲的正是这条等式，只有这个括号里借了 V2 的词。
- **核实（T-3）**：该探针的 findings 分支只有两条 push —— `s.gap !== 0` 与
  （`mode === 'card'` 时的）`s.skPitch !== s.realPitch`。`realMin`/`realMax` 只出现在 `SKELETON` 那行
  读数里，**不进 `auditFindings`、不影响退出码**。⇒ "会一并报出来"若读成"会进失败清单"就是假承诺。
  （V1 的末行用 `border-bottom-color: transparent` 保住盒模型，所以两个数本来就该相等 ——
  这也是它敢用"最小值"的原因；V2 那边恰恰相反，末行真的会矮，所以 V2 的探针改用**众数**。）
- **修法**：T-2 把括号里的机制换成 V1 的真实机制；T-3 把"会一并报出来"改成"会出现在同一行读数里
  （`realMin`/`realMax`），但**不进 findings** —— 它只是这条判据取值的依据"。

### T-4：`少 1px：125 → 124 / 77 → 76.5` 内部不自洽

- **原文**（`probe.mjs` 的 `rowModeH` 注释）：`最小的那张是**末行**（末张卡片没有下边框，少 1px：125 → 124 / 77 → 76.5）`
- **核实**：两个读数分别对应两种模式，而它们**少掉的量本来就不同**：
  - **卡片档**（≤720px）：行不再是表格行，`.item` 的 `border-bottom: 1px` 是**整条**，
    末行被 `board-v2.css` 的 `.item:last-child { border-bottom: 0 }` 摘掉 ⇒ 少 **1px**（125 → 124）✅
  - **表格档**（>720px）：`board-v2.css:103` 是 `border-collapse: collapse` ⇒ 相邻行之间那条 1px
    由两侧**各担一半**，末行只少了属于它的那一半 ⇒ 少 **0.5px**（77 → 76.5）✅
  （顺带自洽：`.ghost` 的表格档等式是 `--row-h + --sp-3 + 1px`，那 1px 正是两个 0.5 之和。）
- **结论**：两个**读数都对**，错的是"少 1px"这个统一概括 —— 它让读者一算就觉得数字有问题。
- **修法**：改成分别写明"卡片档整条 1px / 表格档只少一半（`border-collapse: collapse`）"，
  并指向 `board-v2.css` 的 `.item:last-child` 与 `.ghost` 两条等式。

### T-5：本轮补丁自己的勘误——在那块注释里写反引号会把整份文件改坏

- **经过**：T-4 的第一版补丁在**同一个注释块**里写了 `` `board-v2.css` `` / `` `.ghost` ``。
  而这一块位于 `probe.mjs` 那条 `await read(…)` 的**模板字符串内部**——
  一个反引号就把模板提前结束，后面整段被当成 Node 侧代码 ⇒ `node --check` 报
  `SyntaxError: missing ) after argument list`（**文件根本不可运行**）。
- **为什么值得单列**：`probe.mjs` 自己在那块附近**写过两次**"（本块是模板字符串 ⇒ 注释里不许出现反引号。）"，
  而本轮的实施者（我）**读过那两句仍然犯了** —— 说明"就地写一句警告"对这类陷阱不够，
  起作用的是**检查**：`node --check` 一秒就抓住了它。
- **修法**：去掉反引号；并就地补一句"⚠️ 本块是模板字符串，注释里**不许出现反引号**（会提前终止模板，N-14 形态）"。
- **边界纠正**：本轮**只**对改过的两个 `.mjs` 跑了 `node --check`（语法检查，不是测试、不是脚本）。
  这不等于门禁：`tsc` / `eslint` / 22 个套件 / 四个探针的运行**一条都没跑**（见 §6）。

---

## 5. 复核结论

1. **改名跟随是干净的**：14 个文件里 12 个含"`/ui/`→`/ui_v2/`、`ui_old`→`ui_v1`"式替换，
   逐处核过**没有一处改错方向**（V2 的 import 一律指 `ui_v2`、V1 的一律指 `ui_v1`），
   也没有把 `/ui/api/*` 这个**接口前缀**误改（`ui-guard` 的判据 ② 守着这一条）。
2. **两处"改名改出了从未发生的事"已被修**：`ui-guard` 里讲 2026-09-15 事故的两段叙述，
   此前被整词替换成"把 V1 存档到 `public/ui_v1/` 时 `/ui_v2/` → `/ui_v1/`"——而那时两个名字都还不存在。
   本轮补回历史名并**明确写下"不要随改名替换"**（`test/ui-guard.test.ts:270-286` 一带）。
   这一类残留此前不在任何清单里，`docs/ui-rename-v1-v2.md` §3 已登记。
3. **补上的断言都是"结构性的"**，不是"逐个列清单"：模块图规模改成精确值（`EXPECTED_GRAPH`）、
   挂载点从 `public/` **动态发现**、`_headers` 按前缀集合校验。
   代价是"改动时必须同步"的位置多了，但每条都带**空集守卫**（`toBeGreaterThan(...)` /
   `toBeDefined()` + 提示语），不会静默放行。
4. **`test/` 这一轮没有发现"断言写错"**：79 个 hunk 里 0 条断言逻辑缺陷。
   查出的 4 条全在注释，且全部是"读者会照着它做错事"那一类（借错版本、承诺不存在、数字不自洽）。
   **但本轮唯一的"把文件改坏"是补丁自己造的**（T-5：在模板字符串内部的注释里写了反引号）——
   它被 `node --check` 当场抓住。这条记在这里是为了说明一件事：
   **"注释改动"在这份文件里不是零风险的改动**。
5. **可信度证据链在本轮是"可复算"的**：范围三数（14 / 79 / 2291）都能用两条命令重算；
   §7 的每条外部事实都给了"在哪个文件的哪一行能看到"。

## 6. 未决 / 留给下一轮

- **门禁未跑**（本轮用户明令禁止）：`tsc --noEmit`、`eslint`、22 个套件、四个手动脚本
  （`probe.mjs` / `probe-ui-v1.mjs` / `states.mjs` / `shoot.mjs`）一条都没跑。
  本轮唯一跑过的是 `node --check` 对**改过的两个 `.mjs`**（语法检查，抓到了 T-5）——
  按 `AGENTS.md` §2 的 DoD，落地前仍需补跑门禁。
- **T-3 暴露的"半条判据"没有补**：`realMin ≠ realMax` 目前只是读数。要不要把它变成一条真判据
  （V2 那边以"众数"为准，V1 这边以"相等"为准）属**探针设计决定**，不在本轮范围内 ——
  本轮只把注释改成与现状相符，没有顺手加断言（加断言需要先确定"什么算漂"）。
- **`.audits/test.diff` 与 `.audits/test-worktree.diff` 未进版本库**：它们是本轮的证据文件，
  由一条 `git diff … >` 生成（不是脚本）。需要复算请保留。
- **`.audits/` 里此前那九个分析脚本本轮没有重跑**（用户明令禁止脚本），故它们产出的结论
  （`public/` 的站内引用、`modulepreload` 闭包等）本轮只做"台账内部自洽"级别的复核，未独立复算。

---

## 7. 事实复核台账（数值 / 外部事实 / 交叉引用）

§3 的 `✅` 有两层含义，本节给第二层的判据。**每一类都只用到"读 + 数行 + 在别处找同一个事实"**。

### 7.1 范围与计数

| 口径 | 命令 / 做法 | 读数 | 与文档一致 |
|---|---|---|---|
| 文件数 | `git diff --shortstat 6ebcf6e..HEAD -- test/` | `14 files changed` | ✅ |
| ±行数 | 同上 | `+1242 / −227` | ✅ |
| hunk 数 | 数 `.audits/test.diff` 里的 `@@` 行 | **79** | ✅ |
| 文件头数 | 数同文件里的 `diff --git` 行 | **14** | ✅ |
| §2 表逐文件 hunk 数求和 | 2+1+1+12+8+2+17+3+2+1+7+17+2+4 | **79** | ✅ 与上一条相等 |

### 7.2 外部事实（hunk 里断言的东西，在**别的文件**里核实）

| hunk | 断言 | 核到哪里 | 结果 |
|---|---|---|---|
| 001 / 002 | `SETTINGS_META_KEYS.retentionMinutes === 'settings:retentionMinutes'` | `src/cleanup.ts:131-134` | ✅ 字面量逐字相同 |
| 002 | 内置默认「10080 / 1000」不可能是 0 ⇒ `reason=` 只有两态 | `src/cleanup.ts:140-141` | ✅ 两值即 10080 / 1000 |
| 002 | Meta 键名与 `PUT /ui/api/settings` 落库同一个常量 | `src/cleanup.ts:130`（注释写明 maintenance.ts 从此 import） | ✅ |
| 002 | `INSERT INTO Meta (Key, Value)` 的写法可用 | `schema.sql:51-54` | ✅ `Key TEXT PRIMARY KEY, Value TEXT NOT NULL` |
| 002 | 三个用例要用的 `fixture` / `cronRun` / `captureConsole` / `MAX_COUNT` 在作用域内 | `cleanup-budget.test.ts:31 / 169 / 225`（都在**模块级**） | ✅ 新 describe 在 :494，同为模块级 |
| 004 | 「`public/` 四部分、`/ui/` 只有 index.html + 中继脚本、站点根两个文件」 | `public/` 实际内容（`public/ui/` 下只有这两个文件；根下 `_headers` + `robots.txt`） | ✅ |
| 020 | `.kinds__item` 没有生产者；类型计数在 chips 上 | `public/ui_v2/js/ui/filters.js:37-52`（`dataset:{kind}` + `.chip__num`） | ✅ 新选择器命中 4 枚 |
| 021 | 探针把骨架注入 `document.body` 也能量到高度 ⇒ `--card-thumb` 必须声明在 `:root` | `public/ui_v2/css/board-v2.css` 的 ≤720 块（`:root { --card-thumb: 48px }`） | ✅ 两处互为前提 |
| 021 | 表格档骨架间距期望 0 ⇒ 包裹层 `.board` 基础规则无 `gap` | `board-v2.css:85-94`（只有 border/radius/bg/shadow/overflow/scroll-margin/transition） | ✅ |
| 021 | 卡片档 `gap: var(--sp-2)` = 8px | `board-v2.css` 的 `.board:has(> .ghost)` + `tokens-v2.css` 的 `--sp-2: 8px` | ✅ |
| 021 | 「第一版判据踩过：实测 156 而期望 154」 | 2×77 = 154、加包裹层上下各 1px 边框 = 156 | ✅ 自洽 |
| 024 | V2 抽屉有**七个** `.section__title` | `ui/drawer.js`：`section(...)` 六处（:91/:112/:206/:215/:220/:248）+ 活动趋势（:327） | ✅ =7 |
| 024 | 保留策略两个输入框的 placeholder 形如 `当前 N` | `ui/drawer.js` 的 `paint()`（`'当前 ' + minutes` / `'当前 ' + count`） | ✅ |
| 024 | `#notice` 仍在且初始隐藏 | `public/ui_v2/app/index.html:104`（`role="status" hidden`） | ✅ |
| 028 | `tr.item` 的行高由 `border-collapse: collapse` 的共享边框决定（末行 0.5px 差异） | `board-v2.css:103 / :221-222` | ✅ 见 T-4 |
| 043 | `cdp.listeners` 是这套 CDP 客户端的正确挂法 | `states.mjs:53`（初始化）、`:63`（派发），另有既有先例 :137 / :1174 | ✅ |
| 047 | `/ui_v2/API/session` 不该被归一（首段不是协议段） | `src/pathCase.ts:23`（`SEGMENT_1` 只含 api/file/…）与顶部约束 2（:13 明写三个界面前缀） | ✅ |
| 055 | index 33/32/5、login 5/4/3 | `public/ui_v2/app/index.html` 的 32 条 `modulepreload` + 5 张样式表；`login.html` 的 4 条 + 3 张 | ✅ 闭包 = 预载 + 入口自己 |
| 061 / 070 | 提示条整体移除（`NOTICE_KEY` 与 `notice-bar__close` 都没了） | `public/ui_v1/` 下 `notice-bar` 相关选择器与 `NOTICE_KEY` 零命中 | ✅ 故这两条断言/清单一并删掉是对的 |
| 067 | V1 的挂载点字面量改成 `canonical(u.pathname) === '/ui_v1/login'` | `public/ui_v1/js/next-target.js` 的 `canonical()` 与那个唯一字面量 | ✅ 与实现逐字同形 |
| 073 | `_headers` 判据②「该面没有这个目录就不要求」（`/ui/` 无 `css/`） | `public/ui/` 实际只有 `index.html` + `js/redirect-hash.js` | ✅ |
| 075 | `api.overview` 已不收 `tz` | `public/ui_v2/js/api.js` 的 `overview: (signal, { deleted = false } = {})` | ✅ |
| 078 | 未来时间戳的新文案是「N 分钟/小时/天后」 | `public/ui_v2/js/format.js` 的 `formatRelative`（`diff < 0` 分支） | ✅ 四档与断言逐条对应 |
| 079 | 两版 `format.js` 各有一份 `truncateText`/`charCount`，签名相同 | `public/ui_v1/js/format.js` 与 `public/ui_v2/js/format.js` | ✅ 别名 import 与之一致 |

### 7.3 探针的 DOM 钩子（判据的**前提**）

探针在改名前后的最大风险不是"判据写错"，而是**选择器失效导致静默跳过**（本轮这一批探针
新增了"findings 非空即退出码 1"，所以选择器错了会红而不是静默绿——但仍要把钩子逐个核掉）：

| 探针 | 用到的钩子 | 核到哪里 | 结果 |
|---|---|---|---|
| `probe-ui-v1.mjs` | `dialog.dialog[open]` / `.dialog__body` / `.dialog__foot` / `button[aria-label="关闭预览"]` | `public/ui_v1/js/components/preview.js:29 / :30 / :33 / :39` | ✅ 四处都在 |
| `probe.mjs` | `dialog.dialog[open]` / `.dialog__close` / `.dialog__body` / `.dialog__foot` | `public/ui_v2/js/ui/dialog.js:38 / :53 / :55 / :61` | ✅ 四处都在 |
| `probe-ui-v1.mjs` | `mode` 靠 `getComputedStyle(tr.row).display === 'flex'` 判定卡片档 | `public/ui_v1/css/components.css:1855`（`.table tr.row { display: flex }`，在 ≤860 块内） | ✅ |
| `probe-ui-v1.mjs` 的 `SKELETON` | 骨架放进 `.results` 量高度（与真实那份同父元素） | `list.js` 的 `node` 里就有 `skeleton`；`components.css` 的 `.skeleton` / `.skeleton__row` | ✅ |
| `states.mjs` 的骨架断言 | 注入 `.ghost` 到 `document.body` 并切 `data-density` | `board-v2.css` 的 `.ghost` 高度等式、`tokens-v2.css` 的 `--row-h` | ✅ |

### 7.4 一条**边界**：凡标"实测"的数字，本轮都没有起浏览器

`probe*.mjs` / `states.mjs` 的注释里大量出现实测数：`47 / 103 / 117 / 124 / 125 / 76.5 / 77 /
156 / 154 / 250ms / 300ms / 400ms / 1200ms`、CLS 0.90、`1009` 等。
本轮**没有跑任何探针**（用户明令禁止），对它们做的是**内部自洽 + 与 CSS 推导互证**：
例如 77 = `--row-h(64) + --sp-3(12) + 1px`、125 = `2×12 + 2 + 2×4 + 48 + 8 + 1 + 34`、
156 = 2×77 + 2×1、76.5/124 的差异来自末行边框（T-4）。
**自洽只能证伪、不能证实** ⇒ 这些数仍需探针才能称"实测已复核"。

### 7.5 本轮**没有**复算的（禁脚本的代价）

`.audits/` 下此前那批分析脚本（`_hunkverify` / `_docrefs` / `_preload` / `_claims` / `_eqs` …）
本轮一次都没跑。所以「hunk 逐字是否落在 HEAD 上」这一层，本轮是靠**整份读完 2291 行**得出的，
而不是靠"拼串找连续子串"的机械判据 —— 它比机械判据弱：
**机械判据能证明"一处不漏"，通读只能证明"我读到的都对"**。
补救是 §7.1 的三数对账（文件 / hunk / 逐文件求和），它把"漏读"的空间压到"读了但没记"。

### 7.6 一条**可检查的**规则：改 `test/manual/*.mjs` 的注释后必须 `node --check`

这两个探针里有**大段模板字符串**（`await read(\`…\`)` / `await evaluate(\`…\`)`），
而模板字符串**内部的注释里出现反引号会提前终止模板** —— 后果不是"注释错了"，
而是**整份文件不可运行**（N-14 的形态；T-5 就是本轮踩的同一个坑）。

- 判据：`node --check test/manual/probe.mjs`（对 `probe-ui-v1.mjs` / `states.mjs` / `shoot.mjs` 同理）
  —— 一秒、零依赖、不需要 dev server，**不是测试也不是脚本**。
- 为什么"就地写句警告"不够：这两个文件里**已经**写过两次同样的警告，
  而本轮的实施者读过之后**仍然**犯（§4 的 T-5）⇒ 起作用的是**检查**，不是提示。
- 建议（**本轮未做，属另一项决定**）：把这一条从"散在两个文件里的注释"提升为
  `AGENTS.md` §2 的一条 —— 现在的 DoD 第 1 条是 `tsc --noEmit`，而它**不覆盖** `.mjs`。

---

## 8. 范围外但属"最新"的一部分：工作区未提交的 `test/**`

`git status` 显示 `test/` 下有 **7 个文件**带未提交改动（+264 行上下），它们**不在**
`6ebcf6e..HEAD` 这个范围里，但确实是"最新状态"的一部分（是 `src/` 与 `public/` 两轮修复的
**另一半**：修复改了行为，这些断言把它钉住）。本轮一并读了，结论：

| 文件 | 未提交改动 | 核实 |
|---|---|---|
| `dto-validation.test.ts` | +147：新增 `PUT 字段 JSON 类型`、`PATCH 日期字段`、`库里的坏行` 三组；`FakeD1.exec()` + `createUiRoutes()` 接线 | ✅ 断言串与实现相符（`'Invalid JSON body'` 见 `src/routes/webdav.ts:113`） |
| `fix-regressions.test.ts` | +51：D1 的 LIKE 模式 50 字节上限（`/file/{name}` ≥49 字节从前恒 500）；UI 搜索 25 个 `%` | ✅ 错误串 `after LIKE escaping` 见 `src/serialization.ts:480` |
| `cleanup-budget.test.ts` | +23：单目录 >1000 对象时的分块删除（1200 ⇒ 2 次 `bucket.delete`） | ✅ `CountingBucket.deleteCalls` 见本文件 `:91-114`，且同形断言已有先例（`:311`） |
| `ui-guard.test.ts` | +18：裸 `/ui/api` 必须与 `/ui/api/*` **同形**（401 / JSON 404，不碰静态资源） | ✅ 依赖 `src/index.ts` 的未提交改动，属"两笔一起才成立" |
| `hardening.test.ts` | +12：UI 入口按**转义后**长度判预算（25 个 `%` 必拒、24 个 `%` 必收） | ✅ 边界自洽：24×2 = 48 ≤ 48 字节 |
| `cleanup.test.ts` | +11：`/__scheduled` 与 `beforeAll` 的两处响应体**排空** | ✅ 注释自认"**不代表已证因果**"（隔离跑 7/7、序列跑 10/10），口径诚实 |
| `fixes.test.ts` | +2/−2：注释里的方法名 `listHistoryWorkingDirs()` → `listHistoryObjectsByDir()` | ✅ 后者存在于 `src/storage.ts:143`，前者**零命中**（改对了） |

> ⚠️ 这一批**不在**本文档的 hunk 台账里（它们不是"提交"，没有 `6ebcf6e..HEAD` 这个范围可言），
> 所以 §3 的"79 处全部过了一遍"**不覆盖它们**。它们的门禁状态见 §6 —— 上一轮 `§95` 跑过
> 22 套件 / 420 例全绿，但**之后 `test/**` 又被改过**（本文档涉及的这几笔），故那一轮的绿
> 不能当作这几笔的绿。
