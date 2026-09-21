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
import { iconPaths } from '../../../ui_shared/js/icons.js';
import { setPending, isPending } from './toast.js';

export function createConfirm() {
  let resolveCurrent = null;
  let action = null;
  // 「有请求在飞」的旗子：`setPending(okButton, true)` 只 disable 了**确认键**，
  // 而 ✕ / 取消 / Esc 三条路都还能把对话框关掉。在途期间把它们也关掉（F2）——
  // 否则"以为取消了、其实删成了"：调用方的收行/刷新/提示全写在 `if (!ok)` 之后。
  // V2 的 `dialog.js` 用同一份 `canClose` 机制（d0c58bd），这里是它的 V1 移植。
  let busy = false;
  // 在途时可以**中止**（2026-09-21，批量取消）：控制器由本次动作创建，取消键把它 `abort()`。
  // 注意中止的语义是"**这批做完就停**"—— 服务端一次请求内部不会被打断（见 api.js 的分片循环），
  // 所以不会留下半条记录；已生效的条数由调用方如实报出。
  let controller = null;

  const title = el('h2', { class: 'dialog__title', id: 'confirm-title' });
  const message = el('p', { id: 'confirm-message' });
  const errorBox = el('p', { class: 'alert--error', role: 'alert', hidden: true });
  const okLabel = el('span', { class: 'btn__label' });

  const okButton = el('button', { class: 'btn btn--primary', type: 'button' }, [okLabel]);
  // 在途时 ✕ 与「取消」都**不算**取消：请求已发出，关掉对话框只会让调用方
  // 把"已成功"读成"用户取消"。两条路都先过 `busy` 守卫（与 V2 的 `canClose` 同义）。
  const tryDismiss = () => {
    if (busy) return;
    dialog.close('cancel');
    settle(false);
  };
  const closeButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '关闭',
      // 取消路径同样在当下结算，理由与 settle() 的注释相同
      onclick: tryDismiss,
    },
    [svg(iconPaths('close'))],
  );
  const cancelLabel = el('span', { class: 'btn__label', text: '取消' });
  const cancelButton = el(
    'button',
    {
      class: 'btn',
      type: 'button',
      // 两条语义同一个键：空闲时是「取消」（关掉对话框、不做事），在途时是「中止」
      // （请求停下、对话框留着把结果说清楚）。
      onclick: () => {
        if (!busy) {
          tryDismiss();
          return;
        }
        // 只**请求**中止：真正停下来发生在片与片之间（api.js 的分片循环里），
        // 所以这里立刻禁用自己，避免连点造成二次 abort。
        if (controller && !controller.signal.aborted) {
          controller.abort();
          cancelButton.disabled = true;
          cancelLabel.textContent = '正在中止…';
        }
      },
    },
    [cancelLabel],
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
    // 重入守卫：`setPending` 只加 `pointer-events: none`（挡鼠标），**键盘 Enter 照样
    // 会派发 click** —— 确认框上连按两次回车就会执行两次 action（两次批量删除 / 两次清空）。
    // 其余同类按钮都有这一条（list.js 的行内动作、info.js 的保存与检查、preview.js 的动作）。
    if (isPending(okButton)) return;
    if (!action) {
      dialog.close('confirm');
      settle(true);
      return;
    }
    errorBox.hidden = true;
    setPending(okButton, true);
    busy = true;
    // 在途期间：✕ 与 Esc 依旧挡住（F2——关掉对话框会让调用方把"已成功"读成"用户取消"），
    // 但「取消」变成可用的「中止」：长批量（300 条 = 3 批）必须留一条停下来的路。
    closeButton.disabled = true;
    cancelButton.disabled = false;
    cancelLabel.textContent = '中止';
    controller = new AbortController();
    try {
      // `action` 收到一个上下文：`setMessage(text)` 把进度写进正文，`signal` 用于中止
      // （api.js 的分片循环在每片之间检查它）。旧调用方忽略它们即可。
      await action({
        setMessage: (text) => { message.textContent = text; },
        signal: controller.signal,
      });
      busy = false;
      dialog.close('confirm');
      settle(true);
    } catch (error) {
      // 留在原地：用户读得到原因，也能直接重试或取消（故这里放开 `busy`）
      busy = false;
      errorBox.textContent = error?.message ?? String(error);
      errorBox.hidden = false;
    } finally {
      setPending(okButton, false);
      // 复位这一键的两副面孔（空闲时是「取消」；无论成功/失败/中止都要回到它）
      cancelButton.disabled = false;
      cancelLabel.textContent = '取消';
      closeButton.disabled = false;
      controller = null;
    }
  });

  // 旁路关闭：`cancel`（Esc）与 `close`（点背景/程序化）都在这里兜底。
  // 主路径已自行结算，故这两个监听器只在「不是我们主动关的」时候生效（settle 幂等）。
  // **Esc 在途时必须挡下**：`cancel` 是可取消事件，`disabled` 挡不住它 ——
  // 不 preventDefault 的话，对话框照样关、`settle(false)` 照样结算（F2）。
  dialog.addEventListener('cancel', (event) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    settle(false);
  });
  dialog.addEventListener('close', () => settle(dialog.returnValue === 'confirm'));

  document.body.append(dialog);

  return {
    // `destructive`：目前四个调用方都是销毁性动作（删除 / 清空回收站 / 清空全部），默认的
    // 填色红是对的；把它做成参数是为了下一处 —— 若将来给"恢复 12 条"这类可逆动作也加一句确认，
    // 复制粘贴这一行会得到一个红得像删除的按钮，而那正是"同一档强度"要求避免的事。
    ask({ title: heading, message: body, confirmLabel = '删除', action: onConfirm = null, destructive = true }) {
      title.textContent = heading;
      message.textContent = body;
      okLabel.textContent = confirmLabel;
      okButton.className = destructive ? 'btn btn--danger-solid' : 'btn btn--primary';
      action = onConfirm;
      return new Promise((resolve) => {
        resolveCurrent = resolve;
        dialog.showModal();
        cancelButton.focus();
      });
    },
  };
}
