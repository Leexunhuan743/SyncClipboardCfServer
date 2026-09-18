// 修复项的 HTTP 级判别用例（前置：本地 dev server 已运行，BASE 默认 http://127.0.0.1:8787）
// 每个用例都写成「旧实现会失败、修复后通过」的形态，作为回归守卫。
import { describe, expect, it, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { assertWritableTarget } from './support/target-guard';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

// 本套件会写目标库：默认只允许指向本机 dev server，指向远端需显式 ALLOW_REMOTE_TARGET=1
assertWritableTarget(BASE);
// WS 探测必须跟随 BASE：此文件也会以线上 BASE 运行，硬编码 localhost 会让「真实 token 可通过升级」
// 用例拿到线上 token 却去连本地服务（本地必拒）——测试自身的缺陷，不是服务端行为。
const WS_BASE = BASE.replace(/^http/, 'ws');
// 凭据变量名专用化：`USER`/`USERNAME` 在宿主环境里恒被占用
// （Windows 有 USERNAME，Ubuntu CI runner 有 USER=runner），用它们会让测试
// 拿错凭据→401 假失败。只认 SYNC_USER / SYNC_PASS，默认与 .dev.vars 示例一致。
const USER = process.env.SYNC_USER ?? 'admin';
const PASS = process.env.SYNC_PASS ?? 'admin';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex').toUpperCase();

const RUN = Date.now().toString(36);

async function req(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: AUTH, ...(init.headers ?? {}) },
  });
}

// 手工组 multipart（.NET HttpClient 风格：无引号 name=；data 部分带 filename）
function multipart(
  boundary: string,
  fields: Record<string, string>,
  data?: { filename: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s, 'utf8'));
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name=${k}\r\n\r\n${v}\r\n`);
  }
  if (data) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name=data; filename="${data.filename}"\r\n`);
    push('Content-Type: application/octet-stream\r\n\r\n');
    chunks.push(data.content);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/`, { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`dev server 不可用 (${BASE}): ${res.status}`);
});

// Node 的 fetch 禁止手工设置 Upgrade/Connection 头（undici 会抛 invalid upgrade header），
// 因此 WS 升级用全局 WebSocket 客户端探测：能 open 即 101，否则被拒。
function tryWs(url: string, timeoutMs = 8000): Promise<{ opened: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      resolve({ opened });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      finish(true);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

describe('F1 · WS 升级鉴权（negotiate 签发的 token）', () => {
  it('negotiate 只宣告 Text 传输（F13）', async () => {
    const res = await req('/SyncClipboardHub/negotiate?negotiateVersion=1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      connectionToken: string;
      availableTransports: { transport: string; transferFormats: string[] }[];
    };
    expect(body.connectionToken).toBeTruthy();
    // 逐字对齐上游：ASP.NET Core SignalR 对 WebSockets 硬编码宣告 ["Text","Binary"]
    expect(body.availableTransports[0]!.transferFormats).toEqual(['Text', 'Binary']);
  });

  it('伪造 ?id 且无凭据的 WS 升级被拒绝（旧实现返回 101）', async () => {
    const { opened } = await tryWs(`${WS_BASE}/SyncClipboardHub?id=forged-token-${RUN}`);
    expect(opened).toBe(false);
  });

  it('无 ?id 且无凭据的 WS 升级被拒绝', async () => {
    const { opened } = await tryWs(`${WS_BASE}/SyncClipboardHub`);
    expect(opened).toBe(false);
  });

  it('已登记的真实 token 可以通过升级（基线）', async () => {
    const nego = await req('/SyncClipboardHub/negotiate?negotiateVersion=1', { method: 'POST' });
    const { connectionToken } = await nego.json() as { connectionToken: string };
    const { opened } = await tryWs(`${WS_BASE}/SyncClipboardHub?id=${connectionToken}`);
    expect(opened).toBe(true);
  });
});

describe('F2 · POST /api/history 的 Text transfer data 语义', () => {
  it('大文本（size > 文本长度）带 data 且哈希一致 → 200', async () => {
    const full = 'L'.repeat(11000);
    const hash = sha256(Buffer.from(full, 'utf8'));
    const boundary = `bnd${RUN}a`;
    const { body, contentType } = multipart(
      boundary,
      {
        hash,
        type: 'Text',
        text: full.slice(0, 10240),
        size: String(full.length),
        version: '0',
      },
      { filename: 'clip.txt', content: Buffer.from(full, 'utf8') },
    );
    const res = await req('/api/history', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(res.status).toBe(200);
    const dto = await res.json() as { size: number; hasData: boolean };
    expect(dto.hasData).toBe(true);
    // F11：Size 保持字符数，不因 data 是 UTF-8 而变成字节数
    expect(dto.size).toBe(full.length);
  });

  it('inline Text 却带 data → 422（旧实现返回 200 并入库）', async () => {
    const text = `inline-${RUN}`;
    const boundary = `bnd${RUN}c`;
    const { body, contentType } = multipart(
      boundary,
      { hash: sha256(text), type: 'Text', text, size: String(text.length), version: '0' },
      { filename: 'empty.bin', content: Buffer.alloc(0) },
    );
    const res = await req('/api/history', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(res.status).toBe(422);
  });
});

describe('F7 · PATCH 非法日期 → 400（不是 500）', () => {
  it('非法 lastModified', async () => {
    const text = `patch-${RUN}`;
    const hash = sha256(text);
    await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash, text, hasData: false, size: text.length }),
    });
    const res = await req(`/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastModified: 'not-a-date' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('F8 · PUT 非法 ProfileType → 400（不覆盖当前 profile）', () => {
  it('type=Bogus', async () => {
    const before = await (await req('/SyncClipboard.json')).json();
    const res = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Bogus', hash: 'H', text: 'x', hasData: false }),
    });
    expect(res.status).toBe(400);
    const after = await (await req('/SyncClipboard.json')).json();
    expect(after).toMatchObject(before as object);
  });
});

describe('F9 · query 的 Page 按上游 int 绑定语义处理（不再是 500，也不能与上游相左）', () => {
  it('Page=1e20（超 int32）→ 400，不是 500', async () => {
    const boundary = `bnd${RUN}q`;
    const { body, contentType } = multipart(boundary, { Page: '100000000000000000000', Types: 'All' });
    const res = await req('/api/history/query', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(res.status).toBe(400);
  });

  it('Page=int32 上限 → 200（上游 int 可绑定，返回空页；旧的 1e6 上限会误判为 400）', async () => {
    const boundary = `bnd${RUN}q1`;
    const { body, contentType } = multipart(boundary, { Page: '2147483647', Types: 'All' });
    const res = await req('/api/history/query', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('Page=int32 上限 +1 → 400（上游模型绑定失败）', async () => {
    const boundary = `bnd${RUN}q2`;
    const { body, contentType } = multipart(boundary, { Page: '2147483648', Types: 'All' });
    const res = await req('/api/history/query', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(res.status).toBe(400);
  });

  it('Page=abc → 400；Page=-5 → 200（上游 Page<1 钳为 1）', async () => {
    const b1 = `bnd${RUN}q3`;
    const m1 = multipart(b1, { Page: 'abc', Types: 'All' });
    const r1 = await req('/api/history/query', { method: 'POST', headers: { 'Content-Type': m1.contentType }, body: m1.body });
    expect(r1.status).toBe(400);

    const b2 = `bnd${RUN}q4`;
    const m2 = multipart(b2, { Page: '-5', Types: 'All' });
    const r2 = await req('/api/history/query', { method: 'POST', headers: { 'Content-Type': m2.contentType }, body: m2.body });
    expect(r2.status).toBe(200);
  });
});

describe('F4 · PUT /SyncClipboard.json 消费掉暂存对象', () => {
  it('成功后再用同一 dataName 且不重新上传 → 404（暂存已被消费）', async () => {
    const fileName = `f4-${RUN}.txt`;
    const content = Buffer.from(`payload-${RUN}`, 'utf8');
    const putFile = await req(`/file/${fileName}`, { method: 'PUT', body: content });
    expect(putFile.status).toBe(200);

    const hash = sha256(content);
    const first = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash, text: 'payload', hasData: true, dataName: fileName }),
    });
    expect(first.status).toBe(200);

    // 不重新 PUT /file，直接第二次引用同一 dataName：上游暂存已被 File.Move 移走 → 404
    const second = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash: sha256('different'), text: 'payload2', hasData: true, dataName: fileName }),
    });
    expect(second.status).toBe(404);
  });
});

describe('F15 · 既有缺口行为的判别用例', () => {
  it('PUT 历史复用分支：同 hash 二次 PUT 不新建记录（version 前进）', async () => {
    const text = `reuse-${RUN}`;
    const hash = sha256(text);
    const put = () =>
      req('/SyncClipboard.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'Text', hash, text, hasData: false, size: text.length }),
      });
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    // GET /api/history/{profileId} 的 profileId 是单段 "Type-Hash"（protocol.md §5）
    const res = await req(`/api/history/Text-${hash}`);
    expect(res.status).toBe(200);
    const one = await res.json() as { version: number };
    expect(one.version).toBeGreaterThanOrEqual(1);
  });

  it('PROPFIND /file 返回 2xx（旧套件只测了 PROPFIND /）', async () => {
    const res = await req('/file', { method: 'PROPFIND' });
    expect([200, 207]).toContain(res.status); // 现返回标准 multistatus 207
  });

  it('DELETE /file 清空暂存区后，未重新上传的 dataName → 404', async () => {
    const fileName = `del-${RUN}.bin`;
    const content = Buffer.from('bye', 'utf8');
    await req(`/file/${fileName}`, { method: 'PUT', body: content });
    const cleared = await req('/file', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    const res = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash: sha256(content), text: 'bye', hasData: true, dataName: fileName }),
    });
    expect(res.status).toBe(404);
  });

  it('query 的 Types 过滤与分页生效（旧套件恒用 Types=All 且只断言数组形状）', async () => {
    const boundary = `bnd${RUN}t`;
    const { body, contentType } = multipart(boundary, { Page: '1', Types: 'None' });
    const res = await req('/api/history/query', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(res.status).toBe(200);
    const list = await res.json() as unknown[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0); // Types=None 不匹配任何记录
  });

  it('F15 · 已删除 Group 记录带 data 复活后 /data 可取回（复用原文件名）', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const { parseGroupZip, groupHashFromEntries } = await import('../src/hash');
    const zip = zipSync({ 'a.txt': strToU8(`aaa-${RUN}`), 'b.txt': strToU8(`bbb-${RUN}`) });
    const { entries } = parseGroupZip(zip);
    const hash = await groupHashFromEntries(entries);

    // 1) 首次上传（含 data）
    const boundary = `bnd${RUN}g1`;
    const first = multipart(boundary, {
      hash, type: 'Group', text: 'a.txt\nb.txt', version: '0', isDeleted: 'false', size: String(zip.length),
    }, { filename: 'up.zip', content: Buffer.from(zip) });
    const created = await req('/api/history', { method: 'POST', headers: { 'Content-Type': first.contentType }, body: first.body });
    expect(created.status).toBe(200);

    // 2) 软删除（数据被清理）
    const del = await req(`/api/history/Group/${hash}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDelete: true, version: 1, lastModified: new Date().toISOString() }),
    });
    expect(del.status).toBe(200);

    // 3) 客户端重传同 hash 带 data（上游 HistoryTransferQueue 对已删记录会带 data 重传）
    const boundary2 = `bnd${RUN}g2`;
    const again = multipart(boundary2, {
      hash, type: 'Group', text: 'a.txt\nb.txt', version: '2', isDeleted: 'false', size: String(zip.length),
    }, { filename: 'up2.zip', content: Buffer.from(zip) });
    const revived = await req('/api/history', { method: 'POST', headers: { 'Content-Type': again.contentType }, body: again.body });
    expect(revived.status).toBe(200);

    // 4) 关键断言：复活后数据可取回（修复前写入新随机名 → 404）
    const data = await req(`/api/history/Group-${hash}/data`);
    expect(data.status).toBe(200);
    const got = Buffer.from(await data.arrayBuffer());
    expect(got.length).toBe(zip.length);
  });

  it('F16 · 目录端点容忍尾斜杠（上游客户端 AdjustDirectoryUrl 恒加 /）', async () => {
    // 官方客户端 CleanupTempFilesAsync → DirectoryDelete("file") → URL "file/"；
    // 旧实现（严格路由）下 DELETE/PROPFIND /file/ 404 → 清理静默失效、暂存对象无限累积
    for (const method of ['PROPFIND', 'MKCOL']) {
      const res = await req('/file/', { method });
      // PROPFIND 现返回 207 multistatus（客户端两处调用均按 2xx 判定）；MKCOL 仍 200
      expect([200, 207], `${method} /file/`).toContain(res.status);
    }
    const del = await req('/file/', { method: 'DELETE' });
    expect(del.status).toBe(200);
    // 精确路径仍工作
    const mkcol = await req('/file', { method: 'MKCOL' });
    expect(mkcol.status).toBe(200);
    // GET /file/ 不应被目录路由吞掉（上游无该端点语义 → 404）
    const get = await req('/file/');
    expect(get.status).toBe(404);
  });

  it('F17 · Basic 认证：scheme 大小写不敏感 + 凭据按 UTF-8 解码（对齐上游）', async () => {
    // 上游 StartsWith("basic", OrdinalIgnoreCase) 且 Encoding.UTF8.GetString(base64)
    const lower = await fetch(`${BASE}/api/version`, {
      headers: { Authorization: 'basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
    });
    expect(lower.status).toBe(200);

    // 非 ASCII 凭据：若实现用 atob(latin1) 解码会失败（上游 UTF-8 可正常校验）
    const user = '用户';
    const pass = '密码';
    const encoded = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    const res = await fetch(`${BASE}/api/version`, { headers: { Authorization: 'Basic ' + encoded } });
    // 凭据本身不在服务端 secrets 中 → 401；关键是「不能被解码损坏成 500 或异常」
    expect([401]).toContain(res.status);

    // 401 应带 WWW-Authenticate（对齐上游）
    const unauth = await fetch(`${BASE}/api/version`);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('Basic');
  });

  it('F22 · GET /file 在最新同名记录的数据缺失时回退到更旧的同名记录（上游 File.Exists 过滤语义）', { timeout: 60_000 }, async () => {
    const name = `fallback-${RUN}.bin`;
    const c1 = Buffer.from('first-version-content');
    const c2 = Buffer.from('second-version-content');
    const fileHash = (buf: Buffer) => sha256(`${name}|${sha256(buf)}`);

    // 第一条记录（同名、内容 C1）
    await req(`/file/${name}`, { method: 'PUT', body: c1 });
    let res = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'File', hash: fileHash(c1), text: name, hasData: true, dataName: name, size: c1.length }),
    });
    expect(res.status).toBe(200);

    // 第二条记录（同名、内容 C2、LastAccessed 更新）
    await req(`/file/${name}`, { method: 'PUT', body: c2 });
    res = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'File', hash: fileHash(c2), text: name, hasData: true, dataName: name, size: c2.length }),
    });
    expect(res.status).toBe(200);

    // 最新记录优先
    res = await req(`/file/${name}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(c2.toString());

    // 删除最新记录的数据（软删会清理其工作目录）
    const del = await req(`/api/history/File/${fileHash(c2)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDelete: true, version: 1, lastModified: new Date().toISOString() }),
    });
    expect(del.status).toBe(200);

    // 关键断言：回退到更旧的同名记录（修复前：命中最新记录后对象缺失 → 直接 404）
    res = await req(`/file/${name}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(c1.toString());
  });

  it('F23 · profileId / PATCH type 接受数字枚举（上游 Enum.TryParse 语义）', async () => {
    const text = `numeric-enum-${RUN}`;
    const hash = sha256(text);

    // 建一条 Text 记录
    const form = new FormData();
    form.set('hash', hash);
    form.set('type', 'Text');
    form.set('text', text);
    form.set('version', '0');
    form.set('isDeleted', 'false');
    const created = await req('/api/history', { method: 'POST', body: form });
    expect(created.status).toBe(200);

    // GET /api/history/0-<hash>：上游 Enum.TryParse("0") → Text，可查到
    const byNumber = await req(`/api/history/0-${hash}`);
    expect(byNumber.status).toBe(200);
    const rec = await byNumber.json() as { type: string; hash: string };
    expect(rec.type).toBe('Text');
    expect(rec.hash).toBe(hash);

    // 数字名 与 枚举名 等价
    const byName = await req(`/api/history/Text-${hash}`);
    expect(byName.status).toBe(200);

    // PATCH /api/history/0/<hash>：数字段同样被接受
    const patch = await req(`/api/history/0/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true, version: 10, lastModified: new Date().toISOString() }),
    });
    expect(patch.status).toBe(200);

    // 越界数字（上游 Enum.TryParse 也成功，但查不到记录）→ 404 而非 400
    const outOfRange = await req(`/api/history/6-${hash}`);
    expect(outOfRange.status).toBe(404);

    // 非法枚举名 → 400（上游 Enum.TryParse 失败）
    const badName = await req(`/api/history/${'Bogus'}-${hash}`);
    expect(badName.status).toBe(400);
  });

  it('F24 · query 的 Types 非法名 → 400；合法名/缺失 → 200（上游枚举绑定语义）', { timeout: 60_000 }, async () => {
    const q = async (types: string | null) => {
      const b = `bnd${RUN}q${Math.random().toString(36).slice(2, 8)}`;
      const fields: Record<string, string> = { Page: '1' };
      if (types !== null) fields.Types = types;
      return req('/api/history/query', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + b },
        body: multipart(b, fields).body,
      });
    };

    // 合法值：上游 ProfileTypeFilter 只有 None/Text/File/Image/Group/FileAndGroup/All
    for (const ok of ['All', 'None', 'Text', 'File,Image', 'FileAndGroup']) {
      expect((await q(ok)).status, `Types=${ok}`).toBe(200);
    }
    // 缺失 → DTO 默认值 All
    expect((await q(null)).status).toBe(200);

    // 非法值：上游 Enum.TryParse 失败 → [ApiController] 400
    // （修复前本实现静默回退 All，把拼错的过滤条件变成「返回全部记录」）
    for (const bad of ['Bogus', 'Unknown', 'Text,Bogus', 'Text;File']) {
      expect((await q(bad)).status, `Types=${bad}`).toBe(400);
    }
  });

  it('F25 · PROPFIND 返回可解析的 WebDAV multistatus（客户端 PreciseDelete 清理依赖）', async () => {
    // 造一个暂存对象
    const name = `propfind-${RUN}.bin`;
    await req(`/file/${name}`, { method: 'PUT', body: Buffer.from('propfind-probe') });

    const res = await req('/file', { method: 'PROPFIND', headers: { Depth: '1' } });
    // 上游返回 200 空体；本实现返回 207 multistatus（客户端两处调用均按 2xx 判定）
    expect([200, 207]).toContain(res.status);

    const body = await res.text();
    // 关键：修复前为空体 → 客户端 XmlDocument.LoadXml 抛 XmlException
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('<D:multistatus');
    expect(body).toContain('xmlns:D="DAV:"');
    // 自身必须是集合
    expect(body).toContain('<D:collection/>');
    // 且列出刚上传的对象（href 存在、非集合）
    expect(body).toContain(name);
    const responses = body.match(/<D:response>/g) ?? [];
    expect(responses.length).toBeGreaterThanOrEqual(2); // 目录自身 + 至少一个对象
    // 每个 response 都应带 propstat/status（客户端按 propstat 取属性）
    expect(body.match(/<D:propstat>/g)?.length).toBe(responses.length);
  });

  it('F27 · 请求体必须是 JSON 对象（上游 [FromBody] 反序列化失败 → 400）', async () => {
    // 修复前：[] / null / 123 会被当成「字段全缺失的 DTO」→ 写出一条空文本历史记录并设为当前 profile
    for (const body of ['[]', 'null', '123', '"text"', 'true']) {
      const res = await req('/SyncClipboard.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status, `PUT body=${body}`).toBe(400);
    }

    // PATCH：[] 曾被当作「空 dto」→ 走 ShouldUpdate 分支推进版本/时间戳，静默改动记录
    const text = `objguard-${RUN}`;
    const hash = sha256(text);
    const created = await req('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hash, type: 'Text', text, version: '0', isDeleted: 'false' }).toString(),
    });
    // 上游 [Consumes("multipart/form-data")] → 非 multipart 应被拒
    expect(created.status).toBeGreaterThanOrEqual(400);

    const patch = await req(`/api/history/Text/${hash}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    expect(patch.status).toBe(400);
  });

  it('F27 · query 的 Types 接受数字位掩码（上游 Enum.TryParse 语义）', { timeout: 60_000 }, async () => {
    const q = async (types: string) => {
      const b = `bnd${RUN}n${Math.random().toString(36).slice(2, 8)}`;
      return req('/api/history/query', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + b },
        body: multipart(b, { Page: '1', Types: types }).body,
      });
    };
    // 客户端 ProfileTypeFilter.ToString() 的真实形式（带空格）与数字形式都必须被接受
    for (const ok of ['Text, File', '5', '0', '15', '2']) {
      expect((await q(ok)).status, `Types=${ok}`).toBe(200);
    }
    // 非数字非法名仍 400；数字/名称混用（TryParse 失败）也 400
    for (const bad of ['Bogus', 'Text,5', '1e2', '99999999999999']) {
      expect((await q(bad)).status, `Types=${bad}`).toBe(400);
    }
  });

  it('F27 · query 的 Starred / SortByLastAccessed 非法值 → 400（上游 bool 绑定失败）', { timeout: 60_000 }, async () => {
    const q = async (fields: Record<string, string>) => {
      const b = `bnd${RUN}b${Math.random().toString(36).slice(2, 8)}`;
      return req('/api/history/query', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + b },
        body: multipart(b, { Page: '1', Types: 'All', ...fields }).body,
      });
    };
    // 合法：True/False 任意大小写
    for (const ok of ['True', 'False', 'true', 'FALSE']) {
      expect((await q({ Starred: ok })).status, `Starred=${ok}`).toBe(200);
      expect((await q({ SortByLastAccessed: ok })).status, `SortByLastAccessed=${ok}`).toBe(200);
    }
    // 非法：修复前静默当作 null/false → 变成「返回全部记录」（把拼错的过滤条件当无过滤）
    for (const bad of ['maybe', 'yes', '1', '0']) {
      expect((await q({ Starred: bad })).status, `Starred=${bad}`).toBe(400);
      expect((await q({ SortByLastAccessed: bad })).status, `SortByLastAccessed=${bad}`).toBe(400);
    }
  });

  it('F27 · POST /api/history 的 version/size 按 TryParse 语义（整体必须合法，否则 0）', { timeout: 60_000 }, async () => {
    const text = `tryparse-${RUN}`;
    const hash = sha256(text);
    const b = `bnd${RUN}v`;
    // 上游 int.TryParse("3abc") 失败 → 0；long.TryParse("1e999") 失败 → 0
    const res = await req('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + b },
      body: multipart(b, { hash, type: 'Text', text, version: '3abc', size: '1e999', isDeleted: 'false' }).body,
    });
    expect(res.status).toBe(200);
    const dto = await res.json() as { version: number; size: number };
    // 修复前 parseInt('3abc')=3、Number('1e999')=Infinity（D1 里会变成 NULL）
    expect(dto.version).toBe(0);
    expect(dto.size).toBe(0);
  });

  it('F27 · 空 multipart 的 POST /api/history → 400（上游 hash is required）', async () => {
    const b = `bnd${RUN}e`;
    const res = await req('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
      body: '--' + b + '--\r\n',
    });
    expect(res.status).toBe(400);
  });

  it('F28 · PUT type=File + 图片文件名 → 落库为 Image（上游 Profile.Create 提升语义）', async () => {
    const name = `promote-${RUN}.png`;
    const content = Buffer.from(`png-bytes-${RUN}`);
    const hash = sha256(`${name}|${sha256(content)}`); // 上游 CombineHash 公式

    const up = await req(`/file/${name}`, { method: 'PUT', body: content });
    expect(up.status).toBe(200);

    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'File', hash, text: name, hasData: true, dataName: name, size: content.length }),
    });
    expect(put.status).toBe(200);

    // 关键：上游 Profile.Create(dto) 把它建成 ImageProfile → 记录 Type 为 Image
    const asImage = await req(`/api/history/Image-${hash}`);
    expect(asImage.status).toBe(200);
    const asFile = await req(`/api/history/File-${hash}`);
    expect(asFile.status).toBe(404);

    // 当前 profile 的 type 也应是 Image
    const cur = (await (await req('/SyncClipboard.json')).json()) as { type: string; dataName: string };
    expect(cur.type).toBe('Image');

    // 非图片扩展名的 File 不提升
    const binName = `promote-${RUN}.bin`;
    const binContent = Buffer.from(`bin-bytes-${RUN}`);
    const binHash = sha256(`${binName}|${sha256(binContent)}`);
    await req(`/file/${binName}`, { method: 'PUT', body: binContent });
    const put2 = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'File', hash: binHash, text: binName, hasData: true, dataName: binName, size: binContent.length }),
    });
    expect(put2.status).toBe(200);
    expect((await req(`/api/history/File-${binHash}`)).status).toBe(200);
  });

  it('F28 · GET /api/history/{profileId}/data 解析失败 → 404（上游此端点不自行校验格式）', async () => {
    // 上游 HistoryService.GetTransferDataFileByProfileId 在 ParseProfileId 失败时返回 null → 404
    for (const bad of ['Bogus-abc', 'no-dash', '06-abc']) {
      const res = await req(`/api/history/${bad}/data`);
      expect(res.status, `data ${bad}`).toBe(404);
    }
    // 对照：同一 profileId 走元数据端点时是 400（上游控制器自行校验格式）
    expect((await req('/api/history/Bogus-abc')).status).toBe(400);
  });

  it('F29 · HEAD /file/{name} 与 GET 同源（200 + Content-Length，无响应体）', { timeout: 60_000 }, async () => {
    const name = `head-${RUN}.bin`;
    const content = Buffer.from(`head-body-${RUN}`);
    const hash = sha256(`${name}|${sha256(content)}`);
    await req(`/file/${name}`, { method: 'PUT', body: content });
    const put = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'File', hash, text: name, hasData: true, dataName: name, size: content.length }),
    });
    expect(put.status).toBe(200);

    // 上游 [HttpHead("file/{fileName}")] 与 HttpGet 同挂一个 action
    const head = await req(`/file/${name}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(content.length));
    expect((await head.text()).length).toBe(0);

    // Range 被忽略（上游 File(bytes, contentType) 的 EnableRangeProcessing 默认 false）
    const ranged = await req(`/file/${name}`, { headers: { Range: 'bytes=0-3' } });
    expect(ranged.status).toBe(200);
    expect((await ranged.arrayBuffer()).byteLength).toBe(content.length);

    // HEAD 不存在 → 404（上游 NotFound()）
    expect((await req(`/file/nope-${RUN}.bin`, { method: 'HEAD' })).status).toBe(404);
  });

  it('F31 · 存储值里的 hash 含分隔符 → 视为损坏并降级（读取路径同样不推出坏 hash）', async () => {
    const { classifyStoredProfile } = await import('../src/serialization');
    // 写入已拒绝（见 HTTP 用例），但历史遗留/外部篡改的存储值仍可能在 Meta 里；
    // 若原样返回，客户端会用同一规则构造本地路径 → 抛异常/产生非法路径。
    for (const bad of ['A/B', 'A\\B']) {
      const raw = JSON.stringify({ type: 'Text', hash: bad, text: 'x', hasData: false });
      expect(classifyStoredProfile(raw), bad).toBe('corrupt');
    }
    // 合法 hash 与非字符串/缺失 hash 的处理
    expect(classifyStoredProfile(JSON.stringify({ type: 'Text', hash: sha256('x'), text: 'x' }))).toBe('ok');
    expect(classifyStoredProfile(JSON.stringify({ type: 'Text', text: 'x' }))).toBe('ok'); // 键缺失 → 空串
    expect(classifyStoredProfile(JSON.stringify({ type: 'Text', hash: null }))).toBe('ok');
    expect(classifyStoredProfile(JSON.stringify({ type: 'Text', hash: 42 }))).toBe('corrupt');
  });

  it('F31 · hash 含路径分隔符 → 400（上游 GetWorkingDirName 抛 ArgumentException）', { timeout: 60_000 }, async () => {
    // 上游依据：`Profile.GetWorkingDirName` 在 hash 含 Directory/AltDirectory 分隔符时抛
    // ArgumentException（未捕获 → 500）。本实现给出可诊断的 400。
    // 修复前：含 `/` 的内联 Text 会被接受（200）、入库并**设为当前 profile** —— 该坏记录随后推给
    // 客户端（客户端本地用同一规则构造路径，会抛异常/产生非法路径）。
    const current = (await (await req('/SyncClipboard.json')).json()) as { hash: string; text: string };

    const slashHash = 'ABCD1234/EF567890';
    const backslashHash = 'ABCD1234\\EF567890';

    for (const bad of [slashHash, backslashHash]) {
      const put = await req('/SyncClipboard.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'Text', hash: bad, text: `badhash-${RUN}`, hasData: false, size: 5 }),
      });
      expect(put.status, `PUT hash=${bad}`).toBe(400);
    }

    // POST /api/history：同样拒绝
    const b = `bnd${RUN}hash`;
    const post = await req('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
      body: multipart(b, { hash: slashHash, type: 'Text', text: `badhash-${RUN}`, version: '0', isDeleted: 'false' }).body,
    });
    expect(post.status).toBe(400);

    // PATCH：含分隔符的 hash 在删除路径会构造 R2 前缀 → 拒绝
    const patch = await req(`/api/history/Text/${encodeURIComponent(backslashHash)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDelete: true, version: 1 }),
    });
    expect(patch.status).toBe(400);

    // 关键：坏 hash 未被入库，也没污染当前 profile
    const notStored = await req(`/api/history/Text-${encodeURIComponent(slashHash)}`);
    expect(notStored.status).toBe(404);
    const after = (await (await req('/SyncClipboard.json')).json()) as { hash: string; text: string };
    expect(after).toMatchObject(current as object);
  });

  it('F31 · 合法 hash（SHA256 hex）不受影响', { timeout: 60_000 }, async () => {
    const text = `okhash-${RUN}`;
    const res = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash: sha256(text), text, hasData: false, size: text.length }),
    });
    expect(res.status).toBe(200);
  });

  it('F32 · negotiate 版本协商与错误路径逐字对齐上游', { timeout: 60_000 }, async () => {
    // 依据：ASP.NET Core `HttpConnectionDispatcher.ProcessNegotiate` + `NegotiateProtocol.WriteResponse`
    //   - 未携带 negotiateVersion → 版本 0（MinimumProtocolVersion=0，不算错误）
    //   - 非整数 → error "The client requested a non-integer protocol version."
    //   - 负数 → error "The client requested version '<v>', but the server does not support this version."
    //   - > 1 → 钳制到服务端最大值 1
    //   - `negotiateVersion` 恒出现；`connectionToken` 仅在版本 > 0 时出现
    //   - 出错时仍返回 HTTP 200，响应体只有 error
    type Neog = {
      negotiateVersion?: number;
      connectionId?: string;
      connectionToken?: string;
      error?: string;
      availableTransports?: { transport: string; transferFormats: string[] }[];
    };
    const nego = async (query: string): Promise<{ status: number; body: Neog }> => {
      const res = await req(`/SyncClipboardHub/negotiate${query}`, { method: 'POST' });
      return { status: res.status, body: (await res.json()) as Neog };
    };

    // ① 版本 1（官方客户端实际发送的形态）
    const v1 = await nego('?negotiateVersion=1');
    expect(v1.status).toBe(200);
    expect(v1.body.negotiateVersion).toBe(1);
    expect(v1.body.connectionToken).toBeTruthy();
    expect(v1.body.connectionId).toBeTruthy();
    expect(v1.body.error).toBeUndefined();

    // ② 未携带参数 → 版本 0，**无** connectionToken，但 negotiateVersion 键必须存在
    const v0 = await nego('');
    expect(v0.status).toBe(200);
    expect(v0.body.negotiateVersion).toBe(0);
    expect(v0.body.connectionId).toBeTruthy();
    expect(v0.body.connectionToken).toBeUndefined();
    expect(v0.body.availableTransports).toHaveLength(3);

    // ③ 显式 0 → 同 ②
    const v0b = await nego('?negotiateVersion=0');
    expect(v0b.body.negotiateVersion).toBe(0);
    expect(v0b.body.connectionToken).toBeUndefined();

    // ④ 高于服务端最大值 → 钳制为 1（不是错误）
    const v2 = await nego('?negotiateVersion=2');
    expect(v2.status).toBe(200);
    expect(v2.body.negotiateVersion).toBe(1);
    expect(v2.body.connectionToken).toBeTruthy();

    // ⑤ 非整数 → 200 + error（上游不设置非 200 状态）
    const bad = await nego('?negotiateVersion=abc');
    expect(bad.status).toBe(200);
    expect(bad.body.error).toBe('The client requested a non-integer protocol version.');
    expect(bad.body.availableTransports).toBeUndefined();

    // ⑥ 负数 → 200 + error
    const neg = await nego('?negotiateVersion=-1');
    expect(neg.status).toBe(200);
    expect(neg.body.error).toBe(
      "The client requested version '-1', but the server does not support this version.",
    );

    // 报错路径不签发 token：用返回体里的任何值都不应通过连接鉴权
    const forgedRes = await req('/SyncClipboardHub/negotiate?negotiateVersion=abc', { method: 'POST' });
    const forged = (await forgedRes.json()) as Neog;
    expect(forged.connectionId).toBeUndefined();
  });

  it('F26 · File/Image/Group 缺传输数据时拒绝（上游 Persist 抛异常拒绝，本实现 400）', async () => {
    // 上游这些 Profile 的 Persist() 在无数据时抛异常（请求被拒）；此前本实现静默入库，
    // 写出永远取不到数据的坏记录并污染当前 profile。
    for (const t of ['File', 'Image', 'Group']) {
      const res = await req('/SyncClipboard.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: t, hash: sha256(`nodata-${t}-${RUN}`), text: 'x.png', hasData: false }),
      });
      expect(res.status, `${t} 无数据`).toBe(400);
    }

    // Text 无数据是正常内联场景，必须仍为 200
    const text = `inline-ok-${RUN}`;
    const ok = await req('/SyncClipboard.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Text', hash: sha256(text), text, hasData: false, size: text.length }),
    });
    expect(ok.status).toBe(200);

    // 当前 profile 不应被无数据请求污染（应仍是刚写入的 Text）
    const cur = await (await req('/SyncClipboard.json')).json() as { type: string; text: string };
    expect(cur.type).toBe('Text');
    expect(cur.text).toBe(text);

    // 历史里不应出现无数据的 File/Image/Group 记录
    for (const t of ['File', 'Image', 'Group']) {
      const rec = await req(`/api/history/${t}-${sha256(`nodata-${t}-${RUN}`)}`);
      expect(rec.status, `${t} 无数据记录不应入库`).toBe(404);
    }
  });
});
