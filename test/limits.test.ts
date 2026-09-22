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
  groupZipDecompressionCap,
  parseGroupZip,
} from '../src/hash';
import {
  BadRequestError,
  PayloadTooLargeError,
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
import { createWebdavRoutes } from '../src/routes/webdav';
import {
  ISOLATE_TRANSFER_BUDGET_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES_CEILING,
  MAX_REQUEST_BODY_BYTES_FLOOR,
} from '../src/requestLimits';
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
  deletedTemps: string[] = [];

  // 与真实 R2ObjectBody 一样带 `size`：落库那步的内存护栏**按对象实际大小**判定
  // （不信 content-length，因为暂存是流式的，请求头可以绕过预检）
  async getTemp(_name: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null> {
    const temp = this.temp;
    return temp ? { arrayBuffer: async () => temp.slice().buffer, size: temp.length } : null;
  }

  async deleteTemp(name: string): Promise<void> {
    this.deletedTemps.push(name);
    this.temp = null;
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
    await expect(parseGroupZip(bomb)).rejects.toBeInstanceOf(InvalidGroupDataError);
    await expect(parseGroupZip(bomb)).rejects.toThrow(
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
    await expect(parseGroupZip(bomb)).rejects.toThrow(new RegExp(`expands beyond ${GROUP_ZIP_MAX_TOTAL_BYTES} bytes`));

    const storage = new RecordingStorage();
    await expect(
      validateAndPersistData(storage as unknown as R2Storage, groupDto(), 'File_parts.zip', bomb),
    ).rejects.toBeInstanceOf(InvalidGroupDataError);
    expect(storage.writes).toHaveLength(0);
  });

  it('条目数超上限（1001）中止；1000 条仍可通过', async () => {
    const make = (count: number): Uint8Array => {
      const entries: Record<string, Uint8Array> = {};
      for (let i = 0; i < count; i++) entries[`f${i}.txt`] = strToU8('x');
      return zipSync(entries);
    };
    await expect(parseGroupZip(make(GROUP_ZIP_MAX_ENTRIES + 1))).rejects.toThrow(
      new RegExp(`more than ${GROUP_ZIP_MAX_ENTRIES} entries`),
    );
    const atLimit = await parseGroupZip(make(GROUP_ZIP_MAX_ENTRIES));
    expect(atLimit.entries.filter((e) => !e.isDir)).toHaveLength(GROUP_ZIP_MAX_ENTRIES);
    expect(atLimit.totalSize).toBe(GROUP_ZIP_MAX_ENTRIES);
  });

  it('非 zip → InvalidGroupDataError（既有语义不变）', async () => {
    await expect(parseGroupZip(new Uint8Array(0))).rejects.toThrow(InvalidGroupDataError);
    await expect(parseGroupZip(new Uint8Array(200))).rejects.toThrow(/not a zip archive/);
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

  it('正常小 zip 不受影响：条目/顶层/totalSize 与哈希与既有公式一致，并正常落盘', async () => {    const zip = zipSync(
      {
        'a.txt': strToU8('aaa'),
        'empty.txt': new Uint8Array(0),
        'dir/': new Uint8Array(0),
        'dir/b.txt': strToU8('bbb'),
      },
      { level: 9 },
    );
    const { entries, topLevel, totalSize } = await parseGroupZip(zip);
    expect([...topLevel].sort()).toEqual(['a.txt', 'dir', 'empty.txt']);
    expect(entries.find((e) => e.name === 'empty.txt')?.contentLength).toBe(0); // 0 字节条目走零长度分支
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
describe('F9 · 传输数据上限按「暂存对象实际大小」判定（不信 content-length）', () => {
  // 背景：`PUT /file/{name}` 是**流式**写 R2 的（不吃内存），把大对象暂存进去完全免费；
  // 而落库那步要把它整包读回内存做哈希校验。只靠请求头预检时，客户端"先流式暂存 100MB、
  // 再用很小的 JSON 提交"即可绕过，让 isolate 在 arrayBuffer() 处 OOM（并发中的其他请求一起 503）。
  it('暂存对象超过上限 → PayloadTooLargeError，且不落库、并把暂存对象删掉', async () => {
    const db = { getByTypeAndHash: async () => null };
    const storage = new RecordingStorage();
    storage.temp = new Uint8Array(1024); // 1 KiB 的"大文件"

    await expect(
      putSyncProfile(db as never, storage as unknown as R2Storage, groupDto(), silentNotify, 100),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(storage.writes, '超限时不应写入任何持久对象').toHaveLength(0);
    expect(storage.deletedTemps, '应顺手清掉暂存对象，不留下垃圾').toHaveLength(1);
  });

  it('恰好等于上限 → 放行（边界是 > 而非 >=）', async () => {    const zip = zipSync({ 'a.txt': strToU8('aaa') }, { level: 9 });
    // 走完整落库路径所需的最小 db 桩：查不到已存在 → insert → 写当前 profile
    const db = {
      getByTypeAndHash: async () => null,
      insert: async (entity: unknown) => entity,
      setCurrentProfileJson: async () => undefined,
    };
    const storage = new RecordingStorage();
    storage.temp = zip;

    await putSyncProfile(
      db as never,
      storage as unknown as R2Storage,
      groupDto(),
      silentNotify,
      zip.length,
    );
    expect(storage.writes, '恰好等于上限应当落库').toHaveLength(1);
    expect(storage.deletedTemps, '落库成功后暂存对象被消费掉（上游 File.Move 语义）').toHaveLength(1);
  });

  it('真实路由：PUT /SyncClipboard.json 提交一个超限的暂存对象 → 413（不是 400/500）', async () => {
    const app = createWebdavRoutes();
    // 只桩到"暂存对象存在且很大"：路由进入 profile 层后会先撞大小判定，不会真去读内容
    const env = {
      R2: {
        get: async () => ({
          size: MAX_REQUEST_BODY_BYTES + 1,
          arrayBuffer: async () => new ArrayBuffer(0),
        }),
        // 超限路径会顺手删掉暂存对象（不留垃圾），真实实现用同一个 bucket.delete
        delete: async () => undefined,
      },
      // 大小判定在 db 之前发生；给个最小桩防止路径意外推进时静默通过
      DB: {},
      VERSION: 'limits-test',
    } as unknown as Bindings;
    const res = await app.request(
      '/SyncClipboard.json',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'File', hash: '', text: 'big.bin', size: 1, hasData: true, dataName: 'big.bin' }),
      },
      env,
    );
    expect(res.status, '超限暂存对象必须映射成 413（客户端按状态码判定失败）').toBe(413);
    expect(await res.text()).toBe('Payload Too Large');
  });
});

describe('F9 · 解压预算随请求体收缩（body 与解压内容之和受 isolate 预算约束）', () => {
  // 背景：`parseGroupZip` 期间 zip 的**压缩体一直存活**，且峰值不是「body + 解压」而是
  // 「body + 2×解压」（fflate 解压缓冲按 2 倍增长、ondata 交付再复制一份），所以预算按 2 分摊：
  // 80 MiB body + 64 MiB 解压 = 144 MiB > 128 MiB isolate，那会在解压**中途** OOM。
  const fake = (length: number) => ({ length }) as unknown as Uint8Array;

  it('小请求体 → 解压预算 = (96 MiB − body) / 2（常规使用不受影响）', () => {
    const cap = (ISOLATE_TRANSFER_BUDGET_BYTES - 0) / 2;
    expect(groupZipDecompressionCap(fake(0))).toBe(cap);
    expect(groupZipDecompressionCap(fake(20 * 1024 * 1024))).toBe(cap - 10 * 1024 * 1024);
  });

  it('大请求体 → 解压预算按剩余预算收缩', () => {
    // 48 MiB body（当前默认上限）⇒ 还剩 48 MiB ⇒ ÷2 = 24 MiB
    expect(groupZipDecompressionCap(fake(MAX_REQUEST_BODY_BYTES))).toBe(
      (ISOLATE_TRANSFER_BUDGET_BYTES - MAX_REQUEST_BODY_BYTES) / 2,
    );
    // 64 MiB body（上限）⇒ 还剩 32 MiB ⇒ ÷2 = 16 MiB
    expect(groupZipDecompressionCap(fake(MAX_REQUEST_BODY_BYTES_CEILING))).toBe(
      (ISOLATE_TRANSFER_BUDGET_BYTES - MAX_REQUEST_BODY_BYTES_CEILING) / 2,
    );
    // 极端：body 已占满预算 ⇒ 保留 1 MiB 下限（不出现"预算 0 ⇒ 任何 zip 都报错"的难查形态）
    expect(groupZipDecompressionCap(fake(ISOLATE_TRANSFER_BUDGET_BYTES))).toBe(1024 * 1024);
    expect(groupZipDecompressionCap(fake(ISOLATE_TRANSFER_BUDGET_BYTES * 2))).toBe(1024 * 1024);
  });

  it('守卫：任何允许的请求体 + 其解压预算都不超过 isolate 工作集预算', () => {
    for (const body of [
      0,
      MAX_REQUEST_BODY_BYTES,
      MAX_REQUEST_BODY_BYTES_CEILING,
      MAX_REQUEST_BODY_BYTES_FLOOR,
    ]) {
      const cap = groupZipDecompressionCap(fake(body));
      expect(body + 2 * cap, `body=${body} + 2×cap=${cap}`).toBeLessThanOrEqual(
        ISOLATE_TRANSFER_BUDGET_BYTES,
      );
    }
    // 上限本身也不能贴到 isolate：要按"预算 + 运行时余量"来定，而不是按平台 100MB 来定
    expect(MAX_REQUEST_BODY_BYTES_CEILING).toBeLessThanOrEqual(ISOLATE_TRANSFER_BUDGET_BYTES);
    expect(MAX_REQUEST_BODY_BYTES).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES_CEILING);
    expect(MAX_REQUEST_BODY_BYTES_FLOOR).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES);
  });

  it('行为：同一份 zip 在动态收缩后的预算下被拒绝（错误信息带上实际生效的数）', async () => {
    // 4 MiB 解压内容：默认 64 MiB 上限下通过；预算收到 1 MiB 时中止
    const zip = zipSync({ 'big.bin': new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    await expect(parseGroupZip(zip)).resolves.not.toThrow();
    await expect(parseGroupZip(zip, 1024 * 1024)).rejects.toThrow(/expands beyond 1048576 bytes/);
  });
});

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
      const { entries, totalSize } = await parseGroupZip(c.zip);
      expect(totalSize, c.name).toBe(c.totalSize);
      expect(await groupHashFromEntries(entries), c.name).toBe(c.hash);
    }
  });
});
