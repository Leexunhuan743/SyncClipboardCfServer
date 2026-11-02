// `GET /ui/api/overview?storage=0`：轻量概览不列举 R2（那是收费的 Class A 操作），
// 存储体积为 null，由调用方沿用上一次的值；计数、变更标记、服务端时间照常。默认（不带参数）行为不变。
import { describe, expect, it } from 'vitest';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const AUTH = 'Basic ' + Buffer.from(`${process.env.SYNC_USER ?? 'admin'}:${process.env.SYNC_PASS ?? 'admin'}`).toString('base64');

interface Overview {
  stats: { totalCount: number; activeCount: number; totalFileSizeMB: number | null };
  byType: Record<string, number>;
  marker: { lastModified: number };
  info: { storage: { totalBytes: number | null; totalFileSizeMB: number | null }; counts: { active: number } };
  serverTime: string;
}

const get = async (query = ''): Promise<Overview> => {
  const res = await fetch(`${BASE}/ui/api/overview${query}`, { headers: { Authorization: AUTH } });
  expect(res.status).toBe(200);
  return (await res.json()) as Overview;
};

describe('GET /ui/api/overview 的轻量模式', () => {
  it('默认：带存储体积（数字）', async () => {
    const full = await get();
    expect(typeof full.info.storage.totalBytes).toBe('number');
    expect(typeof full.stats.totalFileSizeMB).toBe('number');
  });

  it('?storage=0：体积为 null，计数与标记照常', async () => {
    const [light, full] = await Promise.all([get('?storage=0'), get()]);
    expect(light.info.storage.totalBytes).toBeNull();
    expect(light.info.storage.totalFileSizeMB).toBeNull();
    expect(light.stats.totalFileSizeMB).toBeNull();
    expect(light.stats.activeCount).toBe(full.stats.activeCount);
    expect(light.info.counts.active).toBe(full.info.counts.active);
    expect(light.marker.lastModified).toBe(full.marker.lastModified);
    expect(Number.isNaN(Date.parse(light.serverTime))).toBe(false);
  });

  it('可与 deleted 视图组合', async () => {
    const light = await get('?storage=0&deleted=true');
    expect(light.info.storage.totalBytes).toBeNull();
  });
});
