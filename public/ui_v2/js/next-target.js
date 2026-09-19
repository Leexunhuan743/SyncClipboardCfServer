// 登录后「下一跳」的判定（纯函数，无 DOM、无网络 —— 因此可以被测试直接覆盖）。
//
// 从 V1 原样保留：这是**安全边界**，不是显示逻辑，重写没有收益只有风险。
// V1 的教训写在 docs/ui.md §7：`?next=` 只接受**同源**目标，前缀比较不够 ——
// 浏览器的 WHATWG URL 对 http/https 这类 special scheme 把 `\` 视同 `/`，
// 于是 `?next=/\evil.example` 与 `//evil.example` 一样是协议相对 URL 而跳到站外。
//
// 判据：用 `new URL(raw, origin)` 解析后的 `origin` 必须与当前页相等，
// 且只返回 `pathname + search + hash`（不带 origin，跨源字符串没有漏出的路径）。
// 回归用例见 test/next-target.test.ts。
export function resolveNext(raw, origin, fallback = '/ui_v2/app/') {
  if (typeof raw !== 'string' || raw === '') return fallback;
  let url;
  try {
    url = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // 解析成功但指向本站**登录页自身**时也要回落：否则登录成功后会再次落到登录页（死循环）。
  // 判据只列**这一版真实存在**的登录页：`/ui_v2/app/login.html`。
  // （V1 的登录页在 `/ui_v1/login.html`，那是另一个应用、不归这条判定管。）
  if (url.pathname === '/ui_v2/app/login.html') return fallback;
  return path;
}
