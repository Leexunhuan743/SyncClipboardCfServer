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
//
// 尺寸规则（2026-09-18 收敛）：行内/控件内用 **12 / 14 / 16**，空状态与对话框插图用 **32**，
// 品牌标识 26 是唯一的例外（它是 logo，不是图标）。此前实际用到 11–34 共十一档，
// 多出来的那些（11/13/15/34）视觉上分不出来，只是让"这个图标该多大"每次都要重新决定。
export function svg(pathData, { size = 16, class: classNames = '' } = {}) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  if (classNames) node.setAttribute('class', classNames);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  node.setAttribute('fill', 'none');
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

export function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

