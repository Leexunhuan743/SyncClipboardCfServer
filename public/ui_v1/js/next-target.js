// 登录后「下一跳」的解析：把 `?next=` 的值判成**同源**站内路径，否则回落。
//
// 为什么不靠前缀比较：浏览器（WHATWG URL）对 http/https 这类 special scheme 把 `\` 视同 `/`，
// 于是 `/\evil.example` 与 `//evil.example` 一样是协议相对 URL。只挡 `//` 会漏掉前者，
// 登录后的 location.replace() 就成了开放重定向。故按 **origin 相等**判定；
// 返回值只含 pathname + search + hash（不带 origin），跨源字符串没有任何漏出的路径。
//
// 抽成独立模块的理由：这条判定是纯函数，且是登录页唯一的跳转来源（两处 location.replace），
// 判错一次即安全缺陷——独立成文件才能被测试直接覆盖，而不是只能靠浏览器端到端。
export function resolveNext(raw, origin) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  // 解析成功但指向**登录页自身**时同样回落：否则登录成功后会再落到登录页（多一跳）。
  //
  // 比的是**平台的规范路径**，不是文件名（实测 wrangler dev，2026-09-19）：
  //   `/ui_v1/login.html` → 307 → `/ui_v1/login`（后者 200）；`/ui_v1/login/` 同样 307 归一。
  // ⇒ 先「去扩展名 + 去尾斜杠」归一到规范形态，再与**唯一一个**字面量比较，
  //   带扩展名与尾斜杠两种写法都被覆盖，不必列第二个、第三个。
  // 这个字面量在本模块里不可避免（文件头说明了它刻意不 import `api.js` 的 `PAGE_BASE`
  // —— 保持"纯函数、可被测试直接覆盖"），守卫只要求它出现一次。
  const canonical = (pathname) => pathname.replace(/\.html$/, '').replace(/\/+$/, '');
  if (canonical(u.pathname) === '/ui_v1/login') return null;
  return u.pathname + u.search + u.hash;
}
