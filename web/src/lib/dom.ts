// DOM 小工具：`h()` 建节点、`icon()` 画图标、`debounce()`。
// 刻意不做虚拟 DOM —— 视图自己决定何时重建、何时就地更新（列表按 key 对账，见 views/feed.ts）。
// 不用 innerHTML：用户内容（剪贴板正文、文件名）只经过 textContent，XSS 面为零。
import { FILLED, ICONS, type IconName } from './icons';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null | undefined;

/**
 * 建一个元素。
 *   h('button', { class: 'btn', onclick: fn, 'aria-label': '复制', dataset: { a: '1' } }, child, [child, …])
 * `text` 直接写文本；`on*` 绑事件；布尔/DOM 属性走属性赋值；其余走 setAttribute。
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value as Record<string, string>);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value as EventListener);
      } else if (key === 'value') {
        (node as unknown as Record<string, unknown>)[key] = value;
      } else if (typeof value === 'boolean') {
        // 布尔属性：DOM 里有同名属性就赋值（hidden/disabled/checked…），没有就写成空属性（readonly/novalidate…）
        if (key in node) (node as unknown as Record<string, unknown>)[key] = value;
        else node.setAttribute(key, '');
      } else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export interface IconOptions {
  size?: number;
  filled?: boolean;
  className?: string;
}

/** 图标：24×24 描边 SVG。星标/置顶在 `filled` 时填充（形状与颜色双通道表意）。 */
export function icon(name: IconName, { size = 18, filled = false, className = '' }: IconOptions = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', filled && FILLED.has(name) ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon${className ? ` ${className}` : ''}`);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** 就地换掉按钮里的图标（状态切换用）。 */
export function setIcon(host: Element, name: IconName, options?: IconOptions): void {
  const old = host.querySelector(':scope > svg.icon');
  const next = icon(name, options);
  if (old) old.replaceWith(next);
  else host.prepend(next);
}

export function clear<T extends Node>(node: T): T {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer = 0;
  const wrapped = ((...args: A) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as Debounced<A>;
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** `querySelector` 的必选版：找不到就抛（视图自己建的节点找不到是 bug，不是运行时条件）。 */
export function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`找不到节点：${selector}`);
  return found;
}
