# 安全审计的修复台账（cfserver-audit-003）

> **精简介**：本节起为 2026-10-04 的整篇重写（原文 230 行）；历史版本见
> `git show <hash>:docs/security-fix-plan.md`：重写前最近一版 `60c510f`，初版见
> `git show --diff-filter=A --format=%h -- docs/security-fix-plan.md`。
>
> **重写的取舍**：原文是一份**计划**（十条 Finding → 修复设计 → 提交划分 → 探针命令）。
> 现在 **P1/P2/P3 全部已落地**（只剩 P0 这个运维动作），所以本版把它改成**台账**：
> 每条只留三样 —— **问题是什么 / 现在在哪实现 / 怎么复验**。§二 的逐条修复设计、
> §三 的提交划分（都已完成）不再保留 —— 要查当时的写法用上面的 `git show`。
>
> **与姊妹文档的分工**：本文件管**本实现自己的**安全问题；
> **上游同样存在的问题**（限速、HSTS、体量上限、zip 上限）在
> [`upstream-issues.md`](upstream-issues.md)；上游缺陷在本实现里怎么处置在
> [`upstream-defects.md`](upstream-defects.md)。**三份不要混。**

- **来源**：`cfserver-audit-003`（交叉验证安全审计）：14 个验证单元 / 76 条可证伪假说 / 11 Findings。
- **审计账目**：`.audits/cfserver-audit-003/` —— **不在版本库内**（`.gitignore` 排除），
  只存在于审计时那台机器的本地工作区；干净检出上引用它的命令会 `MODULE_NOT_FOUND`。
  长期价值是**判别实验的设计**，当前可跑的替代证据是 `test/rate-limit.test.ts` 与
  `test/fix-regressions.test.ts`。
- **审计绑定的提交已不在历史里**：那次审计针对重排前的 `52bfb333…`，
  而 91 条提交随后被按主题重排为 13 条（旧 SHA 不再指向当前历史）。
- **验收口径（2026-10-04 复核）**：下面每条都**逐条对照当前代码**确认过实现位置；
> 原文 §五 的探针脚本**不可用**（见上），故"怎么复验"一栏改指**当前仓库里真有的守卫**。

---

## 一、台账

> **编号锚点**：`F1`–`F11` 是这条审计的 Finding 编号，仓库里按它们引用
> （`src/rateLimit.ts:1` 写着「`docs/security-fix-plan.md` §二·F7」）。
> 原文的**§一 优先级总览**与**§二 逐条修复设计**已合并为下面这张表 ——
> **按 `§二·F<n>` 引用时，对应的是本表里 `F<n>` 那一行。**

| # | 问题 | 严重度 | **现状与实现位置** | **怎么复验** |
|---|---|---|---|---|
| **F1** | 线上使用**文档化默认凭据**：`HKDF(PASSWORD)` 可离线复算 ⇒ 任意第三方可伪造会话、读走全部历史 | **Critical** | ◑ **代码侧已加固，运维侧未执行**：`src/auth.ts` 有 `WEAK_CREDENTIAL_VALUES` + `hasWeakCredentials()`（命中已知默认值或长度 < 8 即告警；`ENFORCE_STRONG_CREDENTIALS=true` 时 fail-closed）。**但轮换口令是运维动作，仍未做** | 运维：`npx wrangler secret put PASSWORD`；复验：**旧口令**派生的 Cookie 打 `/ui/api/session` 必须 `authenticated:false`，旧 Basic 凭据必须 401 |
| F2 | 注销不吊销令牌 | Low（**接受**） | ✅ **按设计接受**：无状态签名 Cookie 是 ADR D13 的明示取舍。登出只清本机 Cookie；**唯一撤销手段是改口令** | `docs/ui.md` §4 已写明；UI 文案一致 ⇒ 无代码可验 |
| F3 | 登录页 `?next=` **开放重定向**（`/\evil.example` 经 WHATWG 反斜杠归一后跳到站外） | Medium | ✅ **已修**：`next-target.js` 改为**按 origin 判定**（`new URL(raw, location.origin)` 比 `u.origin`），不再是前缀字符串比较 | `test/ui-logic.test.ts` 覆盖 `/\evil`、`//evil`、`javascript:` 三类变体 |
| F4 | 写端点无**来源校验**（纵深防御） | Low | ✅ **已修**：`src/index.ts:101-131` 的 `/ui/api/*` 中间件 —— 带 `Origin` 且 host 不匹配 ⇒ **403 `cross_origin_rejected`**；`Sec-Fetch-Site: cross-site` ⇒ 403；**无 `Origin` 的 CLI / 测试客户端放行**（浏览器对跨站写请求一律带 `Origin`，故该放行面不构成绕过） | `test/ui-guard.test.ts` 的契约断言 + `test/ui-input.test.ts` |
| F5 | 含 **CR/LF/NUL** 的 `dataName` 使 `/data` 恒 500（记录永久不可下载） | Medium | ✅ **已修**：出口统一编码 —— `encodeURIComponent` 同时给出 ASCII 回落与 `filename*=UTF-8''`（`src/routes/history.ts` 与 `src/contentTypes.ts` 同款） | `test/dto-validation.test.ts` 的「`/data` 头编码」用例 |
| F6 | PATCH `version` / PUT `size` **缺整数与范围校验**（`1.5` 落库、`1e400` → 500） | Low | ✅ **已修**：复用 `INT32_MIN` / `INT32_MAX`（`src/types.ts` 的**唯一定义处**）+ `Number.isSafeInteger`，非法值 400 | `test/dto-validation.test.ts` 的 PATCH/PUT 整数校验用例 |
| F7 | 认证失败路径**无限速** | Medium | ✅ **已修**：`src/rateLimit.ts` —— 权威计数在 DO（`env.HUB`），快路径读 isolate 内存 Map，**只在失败时**经 `waitUntil` 异步投递；维度 = **IP 与凭据**（另有全局计数**只用于告警、绝不封锁**，否则攻击者可用垃圾请求锁死合法用户）。**明确不做**：失败路径不写 D1（会烧掉写入额度） | `test/rate-limit.test.ts`（用 `sync.example.com` + 显式 `cf-connecting-ip` 驱动 —— **本地 loopback 有意豁免限速**，探针证明不了它） |
| F8 | 无 HSTS / 未强制 HTTPS | Low | ✅ **已修**：`src/index.ts` 全局中间件 —— 明文请求 301 到 https + `strict-transport-security`。**loopback 有意豁免**（否则本地 dev 被强行升级到不存在的 https） | `test/hardening.test.ts`（**同样不能用本地探针证明**，理由同上） |
| F9 | 资源放大面（四类无封顶） | Medium | ✅ **已修**，四类分别封顶：① multipart **分界串长度上限**（RFC 2046 的 70 字节）+ 高效查找；② 请求体上限（默认 48 MiB，可调至 64 MiB）→ 413；③ Group zip 的**解压总量 / 条目数 / 单条目 / 压缩比**四道守卫；④ 单连接**队列条数 / 字节上限**，超限断开 | `test/limits.test.ts`（分界串与 zip）+ `test/rate-limit.test.ts`（体量与队列） |
| F10 | 软删留存 | Low（**接受**） | ✅ **按设计接受**：与上游语义一致，UI 已明示 30 天窗口。要"立即彻底清除"需作为**新功能**立项（D1 + R2 双清） | 无代码可验；`docs/ui.md` §5 第 4 条 |
| F11 | 清理**跑不完 + 失败静默** | Medium（条件性） | ✅ **已修**：分阶段 `try/catch` + **子请求预算**（`SUBREQUEST_BUDGET = 800`）+ **阶段保底配额** + **游标续跑**；失败写 `cleanup:lastError` 并在 `/ui/api/info` 暴露；**轮首心跳**（先写 `lastRunAt`）让"只开始了、没跑完"可见 | `test/cleanup-budget.test.ts`（预算 / 游标 / 失败可观测）+ `test/cleanup.test.ts` |

## 二、仍未做的（只有一条）

**F1 的运维动作**：轮换线上口令。三条连带影响必须同时做，否则表现为"同步无声坏掉"：

1. **轮换**：`npx wrangler secret put PASSWORD`（以及 `USERNAME`），或在 GitHub Actions 的
   `SYNC_USER` / `SYNC_PASS` 里改后重新部署（CI 的凭据步骤会写进 Worker）。
2. **更新所有客户端配置**：桌面端 / 客户端、WebDAV 工具、备份脚本里保存的账号。
   **所有已签发的会话 Cookie 会立即失效 —— 这是期望行为。**
3. **复验**：旧口令派生的 Cookie 打 `/ui/api/session` 必须 `authenticated:false`；旧 Basic 凭据必须 401。

**残余 G1**：isolate 级密钥缓存可能让旧令牌在版本切换的窗口期内仍被接受 ——
轮换后跨多个 `cf-ray` 用旧令牌请求复测即可闭合（该窗口后来被刻意消除，见 `src/ui/session.ts` 的注释）。

## 三、范围边界（明确不做）

- **不改与上游一致的语义**（软删保留期、客户端可控 `version`/`lastModified` 的部分更新语义）——
  这些是"镜像上游"，单边偏离会造成客户端行为分歧。
- **不引入服务端会话存储**（与 ADR D13 冲突）。
- **不修改上游仓库**；上游侧问题见 [`upstream-issues.md`](upstream-issues.md)。

## 四、复验方式（当前仓库里真有的守卫）

原文 §五 给的是**审计探针脚本**路径（`.audits/cfserver-audit-003/probes/…`）——
**那个目录不在版本库内**，干净检出上跑不了。当前每条修复都有常驻守卫，按下表跑：

| 修复 | 守卫 |
|---|---|
| F3 | `test/ui-logic.test.ts`（`next-target` 的同源判定） |
| F4 | `test/ui-guard.test.ts` / `test/ui-input.test.ts` |
| F5、F6 | `test/dto-validation.test.ts` |
| F7 | `test/rate-limit.test.ts`（**必须**用非 loopback host + 显式 `cf-connecting-ip`） |
| F8 | `test/hardening.test.ts` |
| F9 | `test/limits.test.ts` + `test/rate-limit.test.ts` |
| F11 | `test/cleanup-budget.test.ts` + `test/cleanup.test.ts` |

**一句纪律**：F7 / F8 **不能用本地探针证明** —— loopback 有意豁免限速与 https 升级，
本地跑出来的"没有 429 / 没有 301"是**设计如此**，不是缺陷。
