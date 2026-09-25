// 修复项运行时验证（不依赖 dev server）
// - 纯逻辑：multipart / serialization / hash
// - 服务层：profile.ts（用内存 stub 驱动 R2/D1 接口）
// - 数据层：db.ts（用 node:sqlite + schema.sql 建真实 SQLite，验证 SQL 语义）
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { zipSync, strToU8, Zip, ZipPassThrough } from 'fflate';
import { createSqliteD1, readSchemaSql, type SqliteD1 } from './support/d1-sqlite';

import { parseMultipart } from '../src/multipart';
import { parseProfileDto, parseHistoryRecordUpdateDto, profileDtoToJson } from '../src/serialization';
import { parseGroupZip, sha256Hex, textProfileHash } from '../src/hash';
import { addRecordDto, entityToProfileDto, putSyncProfile, ProfileDataInvalidError, IncomingRecord } from '../src/profile';
import { HistoryDb } from '../src/db';
import { ProfileType } from '../src/types';
import type { HistoryRecordEntity, ProfileDto } from '../src/types';
import type { R2Storage } from '../src/storage';
import { R2Storage as RealR2Storage } from '../src/storage';
import { runCleanup } from '../src/cleanup';
import { createWebdavRoutes } from '../src/routes/webdav';
import { createHistoryRoutes } from '../src/routes/history';
import { purgeTrash } from '../src/historyOps';
import type { Bindings } from '../src/env';

const sha256 = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest('hex').toUpperCase();

// ============ multipart 构造 ============
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function multipartBody(
  parts: { name: string; filename?: string; content: Uint8Array }[],
  boundary = 'bnd',
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name=${p.name}`;
    if (p.filename) head += `; filename="${p.filename}"`;
    chunks.push(enc.encode(`${head}\r\n\r\n`));
    chunks.push(p.content);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return concat(chunks);
}

// ============ R2 / D1 stub ============
class FakeR2 {
  objects = new Map<string, Uint8Array>();

  async putTemp(name: string, body: Uint8Array): Promise<void> {
    this.objects.set(`file/${name}`, new Uint8Array(body));
  }
  async getTemp(name: string) {
    const b = this.objects.get(`file/${name}`);
    if (!b) return null;
    return { arrayBuffer: async () => b.slice().buffer };
  }
  async deleteTemp(name: string): Promise<void> {
    this.objects.delete(`file/${name}`);
  }
  async putHistory(type: ProfileType, hash: string, fileName: string, body: Uint8Array): Promise<void> {
    this.objects.set(`history/${ProfileType[type]}_${hash}/${fileName}`, new Uint8Array(body));
  }
  // isLocalDataValid 需要读取历史对象（真实 R2Storage 有该方法）
  async getHistory(type: ProfileType, hash: string, fileName: string) {
    const b = this.objects.get(`history/${ProfileType[type]}_${hash}/${fileName}`);
    return b ? { arrayBuffer: async () => b.slice().buffer } : null;
  }
  hasTemp(name: string): boolean {
    return this.objects.has(`file/${name}`);
  }
}

class FakeDb {
  rows: HistoryRecordEntity[] = [];
  meta: string | null = null;
  private nextId = 1;

  async getByTypeAndHash(type: ProfileType, hash: string): Promise<HistoryRecordEntity | null> {
    const key = (hash || '').toUpperCase();
    const row = this.rows.find((r) => r.type === type && r.hash.toUpperCase() === key);
    return row ? { ...row } : null;
  }
  async insert(e: HistoryRecordEntity): Promise<HistoryRecordEntity> {
    const row = { ...e, id: this.nextId++ };
    this.rows.push(row);
    return { ...row };
  }
  async updateEntity(e: HistoryRecordEntity): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === e.id);
    if (i >= 0) this.rows[i] = { ...e };
  }
  async setCurrentProfileJson(json: string): Promise<void> {
    this.meta = json;
  }
  async getCurrentProfileJson(): Promise<string | null> {
    return this.meta;
  }
}

const silentNotify = {
  notifyProfile: () => undefined,
  notifyHistory: () => undefined,
};

function incoming(over: Partial<IncomingRecord>): IncomingRecord {
  const now = Date.now();
  return {
    type: ProfileType.Text,
    hash: '',
    text: '',
    size: 0,
    createTime: now,
    lastModified: now,
    lastAccessed: now,
    starred: false,
    pinned: false,
    version: 0,
    isDeleted: false,
    ...over,
  };
}

// ============================================================ F14 / multipart
describe('F14 · multipart 区分「无 data 部分」与「0 字节 data 部分」', () => {
  it('无 data 部分 → dataPresent=false', () => {
    const bytes = multipartBody([{ name: 'hash', content: strToU8('ABC') }]);
    const parsed = parseMultipart(bytes, 'bnd');
    expect(parsed.dataPresent).toBe(false);
    expect(parsed.data).toBeNull();
  });

  it('0 字节 data 部分 → dataPresent=true 且 data=null', () => {
    const bytes = multipartBody([
      { name: 'hash', content: strToU8('ABC') },
      { name: 'data', filename: 'x.bin', content: new Uint8Array(0) },
    ]);
    const parsed = parseMultipart(bytes, 'bnd');
    expect(parsed.dataPresent).toBe(true);
    expect(parsed.data).toBeNull();
  });

  it('有内容 data 部分 → dataPresent=true 且 data 非空', () => {
    const bytes = multipartBody([
      { name: 'hash', content: strToU8('ABC') },
      { name: 'data', filename: 'x.bin', content: strToU8('hello') },
    ]);
    const parsed = parseMultipart(bytes, 'bnd');
    expect(parsed.dataPresent).toBe(true);
    expect(parsed.data?.content.length).toBe(5);
  });
});

// ============================================================ F12 / hash
describe('F12 · Group zip 畸形条目语义', () => {
  it('同名重复条目按上游「首次写入优先」取首个内容（旧实现取后者）', async () => {
    const dupZip = buildZipWithDuplicateNames('dup.txt', [strToU8('AAA'), strToU8('BBB')]);
    const { entries, totalSize } = await parseGroupZip(dupZip);
    const files = entries.filter((e) => !e.isDir);
    expect(files.length).toBe(1);
    // 内容字节不保留：校验改为内容哈希（SHA-256('AAA')）
    expect(files[0]!.contentHash).toBe(await sha256Hex(strToU8('AAA')));
    expect(totalSize).toBe(3);
    // 非重复的普通 zip 不受影响
    expect((await parseGroupZip(zipSync({ 'ok.txt': strToU8('AAA') } as never))).totalSize).toBe(3);
  });

  it('多尾斜杠目录条目按 TrimEnd 全部裁剪判定顶层（不再只裁一个）', async () => {
    const zip = zipSync({ 'a//': new Uint8Array(0), 'a//b.txt': strToU8('x') } as never);
    const { topLevel } = await parseGroupZip(zip);
    // 'a//' → TrimEnd 后为 'a' → 判为顶层（旧实现 slice(0,-1) 得 'a/' 仍含 '/'，判为非顶层）
    expect(topLevel).toContain('a');
  });

  it('totalSize 为解压后条目长度之和，而非 zip 体积', async () => {
    const zip = zipSync({ 'f.txt': strToU8('0123456789') } as never);
    const { totalSize } = await parseGroupZip(zip);
    expect(totalSize).toBe(10);
    expect(totalSize).not.toBe(zip.length);
  });
});

// 用 fflate 的流式 Zip 构造含两个同名条目的 zip（zipSync 以对象键为名字，无法造重名）
function buildZipWithDuplicateNames(name: string, contents: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, dat) => {
    if (err) throw err;
    chunks.push(dat);
  });
  for (const content of contents) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(content, true);
  }
  zip.end();
  return concat(chunks);
}

// ============================================================ F7 / F8 / F11 序列化
describe('F27 · 服务端生成的传输数据文件名（对齐上游 Utility.CreateTimeBasedFileName）', () => {
  it('Group：File_{stamp}_{8chars}.{3chars}.zip；Text：Text_..._.txt', async () => {
    const { createNewGroupDataFileName, createNewTextDataFileName } = await import('../src/profile');
    const group = createNewGroupDataFileName();
    // 上游 CreateTimeBasedFileName = $"{DateTime.Now:yyyy-MM-dd_HH-mm-ss}_{Path.GetRandomFileName()}"，
    // 而 Path.GetRandomFileName() 形如 "abcd1234.xyz"（随机段自带一个点）
    expect(group).toMatch(/^File_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{8}\.[a-z0-9]{3}\.zip$/);
    const text = createNewTextDataFileName();
    expect(text).toMatch(/^Text_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{8}\.[a-z0-9]{3}\.txt$/);
    // 唯一性（同一秒内多次调用不得碰撞）
    expect(new Set(Array.from({ length: 50 }, () => createNewGroupDataFileName())).size).toBe(50);
  });
});

describe('F30 · 存储的当前 profile 损坏时优雅降级（对齐上游 GetSyncProfile 的两个 catch 出口）', () => {
  it('classifyStoredProfile：合法 DTO → ok；数组/标量/非法枚举名 → corrupt；字面 null → null-dto', async () => {
    const { classifyStoredProfile } = await import('../src/serialization');

    // ok：正常写入的形状，以及上游同样不抛错的形状
    for (const raw of [
      JSON.stringify({ type: 'Text', hash: 'H', text: 't', hasData: false, dataName: null }),
      // type 键缺失 → JsonSerializer 用默认 Text，不抛错
      JSON.stringify({ hash: 'H', text: 't' }),
      // JsonStringEnumConverter 接受整数枚举值与大小写不敏感的枚举名
      JSON.stringify({ type: 0 }),
      JSON.stringify({ type: 'text' }),
      JSON.stringify({ type: 'None' }),
      JSON.stringify({ type: 'Unknown' }),
    ]) {
      expect(classifyStoredProfile(raw), raw).toBe('ok');
    }

    // corrupt：反序列化抛 JsonException → 上游 catch → 空 TextProfile
    for (const raw of [
      'not json at all',
      '[]', // 数组不是 ProfileDto
      '"a string"',
      '123',
      'true',
      JSON.stringify({ type: 'Bogus' }),
      JSON.stringify({ type: 'Text,File' }), // 逗号组合不是合法枚举名
      JSON.stringify({ type: 1.5 }), // 非整数数字无法转枚举
      JSON.stringify({ type: {} }),
    ]) {
      expect(classifyStoredProfile(raw), raw).toBe('corrupt');
    }

    // null-dto：文本为字面 `null` → `Deserialize(...) ?? new ProfileDto()`
    expect(classifyStoredProfile('null')).toBe('null-dto');
  });

  it('corrupt → 空 TextProfile dto（hash=SHA256("")、size:0）；null → hash="" 且省略 size 键', async () => {
    const { profileDtoToJson } = await import('../src/serialization');
    const { textProfileHash } = await import('../src/hash');
    const { ProfileType } = await import('../src/types');

    // 上游 catch 分支：new TextProfile(string.Empty).ToProfileDto()
    const emptyWire = JSON.parse(
      profileDtoToJson({
        type: ProfileType.Text,
        hash: await textProfileHash(''),
        text: '',
        hasData: false,
        size: 0,
      }),
    ) as Record<string, unknown>;
    expect(emptyWire.size).toBe(0);
    expect(emptyWire.hash).toBe(await textProfileHash(''));
    expect(emptyWire.dataName).toBeNull();

    // 上游 `?? new ProfileDto()` 分支：Hash 为空串、Size 为 null（WhenWritingNull 省略键）
    const nullWire = JSON.parse(
      profileDtoToJson({ type: ProfileType.Text, hash: '', text: '', hasData: false }),
    ) as Record<string, unknown>;
    expect(nullWire.hash).toBe('');
    expect('size' in nullWire).toBe(false);
    expect(nullWire.dataName).toBeNull();
  });
});

describe('F31 · hash 参与 R2 key 构造时的路径字符防线（对齐上游 Profile.GetWorkingDirName）', () => {
  it('workingDirPrefix / historyKey 对含分隔符的 hash 抛错（最后防线）', async () => {
    const { workingDirPrefix, historyKey, tempKey } = await import('../src/storage');
    const { ProfileType } = await import('../src/types');

    // 合法 hash（SHA256 hex）正常构造
    expect(workingDirPrefix(ProfileType.Text, 'ABCDEF')).toBe('history/Text_ABCDEF/');
    expect(historyKey(ProfileType.File, 'ABCDEF', 'a.bin')).toBe('history/File_ABCDEF/a.bin');

    // 含 `/` 或 `\` 一律抛错：否则 key 结构会与「按第一个 / 截断工作目录名」的孤儿判定不同构
    for (const bad of ['A/B', 'A\\B', '/lead', 'trail/', 'A//B']) {
      expect(() => workingDirPrefix(ProfileType.Text, bad), bad).toThrow(/invalid path characters/);
      expect(() => historyKey(ProfileType.Text, bad, 'x'), bad).toThrow(/invalid path characters/);
    }

    // 暂存区 key 不受此限（文件名由 invalidFileName 在路由层单独校验）
    expect(tempKey('a.bin')).toBe('file/a.bin');
  });
});

describe('F7 · PATCH 非法日期在解析期被拒绝（→ 400 而非 500）', () => {
  it('非法 lastModified 抛错', () => {
    expect(() => parseHistoryRecordUpdateDto('{"lastModified":"not-a-date"}')).toThrow();
  });
  it('非法 lastAccessed 抛错', () => {
    expect(() => parseHistoryRecordUpdateDto('{"lastAccessed":"2026-13-45T99:99:99Z"}')).toThrow();
  });
  it('合法 ISO（含 +00:00 与 Z）通过', () => {
    expect(() => parseHistoryRecordUpdateDto('{"lastModified":"2026-09-12T10:20:30+00:00"}')).not.toThrow();
    expect(() => parseHistoryRecordUpdateDto('{"lastModified":"2026-09-12T10:20:30.1234567Z"}')).not.toThrow();
  });
});

describe('F8 · 非法/未知 ProfileType 被拒绝（不再静默降级为 Text）', () => {
  it('type=Bogus 抛错', () => {
    expect(() => parseProfileDto('{"type":"Bogus","hash":"H","text":"x","hasData":false}')).toThrow();
  });
  it('type=Unknown / None 抛错', () => {
    expect(() => parseProfileDto('{"type":"Unknown"}')).toThrow();
    expect(() => parseProfileDto('{"type":"None"}')).toThrow();
  });
  it('type 缺失 → Text；合法名大小写不敏感；数字枚举串可接受', () => {
    expect(parseProfileDto('{"hash":"H"}').type).toBe(ProfileType.Text);
    expect(parseProfileDto('{"type":"file"}').type).toBe(ProfileType.File);
    expect(parseProfileDto('{"type":"2"}').type).toBe(ProfileType.Image);
  });
});

describe('F11 · 空档响应含 size:0', () => {
  it('空 TextProfile dto 序列化含 size:0 与 dataName:null', () => {
    const empty: ProfileDto = { type: ProfileType.Text, hash: '', text: '', hasData: false, size: 0 };
    const parsed = JSON.parse(profileDtoToJson(empty)) as Record<string, unknown>;
    expect(parsed.size).toBe(0);
    // 上游 ProfileDto.DataName 无 JsonIgnore：无数据时输出 null（仅 Size 为 WhenWritingNull）
    expect('dataName' in parsed).toBe(true);
    expect(parsed.dataName).toBeNull();
    expect(parsed).toMatchObject({ type: 'Text', hash: '', text: '', hasData: false });
  });

  it('有数据时 dataName 存在，且 size 一并输出', () => {
    const withData: ProfileDto = {
      type: ProfileType.File, hash: 'H', text: 'a.png', hasData: true, dataName: 'a.png', size: 12,
    };
    const parsed = JSON.parse(profileDtoToJson(withData)) as Record<string, unknown>;
    expect(parsed.dataName).toBe('a.png');
    expect(parsed.size).toBe(12);
  });

  it('无存储 Profile 的空档 wire：hash=SHA256("")、size=0、dataName:null（对齐上游 ToProfileDto）', async () => {
    const dto: ProfileDto = {
      type: ProfileType.Text,
      hash: await textProfileHash(''),
      text: '',
      hasData: false,
      size: 0,
    };
    const parsed = JSON.parse(profileDtoToJson(dto)) as Record<string, unknown>;
    expect(parsed).toEqual({
      type: 'Text',
      hash: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
      text: '',
      hasData: false,
      dataName: null,
      size: 0,
    });
  });

  it('entityToProfileDto 对 inline Text 也输出 size（不再省略）', () => {
    const entity: HistoryRecordEntity = {
      userId: 'default_user', type: ProfileType.Text, text: 'hello', size: 5,
      transferDataFile: '', filePaths: [], hash: 'H', createTime: 0, lastAccessed: 0,
      lastModified: 0, stared: false, pinned: false, version: 0, isDeleted: false,
    };
    const dto = entityToProfileDto(entity);
    expect(dto.size).toBe(5);
    expect(dto.hasData).toBe(false);
    expect(JSON.parse(profileDtoToJson(dto)).size).toBe(5);
  });
});

// ============================================================ F2 / F4 / F11 服务层
describe('F2 · POST /api/history 的 Text transfer-data 语义（对齐上游）', () => {
  it('inline Text（size == 文本长度）带 data → 422（即使内容为空）', async () => {
    const db = new FakeDb();
    await expect(
      addRecordDto(
        db as never, new FakeR2() as unknown as R2Storage,
        incoming({ type: ProfileType.Text, hash: sha256('hi'), text: 'hi', size: 2 }),
        strToU8('hi'), silentNotify,
      ),
    ).rejects.toBeInstanceOf(ProfileDataInvalidError);
  });

  it('大文本（size > 文本长度）带 data 且哈希一致 → 接受并落盘', async () => {
    const db = new FakeDb();
    const storage = new FakeR2();
    const full = 'x'.repeat(11000);
    const hash = sha256(strToU8(full));
    const dto = await addRecordDto(
      db as never, storage as unknown as R2Storage,
      incoming({ type: ProfileType.Text, hash, text: 'x'.repeat(10240), size: full.length }),
      strToU8(full), silentNotify,
    );
    expect(dto.hash).toBe(hash);
    expect(dto.hasData).toBe(true);
    // F11：Size 保持全文长度（字符数），不是 UTF-8 字节数
    expect(dto.size).toBe(full.length);
    expect(db.rows[0]!.transferDataFile.endsWith('.txt')).toBe(true);
  });

  it('大文本带 data 但哈希不符 → 422', async () => {
    const db = new FakeDb();
    const full = 'y'.repeat(11000);
    await expect(
      addRecordDto(
        db as never, new FakeR2() as unknown as R2Storage,
        incoming({ type: ProfileType.Text, hash: sha256('other'), text: 'y'.repeat(10240), size: full.length }),
        strToU8(full), silentNotify,
      ),
    ).rejects.toBeInstanceOf(ProfileDataInvalidError);
  });
});

describe('F4 · PUT /SyncClipboard.json 成功后消费掉暂存对象', () => {
  it('校验通过后 file/ 暂存对象被删除；重复 PUT 同 dataName 时暂存已不存在', async () => {
    const db = new FakeDb();
    const storage = new FakeR2();
    const fileName = 'temp-payload.bin';
    const content = strToU8('payload-bytes');
    await storage.putTemp(fileName, content);
    expect(storage.hasTemp(fileName)).toBe(true);

    const dto: ProfileDto = { type: ProfileType.Text, hash: sha256(content), text: 'payload', hasData: true, dataName: fileName };
    await putSyncProfile(db as never, storage as unknown as R2Storage, dto, silentNotify);
    expect(storage.hasTemp(fileName)).toBe(false);
  });

  it('校验失败时暂存保留（与上游异常路径一致）', async () => {
    const db = new FakeDb();
    const storage = new FakeR2();
    const fileName = 'bad.bin';
    await storage.putTemp(fileName, strToU8('actual'));
    const dto: ProfileDto = { type: ProfileType.Text, hash: sha256('expected'), text: 'x', hasData: true, dataName: fileName };
    await expect(putSyncProfile(db as never, storage as unknown as R2Storage, dto, silentNotify)).rejects.toBeTruthy();
    expect(storage.hasTemp(fileName)).toBe(true);
  });
});

describe('F11 · PUT 空 hash 的 inline Text 在服务端计算哈希与 size', () => {
  it('空 hash → 存储 SHA256(文本)；size 取文本长度；重复 PUT 可命中复用分支', async () => {
    const db = new FakeDb();
    const storage = new FakeR2();
    const text = 'hello-world';
    const dto: ProfileDto = { type: ProfileType.Text, hash: '', text, hasData: false };
    await putSyncProfile(db as never, storage as unknown as R2Storage, dto, silentNotify);
    expect(db.rows[0]!.hash).toBe(sha256(text));
    expect(db.rows[0]!.size).toBe(text.length);

    // 第二次同内容 PUT（客户端带上计算好的 hash）应命中复用分支，不新建记录
    await putSyncProfile(db as never, storage as unknown as R2Storage,
      { type: ProfileType.Text, hash: sha256(text), text, hasData: false }, silentNotify);
    expect(db.rows.length).toBe(1);
    expect(db.rows[0]!.version).toBeGreaterThan(0);
  });
});

// ============================================================ F3 / F5 / F9 数据层
const schemaSql = readSchemaSql();

function makeDb() {
  const d1 = createSqliteD1(schemaSql);
  return { d1, db: new HistoryDb(d1 as unknown as D1Database) };
}

function entity(over: Partial<HistoryRecordEntity>): HistoryRecordEntity {
  const now = Date.now();
  return {
    userId: 'default_user', type: ProfileType.Text, text: 't', size: 1,
    transferDataFile: '', filePaths: [], hash: 'H', createTime: now,
    lastAccessed: now, lastModified: now, stared: false, pinned: false, version: 0,
    isDeleted: false, ...over,
  };
}

// 可注入故障的 D1：验证 insert() 只把「唯一约束冲突」当作并发合并，其余 INSERT 失败必须原样抛出。
// 用共享适配器的 `beforeStatement` 钩子（不再为此另抄一份适配器）：状态放在返回的 `fault` 上，
// 注入只针对 `run`（即 INSERT），不影响同一条用例里的查询。
function createFaultD1(): { d1: SqliteD1; fault: { error: Error | null; attempts: number } } {
  const fault: { error: Error | null; attempts: number } = { error: null, attempts: 0 };
  const d1 = createSqliteD1(schemaSql, {
    beforeStatement: (sql, op) => {
      if (op !== 'run' || fault.error === null) return;
      if (!/^\s*INSERT INTO HistoryRecords/i.test(sql)) return;
      fault.attempts++;
      throw fault.error;
    },
  });
  return { d1, fault };
}

describe('F5 · 写路径唯一约束与乐观并发', () => {
  it('(UserId,Type,Hash) 唯一索引阻止重复行；冲突时按上游 UpdateExistingRecordDto 合并元数据', async () => {
    const { db } = makeDb();
    const first = await db.insert(entity({ hash: 'ABC', text: 'one' }));
    const second = await db.insert(entity({ hash: 'ABC', text: 'two' }));
    expect(second.id).toBe(first.id);
    const list = await db.queryList({
      page: 1, types: 15, searchText: null, starred: null, sortByLastAccessed: false,
    } as never);
    expect(list.length).toBe(1);
    // 内容字段沿用既有行：同 (Type,Hash) ⇒ 同内容；上游 UpdateEntityFields 只拷元数据，
    // 不重写 Text/Size/TransferDataFile/FilePaths/Hash。
    expect(list[0]!.text).toBe('one');
    // 版本不倒退：max(incoming 0, existing 0 + 1) = 1
    expect(list[0]!.version).toBe(1);
  });

  it('非唯一约束的 INSERT 失败必须原样抛出（不再被当成冲突吞掉，F5 回归）', async () => {
    const { d1, fault } = createFaultD1();
    const db = new HistoryDb(d1 as unknown as D1Database);
    await db.insert(entity({ hash: 'K', text: 'fresh', version: 7 }));
    // 模拟"非唯一约束"的 INSERT 失败（如 D1 瞬时错误）
    fault.error = new Error('D1_ERROR: simulated transient failure');
    await expect(
      db.insert(entity({ hash: 'K', text: 'STALE', version: 0, lastModified: Date.now() - 3_600_000 })),
    ).rejects.toThrow('simulated transient failure');
    expect(fault.attempts).toBe(1);
    // 既有行未被陈旧数据覆盖
    const after = await db.getByTypeAndHash(ProfileType.Text, 'K');
    expect(after?.text).toBe('fresh');
    expect(after?.version).toBe(7);
  });

  it('真正的唯一约束冲突在 incoming 更旧时不覆盖既有行', async () => {
    const { db } = makeDb();
    const t0 = Date.now();
    await db.insert(entity({ hash: 'U', text: 'v9', version: 9, lastModified: t0 }));
    // 同 key、更旧的进入者：gap > 5 分钟 → ShouldUpdate 判定 newLastModified >= old 为假 → no-op
    const returned = await db.insert(
      entity({ hash: 'U', text: 'v0-old', version: 0, lastModified: t0 - 600_000 }),
    );
    const after = await db.getByTypeAndHash(ProfileType.Text, 'U');
    expect(returned.id).toBe(after?.id);
    expect(after?.text).toBe('v9');
    expect(after?.version).toBe(9);
  });

  it('genuine 唯一冲突且 incoming 较新时按 ShouldUpdate 合并（版本推进）', async () => {
    const { db } = makeDb();
    const t0 = Date.now();
    await db.insert(entity({ hash: 'W', text: 'old', version: 2, lastModified: t0 - 600_000 }));
    // gap = 10 分钟 > 阈值 5 分钟 → 走 LastModified 比较：t0 >= t0-600000 → true → 合并
    const returned = await db.insert(entity({ hash: 'W', text: 'newer', version: 1, lastModified: t0 }));
    const after = await db.getByTypeAndHash(ProfileType.Text, 'W');
    expect(returned.id).toBe(after?.id);
    // Math.max(incoming.Version, existing.Version + 1) = max(1, 3) = 3
    expect(after?.version).toBe(3);
    // 内容字段仍是既有行的（同 hash ⇒ 同内容）
    expect(after?.text).toBe('old');
  });

  it('updateEntityIfVersion 在版本过期时不写入（防丢更新）', async () => {
    const { db } = makeDb();
    const row = await db.insert(entity({ hash: 'V1', version: 0 }));
    const stale = { ...row, text: 'stale' };
    // 先由"另一个客户端"把版本推进
    await db.updateEntity({ ...row, version: 1, text: 'newer' });
    expect(await db.updateEntityIfVersion(stale, 0)).toBe(false);
    const fresh = await db.getByTypeAndHash(ProfileType.Text, 'V1');
    expect(fresh?.text).toBe('newer');
  });

  it('clearAll 用单条 DELETE RETURNING：返回集合与删除行一致且表被清空', async () => {
    const { db } = makeDb();
    await db.insert(entity({ hash: 'C1' }));
    await db.insert(entity({ hash: 'C2', type: ProfileType.File }));
    const removed = await db.clearAll();
    expect(removed.length).toBe(2);
    expect(removed.map((r) => r.hash).sort()).toEqual(['C1', 'C2']);
    const rest = await db.queryList({
      page: 1, types: 15, searchText: null, starred: null, sortByLastAccessed: false,
    } as never);
    expect(rest.length).toBe(0);
  });
});

describe('F3 · 历史查找不再被 LIMIT 500 截断', () => {
  it('第 600 条（LastAccessed 最旧）的记录仍能按 basename 命中', async () => {
    const { db } = makeDb();
    const base = Date.now();
    for (let i = 0; i < 600; i++) {
      await db.insert(entity({
        hash: `H${i}`, text: `t${i}`,
        transferDataFile: `payload-${i}.bin`,
        // i 越大 LastAccessed 越旧 → 目标记录排在 600 名之后
        lastAccessed: base - i * 1000,
      }));
    }
    const candidates = await db.listTransferFileCandidates('payload-599.bin');
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.hash).toBe('H599');
  });

  it('同名多记录按 LastAccessed 倒序返回全部候选（上游文件缺失时回退更旧记录的语义基础）', async () => {
    const { db } = makeDb();
    const base = Date.now();
    await db.insert(entity({ hash: 'NEW', text: 'n', transferDataFile: 'same.bin', lastAccessed: base }));
    await db.insert(entity({ hash: 'OLD', text: 'o', transferDataFile: 'same.bin', lastAccessed: base - 5000 }));
    await db.insert(entity({ hash: 'OTHER', text: 'x', transferDataFile: 'other.bin', lastAccessed: base - 9000 }));

    const candidates = await db.listTransferFileCandidates('same.bin');
    expect(candidates.map((r) => r.hash)).toEqual(['NEW', 'OLD']); // 倒序、排除不同名
  });
});

describe('F9 · 越界数值不再导致 OFFSET 类型错误', () => {
  it('超大 page 被钳制为 1，不抛 datatype mismatch', async () => {
    const { db } = makeDb();
    await db.insert(entity({ hash: 'P1' }));
    const rows = await db.queryList({
      page: Number('1e20'), types: 15, searchText: null, starred: null, sortByLastAccessed: false,
    } as never);
    expect(rows.length).toBe(1);
  });
});

// F10 的运行时行为难以断言（需要 60s 墙钟 + 真实 workerd alarm），
// 这里直接驱动 DO 的清理逻辑，确定性地锁住「静默 >60s 关闭、活跃保留」与「alarm 发心跳并重排」。
type HubInternals = {
  sseClients: Map<string, unknown>;
  lpClients: Map<string, unknown>;
  closeIdleClients(): void;
  alarm(): Promise<void>;
};

// P1（WS 迁 Hibernation API，docs/design.md D42）之后 WS 连接集合**不在内存里**：
// 集合由平台代管（`state.getWebSockets()`），每连接的 `lastSeen` 存在该连接的 attachment 里
// （`closeIdleClients` 用 `deserializeAttachment()` 读）。桩因此必须提供
// `acceptWebSocket` / `getWebSockets` / `storage.getAlarm`，否则这组用例会 TypeError
// —— 属于桩与真实接口不一致，不是被测量行为。
interface FakeSocket {
  readyState: number;
  sent: string[];
  closed: Array<[number | undefined, string | undefined]>;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  deserializeAttachment(): { lastSeen: number } | null;
}

function fakeSocket(lastSeen: number): FakeSocket {
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(message: string) {
      this.sent.push(message);
    },
    close(code?: number, reason?: string) {
      this.closed.push([code, reason]);
    },
    deserializeAttachment: () => ({ lastSeen }),
  };
}

async function makeHub(setAlarm: (t: number) => void, sockets: FakeSocket[] = []) {
  const { SyncClipboardHub } = await import('../src/durable/SyncClipboardHub');
  const storage = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => new Map<string, number>(),
    setAlarm: async (t: number) => {
      setAlarm(t);
    },
    // 心跳防重排的判据是「平台上有没有 pending alarm」（`storage.getAlarm()`）；桩里恒为「没有」。
    getAlarm: async () => null,
  };
  // 真实 DO 的 state 一定实现 blockConcurrencyWhile（本轮 F7 用它做启动期状态加载）；
  // 桩缺它会让 DO 构造抛错 —— 属于桩与真实接口不一致，不是被测量行为。
  const state = {
    storage,
    acceptWebSocket: (ws: FakeSocket) => {
      sockets.push(ws);
    },
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  return new SyncClipboardHub(state as never, {} as never) as unknown as HubInternals;
}

describe('F10 · 死连接清理（半开 TCP 不会产生 close/error 事件）', () => {
  it('closeIdleClients 关闭静默 >60s 的连接，保留活跃连接', async () => {
    const idle = fakeSocket(Date.now() - 61_000);
    const active = fakeSocket(Date.now());
    const hub = await makeHub(() => undefined, [idle, active]);

    hub.closeIdleClients();

    expect(idle.closed).toEqual([[1000, 'idle timeout']]); // 只关了静默那条
    expect(active.closed).toEqual([]);
  });

  it('alarm() 发送心跳并重排下一轮 alarm（DO 空闲时定时器冻结，靠 alarm 保活）', async () => {
    const alarms: number[] = [];
    const ws = fakeSocket(Date.now());
    const hub = await makeHub((t) => alarms.push(t), [ws]);

    await hub.alarm();

    expect(ws.sent.length).toBe(1); // SignalR keepalive ping（{"type":6}）
    expect(alarms.length).toBe(1);
    expect(alarms[0]!).toBeGreaterThan(Date.now());
  });

  it('无连接时不重排 alarm（避免空转）', async () => {
    const alarms: number[] = [];
    const hub = await makeHub((t) => alarms.push(t));
    await hub.alarm();
    expect(alarms.length).toBe(0);
  });
});

// ============ 保留与清理（cleanup.ts 数据层判别）============

describe('F18 · 历史保留与清理（对齐上游 HistoryCleaner）', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const make = (hash: string, opts: Partial<HistoryRecordEntity> = {}): HistoryRecordEntity => ({
    userId: 'default_user', type: ProfileType.Text, text: hash, size: 1,
    transferDataFile: '', filePaths: [], hash,
    createTime: now, lastAccessed: now, lastModified: now,
    stared: false, pinned: false, version: 0, isDeleted: false,
    ...opts,
  });

  it('保留期：过期且未收藏/未置顶的记录被**软删**（对齐上游 MarkForDeletionAsync），收藏/置顶/新记录保留', async () => {
    const { db } = makeDb();
    const old = now - 8 * DAY;
    await db.insert(make('OLD', { lastModified: old, lastAccessed: old }));
    await db.insert(make('OLDSTAR', { lastModified: old, lastAccessed: old, stared: true }));
    await db.insert(make('OLDDEAD', { lastModified: old, lastAccessed: old, isDeleted: true }));
    await db.insert(make('NEW'));

    const removed = await db.softDeleteExpiredRecords(now - 7 * DAY, now, 100);
    expect(removed.map((r: HistoryRecordEntity) => r.hash)).toEqual(['OLD']);

    // 行仍保留（软删）：IsDeleted=1、Version 自增、LastModified 刷新为 now
    const row = await db.getByTypeAndHash(ProfileType.Text, 'OLD');
    expect(row).not.toBeNull();
    expect(row!.isDeleted).toBe(true);
    expect(row!.version).toBe(1);
    expect(row!.lastModified).toBe(now);
    // 收藏/置顶/已删除/新记录不受影响
    expect((await db.getByTypeAndHash(ProfileType.Text, 'OLDSTAR'))!.isDeleted).toBe(false);
    expect((await db.getByTypeAndHash(ProfileType.Text, 'NEW'))!.isDeleted).toBe(false);
  });

  it('条数上限：软删最旧的非收藏/非置顶记录（收藏与置顶豁免）', async () => {
    const { db } = makeDb();
    await db.insert(make('A', { lastModified: now - 3000, lastAccessed: now - 3000 }));
    await db.insert(make('B', { lastModified: now - 2000, lastAccessed: now - 2000, stared: true }));
    await db.insert(make('C', { lastModified: now - 1000, lastAccessed: now - 1000 }));

    const trimmed = await db.trimToMaxCount(1, now);
    expect(trimmed.map((r) => r.hash)).toEqual(['A']); // 最旧且未被豁免
    expect(await db.countActiveRecords()).toBe(2); // B(收藏) 与 C 保留
  });

  it('已删除记录硬删：仅超 30 天的 IsDeleted 行', async () => {
    const { db } = makeDb();
    await db.insert(make('DELOLD', { isDeleted: true, lastModified: now - 31 * DAY }));
    await db.insert(make('DELNEW', { isDeleted: true, lastModified: now - 1 * DAY }));

    const hard = await db.hardDeleteOldDeletedRecords(now - 30 * DAY, 100);
    expect(hard.map((r) => r.hash)).toEqual(['DELOLD']);
  });

  it('listReferencedWorkingDirs 返回**全部**记录（含已删除）的目录，且**带尾斜杠**（与 R2 列出的目录名同形）', async () => {
    const { db } = makeDb();
    await db.insert(make('KEEP'));
    await db.insert(make('GONE', { isDeleted: true }));
    const dirs = await db.listReferencedWorkingDirs();
    // 尾斜杠不是风格问题：cleanup 用它和 R2Storage.listHistoryObjectsByDir()（由 R2 key 截取，
    // 形如 `Text_KEEP/`）做集合比较。形式不一致 → has() 恒 false → 全部历史数据被当孤儿删除。
    expect(dirs.has('Text_KEEP/')).toBe(true);
    // 2026-09-22（ADR D29）：已删除的记录**必须**算"有人引用" —— 真回收站保留它的数据目录，
    // 漏掉它等于孤儿阶段每 20 分钟把回收站里的数据删一次（行还在、数据没了，最难看的那种坏法）。
    expect(dirs.has('Text_GONE/')).toBe(true);
  });

// F19 独立顶层套件（不嵌在 F18 内）
});

// 内存 R2Bucket：只需 R2Storage 用到的那部分（put/get/delete/list），用于驱动**真实** R2Storage，
// 从而覆盖 key 构造与前缀截取（本次缺陷正在这一层，替换 R2Storage 的 stub 无法发现）。
class FakeBucket {
  // 存**字节**（不是只存 size）：`GET /file/{name}` 这类用例要断言回退后拿到的内容，
  // 而 `get()` 必须能交出可读的 body（`new Response(obj.body)` 需要真正的流）。
  objects = new Map<string, Uint8Array>();

  async put(key: string, body: unknown): Promise<void> {
    const bytes =
      body instanceof Uint8Array
        ? body
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(0);
    this.objects.set(key, bytes);
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.length, body: new Blob([bytes]).stream() };
  }
  async delete(keyOrKeys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) this.objects.delete(k);
  }
  async list(opts: { prefix?: string; cursor?: string } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const slice = keys.slice(start, start + 1000);
    const next = start + slice.length;
    return {
      objects: slice.map((k) => ({ key: k, size: this.objects.get(k)?.length ?? 0 })),
      truncated: next < keys.length,
      cursor: String(next),
    };
  }
}

// 广播用的 HUB stub（runCleanup 会对软删记录广播；失败被吞，但需可调用）
const hubStub = () => ({
  idFromName: () => 'hub',
  get: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
});

describe('F33 · 孤儿目录清理不得误删活跃记录的数据（键形式必须同构）', () => {
  it('runCleanup：活跃记录与**已软删记录**的数据保留；真孤儿被清', async () => {
    const d1 = createSqliteD1(schemaSql);
    const db = new HistoryDb(d1 as unknown as D1Database);
    const bucket = new FakeBucket();
    const storage = new RealR2Storage(bucket as unknown as R2Bucket);
    const now = Date.now();
    const rec = (hash: string, over: Partial<HistoryRecordEntity> = {}): HistoryRecordEntity => ({
      userId: 'default_user', type: ProfileType.File, text: `${hash}.bin`, size: 3,
      transferDataFile: `${hash}.bin`, filePaths: [`${hash}.bin`], hash,
      createTime: now, lastAccessed: now, lastModified: now,
      stared: false, pinned: false, version: 0, isDeleted: false, ...over,
    });

    // ① 活跃记录 + 其数据（必须保留）
    await db.insert(rec('KEEP1'));
    await storage.putHistory(ProfileType.File, 'KEEP1', 'KEEP1.bin', new Uint8Array([1, 2, 3]));
    // ② 真孤儿目录（无任何记录引用）
    await storage.putHistory(ProfileType.File, 'ORPHAN9', 'gone.bin', new Uint8Array([9]));
    // ③ 已软删记录的目录 —— **必须保留**（2026-09-22，ADR D29）：真回收站里那行还在，
    //    它就引用着这份数据；孤儿阶段若按"只算活跃记录"求差集，会每 20 分钟把回收站的数据删一次
    //    （行还在、数据没了 —— 用户会先撞上它。`/ui/api/integrity` **只扫活跃记录**
    //      （`src/ui/maintenance.ts` 的 `listActiveRecordsWithData`，`IsDeleted = 0`），
    //      所以回收站里这一档它查不出来 —— 别在别处写成"自检能查出来"）。
    await db.insert(rec('DEL1', { isDeleted: true }));
    await storage.putHistory(ProfileType.File, 'DEL1', 'DEL1.bin', new Uint8Array([8]));

    const env = {
      DB: d1, R2: bucket, HUB: hubStub(),
      MAX_SAVED_HISTORY_COUNT: '1000', HISTORY_RETENTION_MINUTES: '10080',
    } as unknown as Bindings;

    const result = await runCleanup(env);

    // 关键断言：活跃记录的数据**必须还在**（修复前被当成孤儿删除 → 每小时清空一次 history/）
    expect(bucket.objects.has('history/File_KEEP1/KEEP1.bin'), '活跃记录的数据被误删').toBe(true);
    expect(await storage.getHistory(ProfileType.File, 'KEEP1', 'KEEP1.bin')).toBeTruthy();

    // 已软删（回收站里）记录的数据**同样必须还在**，只有真孤儿被清
    expect(bucket.objects.has('history/File_DEL1/DEL1.bin'), '回收站记录的数据被当孤儿删了').toBe(true);
    expect(bucket.objects.has('history/File_ORPHAN9/gone.bin')).toBe(false);
    expect(result.orphans).toBe(1);
  });
});

describe('F22 · GET /file 在最新同名记录的数据缺失时回退到更旧的同名记录（上游 File.Exists 过滤语义）', () => {
  // 为什么这条在单元层（而不是 HTTP 层）：构造"最新那条同名记录的对象**真的缺失**"必须绕过写路径 ——
  // 2026-09-22（ADR D29）起软删不再清数据目录，公开 API 已经造不出这种记录（这正是它的价值：
  // "行在、数据不在"只可能来自历史事故或被别处动过的存储）。所以这里用假桶把新记录的对象删掉，
  // 再走**真实路由**（`createWebdavRoutes`）验证回退仍然发生。
  it('新记录的对象缺失 → 回退并返回旧记录的内容', async () => {
    const d1 = createSqliteD1(schemaSql);
    const db = new HistoryDb(d1 as unknown as D1Database);
    const bucket = new FakeBucket();
    const storage = new RealR2Storage(bucket as unknown as R2Bucket);
    const name = 'same-name.bin';
    const now = Date.now();
    const rec = (hash: string, lastAccessed: number, content: string): HistoryRecordEntity => ({
      userId: 'default_user', type: ProfileType.File, text: name, size: content.length,
      transferDataFile: name, filePaths: [name], hash,
      createTime: now, lastAccessed, lastModified: now,
      stared: false, pinned: false, version: 0, isDeleted: false,
    });

    // 旧的（LastAccessed 更早）+ 新的（更晚）同名记录；只有**旧的**那份数据在桶里
    await db.insert(rec('OLD1', now - 60_000, 'old-content'));
    await db.insert(rec('NEW1', now, 'new-content'));
    await storage.putHistory(ProfileType.File, 'OLD1', name, new Uint8Array(Buffer.from('old-content')));

    const env = { DB: d1, R2: bucket, HUB: hubStub() } as unknown as Bindings;
    const res = await createWebdavRoutes().request(`/file/${name}`, {}, env);

    expect(res.status, '回退到旧记录（修复前：命中新记录后对象缺失 → 直接 404）').toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('old-content');
  });
});



describe('F21 · 附件响应加固（同源存储型 XSS 面）', () => {
  it('默认-deny 内联白名单：白名单可内联、其余强制下载；可渲染类型另加 CSP 沙箱', async () => {
    const { fileHeaders, contentTypeOf } = await import('../src/contentTypes');

    // ① 可渲染（HTML/XML 家族，按**后缀**判定）→ 强制下载 + CSP 沙箱
    for (const name of ['evil.html', 'page.xhtml', 'vec.svg', 'doc.xml', 'feed.rss', 'x.atom', 's.shtml']) {
      const h = fileHeaders(name);
      expect(h.get('x-content-type-options'), name).toBe('nosniff');
      expect(h.get('content-disposition'), name).toContain('attachment');
      expect(h.get('content-security-policy'), name).toContain("default-src 'none'");
    }

    // ② 内联白名单（图片除 svg / 纯文本 / json / pdf）→ 不加 disposition，由调用方决定 inline
    for (const name of ['a.png', 'b.jpg', 'd.txt', 'e.md', 'f.csv', 'g.json', 'h.pdf']) {
      const h = fileHeaders(name);
      expect(h.get('x-content-type-options'), name).toBe('nosniff');
      expect(h.get('content-disposition'), name).toBeNull(); // 可内联查看
      expect(h.get('content-security-policy'), name).toBeNull();
    }

    // ③ 非白名单（压缩包 / Office / 未知）→ 强制下载，但**不**加 CSP（不是可渲染类型）。
    //    ⚠️ 2026-09-21：`.zip` 从「无 disposition」改成「attachment」—— 策略由"可渲染黑名单"改成
    //    "默认-deny 内联白名单"；决定、差集与读数见 docs/progress.md §106。
    for (const name of ['c.zip', 'i.docx', 'j.7z', 'k.bin', 'noext']) {
      const h = fileHeaders(name);
      expect(h.get('x-content-type-options'), name).toBe('nosniff');
      expect(h.get('content-disposition'), name).toContain('attachment');
      expect(h.get('content-security-policy'), name).toBeNull();
    }

    // ④ 未知类型回退 octet-stream；**补遗表**覆盖 mrmime 未收录的类型（`.docx` 正是其中之一，
    //    只引 mrmime 会让它退步成 octet-stream）
    expect(contentTypeOf('noext')).toBe('application/octet-stream');
    expect(contentTypeOf('i.docx')).not.toBe('application/octet-stream');
  });

  it('已知大小时带 content-length；未知时省略', async () => {
    const { fileHeaders } = await import('../src/contentTypes');
    expect(fileHeaders('a.png', 1234).get('content-length')).toBe('1234');
    expect(fileHeaders('a.png').get('content-length')).toBeNull();
  });
});

describe('F20 · 借鉴同类项目审计的加固（原型链 / 配置诊断 / 常量时间比较）', () => {
  it('contentTypeOf 不受原型链影响：x.constructor 回退 octet-stream，正常扩展仍生效', async () => {
    const { contentTypeOf } = await import('../src/contentTypes');
    // 修复前（2026-09-15 之前）：`CONTENT_TYPES['constructor']` 命中 `Object.prototype.constructor`
    // （函数）→ 非法头。
    // 2026-09-21 换 mrmime 后，这个风险**换了载体但没消失**：`mimes` 同样是普通对象字面量，
    // 实测 `lookup('x.constructor')` 就返回那个函数 ⇒ 本模块**不用它的 `lookup()`**，自己走
    // `Object.hasOwn`。本条判据因此仍然承重，别因为"表换成库了"就删掉。
    for (const evil of ['x.constructor', 'a.tostring', 'b.valueof', 'c.__proto__', 'd.hasownproperty']) {
      expect(contentTypeOf(evil), evil).toBe('application/octet-stream');
    }
    expect(contentTypeOf('a.zip')).toBe('application/zip');
    expect(contentTypeOf('a.png')).toBe('image/png');
    expect(contentTypeOf('noext')).toBe('application/octet-stream');
  });

  it('凭据未配置时给出可诊断的 500（而非静默 401）', async () => {
    const { isAuthConfigured, authFailure } = await import('../src/auth');
    const unconfigured = {} as never;
    expect(isAuthConfigured(unconfigured)).toBe(false);
    const res = authFailure(unconfigured, new Request('https://x/'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    expect(await res!.text()).toContain('USERNAME and PASSWORD');

    const empty = { USERNAME: '', PASSWORD: '' } as never;
    expect(isAuthConfigured(empty)).toBe(false);

    const configured = { USERNAME: 'u', PASSWORD: 'p' } as never;
    expect(isAuthConfigured(configured)).toBe(true);
    // 配好了但凭据不对 → 401（带 WWW-Authenticate）
    const denied = authFailure(configured, new Request('https://x/'));
    expect(denied!.status).toBe(401);
    // 注：node 的 Headers.get 对 WWW-Authenticate 有大小写查找怪癖，用 entries 判定更可靠
    const wwwAuth = [...denied!.headers.entries()].find(([k]) => k.toLowerCase() === 'www-authenticate');
    expect(wwwAuth?.[1]).toContain('Basic');
  });

  it('checkBasicAuth：正确凭据通过、错误/长度不符/空头拒绝、UTF-8 凭据可解析', async () => {
    const { checkBasicAuth } = await import('../src/auth');
    const env = { USERNAME: 'user', PASSWORD: 'pass' } as never;
    const hdr = (v: string) => new Request('https://x/', { headers: { Authorization: v } });
    expect(checkBasicAuth(env, hdr('Basic ' + btoa('user:pass')))).toBe(true);
    expect(checkBasicAuth(env, hdr('basic ' + btoa('user:pass')))).toBe(true); // scheme 大小写不敏感
    expect(checkBasicAuth(env, hdr('Basic ' + btoa('user:wrong')))).toBe(false);
    expect(checkBasicAuth(env, hdr('Basic ' + btoa('userx:pass')))).toBe(false); // 长度不同
    expect(checkBasicAuth(env, hdr('Bearer abc'))).toBe(false);
    expect(checkBasicAuth(env, new Request('https://x/'))).toBe(false);
    expect(checkBasicAuth(env, hdr('Basic !!!not-base64!!!'))).toBe(false);
    // 非 ASCII 密码按 UTF-8 解码（atob 为 latin1，须转码）
    const utf8Env = { USERNAME: '用户', PASSWORD: '密码' } as never;
    const utf8Header = 'Basic ' + Buffer.from('用户:密码', 'utf8').toString('base64');
    expect(checkBasicAuth(utf8Env, hdr(utf8Header))).toBe(true);
  });
});

describe('F19 · Text transfer data 语义对齐上游（复用文件名 / Size / FilePaths / 有效性）', () => {
  it('大文本带 data 新建：生成 Text_*.txt 名并落盘，FilePaths=[该名]', async () => {
    const db = new FakeDb();
    const storage = new FakeR2();
    const full = 'w'.repeat(11000);
    const hash = sha256(strToU8(full));
    await addRecordDto(
      db as never, storage as unknown as R2Storage,
      incoming({ type: ProfileType.Text, hash, text: 'w'.repeat(10240), size: full.length }),
      strToU8(full), silentNotify,
    );
    const row = db.rows[0]!;
    expect(row.transferDataFile.endsWith('.txt')).toBe(true);
    expect(row.filePaths).toEqual([row.transferDataFile]);
    expect(storage.objects.has(`history/Text_${hash}/${row.transferDataFile}`)).toBe(true);
  });

  it('已删除 Text 记录带 data 复活：复用原 transferDataFile（上游 _transferDataName ?? 生成）', async () => {
    const db = new FakeDb();
    const storage = new FakeR2();
    const full = 'q'.repeat(11000);
    const hash = sha256(strToU8(full));
    const rec = (over = {}) => incoming({ type: ProfileType.Text, hash, text: 'q'.repeat(10240), size: full.length, ...over });

    await addRecordDto(db as never, storage as unknown as R2Storage, rec(), strToU8(full), silentNotify);
    const originalName = db.rows[0]!.transferDataFile;
    db.rows[0]!.isDeleted = true; // 模拟 PATCH isDelete（数据已被清理）

    await addRecordDto(db as never, storage as unknown as R2Storage, rec({ version: 5 }), strToU8(full), silentNotify);
    expect(db.rows[0]!.transferDataFile).toBe(originalName); // 复用而非新随机名
    expect(db.rows[0]!.isDeleted).toBe(false);
    expect(storage.objects.has(`history/Text_${hash}/${originalName}`)).toBe(true);
  });

  it('POST 路径 Size 用声明值（缺失/非法 → 0）；**不**回落到读文件', async () => {
    // 上游依据：`ProfilePersistentInfo.Size` 是 `required long`（非空），
    // `TextProfile(ProfilePersistentInfo)` 赋值 `Size = entity.Size` → `GetSize()` 原样返回，
    // 永不触发 ComputeSize。POST 的 size 来自 `ParseLong(metadata,"size")`，缺失/非法即 0。
    // （读文件的回落只存在于 PUT 路径：`TextProfile(ProfileDto)` 的 Size 可为 null。）
    const db = new FakeDb();
    const full = '你'.repeat(11000); // 字符数 11000，UTF-8 字节数 33000
    const hash = sha256(strToU8(full));
    await addRecordDto(
      db as never, new FakeR2() as unknown as R2Storage,
      incoming({ type: ProfileType.Text, hash, text: '你'.repeat(10240), size: 0 }),
      strToU8(full), silentNotify,
    );
    expect(db.rows[0]!.size).toBe(0);
  });

  it('POST 路径 File/Image 的 Size 取实际写入字节数（忽略声明的 size）', async () => {
    // 上游依据：`FileProfile(ProfilePersistentInfo)` 不设置 Size（保持 null）→
    // Persist 时 GetSize 走 ComputeSize → FileInfo(FullPath).Length = 实际文件长度。
    const db = new FakeDb();
    const name = 'real-size.bin';
    const content = strToU8('0123456789'); // 10 字节
    const hash = sha256(`${name}|${sha256(content)}`);
    const dto = await addRecordDto(
      db as never, new FakeR2() as unknown as R2Storage,
      incoming({ type: ProfileType.File, hash, text: name, size: 999999 }),
      content, silentNotify,
    );
    expect(dto.size).toBe(10);
    expect(db.rows[0]!.size).toBe(10);
  });

  it('size > 文本长度但无 transfer data → 拒绝（上游 3.3.0 #413 起文案为 Local data is missing…）', async () => {
    // 上游 `IsLocalDataValid(false)` 的 HasTransferData（Size > Text.Length）为真而文件不存在 ⇒ 拒绝。
    // 文案随 3.3.0 从 `Needs tranfer data.` 换成 `Local data is missing or does not match the profile hash.`
    //（`Needs tranfer data.` 只保留在「既有记录、无 data」的 EnsureExistingRecordData 路径上）。
    const db = new FakeDb();
    await expect(
      addRecordDto(
        db as never, new FakeR2() as unknown as R2Storage,
        incoming({ type: ProfileType.Text, hash: sha256('anything'), text: 'short', size: 99999 }),
        null, silentNotify,
      ),
    ).rejects.toThrow(/Local data is missing or does not match the profile hash/);
  });

  it('inline Text（size == 文本长度）无 data → 正常入库', async () => {
    const db = new FakeDb();
    const text = 'inline-only';
    const dto = await addRecordDto(
      db as never, new FakeR2() as unknown as R2Storage,
      incoming({ type: ProfileType.Text, hash: sha256(text), text, size: text.length }),
      null, silentNotify,
    );
    expect(dto.hasData).toBe(false);
    expect(db.rows[0]!.transferDataFile).toBe('');
  });
});

// ============ D29（2026-09-22 审核补）：软删语义必须在**所有**写路径上一致 ============
//
// 背景：ADR D29 把「软删即删数据目录」改成「保留到真的没了那一刻」。当天只改了 PATCH 路径
// （`historyOps.applyHistoryUpdate`），而 `POST /api/history`（`profile.addRecordDto`，上游
// `HistoryService.cs:328/387` 的忠实移植）仍在软删时清目录 ⇒ 经 POST 软删的记录进回收站后
// **没有数据**，"回收站要能连数据拿回来"对那条路径不成立。
// 两条用例分别钉住修好后的语义（都在内存 stub 上跑：node:sqlite + FakeBucket，不碰 dev 库）：
//   ① `purgeTrash`（清空回收站）：单语句 `DELETE … RETURNING Type, Hash` ⇒ 删掉的行与要清扫的目录
//      是**同一集合**。此前写成 SELECT + 独立 DELETE，两者之间的间隙正好会**多删**：期间被恢复成
//      活跃的记录躲过了 DELETE（行还在），却仍在 SELECT 的名单里 ⇒ 照单清扫会删掉它的数据；
//   ② `POST /api/history` 带 `isDeleted=true`：只标记删除，不动 R2。

describe('D29 · purgeTrash：只删已删除的行，并按同一集合清扫 R2', () => {
  it('清空回收站：删行 + 清掉它们的数据目录；**活跃记录的数据不动**', async () => {
    const d1 = createSqliteD1(schemaSql);
    const db = new HistoryDb(d1 as unknown as D1Database);
    const bucket = new FakeBucket();
    const storage = new RealR2Storage(bucket as unknown as R2Bucket);
    const env = { DB: d1, R2: bucket, HUB: hubStub() } as unknown as Bindings;
    const now = Date.now();
    const rec = (hash: string, over: Partial<HistoryRecordEntity> = {}): HistoryRecordEntity => ({
      userId: 'default_user',
      type: ProfileType.File,
      text: `${hash}.bin`,
      size: 3,
      transferDataFile: `${hash}.bin`,
      filePaths: [`${hash}.bin`],
      hash,
      createTime: now,
      lastAccessed: now,
      lastModified: now,
      stared: false,
      pinned: false,
      version: 0,
      isDeleted: false,
      ...over,
    });

    await db.insert(rec('KEEP3'));
    await storage.putHistory(ProfileType.File, 'KEEP3', 'KEEP3.bin', new Uint8Array([1]));
    await db.insert(rec('TRASH1', { isDeleted: true }));
    await storage.putHistory(ProfileType.File, 'TRASH1', 'TRASH1.bin', new Uint8Array([2]));
    await db.insert(rec('TRASH2', { isDeleted: true }));
    await storage.putHistory(ProfileType.File, 'TRASH2', 'TRASH2.bin', new Uint8Array([3]));

    const deleted = await purgeTrash(env);
    expect(deleted, '只数回收站里那两条').toBe(2);

    expect(bucket.objects.has('history/File_TRASH1/TRASH1.bin'), '回收站记录的数据必须被清掉').toBe(false);
    expect(bucket.objects.has('history/File_TRASH2/TRASH2.bin'), '回收站记录的数据必须被清掉').toBe(false);
    expect(bucket.objects.has('history/File_KEEP3/KEEP3.bin'), '活跃记录的数据**不得**被清').toBe(true);
    expect(await db.getByTypeAndHash(ProfileType.File, 'KEEP3'), '活跃记录的行还在').not.toBeNull();
    expect(await db.getByTypeAndHash(ProfileType.File, 'TRASH1'), '已删记录的行没了').toBeNull();
    expect(await db.getByTypeAndHash(ProfileType.File, 'TRASH2'), '已删记录的行没了').toBeNull();
  });
});

describe('D29 · POST /api/history 的软删同样保留数据（三条写路径同一语义）', () => {
  it('带 isDeleted=true 的 POST 只标记删除，**不**清 R2 目录', async () => {
    const d1 = createSqliteD1(schemaSql);
    const db = new HistoryDb(d1 as unknown as D1Database);
    const bucket = new FakeBucket();
    const storage = new RealR2Storage(bucket as unknown as R2Bucket);
    const env = { DB: d1, R2: bucket, HUB: hubStub() } as unknown as Bindings;
    const now = Date.now();
    const name = 'post-soft.bin';
    await db.insert({
      userId: 'default_user',
      type: ProfileType.File,
      text: name,
      size: 5,
      transferDataFile: name,
      filePaths: [name],
      hash: 'POST1',
      createTime: now,
      lastAccessed: now,
      lastModified: now,
      stared: false,
      pinned: false,
      version: 0,
      isDeleted: false,
    });
    await storage.putHistory(ProfileType.File, 'POST1', name, new Uint8Array([1, 2, 3, 4, 5]));

    // 与官方客户端同形：multipart 表单（字段名大小写不敏感），**不带** data 部分
    // （即"只改元数据"的那条分支 —— 上游 `UpdateExistingRecordDto`）。
    const form = new FormData();
    form.set('type', 'File');
    form.set('hash', 'POST1');
    form.set('text', name);
    form.set('isDeleted', 'true');
    form.set('version', '10000');
    form.set('lastModified', new Date(now).toISOString());
    const res = await createHistoryRoutes().request('/api/history', { method: 'POST', body: form }, env);
    expect(res.status, 'POST /api/history').toBe(200);

    const after = await db.getByTypeAndHash(ProfileType.File, 'POST1');
    expect(after?.isDeleted, '行被标记为已删除（进回收站）').toBe(true);
    expect(
      bucket.objects.has(`history/File_POST1/${name}`),
      '数据必须留下 —— 修复前这里被 DeleteProfileDataIfNeed 等价逻辑删掉，回收站里那条就永远没有数据了',
    ).toBe(true);
  });
});
