// D1 免费额度用完时的行为：不再是一个没有任何说明的 500，而是带原因与恢复时间的 503。
// （线上真发生过：错误是 `Your account has exceeded D1's free tier daily row read limit …`。）
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { handleAppError, isD1QuotaError, secondsUntilUtcMidnight } from '../src/errors';

const REAL = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

describe('isD1QuotaError', () => {
  it('认平台的真实报错，也认包了一层 cause 的', () => {
    expect(isD1QuotaError(new Error(REAL))).toBe(true);
    expect(isD1QuotaError(new Error('outer', { cause: new Error(REAL) }))).toBe(true);
    expect(isD1QuotaError(new Error("Your account has exceeded D1's free tier daily row written limit"))).toBe(true);
  });
  it('其它错误不算（包括普通的 D1 / SQL 错误），避免把真故障误报成"额度用完"', () => {
    for (const msg of ['D1_ERROR: no such table: HistoryRecords', 'UNIQUE constraint failed', 'Network connection lost', 'boom']) {
      expect(isD1QuotaError(new Error(msg)), msg).toBe(false);
    }
    expect(isD1QuotaError(null)).toBe(false);
    expect(isD1QuotaError('exceeded')).toBe(false);
  });
});

describe('secondsUntilUtcMidnight', () => {
  it('到下一个 UTC 0 点的秒数', () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 2, 15, 0, 0))).toBe(9 * 3600);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 2, 23, 59, 59))).toBe(1);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 2, 0, 0, 0))).toBe(24 * 3600);
  });
});

describe('经 Hono onError', () => {
  const app = new Hono();
  app.onError((err, c) => handleAppError(err, c));
  app.get('/quota', () => {
    throw new Error(REAL);
  });
  app.get('/other', () => {
    throw new Error('boom');
  });

  it('额度错误 → 503 + Retry-After + 可读的 JSON，且不缓存', async () => {
    const res = await app.request('/quota');
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(24 * 3600);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('d1_quota_exceeded');
    expect(body.detail).toContain('UTC 0 点');
  });
  it('其它错误保持 500 纯文本，不泄露内部信息', async () => {
    const res = await app.request('/other');
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
  });
});

describe('入口接上了它', () => {
  it('src/index.ts 注册了 onError(handleAppError)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/app\.onError\(\(err, c\) => handleAppError\(err, c\)\)/);
  });
});
