// `/ui/` 那个跳转页的 fragment 中继（**经典脚本**，不是模块 —— 它必须在解析期尽快跑完）。
//
// 为什么需要它：`/ui/` 的唯一职责是把人送到默认界面 `/ui_v1/`。那一页的 `<noscript>` 里有一条
// meta refresh 兜底（无脚本时用），而声明式 refresh **不会继承**原 URL 的 fragment ——
// `/ui/#Text-<hash>` 这类**记录级深链接**会静默退化成默认列表页。有脚本时由这里负责：
// 把 hash 接在目标地址后面；没有 hash 就照样跳（不带参数）。
//
// 两处目标必须一致（`/ui_v1/`），守卫见
// `test/ui-guard.test.ts` 的「默认界面的入口链一致」。
(function () {
  window.location.replace('/ui_v1/' + window.location.hash);
})();
