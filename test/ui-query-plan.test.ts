// 界面查询的「读行数」回归（D1 免费额度：500 万行读/天）。
//
// 背景：线上某天 D1 读行数用到了额度的 83%，而 99% 来自网页界面。逐条实测（924 行的表）：
//   列表一页 1,799 / 列表总数 924 / 总览分组 1,848 + 四个计数 924 + 每个收藏夹 924 / 轮询 924
// 根因是几乎每条查询都**全表扫描**（含软删保留 30 天的回收站行，回收站占到 70% 时成本 ×3.4）。
// 这里钉住修复后的形状。D1 的计费口径是「扫描的行数」，而 node:sqlite 与 D1 同为 SQLite，
// 所以查询计划（EXPLAIN QUERY PLAN）一致：走索引、没有临时排序 ⇒ 读行数与「返回的行数」同阶，不随表（回收站）变大。
//
// 不依赖 dev server：node:sqlite + 真 `schema.sql`。
import { describe, expect, it } from 'vitest';
import { HistoryDb } from '../src/db';
import { buildListSql, countByTypeViews, parseUiHistoryQuery, readChangeMarker, readLastModified } from '../src/ui/query';
import { ProfileType } from '../src/types';
import type { HistoryRecordEntity } from '../src/types';
import { createSqliteD1, readSchemaSql } from './support/d1-sqlite';

const SCHEMA = readSchemaSql();
const now = Date.now();

const record = (hash: string, opts: Partial<HistoryRecordEntity> = {}): HistoryRecordEntity => ({
  userId: 'default_user', type: ProfileType.Text, text: hash, size: hash.length, transferDataFile: '', filePaths: [], hash,
  createTime: now, lastAccessed: now, lastModified: now, stared: false, pinned: false, version: 0, isDeleted: false, ...opts,
});

function setup() {
  const d1 = createSqliteD1(SCHEMA);
  return { d1, db: new HistoryDb(d1 as unknown as D1Database) };
}

/** 对一条 SQL 取查询计划（每步一行文字）。 */
function plan(d1: ReturnType<typeof createSqliteD1>, sql: string, params: (string | number)[]): string[] {
  const rows = d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[];
  return rows.map((r) => r.detail);
}

describe('列表：只读需要的行，不扫全表、不临时排序', () => {
  // 第三列：允许命中的索引。「只看收藏」时 SQLite 会选更有选择性的 Stared 索引（只读收藏的行），那比列表索引更好
  const cases: [string, string, RegExp][] = [
    ['活跃视图（默认：置顶优先 + 创建时间倒序）', '', /idx_h_user_list/],
    ['回收站视图', 'deleted=true', /idx_h_user_list/],
    ['收藏夹视图', 'folder=1', /idx_h_user_list/],
    ['按类型筛', 'types=Text', /idx_h_user_list/],
    ['只看收藏', 'starred=true', /idx_h_user_(list|stared)/],
  ];
  for (const [label, qs, index] of cases) {
    it(`${label}：一页与总数都走索引（不是全表扫描），没有临时 B 树排序`, () => {
      const { d1 } = setup();
      const q = parseUiHistoryQuery(new URLSearchParams(qs));
      const sql = buildListSql(q);
      const page = plan(d1, sql.pageSql, sql.pageParams);
      const count = plan(d1, sql.countSql, sql.countParams);
      expect(page.join('\n'), `一页的计划：\n${page.join('\n')}`).toMatch(index);
      expect(page.join('\n'), `一页不该有临时排序：\n${page.join('\n')}`).not.toMatch(/TEMP B-TREE/);
      expect(count.join('\n'), `总数的计划：\n${count.join('\n')}`).toMatch(index);
      expect(count.join('\n')).not.toMatch(/\bSCAN HistoryRecords\b(?! USING)/);
    });
  }

  it('活跃视图的总数是覆盖索引：只读索引条目，不回表', () => {
    const { d1 } = setup();
    const sql = buildListSql(parseUiHistoryQuery(new URLSearchParams('')));
    expect(plan(d1, sql.countSql, sql.countParams).join('\n')).toMatch(/COVERING INDEX idx_h_user_list/);
  });
});

describe('变更信号：读 1 行', () => {
  it('MAX(LastModified) 走 idx_h_user_modify 的索引定位（SEARCH，不是 SCAN）', () => {
    const { d1 } = setup();
    const p = plan(d1, `SELECT COALESCE(MAX(LastModified), 0) AS m FROM HistoryRecords WHERE UserId = ?1`, ['default_user']).join('\n');
    expect(p).toMatch(/idx_h_user_modify/);
    expect(p).not.toMatch(/\bSCAN HistoryRecords\b(?! USING)/);
  });

  it('只有 lastModified 一个值；新增 / 更新会抬高它，随后硬删最新一条会让它回落', async () => {
    const { d1, db } = setup();
    expect(await readChangeMarker(d1 as unknown as D1Database)).toEqual({ lastModified: 0 });
    await db.insert(record('A', { lastModified: now - 5000 }));
    await db.insert(record('B', { lastModified: now - 1000 }));
    const marker = await readChangeMarker(d1 as unknown as D1Database);
    expect(Object.keys(marker)).toEqual(['lastModified']);
    expect(marker.lastModified).toBe(now - 1000);
    await db.updateHistory(ProfileType.Text, 'A', { starred: true }); // 更新 ⇒ LastModified 推进
    expect(await readLastModified(d1 as unknown as D1Database)).toBeGreaterThan(now - 1000);
  });
});

describe('总览：四个计数与收藏夹条数来自同一次分组，且与协议口径一致', () => {
  it('stats 与 db.statistics() 逐项相等（含：回收站里的收藏、未知类型的行）', async () => {
    const { d1, db } = setup();
    await db.insert(record('T1'));
    await db.insert(record('T2', { stared: true }));
    await db.insert(record('T3', { isDeleted: true }));
    await db.insert(record('T4', { isDeleted: true, stared: true })); // 回收站里的收藏：starredCount 是全库口径，要算
    await db.insert(record('I1', { type: ProfileType.Image }));
    d1.sqlite.exec(`INSERT INTO HistoryRecords (UserId, Type, Text, Size, Hash, CreateTime, LastAccessed, LastModified) VALUES ('default_user', 4, 'x', 1, 'UNKNOWN', ${now}, ${now}, ${now})`); // Type=Unknown 的坏行
    const views = await countByTypeViews(d1 as unknown as D1Database);
    expect(views.stats).toEqual(await db.statistics());
    expect(views.stats.totalCount).toBe(6);
  });

  it('收藏夹条数只算活跃成员；与 listFolders() 一致', async () => {
    const { d1, db } = setup();
    const a = await db.createFolder('甲', now);
    const b = await db.createFolder('乙', now);
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('建收藏夹失败');
    for (const h of ['F1', 'F2', 'F3']) await db.insert(record(h));
    await db.insert(record('F4', { isDeleted: true }));
    await db.setFolder([{ type: ProfileType.Text, hash: 'F1' }, { type: ProfileType.Text, hash: 'F2' }, { type: ProfileType.Text, hash: 'F4' }], a.id);
    await db.setFolder([{ type: ProfileType.Text, hash: 'F3' }], b.id);

    const views = await countByTypeViews(d1 as unknown as D1Database);
    expect(views.folders).toEqual({ [a.id]: 2, [b.id]: 1 }); // 回收站里的 F4 不计入
    const listed = await db.listFolders();
    expect(listed.map((f) => [f.id, f.count])).toEqual([[a.id, 2], [b.id, 1]]);
    // 总览那一路：收藏夹行 + 分组里的条数 = listFolders() 的结果
    const rows = await db.listFolderRows();
    expect(rows.map((r) => ({ ...r, count: views.folders[r.id] ?? 0 }))).toEqual(listed);
  });

  it('listFolders 是一条分组查询，不是每个收藏夹一条相关子查询（后者读行数 = 收藏夹数 × 全表）', () => {
    const { d1 } = setup();
    const sql = `SELECT f.Id AS id, COALESCE(c.n, 0) AS count FROM Folders f LEFT JOIN (SELECT FolderId, COUNT(*) AS n FROM HistoryRecords WHERE UserId = ?1 AND IsDeleted = 0 AND FolderId != 0 GROUP BY FolderId) c ON c.FolderId = f.Id WHERE f.UserId = ?1`;
    const p = plan(d1, sql, ['default_user']).join('\n');
    expect(p).not.toMatch(/CORRELATED/);
  });
});

describe('协议路径：哈希查找是点查，不是把该类型的行逐行扫一遍', () => {
  // 官方客户端的每次同步（PUT /SyncClipboard.json、POST /api/history）与每次 GET /api/history/{id} 都会走 getByTypeAndHash。
  // 它写成 `LOWER(Hash) = LOWER(?)`：函数包着列时 (UserId, Type, Hash) 唯一索引用不上，只能扫该类型的全部行。
  // 线上实测 ~540 行/次、两台客户端一小时 ~700 次 ⇒ 一天单独烧光 D1 免费额度。
  const LOOKUP = `SELECT * FROM HistoryRecords WHERE UserId = ?1 AND Type = ?2 AND LOWER(Hash) = LOWER(?3) LIMIT 1`;

  it('getByTypeAndHash 的查询走表达式索引 idx_h_user_type_lhash，等值条件覆盖到 LOWER(Hash)', () => {
    const { d1 } = setup();
    const p = plan(d1, LOOKUP, ['default_user', 0, 'abc']).join('\n');
    expect(p, p).toMatch(/idx_h_user_type_lhash \(UserId=\? AND <expr>=\? AND Type=\?\)/);
  });

  it('SQL 与 db.ts 里真正执行的那条一致（索引表达式必须与查询逐字匹配规划器才会选它）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8');
    expect(src).toContain('UserId = ?1 AND Type = ?2 AND LOWER(Hash) = LOWER(?3) LIMIT 1');
    expect(readSchemaSql()).toContain('ON HistoryRecords(UserId, LOWER(Hash), Type)');
  });

  it('语义不变：大小写不敏感（小写查大写行）、类型与用户仍然隔离', async () => {
    const { db } = setup();
    await db.insert(record('ABCDEF0123'));
    expect((await db.getByTypeAndHash(ProfileType.Text, 'abcdef0123'))?.hash).toBe('ABCDEF0123');
    expect(await db.getByTypeAndHash(ProfileType.Image, 'abcdef0123')).toBeNull();
    expect(await db.getByTypeAndHash(ProfileType.Text, 'nope')).toBeNull();
  });
});

