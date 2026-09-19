// 焦点保持：DOM 就地重建时把用户的键盘位置搬回来。
//
// 为什么需要它（2026-09-16 实测抓到）：列表每 10 秒轮询一次、每次推送广播也刷一次，
// 而 `board.js` 落地时是「清空 `tbody` → 整体重新 append」。行节点本身是**被复用的**
// （按 key 对账，注释里也写着"保住缩略图、焦点"），但复用之后这次 detach/attach
// 仍然会让浏览器把焦点扔给 `<body>` —— 实测：焦点在行的复制按钮上，按一次 `r` 刷新后
// `document.activeElement` 变成 `BODY`，而行的 DOM 节点身份没变。
//
// 对键盘与读屏用户，这意味着**每一步操作都可能被后台刷新打断**：Tab 到第三个按钮，
// 10 秒后焦点回到页面开头，要从 `<body>` 重新 Tab 一遍。V1 的注释里把"丢掉焦点"
// 列为整表重建的三大害处之一，而这里发生的是同一件事 —— 只是方式更隐蔽。
//
// 两个层次，缺一不可：
//   1. **能复用节点就不动它**（调用方的责任：顺序没变时跳过 DOM 交换）—— 这是治本；
//   2. **真要动就搬回来**（本模块）—— 因为"别的设备改了一条记录"时顺序确实会变。
//
// 判据用「元素本身 + 行 key + 控件选择器」三段：
//   · 元素还在文档里 → 直接还给它（最常见：整段 append 回去，节点没换）；
//   · 元素已被就地替换（`fillRow` 重建了操作列）→ 按行 key 找到那一行，
//     再用同一个选择器找同类控件（收藏按钮换成新的收藏按钮，仍把焦点还给它）。

/**
 * 一个元素在**重建前后都可复现**的描述。
 *
 * 只认三类：`[data-icon]`（行内图标按钮，行内唯一）、`.check`（选择框，行内唯一）、
 * `#id`（全局唯一）。认不出来就返回 `null` —— 宁可不搬，也不要把焦点搬到错误的控件上
 * （把焦点搬到另一个按钮上比丢焦点更糟：用户会按下去）。
 */
export function describeFocusable(node) {
  if (!node || node === document.body || node === document.documentElement) return null;
  if (typeof node.focus !== 'function') return null;

  let selector = null;
  if (node.dataset?.icon) selector = `[data-icon="${node.dataset.icon}"]`;
  else if (node.dataset?.action === 'preview') selector = '[data-action="preview"]';
  else if (node.classList?.contains('check')) selector = '.check';
  else if (node.id) selector = `#${node.id}`;
  if (!selector) return null;

  // 行 key：行是列表里可复现的最小单位（`row.js` 给每行写了 `data-key`）
  const row = node.closest?.('[data-key]');
  return { node, key: row?.dataset.key ?? null, selector };
}

/**
 * 现在该把焦点搬到哪儿 —— 返回一个不透明的快照，交给 `restoreFocus` 用。
 * 焦点不在 `scope` 里（或认不出控件）时返回 `null`。
 */
export function captureFocus(scope) {
  if (!scope) return null;
  const active = document.activeElement;
  if (!active || !scope.contains(active)) return null;
  return describeFocusable(active);
}

/**
 * 把焦点还回去。
 *
 * @param {ParentNode} scope 搜索范围（通常是列表容器或那一行）
 * @returns {boolean} 是否真的还回去了（没还回去时调用方不必做任何补救 —— 丢焦点是旧行为）
 */
export function restoreFocus(scope, snapshot) {
  if (!snapshot || !scope) return false;

  // ① 原节点还在文档里：最理想，直接还给它（用户的位置与滚动都不变）
  if (snapshot.node?.isConnected) {
    snapshot.node.focus({ preventScroll: true });
    return true;
  }

  // ② 节点被就地替换了：按行 key + 控件选择器找回同类控件
  const host = snapshot.key ? scope.querySelector(`[data-key="${cssEscape(snapshot.key)}"]`) : scope;
  const next = host?.querySelector?.(snapshot.selector);
  if (next) {
    next.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/**
 * `CSS.escape` 的本地实现：零构建环境里不引入 polyfill，而这里只需要处理
 * 属性选择器里的引号与反斜杠（行 key 是 `类型-哈希`，只含 `[A-Za-z0-9-]`，理论上无需转义；
 * 但"理论上"是这类代码出事的常见原因，转义只有两行）。
 */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
