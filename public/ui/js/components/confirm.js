// 确认对话框：销毁性操作前问一句，并且把**请求进行中/失败**留在对话框里。
//
// 用原生 <dialog> + showModal()：焦点陷阱、Esc 关闭、背景 inert、顶层渲染都由浏览器提供，
// 自己用 div 搭的那套总要重写一遍而且总会漏掉其中一项。
//
// 两处刻意的设计（都与「问一句就关掉」不同）：
//   1. 初始焦点落在**取消**上。原生 dialog 会把焦点给第一个可聚焦元素（这里是右上角关闭按钮），
//      于是「问一句」时按下 Enter 等于点了关闭——安全的选择应当是 Enter 的默认结果。
//   2. 传了 `action` 时点击确认**不立刻关闭**：按钮转成进行中，失败留在原地显示原因并可重试，
//      只有成功才关闭。否则一个两秒的删除请求读起来就是「点了没反应」。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { setPending } from './toast.js';

export function createConfirm() {
  let resolveCurrent = null;
  let action = null;

  const title = el('h2', { class: 'dialog__title', id: 'confirm-title' });
  const message = el('p', { id: 'confirm-message' });
  const errorBox = el('p', { class: 'dialog__error', role: 'alert', hidden: true });
  const okLabel = el('span', { class: 'btn__label' });

  const okButton = el('button', { class: 'btn btn--primary', type: 'button' }, [okLabel]);
  const closeButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '关闭',
      // 取消路径同样在当下结算，理由与 settle() 的注释相同
      onclick: () => {
        dialog.close('cancel');
        settle(false);
      },
    },
    [svg(iconPaths('close'))],
  );
  const cancelButton = el(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        dialog.close('cancel');
        settle(false);
      },
    },
    [el('span', { class: 'btn__label', text: '取消' })],
  );

  const dialog = el(
    'dialog',
    { class: 'dialog dialog--narrow', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-message' },
    [
      el('div', { class: 'dialog__head' }, [title, closeButton]),
      el('div', { class: 'dialog__body' }, [message, errorBox]),
      el('div', { class: 'dialog__foot' }, [
        el('span', { class: 'dialog__foot-spacer' }),
        cancelButton,
        okButton,
      ]),
    ],
  );

  // 结果在**决定的当下**落地，不等待 `close` 事件：
  // 事件是旁路（Esc / 点背景 / 程序化关闭才必需），而依赖它会让「未触发即永不结算」——
  // 调用方 `await ask()` 之后的收尾（提示、刷新）就整段丢失。实测 headless Chromium 上
  // `dialog.close()` 后 close 事件根本不来，这条路径真的会悬着。
  // settle 幂等：谁先到谁结算，后到的（含 close 事件）看到 resolveCurrent 已空即忽略。
  function settle(result) {
    const resolve = resolveCurrent;
    resolveCurrent = null;
    action = null;
    errorBox.hidden = true;
    if (resolve) resolve(result);
  }

  okButton.addEventListener('click', async () => {
    if (!action) {
      dialog.close('confirm');
      settle(true);
      return;
    }
    errorBox.hidden = true;
    setPending(okButton, true);
    cancelButton.disabled = true;
    closeButton.disabled = true;
    try {
      await action();
      dialog.close('confirm');
      settle(true);
    } catch (error) {
      // 留在原地：用户读得到原因，也能直接重试，不必重新走一遍确认
      errorBox.textContent = error?.message ?? String(error);
      errorBox.hidden = false;
    } finally {
      setPending(okButton, false);
      cancelButton.disabled = false;
      closeButton.disabled = false;
    }
  });

  // 旁路关闭：`cancel`（Esc）与 `close`（点背景/程序化）都在这里兜底。
  // 主路径已自行结算，故这两个监听器只在「不是我们主动关的」时候生效（settle 幂等）。
  dialog.addEventListener('cancel', () => settle(false));
  dialog.addEventListener('close', () => settle(dialog.returnValue === 'confirm'));

  document.body.append(dialog);

  return {
    ask({ title: heading, message: body, confirmLabel = '删除', danger = true, action: onConfirm = null }) {
      title.textContent = heading;
      message.textContent = body;
      okLabel.textContent = confirmLabel;
      okButton.className = danger ? 'btn btn--danger-solid' : 'btn btn--primary';
      action = onConfirm;
      return new Promise((resolve) => {
        resolveCurrent = resolve;
        dialog.showModal();
        cancelButton.focus();
      });
    },
  };
}
