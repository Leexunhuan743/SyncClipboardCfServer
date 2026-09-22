// 键盘快捷键：**目录**（唯一事实源）+ 帮助浮层。
//
// 设计取向（2026-09-22 用户要求"全面评估 ui v1 的全部页面，看可不可以设计一些合适的快捷键"）：
//   · **少而稳**：只绑「有可见等价按钮」的动作 —— 每个键都能在对应按钮的 hover 提示里看到
//     （键与按钮一一对应，用户不必背）；不与浏览器/输入法抢键（除 `Ctrl+Enter` 这一条明确的例外）。
//   · **不做销毁性单键**：删除 / 彻底删除 / 清空回收站仍然只走按钮或确认框 —— 单键手滑的代价是
//     一条记录，而 `confirm.js` 的初始焦点落在「取消」正是同一条安全取向。
//   · **输入处一律让路**：`INPUT` / `TEXTAREA` / `SELECT` / `contentEditable`，以及 IME 组字期间。
//   · **对话框打开时只有对话框自己的键**（`preview.js`）：列表页那条派发器见到 `dialog[open]` 就退出。
//
// ⚠️ 目录与派发器是同**一份**数组（`main.js` 把 `run` 一并放进表里，本模块只负责渲染）：
// 因此不会出现"帮助里写了、实际没绑"或反过来的漂移 —— 这也正是把帮助做成浮层而不是文档的原因之一。
//
// 为什么要有这个浮层：hover 提示只能被"已经知道有快捷键"的人发现。`?` 是这类列表页的通用入口
// （Gmail / GitHub / Slack 都是它），成本低、收益是整组键的可发现性。
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';
import { EDIT_SHORTCUTS, PREVIEW_SHORTCUTS } from './preview.js';

/** 一组快捷键 → DOM。`keys` 是**按键序列**（如 ['Ctrl', 'Enter']），逐个渲染成键帽。 */
function renderGroup(title, entries) {
  return el('section', { class: 'shortcuts' }, [
    el('h3', { class: 'shortcuts__title', text: title }),
    el(
      'ul',
      { class: 'shortcuts__list' },
      entries.map((entry) =>
        el('li', { class: 'shortcuts__item' }, [
          el(
            'span',
            { class: 'shortcuts__keys' },
            entry.keys.map((k) => el('kbd', { text: k })),
          ),
          el('span', { class: 'shortcuts__label', text: entry.label }),
        ]),
      ),
    ),
  ]);
}

/**
 * 快捷键帮助浮层。
 * @param {{ list?: { keys: string[], label: string }[] }} options
 *   `list` = 列表页那一组（由 `main.js` 传入，含 `run`；这里只读 `keys`/`label`）。
 */
export function createShortcutsHelp({ list = [] } = {}) {
  const dialog = el('dialog', { class: 'dialog dialog--narrow', 'aria-labelledby': 'shortcuts-title' });
  const closeButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '关闭快捷键列表', onclick: () => dialog.close() },
    [svg(iconPaths('close'))],
  );
  dialog.append(
    el('div', { class: 'dialog__head' }, [
      el('h2', { class: 'dialog__title', id: 'shortcuts-title', text: '键盘快捷键' }),
      closeButton,
    ]),
    el('div', { class: 'dialog__body' }, [
      renderGroup('列表页', list),
      renderGroup('预览框', PREVIEW_SHORTCUTS),
      renderGroup('编辑正文', EDIT_SHORTCUTS),
    ]),
    el('div', { class: 'dialog__foot' }, [
      el('span', { class: 'dialog__foot-spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, [
        el('span', { class: 'btn__label', text: '知道了' }),
      ]),
    ]),
  );
  document.body.append(dialog);
  return {
    el: dialog,
    open() {
      if (!dialog.open) dialog.showModal();
    },
  };
}
