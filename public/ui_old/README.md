# `public/ui_old/` — V1 界面（备用）

默认界面是 V2（`/ui/app/`）。这里是 V1，用作"V2 在某个环境下不可用"时的回退；
2026-09-17 起它重新纳入维护（此前是冻结存档）。

## 挂载点

| 面 | 路径 |
|---|---|
| 页面与静态资源 | `/ui_old/...` |
| 服务端接口 | `/ui/api/...`（与 V2 共用，**不是** `/ui_old/api/...`） |
| 文案表 | `/ui/js/messages.js`（**与 V2 共用同一份**，2026-09-18 起；跨目录依赖只此一处，守卫见 `test/ui-guard.test.ts`） |

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
