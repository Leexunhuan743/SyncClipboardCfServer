// 只守会影响真实部署或数据结构的跨文件不变式。
// 套件数、资源数、目录树、代码行数和历史文档不属于测试职责。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

describe('部署开关清单：.dev.vars.example / deploy.yml / README 三处一致', () => {
  const readText = (relative: string): string => read(relative).replace(/\r\n/g, '\n');

  function exampleNames(): string[] {
    return [...readText('.dev.vars.example').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
  }

  function workerBoundNames(): string[] {
    const list = /\n\s+vars: \|\n((?:\s+[A-Z][A-Z0-9_]*\n)+)/.exec(readText('.github/workflows/deploy.yml'))?.[1];
    expect(list, '没抽到 deploy.yml 的 vars 名单（守卫可能失效）').toBeTruthy();
    return [...(list ?? '').matchAll(/([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
  }

  function readmeTableNames(): string[] {
    return [...readText('README.md').matchAll(/^\s*\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!);
  }

  it('.dev.vars.example == CI 绑给 Worker 的名字 + 凭据 + 测试覆盖（双向，且不放空）', () => {
    const example = new Set(exampleNames());
    const bound = new Set(workerBoundNames());
    expect(example.size, '没抽到 .dev.vars.example 的名字（守卫可能失效）').toBeGreaterThan(6);
    expect(bound.size, '没抽到 deploy.yml 的开关名单（守卫可能失效）').toBeGreaterThan(6);
    const allowed = new Set([...bound, 'USERNAME', 'PASSWORD', 'SYNC_USER']);
    expect(
      [...example].filter((name) => !allowed.has(name)).sort(),
      '.dev.vars.example 里出现了 CI 不认的名字：要么把它接进 deploy.yml 的 vars 名单，要么从示例删掉',
    ).toEqual([]);
    expect(
      [...bound].filter((name) => !example.has(name)).sort(),
      '.dev.vars.example 缺了 CI 会绑给 Worker 的开关 —— 新增可调项时四处（示例/CI/README/wrangler.toml）都要改',
    ).toEqual([]);
  });

  it('README 的开关表覆盖全部运行期开关 + 两个部署期变量（2026-09-21 曾漏 4 个限速参数）', () => {
    const table = new Set(readmeTableNames());
    expect(table.size, '没抽到 README 开关表（守卫可能失效）').toBeGreaterThan(6);
    const required = new Set([...workerBoundNames(), 'D1_DATABASE_ID', 'D1_BOOTSTRAP']);
    expect(
      [...required].filter((name) => !table.has(name)).sort(),
      'README 的开关表漏了这些变量（用户在 README 里根本看不到它们可配）',
    ).toEqual([]);
    expect(
      [...table].filter((name) => !required.has(name)).sort(),
      'README 开关表里出现了既不是运行期开关、也不是部署期变量的名字（写错了？还是该登记进上面那条判据？）',
    ).toEqual([]);
  });
});

describe('部署链：hash 大小写折叠冲突检测（tools/check-hash-case-conflicts.mjs）', () => {
  it('findCaseConflicts：只差大小写的同 (User, Type) hash 被挑出；纯大写/不同 hash 不受影响', async () => {
    // @ts-expect-error —— 无该 .mjs 的声明文件
    const mod = await import('../tools/check-hash-case-conflicts.mjs');
    const rows = [
      { ID: 1, UserId: 'default_user', Type: 0, Hash: 'ABC' },
      { ID: 2, UserId: 'default_user', Type: 0, Hash: 'abc' },
      { ID: 3, UserId: 'default_user', Type: 0, Hash: 'DEF' },
      { ID: 4, UserId: 'default_user', Type: 1, Hash: 'ABC' },
    ];
    const conflicts = mod.findCaseConflicts(rows);
    expect(conflicts.length, '只有 (User,Text) 的 ABC/abc 是冲突').toBe(1);
    expect(conflicts[0].map((r: { Hash: string }) => r.Hash).sort()).toEqual(['ABC', 'abc']);
    // 正对照：全大写、或无折叠冲突时为空
    expect(mod.findCaseConflicts([{ ID: 1, UserId: 'u', Type: 0, Hash: 'ABC' }])).toEqual([]);
  });

  it('工具是**只读**的（只出现 SELECT，不含 UPDATE/DELETE/INSERT 语句）', () => {
    const script = read('tools/check-hash-case-conflicts.mjs').replace(/\r\n/g, '\n');
    expect(script).toMatch(/SELECT[^]*FROM HistoryRecords/);
    // 只看**语句**（行首的 SQL 关键字），注释里提到 DELETE 不算
    expect(script).not.toMatch(/^[ \t]*(UPDATE|DELETE[ \t]+FROM|INSERT[ \t]+INTO)\b/im);
  });
});

describe('部署链：D1 列迁移（tools/migrate-d1.mjs）', () => {
  it('parseD1Output 处理 wrangler 的横幅前缀 / 空输出 / 正常 JSON 三形态', async () => {
    // @ts-expect-error —— 无 migrate-d1.mjs 的声明文件
    const mod = await import('../tools/migrate-d1.mjs');
    const banner =
      '🌀 Executing on remote database syncclipboard (a1b2c3)\n' +
      '[{"results":[{"name":"ID"},{"name":"TransferDataHash"}],"success":true}]';
    expect([...mod.parseD1Output(banner)]).toEqual(['ID', 'TransferDataHash']);
    expect([
      ...mod.parseD1Output('[{"results":[{"name":"A"}],"success":true},{"results":[{"name":"B"}],"success":true}]'),
    ]).toEqual(['A', 'B']);
    expect(() => mod.parseD1Output('no json')).toThrow();
  });

  it('deploy.yml 的迁移步骤存在、先于 Deploy Worker，且与 schema 步骤同库寻址', () => {
    const yml = read('.github/workflows/deploy.yml');
    const stepIdx = (name: string) => yml.indexOf(`- name: ${name}`);
    const applyIdx = stepIdx('Apply D1 schema (idempotent)');
    const migrateIdx = stepIdx('Migrate D1 (idempotent)');
    const deployIdx = stepIdx('Deploy Worker');
    expect(applyIdx, '缺少 Apply D1 schema 步骤').toBeGreaterThan(-1);
    expect(migrateIdx, '缺少 Migrate D1 步骤').toBeGreaterThan(applyIdx);
    expect(deployIdx, 'Deploy Worker 步骤缺失').toBeGreaterThan(migrateIdx);
    expect(yml).toContain('npx wrangler d1 execute DB --remote --file=./schema.sql');
    expect(yml).not.toContain('wrangler d1 execute syncclipboard');
    const script = read('tools/migrate-d1.mjs');
    expect(script).toContain("const DB = 'DB'");
  });

  it('迁移的 ALTER DDL 与 schema.sql 的列定义**同一事实**（加了列/改了默认值必须两处同步）', () => {
    const script = read('tools/migrate-d1.mjs').replace(/\r\n/g, '\n');
    const schema = read('schema.sql').replace(/\r\n/g, '\n');

    const entries = [
      ...script.matchAll(/table:\s*'([^']+)'[\s\S]*?column:\s*'([^']+)'[\s\S]*?"(ALTER TABLE[^"\n]+)"/g),
    ].map((m) => ({ table: m[1]!, column: m[2]!, ddl: m[3]! }));

    expect(
      entries.length,
      '抽不到任何一条迁移（抽取器失效；迁移条数应 ≥1）',
    ).toBeGreaterThan(0);
    expect(entries.length, '抽取到的迁移条数与源码里的 MIGRATIONS 条目数对不上').toBe(
      (script.match(/table:\s*'/g) ?? []).length,
    );

    for (const { table, column, ddl } of entries) {
      const prefix = `ALTER TABLE ${table} ADD COLUMN `;
      expect(ddl.startsWith(prefix), `${table}.${column} 的 DDL 形态不对：${ddl}`).toBe(true);
      expect(ddl, `DDL 必须加的是同名表上的那一列（${table}.${column}）`).toContain(` ${column} `);

      const migratedDef = ddl.slice(prefix.length);
      const body = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
      expect(body, `schema.sql 里找不到表 ${table}`).not.toBeNull();
      const schemaLine = body![1]!
        .split('\n')
        .map((l) => l.trim())
        .find((l) => new RegExp(`^"?${column}"?\\s`).test(l));
      expect(schemaLine, `schema.sql 里找不到列 ${table}.${column}`).toBeDefined();
      const schemaDef = schemaLine!.split('--')[0]!.trim().replace(/,$/, '');
      expect(schemaDef.length, '抽取器的正向证据：schema 列定义不该是空串').toBeGreaterThan(20);

      expect(
        migratedDef,
        `${table}.${column} 的迁移列定义与 schema.sql 不一致 —— 新库/老库会结构不同，且 DDL 不会报错：\n` +
          `  migrate: ${migratedDef}\n  schema : ${schemaDef}`,
      ).toBe(schemaDef);

      expect(migratedDef, `${table}.${column}：ADD COLUMN 出现 NOT NULL 却没有 DEFAULT ⇒ SQLite 会拒绝`).toMatch(
        /NOT NULL DEFAULT/,
      );
    }

    const LEGACY_COLUMNS_WITHOUT_MIGRATION = new Set([
      'ID',
      'UserId',
      'Type',
      'Text',
      'Size',
      'TransferDataFile',
      'TransferDataSha256',
      'TransferDataMd5',
      'FilePaths',
      'Hash',
      'CreateTime',
      'LastAccessed',
      'LastModified',
      'Stared',
      'Pinned',
      'From',
      'Tags',
      'ExtraData',
      'Version',
      'IsDeleted',
    ]);
    const migrated = new Set(entries.filter((e) => e.table === 'HistoryRecords').map((e) => e.column));
    const body = schema.match(/CREATE TABLE IF NOT EXISTS HistoryRecords \(([\s\S]*?)\n\);/);
    expect(body, 'schema.sql 里找不到 HistoryRecords 表').not.toBeNull();
    const schemaColumns = body![1]!
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('--'))
      .map((l) => l.split('--')[0]!.trim().replace(/,$/, ''))
      .map((l) => l.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?\s/)?.[1])
      .filter((c): c is string => typeof c === 'string');
    expect(schemaColumns.length, '抽取器的正向证据：schema 列数不该太少').toBeGreaterThan(10);
    const orphan = schemaColumns.filter(
      (c) => !migrated.has(c) && !LEGACY_COLUMNS_WITHOUT_MIGRATION.has(c),
    );
    expect(
      orphan,
      'schema.sql 里的这些列既没有对应迁移、也不在历史白名单里 —— ' +
        '老库不会有它们（`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效），' +
        '请把它们加进 tools/migrate-d1.mjs 的 MIGRATIONS（而不是白名单）',
    ).toEqual([]);

    const staleWhitelist = [...LEGACY_COLUMNS_WITHOUT_MIGRATION].filter((c) => !schemaColumns.includes(c));
    expect(
      staleWhitelist,
      '白名单里这些列在 schema.sql 里已不存在 —— 删列时请一并删掉白名单条目' +
        '（留着会让同名的新列被静默放行、绕过上面的反向检查）',
    ).toEqual([]);
  });
});
