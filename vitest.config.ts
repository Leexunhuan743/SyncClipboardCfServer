import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .audits/ 下的是**审计证据工件**（判别性探针），不是产品测试：
    // 它们断言的是被审计快照（pre-fix）的行为，修复后按设计会失败。
    // 保留原件供复核，但不纳入产品测试套件。
    exclude: ['**/node_modules/**', '**/dist/**', '**/.audits/**'],
  },
});
