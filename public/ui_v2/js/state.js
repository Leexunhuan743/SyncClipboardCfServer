// 状态容器：一个可读可写对象，不掺 DOM、不掺网络。
//
// 与 V1 的 `store.js` 只多一样东西：`patch()` —— 顶层浅合并（V1 的 `set` 就是这个语义，
// 改名以免与"整体替换"混淆）。
//
// 刻意**不提供订阅**（V1 的教训，原样保留）：曾经有过一个 `subscribe()`，而全仓无人订阅
// —— 一个"看着像响应式、实际全靠手动调用"的接口只会误导下一个人。渲染由 `boot.js` 在改动之后
// **显式**驱动。真要改成订阅驱动，得连同组件的重建策略一起设计，不是加个回调的事。
//
// 同样刻意**不提供** `update(key, fn)` 这类"读改写单个键"的方法：曾经有过一个，
// 注释为 `filters` 这种"只改一个字段"的高频路径辩护，而全仓**零调用**（`patch` 有 21 处）。
// 未被调用的 API 不会报错，只会让人以为存在一条高频路径。
export function createStore(initial) {
  let state = initial;

  return {
    get() {
      return state;
    },

    /** 顶层浅合并。`patch` 可以是对象或 `(state) => patch`。 */
    patch(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      return state;
    },
  };
}
