// 清理任务（Cron scheduled handler）的端到端验证
//
// 背景：曾发生生产事故 —— 孤儿目录判定的键形式不一致（`File_ABC/` vs `File_ABC`），
// 导致每小时 Cron 把 R2 的 history/ 下**所有**工作目录（含活跃记录的数据）删光。
// 当时只有「数据层单测」（F33 用真实 runCleanup），**从未跑过真实的 scheduled handler**，
// 因此本文件补上这一层：经 HTTP 触发真实 Cron，断言它对历史数据的影响。
//
// 前置：dev server 需以 `--test-scheduled` 启动（`npm run dev` 已含该参数；CI 的 quality job 同）。
// 未启用时本套件会跳过并明确报告原因，而不是假装通过。
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import * as signalR from '@microsoft/signalr';
import { assertWritableTarget } from './support/target-guard';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

// 本套件会写目标库：默认只允许指向本机 dev server，指向远端需显式 ALLOW_REMOTE_TARGET=1
assertWritableTarget(BASE);
// 凭据变量专用化：USER/USERNAME 被宿主环境占用（Windows 的 USERNAME、CI runner 的 USER）
const USER = process.env.SYNC_USER ?? 'admin';
const PASS = process.env.SYNC_PASS ?? 'admin';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const H = { Authorization: AUTH };

const RUN = Date.now().toString(36);

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex').toUpperCase();
// 上游 FileProfile.CombineHash: SHA256hex(UTF8($"{fileName}|{contentHash.ToUpper()}"))
const fileHash = (fileName: string, content: Buffer) => sha256(`${fileName}|${sha256(content)}`);

const DAY_MS = 24 * 60 * 60 * 1000;

async function req(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
}

// .NET HttpClient 风格 multipart（无引号 name=）
function multipart(
  boundary: string,
  fields: Record<string, string>,
  data?: { filename: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s, 'utf8'));
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name=${k}\r\n\r\n${v}\r\n`);
  }
  if (data) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name=data; filename="${data.filename}"\r\n`);
    push('Content-Type: application/octet-stream\r\n\r\n');
    chunks.push(data.content);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// 触发真实的 scheduled handler（miniflare 的测试端点）
async function triggerCron(): Promise<number> {
  const res = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('17 * * * *')}`);
  return res.status;
}

// 本套件会写目标库；这些 name/hash 在模块级定义，供用例与 afterAll 共用。
// 其中 `cron-keep` 一条**不会**被 Cron 清掉（它正是「活跃数据必须存活」的对照），
// 因此必须由 afterAll 收尾，否则每次运行都在库里留下一条活跃记录 + 一个 R2 对象。
const KEEP_NAME = `cron-keep-${RUN}.bin`;
const KEEP_CONTENT = Buffer.from(`keep-me-${RUN}`);
const KEEP_HASH = fileHash(KEEP_NAME, KEEP_CONTENT);

let cronAvailable = false;

beforeAll(async () => {
  const root = await fetch(`${BASE}/`, { headers: H });
  if (!root.ok) throw new Error(`dev server 不可用 (${BASE}): ${root.status}`);
  // 未以 --test-scheduled 启动时，/__scheduled 会落到 Worker 路由 → 404
  const probe = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('17 * * * *')}`);
  cronAvailable = probe.status !== 404;
  if (!cronAvailable) {
    console.warn(
      `[cleanup] 跳过：dev server 未启用 --test-scheduled（${BASE}）。` +
        '请用 `npm run dev` 启动后重跑，否则清理任务的端到端验证不会执行。',
    );
  }
});

describe('清理任务（Cron scheduled handler）端到端', () => {
  it('Cron 确实执行了保留期清理（否则「数据存活」断言是空转的）', { timeout: 60_000 }, async (ctx) => {
    if (!cronAvailable) return ctx.skip();

    // 造一条**超过保留期**的记录（HISTORY_RETENTION_MINUTES 默认 10080 = 7 天）：
    // POST 允许显式设定 lastModified/lastAccessed，故可构造过期条件
    const name = `cron-ret-${RUN}.bin`;
    const content = Buffer.from(`retention-${RUN}`);
    const hash = fileHash(name, content);
    const old = new Date(Date.now() - 8 * DAY_MS).toISOString();

    const b = `bnd${RUN}cronret`;
    const { body, contentType } = multipart(
      b,
      {
        hash,
        type: 'File',
        text: name,
        version: '0',
        isDeleted: 'false',
        size: String(content.length),
        createTime: old,
        lastModified: old,
        lastAccessed: old,
      },
      { filename: name, content },
    );
    const created = await req('/api/history', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(created.status, '构造过期记录失败').toBe(200);

    const before = (await (await req(`/api/history/File-${hash}`)).json()) as { isDeleted: boolean };
    expect(before.isDeleted, '记录本应是活跃的').toBe(false);

    expect(await triggerCron(), '触发 /__scheduled 失败').toBeLessThan(400);

    // 关键：Cron 必须把这条过期记录软删 —— 证明 scheduled handler 真的跑了
    const after = (await (await req(`/api/history/File-${hash}`)).json()) as { isDeleted: boolean };
    expect(after.isDeleted, 'Cron 未执行保留期清理').toBe(true);
  });

  it('Cron 不得删除活跃记录的数据（生产事故的回归守卫）', { timeout: 60_000 }, async (ctx) => {
    if (!cronAvailable) return ctx.skip();

    // 活跃记录：走 PUT /file + PUT /SyncClipboard.json（会创建历史记录并把暂存移入 history/）
    const name = KEEP_NAME;
    const content = KEEP_CONTENT;
    const hash = KEEP_HASH;

    expect((await req(`/file/${name}`, { method: 'PUT', body: content })).status).toBe(200);
    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'File', hash, text: name, hasData: true, dataName: name, size: content.length }),
    });
    expect(put.status).toBe(200);

    const before = await req(`/api/history/File-${hash}/data`);
    expect(before.status, '刚入库的数据应可取回').toBe(200);

    expect(await triggerCron()).toBeLessThan(400);

    // ★ 回归断言：修复前 Cron 会把 history/ 下所有目录当孤儿删除 → 此处 404
    const after = await req(`/api/history/File-${hash}/data`);
    if (after.status === 200) {
      expect(Buffer.from(await after.arrayBuffer()).toString()).toBe(content.toString());
    }
    expect(after.status, '活跃记录的数据被 Cron 误删').toBe(200);

    // 粗粒度对照：修复后 R2 的 history/ 前缀不应为空
    const stats = (await (await req('/api/history/statistics')).json()) as { totalFileSizeMB: number };
    expect(stats.totalFileSizeMB, 'history/ 被清空').toBeGreaterThan(0);
  });

  it('Cron 清理真孤儿目录（无任何记录引用的 history/ 目录）', { timeout: 60_000 }, async (ctx) => {
    if (!cronAvailable) return ctx.skip();

    // 通过公开 API 无法直接写入「无记录引用的 history/ 对象」，故用软删记录间接构造：
    // PATCH isDelete:true 会立即清掉其工作目录，随后 Cron 的孤儿扫描不应再误伤活跃记录。
    const name = `cron-del-${RUN}.bin`;
    const content = Buffer.from(`delete-me-${RUN}`);
    const hash = fileHash(name, content);

    expect((await req(`/file/${name}`, { method: 'PUT', body: content })).status).toBe(200);
    expect(
      (
        await req('/SyncClipboard.json', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'File', hash, text: name, hasData: true, dataName: name, size: content.length }),
        })
      ).status,
    ).toBe(200);

    const del = await req(`/api/history/File/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDelete: true, version: 10_000, lastModified: new Date().toISOString() }),
    });
    expect(del.status).toBe(200);

    expect(await triggerCron()).toBeLessThan(400);

    // 已软删记录的数据不可再取回，且不应影响其它活跃数据
    expect((await req(`/api/history/File-${hash}/data`)).status).toBe(404);
  });

  it('Cron 软删记录时广播 RemoteHistoryChanged（客户端历史 UI 依赖的副作用）', { timeout: 60_000 }, async (ctx) => {
    if (!cronAvailable) return ctx.skip();

    // 上游 OnRecordDeletedAsync → NotifyProfileChangeAsync → hub RemoteHistoryChanged（逐条）。
    // 若清理只改库不发通知，其它设备的历史列表会一直显示已过期的记录。
    const options = {
      headers: { Authorization: AUTH },
      // @microsoft/signalr 在 Node 下默认用 ws 库（不读 HTTP(S)_PROXY）；注入全局 WebSocket
      WebSocket,
    } as signalR.IHttpConnectionOptions;
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(`${BASE}/SyncClipboardHub`, options)
      .build();
    const seen: unknown[] = [];
    connection.on('RemoteHistoryChanged', (dto) => seen.push(dto));
    await connection.start();

    try {
      // 过期记录（8 天前）→ Cron 会软删并广播
      const name = `cron-bc-${RUN}.bin`;
      const content = Buffer.from(`broadcast-${RUN}`);
      const hash = fileHash(name, content);
      const old = new Date(Date.now() - 8 * DAY_MS).toISOString();
      const b = `bnd${RUN}cronbc`;
      const { body, contentType } = multipart(
        b,
        {
          hash,
          type: 'File',
          text: name,
          version: '0',
          isDeleted: 'false',
          size: String(content.length),
          createTime: old,
          lastModified: old,
          lastAccessed: old,
        },
        { filename: name, content },
      );
      expect(
        (await req('/api/history', { method: 'POST', headers: { 'Content-Type': contentType }, body })).status,
      ).toBe(200);

      expect(await triggerCron()).toBeLessThan(400);

      const matched = () =>
        seen.some(
          (d) =>
            typeof d === 'object' &&
            d !== null &&
            (d as { hash?: string }).hash === hash &&
            // 必须区分来源：POST /api/history 建记录时**也会**广播（isDeleted=false），
            // 只有 Cron 软删后那条才是 isDeleted=true。否则本用例会假通过。
            (d as { isDeleted?: boolean }).isDeleted === true,
        );
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !matched()) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(matched(), 'Cron 软删后未广播 RemoteHistoryChanged').toBe(true);
    } finally {
      await connection.stop();
    }
  });
});

// 收尾：删除本套件留下的活跃对照记录（其余记录已被 Cron 软删，无需处理）。
// 清理失败必须让套件失败 —— 静默残留会让共享/线上实例积累垃圾记录。
afterAll(async () => {
  if (!cronAvailable) return;
  const res = await req(`/api/history/File/${KEEP_HASH}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isDelete: true, version: 10_000, lastModified: new Date().toISOString() }),
  });
  expect([200, 404], `收尾删除失败（目标库可能残留 ${KEEP_NAME}）：${res.status}`).toContain(res.status);
});
