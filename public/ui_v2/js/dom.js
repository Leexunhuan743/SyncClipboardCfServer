// 极简 DOM 工具。从 V1 保留，契约不变。
//
// 硬约束：**本模块不提供任何插入 HTML 的途径**。
// 剪贴板里的内容完全不可信（用户复制的可能就是一段 HTML 源码），而本页与数据端点同源、
// 且持有会话 Cookie —— 一处 `innerHTML` 就是一条读取全部历史的 XSS 路径。
// 因此文本只能经 `text` 选项（内部走 textContent），图标只能经 `svg()` 用常量路径构造。
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 建元素。
 * @param {string} tag
 * @param {Record<string, unknown>} props
 *   `class` / `text` / `dataset` / `style` 有特殊含义；
 *   `on*` 且值为函数 → addEventListener；其余走 setAttribute（值为 `true` 时写成空属性）。
 * @param {Array<Node|string|null|false|undefined>|Node|string} children
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * 用常量路径数据构造 SVG（路径来自 icons.js 的静态表，不含任何用户输入）。
 * `filled` 用于星标/置顶的"已选中"态：填充与描边是**两个通道**的信息，
 * 色觉障碍下"填充 vs 描边"仍可区分（见 icons.js 的 FILLED 说明）。
 */
export function svg(pathData, { size = 16, class: classNames = '', filled = false } = {}) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  if (classNames) node.setAttribute('class', classNames);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  node.setAttribute('fill', filled ? 'currentColor' : 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.7');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');

  for (const d of Array.isArray(pathData) ? pathData : [pathData]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    node.append(path);
  }
  return node;
}

/** 尾沿去抖。用于把一串广播（批量操作是逐条广播的）收敛成一次刷新。 */
export function debounce(fn, wait) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/**
 * 重放一次 CSS 动画：先删属性、强制回流，再加回去。
 * 同一个属性值不会重启动画 —— 星标连点两次时第二次必须还有反馈。
 */
export function replayAnimation(node, attr, value) {
  node.removeAttribute(attr);
  void node.offsetWidth; // 强制回流：让浏览器忘记上一轮动画已经播过
  node.setAttribute(attr, value);
}

/** 清空一个节点（不用 innerHTML = ''，那会触发 HTML 解析器）。 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * 焦点在一个"正在输入"的控件里吗？
 *
 * 三条快捷键（`/`、`Ctrl/Cmd+K`、`r`）要靠它让路 —— 否则用户打字打到一半，
 * 一个 `r` 就把列表刷走了、`/` 还会把斜杠吞掉。
 *
 * ⚠️ **它把复选框也算作"输入控件"**，这对上面三条键是对的，但 **Esc 不能用它**：
 * 用键盘选中一行时焦点就在复选框上，用这个判据会让 Esc 失效（实测踩过，见 `keys.js`）。
 * 那个场景要用 `isTextInput`。
 */
export function isTypingTarget(node) {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement ||
    node?.isContentEditable === true
  );
}

/**
 * 焦点在一个**真的在输入文字**的控件里吗（复选框、单选框、按钮型 input 不算）。
 * Esc 这类"取消"动作应该用这个判据。
 */
export function isTextInput(node) {
  if (node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLSelectElement) return true;
  if (node instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      node.type,
    );
  }
  return node?.isContentEditable === true;
}
