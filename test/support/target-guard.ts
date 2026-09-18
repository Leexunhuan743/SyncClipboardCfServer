// 写库套件的目标守卫
//
// 这些套件会**写目标库**：创建历史记录、上传/删除 R2 对象、触发清理等。默认只允许指向本机
// dev server；若要把它们指向共享或线上实例，必须显式设置 ALLOW_REMOTE_TARGET=1。
//
// 为什么需要硬守卫而不是只靠自觉：本仓库曾多次在收尾时把黑盒套件指向线上实例，留下数十条
// 记录与已被清理的数据目录（其中一批记录的 lastModified 落在未来，连 PATCH 都删不掉，
// 只能等 ~34 天后由硬删任务回收）。加一行守卫比给每个套件补 afterAll 更便宜，且能防复发。
//
// 只读/纯逻辑套件（hash、fixes）不经 HTTP，无需调用本函数。
export function assertWritableTarget(base: string): void {
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    host = '';
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
  if (localHosts.has(host)) return;
  if (process.env.ALLOW_REMOTE_TARGET === '1') return;

  throw new Error(
    `拒绝把写库套件指向非本机目标：${base}\n` +
      '  这些套件会创建/删除历史记录与 R2 对象，误指线上会留下难以回收的残留。\n' +
      '  确认目标是一次性/可丢弃实例后，用 ALLOW_REMOTE_TARGET=1 显式放行：\n' +
      `    ALLOW_REMOTE_TARGET=1 BASE=${base} npx vitest run <此文件>`,
  );
}
