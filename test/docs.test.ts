// 只保留会阻止真实部署/数据事故的仓库级守卫。
// 文档中的套件数、资源数、目录树、代码行数与历史进度索引不再作为测试对象。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

// ===== 部署开关的四处清单：`.dev.vars.example` ↔ `deploy.yml`（↔ `README.md` 的开关表）=====
//
// 由来（2026-09-21 复查）：同一批开关散在四处 —— `.dev.vars.example`（本地开发）、`deploy.yml`
// （GitHub 仓库变量 → 绑给 Worker）、`wrangler.toml` 的 `[vars]`（默认值）、`README.md` 的开关表。
// 此前**没有任何判据**看着它们：`.dev.vars.example` 只在四个套件的注释里被提到（"默认与 .dev.vars 示例一致"），
// 于是"新增一个开关、忘了改示例文件或 README"这类漂移只能靠人去数 —— 正是 `AGENTS.md` §1 点名的那类
// （2026-09-21 实测：README 的开关表就漏了 4 个 `AUTH_RATE_LIMIT_*`，而 `deploy.yml` 的注释还写着
// "README 已写明"）。判据只钉**名字集合**：默认值各处已实测一致，范围另有 `src/rateLimit.ts` 的
// `AUTH_RATE_LIMIT_RANGES`、`src/requestLimits.ts` 的 FLOOR/CEILING 与 CI 的校验。
describe('部署开关清单：.dev.vars.example / deploy.yml / README 三处一致', () => {
  // ⚠️ 仓库里的文件是 **CRLF** ⇒ 任何"按行匹配"的抽取都要先归一，否则 `\|\n` 这类模式永远不命中
  // （2026-09-21 加这条守卫时正踩在这里：抽不到 `vars:` 名单，断言先红在"抽取器失效"上）。
  const readText = (relative: string): string => read(relative).replace(/\r\n/g, '\n');

  /** `.dev.vars.example` 里的名字（含被注释掉的**可选**行 —— 注释行同样是这份清单的一部分）。 */
  function exampleNames(): string[] {
    return [...readText('.dev.vars.example').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
  }

  /** `deploy.yml` 里 `Deploy Worker` 步骤的 `vars: |` 名单 —— 即"绑给 Worker"的那批名字。 */
  function workerBoundNames(): string[] {
    const list = /\n\s+vars: \|\n((?:\s+[A-Z][A-Z0-9_]*\n)+)/.exec(readText('.github/workflows/deploy.yml'))?.[1];
    expect(list, '没抽到 deploy.yml 的 vars 名单（守卫可能失效）').toBeTruthy();
    return [...(list ?? '').matchAll(/([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
  }

  /** `README.md` **开关表**里被反引号括起来的变量名（只认表格行，避免把散文里的提及算进来）。 */
  function readmeTableNames(): string[] {
    return [...readText('README.md').matchAll(/^\s*\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!);
  }

  it('.dev.vars.example == CI 绑给 Worker 的名字 + 凭据 + 测试覆盖（双向，且不放空）', () => {
    const example = new Set(exampleNames());
    const bound = new Set(workerBoundNames());
    // 空集合会让下面两条断言永远为真 ⇒ 先钉住"抽取器在工作"
    expect(example.size, '没抽到 .dev.vars.example 的名字（守卫可能失效）').toBeGreaterThan(6);
    expect(bound.size, '没抽到 deploy.yml 的开关名单（守卫可能失效）').toBeGreaterThan(6);
    // 凭据走 secrets（`wrangler secret put`），SYNC_USER/SYNC_PASS 只是测试覆盖 —— 这五个不进 CI 的 vars 名单
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

// ===== 部署链守卫：列迁移脚本与步骤顺序（2026-09-22 发布审计新增）=====
// 迁移是「推送即部署」链路上唯一会先于新代码跑的东西：schema.sql 的 CREATE IF NOT EXISTS
// 对老库不生效，新代码的 INSERT/UPDATE 写 TransferDataHash 列 ⇒ 列不存在则部署后每次写库失败，
// 而只读冒烟（statistics=COUNT(*)）根本发现不了。以下两条把「手检」变成常驻判据。

describe('部署链：D1 列迁移（tools/migrate-d1.mjs）', () => {
  it('parseD1Output 处理 wrangler 的横幅前缀 / 空输出 / 正常 JSON 三形态', async () => {
    // tools/ 不在 tsconfig include，也没有 .d.ts —— 静态导入即报 TS7016，故用 ts-expect-error
    // @ts-expect-error —— 无 migrate-d1.mjs 的声明文件
    const mod = await import('../tools/migrate-d1.mjs');
    // --remote 会在 JSON 前打印 `🌀 Executing …`（直接 JSON.parse 会抛 → 挡住部署）
    const banner =
      '🌀 Executing on remote database syncclipboard (a1b2c3)\n' +
      '[{"results":[{"name":"ID"},{"name":"TransferDataHash"}],"success":true}]';
    expect([...mod.parseD1Output(banner)]).toEqual(['ID', 'TransferDataHash']);
    // 正常形态（多页结构）
    expect([
      ...mod.parseD1Output('[{"results":[{"name":"A"}],"success":true},{"results":[{"name":"B"}],"success":true}]'),
    ]).toEqual(['A', 'B']);
    // 空输出：解析失败必须抛（脚本据此非零退出）
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
    // 三处必须按 **binding 名** `DB` 寻址：按库名 `syncclipboard` 会与注入的 database_id 解耦
    const d1ExecLines = yml
      .split('\n')
      .filter((l) => l.includes('wrangler d1 execute'))
      .filter((l) => !l.trim().startsWith('#')); // 跳过注释（如「参数本身就是 name or binding」的说明）
    expect(d1ExecLines.length).toBeGreaterThanOrEqual(2);
    for (const line of d1ExecLines) {
      expect(line, `d1 execute 必须用 binding 名 DB：${line.trim()}`).toMatch(/d1 execute DB\b/);
      expect(line).not.toMatch(/d1 execute syncclipboard\b/);
    }
    const script = read('tools/migrate-d1.mjs');
    expect(script).toContain("const DB = 'DB'");
  });

  it('迁移的 ALTER DDL 与 schema.sql 的列定义**同一事实**（加了列/改了默认值必须两处同步）', () => {
    // 这是本仓库"同一个事实存在两处"清单里**唯一还没被判据看着**的一处：
    // 新库由 `CREATE TABLE` 建列、老库由 `ALTER TABLE … ADD COLUMN` 加列 —— 两边必须是同一列，
    // 否则新库与老库**结构不同**，而 DDL 本身两边都能跑过（不报错），只在别处冒出来：
    //   · `NOT NULL DEFAULT ''` 是 SQLite 对 ADD COLUMN 的硬要求（非空列必须带默认值）；
    //   · 少了 `DEFAULT ''`，老库的新列默认 NULL、新库是 ''，同一行在不同库上读出来不同值；
    //   · 默认值不一致（`DEFAULT ''` vs `DEFAULT 'x'`）是纯静默漂移，什么都不报。
    // tools/migrate-d1.mjs 的注释已经写着"必须与 schema.sql 逐字一致"，但没有判据 —— 靠人记。
    // （仓库文件是 CRLF ⇒ 按行/正则抽取前先归一，见上面那条守卫的同一教训。）
    const script = read('tools/migrate-d1.mjs').replace(/\r\n/g, '\n');
    const schema = read('schema.sql').replace(/\r\n/g, '\n');

    // 抽取**每一条**迁移（不是只第一条）：将来加第二条 ADD COLUMN 时，它同样必须与 schema.sql 同源。
    // 一条迁移在源码里是 `{ table: '…', column: '…', ddl: "ALTER TABLE …" }` 三行，故按出现顺序配对。
    const entries = [
      ...script.matchAll(/table:\s*'([^']+)'[\s\S]*?column:\s*'([^']+)'[\s\S]*?"(ALTER TABLE[^"\n]+)"/g),
    ].map((m) => ({ table: m[1]!, column: m[2]!, ddl: m[3]! }));

    // 抽取器自检：没抽到就说明文件结构变了，下面的断言会退化成"空集合全过"
    expect(
      entries.length,
      '抽不到任何一条迁移（抽取器失效；迁移条数应 ≥1）',
    ).toBeGreaterThan(0);
    expect(entries.length, '抽取到的迁移条数与源码里的 MIGRATIONS 条目数对不上').toBe(
      (script.match(/table:\s*'/g) ?? []).length,
    );

    for (const { table, column, ddl } of entries) {
      // ① 结构：DDL 必须就是 `<表> ADD COLUMN` 形态（不是 CREATE/RENAME/别的表的列）
      const prefix = `ALTER TABLE ${table} ADD COLUMN `;
      expect(ddl.startsWith(prefix), `${table}.${column} 的 DDL 形态不对：${ddl}`).toBe(true);
      expect(ddl, `DDL 必须加的是同名表上的那一列（${table}.${column}）`).toContain(` ${column} `);

      // ② 交叉核对：DDL 的**列定义段**与 schema.sql 里该列的定义**逐字一致**
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

      // ③ 非空列必须带默认值：SQLite 的 ADD COLUMN 直接拒绝 `NOT NULL` 而不给 `DEFAULT`
      //    （那条错误会让 CI 的迁移步骤红、挡住部署 —— 但那时是在部署链路上才发现）
      expect(migratedDef, `${table}.${column}：ADD COLUMN 出现 NOT NULL 却没有 DEFAULT ⇒ SQLite 会拒绝`).toMatch(
        /NOT NULL DEFAULT/,
      );
    }

    // ④ **反方向**（2026-10-04 补，审计 R2#4）：schema.sql 里新增的列必须要么有对应迁移、
    //    要么在下面的白名单里 —— 否则「老库没有这一列」永远没人发现（实测：给 schema.sql 加一列
    //    后，5 个读 schema 的套件 128 条全绿 exit=0）。这条与上面的 ①②③ 合起来才是双向的。
    //    白名单：建立**早于**迁移机制存在的历史列（老库靠 CREATE TABLE IF NOT EXISTS 的首次执行
    //    就已带上，无需 ALTER）。新增列时**不要**往这里加，而应加进 MIGRATIONS。
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

    // ⑤ 白名单的**反方向**（2026-10-04 补，验证单元 V2 指出）：白名单里的名字必须在 schema 里真实存在。
    //    否则删掉一列后白名单留下一条死条目 —— 那条没人守，将来同名的新列会被它**静默放行**
    //    （V2 实测：把 `Tags` 从 schema 删除而白名单留着，15 passed 未红）。
    const staleWhitelist = [...LEGACY_COLUMNS_WITHOUT_MIGRATION].filter((c) => !schemaColumns.includes(c));
    expect(
      staleWhitelist,
      '白名单里这些列在 schema.sql 里已不存在 —— 删列时请一并删掉白名单条目' +
        '（留着会让同名的新列被静默放行、绕过上面的反向检查）',
    ).toEqual([]);
  });
});
