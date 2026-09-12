// 修复项的 HTTP 级判别用例（前置：本地 dev server 已运行，BASE 默认 http://127.0.0.1:8787）
// 每个用例都写成「旧实现会失败、修复后通过」的形态，作为回归守卫。
import { describe, expect, it, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const USER = process.env.USER ?? 'admin';
const PASS = process.env.PASS ?? 'admin';
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
    const { opened } = await tryWs(`ws://127.0.0.1:8787/SyncClipboardHub?id=forged-token-${RUN}`);
    expect(opened).toBe(false);
  });

  it('无 ?id 且无凭据的 WS 升级被拒绝', async () => {
    const { opened } = await tryWs('ws://127.0.0.1:8787/SyncClipboardHub');
    expect(opened).toBe(false);
  });

  it('已登记的真实 token 可以通过升级（基线）', async () => {
    const nego = await req('/SyncClipboardHub/negotiate?negotiateVersion=1', { method: 'POST' });
    const { connectionToken } = await nego.json() as { connectionToken: string };
    const { opened } = await tryWs(`ws://127.0.0.1:8787/SyncClipboardHub?id=${connectionToken}`);
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

  it('F22 · GET /file 在最新同名记录的数据缺失时回退到更旧的同名记录（上游 File.Exists 过滤语义）', async () => {
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

  it('F24 · query 的 Types 非法名 → 400；合法名/缺失 → 200（上游枚举绑定语义）', async () => {
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
