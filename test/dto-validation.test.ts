// F6（PATCH `version` / PUT `size` 的整数与范围校验）与 F5（官方 `/data` 出口 Content-Disposition
// 编码）的判别性用例：每条都写成「修复前失败、修复后通过」的形态。
//
// 不依赖 dev server：真实 Hono 路由 + node:sqlite 上的最小 D1 适配器（读真 `schema.sql`）+
// 内存 R2 bucket stub，全程进程内。理由同 test/fixes.test.ts ——黑盒套件会把「别的切片正在被
// 热重载」误报成本套件的失败。
//
// 口径来源（上游 `Models/HistoryRecordUpdateDto.cs:8` 的 `int?`、`Shared/ProfileDto.cs:15` 的
// `long?`）：模型绑定只做「类型 + 范围」，符号不限。因此 `version:-1` **不是** 400，而是落到既有
// shouldUpdate 判定（本例记录版本为 0 且时间戳为 now → 版本不前进 → 409）。
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { parseHistoryRecordUpdateDto, parseProfileDto, historySizeMB } from '../src/serialization';
import { createHistoryRoutes } from '../src/routes/history';
import { createWebdavRoutes } from '../src/routes/webdav';
import { createUiRoutes } from '../src/ui/routes';
import { fileProfileHash, sha256Hex } from '../src/hash';
import { INT32_MAX, INT32_MIN } from '../src/types';
import type { Bindings } from '../src/env';
import { createSqliteD1, readSchemaSql } from './support/d1-sqlite';

const SCHEMA = readSchemaSql();
const enc = new TextEncoder();

// ============ 内存 R2 bucket ============
// 这个**留在这里**（不并进 test/support/）：它只存字节、`list()` 恒空，与
// test/fixes.test.ts 的 FakeBucket（只存 size、真分页）和 test/cleanup-budget.test.ts 的
// CountingBucket（带记账）语义各不相同 —— 合并它们只会为差异造一层配置面（docs/progress.md §105）。
class FakeR2Bucket {
  objects = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array | ArrayBuffer | ReadableStream): Promise<void> {
    if (body instanceof Uint8Array) this.objects.set(key, new Uint8Array(body));
    else if (body instanceof ArrayBuffer) this.objects.set(key, new Uint8Array(body));
    else throw new Error('FakeR2Bucket 只支持 Uint8Array/ArrayBuffer 体（本套件不需要流）');
  }
  async get(key: string): Promise<{ body: Uint8Array; size: number } | null> {
    const bytes = this.objects.get(key);
    return bytes ? { body: bytes.slice(), size: bytes.length } : null;
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(): Promise<{ objects: { key: string; size: number }[]; truncated: boolean }> {
    return { objects: [], truncated: false };
  }
}

interface Harness {
  env: Bindings;
  history: Hono<{ Bindings: Bindings }>;
  webdav: Hono<{ Bindings: Bindings }>;
  ui: Hono<{ Bindings: Bindings }>;
  /** 直接往库里写一行（见 createSqliteD1 的 `exec`） */
  exec: (sql: string) => void;
}

function makeHarness(): Harness {
  const db = createSqliteD1(SCHEMA);
  const bucket = new FakeR2Bucket();
  const env = {
    DB: db as unknown as D1Database,
    R2: bucket as unknown as R2Bucket,
    // 广播（PATCH/PUT 写路径都会 await 它）指向一个假 Hub：不测广播，但要让这条链路走通
    HUB: {
      idFromName: () => 'hub',
      get: () => ({ fetch: async () => new Response('') }),
    } as unknown as DurableObjectNamespace,
    VERSION: 'test',
    MAX_SAVED_HISTORY_COUNT: '1000',
    HISTORY_RETENTION_MINUTES: '43200',
    USERNAME: 'admin',
    PASSWORD: 'admin',
  } as unknown as Bindings;
  return {
    env,
    history: createHistoryRoutes(),
    webdav: createWebdavRoutes(),
    ui: createUiRoutes(),
    exec: (sql: string) => db.exec(sql),
  };
}

// 进程内请求：十几处调用共用同一发送路径（URL 前缀 + env 注入），避免各写一份 new Request
async function send(app: Hono<{ Bindings: Bindings }>, env: Bindings, path: string, init?: RequestInit): Promise<Response> {
  return await app.fetch(new Request(`http://test${path}`, init), env);
}

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

// 手工组 multipart（与 .NET HttpClient 同形：name 不带引号；data 部分带 filename）
function multipart(fields: Record<string, string>, data: Uint8Array) {
  const boundary = 'dto-validation-boundary';
  const chunks: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name=${k}\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name=data; filename="data.bin"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
  );
  chunks.push(data);
  chunks.push(enc.encode('\r\n'));
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return { body: concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ============ 场景构造 ============

// 经真实 POST /api/history 落一条 Image 记录（dataName = text 字段），返回它的 hash
async function createImageRecord(h: Harness, dataName: string, content: Uint8Array): Promise<string> {
  const hash = await fileProfileHash(dataName, content);
  const now = new Date().toISOString();
  const { body, contentType } = multipart(
    {
      hash,
      type: 'Image',
      text: dataName,
      size: String(content.length),
      version: '0',
      createTime: now,
      lastModified: now,
      lastAccessed: now,
      isDeleted: 'false',
    },
    content,
  );
  const created = await send(h.history, h.env, '/api/history', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  // 写入口不拦控制字符（对齐上游；要修的是出口编码，既有坏数据也必须可下载）
  expect(created.status, 'POST /api/history 应接受该 dataName').toBe(200);
  return hash;
}

// 经真实 POST /api/history 落一条普通 Text 记录（带 data 部分），返回 profileId 用的 hash。
// 两个口径要和真实客户端一致：① hash = `SHA256hex(内容)`（File/Image 才是 `fileName|contentHash`）；
// ② data 内容必须**不等于**内联 text，否则命中「内联哈希已匹配声明值 ⇒ 不需要 transfer data」（422）。
async function createTextRecord(h: Harness, tag: string): Promise<string> {
  const text = `dto-validation-${tag}-${Date.now().toString(36)}`;
  const bytes = enc.encode(`${text}（完整正文，内联 text 只是截断预览）`);
  const hash = await sha256Hex(bytes);
  const now = new Date().toISOString();
  const { body, contentType } = multipart(
    {
      hash,
      type: 'Text',
      text,
      size: String(bytes.length),
      version: '0',
      createTime: now,
      lastModified: now,
      lastAccessed: now,
      isDeleted: 'false',
    },
    bytes,
  );
  const created = await send(h.history, h.env, '/api/history', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  expect(created.status, '前置：POST /api/history 建记录').toBe(200);
  return hash;
}

function readVersion(h: Harness, hash: string): Promise<{ version: number; starred: boolean }> {
  return send(h.history, h.env, `/api/history/Text-${hash}`).then(async (res) => {
    expect(res.status, '读回记录').toBe(200);
    return (await res.json()) as { version: number; starred: boolean };
  });
}

// ============================================================ F6 · PATCH version
describe('F6 · PATCH version 只接受 int32（上游 int? 模型绑定）', () => {
  it('非整数 / 非有限 / 越界 / 类型不符 → 解析期抛错（修复前：1.5 被接受并原样落库）', () => {
    for (const raw of ['1.5', '1e400', '1e308', '2147483648', '-2147483649', '"3"', 'true', '{}']) {
      expect(() => parseHistoryRecordUpdateDto(`{"version":${raw}}`), `version:${raw} 应被拒`).toThrow();
    }
  });

  it('合法 int32（含 0 与两端边界）与 null/缺省 → 通过；缺省保持「部分更新」语义', () => {
    expect(parseHistoryRecordUpdateDto('{"version":1}').version).toBe(1);
    expect(parseHistoryRecordUpdateDto('{"version":0}').version).toBe(0);
    expect(parseHistoryRecordUpdateDto(`{"version":${INT32_MAX}}`).version).toBe(INT32_MAX);
    expect(parseHistoryRecordUpdateDto(`{"version":${INT32_MIN}}`).version).toBe(INT32_MIN);
    expect(parseHistoryRecordUpdateDto('{"version":null}').version).toBeUndefined();
    expect(parseHistoryRecordUpdateDto('{"starred":true}').version).toBeUndefined();
  });

  it('HTTP：{"version":1.5} / {"version":1e400} / {"version":2147483648} → 400，且记录未被改动', async () => {
    const h = makeHarness();
    const hash = await createTextRecord(h, 'reject');

    for (const raw of ['{"version":1.5}', '{"version":1e400}', '{"version":2147483648}']) {
      const res = await send(h.history, h.env, `/api/history/Text/${hash}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      expect(res.status, `PATCH ${raw} 应 400（修复前 1.5 → 200 落库、1e400 → 500）`).toBe(400);
      expect((await readVersion(h, hash)).version, `${raw} 被拒后版本不得变动`).toBe(0);
    }
  });

  it('HTTP：{"version":1} → 200（合法更新不受影响，版本真正推进）', async () => {
    const h = makeHarness();
    const hash = await createTextRecord(h, 'accept');

    const res = await send(h.history, h.env, `/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, starred: true }),
    });
    expect(res.status).toBe(200);
    const after = await readVersion(h, hash);
    expect(after.version).toBe(1);
    expect(after.starred).toBe(true);
  });

  it('HTTP：{"version":-1} → 409（不是 400；符号不受校验，由上游 shouldUpdate 语义决定）', async () => {
    const h = makeHarness();
    const hash = await createTextRecord(h, 'negative');
    const res = await send(h.history, h.env, `/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"version":-1}',
    });
    // 记录 lastModified ≈ now（gap ≤ 5min）→ 按版本判定：-1 >= 0 不成立 → 409 冲突（上游行为）
    expect(res.status).toBe(409);
    expect((await readVersion(h, hash)).version).toBe(0);
  });

  it('HTTP：`{"version":NaN}`（JSON 无 NaN 字面量）→ 400，而非 500', async () => {
    const h = makeHarness();
    const hash = await createTextRecord(h, 'nan');
    // 非有限值的**可达**形态是 1e400 → Infinity（已在上面的用例覆盖）；NaN 在 JSON.parse 阶段
    // 就失败，但出口同样是本路由的 400。
    const res = await send(h.history, h.env, `/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"version":NaN}',
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================ F6 · PUT size
describe('F6 · PUT size 只接受安全整数（上游 long? 模型绑定）', () => {
  it('非整数 / 非有限 / 超安全整数 / 类型不符 → 解析期抛错（修复前：1.5、1e400 被当作合法体积）', () => {
    for (const raw of ['1.5', '1e400', '1e308', '9007199254740992', '"5"', 'true', '[]']) {
      expect(() => parseProfileDto(`{"type":"Text","size":${raw}}`), `size:${raw} 应被拒`).toThrow();
    }
  });

  it('安全整数（含 0、负数）与 null/缺省 → 通过；size 缺失时不塞默认值', () => {
    expect(parseProfileDto('{"type":"Text","size":123}').size).toBe(123);
    expect(parseProfileDto('{"type":"Text","size":0}').size).toBe(0);
    expect(parseProfileDto('{"type":"Text","size":-1}').size).toBe(-1);
    expect(parseProfileDto('{"type":"Text","size":9007199254740991}').size).toBe(9007199254740991);
    expect(parseProfileDto('{"type":"Text","size":null}').size).toBeUndefined();
    expect(parseProfileDto('{"type":"Text"}').size).toBeUndefined();
  });

  it('HTTP：PUT {"size":1.5} / {"size":1e400} → 400（修复前会被当成合法体积写进记录）', async () => {
    const h = makeHarness();
    for (const raw of ['{"type":"Text","hash":"","text":"x","hasData":false,"size":1.5}', '{"type":"Text","hash":"","text":"x","hasData":false,"size":1e400}']) {
      const res = await send(h.webdav, h.env, '/SyncClipboard.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      expect(res.status, `PUT ${raw} 应 400`).toBe(400);
    }
  });

  it('HTTP：PUT {"size":5} → 200，且 GET /SyncClipboard.json 读回 size=5（合法路径不受影响）', async () => {
    const h = makeHarness();
    const res = await send(h.webdav, h.env, '/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"type":"Text","hash":"","text":"dto-validation-size","hasData":false,"size":5}',
    });
    expect(res.status).toBe(200);
    const read = await send(h.webdav, h.env, '/SyncClipboard.json');
    expect(read.status).toBe(200);
    const dto = (await read.json()) as { size: number; text: string };
    expect(dto.text).toBe('dto-validation-size');
    expect(dto.size).toBe(5);
  });
});

// ============================================================ PUT 字段的 JSON 类型
describe('PUT 的 hash / text / dataName / hasData 只接受对应 JSON 类型（上游 [FromBody] 模型绑定）', () => {
  it('类型不符 → 解析期抛错（修复前一律 as string 强转，5 例变成未处理的 500）', () => {
    for (const raw of ['123', '{}', '[]', 'true']) {
      expect(() => parseProfileDto(`{"type":"Text","hash":${raw}}`), `hash:${raw} 应被拒`).toThrow();
      expect(() => parseProfileDto(`{"type":"Text","text":${raw}}`), `text:${raw} 应被拒`).toThrow();
      expect(
        () => parseProfileDto(`{"type":"Text","hasData":true,"dataName":${raw}}`),
        `dataName:${raw} 应被拒`,
      ).toThrow();
    }
    // hasData 必须是布尔：字符串 "false" 会被当**真值**，于是"没有数据"被判成"有数据"
    // `null` 同样被拒 —— 上游 `ProfileDto.HasData` 是 `bool`（非空值类型），STJ 反序列化失败 ⇒ 400
    for (const raw of ['"false"', '0', '1', '[]', '{}', 'null']) {
      expect(() => parseProfileDto(`{"type":"Text","hasData":${raw}}`), `hasData:${raw} 应被拒`).toThrow();
    }
  });

  it('null 等价于缺省**只限引用类型字段**；值类型字段的显式 null 是类型错误（见上一条）', () => {
    expect(
      parseProfileDto('{"type":"Text","hash":null,"text":null,"dataName":null}'),
    ).toMatchObject({ hash: '', text: '', hasData: false, dataName: null });
    // `type` 是非空值类型 ⇒ 显式 null 与「键缺失」不同，按类型错误处理
    expect(() => parseProfileDto('{"type":null}')).toThrow();
  });

  it('HTTP：类型不符 → 400，且理由是模型绑定失败（不是被后面的业务判据顺手拒掉）', async () => {
    const h = makeHarness();
    const bodies = [
      '{"type":"Text","hash":123,"text":"x"}',
      '{"type":"Text","hash":"","text":[1,2]}',
      '{"type":"Text","hash":"","text":"x","hasData":true,"dataName":123}',
      // 判别性最强的一条：修前它也回 400，但理由是"HasData 为真却没有 dataName"（字符串被当真值）
      '{"type":"Text","hash":"","text":"x","hasData":"false"}',
      // 非空值类型的显式 null（2026-09-20 起对齐上游的 400）
      '{"type":"Text","hash":"","text":"x","hasData":null}',
      '{"type":null,"hash":"","text":"x"}',
    ];
    for (const raw of bodies) {
      const res = await send(h.webdav, h.env, '/SyncClipboard.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      expect(res.status, `PUT ${raw} 应 400`).toBe(400);
      expect(await res.text(), `PUT ${raw} 应报 JSON 类型错误`).toBe('Invalid JSON body');
    }
  });
});

// ============================================================ F5 · /data 出口编码
describe('F5 · /data 的 Content-Disposition 对任意 dataName 都必须合法', () => {
  // `harnessStorageGap`：NUL 名称在本 harness 的存储层（node:sqlite + 内存 R2 stub）上的往返
  // 取决于 Node 版本（SQLite 的 length()/比较把 NUL 当终止符，Node 22 与 24 行为不同），
  // 与真实运行时（miniflare D1/R2 与生产 D1/R2）不一致。该场景已在**真实本地实例**上端到端验证：
  // POST /api/history 200 → GET /api/history/{id}/data 200（见 .audits/cfserver-audit-003/probes/lead-agent/
  // lead-verify5.mjs 的翻转结果）。因此这条只断言 F5 的**真正契约**：永不 500、且一旦返回 200 头值必须合法；
  // 不把 harness 的存储保真度当成产品缺陷。
  const NAMES: { name: string; why: string; harnessStorageGap?: boolean }[] = [
    { name: 'evil\r\nX-Injected: 1.txt', why: 'CRLF（修复前 POST 200 但 /data 恒 500）' },
    { name: 'nul\u0000name.txt', why: 'NUL（同上）', harnessStorageGap: true },
    { name: '报告 100% done.txt', why: '中文 / 空格 / %（RFC 5987 编码对照）' },
    { name: 'quote"and\\backslash.txt', why: '会破坏引号串的 `"` 与 `\\`' },
    { name: 'normal.txt', why: '正常名对照' },
  ];

  for (const { name, why, harnessStorageGap } of NAMES) {
    it(`dataName=${JSON.stringify(name)}（${why}）→ 永不为 5xx，且 200 时头值合法`, async () => {
      const h = makeHarness();
      const content = enc.encode(`payload for ${name}`);
      const hash = await createImageRecord(h, name, content);

      const res = await send(h.history, h.env, `/api/history/Image-${hash}/data`);
      // F5 的契约：出口编码修好后**不可能**再因头值非法而 500。
      expect(res.status, '修复前含 CR/LF/NUL 的名称在这里恒 500').toBeLessThan(500);
      if (harnessStorageGap) {
        // 该名称在 harness 存储层上可能取不到（见 NAMES 上方的说明）——那属于适配器限制。
        expect([200, 404], 'harness 存储层限制只允许 404，不允许别的失败').toContain(res.status);
        if (res.status === 404) return;
      } else {
        expect(res.status, '其余名称必须能取到（含 CRLF）').toBe(200);
      }

      const cd = res.headers.get('content-disposition') ?? '';
      // 头值本身合法：Node/Workers 的 Headers 对非法值（裸 CR/LF/NUL）在构造期就抛错，
      // 能走到这里说明没有裸控制字符；再显式断言一次，防止将来有人改成「先设值后清洗」。
      expect(cd).not.toMatch(/[\r\n\u0000]/);
      expect(cd.startsWith('attachment; filename="')).toBe(true);
      expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
      // ASCII 兜底串：控制字符与非 ASCII → `_`，且不含会破坏引号串的 `"`/`\`
      const ascii = cd.slice('attachment; filename="'.length, cd.indexOf('"; filename*='));
      expect(ascii).toMatch(/^[\x20\x21\x23-\x5B\x5D-\x7E]*$/);
      expect(ascii).not.toContain('"');
      expect(ascii).not.toContain('\\');
      // 内容与类型不受影响
      expect(await res.text()).toBe(`payload for ${name}`);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      // 上游 3.3.0 #413：响应用 `X-SyncClipboard-Transfer-Data-Hash` 回带传输文件的 SHA-256
      //（本 harness 走真实 POST，落库的 transferDataHash = sha256(内容)）⇒ 必须有且等于内容哈希。
      const tdHash = res.headers.get('x-syncclipboard-transfer-data-hash');
      expect(tdHash, 'POST 落库后 /data 必须回带传输数据哈希').not.toBeNull();
      expect(tdHash, '传输数据哈希必须是内容字节的 SHA-256（大写 hex）').toBe(await sha256Hex(content));
    });
  }

  it('对照（判别性）：修复前的拼接方式在 CR/LF 名称上确实会让 Response 构造抛错', () => {
    const name = 'evil\r\nX-Injected: 1.txt';
    const legacy = `attachment; filename*=UTF-8''${encodeURIComponent(name)}; filename="${name.replace(/"/g, '')}"`;
    // 这就是「POST 200 但 /data 恒 500」的机制：头值里的裸 CR/LF 让 Response 构造抛 TypeError
    expect(() => new Response('x', { headers: { 'content-disposition': legacy } })).toThrow();
  });
});

// ============================================================ PATCH 的日期字段
describe('PATCH 的 lastModified / lastAccessed：类型与格式（上游 [FromBody] DateTimeOffset? 绑定）', () => {
  it('类型不符与空串 → 解析期抛错（修复前被**静默忽略** ⇒ 服务端没改、请求方以为改了）', () => {
    for (const raw of ['123', '{}', '[]', 'true', '""']) {
      expect(() => parseHistoryRecordUpdateDto(`{"lastModified":${raw}}`), `lastModified:${raw} 应被拒`).toThrow();
      expect(() => parseHistoryRecordUpdateDto(`{"lastAccessed":${raw}}`), `lastAccessed:${raw} 应被拒`).toThrow();
    }
    // null 与键缺失 = 「未提供」（上游得到 null，该字段不参与更新）
    expect(parseHistoryRecordUpdateDto('{"lastModified":null}').lastModified).toBeUndefined();
    expect(parseHistoryRecordUpdateDto('{"lastAccessed":null}').lastAccessed).toBeUndefined();
    expect(parseHistoryRecordUpdateDto('{"starred":true}').lastModified).toBeUndefined();
    // 合法串（含 C# 的 7 位小数形态）不受影响
    expect(parseHistoryRecordUpdateDto('{"lastModified":"2026-09-12T10:20:30.1234567Z"}').lastModified).toBe(
      '2026-09-12T10:20:30.1234567Z',
    );
  });

  it('HTTP：类型不符 → 400，且记录一个字段都没被改动（修复前：忽略该字段 + 静默推进版本与时间戳）', async () => {
    const h = makeHarness();
    const hash = await createTextRecord(h, 'date-type');
    for (const raw of ['{"lastModified":123}', '{"lastAccessed":[]}', '{"lastModified":""}', '{"lastAccessed":{}}']) {
      const res = await send(h.history, h.env, `/api/history/Text/${hash}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      expect(res.status, `PATCH ${raw} 应 400（修复前 200：字段没改、版本却推进了）`).toBe(400);
      expect((await readVersion(h, hash)).version, `${raw} 被拒后版本不得变动`).toBe(0);
    }
    // null 表示"未提供"：整条仍应正常更新
    const ok = await send(h.history, h.env, `/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastModified: null, lastAccessed: null, starred: true, version: 1 }),
    });
    expect(ok.status).toBe(200);
  });
});

// ============================================================ 带外写入的坏行
// 为什么这一组住在本文件：这里的 harness 是仓库里唯一同时具备「读真 schema.sql 的 D1 假实现 + 内存 R2 +
// 可注入 env + 三条路由面」的**进程内**环境 —— 而这一族要的正是「直接往库里写一行**写路径都拒绝**的数据」。
// 三条写路径都拒 hash 含 `/`（PUT /SyncClipboard.json、POST /api/history、UI PATCH 各有一道校验），
// 故这种行只能来自"库被外部改坏" —— 而那恰恰是自检端点存在的理由。
describe('库里的坏行（hash 含路径分隔符）：诊断面与读路径都不该 500', () => {
  const BASIC = 'Basic ' + Buffer.from('admin:admin').toString('base64');

  function insertCorruptRow(h: Harness, hash: string): void {
    h.exec(
      `INSERT INTO HistoryRecords
         (UserId, Type, Text, Size, TransferDataFile, FilePaths, Hash, CreateTime, LastAccessed, LastModified, Stared, Pinned, Version, IsDeleted)
       VALUES ('default_user', 0, 'corrupt-row', 11, 'a.bin', '["a.bin"]', '${hash}', 1, 1, 1, 0, 0, 0, 0)`,
    );
  }

  it('GET /ui/api/integrity → 200：坏行按「取不到」计，并把它的 hash 原样列出来', async () => {
    const h = makeHarness();
    insertCorruptRow(h, 'AA/BB');
    const res = await send(h.ui, h.env, '/ui/api/integrity', { headers: { authorization: BASIC } });
    expect(res.status, '修复前这里是 500（historyKey 内部的 assertHashForPath 抛出）').toBe(200);
    const body = (await res.json()) as {
      recordsWithData: number;
      missingCount: number;
      missing: { hash: string }[];
    };
    expect(body.recordsWithData).toBe(1);
    expect(body.missingCount).toBe(1);
    // 清单里露出坏 hash 正是它可诊断的地方（不做静默跳过）
    expect(body.missing.map((m) => m.hash)).toContain('AA/BB');
  });

  it('GET /api/history/{id}/data → 422 history_data_invalid（不是 500）：构造不出 key 的记录按「有数据但取不到」计', async () => {
    // 上游 3.3.0（#413）把「记录声称有数据但数据不可用」从 404 改成 422（History transfer data is invalid）。
    const h = makeHarness();
    insertCorruptRow(h, 'AA/BB');
    const res = await send(h.history, h.env, '/api/history/Text-AA%2FBB/data');
    expect(res.status, '修复前这里是 500（storage 层的 assertHashForPath 抛出）').toBe(422);
    // 对照：同一行的**元数据**端点不受影响（它不碰 R2 key 构造）
    expect((await send(h.history, h.env, '/api/history/Text-AA%2FBB')).status).toBe(200);
  });

  it('迁移前入库的记录（TransferDataHash 列 = \'\'）→ 数据可取时 200 且**不带**头，取不到时 422 也不带头', async () => {
    // 上游 3.3.0 客户端对「空/非法头值」会抛 RemoteHistoryDataRejectedException ⇒ 旧记录若带了
    // 一个空头，下载会整体失败。契约：**只有已知且合法**的哈希才回带（见 src/routes/history.ts）。
    // ① 数据对象存在（F5 的正常名用例已覆盖「有哈希 ⇒ 带头」）——这里验证**没有存储对象**的
    //    旧行：422（数据取不到）且不带传输数据哈希头（不能带一个空头）。
    const h = makeHarness();
    h.exec(
      `INSERT INTO HistoryRecords
         (UserId, Type, Text, Size, TransferDataFile, FilePaths, Hash, CreateTime, LastAccessed, LastModified, Stared, Pinned, Version, IsDeleted)
       VALUES ('default_user', 0, 'legacy', 6, 'legacy.txt', '["legacy.txt"]', '${'B'.repeat(64)}', 1, 1, 1, 0, 0, 0, 0)`,
    );
    const res = await send(h.history, h.env, `/api/history/Text-${'B'.repeat(64)}/data`);
    expect(res.status).toBe(422);
    expect(res.headers.get('x-syncclipboard-transfer-data-hash'), '取不到数据的旧行不该带空头').toBeNull();
  });
});

// `historySizeMB`：统计接口的体积口径。此前**没有任何断言**，而它是两个"跨测量差值"判据的输入
// （`test/ui.test.ts` 的"彻底删除清字节"就是其中之一）—— 2026-09-22 CI 实测读到 1.99 而不是 2.00，
// 根因正是下面这条**地板**：CI 的库几乎空 ⇒ 清空后总字节 ≈ 40 B ⇒ 四舍五入成 0 ⇒ 被抬到 0.01。
describe('historySizeMB：两位小数 + 「非零不得显示成 0」的地板', () => {
  it('0 给 0（真值）；非零但不足 0.005 MB 给 0.01；正常值取两位小数', () => {
    expect(historySizeMB(0), '真的一个字节都没有 —— 0 是**真值**，不该被抬成 0.01').toBe(0);
    expect(historySizeMB(1), '非零不得显示成 0（那是"取不到/坏了"的读数）').toBe(0.01);
    expect(historySizeMB(40), 'CI 那次就是这一档（清空后只剩几十字节）').toBe(0.01);
    expect(historySizeMB(2 * 1024 * 1024), '正好 2 MiB').toBe(2);
    expect(historySizeMB(1024 * 1024 * 3.14159), '两位小数').toBe(3.14);
  });
});
