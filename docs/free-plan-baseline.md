# 自由计划适配工作流 · 基线记录（2026-09-25）

> 本文件是**一次性的基线快照**，不是现状口径文档：它记录 `perf/free-plan` 分支创建那一刻
> 的四条门禁读数。数字**不做等值断言**（`test/docs.test.ts` 也不把本文件纳入现状名单），
> 后续轮次请另起记录，不要"顺手校准"这里的历史数字。
>
> 本轮只做分支与门禁两件事，**未改动任何产品代码**。

## 1. 分支

| 项 | 值 |
|---|---|
| 分支名 | `perf/free-plan` |
| 起点 sha | `a5a12488744cb8a57a8843fee445406c6172f6f5` |
| 起点提交 | `a5a1248 docs: 修正 README 的 clone 地址（leeexx → Leexunhuan743）` |
| 建分支时 `git status --short --branch` 首行 | `## master...origin/master` |
| 建分支时 `origin/master` | `a5a12488744cb8a57a8843fee445406c6172f6f5`（与本地 `master` **同 sha，无领先/落后**） |

即：分支从与 `origin/master` 完全一致的 `master` 切出，工作区在建分支前为干净状态。

## 2. 四条门禁（全部按退出码判定，未经管道吞掉失败）

### 2.1 类型检查

```bash
node node_modules/typescript/bin/tsc --noEmit
```

- 退出码：**0**
- 输出：无（0 错）

### 2.2 静态检查

```bash
node node_modules/eslint/bin/eslint.js public/ui_v2/js public/ui_v1/js public/ui_shared/js test/manual
```

- 退出码：**0**
- 输出：无（0 告警）

### 2.3 `test/manual/*.mjs` 语法门

```bash
node --check test/manual/probe.mjs
node --check test/manual/probe-ui-v1.mjs
node --check test/manual/states.mjs
node --check test/manual/shoot.mjs
```

| 文件 | 退出码 |
|---|---|
| `probe.mjs` | **0** |
| `probe-ui-v1.mjs` | **0** |
| `states.mjs` | **0** |
| `shoot.mjs` | **0** |

### 2.4 全量套件

前置检查（本轮实测）：

- `tasklist | grep -i -E "workerd|wrangler"` → 无匹配（**同目录内没有第二个 wrangler dev**）；
- `netstat -ano | grep :8787` → 无 `LISTENING`；
- `.dev.vars` **已存在**（2710 字节，2026-09-21），未从 `.dev.vars.example` 复制，**未打印、未提交其内容**。

启动 dev server（后台，单实例）：

```bash
node node_modules/wrangler/bin/wrangler.js dev --test-scheduled --port 8787 --ip 127.0.0.1
```

就绪后执行（`BASE` 显式给本机 dev server，避免落到别的监听者）：

```bash
BASE=http://127.0.0.1:8787 node node_modules/vitest/vitest.mjs run --no-file-parallelism
```

- 退出码：**0**

汇总行**原文**：

```
 Test Files  22 passed (22)
      Tests  463 passed (463)
   Start at  14:07:39
   Duration  81.54s (transform 764ms, setup 0ms, collect 2.14s, tests 73.00s, environment 4ms, prepare 2.08s)
```

| 项 | 值 |
|---|---|
| 通过套件数 | 22 / 22 |
| 用例总数 | 463（全部通过，失败 0） |
| 失败数 | 0 |
| 总耗时 | 81.54s |

跑完**已停止** dev server：`hub` 报告 `Stopped wrangler-dev-freeplan: exited exit=1 uptime=2m6s`；
随后复查 `tasklist | grep -i -E "workerd|wrangler"` → **无匹配**（端口上仅剩 `TIME_WAIT` 套接字，无 `LISTENING`），进程确已退出。

## 3. 本机环境

| 项 | 值 |
|---|---|
| OS | Windows 10.0.26100（Windows 11 IoT Enterprise LTSC 2024，x64） |
| Shell | Git Bash |
| Node | `v24.18.0` |
| vitest | v2.1.9 |
| 时区/时刻 | 本地 14:07 起跑，UTC 2026-09-25T06:09:49Z |

## 4. 本轮未验证

- **无未验证项**：§2 的四条门禁（类型、lint、`node --check` ×4、全量套件）**全部跑完且退出码为 0**，
  没有中途中断、没有跳过、没有失败。
- 本轮**未**执行 AGENTS.md §2 第 5 条（改前端后用真实浏览器探针量一次）：**本轮不改任何前端代码**，
  该条不适用。
- 本轮**未**做 `git push`（推 `master` 会触发真实 Cloudflare 部署），也未执行任何写库/清理类操作。
- 本轮**未**运行 CI，未验证 `origin/master` 之外的远端状态。

## 5. 附注

- 另有一份审计文档由另一工作者产出，**未随本文件提交**（本提交只含 `docs/free-plan-baseline.md` 一个路径）。
- 未执行 `git add -A`；未触碰 `src/**`、`public/**`、`test/**`、`wrangler.toml`、`.dev.vars`、`.workbuddy/`、`qf-*` 夹具。
