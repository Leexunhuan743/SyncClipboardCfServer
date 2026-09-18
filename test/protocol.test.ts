// HTTP 协议黑盒测试（docs/protocol.md §4-§5）
// 前置：本地 dev server 已运行（npm run dev），BASE 默认 http://127.0.0.1:8787
import { describe, expect, it, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { assertWritableTarget } from './support/target-guard';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

// 本套件会写目标库：默认只允许指向本机 dev server，指向远端需显式 ALLOW_REMOTE_TARGET=1
assertWritableTarget(BASE);
// 凭据变量名专用化：`USER`/`USERNAME` 在宿主环境里恒被占用
// （Windows 有 USERNAME，Ubuntu CI runner 有 USER=runner），用它们会让测试
// 拿错凭据→401 假失败。只认 SYNC_USER / SYNC_PASS，默认与 .dev.vars 示例一致。
const USER = process.env.SYNC_USER ?? 'admin';
const PASS = process.env.SYNC_PASS ?? 'admin';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex').toUpperCase();

async function req(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: AUTH, ...(init.headers ?? {}) },
  });
}

function fileHash(fileName: string, content: Buffer): string {
  return sha256(`${fileName}|${sha256(content)}`);
}

// 唯一后缀避免测试间数据冲突
const RUN = Date.now().toString(36);

beforeAll(async () => {
  const res = await fetch(`${BASE}/`, { headers: { Authorization: AUTH } });
  if (!res.ok) {
    throw new Error(`dev server 不可用 (${BASE}): ${res.status}`);
  }
  // 重置当前 profile 为空 Text（对应上游空档语义），保证"初始为空"测试确定性
  await fetch(`${BASE}/SyncClipboard.json`, {
    method: 'PUT',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Text', hash: '', text: '', hasData: false }),
  });
});

describe('鉴权', () => {
  it('无凭据 → 401', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(401);
  });
  it('错误凭据 → 401', async () => {
    const res = await fetch(`${BASE}/`, {
      headers: { Authorization: 'Basic ' + Buffer.from('x:y').toString('base64') },
    });
    expect(res.status).toBe(401);
  });
});

describe('基础端点', () => {
  it('GET / → Server is running.', async () => {
    expect(await (await req('/')).text()).toBe('Server is running.');
  });
  // 上游 GetServerTime 返回 DateTimeOffset（非 string）→ 走 JSON 格式化器。
  // 官方客户端用 ReadFromJsonAsync<DateTimeOffset> 读取：必须是 application/json 的带引号 ISO 串，
  // text/plain 的裸时间戳会因媒体类型不支持直接抛异常。
  it('GET /api/time 为 application/json 的 ISO8601 串', async () => {
    const res = await req('/api/time');
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const t = (await res.json()) as string;
    expect(new Date(t).getTime()).not.toBeNaN();
  });
  it('GET /api/version 为 text/plain 裸串（上游 AppVersion 是 string）', async () => {
    const res = await req('/api/version');
    const v = await res.text();
    expect(v.startsWith('"')).toBe(false); // 不是 JSON 引号串，否则 AppVersion.TryParse 会失败
    expect(Number(v.split('.')[0])).toBeGreaterThanOrEqual(3);
  });
});

describe('Profile（WebDAV 兼容）', () => {
  it('GET /SyncClipboard.json 初始为空 TextProfile dto', async () => {
    const res = await req('/SyncClipboard.json');
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; hash: string; text: string; hasData: boolean; size: number; dataName: unknown };
    // 注意：beforeAll 已经 PUT 过一个空 Text，因此这里读到的是**已存储**记录，
    // 其 hash 为服务端计算的 SHA256('')（上游 TextProfile.ComputeHash 同此），不再是空串。
    expect(body).toMatchObject({ type: 'Text', text: '', hasData: false });
    // 上游 ProfileDto.DataName 无 JsonIgnore：无数据时输出 "dataName":null（仅 Size 为 WhenWritingNull）
    expect('dataName' in body).toBe(true);
    expect(body.dataName).toBeNull();
    // 上游 ToProfileDto 恒带 Size（long? 仅 WhenWritingNull 省略），空文本的 Size=0。
    // 旧实现省略该字段，故此断言同时是 F11 的判别用例。
    expect('size' in body).toBe(true);
    expect(body.size).toBe(0);
  });

  it('PUT Text profile → GET 回读 + 历史入库', async () => {
    const text = `protocol-text-${RUN}`;
    const hash = sha256(text);
    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash, text, hasData: false }),
    });
    expect(put.status).toBe(200);

    const got = await (await req('/SyncClipboard.json')).json();
    expect(got).toMatchObject({ type: 'Text', hash, text, hasData: false });
  });

  it('PUT File profile：上传数据 → 校验 → 下载（历史查找）', async () => {
    const fileName = `file-${RUN}.bin`;
    const content = Buffer.from('file-content-' + RUN);
    const hash = fileHash(fileName, content);

    const up = await req(`/file/${fileName}`, { method: 'PUT', body: content });
    expect(up.status).toBe(200);

    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'File', hash, text: fileName, hasData: true, dataName: fileName, size: content.length }),
    });
    expect(put.status).toBe(200);

    const dl = await req(`/file/${fileName}`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe(content.toString());
  });

  it('哈希不符 → 400 Hash is not match data.', async () => {
    const fileName = `bad-${RUN}.bin`;
    await req(`/file/${fileName}`, { method: 'PUT', body: 'x' });
    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'File',
        hash: 'A'.repeat(64),
        text: fileName,
        hasData: true,
        dataName: fileName,
        size: 1,
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.text()).toContain('Hash is not match data');
  });

  it('PROPFIND / 与 MKCOL /file → 2xx（PROPFIND 返回 207 multistatus）', async () => {
    // PROPFIND 改为返回标准 WebDAV multistatus（207）；客户端按 2xx 判定（EnsureSuccessStatusCode）
    expect([200, 207]).toContain((await req('/', { method: 'PROPFIND' })).status);
    expect((await req('/file', { method: 'MKCOL' })).status).toBe(200);
  });
});

describe('历史 API', () => {
  it('POST 历史上传 → 记录可查', async () => {
    const text = `history-${RUN}`;
    const hash = sha256(text);
    const form = new FormData();
    form.set('hash', hash);
    form.set('type', 'Text');
    form.set('text', text);
    form.set('createTime', '2026-09-12T00:00:00Z');
    form.set('lastModified', '2026-09-12T00:00:00Z');
    form.set('lastAccessed', '2026-09-12T00:00:00Z');
    form.set('starred', 'false');
    form.set('pinned', 'false');
    form.set('version', '0');
    form.set('isDeleted', 'false');
    form.set('size', String(text.length));

    const res = await req('/api/history', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const dto = await res.json() as { type: string; hash: string; text: string };
    expect(dto).toMatchObject({ type: 'Text', hash, text });

    const got = await (await req(`/api/history/Text-${hash}`)).json() as { hash: string };
    expect(got.hash).toBe(hash);
  });

  it('POST 历史上传数据校验失败 → 422 code=history_data_invalid', async () => {
    const form = new FormData();
    form.set('hash', 'A'.repeat(64));
    form.set('type', 'File');
    form.set('text', 'bad.bin');
    form.set('version', '0');
    form.set('isDeleted', 'false');
    form.set('size', '3');
    form.set('data', new Blob(['bad'], { type: 'application/octet-stream' }), 'bad.bin');

    const res = await req('/api/history', { method: 'POST', body: form });
    expect(res.status).toBe(422);
    const problem = await res.json() as { code: string; status: number };
    expect(problem.code).toBe('history_data_invalid');
    expect(problem.status).toBe(422);
  });

  it('PATCH：旧版本 → 409 回写服务器值；新版本 → 200', async () => {
    const text = `patch-${RUN}`;
    const hash = sha256(text);
    const form = new FormData();
    form.set('hash', hash);
    form.set('type', 'Text');
    form.set('text', text);
    form.set('version', '0');
    form.set('isDeleted', 'false');
    await req('/api/history', { method: 'POST', body: form });

    // 服务器时间较新：发送 2020 年的 lastModified（gap > 5min → 按时间判定 → 不更新 → 409）
    const conflict = await req(`/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 0, lastModified: '2020-01-01T00:00:00Z', starred: true }),
    });
    expect(conflict.status).toBe(409);
    const payload = await conflict.json() as { starred: boolean };
    expect(payload).toHaveProperty('starred');

    const ok = await req(`/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, lastModified: new Date().toISOString(), starred: true }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('');
  });

  it('PATCH 不存在 → 404', async () => {
    // 目标必须是**本文件不会产生、且外部也几乎不可能留下**的 hash：同文件 :140/:186 用的是
    // 共享常量 'A'.repeat(64)（那两处期望 400，不会落库），但历史探针在本地库留下过同 hash 的
    // 软删行 ⇒ 这条会在本机红、CI 绿。用每次运行唯一的 64 位小写 hex（服务端 hash 大小写不敏感）。
    const absentHash = (randomUUID() + randomUUID()).replace(/-/g, '');
    const res = await req(`/api/history/Text/${absentHash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it('query 分页 + 类型过滤', async () => {
    const form = new FormData();
    form.set('Page', '1');
    form.set('Types', 'All');
    const res = await req('/api/history/query', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ type: string }>;
    expect(Array.isArray(list)).toBe(true);
    for (const item of list) {
      expect(['Text', 'File', 'Image', 'Group']).toContain(item.type);
    }
  });

  it('statistics 返回计数', async () => {
    const res = await req('/api/history/statistics');
    expect(res.status).toBe(200);
    const stats = await res.json() as { totalCount: number; activeCount: number };
    expect(stats).toHaveProperty('totalCount');
    expect(stats).toHaveProperty('activeCount');
  });
});
