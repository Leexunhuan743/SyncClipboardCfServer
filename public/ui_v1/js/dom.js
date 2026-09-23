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

/**
 * 焦点在一个**真的能输入文字**的控件里吗（复选框 / 单选框 / 按钮型 `input` / `select` 之外的都算）。
 *
 * 为什么需要它、以及它和"输入处"的区别（2026-09-23 实测补）：
 * 列表级的快捷键（`/ ? r t n p Esc`）此前一律按 `tagName` 让路（`INPUT`/`TEXTAREA`/`SELECT`），
 * 而**复选框也是 `INPUT`** —— 而"用键盘选中一行"必然把焦点留在复选框上（方向键导航也落在它上面）
 * ⇒ 那一刻 `t`/`?`/`n`/`p`/`r` **全部静默失效**（实测：焦点在行内复选框时按 `t` 主题不变、
 * 按 `n` 不翻页；换到行内按钮上同一按键立刻生效）。复选框接收不了文字，没有"抢键"这回事。
 * V2 的 `keys.js` 早就把这条判据分成了两份（`isTypingTarget` / `isTextInput`，见其文件头第 2 条），
 * 本函数是 V1 这一份 —— 两版实现有意不同，语义一致。
 */
export function isTextEntry(node) {
  if (node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLSelectElement) return true;
  if (node instanceof HTMLInputElement) {
    // `select` 的字母键是**选项跳转**，属于控件自己的行为 ⇒ 让路；复选框/单选框/按钮型不是。
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(node.type);
  }
  return node?.isContentEditable === true;
}

/**
 * 尾沿去抖。返回的函数上带 `cancel()`：**调用方在"立刻结算"的那条路径上必须用它**，
 * 否则已经排期的那一次还会在窗口末尾再跑一遍。
 *
 * 为什么必须有（2026-09-18 补）：搜索框的 Esc / 清空按钮 / 原生 `search` 事件都会直接调
 * `onSearch('')`，而输入事件排期的那次去抖调用无法取消 ⇒ 260ms 后它读一次已经清空的输入框、
 * **又发一次同样的列表请求**。V2 的 `debounce` 一直带 `cancel`，且五处调用都用上了
 * （`ui/omnibox.js`）；见 `docs/archive/AUDIT-v1-v2-divergence.md` §3.3。
 */
export function debounce(fn, wait) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

