// 会话 Cookie 的 Secure 属性：经隧道/反代时 Worker 看到的是回源的 http，但用户浏览器用的是 https，
// 要看 `X-Forwarded-Proto` / `CF-Visitor`。本地直连 http 时不能加 Secure（浏览器会直接丢弃 Cookie）。
import { describe, expect, it } from 'vitest';
import { assertWritableTarget } from './support/target-guard';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
assertWritableTarget(BASE);
const USER = process.env.SYNC_USER ?? 'admin';
const PASS = process.env.SYNC_PASS ?? 'admin';

async function login(headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${BASE}/ui/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

describe('UI 会话 Cookie 的 Secure 属性', () => {
  it('本地直连 http：不加 Secure（否则浏览器丢弃 Cookie）', async () => {
    expect(await login()).not.toMatch(/;\s*Secure/i);
  });
  it('X-Forwarded-Proto: https（经反代/隧道）→ 加 Secure', async () => {
    expect(await login({ 'X-Forwarded-Proto': 'https' })).toMatch(/;\s*Secure/i);
  });
  it('CF-Visitor: {"scheme":"https"} → 加 Secure', async () => {
    expect(await login({ 'CF-Visitor': '{"scheme":"https"}' })).toMatch(/;\s*Secure/i);
  });
  it('X-Forwarded-Proto: http → 不加', async () => {
    expect(await login({ 'X-Forwarded-Proto': 'http' })).not.toMatch(/;\s*Secure/i);
  });
  it('HttpOnly 与 SameSite=Strict 恒在', async () => {
    const cookie = await login({ 'X-Forwarded-Proto': 'https' });
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
});
