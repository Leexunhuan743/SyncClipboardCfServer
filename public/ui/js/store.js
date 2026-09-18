// 状态容器：一个可读可写对象，不掺 DOM、不掺网络。
//
// 只有 actions 改它，渲染由 main.js 在改动之后**显式**驱动（`render()` 或某个组件的
// `update()`）。这里刻意**不提供订阅**：曾经有过一个 `subscribe()`，而全仓无人订阅
// ——一个"看着像响应式、实际全靠手动调用"的接口只会误导下一个人（要么接上它、
// 要么别留着）。真的要改成订阅驱动，得连同组件的重建策略一起设计，不是加个回调的事。
export function createStore(initial) {
  let state = initial;

  return {
    get() {
      return state;
    },

    // patch 可以是对象或 (state) => patch
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
    },
  };
}
