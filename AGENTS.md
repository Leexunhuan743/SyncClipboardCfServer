# AGENTS.md — 在本仓库工作的最小契约

> 只保留真正会改变代码正确性、部署安全或兼容性的规则。项目现状不要复制到这里。
> 用户/部署说明看 `README.md`；架构决策看 `docs/design.md`；协议看 `docs/protocol.md`；界面看 `docs/ui.md`。

## 1. 工作方式

- 所有改动走独立 branch + PR，不直接改 `master`。
- 修改前读真实代码与相关测试；文档与代码冲突时，以代码/运行时事实为准并修正文档。
- 不为一次审计、一次修复或一次实验新增长期维护的审计报告/进度台账。结论进入现有权威文档，回归进入测试；过程留在 Git 历史和 PR。
- 不在多份文档复制可自动推导的数字或清单，例如测试套件数、资源文件数、代码行数、完整目录树。

## 2. 协议兼容

- 改协议路径、状态码、字段、序列化、哈希或 SignalR 行为时，先与上游 SyncClipboard 实现核对。
- 有意偏离只登记在 `docs/protocol.md` §10；不要另建第二份差异表。
- 兼容性结论必须有测试或真实 A/B 证据，不能只靠注释推断。

## 3. Cloudflare 与数据安全

- D1 新增列同时修改 `schema.sql` 与 `tools/migrate-d1.mjs`；`test/docs.test.ts` 会校验迁移与 schema 一致。
- 新增运行期开关时同步 `.dev.vars.example`、`.github/workflows/deploy.yml`、`README.md` 与 `wrangler.toml`；守卫只检查这类会直接影响部署的事实。
- `.dev.vars` 是本地凭据，永远不要提交。
- 写库测试默认只能指向 localhost；远端写入必须显式设置 `ALLOW_REMOTE_TARGET=1`。

## 4. Web UI

- 界面源码在 `web/`（TypeScript，esbuild 打包），构建产物是 `public/ui/`（不进仓库，**不要手改**）；构建由 `wrangler.toml` 的 `[build]` 钩子触发，本地改源码用 `npm run dev:web` 监听。
- 界面只有 `/ui/` 一个挂载点。改挂载点时必须一起检查 `wrangler.toml`（`run_worker_first`）、`src/index.ts`、`public/_headers` 与 `test/ui-guard.test.ts`。
- CSP 是 `script-src 'self'; style-src 'self'`：不写内联脚本/样式属性，不用 `innerHTML` 注入用户内容；守卫在 `test/ui-guard.test.ts`。
- 前端纯逻辑（`web/src/lib/`）的单元测试在 `web/test/`；视觉或交互改动除了测试，还要用 `test/manual/probe-ui.mjs` 至少检查一档桌面和一档窄屏。改了风格（`themes.css`）或带阴影的组件后，再跑 `test/manual/shadow-clip.mjs`（阴影被 `overflow` 祖先裁掉会非 0 退出）。

## 5. 完成条件

常规改动至少运行：

```bash
npm run typecheck
npm run lint
npm test
```

- 黑盒套件需要先启动 `wrangler dev --test-scheduled` 并初始化本地 D1。
- 改前端时再运行 `node test/manual/probe-ui.mjs`（需要本地 dev server）；未执行的验证必须在 PR 中明确写出。
- 不把“文档同步”扩张成维护历史过程；只更新仍承担当前事实的 README / design / protocol / ui 等文档。

## 6. 不要碰

- `.workbuddy/`：本地项目记忆。
- `.dev.vars`：本地凭据。
- 未经明确授权，不清理用户真实数据或把写库测试指向线上。

## 7. 历史资料

2026-10 的精简删除了已完成的 `AUDIT-*`、审计报告、实现计划、基线快照和 `progress-index.md`。
需要追溯时直接读 Git 历史；历史审计、进度台账和完成计划不再作为当前工作树的事实源。
