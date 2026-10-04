# AGENTS.md — 在本仓库工作的行为契约

> 给 AI 代理，也让新加入的人。**本文件与代码同等对待**：改代码时若发现它与现实不符，
> 就在同一次改动里改掉它（下面第 1 条要求的就是这件事）。
>
> 分工：项目是什么、为什么这样取舍 → [`README.md`](README.md) + [`docs/design.md`](docs/design.md)；
> 协议逐条行为 → [`docs/protocol.md`](docs/protocol.md)；界面 → [`docs/ui.md`](docs/ui.md)。
> **本文件不抄这些内容的副本**，只写"干活时必须遵守什么"。
>
> **改写与精简（2026-10-04）**：文档过时、冗长或含无关限制时**允许整篇重写**，不受"保留原文"
> 约束；但重写只改**表述**，不改**事实**——事实须照代码/运行时逐条核对，且保住别人引用的锚点
> （章节号 / 编号 / 文件名）。重写本文件之前的历史版本见
> `git show 14e0729:AGENTS.md` 与 `git show 6883927:AGENTS.md`。
> **本仓库不删除任何已提交的历史**（不 `filter-branch`、不 `rebase -i`、不 `push --force`）：
> 否则一切"历史见 `git show <hash>`"的标注都成了空话。
>
> **引文说明**：代码与文档引用了**不在本仓库**的文件，分两类：
> - **`components.md` / `handfeel.md`** —— `motion-web` 技能的两份（ADR D14 允许取用其设计系统）。
>   `components.md` = 组件状态矩阵九格（rest / hover / `:active` / `:focus-visible` / disabled /
>   loading / error / empty / success），error 格要求：信息挨着控件、被 `aria-describedby` 关联、
>   不靠颜色单独传达（"never colour alone"）；`handfeel.md` §7 = "跟随"类动作（相机 / 光标 /
>   导轨 / tooltip）必须到达并停住。⚠️ 当前环境**拿不到**这两份（仓库与 git 历史都没有）⇒ 凡引用
>   它们的地方，必须把要求**就地写全**，照做不需要去找原文件。最完整的一处在 `docs/ui.md`
>   硬约束第 19 条；九格逐格核对在 `docs/progress.md` §69.1。
> - **`v4.1.md`** —— **外部审计文档**（2026-09-19/20 两轮复核的输入），同样不在本仓库。角色不同：
>   它是**证据来源**、非要求来源 ⇒ 引用处写明"该文件不在本仓库"即可，不必抄内容
>   （已落地的部分在 `docs/AUDIT-*-diff-6ebcf6e.md` 与 `docs/progress.md` §94–§102）。

## 0. 铁律：改代码顺手维护文档

**任何代码改动，都在同一次改动里把对应文档改完**，不留"下次一起改"、不写进待办、不靠 review 兜。

理由不是整洁，而是本仓库的文档**被测试与 CI 引用**：套件数、资源数、端点表、预载清单都在守卫里，
文档漂移要么当场把门禁变红，要么让下一个照文档干活的人写出错代码。**「门禁全绿」不等于「文档对了」**：
`test/docs.test.ts` 只把 5 个文件当现状口径校验（`README.md` / `AGENTS.md` / `docs/design.md` /
`docs/ui.md` / `.github/workflows/deploy.yml`），且只校验**套件数**与**资源数**；端点表、目录树、
令牌表、差异登记表都在守卫之外——**下表才是责任范围**。改完回头过一遍：有没有哪一行被漏了？

| 你动了什么 | 同一次改动要同步的位置 |
|---|---|
| `src/ui/routes.ts` / `src/ui/maintenance.ts` 增删 `/ui/api/*` 端点 | `docs/ui.md` §5 端点表；`test/ui-guard.test.ts` 的 `EXPECTED_API_ROUTES`（**20 条是权威口径**） |
| `public/` 下增删任何文件 | `docs/ui.md` §3 的「共 N 个资源」总数与 V1 / V2 / 跳转壳 / 站点根分表；`docs/design.md` §4 目录树；`docs/ui-v2-design.md` §7 目录树 |
| V2 增删 JS 模块 | `public/ui_v2/app/index.html` 与 `login.html` 的 `modulepreload` 清单（**少一项留下依赖瀑布、多一项白拉一个文件，两者都不会报错**）；上面的资源数与目录树 |
| **增删界面挂载点**（`public/` 下新增/改名 `ui*` 目录） | 三份事实**必须一起改**：`wrangler.toml` 的 `run_worker_first`、`src/index.ts` 的 `isUiAsset`、`public/_headers` 的路径规则；`test/ui-guard.test.ts` 的**挂载点判据**（`run_worker_first` ×2 + `isUiAsset` ×1 + `_headers` ×2）会红——挂载点集合一律从 `public/` **动态发现**，不写死清单（见 §2） |
| 增删测试套件 `test/*.test.ts` | 套件数出现在 `README.md`、`AGENTS.md`、`docs/design.md`、`docs/ui.md`、`.github/workflows/deploy.yml`；且 `docs/design.md` 的「**套件清单**」段要逐个列出套件名（名单与数字是两条独立断言） |
| 改 `public/ui_shared/**`（品牌图标、共用模块） | `docs/ui.md` §3.4 的规则表与 §3 的资源数/分表（`test/docs.test.ts` 会红）；`docs/design.md` §4 目录树；`docs/ui-v2-design.md` §7；`README.md` 的 `public/` 行；`test/ui-guard.test.ts` 的挂载点判据（`wrangler.toml` / `src/index.ts` / `public/_headers` 三处必须一起含 `ui_shared`）与 `_headers` 的 no-cache 规则 |
| 改 `public/ui_v1/js/messages.js` 或 `public/ui_v2/js/messages.js` | **两份从第一条 `import` 起必须逐字一致**（`ui-guard` 的对等守卫会红，见 §2；文件头**有意不同**——V1 那份解释「为什么自己有一份」，别去"对齐"掉）；改 V1 时同时看 `docs/ui.md` §3.2 |
| 要**截断**或**统计用户看到的字符数**（提示条「已复制 N 个字符」、删除确认里的正文开头、行内 `aria-label`） | 用各自 `format.js` 的 `truncateText()` / `charCount()`，**不要写 `slice(0, n)` / `.length`**——按 UTF-16 码元切会切出半个代理对（渲染成 `�`），`.length` 把 10 个 emoji 报成 20。两版各有一份同名实现（**不共享**），改其一要同时改另一版；口径与例外见 `docs/archive/AUDIT-v1-v2-divergence.md` §5.3 |
| 改 V1 结果区的**形态**（骨架 / 表格 / 空态）或**行高** | `public/ui_v1/js/components/list.js` 的 `setView()` 是这三种形态的**唯一开关**（别处不要再直接写 `table.hidden` / `empty.hidden`）；`.skeleton__row` 的高度必须等于真实行高——**两条等式 × 两档指针**：表格档 `8+8+1+30 = 47px`、**粗指针下换成 `--hit-min` ⇒ `61px`**（1024×768 触屏正是「表格档 + 粗指针」）、卡片档（≤860px）按 `tr.row` 的盒模型推出 `103px`／粗指针 `117px`；**外加一条实测档**：带徽标且内容格 ≤360px 的卡片行 `131px`／粗指针 `145px`（骨架画不了"哪一行带徽标"，按基础值估）。推导都在 `public/ui_v1/css/components.css`；`public/ui_v1/index.html` 里那份静态骨架是**挂载前**的占位，与它同源；见 `docs/ui.md` §3.3 第 30 条与 §9.3。**补/改一个"未知"档时要过一遍该组件的每一处出口**（`update` / `showError` / `removeItem` …）——2026-09-18 实测：只给 `update()` 加了骨架档，`showError()` 那条出口就把「正在加载…」和「加载失败」同时留在了屏幕上 |
| 改协议行为（路由、状态码、字段、响应头、哈希） | `docs/protocol.md` §10 差异登记表——**它是协议差异的唯一登记处**，每条带上游 `文件:行`；同一差异不要重复登记 |
| 做了设计取舍（新方案 / 换方案 / 决定不做） | `docs/design.md` §2 加一条 ADR（编号递增），实现处注明 D 号 |
| 修缺陷、踩到坑、量出数字 | `docs/progress.md` 追加一节（编号递增 + 日期）；**被修的行为若还有测试断言在钉它，同一次改掉断言**——别让旧断言继续固化已被判定为缺陷的行为 |
| 在 `docs/progress.md` **追加/改动小节**（`##` 标题） | `docs/progress-index.md` 的目录——它由正文的 `##` 标题生成，`test/docs.test.ts` 有一条守卫**逐条逐字**比对两者 |
| 增删**部署开关**（运行期变量，如新的 `AUTH_RATE_LIMIT_*`） | **四处一起改**：`.dev.vars.example`（本地）、`.github/workflows/deploy.yml`（Resolve 步骤的默认值 + `vars:` 名单）、`README.md` 的开关表、`wrangler.toml` 的 `[vars]`（默认值）；`test/docs.test.ts` 的两条清单守卫会红（示例 ↔ CI ↔ README 的名字集合） |
| 改文档里写死的数字 / 文件名 / 令牌名 | 全文搜一遍再改：同一事实常散在 3~5 处——套件数 **5 处**（`test/docs.test.ts` 的 `CURRENT_STATE_FILES` 那 5 个文件）、`public/` 资源数 **2 处**（都在 `docs/ui.md` §3：总数 + V1 / V2 / 跳转壳 / 站点根分表）、目录树 **3 处**（`docs/design.md` §4、`docs/ui-v2-design.md` §7、`README.md` 的 `public/` 行）——其中**模块级**增删（`js/` 下加/删文件）自 2026-09-22 起由 `test/docs.test.ts` 一条守卫按**文件系统**对账（§4 的 V1/V2 模块清单与 §7 列出的每个文件），漏改会当场红 |

**这条铁律的失败形态**（真实发生过）：`e3858cd` 改名（121 文件）当次漏了 `public/_headers`
（功能面：两版前端同时退回平台默认 `max-age=0`）与 `test/manual/*.mjs` 里 17 处死路径，
随后靠 `7f4de45` → `d32631b` → `1149af0` 三笔才补齐。⇒ 「按目录批量替换」与「改写死的数字/文件名」
属同一类：**必须全文搜一遍**（上表最后一行）。自查办法见 `docs/ui-rename-v1-v2.md` §3。

## 1. 完成定义（DoD）

一次改动算"完成"，要同时满足下面五条：

1. **类型**：`node node_modules/typescript/bin/tsc --noEmit` → 0 错。
   （`npm run <script>` 在本机 Git Bash 里会被安全策略拦，直接调 `node node_modules/...` 的 CLI 入口。）
2. **静态检查**：`node node_modules/eslint/bin/eslint.js public/ui_v2/js public/ui_v1/js public/ui_shared/js test/manual` → 0 告警。
   外加**四个 `test/manual/*.mjs` 的语法门**：`node --check test/manual/{probe,probe-ui-v1,states,shoot}.mjs` → 全 0。
   它们既不在 `tsc` 的 include 里、也不进任何套件，而**模板字面量里的一个反引号就能让整份探针不可运行**
   （`states.mjs` 2026-09-18 一次、`probe-ui-v1.mjs` 2026-09-20 一次）。⚠️ `test/manual/` 也在这条
   lint 射程内（`no-undef` 能抓到"调了从未定义的标识符"这类语法合法却跑不起来的错误，见 `progress.md` §105.6）；
   改这一处要**同时**改 `eslint.config.js` 的 `files` 与 `package.json` 的 `lint` 脚本。
3. **全量套件**：先起 dev server（**端口必须 8787，测试里写死 `http://127.0.0.1:8787`**）
   `node node_modules/wrangler/bin/wrangler.js dev --test-scheduled --port 8787 --ip 127.0.0.1`，
   再 `node node_modules/vitest/vitest.mjs run --no-file-parallelism`。
   判据是 **22 个套件全过**；`ECONNREFUSED` 一律是"dev server 没起"的环境问题，**不是"可跳过"**。
4. **文档同步**：§0 那张表逐行过了一遍。
5. **改前端 ⇒ 用真实浏览器量一次**（DOM 在 ≠ 看得见）：
   V2 用 `node test/manual/probe.mjs --port <空闲端口> --width 1440 --height 900 --url /ui_v2/app/`
   **与 `--width 390 --height 844`**（窄屏是**另一套布局**：概览带折两行、趋势图独占一行——2026-09-22
   实测过一个只在窄屏越预算的首屏 CLS 缺陷，1440 档读数是 0.0026 而 390 档 0.1217）。
   V1 用 `test/manual/probe-ui-v1.mjs`（同样至少覆盖一档宽 + 一档窄，见 `public/ui_v1/README.md`）。
   确认**零 console 错误、零失败请求**、探针退出码 0。预算与判据见 `docs/ui.md` §11。

**写文档的数字口径**：套件数可以写（可从文件系统数出来，且守卫会盯住）；**用例数不要写进现状文档**
（每加一条断言就变、不可机械核对）——需要引用就写"见 `npm test` 输出"。

## 2. 两套前端：定位是硬约定

| | `public/ui_v1/` = **V1** | `public/ui_v2/` = **V2** |
|---|---|---|
| 定位 | **默认界面 / 产品面**（根路径 302 到这里；挂载 `/ui_v1/`） | **开发测试版**（挂载 `/ui_v2/`；应用本体在 `/ui_v2/app/`） |
| 能不能改 | 能改，改动要带走文档与守卫同步 | 允许以后**破坏性重构** |

- **不要删任何一版**，也不要为了"收敛"做连带改动。产品投入优先给 V1；V2 只做零成本清理。
- `/ui/`（`public/ui/`）**只剩一层跳转壳**（`index.html` + `js/redirect-hash.js`），送到 `/ui_v1/`。
  它还在，是因为 `/ui/api/*` 这个**两版共用的服务端接口**命名空间必须以 `/ui/` 为前缀
  （路由在 `src/ui/routes.ts`）。**别把接口前缀跟着改名**——2026-09-15 正是这样翻过一次车。
- **跨版共享只有一个面：`public/ui_shared/`**（2026-09-21 起）。只放**不随某一版演进**的东西
  （品牌图标、无版本耦合的纯数据模块如 `icons.js`）。`ui-guard` 的判据是："V1 的模块只允许逃到
  `../ui_shared/`，逃进 `/ui_v2/` 一律红，且必须确实有引用（防空转）"。**两版"实现有意不同"的
  模块不许搬进去**（`format`/`dom`/`filters`/`api`/`messages` …）——搬进去就把"改一版"变成"两版一起变"，
  那正是这条红线要防的；判据与例子见 `docs/ui.md` §3.4。
- 两版同名的 `messages.js` 是**故意的两份**，由对等守卫钉住**正文**（从第一条 `import` 起）逐字一致
  ——改文案两版都要改；文件头**有意不同**（V1 那份解释「为什么自己有一份」）。

## 3. 协议兼容红线

- 判定"是否对齐上游"时**直接读本机的上游源码**（`../SyncClipboard`），**不要只信本仓库的注释与文档**。
  上游基线 `984d3463` ⇒ `/api/version` 返回 `3.3.0-beta1`（版本唯一事实源是上游 `src/Directory.Build.props`
  的 `<VersionPrefix>` + `<VersionSuffix>`，不是 `Changes.md`）。
- 官方客户端实际只调用：`/api/version`、`/SyncClipboard.json`、`/file/*`、`PROPFIND`、
  `/api/history`（query / 单条 / data / PATCH / POST）。`/api/history/statistics` 与 `/api/history/clear`
  **客户端不用**（后者只有本站界面用）。
- 有意偏离已经登记在 `docs/protocol.md` §10：**不要重复登记**，只需回答"这样改会不会破坏兼容"。
  看到"上游没做、本实现做了"的差异，先查 §10 是否已给处置（对齐 / 有意偏离 / 不复刻）**再动手**。

## 4. 提交与推送

- 推送前**按主题压成合理粒度的提交**，并跑**真门禁**（直接判退出码，不经管道吞掉失败）。（ADR D11）
- **推送到 `master` 会触发真实 Cloudflare 部署**（`.github/workflows/deploy.yml`）。
  没打算部署就不要推；部署开关与变量的权威说明在 `README.md` 的部署章节，别在本文件里抄副本。
- 推送成功后**这是本轮最后一件事**，不要 `gh run watch` 守着 CI；最多一次非阻塞的 `gh run list --limit 1`。（ADR D18）
- 沙箱代理会间歇性掐断 git-over-https（`CONNECT tunnel failed` / `server closed abruptly`）：
  那是**网络故障**，不是凭据或代码问题——不要改写历史、不要换凭据，等网络恢复重跑 `git push` 即可。
- **三条流程惯例**（每条都有已发生的事故背书，不是预防性洁癖）：
  1. **没跑完的门禁，必须在提交信息里写明"未验证"。**「没测」与「测了、通过」在文字上必须分得开，
     否则下一位会把它当"已通过"引用。
  2. **不要把正文塞进命令行字符串**（`node -e "…"` / `bash -c "…"` / `python -c "…"`）：正文里的
     **反引号或 `${}`** 会被 shell **先**解析，单引号包字符串保护不了它们。代价见 `docs/progress.md` §124：
     2026-09-21 用 `node -e "…"` 追加文档时，正文里的 `` `wrangler delete` `` 被当命令执行，
     **删掉了生产 Worker**（`syncc.141425.xyz` 中断约 15 分钟）。做法：用 `write` 工具把脚本落成文件再
     `node 文件`。
  3. **门禁跑着的时候不要改文档**：`test/docs.test.ts` 读的是**工作区文件**，会读到"正文已追加、
     目录还没写"的**中间态**而红（2026-09-22 曾把这条红误判成"偶发"，见 `progress.md` §159）。
     规矩：**先改完文档再跑门禁**，或**等门禁跑完再改**；真红了先用
     `--reporter=json --outputFile=/tmp/fail.json` 拿**测试名**，不要用 `tail` 猜。

## 5. 不要碰

- `.workbuddy/` —— **项目记忆**（跨会话的工作日志与长期事实），不是缓存，不要删。
- `.dev.vars` —— 本地凭据，已被 `.gitignore` 排除，**永远不要提交**。
- 本地库里那批 `qf-*` 夹具（软删状态，见 `docs/progress.md` §52 的「仍未做」与 §20）：删数据需要显式授权。
- `docs/progress.md` 的历史快照数字（每轮记的套件数/行数）：那是版本曲线，**不要"顺手校准"**；
  要补就另起一节、带日期。
