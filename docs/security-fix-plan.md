# SyncClipboardCfServer 安全修复计划

- **来源**：`cfserver-audit-003`（交叉验证安全审计）。该审计**绑定的是一个重排前存在、现已不存在的提交**（`52bfb333…`）：本轮把 91 条提交按主题重排为 13 条（根提交 + 12 个主题提交），旧 SHA 均不再指向当前历史；审计账目保留在`.audits/cfserver-audit-003/`（不在版本库内），其 `state.json` 内仍记录重排前的快照 SHA。
- **审计账目**：14 个验证单元 / 76 条可证伪假说 / 11 Findings / 10 残余 · validator `PASS, 0 errors`
- **完整报告**：`.audits/cfserver-audit-003/report.md`（含每条 Finding 的证据 id、上游对照、过程披露）
- **本文档定位**：把报告的 Findings 落成可执行的修复计划。**审计是 audit-only，本文档不代表已修复。**
- **配套文档**：`docs/upstream-issues.md`（其中同时属于上游 SyncClipboard 的问题的 issue 稿）

---

> **实施状态（2026-09-13 更新）**：本文档 §二 的 P1–P3 项**已全部实施并验证**——`npx tsc --noEmit` 干净，
> `npm test` **全部 20 个套件通过**（用例数见命令输出）；F5/F6 另有"翻转探针"证据（修前 500/落库 → 修后 200/400）。
> `P0`（线上口令轮换）**仍未执行**，属运维动作，需部署者完成。逐项改动与集成期发现见 `docs/progress.md` 第 27 轮。
> §五 的验证方法仍适用：复跑 `.audits/cfserver-audit-003/probes/lead-agent/` 下的探针应得到与修复前相反的结果。

## 一、优先级总览

| 优先级 | 项 | 严重度 | 工作量 | 可判定退出条件（验收） |
|---|---|---|---|---|
| **P0** | F1 轮换线上口令 | **Critical** | 5 分钟（运维） | 用旧口令派生的会话 Cookie 打线上 `/ui/api/session` 返回 `authenticated:false`，Basic 旧凭据返回 401 |
| P1 | F3 开放重定向 | Medium | 1 行 + 1 用例 | `?next=/\evil.example` 不再离开本站；`?next=//evil` 仍被拒；站内 `?next=/ui/` 正常 |
| P1 | F5 CRLF 名称致 500 | Medium | 1 行 | 复跑 `probes/lead-agent/lead-verify5.mjs`：CRLF/NUL 记录 `/data` 不再 500，正常名仍 200 |
| P1 | F7 认证失败无限速 | Medium | 0.5–1 天 | 20 次错凭据触发限速（429 或递增延迟/锁定），且正常用户不受影响 |
| P1 | F11 清理跑不完 + 失败静默 | Medium(COND) | 1–2 天 | 构造积压后清理能在有限次运行内收敛；注入失败产生可观测信号 |
| P2 | F6 version/size 校验 | Low | 10 行 | `PATCH {"version":1.5}` 与 `{"version":1e400}` 返回 400；正常更新不受影响 |
| P2 | F8 无 HSTS / 未强制 HTTPS | Low | 5 行 | 响应带 `Strict-Transport-Security`；明文请求 301 到 https |
| P2 | F4 写端点无来源校验 | Low | 5 行 | 带外源 `Origin`/`Sec-Fetch-Site: cross-site` 的写请求被拒 |
| P2 | F9 资源放大面 | Medium | 1–2 天 | 分界串/体量/zip/队列四类封顶生效，超限请求快速 400/413 |
| P3 | F2 注销不吊销 / F10 软删留存 | Low（接受） | 文案 | 文档与 UI 文案与实现一致（无代码改动） |

---

## 二、逐条修复设计

### P0 · F1 —— 线上使用文档化默认凭据（Critical）

**现状**：线上 `PASSWORD`/`USERNAME` 的字面值等于文档化默认值，会话签名密钥 `HKDF(PASSWORD)` 因此可离线复算 ⇒ 任意第三方可伪造会话、读取全部历史与附件（审计 §三 F1，证据 R4-E6/E7 + 独立挑战复现）。

**修复（运维，非代码）**：

1. 轮换：`npx wrangler secret put PASSWORD`（以及 `USERNAME`），或在 GitHub Actions 的 `SYNC_USER`/`SYNC_PASS` 里改后重新部署（`deploy.yml` 的 `Sync Basic Auth credentials` 步骤会把它们写进 Worker）。
2. 轮换的连带影响（必须同时做，否则表现为"同步无声坏掉"）：桌面/客户端、WebDAV 工具、R2 备份脚本里保存的账号配置全部要更新；所有已签发的会话 Cookie 会立即失效（这是期望行为）。
3. 复测：用**旧口令**派生密钥签发的 Cookie 打线上 `/ui/api/session` 必须 `authenticated:false`；旧 Basic 凭据必须 401。

**可选代码加固（建议做）**：在 `src/auth.ts` 的配置校验处增加弱凭据拒绝——命中 `admin`、`your_username`、`your_password` 等已知默认值时启动即报错或显著告警（当前只有"未配置即 500"的 fail-closed）。
**残余**：G1（isolate 级密钥缓存可能让旧令牌在版本切换窗口期仍被接受）——轮换后按 G1 的闭合方式复测（跨多个 `cf-ray` 用旧令牌请求）。

---

### P1 · F3 —— 登录页 `?next=` 开放重定向

**现状**：`public/ui/js/login.js:11-14` 的 `safeNext()` 只拒绝 `//` 前缀；`/\evil.example` 通过校验，浏览器按 WHATWG 把反斜杠视同斜杠 ⇒ `location.replace` 跳到站外（登录后 `:49` 与已登录加载时 `:67-70` 两处）。

**修复**：按 origin 判定，而不是前缀字符串比较：

```js
const safeNext = (raw) => {
  if (!raw) return null;
  try { const u = new URL(raw, location.origin);
        return u.origin === location.origin ? u.pathname + u.search + u.hash : null; }
  catch { return null; }
};
```

**验收**：`?next=/\evil.example`、`?next=//evil.example`、`?next=javascript:alert(1)` 全部落回站内；`?next=/ui/?x=1` 正常跳转。补一条回归用例（现有测试未覆盖反斜杠变体）。
**上游归属**：本项目新增面（上游 `SyncClipboard.Server.Core` 无 Web UI 与登录页，`grep -rE "Cookie|Session|HtmlContent|text/html"` 零命中）⇒ 非上游问题。

---

### P1 · F5 —— 含 CR/LF/NUL 的 dataName 使官方 `/data` 恒 500

**现状**：写路径不校验 `dataName`/`fileName` 中的控制字符，落库后 `src/routes/history.ts:222` 附近拼接 `Content-Disposition` 抛非法头值 ⇒ 该记录**永久不可下载**（`GET /api/history/{profileId}/data` 恒 500）。同仓库另两处已用 `encodeURIComponent`（`src/contentTypes.ts:92`、`src/ui/routes.ts:168`）。

**修复**：出口统一编码（推荐，不破坏既有数据可读性）：

```ts
const asciiFallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
res.headers.set('content-disposition',
  `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`);
```

或在写入侧拒绝控制字符（二选一）。**验收**：复跑 `node .audits/cfserver-audit-003/probes/lead-agent/lead-verify5.mjs` —— CRLF 与 NUL 记录的 `/data` 应返回 200，正常文件名对照仍 200。
**上游归属**：上游走 `HistoryController.cs:66` 的 `File(stream, contentType, fileName)`，由 ASP.NET 写头；**是否同样 500 未验证**（不在上游 issue 中主张）。

---

### P1 · F7 —— 认证失败路径无限速

**现状**：登录端点（`src/ui/routes.ts` 的 `/ui/api/login`）与全部 Basic 协议端点没有任何限速/失败计数/锁定/递增延迟；实测线上 32 次、本地 197 次、主代理 20 次错凭据零阻断。免费额度下约 1e5 次/天。

**修复（按成本递增，建议至少做 1+2）**：

1. README 把"必须使用高熵口令"从提示改成**硬性要求**（含生成示例与"弱口令=数据全失守"的说明）。
2. 计数与封锁：**主存储在已有的 Durable Object**（`env.HUB`）里维护计数器，**快路径用 isolate 内存 Map**（零 I/O，正常同步路径零额外往返），只在**失败时**异步投递一次 DO（`ctx.waitUntil`）；维度按 **IP** 与 **凭据（用户名）** 分别封锁，另加**全局阈值仅用于告警**（绝不用它封锁，否则攻击者可用垃圾请求锁死合法用户）。
   - 阈值示例：IP 15 分钟 10 次失败 → 429 + `Retry-After`；成功即清零。
   - **明确不做**：失败路径上不写 D1（免费额度 10 万写/天，与爆破量级同阶 ⇒ 攻击者可用错口令请求烧掉写入额度、并让每次失败多一次 D1 往返）。DO 侧持久化也走低频（每 N 次或 alarm 落盘）。
3. 备选（更省，但需先升级工具链）：Cloudflare Rate Limiting 规则，不消耗 Worker 调用；注意本仓 `wrangler 3.114.17` 低于该 binding 所需 4.36.0，需先升 wrangler。

> **封锁是 best-effort / 最终一致，不是全局硬保证**：isolate 内存是每实例的，失败上报是 `waitUntil` fire-and-forget，DO 被驱逐后计数还可能回退；缺 `cf-connecting-ip` 的**不可归因**流量不进入可锁桶（归因制：拿不到该头就不启用 IP 维度）。
> 验收口径：**同一 isolate 内连续 N 次失败返回 429；跨 isolate 为最终一致（不保证即时全局封锁）**。

**验收**：连续 N 次失败后返回 429；正常凭据在阈值内不受影响；计数器有过期清理避免无界增长。
**上游归属**：**上游同样没有限速** ⇒ 同步见 `docs/upstream-issues.md` 第 2 条。

---

### P1 · F11 —— 清理在积压场景跑不完 + 失败静默（CONDITIONAL）

**现状**：`src/cleanup.ts` 四阶段线性串联、无子请求预算守卫；每条被处理记录约 3 次子请求（2×R2 删 + 1 DO 广播）⇒ 免费计划 `1,000 internal-subrequest/Cron` 在**约 330 条**耗尽（Paid 10,000 ⇒ 约 3,300 条），代码自身上限的饱和批实测 **12,060** 次；超限中止**连带跳过**同次的 30 天硬删与孤儿扫描。且 `src/index.ts` 的 `ctx.waitUntil(runCleanup(env))` **无 catch**：注入 D1 错误后 `/__scheduled` 仍 200、日志只有 `Uncaught Error`、无 `[cleanup]` 行、无告警。硬删吞吐 200 条/次·小时 vs 软删产生上限 4,000 条/次·小时（16 倍差）。

**当前是否已触发**：否 —— 最近只读 statistics 为 `totalCount=329 / activeCount=64 / deletedCount=265`，与阈值同量级但未越线（属"积压增长后必然发生"的结构性风险）。

**修复**：

1. **预算感知 + 分阶段兜底**：把每阶段包在 `try/catch`，单个阶段超预算只跳过该阶段并记录；把"本轮已处理到的游标"写进 `Meta`（如 `cleanup:cursor`），下次从游标继续。
2. **失败可观测**：`waitUntil(runCleanup(env).catch(err => console.error(...)))` 之外，把失败写入 `Meta.lastCleanupError`（UI `/ui/api/info` 可展示）或 DO 计数；保证"静默未清理"不再可能。
3. **对齐上游语义**：硬删改为循环直到清空（上游 `HistoryService.cs:516-530` 是 `RemoveRange` + 单次 `SaveChanges`，无批次上限），或把批量提到与产生速率同阶。
4. **实测收敛**：构造积压（本地可写）后连续触发 scheduled，验证有限次内收敛。

**验收**：① 饱和积压下阶段 2–4 不再被跳过；② 注入失败产生可观测信号；③ 生产实测量级不再与阈值同阶。
**上游归属**：**cfserver 特有** —— 上游 `HistoryCleaner.cs` 三个循环 `while (!_cts.IsCancellationRequested)` + `Task.Delay(10min/12h)` + `logger.LogError`，无批量上限、失败有日志且下轮重试 ⇒ 该缺陷由本实现的"分批上限 + 无 catch"引入。

---

### P2 · F6 —— PATCH `version` / PUT `size` 缺整数与范围校验

**现状**：`src/serialization.ts:342-348`（PATCH DTO）与 `:224-232`（PUT DTO）只做 `typeof === 'number'`；实测 `{"version":1.5}` 落库、`{"version":1e400}` → 500。同仓库 POST 路径已有 `parseCSharpInt32` / `Number.isSafeInteger` 口径（`src/routes/history.ts:74-138`）。

**修复**：PATCH/PUT 复用同一校验；非法值 400。

```ts
if (typeof version === 'number' && Number.isSafeInteger(version) && version >= INT32_MIN && version <= INT32_MAX) dto.version = version;
else if (version !== undefined) throw new BadRequestError('version must be an int32');
```

**验收**：`1.5`/`1e400` → 400；`1`、`0` → 200；正常客户端同步不受影响。
**上游归属**：**上游更严**（`HistoryRecordUpdateDto.cs:8` 为 `int?`、`ProfileDto.cs:15` 为 `long?`，模型绑定直接 400）⇒ 本实现偏离上游，非上游问题。

---

### P2 · F8 —— 无 HSTS / 未强制 HTTPS

**现状**：仓库与 Hono 层无安全响应头中间件；明文请求不升级、无 `Strict-Transport-Security`。上游 `Web.cs:108-117` 亦仅在有证书时 `UseHttps()`、无 `UseHsts`。

**修复**：`src/index.ts` 全局中间件加：

```ts
const proto = request.headers.get('x-forwarded-proto');
if (proto === 'http') return Response.redirect(url.replace('http://', 'https://'), 301);
res.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
```

**验收**：`curl -I http://…/` 返回 301；https 响应含 HSTS 头。
**上游归属**：**上游同样没有** ⇒ 见 `docs/upstream-issues.md` 第 3 条。

---

### P2 · F4 —— 写端点无服务端来源校验（纵深防御）

**现状**：`/ui/api/*` 状态变更端点不校验 `Origin`/`Referer`/`Sec-Fetch-Site`（全 src 零命中）；唯一防线是 `SameSite=Strict` + `workers.dev` 在 PSL 内（跨账号属跨站 ⇒ 第三方不可利用）。**Basic 第二通道的跨站附带未闭合**（残余 G3）。

**修复**：加一层来源判定中间件（拒绝带外源 `Origin` 的写请求；无 `Origin` 的 CLI 客户端放行）；顺便给 `batch-delete` 校验 `Content-Type: application/json`。

**验收**：带 `Origin: https://evil.example` 的 PATCH 被拒；正常 UI 与 CLI 客户端不受影响。
**上游归属**：本项目新增面（上游无 Cookie 会话、无状态变更型 UI 端点）。

---

### P2 · F9 —— 资源放大面（四类封顶）

| 项 | 现状 | 修复 |
|---|---|---|
| multipart 分界串 | 查找为朴素 `O(体×分界串)`、boundary 无长度上限（64KB 体、2048 字节分界串 → 267ms） | boundary 长度上限（如 70 字节，RFC 2046 上限）+ 改用高效查找 |
| 请求体 | 全量读入 isolate（上游更直接：`MaxRequestBodySize = int.MaxValue`） | 按端点设体量上限，超限 413 |
| Group zip | 无解压体积/条目上限（65.7KB → 64MB，≈1000:1；代价在哈希校验前已付） | 解压总量/条目数上限 + 压缩比守卫 |
| 广播/长轮询队列 | 扇出无上界（30 连接 × 1.6MB = 48MB/次写；单连接队列实测累积 4.5MB） | 单连接队列条数/字节上限 + 超限断开 |

**验收**：四类超限请求快速失败（400/413），正常同步路径不受影响。
**上游归属**：zip 无上限与体量上限**上游同样存在** ⇒ 见 `docs/upstream-issues.md` 第 4、5 条；分界串朴素查找与广播扇出为**本实现特有**。

---

### P3 · F2 / F10 —— 建议接受，但必须改文案

- **F2 注销不吊销令牌**：无状态签名 Cookie 是 ADR D13 的明示取舍。**修复 = 文案**：`docs/ui.md` 与 UI 说明改为"登出只清除本机 Cookie，不使已泄露令牌失效；唯一撤销手段是改口令"。若将来要求真正吊销，需引入服务端会话版本（与 D13 冲突，须单独立项）。
- **F10 软删留存**：与上游语义一致，UI 已明示 30 天窗口。**修复 = 无代码改动**；若要"立即彻底清除"能力，作为新功能立项（需 D1 + R2 双清）。

---

## 三、建议的提交划分（按 ADR D11 修订版：本地细碎、**推送前按主题聚合**）

> 下表是"本地可以先这样分"的粒度；按 D11 修订版，推送到 `master` 前应把同一主题的若干条聚合成一条（例如下表第 1–3 条若属同一轮修复，可并为一条 `fix(security): …` 再推）。

1. `fix(ui): 登录跳转按 origin 判定，关闭反斜杠开放重定向`（F3 + 回归用例）
2. `fix(api): dataName/fileName 出口统一编码，修复 CRLF 记录 /data 恒 500`（F5）
3. `fix(api): PATCH version / PUT size 复用 int32 与安全整数校验`（F6）
4. `fix(security): 认证失败限速与失败计数`（F7，含 README 硬性要求）
5. `fix(security): 加 HSTS 与明文跳转`（F8）
6. `fix(ui): 状态变更端点来源判定 + batch-delete Content-Type 校验`（F4）
7. `fix(api): multipart/体量/zip/队列四类封顶`（F9）
8. `fix(cleanup): 预算感知分阶段兜底 + 失败可观测 + 硬删批量对齐产生速率`（F11）
9. `test(ui): 遍历 /ui/api/* 断言未带凭据一律 401`（防 guard 注册顺序静默失效，评审建议；**变异实验已证**：把 `use` 下移或收窄作用域会让它变红，而在 `app` 上追加新路由仍是 401 —— 本命名空间对新路由默认 fail-closed）

运维动作（不在提交内）：**F1 轮换线上口令**。

---

## 四、范围边界（明确不做）

- 不改动与上游一致的语义（软删保留期、客户端可控 version/lastModified 的部分更新语义）——这些属"镜像上游"，单边偏离会造成客户端行为分歧。
- 不在本计划内引入服务端会话存储（与 ADR D13 冲突）。
- 不修改上游仓库；上游侧问题见 `docs/upstream-issues.md`。

---

## 五、验证方法（复用审计探针，可复跑）

```bash
# 每条修复的判别实验（本地实例需先 npm run dev）
# 注意：F7/F8 的翻转**不能**用这些本地探针证明 —— loopback 有意豁免限速与 https 升级，
#       它们的证据是 test/rate-limit.test.ts（用 sync.example.com + 显式 cf-connecting-ip 驱动）。
#       可用本地探针做翻转的只有 F5（CRLF/NUL 的 /data）与 F6（version/size 校验）。
node .audits/cfserver-audit-003/probes/lead-agent/lead-verify.mjs    # F2/F3/F4/F6/F7/F10
node .audits/cfserver-audit-003/probes/lead-agent/lead-verify2.mjs   # F8
node .audits/cfserver-audit-003/probes/lead-agent/lead-verify5.mjs   # F5（含正常名对照）
python -B .audits/cfserver-audit-003/probes/lead-agent/check-residue.py   # 残留复核（D1 直读）
```

修复后按 §4.7 要求应证明**原 Finding 消失**：复跑上述探针，预期从"复现"翻转为"未复现"，且正常路径行为不变；F11 需另按 §二·F11 的验收条件构造积压实测收敛。
