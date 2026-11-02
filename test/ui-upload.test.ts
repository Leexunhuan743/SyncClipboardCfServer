// `POST /ui/api/upload`：从浏览器上传文件/图片，存成一条记录。
//
// 判据：它走的是协议 `POST /api/history` 的同一套写路径，所以
//   · 记录的 hash 必须等于协议口径的 `fileProfileHash(name, bytes)`（官方客户端读到的就是普通记录）；
//   · 数据真的进了 R2（能原样取回）；
//   · 图片扩展名 ⇒ Image，其余 ⇒ File；
//   · 同名同内容重复上传不产生第二条记录；
//   · 非 octet-stream / 空文件 / 非法文件名都被拒（CSRF 纵深与输入校验）。
//
// 本套件会写目标库（默认只允许 localhost），收尾时软删再彻底删除自己创建的记录。
import { afterAll, describe, expect, it } from 'vitest';
import { assertWritableTarget } from './support/target-guard';
import { fileProfileHash } from '../src/hash';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
assertWritableTarget(BASE);
const AUTH = 'Basic ' + Buffer.from(`${process.env.SYNC_USER ?? 'admin'}:${process.env.SYNC_PASS ?? 'admin'}`).toString('base64');
const RUN = Date.now().toString(36);

const created: { type: string; hash: string }[] = [];

function upload(name: string | null, body: BodyInit | null, headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }) {
  const query = name === null ? '' : `?name=${encodeURIComponent(name)}`;
  return fetch(`${BASE}/ui/api/upload${query}`, { method: 'POST', headers: { Authorization: AUTH, ...headers }, body });
}

const TYPE = { Text: 0, File: 1, Image: 2, Group: 3 } as const;

// 1×1 透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

afterAll(async () => {
  const items = created.map(({ type, hash }) => ({ type, hash }));
  if (items.length === 0) return;
  const json = { Authorization: AUTH, 'Content-Type': 'application/json' };
  await fetch(`${BASE}/ui/api/history/batch-update`, { method: 'POST', headers: json, body: JSON.stringify({ items, update: { isDelete: true } }) });
  await fetch(`${BASE}/ui/api/history/batch-purge`, { method: 'POST', headers: json, body: JSON.stringify({ items }) });
});

describe('POST /ui/api/upload · 输入校验', () => {
  it('没有凭据 → 401', async () => {
    const res = await fetch(`${BASE}/ui/api/upload?name=a.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' });
    expect(res.status).toBe(401);
  });

  it('不是 application/octet-stream（跨站表单能发的"简单"类型）→ 415', async () => {
    for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', 'application/json']) {
      const res = await upload(`a-${RUN}.txt`, 'x', { 'Content-Type': type });
      expect(res.status, type).toBe(415);
    }
  });

  it('文件名缺失 / 为空 / 只有路径点 / 含控制字符 / 超长 → 400 invalid_name', async () => {
    for (const name of [null, '', '   ', '.', '..', 'a\u0000b.txt', 'x'.repeat(300)]) {
      const res = await upload(name, 'x');
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_name');
    }
  });

  it('空文件 → 400 empty_file', async () => {
    const res = await upload(`empty-${RUN}.txt`, new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('empty_file');
  });
});

describe('POST /ui/api/upload · 写入', () => {
  it('图片扩展名 ⇒ Image：hash 按协议口径、数据能原样取回', async () => {
    const name = `shot-${RUN}.png`;
    const res = await upload(name, PNG);
    expect(res.status).toBe(200);
    const item = (await res.json()) as { type: number; hash: string; text: string; dataName: string; size: number; hasData: boolean; isDeleted: boolean };
    created.push({ type: 'Image', hash: item.hash });
    expect(item).toMatchObject({ type: TYPE.Image, text: name, dataName: name, size: PNG.length, hasData: true, isDeleted: false });
    expect(item.hash).toBe(await fileProfileHash(name, new Uint8Array(PNG)));

    const data = await fetch(`${BASE}/ui/api/history/Image/${item.hash}/data`, { headers: { Authorization: AUTH } });
    expect(data.status).toBe(200);
    expect(Buffer.from(await data.arrayBuffer()).equals(PNG)).toBe(true);
    expect(data.headers.get('content-type')).toContain('image/png');
  });

  it('其它扩展名 ⇒ File；下载是附件，文件名不会被当成路径', async () => {
    const name = `../../notes-${RUN}.txt`; // 路径部分被丢弃
    const res = await upload(name, '你好，上传');
    expect(res.status).toBe(200);
    const item = (await res.json()) as { type: number; hash: string; text: string };
    created.push({ type: 'File', hash: item.hash });
    expect(item.type).toBe(TYPE.File);
    expect(item.text).toBe(`notes-${RUN}.txt`);
  });

  it('同名同内容重复上传不产生第二条记录', async () => {
    const name = `dup-${RUN}.bin`;
    const first = (await (await upload(name, 'same-bytes')).json()) as { hash: string };
    const second = (await (await upload(name, 'same-bytes')).json()) as { hash: string };
    created.push({ type: 'File', hash: first.hash });
    expect(second.hash).toBe(first.hash);
    const list = await fetch(`${BASE}/ui/api/history?search=${encodeURIComponent(name)}`, { headers: { Authorization: AUTH } });
    expect(((await list.json()) as { total: number }).total).toBe(1);
  });

  it('上传的记录在列表里可见、可被协议端点读到', async () => {
    const name = `visible-${RUN}.csv`;
    const item = (await (await upload(name, 'a,b\n1,2\n')).json()) as { hash: string };
    created.push({ type: 'File', hash: item.hash });
    const list = (await (await fetch(`${BASE}/ui/api/history?search=${encodeURIComponent(name)}`, { headers: { Authorization: AUTH } })).json()) as { items: { hash: string }[] };
    expect(list.items.map((i) => i.hash)).toContain(item.hash);
    const proto = await fetch(`${BASE}/api/history/File-${item.hash}`, { headers: { Authorization: AUTH } });
    expect(proto.status).toBe(200);
  });
});

describe('GET /ui/api/info · limits', () => {
  it('报告界面上传的单文件上限（= 请求体上限），前端据此在选文件时拦截', async () => {
    const info = (await (await fetch(`${BASE}/ui/api/info`, { headers: { Authorization: AUTH } })).json()) as { limits: { maxUploadBytes: number } };
    expect(Number.isInteger(info.limits.maxUploadBytes)).toBe(true);
    expect(info.limits.maxUploadBytes).toBeGreaterThanOrEqual(256 * 1024);
    expect(info.limits.maxUploadBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
