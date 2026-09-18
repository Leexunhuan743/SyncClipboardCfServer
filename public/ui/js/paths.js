// 记录数据文件的**路径构造**（纯函数：不碰 DOM、不碰网络、不碰状态）。
//
// 为什么单独一个模块（审计 `docs/AUDIT-redundancies.md` §7 的 O-08k）：
// 这条路径此前有**两个生产者** —— `api.js` 的 `dataUrl()`（给 `<a href>`、`api.fetchData()`
// 与 data 端点用）和 `ui/row.js` 里手写的一份模板串。两处各自拼串，正是"改了接口前缀或路径形状、
// 漏掉其中一处"的经典形态：症状是缩略图整片 404 而其它请求全好（V1 的 `preview.js` 为同一件事
// 写过注释——"组件里再抄一遍，就是又一处改接口前缀、漏了这个文件的机会"）。
//
// 为什么不直接让 `ui/row.js` 去 import `api.js`：分层纪律（`boot.js` 是唯一碰网络的地方，
// `ui/*` 只做呈现）是这一版刻意立的。而这里需要的只是一个**字符串**，不需要请求能力 ——
// 故抽成纯函数让两边共用，谁也不越界。`test/ui-contract.test.ts` 的「modulepreload == import 闭包」
// 会替我们盯着：新增/删除这个模块必须在两张页面的预载清单里跟着改。

/**
 * 一条记录的数据文件地址。
 *
 * 逐段 `encodeURIComponent` 而不是拼原始串：协议只禁止 hash 里出现路径分隔符，
 * `#` / `?` / `%` 都是合法字符，裸拼会把查询串或片段从那里截断
 * （`test/ui-guard.test.ts` 的「URL 构造」用例钉的就是这一条）。
 *
 * @param {{ type: string, hash: string }} item
 * @param {{ download?: boolean }} [options]
 *   `download: true` 让服务端回附件（`Content-Disposition: attachment`）。
 *   目前只有 V1 的下载路径用它；V2 的 `<img src>` / `<a href>` 走默认值。
 *   保留同一个开关而不是各写一套，是为了不出现"第二个下载语义"。
 * @returns {string}
 */
export function dataPath(item, { download = false } = {}) {
  const base = `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}/data`;
  return download ? `${base}?download=1` : base;
}
