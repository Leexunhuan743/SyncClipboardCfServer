// 弹出菜单：`popover="auto"` 提供顶层、点外面关闭与 Esc；这里补上定位与方向键导航。
import { h, icon } from '../lib/dom';
import type { IconName } from '../lib/icons';

export interface MenuItem {
  label: string;
  icon?: IconName;
  run?: () => void;
  /** 单选/多选菜单：当前项带勾 */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  /** 在该项**之前**画一条分隔线 */
  separatorBefore?: boolean;
}

export interface MenuOptions {
  align?: 'start' | 'end';
  /** 菜单宽度下限（px） */
  minWidth?: number;
}

let current: HTMLElement | null = null;

export function closeMenu(): void {
  if (!current) return;
  const menu = current;
  current = null;
  try {
    menu.hidePopover();
  } catch {
    /* 已关闭 */
  }
  menu.remove();
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], { align = 'start', minWidth = 200 }: MenuOptions = {}): void {
  closeMenu();
  const buttons: HTMLButtonElement[] = [];
  const menu = h('div', { class: 'menu', role: 'menu', popover: 'auto' });
  for (const item of items) {
    if (item.separatorBefore) menu.append(h('div', { class: 'menu__sep', role: 'separator' }));
    const button = h(
      'button',
      {
        class: `menu__item${item.danger ? ' menu__item--danger' : ''}`,
        type: 'button',
        role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
        'aria-checked': item.checked === undefined ? undefined : String(item.checked),
        disabled: item.disabled === true,
        onclick: () => {
          closeMenu();
          anchor.focus({ preventScroll: true });
          item.run?.();
        },
      },
      item.icon ? icon(item.icon, { size: 16 }) : h('span', { class: 'menu__icon-gap' }),
      h('span', { class: 'menu__label', text: item.label }),
      item.hint && h('span', { class: 'menu__hint', text: item.hint }),
      item.checked === true && icon('check', { size: 16, className: 'menu__check' }),
    );
    buttons.push(button);
    menu.append(button);
  }
  menu.addEventListener('keydown', (event) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length];
    else if (event.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled[enabled.length - 1];
    else return;
    event.preventDefault();
    next?.focus();
  });
  menu.addEventListener('toggle', (event) => {
    if ((event as ToggleEvent).newState === 'closed') {
      if (current === menu) current = null;
      menu.remove();
    }
  });
  menu.style.minWidth = `${minWidth}px`;
  document.body.append(menu);
  current = menu;
  try {
    menu.showPopover();
  } catch {
    menu.dataset.fallback = 'true';
  }
  // 定位：贴在锚点下方；放不下（右/下）就翻转，保证整块在视口内
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const margin = 8;
  let left = align === 'end' ? a.right - m.width : a.left;
  left = Math.min(Math.max(margin, left), window.innerWidth - m.width - margin);
  let top = a.bottom + 6;
  if (top + m.height > window.innerHeight - margin) top = Math.max(margin, a.top - m.height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  (buttons.find((b) => b.getAttribute('aria-checked') === 'true' && !b.disabled) ?? buttons.find((b) => !b.disabled))?.focus();
}
