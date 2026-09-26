import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 审计证据工件（判别性探针）不是产品测试：它们断言的是被审计快照（pre-fix）的行为，
    // 修复后按设计会失败。保留原件供复核，但不纳入产品测试套件。
    // ⚠️ 2026-09-26：`.audit-forms/` 是**点目录**，vitest 的 include 仍会扫到它（实测全量套件多出
    // 1 个文件 / 2 条必然失败的用例，见 `progress.md` §188）⇒ 两处都必须显式排除。
    exclude: ['**/node_modules/**', '**/dist/**', '**/.audits/**', '**/.audit-forms/**'],
    // 本仓库多数套件是**集成测试**（对真实服务器发 HTTP/SignalR）。默认 5s 只适配纯逻辑套件：
    // 指向本地 dev server 时够用，但本机需经 HTTP 代理访问远端边缘时单请求需 0.5–2.5s，
    // 多请求用例会以 'Test timed out in 5000ms' 的假失败结束（与实现无关）。
    // 取 30s 保留有界失败信号（真挂住仍会失败），同时容纳代理延迟；
    // 纯逻辑套件（hash/serialization）实测 <200ms，不受影响。
    testTimeout: 30_000,
  },
});
