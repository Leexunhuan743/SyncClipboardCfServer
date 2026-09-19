// HTTP 协议黑盒测试（docs/protocol.md §4-§5）
// 前置：本地 dev server 已运行（npm run dev），BASE 默认 http://127.0.0.1:8787
import { describe, expect, it, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { assertWritableTarget } from './support/target-guard';
import { normalizeProtocolPath } from '../src/pathCase';
import { createWebdavRoutes } from '../src/routes/webdav';
import { createHistoryRoutes } from '../src/routes/history';
import { createUiRoutes } from '../src/ui/routes';

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

// 2026-09-15 用官方 v3.2.0 服务端发布件 A/B 实测：ASP.NET Core 的路由对**字面段**不区分大小写
// （`/API/version`、`/SyncClipboard.JSON`、`/api/history/Statistics`、`/SYNCCLIPBOARDHUB/negotiate`
// 全部 200），而 Hono 与入口的 `url.pathname === HUB_PATH` 都是精确比较 ⇒ 曾一律 404/400。
// 修复：src/pathCase.ts 的归一表（只归一字面段、取值原样保留），在入口最前面应用。见 docs/progress.md §44。
describe('路径字面段大小写（对齐 ASP.NET Core 路由）', () => {
  it('归一函数：只动字面段，取值与超出协议面的路径一律原样', () => {
    const cases: [string, string | null][] = [
      // 需要归一的（上游同样命中）
      ['/API/version', '/api/version'],
      ['/api/VERSION', '/api/version'],
      ['/API/Version', '/api/version'],
      ['/API/time', '/api/time'],
      ['/SyncClipboard.JSON', '/SyncClipboard.json'],
      ['/syncclipboard.json', '/SyncClipboard.json'],
      ['/FILE/x.txt', '/file/x.txt'],
      ['/File', '/file'],
      ['/api/HISTORY/STATISTICS', '/api/history/statistics'],
      ['/api/history/Query', '/api/history/query'],
      ['/api/history/CLEAR', '/api/history/clear'],
      ['/api/history/Text-ABC/DATA', '/api/history/Text-ABC/data'],
      ['/SYNCCLIPBOARDHUB/negotiate', '/SyncClipboardHub/negotiate'],
      ['/SyncClipboardHub/NEGOTIATE', '/SyncClipboardHub/negotiate'],
      // **不**归一：都是"取值"、不属于协议面，或本来就是规范写法（无需改写 ⇒ null）
      ['/SyncClipboardHub', null],
      // **不**归一：都是"取值"或不属于协议面
      ['/file/Statistics', null], // 名为 Statistics 的文件，改了就会查错对象
      ['/file/SyncClipboard.json', null],
      ['/api/history/text-ABC', null], // profileId 是取值（类型枚举大小写另有登记，见 protocol.md §10）
      ['/api/history/Text-ABC', null],
      ['/api/history/Text-ABC/data', null], // 末段已是规范写法，取值未被触碰
      ['/api/version/x', null], // 位置错了就不动（宁可 404，也不猜）
      ['/ui_v2/API/session', null], // 超出协议面（/ui 是我们自己的面，上游无参系物）
      ['/ui_v2/JS/main.js', null],
      ['/', null],
      ['/robots.txt', null],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeProtocolPath(input), input).toBe(expected);
      // 幂等：归一结果再走一遍必须"无需改动"，否则会在入口里反复重写请求
      if (expected !== null) expect(normalizeProtocolPath(expected), `幂等 ${expected}`).toBeNull();
    }
  });

  it('HTTP：字面段大小写变体命中同一端点（上游实测同为 200）', async () => {
    const version = await (await req('/api/version')).text();

    const upperVersion = await req('/API/VERSION');
    expect(upperVersion.status).toBe(200);
    expect(await upperVersion.text()).toBe(version);

    const mixedTime = await req('/API/Time');
    expect(mixedTime.status).toBe(200);
    expect(mixedTime.headers.get('content-type') ?? '').toContain('application/json');

    const profile = await req('/SYNCCLIPBOARD.JSON');
    expect(profile.status).toBe(200);

    const stats = await req('/api/history/STATISTICS');
    expect(stats.status).toBe(200);
    expect(stats.headers.get('content-type') ?? '').toContain('application/json');

    const negotiate = await fetch(`${BASE}/SYNCCLIPBOARDHUB/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers: { Authorization: AUTH },
    });
    expect(negotiate.status).toBe(200);
    expect(((await negotiate.json()) as { negotiateVersion?: number }).negotiateVersion).toBe(1);
  });

  // 守卫：新增端点若引入新的字面段而忘记登记进归一表，这条会红（否则就是"静默地只有部分段不区分大小写"）
  it('守卫：协议面每个字面段都被归一表覆盖', () => {
    const probe = new Hono();
    probe.route('/', createWebdavRoutes());
    probe.route('/', createHistoryRoutes());
    probe.route('/', createUiRoutes());
    probe.get('/api/version', (c) => c.text(''));
    probe.get('/api/time', (c) => c.text(''));

    const paths = new Set<string>(probe.routes.map((r) => r.path));
    // 入口里直接注册的端点（`app.<method>('...')`）也要纳入；index.ts 不能导出 app（模块格式要求具名导出都是函数）
    const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    for (const m of indexSrc.matchAll(/app\.(?:get|post|put|patch|delete|all|on)\(\s*'([^']+)'/g)) {
      const found = m[1];
      if (found !== undefined) paths.add(found);
    }
    paths.add('/SyncClipboardHub');
    paths.add('/SyncClipboardHub/negotiate');

    const uncovered: string[] = [];
    for (const p of paths) {
      const segs = p.split('/');
      const first = (segs[1] ?? '').toLowerCase();
      // 只审协议面；`/ui_v2/*` 与静态资源不在归一范围内（见 src/pathCase.ts 顶部约束 2）
      if (!['api', 'file', 'syncclipboard.json', 'syncclipboardhub'].includes(first)) continue;

      // 构造"字面段全大写 + 参数段用哨兵"的请求路径，期望归一后回到路由本身
      const upper: string[] = [];
      const expected: string[] = [];
      segs.forEach((seg, i) => {
        if (seg === '') {
          upper.push('');
          expected.push('');
        } else if (seg.startsWith(':') || seg.startsWith('*')) {
          const sentinel = `VALUE${i}`;
          upper.push(sentinel);
          expected.push(sentinel);
        } else {
          upper.push(seg.toUpperCase());
          expected.push(seg);
        }
      });
      const got = normalizeProtocolPath(upper.join('/'));
      if (got !== expected.join('/')) {
        uncovered.push(`${p} → ${upper.join('/')} 归一为 ${String(got)}（期望 ${expected.join('/')}）`);
      }
    }
    expect(uncovered, '以下路由的字面段未被 src/pathCase.ts 覆盖').toEqual([]);
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

// 表单端点的媒体类型语义（上游模型绑定，见 docs/protocol.md §10 的「415 / urlencoded」行）：
//   POST /api/history        —— 上游有显式 [Consumes("multipart/form-data")]，非 multipart 在模型绑定
//                               之前就被拒 → 415（客户端按状态码分支，故不能报成 400）
//   POST /api/history/query  —— 上游只有 [FromForm]（无 Consumes 约束）：ASP.NET 的
//                               FormValueProviderFactory 同时接受 multipart 与 application/x-www-form-urlencoded
describe('表单端点的 Media-Type 语义', () => {
  it('POST /api/history：非 multipart → 415', async () => {
    const res = await req('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(415);
  });

  it('POST /api/history：multipart 但缺 boundary → 400', async () => {
    const res = await req('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data' },
      body: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/history/query：接受 application/x-www-form-urlencoded，且字段真的被解析', async () => {
    // 用一个必然匹配不到记录的搜索词：返回空数组即证明 SearchText 被读到（只回 200 不足以证明）
    const body = new URLSearchParams({ Page: '1', Types: 'All', SearchText: `none-${RUN}` }).toString();
    const res = await req('/api/history/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('POST /api/history/query：urlencoded 的非法 Page 与 multipart 同一套绑定语义 → 400', async () => {
    const res = await req('/api/history/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'Page=not-a-number',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/history 的 415 不会污染后续请求（提前返回前排空请求体）', async () => {
    // 回归点：带 body 的请求若在未读完入站体时就返回响应，Workers 运行时会抛
    // 「Can't read from request stream after response has been sent.」并让**后续**请求以 503 结束
    // （src/auth.ts 的 drainRequestBody 注释记录了实测过程）。这里用带固定长度 body 的 415 打头，
    // 紧接着发一个正常请求验证本 isolate 还活着。
    const rejected = await req('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '4' },
      body: 'ping',
    });
    expect(rejected.status).toBe(415);
    const after = await req('/api/version');
    expect(after.status).toBe(200);
  });
});
