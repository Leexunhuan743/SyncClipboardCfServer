# AGENTS.md — 在本仓库工作的行为契约

> 给 AI 代理，也给新加入的人。**本文件与代码同等对待**：改代码时若发现它与现实不符，
> 就在同一次改动里改掉它（它自己第 1 条要求的就是这件事）。
>
> 分工：项目是什么、为什么这样取舍 → [`README.md`](README.md) + [`docs/design.md`](docs/design.md)；
> 协议逐条行为 → [`docs/protocol.md`](docs/protocol.md)；界面 → [`docs/ui.md`](docs/ui.md)。
> **本文件不抄这些内容的副本**，只写"干活时必须遵守什么"。
>
> **引文说明**：代码与文档里引用了**不在本仓库**的文档，分两类：
>   · 来自 `motion-web` 技能的两份（ADR D14 允许取用其设计系统/打磨层）：
>     `components.md` —— 组件状态矩阵九格（rest / hover / `:active` / `:focus-visible` /
>     disabled / loading / error / empty / success），其中 error 格要求：信息挨着控件、
>     被 `aria-describedby` 关联、不靠颜色单独传达（"never colour alone"）；
>     `handfeel.md` §7 —— "跟随"类动作（相机 / 光标 / 导轨 / tooltip）：必须到达并停住。
>     ⚠️ 这两份当前环境里都拿不到（仓库与 git 历史都没有）。因此凡是引用它们的地方，
>     都必须把要求**就地写全** —— 照做不需要去找原文件（最完整的一处在 `docs/ui.md`
>     硬约束第 19 条；九格逐格核对的结果在 `docs/progress.md` §69.1）。
>   · `v4.1.md` —— **外部审计文档**（2026-09-19/20 两轮逐条复核的输入）。它同样不在本仓库
>     （`git log --all -- v4.1.md` 与工作区都没有它），但角色与上两份不同：它是**证据来源**、
>     不是要求来源 ⇒ 引用处只要写明"该文件不在本仓库"即可，不必把内容抄进来
>     （已经落地的部分在 `docs/AUDIT-*-diff-6ebcf6e.md` 与 `docs/progress.md` §94–§102）。

## 1. 铁律：改代码顺手维护文档

**任何代码改动，都在同一次改动里把对应文档改完**，不留"下次一起改"、不写进待办、不靠 review 兜。

理由不是整洁，而是本仓库的文档**被测试与 CI 引用**：套件数、资源数、端点表、预载清单都在守卫里，
文档漂移要么当场把门禁变红，要么让下一个照文档干活的人写出错代码。历史上这类漂移真实发生过多次
（`README` 两处、CI 注释一处，共同点是"只有人去数才会发现"）。

| 你动了什么 | 同一次改动要同步的位置 |
|---|---|
| `src/ui/routes.ts` / `src/ui/maintenance.ts` 增删 `/ui/api/*` 端点 | `docs/ui.md` §5 端点表；`test/ui-guard.test.ts` 的 `EXPECTED_API_ROUTES`（**19 条是权威口径**） |
| `public/` 下增删任何文件 | `docs/ui.md` §3 的「共 N 个资源」总数与 V1 / V2 / 跳转壳 / 站点根分表；`docs/design.md` §4 目录树；`docs/ui-v2-design.md` §7 目录树 |
| V2 增删 JS 模块 | `public/ui_v2/app/index.html` 与 `login.html` 的 `modulepreload` 清单（**少一项留下依赖瀑布、多一项白拉一个文件，两者都不会报错**）；上面的资源数与目录树 |
| **增删界面挂载点**（`public/` 下新增/改名 `ui*` 目录） | 三份事实**必须一起改**：`wrangler.toml` 的 `run_worker_first`、`src/index.ts` 的 `isUiAsset`、`public/_headers` 的路径规则；`test/ui-guard.test.ts` 里那组**挂载点判据**（`run_worker_first` ×2 + `isUiAsset` ×1 + `_headers` ×2）会红 —— 挂载点集合一律从 `public/` **动态发现**（不写死清单），见 §3 |
| 增删测试套件 `test/*.test.ts` | 套件数出现在 `README.md`、`AGENTS.md`、`docs/design.md`、`docs/ui.md`、`.github/workflows/deploy.yml`；且 `docs/design.md` 的「**套件清单**」段要逐个列出套件名（名单与数字是两条独立断言） |
| 改 `public/ui_shared/**`（品牌图标、共用模块） | `docs/ui.md` §3.4 的规则表与 §3 的资源数/分表（`test/docs.test.ts` 会红）；`docs/design.md` §4 目录树；`docs/ui-v2-design.md` §7；`README.md` 的 `public/` 行；`test/ui-guard.test.ts` 的挂载点判据（`wrangler.toml` 的 `run_worker_first`、`src/index.ts` 的 `isUiAsset`、`public/_headers` 三处必须一起含 `ui_shared`）与 `_headers` 的 no-cache 规则 |
| 改 `public/ui_v1/js/messages.js` 或 `public/ui_v2/js/messages.js` | **两份从第一条 `import` 起必须逐字一致**（`ui-guard` 的对等守卫会红，见 §3；文件头**有意不同** —— V1 那份解释「为什么自己有一份」，别去"对齐"掉）；改 V1 时同时看 `docs/ui.md` §3.2 |
| 要**截断**或**统计用户看到的字符数**（提示条「已复制 N 个字符」、删除确认里的正文开头、行内 `aria-label`） | 用各自 `format.js` 的 `truncateText()` / `charCount()`，**不要写 `slice(0, n)` / `.length`** —— 按 UTF-16 码元切会切出半个代理对（渲染成 `�`），`.length` 把 10 个 emoji 报成 20。两版各有一份同名实现（**不共享**），改其一要同时改另一版；口径与例外见 `docs/archive/AUDIT-v1-v2-divergence.md` §5.3 |
| 改 V1 结果区的**形态**（骨架 / 表格 / 空态）或**行高** | `public/ui_v1/js/components/list.js` 的 `setView()` 是这三种形态的**唯一开关**（别处不要再直接写 `table.hidden` / `empty.hidden`）；`.skeleton__row` 的高度必须等于真实行高 —— **两档各一条等式**：表格档 `8+8+1+30 = 47px`（推导在 `components.css` 的 `.table td` 注释里）、卡片档（≤860px）按 `tr.row` 的盒模型推出 `103px`／粗指针 `117px`（推导在 `components.css` 文件末尾那一块）；`public/ui_v1/index.html` 里那份静态骨架是**挂载前**的占位，与它同源；`docs/ui.md` §9.3 的 loading 行。**补/改一个"未知"档时要过一遍该组件的每一处出口**（`update` / `showError` / `removeItem` …）—— 2026-09-18 实测：只给 `update()` 加了骨架档，`showError()` 那条出口就把「正在加载…」和「加载失败」同时留在了屏幕上；同一个哨兵值（`total === 0`）还会在**别的组件**里各写一份（分页、统计条各有自己的判据，见 `docs/AUDIT-missing-states.md`） |
| 改协议行为（路由、状态码、字段、响应头、哈希） | `docs/protocol.md` §10 差异登记表 —— **它是协议差异的唯一登记处**，每条带上游 `文件:行`；同一差异不要重复登记 |
| 做了设计取舍（新方案 / 换方案 / 决定不做） | `docs/design.md` §2 加一条 ADR（编号递增），实现处注明 D 号 |
| 修缺陷、踩到坑、量出数字 | `docs/progress.md` 追加一节（编号递增 + 日期）；**被修的行为若还有测试断言在钉它，同一次改掉断言**——别让旧断言继续固化已被判定为缺陷的行为 |
| 增删**部署开关**（运行期变量，如新的 `AUTH_RATE_LIMIT_*`） | **四处一起改**：`.dev.vars.example`（本地）、`.github/workflows/deploy.yml`（Resolve 步骤的默认值 + `vars:` 名单）、`README.md` 的开关表、`wrangler.toml` 的 `[vars]`（默认值）；`test/docs.test.ts` 的两条清单守卫会红（示例 ↔ CI ↔ README 的名字集合） |
| 改文档里写死的数字 / 文件名 / 令牌名 | 全文搜一遍再改：同一事实常散在 3~5 处 —— 套件数 **5 处**（就是 `test/docs.test.ts` 的 `CURRENT_STATE_FILES` 那 5 个文件）、`public/` 资源数 **2 处**（都在 `docs/ui.md` §3：总数 + V1 / V2 / 跳转壳 / 站点根分表）、目录树 **3 处**（`docs/design.md` §4、`docs/ui-v2-design.md` §7、`README.md` 的 `public/` 行） |

**「门禁全绿」不等于「文档对了」。** `test/docs.test.ts` 只把 5 个文件当作现状口径校验
（`README.md` / `AGENTS.md` / `docs/design.md` / `docs/ui.md` / `.github/workflows/deploy.yml`），
且只校验**套件数**与**资源数**。端点表、目录树、令牌表、差异登记表都在守卫之外 ——
**上表才是责任范围，门禁只兜住它的一部分。**

改完代码回头看一眼上表：**有没有哪一行被我漏了？** 有就先补，再提交。

**三条配套的流程惯例**（2026-09-19 按审计 F-6 落成两条、2026-09-21 事故后补第三条 —— 都是**已发生事实**的固化，不是预防性洁癖）：

1. **没跑完的门禁，必须在提交信息里写明"未验证"。** `d32631b` 在跑不完套件时写下了这条惯例
   （**原文**见该提交的提交信息：`vitest 未跑完（按用户指示"别跑测试"时中断于 transports.test.ts，日志无汇总行）
   ⇒ "22 套件全过"这一条本次未验证，不得当作已通过引用`）。**保留为惯例**：
   「没测」与「测了、通过」在文字上必须分得开 —— 否则下一位会把它当"已通过"引用。
2. **代码与文档拆成两笔提交是允许的，但要点明另一半在哪儿。** `d0c58bd`（只改代码）+
   `796a3b8`（只改文档）属同一次推送内的两笔；按上面那条铁律的字面不算"同一次改动"，
   **允许**，前提是提交信息说清「另一半在另一笔」，且**两笔都落地之后**这道 DoD 才算完成。
3. **不要把正文塞进命令行字符串**（`node -e "…"` / `bash -c "…"` / `python -c "…"`）。
   正文里的**反引号或 `${}`** 会被 shell **先**解析 —— 单引号包字符串保护不了它们。
   `docs/progress.md` §124 记着代价：2026-09-21 我用 `node -e "…"` 追加文档时，正文里
   `` `wrangler delete` `` 被当命令执行，**在仓库根目录删掉了生产 Worker**（连同它的 Secrets 与
   自定义域名），`syncc.141425.xyz` 中断约 15 分钟。做法：用 `write` 工具把脚本落成文件再
   `node 文件`（本仓库的 `write` 正为此而在），或把待插入正文放进 `local://`。

与之对照的是这条铁律**真正的失败形态**：`e3858cd` 那次改名（121 文件）当次漏了
`public/_headers`（功能面：两版前端同时退回平台默认 `max-age=0`）与 `test/manual/*.mjs`
里那 17 处死路径，随后靠 `7f4de45` → `d32631b` → `1149af0` 三笔才补齐，散文里的旧地名
又靠 `c4a9b93` + `60c510f` 两轮收敛，**仍有漏网**。
⇒ 「按目录批量替换」与「改文档里写死的数字/文件名」属同一类：**必须全文搜一遍**（上表最后一行）。
自查办法见 `docs/ui-rename-v1-v2.md` §3。

## 2. 完成定义（DoD）

一次改动算"完成"，要同时满足下面五条：

1. **类型**：`node node_modules/typescript/bin/tsc --noEmit` → 0 错。
   （`npm run <script>` 在本机 Git Bash 里会被安全策略拦，直接调 `node node_modules/...` 的 CLI 入口。）
2. **静态检查**：`node node_modules/eslint/bin/eslint.js public/ui_v2/js public/ui_v1/js test/manual` → 0 告警。
   外加**四个 `test/manual/*.mjs` 的语法门**：`node --check test/manual/probe.mjs`、
   `.../probe-ui-v1.mjs`、`.../states.mjs`、`.../shoot.mjs` → 全 0。它们既不在 `tsc` 的 include 里、
   也不进任何套件，而**模板字面量里的一个反引号就能让整份探针不可运行**（N-14 形态：
   2026-09-18 在 `states.mjs` 上发生过一次，2026-09-20 在 `probe-ui-v1.mjs` 上**又发生了一次** ——
   这次是"给注释补出处"时写进去的，`node --check` 一条命令即可拦下）。
   **2026-09-21 起这条 lint 也覆盖 `test/manual/`**：探针里「调了从未定义的标识符」语法完全合法、
   `node --check` 永远绿 —— `probe-ui-v1.mjs` 的 `check()` 就是这样让整份探针自 `fee8078` 起没跑完过，
   只有 `no-undef` 能拦下（见 `progress.md` §105.6）。⚠️ 改这一处要**同时**改 `eslint.config.js`
   的 `files` 与 `package.json` 的 `lint` 脚本，理由见 `eslint.config.js` 头部。
3. **全量套件**：先起 dev server（**端口必须 8787，测试里写死 `http://127.0.0.1:8787`**）
   `node node_modules/wrangler/bin/wrangler.js dev --test-scheduled --port 8787 --ip 127.0.0.1`，
   再 `node node_modules/vitest/vitest.mjs run --no-file-parallelism`。
   判据是 **22 个套件全过**；`ECONNREFUSED` 一律是"dev server 没起"的环境问题，**不是"可跳过"**。
4. **文档同步**：§1 那张表逐行过了一遍。
5. **改前端 ⇒ 用真实浏览器量一次**（DOM 在 ≠ 看得见）：
   V2 用 `node test/manual/probe.mjs --port <空闲端口> --width 1440 --height 900 --url /ui_v2/app/`，
   V1 用 `test/manual/probe-ui-v1.mjs`；确认**零 console 错误、零失败请求**。
   预算与判据见 `docs/ui.md` §11。

**写文档的数字口径**：套件数可以写（它可从文件系统数出来，且守卫会盯住）；**用例数不要写进现状文档**
（它每加一条断言就变、不可机械核对）——需要引用就写"见 `npm test` 输出"。

## 3. 两套前端：定位是硬约定

| | `public/ui_v1/` = **V1** | `public/ui_v2/` = **V2** |
|---|---|---|
| 定位 | **默认界面 / 产品面**（根路径 302 到这里；挂载 `/ui_v1/`） | **开发测试版**（挂载 `/ui_v2/`；应用本体在 `/ui_v2/app/`） |
| 能不能改 | 能改，改动要带走文档与守卫同步 | 允许以后**破坏性重构** |

> `/ui/`（`public/ui/`）**只剩一层跳转壳**（`index.html` + `js/redirect-hash.js`），送到 `/ui_v1/`。
> 它之所以还在，是因为 `/ui/api/*` 这个**两版共用的服务端接口**命名空间必须以 `/ui/` 为前缀
> （路由在 `src/ui/routes.ts`）。**别把接口前缀跟着改名** —— 2026-09-15 正是这样翻过一次车。

- **不要删任何一版**，也不要为了"收敛"做连带改动。
- **跨版共享只有一个面：`public/ui_shared/`**（2026-09-21 起）。规矩：只放**不随某一版演进**的东西
  （品牌图标、无版本耦合的纯数据模块如 `icons.js`；将来放双语/翻译资源）。`ui-guard` 的判据是
  "V1 的模块只允许逃到 `../ui_shared/`，逃进 `/ui_v2/` 一律红，且必须确实有引用（防空转）"。
  **两版"实现有意不同"的模块不许搬进去**（`format`/`dom`/`filters`/`api`/`messages` …）——
  搬进去就把"改一版"变成"两版一起变"，那正是这条红线要防的；判据与例子见 `docs/ui.md` §3.4。
- 两版同名的 `messages.js` 是**故意的两份**，由对等守卫钉住**正文**（从第一条 `import` 起）逐字一致
  —— 改文案两版都要改；文件头**有意不同**（V1 那份解释「为什么自己有一份」）。
- 产品投入优先给 V1；V2 只做零成本清理（例如"注释与事实相反"这类）。

## 4. 协议兼容红线

- 判定"是否对齐上游"时**直接读本机的上游源码**（`../SyncClipboard`），**不要只信本仓库的注释与文档**。
  上游基线 `28c7e596` ⇒ `/api/version` 返回 `3.2.0`（版本唯一事实源是上游 `src/Directory.Build.props` 的
  `<VersionPrefix>`，不是 `Changes.md`）。
- 官方客户端实际只调用：`/api/version`、`/SyncClipboard.json`、`/file/*`、`PROPFIND`、
  `/api/history`（query / 单条 / data / PATCH / POST）。`/api/history/statistics` 与 `/api/history/clear`
  **客户端不用**（后者只有本站界面用）。
- 有意偏离已经登记在 `docs/protocol.md` §10：**不要重复登记**，只需回答"这样改会不会破坏兼容"。
- 看到"上游没做、本实现做了"的差异，先查 §10 是否已给处置（对齐 / 有意偏离 / 不复刻）**再动手**。

## 5. 提交与推送

- 推送前**按主题压成合理粒度的提交**，并跑**真门禁**（直接判退出码，不经管道吞掉失败）。（ADR D11）
- **推送到 `master` 会触发真实的 Cloudflare 部署**（`.github/workflows/deploy.yml`）。
  没打算部署就不要推；部署开关与变量的权威说明在 `README.md` 的部署章节，别在本文件里抄副本。
- 推送成功后**这一轮就结束**，不要 `gh run watch` 守着 CI；最多一次非阻塞的 `gh run list --limit 1`。（ADR D18）
- 沙箱代理会间歇性掐断 git-over-https（`CONNECT tunnel failed` / `server closed abruptly`）：
  那是**网络故障**，不是凭据或代码问题 —— 不要改写历史、不要换凭据，等网络恢复重跑 `git push` 即可。

## 6. 不要碰

- `.workbuddy/` —— **项目记忆**（跨会话的工作日志与长期事实），不是缓存，不要删。
- `.dev.vars` —— 本地凭据，已被 `.gitignore` 排除，**永远不要提交**。
- 本地库里那批 `qf-*` 夹具（软删状态，见 `docs/progress.md` §52 的「仍未做」与 §20）：删数据需要显式授权。
- `docs/progress.md` 的历史快照数字（每轮记的套件数/行数）：那是版本曲线，**不要"顺手校准"**；
  要补就另起一节、带日期。
