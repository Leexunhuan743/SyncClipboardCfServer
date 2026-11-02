// 提示条：瞬时反馈（成功/失败/需要补充说明的结果）。
// 宿主是 `popover="manual"` —— 进入浏览器**顶层**，于是模态框打开时它仍在最上面，不需要"框内假 toast"。
import { h, icon } from '../lib/dom';
import type { IconName } from '../lib/icons';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  action?: { label: string; run: () => void };
  /** 毫秒；0 = 不自动消失（错误默认停留更久） */
  duration?: number;
}

const ICONS: Record<ToastTone, IconName> = { info: 'info', success: 'check', warn: 'warning', error: 'warning' };

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host) return host;
  host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', popover: 'manual' });
  document.body.append(host);
  return host;
}

/** 把宿主（重新）放到顶层栈的最上面：后打开的模态框会盖住先打开的 popover。 */
function raise(el: HTMLElement): void {
  try {
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
  } catch {
    /* 不支持 popover 的浏览器：宿主是普通固定定位元素，仍然可见 */
  }
}

export function toast(message: string, options: ToastOptions = {}): () => void {
  const { tone = 'info', action, duration = tone === 'error' ? 7000 : 3600 } = options;
  const container = ensureHost();
  let timer = 0;
  const dismiss = (): void => {
    clearTimeout(timer);
    node.dataset.leaving = 'true';
    window.setTimeout(() => {
      node.remove();
      if (!container.children.length) {
        try {
          container.hidePopover();
        } catch {
          /* 同上 */
        }
      }
    }, 180);
  };
  const node = h(
    'div',
    { class: 'toast', dataset: { tone } },
    icon(ICONS[tone], { size: 18, className: 'toast__icon' }),
    h('span', { class: 'toast__text', text: message }),
    action &&
      h('button', {
        class: 'toast__action',
        type: 'button',
        text: action.label,
        onclick: () => {
          dismiss();
          action.run();
        },
      }),
    h('button', { class: 'toast__close', type: 'button', 'aria-label': '关闭提示', onclick: dismiss }, icon('close', { size: 16 })),
  );
  container.append(node);
  // 同时最多留 4 条：批量操作连发时不堆成一堵墙
  while (container.children.length > 4) container.firstElementChild?.remove();
  raise(container);
  if (duration > 0) timer = window.setTimeout(dismiss, duration);
  return dismiss;
}
