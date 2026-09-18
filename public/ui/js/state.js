// 状态容器：一个可读可写对象，不掺 DOM、不掺网络。
//
// 与 V1 的 `store.js` 只多两样东西，都是为了移动端：
//   · `patch()` —— 顶层浅合并（V1 的 `set` 就是这个语义，改名以免与"整体替换"混淆）
//   · `update(key, fn)` —— 单个键的读改写，用于 `filters` 这类"只改一个字段"的高频路径
//
// 刻意**不提供订阅**（V1 的教训，原样保留）：曾经有过一个 `subscribe()`，而全仓无人订阅
// —— 一个"看着像响应式、实际全靠手动调用"的接口只会误导下一个人。渲染由 `boot.js` 在改动之后
// **显式**驱动。真要改成订阅驱动，得连同组件的重建策略一起设计，不是加个回调的事。
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

    /** 读改写单个键。`fn` 收旧值、返回新值。 */
    update(key, fn) {
      return this.patch({ [key]: fn(state[key]) });
    },
  };
}
