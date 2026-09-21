// 按钮：`.btn` 家族的两个构造器，全站共用。
//
// 为什么抽出来（2026-09-16 审计）：`iconButton` 原本只定义在 `rowops.js` 里、也只在那一处被用，
// 而另外 **9 处**图标按钮是各写一遍 `el('button', { class: 'icon-btn', … })`。
// 手写的那 9 处彼此并不一致 —— 有的同时给 `aria-label` 与 `title`、有的只给其一，
// 尺寸在 16 / 17 之间飘，`aria-pressed` 的表达方式也不统一。这些都是"看得见但没人报"
// 的可访问性瑕疵：读屏用户遇到没有 `aria-label` 的图标按钮时，听到的只是"按钮"。
//
// 这里收的不只是行数，而是**判据**：图标按钮必须有一个给人读的名字，
// 带态的要写出态（`aria-pressed`），禁用的要说明原因（`title`）。
import { el, svg } from '../dom.js';
import { iconPaths, iconSupportsFill } from '../../../ui_shared/js/icons.js';

/**
 * 图标按钮（`.icon-btn`）。
 *
 * @param {{ icon: string, label: string, pressed?: boolean, disabled?: boolean,
 *           menu?: boolean, title?: string, size?: number,
 *           onClick?: (button: HTMLElement) => unknown }} spec
 *   `label` 是**必填**：它是 `aria-label`，也是默认的 `title`。
 *   `menu: true` 表示它开一个菜单（补 `aria-haspopup` 与 `aria-expanded`，
 *   后者由 `menu.js` 在开关时同步）。
 */
export function iconButton({ icon, label, pressed, disabled, menu, title, size = 16, onClick }) {
  const filled = pressed === true && iconSupportsFill(icon);
  const button = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': label,
      title: title ?? label,
      dataset: { icon },
      disabled: disabled === true,
      ...(menu ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}),
      onclick: (event) => {
        // 行内按钮的点击不该触发行选中（行首的复选框才是选择入口）
        event.stopPropagation();
        onClick?.(button);
      },
    },
    [svg(iconPaths(icon), { size, filled })],
  );

  if (pressed !== undefined) button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  return button;
}

/**
 * 图标 + 文字的按钮（`.btn` 家族的一员）。
 *
 * 变体（`btn--sm` / `btn--ghost` / `btn--primary`）由调用方通过 `className` 决定 ——
 * 那是各页面自己的取舍；本函数只统一**结构**：图标与文字的类名、以及顺序。
 *
 * @param {{ label?: string, icon?: string|null, iconSide?: 'start'|'end', iconSize?: number,
 *           className?: string, dataset?: Record<string, string>, attrs?: Record<string, unknown>,
 *           onClick?: (button: HTMLElement) => unknown }} spec
 */
export function labelButton({
  label = '',
  icon = null,
  iconSide = 'start',
  iconSize = 14,
  className = 'btn',
  dataset = undefined,
  attrs = undefined,
  onClick = undefined,
}) {
  const iconNode = icon ? svg(iconPaths(icon), { size: iconSize, class: 'btn__icon' }) : null;
  const labelNode = el('span', { class: 'btn__label', text: label });
  const children = iconSide === 'end' ? [labelNode, iconNode] : [iconNode, labelNode];

  return el(
    'button',
    {
      class: className,
      type: 'button',
      ...(dataset ? { dataset } : {}),
      ...(attrs ?? {}),
      onclick: (event) => onClick?.(event.currentTarget),
    },
    children.filter(Boolean),
  );
}
