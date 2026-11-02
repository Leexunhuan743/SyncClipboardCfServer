// 收藏夹命名对话框：新建与重命名共用。
//
// 提交失败（重名、名字不合法、网络）时**对话框不关**，把原因写在输入框下面让用户就地改 ——
// 成功才关闭。`submit` 返回 `null` = 成功，返回字符串 = 要显示的错误。
import { h } from '../lib/dom';
import { openModal } from '../ui/dialog';

/** 与服务端一致（src/db.ts 的 FOLDER_NAME_MAX_CHARS）：按字符（码点）计，不是 UTF-16 码元 */
export const FOLDER_NAME_MAX_CHARS = 30;

export interface FolderNameDialog {
  title: string;
  confirmLabel: string;
  initial?: string;
  /** 输入框下的一行说明 */
  hint?: string;
  submit(name: string): Promise<string | null>;
}

/** 前端先拦下明显不合法的名字（空 / 超长）；重名只有服务端知道。 */
export function folderNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return '请输入收藏夹的名字。';
  if ([...name].length > FOLDER_NAME_MAX_CHARS) return `名字最多 ${FOLDER_NAME_MAX_CHARS} 个字符。`;
  return null;
}

export function openFolderNameDialog({ title, confirmLabel, initial = '', hint, submit }: FolderNameDialog): void {
  const input = h('input', {
    class: 'input',
    type: 'text',
    value: initial,
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: String(FOLDER_NAME_MAX_CHARS * 2), // 只是兜底；真正的上限按码点在 folderNameProblem 里判
    'aria-label': '收藏夹名字',
    placeholder: '例如：工作、账号信息、常用话术',
  });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const note = hint ? h('p', { class: 'field__hint', text: hint }) : null;
  const ok = h('button', { class: 'btn btn--primary', type: 'button', text: confirmLabel });

  const show = (message: string | null): void => {
    error.hidden = message === null;
    error.textContent = message ?? '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  let busy = false;
  const go = async (): Promise<void> => {
    if (busy) return;
    const problem = folderNameProblem(input.value);
    if (problem) {
      show(problem);
      input.focus();
      return;
    }
    busy = true;
    ok.disabled = true;
    show(null);
    try {
      const failure = await submit(input.value.trim());
      if (failure === null) modal.close();
      else {
        show(failure);
        input.focus();
      }
    } finally {
      busy = false;
      ok.disabled = false;
    }
  };

  ok.addEventListener('click', () => void go());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void go();
    }
  });
  input.addEventListener('input', () => show(null));

  const modal = openModal({
    title,
    size: 'sm',
    content: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', { class: 'field__label', text: '名字' }), input), note, error),
    footer: h('div', { class: 'row row--end' }, h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => modal.close() }), ok),
  });
  input.focus();
  input.select();
}
