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

// 触发真实的 scheduled handler（miniflare 的测试端点）。
// ⚠️ 响应体必须**读掉**：`/__scheduled` 是本套件里唯一「服务端工作在响应之后还在继续」的端点
// （scheduled handler 走 `ctx.waitUntil`），不排空时这条连接在 undici 侧一直不算完。
// 2026-09-20 实测：整套跑时偶发的 `Error inside ProxyWorker … Network connection lost`（500，
// 且服务端**没有**该请求的日志行）两次都落在它之后的第一个请求上。这里按"排空"写 ——
// 但**这不代表已证因果**（隔离跑 7/7 通过、cron→POST 序列 10/10 通过）：证据与判据见
// `docs/progress.md` §95.8 的那条注。
async function triggerCron(): Promise<number> {
  const res = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('17 * * * *')}`);
  await res.text();
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
  await root.text(); // 排空（理由见 triggerCron 上方那段）
  if (!root.ok) throw new Error(`dev server 不可用 (${BASE}): ${root.status}`);
  // 未以 --test-scheduled 启动时，/__scheduled 会落到 Worker 路由 → 404
  const probe = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('17 * * * *')}`);
  await probe.text(); // 排空（理由见 triggerCron 上方那段）
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

    // 前提必须是**自足的**：env 的保留期自 2026-09-22 起是 0 = 不限制（wrangler.toml 对齐上游 3.3.0），
    // 不写覆盖就跑这条，保留期阶段什么都不做 ⇒ "Cron 未执行保留期清理"（2026-09-22 实测踩到）。
    // 这里显式写一条**很小的 Meta 覆盖**（保留 10 分钟）+ 压住 trim（1,000,000），
    // 让"删掉这条 8 天前的记录"这件事**只能**来自保留期阶段；`afterAll` 会清掉这两个覆盖键。
    // POST 允许显式设定 lastModified/lastAccessed，故可构造过期条件
    const pin = await putSettings({ retentionMinutes: 10, maxSavedHistoryCount: 1_000_000 });
    expect(pin.status, '压住 trim + 开保留期覆盖失败').toBe(200);

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

    // 自清：把本用例写的覆盖键清掉 —— 否则后面「保留策略在线可调」里"未提供的字段 = env"的断言
    // 会读到本用例留下的 Meta 覆盖而误红（两个 describe 的用例交错执行，afterAll 只跑在最后）。
    const clean = await putSettings({ retentionMinutes: null, maxSavedHistoryCount: null });
    expect(clean.status, '清理本用例的覆盖键失败').toBe(200);
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

  it('Cron 不得误删**回收站记录**的数据（真回收站：软删保留数据）', { timeout: 60_000 }, async (ctx) => {
    if (!cronAvailable) return ctx.skip();

    // 2026-09-22（ADR D29）之前这条用例是用"软删记录"当**真孤儿**来构造的（那时软删会立刻清目录）。
    // 改成真回收站之后软删**保留**数据，而"无记录引用的目录"已经无法通过公开 API 构造
    // （彻底删除会连目录一起扫、30 天硬删也会）—— 于是这条改成守新契约：
    // 软删（进回收站）之后，数据的**唯一**风险就是被孤儿阶段当成无人引用而删掉，
    // 所以这里跑一轮真实的 Cron，断言数据仍在、且能原样取回。
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
    expect(del.status, '软删（进回收站）').toBe(200);

    expect(await triggerCron()).toBeLessThan(400);

    // 回收站里这条记录的数据必须还在（被孤儿阶段删掉就是"行还在、数据没了"）
    const after = await req(`/api/history/File-${hash}/data`);
    expect(after.status, '回收站记录的数据被 Cron 当孤儿删了').toBe(200);
    expect(Buffer.from(await after.arrayBuffer()).toString(), '取回的字节必须原样').toBe(content.toString());

    // 且它仍然可恢复（真回收站：连数据一起回来）
    const restore = await req(`/api/history/File/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDelete: false, version: 20_000, lastModified: new Date().toISOString() }),
    });
    expect(restore.status, '带数据文件的回收站记录必须能恢复（上游那条守卫已去掉）').toBe(200);
    const restored = (await (await req(`/api/history/File-${hash}`)).json()) as { isDeleted: boolean };
    expect(restored.isDeleted, '恢复后回到活跃列表').toBe(false);
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
      // 过期记录（8 天前）→ Cron 会软删并广播。前提必须自足（env 保留期 = 0 = 不限制）：
      // 显式写保留 10 分钟的覆盖 + 压住 trim，让这条记录的软删**只能**来自保留期阶段；
      // 用例末尾自清（后面的用例假设"未提供的字段 = env"）。
      const pin = await putSettings({ retentionMinutes: 10, maxSavedHistoryCount: 1_000_000 });
      expect(pin.status, '开保留期覆盖 + 压 trim 失败').toBe(200);
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
      // 自清本用例的覆盖键（理由见用例开头注释；afterAll 也会再清一次，这里双保险）
      await putSettings({ retentionMinutes: null, maxSavedHistoryCount: null }).catch(() => {});
    }
  });
});

// ===== 保留策略在线可调（docs/backend-gaps.md §2.5）=====
//
// 覆盖写：PUT /ui/api/settings（受守卫，走本套件的 Basic 凭据）。
async function putSettings(body: Record<string, unknown>) {
  return req('/ui/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 保留策略响应（GET/PUT 同形）
interface SettingsRetention {
  retentionMinutes: number | null;
  maxSavedHistoryCount: number | null;
  retentionSource: string;
  maxCountSource: string;
}

// 响应体是**外部输入**（HTTP JSON），故按契约逐字段判形状再取值，而不是裸 `as` 断言后直接用 ——
// 形状不符会在这里直接失败（顺带也是一条契约断言：四个键必须齐、两个值必须是数字或 null）。
function isSettingsRetention(v: unknown): v is SettingsRetention {
  if (typeof v !== 'object' || v === null) return false;
  if (
    !('retentionMinutes' in v && 'maxSavedHistoryCount' in v && 'retentionSource' in v && 'maxCountSource' in v)
  ) {
    return false;
  }
  const numOrNull = (x: unknown): boolean => x === null || (typeof x === 'number' && Number.isFinite(x));
  return (
    numOrNull(v.retentionMinutes) &&
    numOrNull(v.maxSavedHistoryCount) &&
    typeof v.retentionSource === 'string' &&
    typeof v.maxCountSource === 'string'
  );
}

function isSettingsBody(v: unknown): v is { retention: SettingsRetention } {
  return typeof v === 'object' && v !== null && 'retention' in v && isSettingsRetention(v.retention);
}

async function readSettingsBody(res: Response): Promise<SettingsRetention> {
  const raw: unknown = await res.json();
  if (!isSettingsBody(raw)) throw new Error(`/ui/api/settings 响应形状不符：${JSON.stringify(raw)}`);
  return raw.retention;
}

// 造一条**8 天前**的记录（时间戳对保留期/裁剪判定都构成"过期候选"；env 的保留期现在是 0 = 不限制，
// 但 trim 的排序口径 MAX(LastModified, LastAccessed) 同样吃它），返回它的 hash。
// POST /api/history 允许显式给出时间戳，故可构造过期条件。
async function createExpiredRecord(label: string): Promise<string> {
  const name = `${label}-${RUN}.bin`;
  const content = Buffer.from(`${label}-${RUN}`);
  const hash = fileHash(name, content);
  const old = new Date(Date.now() - 8 * DAY_MS).toISOString();
  const b = `bnd${RUN}${label}`;
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
  expect(created.status, `构造过期记录失败（${name}）`).toBe(200);
  return hash;
}

// 单条记录是否已被软删（走协议单条端点，与既有用例同口径）。
// 同样按外部输入处理：先判形状再取值，避免把一个裸断言直接当数据用。
async function isDeleted(hash: string): Promise<boolean> {
  const res = await req(`/api/history/File-${hash}`);
  expect(res.status, `读取记录失败（${hash}）`).toBe(200);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('isDeleted' in body) || typeof body.isDeleted !== 'boolean') {
    throw new Error(`/api/history 单条响应缺少 isDeleted：${JSON.stringify(body)}`);
  }
  return body.isDeleted;
}

// 收尾软删自己造的记录（已删/已硬删都容忍：前者是幂等重删，后者只可能发生在 30 天后）
async function softDeleteRecord(hash: string): Promise<void> {
  const res = await req(`/api/history/File/${hash}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isDelete: true, version: 10_000, lastModified: new Date().toISOString() }),
  });
  expect([200, 404], `收尾软删失败（${hash}）：${res.status}`).toContain(res.status);
}

// 收尾：Meta 覆盖必须清干净。留着覆盖会让实例的**真实** Cron 按测试值跑
// （retentionMinutes=0 会一直关掉保留期清理）——这是比残留记录更危险的残留。
afterAll(async () => {
  const res = await putSettings({ retentionMinutes: null, maxSavedHistoryCount: null });
  expect(res.status, '收尾清除保留策略覆盖失败').toBe(200);
});

describe('保留策略在线可调（GET/PUT /ui/api/settings 与 Cron 的联动）', () => {
  it('覆盖值对 Cron 生效，清除覆盖回落 env（同一条记录两次 Cron 对照）', { timeout: 90_000 }, async (ctx) => {
    if (!cronAvailable) return ctx.skip();

    // 覆盖取「更宽」的值（保留期上界 1 年、条数上限极大）：这样两种策略对下面这条 8 天前的记录
    // 给出**相反**的结论（env 必删 / 覆盖必留），而不会像「设一个很小的保留期」那样把实例上
    // 所有更旧的记录一并软删（本机活跃 1000+ 条）——测试不能以破坏共享实例为代价换区分度。
    // 条数上限必须同时压住：活跃数超过 env 的 1000，trim 阶段会从最旧的非收藏记录开始删，
    // 而这条 8 天前的记录正是最旧的 —— 不压住 trim 就分不清是哪个阶段删的。
    const pinCount = await putSettings({ maxSavedHistoryCount: 1_000_000 });
    expect(pinCount.status, '压住条数上限失败').toBe(200);
    const pinned = await readSettingsBody(pinCount);
    expect(pinned.maxCountSource).toBe('meta');
    expect(pinned.maxSavedHistoryCount).toBe(1_000_000);
    // 只改一个字段：另一个字段必须仍是 env（缺省 = 不改动）
    expect(pinned.retentionSource, '未提供的字段被改动了').toBe('env');

    const applied = await putSettings({ retentionMinutes: 525_600 });
    expect(applied.status).toBe(200);
    const retention = await readSettingsBody(applied);
    expect(retention.retentionMinutes).toBe(525_600);
    expect(retention.retentionSource).toBe('meta');
    expect(retention.maxCountSource, '前一次的条数覆盖被覆盖掉了').toBe('meta');

    const hash = await createExpiredRecord('cron-meta');
    expect(await triggerCron(), '触发 /__scheduled 失败').toBeLessThan(400);
    expect(await isDeleted(hash), 'Meta 覆盖未生效：记录按 env 的 7 天被软删').toBe(false);

    // 清除保留期覆盖（条数上限仍压着）→ 回落 env。**env 的保留期自 2026-09-22 起是 0 = 不限制**
    // （wrangler.toml 默认值已对齐上游 3.3.0）⇒ 清除后**没有**任何按时间的清理会删这条 8 天前的记录：
    // 这里断言的是"回落真的到了 env（且值 = 0）"，而不是"清除后记录被删"（那是 env=10080 时代的旧前提）。
    // 「保留期阶段确实能删过期记录」的证明在 `cleanup-budget.test.ts`（真实 runCleanup，可精确摆布 env）。
    const cleared = await putSettings({ retentionMinutes: null });
    expect(cleared.status).toBe(200);
    const fallback = await readSettingsBody(cleared);
    expect(fallback.retentionSource).toBe('env');
    expect(fallback.retentionMinutes, 'env 回落值应与 wrangler.toml 的默认一致（0 = 不限制）').toBe(0);
    expect(fallback.maxCountSource, '清除一个字段时另一个被连带清除了').toBe('meta');

    expect(await triggerCron()).toBeLessThan(400);
    expect(await isDeleted(hash), 'env 保留期 = 0 ⇒ 不应被按时间软删（清除覆盖回到"不限制"）').toBe(false);
  });

  it('覆盖值 0 = 关闭该阶段，绝不被当成非法值回落默认（回归守卫）', { timeout: 90_000 }, async (ctx) => {
    if (!cronAvailable) return ctx.skip();

    // 0 是**合法**覆盖值（关闭保留期清理）。若实现把它当非法值回落默认（现为 0 = 不限制，
    // 曾是 10080 = 7 天），这条 8 天前的记录会被软删 —— 用户的「别清理」会静默变成「按默认清理」。
    // 同时压住 trim（同上一条的理由），使唯一的删除来源只剩保留期阶段。
    const applied = await putSettings({ retentionMinutes: 0, maxSavedHistoryCount: 1_000_000 });
    expect(applied.status).toBe(200);
    const retention = await readSettingsBody(applied);
    expect(retention.retentionMinutes).toBe(0);
    expect(retention.retentionSource).toBe('meta');

    const hash = await createExpiredRecord('cron-zero');
    expect(await triggerCron()).toBeLessThan(400);
    expect(await isDeleted(hash), 'retentionMinutes=0 未关闭保留期阶段：过期记录被软删了').toBe(false);

    await softDeleteRecord(hash);
  });

  it('PUT 的取值校验：415 / 400 分支（受守卫端点，走已认证请求）', async () => {
    // 非 JSON content-type → 415（跨站表单能不经预检发出 PUT，必须挡在解析之前）
    const wrongType = await req('/ui/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"retentionMinutes":0}',
    });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ error: 'unsupported_media_type' });

    // 非法 JSON 体，以及「合法 JSON 但字段非法」的全部形态 —— 一律 400 invalid_request。
    // 注意 null 不在此列：它是合法的「清除覆盖」（已在上面的用例里覆盖）。
    const bodies = [
      '{',
      JSON.stringify({ retentionMinutes: -1 }),
      JSON.stringify({ retentionMinutes: 1.5 }),
      JSON.stringify({ retentionMinutes: 525_601 }),
      JSON.stringify({ retentionMinutes: '30' }),
      JSON.stringify({ maxSavedHistoryCount: 1_000_001 }),
      JSON.stringify({}),
    ];
    for (const body of bodies) {
      const res = await req('/ui/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status, `body=${body}`).toBe(400);
      expect(await res.json(), `body=${body}`).toEqual({ error: 'invalid_request' });
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
