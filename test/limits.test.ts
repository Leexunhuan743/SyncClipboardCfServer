// F9（资源放大面）中两类的封顶验证（multipart 分界串 / Group zip 解压）：
//  1) multipart：>70 字节的分界串（RFC 2046 上限）不进解构、路由 400；查找不再随分界串长度劣化
//  2) Group zip：总量 / 条目数 / 压缩比 三条上限在**解压过程中**生效——超限立即中止，
//     不写入任何存储对象（旧实现按声明尺寸一次性物化，可在哈希校验前膨胀 ~1000 倍）
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8, Zip, ZipPassThrough } from 'fflate';
import { MAX_BOUNDARY_LENGTH, parseBoundary, parseMultipart } from '../src/multipart';
import {
  GROUP_ZIP_MAX_COMPRESSION_RATIO,
  GROUP_ZIP_MAX_ENTRIES,
  GROUP_ZIP_MAX_TOTAL_BYTES,
  InvalidGroupDataError,
  groupHashFromEntries,
  parseGroupZip,
} from '../src/hash';
import {
  BadRequestError,
  ProfileDataInvalidError,
  addRecordDto,
  putSyncProfile,
  validateAndPersistData,
} from '../src/profile';
import { ProfileType } from '../src/types';
import type { ProfileDto } from '../src/types';
import type { IncomingRecord, NotifyHandlers } from '../src/profile';
import type { R2Storage } from '../src/storage';
import { createHistoryRoutes } from '../src/routes/history';
import type { Bindings } from '../src/env';

const CRLF = '\r\n';
const BOUNDARY_61 = 'b'.repeat(61);
const BOUNDARY_2048 = 'x'.repeat(2048);

// 与官方客户端（.NET MultipartFormDataContent，无引号 name）形状一致的请求体
function multipartBody(boundary: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}${CRLF}Content-Disposition: form-data; name=hash${CRLF}${CRLF}ABC` +
      `${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name=data; filename=x.bin${CRLF}${CRLF}`,
  );
  const tail = enc.encode(`${CRLF}--${boundary}--${CRLF}`);
  const out = new Uint8Array(head.length + payload.length + tail.length);
  out.set(head, 0);
  out.set(payload, head.length);
  out.set(tail, head.length + payload.length);
  return out;
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// 确定性伪随机内容（golden 夹具需要与改前完全同字节的输入）
function pseudoRandom(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// 流式写入的同名重复条目 zip：局部头无尺寸、带数据描述符（.NET/fflate 流式写入的形状）
function streamedDuplicateZip(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, dat) => {
    if (err) throw err;
    chunks.push(dat);
  });
  for (const content of [strToU8('AAA'), strToU8('BBB')]) {
    const entry = new ZipPassThrough('dup.txt');
    zip.add(entry);
    entry.push(content, true);
  }
  zip.end();
  return concat(chunks);
}

// 只记录写入的对象；校验失败时应当一次都没有
class RecordingStorage {
  writes: { type: ProfileType; hash: string; fileName: string; body: Uint8Array }[] = [];
  temp: Uint8Array | null = null;

  async getTemp(_name: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const temp = this.temp;
    return temp ? { arrayBuffer: async () => temp.slice().buffer } : null;
  }

  async putHistory(type: ProfileType, hash: string, fileName: string, body: Uint8Array): Promise<void> {
    this.writes.push({ type, hash, fileName, body });
  }
}

const silentNotify: NotifyHandlers = {
  notifyProfile: () => undefined,
  notifyHistory: () => undefined,
};

function incomingGroup(): IncomingRecord {
  const now = Date.now();
  return {
    type: ProfileType.Group,
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
  };
}

function groupDto(): ProfileDto {
  return { type: ProfileType.Group, hash: '', text: '', hasData: true, dataName: 'File_x.zip' };
}

describe('F9 · multipart 分界串封顶', () => {
  it('71 字节分界串 → 不进入解构（parseBoundary 判为无合法 boundary，路由据此 400）', () => {
    const boundary = 'b'.repeat(MAX_BOUNDARY_LENGTH + 1);
    expect(parseBoundary(`multipart/form-data; boundary=${boundary}`)).toBeNull();
    // 直接调用解析器也必须拒绝，且给出可诊断消息
    expect(() => parseMultipart(multipartBody(boundary, new Uint8Array(16)), boundary)).toThrow(
      /boundary exceeds 70 bytes/,
    );
    // 上限值本身（70 字节）合法——上限含端点
    const maxLen = 'b'.repeat(MAX_BOUNDARY_LENGTH);
    expect(parseBoundary(`multipart/form-data; boundary="${maxLen}"`)).toBe(maxLen);
    const parsed = parseMultipart(multipartBody(maxLen, strToU8('payload')), maxLen);
    expect(parsed.get('hash')).toBe('ABC');
    expect(parsed.data?.content.length).toBe(7);
  });

  it('61 字节分界串正常解析（文本字段 + 文件部分）', () => {
    const payload = new Uint8Array(64 * 1024).fill(0x41);
    const parsed = parseMultipart(multipartBody(BOUNDARY_61, payload), BOUNDARY_61);
    expect(parsed.get('hash')).toBe('ABC');
    expect(parsed.get('data')).toBe(''); // 文件部分不解码为文本（data 的 text 恒为空串）
    expect(parsed.dataPresent).toBe(true);
    expect(parsed.data?.content.length).toBe(payload.length);
    expect(parseBoundary(`multipart/form-data; boundary=${BOUNDARY_61}`)).toBe(BOUNDARY_61);
  });

  it('POST /api/history 带 71 字节分界串 → 400（真实路由路径）', async () => {
    const app = createHistoryRoutes();
    const res = await app.request(
      '/api/history',
      {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${'b'.repeat(71)}` },
        body: '--x--',
      },
      {} as Bindings,
    );
    expect(res.status).toBe(400);
  });

  it('2048 字节分界串不再拖慢同一请求体：拒绝路径为常数时间（宽松阈值防 flaky）', () => {
    const body = multipartBody(BOUNDARY_61, new Uint8Array(64 * 1024));
    const longContentType = `multipart/form-data; boundary=${BOUNDARY_2048}`;
    // 预热（JIT + 编码缓存）
    parseMultipart(body, BOUNDARY_61);
    expect(parseBoundary(longContentType)).toBeNull();

    const t61 = timeMs(() => {
      parseMultipart(body, BOUNDARY_61);
    });
    let rejected: string | null = 'unset';
    const tLong = timeMs(() => {
      rejected = parseBoundary(longContentType);
    });

    expect(rejected).toBeNull(); // 超长分界串不进入解构
    console.log(`[F9 计时] 64KB 体 61 字节分界串解析=${t61.toFixed(2)}ms；2048 字节分界串拒绝=${tLong.toFixed(3)}ms`);
    // 旧实现会在 64KB 体上按 2048 字节分界串做朴素查找（审计实测 267ms / 同体 61 字节 48ms）
    expect(tLong).toBeLessThan(25);
    expect(tLong).toBeLessThanOrEqual(t61 * 5 + 25);
    expect(t61).toBeLessThan(50);
  });
});

describe('F9 · Group zip 解压封顶', () => {
  it('压缩比超限（16MiB 零字节 → ~16KB）在解压中途中止，且未写入任何对象', async () => {
    const bomb = zipSync({ 'bomb.bin': new Uint8Array(16 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(8 * 1024 * 1024); // 放大 1000 倍量级的"成本在哈希校验前"
    expect(() => parseGroupZip(bomb)).toThrow(InvalidGroupDataError);
    expect(() => parseGroupZip(bomb)).toThrow(
      new RegExp(`exceeds the ${GROUP_ZIP_MAX_COMPRESSION_RATIO}:1 compression ratio`),
    );

    const storage = new RecordingStorage();
    await expect(
      validateAndPersistData(storage as unknown as R2Storage, groupDto(), 'File_bomb.zip', bomb),
    ).rejects.toBeInstanceOf(InvalidGroupDataError);
    expect(storage.writes).toHaveLength(0);
  });

  it('解压总量超上限（65 × 1MiB 条目）中止，且未写入任何对象', async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 65; i++) entries[`part${i}.bin`] = new Uint8Array(1024 * 1024);
    const bomb = zipSync(entries, { level: 1 });
    expect(bomb.length).toBeLessThan(1024 * 1024); // 上传体量很小
    expect(GROUP_ZIP_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024);
    expect(() => parseGroupZip(bomb)).toThrow(new RegExp(`expands beyond ${GROUP_ZIP_MAX_TOTAL_BYTES} bytes`));

    const storage = new RecordingStorage();
    await expect(
      validateAndPersistData(storage as unknown as R2Storage, groupDto(), 'File_parts.zip', bomb),
    ).rejects.toBeInstanceOf(InvalidGroupDataError);
    expect(storage.writes).toHaveLength(0);
  });

  it('条目数超上限（1001）中止；1000 条仍可通过', () => {
    const make = (count: number): Uint8Array => {
      const entries: Record<string, Uint8Array> = {};
      for (let i = 0; i < count; i++) entries[`f${i}.txt`] = strToU8('x');
      return zipSync(entries);
    };
    expect(() => parseGroupZip(make(GROUP_ZIP_MAX_ENTRIES + 1))).toThrow(
      new RegExp(`more than ${GROUP_ZIP_MAX_ENTRIES} entries`),
    );
    const atLimit = parseGroupZip(make(GROUP_ZIP_MAX_ENTRIES));
    expect(atLimit.entries.filter((e) => !e.isDir)).toHaveLength(GROUP_ZIP_MAX_ENTRIES);
    expect(atLimit.totalSize).toBe(GROUP_ZIP_MAX_ENTRIES);
  });

  it('非 zip → InvalidGroupDataError（既有语义不变）', () => {
    expect(() => parseGroupZip(new Uint8Array(0))).toThrow(InvalidGroupDataError);
    expect(() => parseGroupZip(new Uint8Array(200))).toThrow(/not a zip archive/);
  });

  it('超限 zip 在两条上传路径上都被映射为客户端错误（PUT→BadRequestError 400 / POST→ProfileDataInvalidError 422），且不写入任何对象', async () => {
    const bomb = zipSync({ 'bomb.bin': new Uint8Array(16 * 1024 * 1024) });
    const db = { getByTypeAndHash: async () => null };

    // POST /api/history：saveTransferData 把任何校验异常包成 ProfileDataInvalidError（路由 422，消息可诊断）
    const postStorage = new RecordingStorage();
    await expect(
      addRecordDto(db as never, postStorage as unknown as R2Storage, incomingGroup(), bomb, silentNotify),
    ).rejects.toThrow(/exceeds the 100:1 compression ratio/);
    await expect(
      addRecordDto(db as never, postStorage as unknown as R2Storage, incomingGroup(), bomb, silentNotify),
    ).rejects.toBeInstanceOf(ProfileDataInvalidError);
    expect(postStorage.writes).toHaveLength(0);

    // PUT /SyncClipboard.json：putSyncProfile 对齐上游 catch 全部异常 → BadRequestError（路由 400）
    const putStorage = new RecordingStorage();
    putStorage.temp = bomb;
    await expect(
      putSyncProfile(db as never, putStorage as unknown as R2Storage, groupDto(), silentNotify),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(putStorage.writes).toHaveLength(0);
  });

  it('正常小 zip 不受影响：条目/顶层/totalSize 与哈希与既有公式一致，并正常落盘', async () => {
    const zip = zipSync(
      {
        'a.txt': strToU8('aaa'),
        'empty.txt': new Uint8Array(0),
        'dir/': new Uint8Array(0),
        'dir/b.txt': strToU8('bbb'),
      },
      { level: 9 },
    );
    const { entries, topLevel, totalSize } = parseGroupZip(zip);
    expect([...topLevel].sort()).toEqual(['a.txt', 'dir', 'empty.txt']);
    expect(entries.find((e) => e.name === 'empty.txt')?.content?.length).toBe(0); // 0 字节条目走零长度分支
    expect(totalSize).toBe(6);
    const expectedHash = await groupHashFromEntries(entries);

    const storage = new RecordingStorage();
    const persisted = await validateAndPersistData(storage as unknown as R2Storage, groupDto(), 'File_ok.zip', zip);
    expect(persisted.hash).toBe(expectedHash);
    expect(persisted.size).toBe(6);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]!.fileName).toBe('File_ok.zip');
  });
});

// 协议级 golden：这些 group hash 由**改前**实现算出（PRE/POST 对照逐位一致后才固化），
// 覆盖 单文件 / 显式目录+多级子目录 / 中文名 / store / deflate / 流式(数据描述符)重复条目。
// 解析管线（条目名、隐式目录、首次写入优先、内容字节）任何漂移都会让官方客户端算出不同 hash，
// 因此这些值必须锁死。
describe('F9 · 解压管线 golden：group hash 与改前逐位一致', () => {
  const CASES: { name: string; zip: Uint8Array; hash: string; totalSize: number }[] = [
    {
      name: '单文件',
      zip: zipSync({ 'a.txt': strToU8('hello world') }),
      hash: 'B9889509A0424174C26FC4B3279CAEE588D9D5807E6B39F3A0BEA2942BE75CC1',
      totalSize: 11,
    },
    {
      name: '显式目录+多级子目录',
      zip: zipSync({
        'dir/': new Uint8Array(0),
        'dir/sub/inner.txt': strToU8('内容'),
        'top.bin': pseudoRandom(4096, 7),
      }),
      hash: '4E0920B7AE01172B47C80E2584A8F1DDFD9E14A220CD019C3EA98D5EC99D446F',
      totalSize: 4102,
    },
    {
      name: '中文名',
      zip: zipSync({ '中文/说明.txt': strToU8('中文内容'), '根.txt': strToU8('root') }),
      hash: '2B5AD81AAA0F8CBAC5CDF03917D7BD121E16E965EA6D13070B69370BF1AD8227',
      totalSize: 16,
    },
    {
      name: 'store(level 0)',
      zip: zipSync({ 'stored.bin': pseudoRandom(2048, 3) }, { level: 0 }),
      hash: 'BF7515B6956D4306E7CA774129CB2C10889E71FC2B39BEEC9C93D28303D3997D',
      totalSize: 2048,
    },
    {
      name: 'deflate(level 9)',
      zip: zipSync({ 'deflated.txt': strToU8('重复文本'.repeat(2000)) }, { level: 9 }),
      hash: '2ED97FB9001DF77D8E243E488071DFF226CD4126295FB927188ABB3BACACC2DE',
      totalSize: 24000,
    },
    {
      name: '同名重复条目（流式/数据描述符）',
      zip: streamedDuplicateZip(),
      hash: '54D7E9740BD225189C7FC62C79D3A775FD7691C62DB7364CF0E0D2A2C9D21257',
      totalSize: 3,
    },
  ];

  it('全部夹具 hash/totalSize 与改前实现一致', async () => {
    for (const c of CASES) {
      const { entries, totalSize } = parseGroupZip(c.zip);
      expect(totalSize, c.name).toBe(c.totalSize);
      expect(await groupHashFromEntries(entries), c.name).toBe(c.hash);
    }
  });
});
