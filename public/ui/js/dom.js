// 极简 DOM 工具。
//
// 硬约束：**本模块不提供任何插入 HTML 的途径**。
// 剪贴板里的内容完全不可信（用户复制的可能就是一段 HTML 源码），而本页与数据端点同源、
// 且持有会话 Cookie——一处 innerHTML 就是一条读取全部历史的 XSS 路径。
// 因此文本只能经 `text` 选项（内部走 textContent），图标只能经 svg() 用常量路径构造。

const SVG_NS = 'http://www.w3.org/2000/svg';

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

// 用常量路径数据构造 SVG（路径来自 icons.js 的静态表，不含用户输入）
export function svg(pathData, { size = 16, filled = false, class: classNames = '' } = {}) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  if (classNames) node.setAttribute('class', classNames);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  node.setAttribute('fill', filled ? 'currentColor' : 'none');
  node.setAttribute('stroke', filled ? 'none' : 'currentColor');
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

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node, children) {
  clear(node);
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) node.append(child);
  }
}

export function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// 视图过渡包装：浏览器不支持或用户要求减少动效时，直接执行。
// 返回是否真的走了过渡（当前无需使用，保留以便将来观测）。
export function withViewTransition(mutate) {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || typeof document.startViewTransition !== 'function') {
    mutate();
    return false;
  }
  const transition = document.startViewTransition(mutate);
  // 过渡被**中止**是正常路径，不是错误：文档不可见（后台标签页）或下一次过渡抢在前面时，
  // 浏览器会 reject `ready` / `finished`。不接住它就是一个 unhandled rejection
  // （实测：文档隐藏时每次过渡必现 InvalidStateError）。中止只影响过渡动画本身——
  // DOM 已由 `mutate` 更新完毕，数据与交互不受影响。
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
  return true;
}
