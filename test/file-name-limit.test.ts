// 文件名进 R2 键的长度护栏：超长名字必须是 400，而不是 R2 抛错变成没有说明的 500。
//
// 背景：对协议接口做模糊测试时发现 `PUT /file/<3000 字符>`、`DELETE /file/<…>`、`PUT /SyncClipboard.json`
// （带很长的 dataName）都会 500 —— R2 的对象键上限是 1024 字节，名字拼进 `file/<名>` 后超限就直接抛错。
// 单元部分不依赖 dev server；黑盒部分需要本地 dev server（与其它黑盒套件同口径）。
import { describe, expect, it } from 'vitest';
import { MAX_FILE_NAME_BYTES, isFileNameTooLong } from '../src/storage';
import { sanitizeUploadName } from '../src/ui/routes/history-mutations';
import { assertWritableTarget } from './support/target-guard';

describe('isFileNameTooLong：按 UTF-8 字节判，不是按字符数', () => {
  it('边界：512 字节恰好可以，513 字节不行', () => {
    expect(isFileNameTooLong('a'.repeat(MAX_FILE_NAME_BYTES))).toBe(false);
    expect(isFileNameTooLong('a'.repeat(MAX_FILE_NAME_BYTES + 1))).toBe(true);
  });
  it('多字节字符：字符数不多但字节数超限的也要拦（汉字 3 字节、emoji 4 字节）', () => {
    expect(isFileNameTooLong('字'.repeat(170))).toBe(false); // 510 字节
    expect(isFileNameTooLong('字'.repeat(171))).toBe(true); // 513 字节
    expect(isFileNameTooLong('😀'.repeat(128))).toBe(false); // 512 字节
    expect(isFileNameTooLong('😀'.repeat(129))).toBe(true); // 516 字节
  });
  it('真实文件名（≤255）远低于上限', () => {
    expect(isFileNameTooLong('报告-2026-第三季度.pdf')).toBe(false);
    expect(isFileNameTooLong('a'.repeat(255))).toBe(false);
    expect(isFileNameTooLong('')).toBe(false);
  });
});

describe('界面上传的文件名', () => {
  it('255 个字符以内但字节数超限（emoji）也拒绝；正常名字不受影响', () => {
    expect(sanitizeUploadName('😀'.repeat(200) + '.png')).toBeNull(); // 204 字符、804 字节
    expect(sanitizeUploadName('字'.repeat(100) + '.txt')).not.toBeNull(); // 300 字节
    expect(sanitizeUploadName('截图 2026-11-02.png')).toBe('截图 2026-11-02.png');
  });
});

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
assertWritableTarget(BASE);
const AUTH = 'Basic ' + Buffer.from(`${process.env.SYNC_USER ?? 'admin'}:${process.env.SYNC_PASS ?? 'admin'}`).toString('base64');
const call = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { method, headers: { authorization: AUTH, ...headers }, body });

describe('协议接口：超长文件名是 400 而不是 500（黑盒）', () => {
  const long = encodeURIComponent('字'.repeat(400) + '.bin'); // 1200 字节
  it('PUT / DELETE / GET /file/<超长>', async () => {
    expect((await call('PUT', `/file/${long}`, 'abc')).status).toBe(400);
    expect((await call('DELETE', `/file/${long}`)).status).toBe(400);
    expect((await call('GET', `/file/${long}`)).status).toBe(400);
  });
  it('名字在上限内仍然能暂存、读取不到时 404、能删除', async () => {
    const ok = encodeURIComponent('名'.repeat(150) + '.bin'); // 450 字节
    expect((await call('PUT', `/file/${ok}`, 'abc')).status).toBe(200);
    expect((await call('DELETE', `/file/${ok}`)).status).toBe(200);
  });
  it('PUT /SyncClipboard.json 带超长 dataName → 400，不是 500', async () => {
    const name = '字'.repeat(400) + '.bin';
    const res = await call(
      'PUT',
      '/SyncClipboard.json',
      JSON.stringify({ type: 'File', hash: 'A'.repeat(64), text: name, hasData: true, dataName: name, size: 3 }),
      { 'content-type': 'application/json' },
    );
    expect(res.status).toBe(400);
  });
});

// 与文件名无关，但同属「畸形输入不该让接口 500」：合法 JSON 但不是对象的 SignalR 帧
import { parseClientMessage } from '../src/durable/signalr';
describe('parseClientMessage · 非对象 JSON', () => {
  it.each(['null', '123', '"x"', 'true', '[]'])('%s ⇒ unknown，不抛', (raw) => {
    expect(parseClientMessage(`${raw}\x1e`).kind).toBe('unknown');
  });
});

import { parseHistoryRecordUpdateDto } from '../src/serialization';
describe('parseHistoryRecordUpdateDto · 布尔字段', () => {
  it.each(['starred', 'pinned', 'isDelete'])('%s 不是布尔 ⇒ 抛错（路由回 400）', (field) => {
    for (const bad of ['"yes"', '1', '"true"', '[]']) {
      expect(() => parseHistoryRecordUpdateDto(`{"${field}":${bad}}`)).toThrow();
    }
  });
  it('null / 缺省 = 未提供；布尔正常通过', () => {
    expect(parseHistoryRecordUpdateDto('{"starred":null}')).toEqual({});
    expect(parseHistoryRecordUpdateDto('{"starred":true,"pinned":false}')).toEqual({ starred: true, pinned: false });
  });
});
