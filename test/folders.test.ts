// 收藏夹（本站独有的界面功能）：数据层语义 + 真实 Hono 路由
//
// 不依赖 dev server：node:sqlite + 真 `schema.sql` + 真实 `createUiRoutes`（Basic 鉴权），全程进程内。
// 这里钉的是三个**产品承诺**，任何一个退化都是数据层面的事故：
//   ① 放进收藏夹的记录**不会被自动清理**（保留期 / 条数上限都跳过）；
//   ② 它**独立于星标**：官方客户端写 starred=false / 重传同一条记录，改不了它；
//   ③ 删除收藏夹时里面的记录**移出**（变回普通记录），不会连记录一起没。
import { describe, expect, it } from 'vitest';
import { HistoryDb, FOLDERS_MAX, normalizeFolderName } from '../src/db';
import { createUiRoutes } from '../src/ui/routes';
import { listUiHistory, parseUiHistoryQuery } from '../src/ui/query';
import { ProfileType } from '../src/types';
import type { HistoryRecordEntity } from '../src/types';
import type { Bindings } from '../src/env';
import { createSqliteD1, readSchemaSql } from './support/d1-sqlite';

const SCHEMA = readSchemaSql();
const DAY = 86_400_000;
const now = Date.now();
const AUTH = 'Basic ' + Buffer.from('admin:admin').toString('base64');

function makeEnv(): Bindings {
  return {
    DB: createSqliteD1(SCHEMA) as unknown as D1Database,
    R2: {} as unknown as R2Bucket,
    HUB: {} as unknown as DurableObjectNamespace,
    VERSION: 'test',
    MAX_SAVED_HISTORY_COUNT: '1000',
    HISTORY_RETENTION_MINUTES: '0',
    USERNAME: 'admin',
    PASSWORD: 'admin',
    UI_ENABLED: 'true',
  } as unknown as Bindings;
}

const record = (hash: string, opts: Partial<HistoryRecordEntity> = {}): HistoryRecordEntity => ({
  userId: 'default_user',
  type: ProfileType.Text,
  text: hash,
  size: hash.length,
  transferDataFile: '',
  filePaths: [],
  hash,
  createTime: now,
  lastAccessed: now,
  lastModified: now,
  stared: false,
  pinned: false,
  version: 0,
  isDeleted: false,
  ...opts,
});

async function call(env: Bindings, method: string, path: string, body?: unknown): Promise<Response> {
  const app = createUiRoutes();
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: AUTH, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

describe('名字规则', () => {
  it('去首尾空白、折叠连续空白；拒绝空名 / 控制字符 / 超长（按码点）', () => {
    expect(normalizeFolderName('  工作   资料 ')).toBe('工作 资料');
    expect(normalizeFolderName('')).toBeNull();
    expect(normalizeFolderName('   ')).toBeNull();
    expect(normalizeFolderName('a\u0007b')).toBeNull();
    expect(normalizeFolderName(42)).toBeNull();
    expect(normalizeFolderName('字'.repeat(30))).not.toBeNull();
    expect(normalizeFolderName('字'.repeat(31))).toBeNull();
    // 一个 emoji = 1 个码点（不是 2 个 UTF-16 码元）
    expect(normalizeFolderName('😀'.repeat(30))).not.toBeNull();
  });
});

describe('① 放进收藏夹的记录不会被自动清理', () => {
  it('保留期：过期的普通记录被软删，收藏夹里的同样过期的记录保留', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const old = now - 8 * DAY;
    const created = await db.createFolder('重要', now);
    const folderId = created.kind === 'ok' ? created.id : 0;
    await db.insert(record('PLAIN', { lastModified: old, lastAccessed: old }));
    await db.insert(record('KEPT', { lastModified: old, lastAccessed: old }));
    expect(await db.setFolder([{ type: ProfileType.Text, hash: 'KEPT' }], folderId)).toBe(1);

    const removed = await db.softDeleteExpiredRecords(now - 7 * DAY, now, 100);
    expect(removed.map((r) => r.hash)).toEqual(['PLAIN']);
    expect((await db.getByTypeAndHash(ProfileType.Text, 'KEPT'))!.isDeleted).toBe(false);
  });

  it('条数上限：裁剪只动不在收藏夹里的最旧记录', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const created = await db.createFolder('重要', now);
    const folderId = created.kind === 'ok' ? created.id : 0;
    await db.insert(record('A', { lastModified: now - 3000, lastAccessed: now - 3000 }));
    await db.insert(record('B', { lastModified: now - 2000, lastAccessed: now - 2000 }));
    await db.insert(record('C', { lastModified: now - 1000, lastAccessed: now - 1000 }));
    await db.setFolder([{ type: ProfileType.Text, hash: 'A' }], folderId); // 最旧的 A 进了收藏夹

    const trimmed = await db.trimToMaxCount(1, now);
    expect(trimmed.map((r) => r.hash)).toEqual(['B']); // 轮到次旧的 B，而不是 A
    expect((await db.getByTypeAndHash(ProfileType.Text, 'A'))!.isDeleted).toBe(false);
  });

  it('清理的候选字节估算与软删用同一个豁免条件（否则预算量的不是真正会被删的那一批）', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const created = await db.createFolder('重要', now);
    const folderId = created.kind === 'ok' ? created.id : 0;
    await db.insert(record('X1', { lastModified: now - 2000 }));
    await db.insert(record('X2', { lastModified: now - 1000 }));
    await db.setFolder([{ type: ProfileType.Text, hash: 'X1' }], folderId);
    const bytes = await db.scanSoftDeleteCandidateBytes(null, 100, 0);
    expect(bytes.length).toBe(1);
  });
});

describe('② 独立于星标，官方客户端改不掉', () => {
  it('客户端把 starred 写成 false（PATCH 路径）不影响收藏夹成员资格', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const created = await db.createFolder('重要', now);
    const folderId = created.kind === 'ok' ? created.id : 0;
    await db.insert(record('S', { stared: true }));
    await db.setFolder([{ type: ProfileType.Text, hash: 'S' }], folderId);

    await db.updateHistory(ProfileType.Text, 'S', { starred: false });
    const row = await db.getByTypeAndHash(ProfileType.Text, 'S');
    expect(row!.stared).toBe(false);
    expect(row!.folderId).toBe(folderId);
  });

  it('客户端重传同一条记录（整行覆盖写）不会清掉 FolderId', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const created = await db.createFolder('重要', now);
    const folderId = created.kind === 'ok' ? created.id : 0;
    const row = await db.insert(record('R'));
    await db.setFolder([{ type: ProfileType.Text, hash: 'R' }], folderId);

    // 客户端视角的整行更新：读到的实体里 folderId 可能是旧值 0（比如它在放进收藏夹之前读的）
    await db.updateEntity({ ...row, text: 'R', version: 1, folderId: 0 });
    expect((await db.getByTypeAndHash(ProfileType.Text, 'R'))!.folderId).toBe(folderId);
  });

  it('放进 / 移出收藏夹不改 Version 与 LastModified（不是一次内容变更，不该被别的设备当成要同步的更新）', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const created = await db.createFolder('重要', now);
    const folderId = created.kind === 'ok' ? created.id : 0;
    await db.insert(record('V', { version: 3, lastModified: now - 5000 }));
    await db.setFolder([{ type: ProfileType.Text, hash: 'V' }], folderId);
    await db.setFolder([{ type: ProfileType.Text, hash: 'V' }], 0);
    const row = await db.getByTypeAndHash(ProfileType.Text, 'V');
    expect(row!.version).toBe(3);
    expect(row!.lastModified).toBe(now - 5000);
  });
});

describe('③ 删除收藏夹：里面的记录移出，不删记录', () => {
  it('成员（含回收站里的）全部移出，记录本身都还在；之后普通清理照常处理它们', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    const old = now - 8 * DAY;
    const created = await db.createFolder('临时', now);
    const folderId = created.kind === 'ok' ? created.id : 0;
    await db.insert(record('M1', { lastModified: old, lastAccessed: old }));
    await db.insert(record('M2', { isDeleted: true }));
    await db.setFolder(
      [
        { type: ProfileType.Text, hash: 'M1' },
        { type: ProfileType.Text, hash: 'M2' },
      ],
      folderId,
    );

    const result = await db.deleteFolder(folderId);
    expect(result).toEqual({ kind: 'ok', moved: 2 });
    expect(await db.listFolders()).toEqual([]);
    expect((await db.getByTypeAndHash(ProfileType.Text, 'M1'))!.folderId).toBe(0);
    expect((await db.getByTypeAndHash(ProfileType.Text, 'M2'))!.folderId).toBe(0);

    // 不再受保护：过期的 M1 现在会被清理
    const removed = await db.softDeleteExpiredRecords(now - 7 * DAY, now, 100);
    expect(removed.map((r) => r.hash)).toEqual(['M1']);
  });

  it('删除不存在的收藏夹 ⇒ not_found，不动任何记录', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    await db.insert(record('Z'));
    expect(await db.deleteFolder(999)).toEqual({ kind: 'not_found' });
  });
});

describe('路由', () => {
  it('新建 / 改名 / 重名 409 / 上限 / 非法名 400', async () => {
    const env = makeEnv();
    const created = await call(env, 'POST', '/ui/api/folders', { name: '  工作  ' });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { id: number; folders: { id: number; name: string; count: number }[] };
    expect(body.folders).toEqual([{ id: body.id, name: '工作', sortOrder: 1, count: 0 }]);

    expect((await call(env, 'POST', '/ui/api/folders', { name: '工作' })).status).toBe(409);
    expect((await call(env, 'POST', '/ui/api/folders', { name: '' })).status).toBe(400);
    expect((await call(env, 'POST', '/ui/api/folders', {})).status).toBe(400);

    const renamed = await call(env, 'PATCH', `/ui/api/folders/${body.id}`, { name: '学习' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { folders: { name: string }[] }).folders[0]!.name).toBe('学习');
    expect((await call(env, 'PATCH', '/ui/api/folders/999', { name: 'x' })).status).toBe(404);
    expect((await call(env, 'PATCH', '/ui/api/folders/abc', { name: 'x' })).status).toBe(400);

    // 改名成别人的名字 ⇒ 409
    await call(env, 'POST', '/ui/api/folders', { name: '生活' });
    expect((await call(env, 'PATCH', `/ui/api/folders/${body.id}`, { name: '生活' })).status).toBe(409);

    // 上限
    for (let i = 0; i < FOLDERS_MAX; i++) await call(env, 'POST', '/ui/api/folders', { name: `f${i}` });
    expect((await call(env, 'POST', '/ui/api/folders', { name: '多出来的' })).status).toBe(400);
  });

  it('需要 application/json；未鉴权 401', async () => {
    const env = makeEnv();
    const app = createUiRoutes();
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const wrongType = await app.fetch(
      new Request('http://localhost/ui/api/folders', { method: 'POST', headers: { authorization: AUTH, 'content-type': 'text/plain' }, body: '{}' }),
      env,
      ctx,
    );
    expect(wrongType.status).toBe(415);
    const anon = await app.fetch(new Request('http://localhost/ui/api/folders', { method: 'POST', body: '{}' }), env, ctx);
    expect(anon.status).toBe(401);
  });

  it('batch-folder：放进 / 移出 / 目标不存在 404 / 非法条目 400；列表按 folder= 筛选，条目带 folderId；概览带收藏夹计数', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    await db.insert(record('H1'));
    await db.insert(record('H2'));
    await db.insert(record('H3', { isDeleted: true }));
    const created = (await (await call(env, 'POST', '/ui/api/folders', { name: '资料' })).json()) as { id: number };

    const items = [
      { type: 'Text', hash: 'H1' },
      { type: 'Text', hash: 'h2' }, // 大小写不敏感
      { type: 'Text', hash: 'H3' },
      { type: 'Text', hash: 'NOPE' },
    ];
    const put = await call(env, 'POST', '/ui/api/history/batch-folder', { items, folderId: created.id });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { updated: number; failed: number; folders: { count: number }[] };
    expect(putBody.updated).toBe(3);
    expect(putBody.failed).toBe(1);
    expect(putBody.folders[0]!.count).toBe(2); // 回收站里的 H3 不计入活跃条数

    // 列表筛选
    const list = await listUiHistory(env.DB, parseUiHistoryQuery(new URLSearchParams({ folder: String(created.id) })));
    expect(list.items.map((i) => i.hash).sort()).toEqual(['H1', 'H2']);
    expect(list.items.every((i) => i.folderId === created.id)).toBe(true);

    // 概览里带收藏夹
    const overview = (await (await call(env, 'GET', '/ui/api/overview?storage=0')).json()) as { folders: { id: number; name: string; count: number }[] };
    expect(overview.folders).toEqual([{ id: created.id, name: '资料', sortOrder: 1, count: 2 }]);

    // 移出（null）
    const out = await call(env, 'POST', '/ui/api/history/batch-folder', { items: [{ type: 'Text', hash: 'H1' }], folderId: null });
    expect(((await out.json()) as { updated: number }).updated).toBe(1);
    expect((await db.getByTypeAndHash(ProfileType.Text, 'H1'))!.folderId).toBe(0);

    // 目标不存在：不能让记录带着悬空 FolderId（永远豁免清理又谁也看不见）
    const missing = await call(env, 'POST', '/ui/api/history/batch-folder', { items: [{ type: 'Text', hash: 'H1' }], folderId: 12345 });
    expect(missing.status).toBe(404);
    expect((await db.getByTypeAndHash(ProfileType.Text, 'H1'))!.folderId).toBe(0);

    expect((await call(env, 'POST', '/ui/api/history/batch-folder', { items: [{ type: 'Nope', hash: 'H1' }], folderId: created.id })).status).toBe(400);
    expect((await call(env, 'POST', '/ui/api/history/batch-folder', { items: [], folderId: created.id })).status).toBe(400);
    expect((await call(env, 'POST', '/ui/api/history/batch-folder', { items, folderId: -1 })).status).toBe(400);
  });

  it('DELETE 收藏夹：记录移出并回报条数；非法 / 不存在的 id', async () => {
    const env = makeEnv();
    const db = new HistoryDb(env.DB);
    await db.insert(record('D1'));
    const created = (await (await call(env, 'POST', '/ui/api/folders', { name: '临时' })).json()) as { id: number };
    await call(env, 'POST', '/ui/api/history/batch-folder', { items: [{ type: 'Text', hash: 'D1' }], folderId: created.id });

    const del = await call(env, 'DELETE', `/ui/api/folders/${created.id}`);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ moved: 1, folders: [] });
    expect((await db.getByTypeAndHash(ProfileType.Text, 'D1'))!.folderId).toBe(0);
    expect((await call(env, 'DELETE', `/ui/api/folders/${created.id}`)).status).toBe(404);
    expect((await call(env, 'DELETE', '/ui/api/folders/0')).status).toBe(400);
  });

  it('folder= 查询参数：非法值 400', async () => {
    const env = makeEnv();
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect((await call(env, 'GET', `/ui/api/history?folder=${bad}`)).status, bad).toBe(400);
    }
    expect((await call(env, 'GET', '/ui/api/history?folder=1')).status).toBe(200);
  });
});
