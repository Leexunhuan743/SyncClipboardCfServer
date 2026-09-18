# AGENTS.md — 在本仓库工作的行为契约

> 给 AI 代理，也给新加入的人。**本文件与代码同等对待**：改代码时若发现它与现实不符，
> 就在同一次改动里改掉它（它自己第 1 条要求的就是这件事）。
>
> 分工：项目是什么、为什么这样取舍 → [`README.md`](README.md) + [`docs/design.md`](docs/design.md)；
> 协议逐条行为 → [`docs/protocol.md`](docs/protocol.md)；界面 → [`docs/ui.md`](docs/ui.md)。
> **本文件不抄这些内容的副本**，只写"干活时必须遵守什么"。

## 1. 铁律：改代码顺手维护文档

**任何代码改动，都在同一次改动里把对应文档改完**，不留"下次一起改"、不写进待办、不靠 review 兜。

理由不是整洁，而是本仓库的文档**被测试与 CI 引用**：套件数、资源数、端点表、预载清单都在守卫里，
文档漂移要么当场把门禁变红，要么让下一个照文档干活的人写出错代码。历史上这类漂移真实发生过多次
（`README` 两处、CI 注释一处，共同点是"只有人去数才会发现"）。

| 你动了什么 | 同一次改动要同步的位置 |
|---|---|
| `src/ui/routes.ts` / `src/ui/maintenance.ts` 增删 `/ui/api/*` 端点 | `docs/ui.md` §5 端点表；`test/ui-guard.test.ts` 的 `EXPECTED_API_ROUTES`（**18 条是权威口径**） |
| `public/` 下增删任何文件 | `docs/ui.md` §3 的「共 N 个资源」总数与 V2 / V1 / 站点根三行分表；`docs/design.md` §4 目录树；`docs/ui-v2-design.md` §7 目录树 |
| V2 增删 JS 模块 | `public/ui/app/index.html` 与 `login.html` 的 `modulepreload` 清单（**少一项留下依赖瀑布、多一项白拉一个文件，两者都不会报错**）；上面的资源数与目录树 |
| 增删测试套件 `test/*.test.ts` | 套件数出现在 `README.md`、`docs/design.md`、`docs/ui.md`、`.github/workflows/deploy.yml`；且 `docs/design.md` 的「**套件清单**」段要逐个列出套件名（名单与数字是两条独立断言） |
| 改 `public/ui_old/js/messages.js` 或 `public/ui/js/messages.js` | **两份必须逐字一致**（`ui-guard` 的对等守卫会红，见 §3）；改 V1 时同时看 `docs/ui.md` §3.2 |
| 改协议行为（路由、状态码、字段、响应头、哈希） | `docs/protocol.md` §10 差异登记表 —— **它是协议差异的唯一登记处**，每条带上游 `文件:行`；同一差异不要重复登记 |
| 做了设计取舍（新方案 / 换方案 / 决定不做） | `docs/design.md` §2 加一条 ADR（编号递增），实现处注明 D 号 |
| 修缺陷、踩到坑、量出数字 | `docs/progress.md` 追加一节（编号递增 + 日期）；**被修的行为若还有测试断言在钉它，同一次改掉断言**——别让旧断言继续固化已被判定为缺陷的行为 |
| 改文档里写死的数字 / 文件名 / 令牌名 | 全文搜一遍再改：同一事实常散在 3~4 处（套件数 4 处、资源数 2 处、V2 目录树 3 处） |

**「门禁全绿」不等于「文档对了」。** `test/docs.test.ts` 只把 4 个文件当作现状口径校验
（`README.md` / `docs/design.md` / `docs/ui.md` / `.github/workflows/deploy.yml`），
且只校验**套件数**与**资源数**。端点表、目录树、令牌表、差异登记表都在守卫之外 ——
**上表才是责任范围，门禁只兜住它的一部分。**

改完代码回头看一眼上表：**有没有哪一行被我漏了？** 有就先补，再提交。

## 2. 完成定义（DoD）

一次改动算"完成"，要同时满足下面五条：

1. **类型**：`node node_modules/typescript/bin/tsc --noEmit` → 0 错。
   （`npm run <script>` 在本机 Git Bash 里会被安全策略拦，直接调 `node node_modules/...` 的 CLI 入口。）
2. **静态检查**：`node node_modules/eslint/bin/eslint.js public/ui/js public/ui_old/js` → 0 告警。
3. **全量套件**：先起 dev server（**端口必须 8787，测试里写死 `http://127.0.0.1:8787`**）
   `node node_modules/wrangler/bin/wrangler.js dev --test-scheduled --port 8787 --ip 127.0.0.1`，
   再 `node node_modules/vitest/vitest.mjs run --no-file-parallelism`。
   判据是 **22 个套件全过**；`ECONNREFUSED` 一律是"dev server 没起"的环境问题，**不是"可跳过"**。
4. **文档同步**：§1 那张表逐行过了一遍。
5. **改前端 ⇒ 用真实浏览器量一次**（DOM 在 ≠ 看得见）：
   V2 用 `node test/manual/probe.mjs --port <空闲端口> --width 1440 --height 900 --url /ui/app/`，
   V1 用 `test/manual/probe-ui-old.mjs`；确认**零 console 错误、零失败请求**。
   预算与判据见 `docs/ui.md` §11。

**写文档的数字口径**：套件数可以写（它可从文件系统数出来，且守卫会盯住）；**用例数不要写进现状文档**
（它每加一条断言就变、不可机械核对）——需要引用就写"见 `npm test` 输出"。

## 3. 两套前端：定位是硬约定

| | `public/ui_old/` = **V1** | `public/ui/` = **V2** |
|---|---|---|
| 定位 | **默认界面 / 产品面**（根路径 302 到这里；挂载 `/ui_old/`） | **开发测试版**（挂载 `/ui/`、`/ui/app/`） |
| 能不能改 | 能改，改动要带走文档与守卫同步 | 允许以后**破坏性重构** |

- **不要删任何一版**，也不要为了"收敛"做连带改动。
- **不要跨版抽公共模块**：V1 必须自包含（`ui-guard` 禁止它引用 `../../ui/`，产品面不依赖开发版）。
- 两版同名的 `messages.js` 是**故意的两份**，由对等守卫钉住逐字一致 —— 改文案两版都要改。
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
- 本地库里那批 `qf-*` 夹具（软删状态，见 `docs/progress.md` §16.8）：删数据需要显式授权。
- `docs/progress.md` 的历史快照数字（每轮记的套件数/行数）：那是版本曲线，**不要"顺手校准"**；
  要补就另起一节、带日期。
