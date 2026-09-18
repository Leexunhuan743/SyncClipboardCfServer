# `public/ui_old/` — V1 界面（**默认界面**）

2026-09-18 起它是默认界面：站点根 `GET /` 的浏览器分支与 `/ui/` 的目录索引**都**指向这里
（守卫见 `test/ui-guard.test.ts` 的「默认界面的入口链一致」）。V2（`public/ui/`，本体在
`/ui/app/`）降为**开发测试版** —— 仓库维护者做实验的地方，进去后顶栏与登录页都标着
"开发测试版"。

它 2026-09-17 起重新纳入维护（此前是冻结存档），2026-09-18 起接手默认入口。

> **为什么默认界面的 URL 是 `/ui_old/` 而不是 `/ui/`**：V2 的资源挂在 `/ui/js|css/*` 下
> （它的页面里写的是绝对路径），把 V1 搬到 `/ui/` 就得同时改写 V1 的全部资源前缀 ——
> 2026-09-15 的改名事故已经付过一次学费。物理目录名保持历史原样，**变的只是入口**。

## 挂载点

| 面 | 路径 |
|---|---|
| 页面与静态资源 | `/ui_old/...`（完全自包含，无任何对 `/ui/` 的跨目录依赖） |
| 服务端接口 | `/ui/api/...`（服务端统一 API 命名空间，**不是** `/ui_old/api/...`） |

## 怎么验证

需要本地 dev server（`npm run dev`）：

```bash
node test/manual/probe-ui-old.mjs                    # 读真实 DOM 的值（只读）
node test/manual/probe-ui-old.mjs --width 390 --height 844
node test/manual/probe-ui-old.mjs --width 1024 --coarse   # 触屏模拟：量行内操作的命中区与间距
node test/manual/probe-ui-old.mjs --shots .shots     # 顺带出图
node test/manual/probe-ui-old.mjs --write            # 会写：收藏开关来回切一次（状态净零）
```

> 手动脚本一律显式给 `--port`（默认端口与其它探针/`states.mjs` 有重合，撞上残留浏览器会量到
> 另一个页面的状态，得到假结论；详见 `docs/progress.md` §62.6）。

## 已知边界

- 正文单行截断，全文在预览里看。
- 窄屏（≤560px）不显示「每页条数」。
- 没有列显示开关与多列排序。

## 详细文档

- 界面契约、模块划分与验证记录：[`docs/ui.md`](../../docs/ui.md)
- 2026-09-17 这轮的改动与实测数字：[`docs/progress.md`](../../docs/progress.md) §53
- 2026-09-17 的**生产级完善**（顶栏实时状态、统计条重排、表格密度、部署信息分段、
  未来时间戳修复等）：[`docs/progress.md`](../../docs/progress.md) §54
- 前端要点清单（关注点 / 判据 / 落地建议）：[`docs/frontend-checklist.md`](../../docs/frontend-checklist.md)
