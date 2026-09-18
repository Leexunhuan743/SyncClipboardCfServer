// `/api/history/query` 过滤与排序语义的端到端验证
//
// 为什么需要：此前只覆盖了「非法值 → 400」（F9/F27），**过滤与排序本身从未端到端断言**，
// 而官方客户端的历史 UI 直接依赖它们：
//   SearchText    → 搜索框
//   Starred       → 星标筛选
//   Types         → 类型筛选
//   SortByLastAccessed → 排序切换
//   Before/After  → 时间范围分页（HistorySyncer.FetchRemoteRangeAsync）
//   ModifiedAfter → **增量同步**（SyncAllAsync(_lastSyncTime) 只拉 LastModified >= 上次同步时间的记录）
//
// 隔离方式：每条记录 text 带唯一 RUN 标记，断言时先按标记筛出本次记录再判断顺序/有无。
// 不用 SearchText 做隔离，否则 SearchText 一旦失效会连带掩盖其它过滤器的断言。
//
// 本套件**会写目标库**（3 条记录），afterAll 负责收尾软删；时间戳的选择保证该收尾一定能成功、
// 且残留行最终会被 Cron 硬删（理由见下方 T*/M* 的注释）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { assertWritableTarget } from './support/target-guard';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

// 本套件会写目标库：默认只允许指向本机 dev server，指向远端需显式 ALLOW_REMOTE_TARGET=1
assertWritableTarget(BASE);
const USER = process.env.SYNC_USER ?? 'admin';
const PASS = process.env.SYNC_PASS ?? 'admin';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const RUN = Date.now().toString(36);
const MARK = `qf-${RUN}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex').toUpperCase();

const DAY = 24 * 60 * 60 * 1000;

// ── 夹具时间戳：为什么锚点必须**锚到库里最新的那条之上**，而不是"现在之上" ──────────
// 协议查询固定 **50 条/页**、默认按 CreateTime DESC，且按上游语义**不过滤软删行**
// （本套件 afterAll 只做软删）⇒ 每跑一次就在排序窗口顶部留下 3 行，且**永不清除**。
// 历史夹具的 CreateTime 是"它那次运行的 now + 4..6 天"，本批是"本次 now + 4..6 天"：本批的
// **gamma** 只比历次的 gamma 新几十分钟，但本批的 **beta/alpha** 比历次的 gamma **旧**。
// 排序是全库混排，于是名次是：
//     本批 gamma → 历次 gamma（每次 1 条）→ 本批 beta → 历次 beta → … → 本批 alpha
// 累积约 25 次运行后，首页 50 条被历次的 gamma/beta 占满，**本批最老的 alpha 被挤出首页**。
// 2026-09-15 在本机复现：首页 50 条 = 26 条 qf-*-gamma + 20 条 qf-*-beta，qf-*-alpha 0 条；
// 表现为「排序 / Types / Before」三个用例失败，而 SearchText=alpha 又能查到它（记录本身没问题）。
// 取"远期锚点"只保证了**新于现在**，保证不了**新于历史**。
// 修法：锚点 = 库里现有最大 CreateTime（+4 天）⇒ 本批永远占据前三名，与运行次数无关。
let NOW = Date.now() + 3000 * DAY; // 夹具纪元：仅供"远未来"断言（NOW + 30 天）使用
let T0 = ''; // CreateTime == LastAccessed 的基准值：它们是**排序键**，必须高于全库
let T1 = '';
let T2 = '';
// LastModified 刻意取**真过去值**（相对系统时间，而不是相对夹具纪元）。它不参与排序，却决定清理：
//   - 写成未来值 → `softDeleteExpiredRecords`（LastModified < cutoff）永不命中；
//   - 且 `hardDeleteOldDeletedRecords`（LastModified < now-30d）同样永不命中 → 测试残留**永久**留在库里
//     （这正是上面那 46 条历史夹具的来历）；
//   - 更关键：afterAll 也删不掉 —— `ShouldUpdate` 在时间差 > 5 分钟时要求
//     `newLastModified >= oldLastModified`，未来的旧值会让「以 now 收尾」的 PATCH 变成 409。
let M0 = '';
let M1 = '';
let M2 = '';

async function req(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, { ...init, headers: { Authorization: AUTH, ...(init.headers ?? {}) } });
}

// 造一条 Text 记录（inline、无数据）——POST 允许显式指定三个时间戳与 starred
async function createRecord(
  suffix: string,
  times: { createTime: string; lastAccessed: string; lastModified: string },
  starred = false,
) {
  const text = `${MARK}-${suffix}`;
  const b = `bnd${RUN}${suffix}`;
  const fields: Record<string, string> = {
    hash: sha256(text),
    type: 'Text',
    text,
    size: String(text.length),
    version: '0',
    isDeleted: 'false',
    starred: starred ? 'true' : 'false',
    pinned: 'false',
    ...times,
  };
  let body = '';
  for (const [k, v] of Object.entries(fields)) {
    body += `--${b}\r\nContent-Disposition: form-data; name=${k}\r\n\r\n${v}\r\n`;
  }
  body += `--${b}--\r\n`;
  const res = await req('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
    body,
  });
  if (res.status !== 200) throw new Error(`建记录 ${suffix} 失败: ${res.status} ${await res.text()}`);
}

async function query(fields: Record<string, string>, page = '1'): Promise<{ type: string; text: string }[]> {
  const b = `bnd${RUN}q`;
  let body = '';
  for (const [k, v] of Object.entries({ Page: page, Types: 'All', ...fields })) {
    body += `--${b}\r\nContent-Disposition: form-data; name=${k}\r\n\r\n${v}\r\n`;
  }
  body += `--${b}--\r\n`;
  const res = await req('/api/history/query', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
    body,
  });
  if (res.status !== 200) throw new Error(`query 失败: ${res.status} ${await res.text()}`);
  return (await res.json()) as { type: string; text: string }[];
}

// 只看本次标记的记录（顺序保留服务端返回顺序）
const mine = (list: { text: string }[]) =>
  list.filter((r) => (r.text ?? '').startsWith(MARK)).map((r) => r.text.slice(MARK.length + 1));

beforeAll(async () => {
  const root = await fetch(`${BASE}/`, { headers: { Authorization: AUTH } });
  if (!root.ok) throw new Error(`dev server 不可用 (${BASE}): ${root.status}`);

  // 先把锚点定在**库里现有的最大 CreateTime 之上**（详见文件头的时间戳说明）。
  // 第 1 页就是按 CreateTime DESC 排的，故首条即最新；库为空（CI）时回退到系统时间。
  const newest = (await query({}))[0] as { createTime?: string } | undefined;
  const existing = newest?.createTime ? Date.parse(newest.createTime) : Number.NaN;
  const anchor = Math.max(Number.isFinite(existing) ? existing : 0, Date.now());

  NOW = anchor + 3 * DAY;
  T0 = new Date(anchor + 1 * DAY).toISOString();
  T1 = new Date(anchor + 2 * DAY).toISOString();
  T2 = new Date(anchor + 3 * DAY).toISOString();
  const real = Date.now();
  M0 = new Date(real - 3 * DAY).toISOString();
  M1 = new Date(real - 2 * DAY).toISOString();
  M2 = new Date(real - 1 * DAY).toISOString();

  // alpha: 最早创建、最久未访问、最久未修改
  await createRecord('alpha', { createTime: T0, lastAccessed: T0, lastModified: M0 });
  // beta: 中间创建、**最近访问**、中间修改、已星标
  await createRecord('beta', { createTime: T1, lastAccessed: T2, lastModified: M1 }, true);
  // gamma: 最近创建、中间访问、**最近修改**
  await createRecord('gamma', { createTime: T2, lastAccessed: T1, lastModified: M2 });
});

describe('query 过滤与排序（客户端历史 UI / 增量同步依赖）', () => {
  it('SearchText 过滤 Text 子串（不匹配的记录必须不出现）', { timeout: 60_000 }, async () => {
    const hit = await query({ SearchText: `${MARK}-beta` });
    expect(mine(hit)).toEqual(['beta']);

    const miss = await query({ SearchText: `${MARK}-nonexistent` });
    expect(mine(miss)).toEqual([]);

    // 部分匹配也要命中（上游 LIKE %text%）
    const partial = await query({ SearchText: `${MARK}-gam` });
    expect(mine(partial)).toEqual(['gamma']);
  });

  it('Types 过滤：Text 命中、File 排除', { timeout: 60_000 }, async () => {
    expect(mine(await query({ Types: 'Text' })).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(mine(await query({ Types: 'File' }))).toEqual([]);
    expect(mine(await query({ Types: 'Text,File' })).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('Starred 过滤：true 只有星标、false 只有非星标', { timeout: 60_000 }, async () => {
    expect(mine(await query({ Starred: 'true' }))).toEqual(['beta']);
    expect(mine(await query({ Starred: 'false' })).sort()).toEqual(['alpha', 'gamma']);
  });

  it('排序：默认按 CreateTime DESC；SortByLastAccessed=true 改按 LastAccessed DESC', { timeout: 60_000 }, async () => {
    // CreateTime: gamma(T2) > beta(T1) > alpha(T0)
    expect(mine(await query({ SortByLastAccessed: 'False' }))).toEqual(['gamma', 'beta', 'alpha']);
    // LastAccessed: beta(T2) > gamma(T1) > alpha(T0)
    expect(mine(await query({ SortByLastAccessed: 'True' }))).toEqual(['beta', 'gamma', 'alpha']);
  });

  it('Before/After 按排序字段过滤（Before 用 <，After 用 >=）', { timeout: 60_000 }, async () => {
    // 默认按 CreateTime：Before=T2 → 排除 gamma(T2)，保留 beta(T1)/alpha(T0)
    expect(mine(await query({ Before: T2 }))).toEqual(['beta', 'alpha']);
    // After=T1 → 保留 gamma(T2)/beta(T1)，排除 alpha(T0)
    expect(mine(await query({ After: T1 }))).toEqual(['gamma', 'beta']);
    // 边界：After == 某条记录的 CreateTime 时该条**被包含**（上游是 >=）
    expect(mine(await query({ After: T2 }))).toEqual(['gamma']);

    // 按 LastAccessed 时同一组参数含义改变：Before=T2 → 排除 beta(T2)，保留 gamma(T1)/alpha(T0)
    expect(mine(await query({ SortByLastAccessed: 'True', Before: T2 }))).toEqual(['gamma', 'alpha']);
  });

  it('ModifiedAfter 按 LastModified 过滤（**增量同步**用的就是这个）', { timeout: 60_000 }, async () => {
    // LastModified: gamma(M2=now-1d) > beta(M1=now-2d) > alpha(M0=now-3d)
    // ModifiedAfter=M1 → 保留 gamma/beta，排除 alpha
    expect(mine(await query({ ModifiedAfter: M1 })).sort()).toEqual(['beta', 'gamma']);
    // ModifiedAfter=M2 → 只有 gamma 满足 >= M2
    expect(mine(await query({ ModifiedAfter: M2 }))).toEqual(['gamma']);
    // 远未来的时间 → 空
    expect(mine(await query({ ModifiedAfter: new Date(NOW + 30 * DAY).toISOString() }))).toEqual([]);
  });

  it('after >= before → 400（上游 BadRequest）', { timeout: 60_000 }, async () => {
    const b = `bnd${RUN}bad`;
    let body = '';
    for (const [k, v] of Object.entries({ Page: '1', Types: 'All', After: T2, Before: T1 })) {
      body += `--${b}\r\nContent-Disposition: form-data; name=${k}\r\n\r\n${v}\r\n`;
    }
    body += `--${b}--\r\n`;
    const res = await req('/api/history/query', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
      body,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('after must be less than before');
  });

  it('组合过滤：SearchText + Starred + 时间范围同时生效', { timeout: 60_000 }, async () => {
    // 星标只有 beta；再叠加 ModifiedAfter=M2（beta 的 LastModified 是 M1 < M2）→ 应为空
    expect(mine(await query({ Starred: 'true', ModifiedAfter: M2 }))).toEqual([]);
    // 改为 ModifiedAfter=M0 → beta 命中
    expect(mine(await query({ Starred: 'true', ModifiedAfter: M0 }))).toEqual(['beta']);
    // 搜索文本 + 星标：gamma 未星标 → 空
    expect(mine(await query({ SearchText: `${MARK}-gamma`, Starred: 'true' }))).toEqual([]);
  });
});

// 收尾：本套件会写目标库，必须自己清理干净（否则每次运行都在库里留下 3 条记录）。
// 若把套件指向共享/线上实例而忘了收尾，这些记录会出现在用户的客户端历史里。
afterAll(async () => {
  const failed: string[] = [];
  for (const suffix of ['alpha', 'beta', 'gamma']) {
    const hash = sha256(`${MARK}-${suffix}`);
    let res: Response;
    try {
      res = await req(`/api/history/Text/${hash}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // lastModified 必须 **≥ 记录现值**：`ShouldUpdate` 在时间差超阈值时要求新值不倒退（否则 409、删不掉）。
        // 夹具的 M* 是真过去值（now-1..3 天），故这里用**系统 now** 即可 —— 并因此让
        // `hardDeleteOldDeletedRecords`（LastModified < now-30d）在 30 天后能真正收掉这几行残留。
        body: JSON.stringify({ isDelete: true, version: 10_000, lastModified: new Date().toISOString() }),
      });
    } catch (err) {
      failed.push(`${suffix}: ${(err as Error).message}`);
      continue;
    }
    if (res.status !== 200 && res.status !== 404) failed.push(`${suffix}: PATCH ${res.status}`);
  }
  // 清理失败必须让套件失败 —— 静默残留正是本收尾要避免的事
  expect(failed, `清理失败，目标库可能已被写入残留记录：${failed.join('; ')}`).toEqual([]);
});
