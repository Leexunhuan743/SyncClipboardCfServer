// 模态框与确认框：基于原生 `<dialog>`（焦点陷阱、Esc、inert 背景、焦点归还都由浏览器负责）。
// Promise 在**决定发生时**结算，`close` 事件只作旁路兜底 —— 主流程不依赖浏览器是否派发事件。
import { clear, h, icon } from '../lib/dom';

export interface ModalOptions {
  title: string;
  content: Node;
  footer?: Node | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 副标题（标题下的一行小字） */
  subtitle?: string;
  onClose?: () => void;
}

export interface Modal {
  el: HTMLDialogElement;
  body: HTMLElement;
  close(): void;
  setFooter(node: Node | null): void;
}

export function openModal({ title, content, footer = null, size = 'md', subtitle, onClose }: ModalOptions): Modal {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const body = h('div', { class: 'modal__body' }, content);
  const foot = h('footer', { class: 'modal__foot', hidden: footer === null });
  if (footer) foot.append(footer);
  const dialog = h(
    'dialog',
    { class: `modal modal--${size}`, 'aria-labelledby': titleId },
    h(
      'header',
      { class: 'modal__head' },
      h('div', { class: 'modal__titles' }, h('h2', { class: 'modal__title', id: titleId, text: title }), subtitle && h('p', { class: 'modal__subtitle', text: subtitle })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => finish() }, icon('close')),
    ),
    body,
    foot,
  );
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    onClose?.();
  };
  // 点遮罩关闭：只认**直接落在 dialog 自身**上的点击（内容里的点击 target 是子节点）
  dialog.addEventListener('mousedown', (event) => {
    if (event.target === dialog) finish();
  });
  dialog.addEventListener('close', finish);
  document.body.append(dialog);
  dialog.showModal();
  return {
    el: dialog,
    body,
    close: finish,
    setFooter(node) {
      clear(foot);
      foot.hidden = node === null;
      if (node) foot.append(node);
    },
  };
}

export interface ConfirmOptions {
  title: string;
  message: string | Node;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** 需要用户逐字输入这段文字才能确认（用于清空全部这类不可撤销的大动作） */
  requireText?: string;
}

export function confirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  requireText,
}: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };
    const input = requireText
      ? h('input', {
          class: 'input',
          type: 'text',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: `输入「${requireText}」以确认`,
          'aria-label': `输入「${requireText}」以确认`,
        })
      : null;
    const ok = h('button', {
      class: `btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`,
      type: 'button',
      text: confirmLabel,
      disabled: requireText !== undefined,
      onclick: () => settle(true),
    });
    input?.addEventListener('input', () => {
      ok.disabled = input.value.trim() !== requireText;
    });
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !ok.disabled) settle(true);
    });
    const modal = openModal({
      title,
      size: 'sm',
      content: h('div', { class: 'stack' }, typeof message === 'string' ? h('p', { class: 'confirm__message', text: message }) : message, input),
      footer: h('div', { class: 'row row--end' }, h('button', { class: 'btn', type: 'button', text: cancelLabel, onclick: () => settle(false) }), ok),
      onClose: () => settle(false),
    });
    (input ?? ok).focus();
  });
}
