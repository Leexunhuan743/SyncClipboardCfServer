// 状态容器：一个可订阅的对象，不掺 DOM、不掺网络。
// 组件订阅它；只有 actions 改它；渲染是订阅回调的事。

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get() {
      return state;
    },

    // patch 可以是对象或 (state) => patch
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
