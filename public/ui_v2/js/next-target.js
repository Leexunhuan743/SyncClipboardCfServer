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
  // 解析成功但指向本站**登录页自身**时也要回落：否则登录成功后会再次落到登录页（多一跳）。
  //
  // 判据比的是**平台的规范路径**，不是文件名。实测（wrangler dev，2026-09-19）：
  //   `/ui_v2/app/login.html` → 307 → `/ui_v2/app/login`（后者 200）
  //   `/ui_v2/app/login/`     → 307 → `/ui_v2/app/login`
  // 即浏览器地址栏里的登录页是**无扩展名**的那个；而 `redirectToLogin()`（`api.js`）写的又是
  // 带 `.html` 的形态（它先被 307、再落到规范形态）。⇒ 只认文件名会漏掉规范形态，
  // `?next=/ui_v2/app/login` 就被原样返回、登录后**多加载一次登录页**
  // （后果的判据：`test/manual/states.mjs` 的导航计数 + `test/next-target.test.ts` 的纯函数用例）。
  // 所以先「去扩展名 + 去尾斜杠」归一到规范形态，再与**唯一一个**字面量比较 ——
  // 带扩展名与尾斜杠两种写法都被覆盖，不必再列第二、第三个字面量。
  // （V1 的登录页是 `/ui_v1/login`，那是另一个应用、不归这条判定管。）
  const canonical = (pathname) => pathname.replace(/\.html$/, '').replace(/\/+$/, '');
  if (canonical(url.pathname) === '/ui_v2/app/login') return fallback;
  return path;
}
