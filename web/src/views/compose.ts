// 新建文本：把一段内容直接存成一条记录（不会碰任何设备的"当前剪贴板"，只是多一条历史）。
import { charCount, TEXT_MAX_BYTES, utf8Bytes } from '../lib/format';
import { h, icon } from '../lib/dom';
import { ApiError } from '../lib/api';
import { openModal } from '../ui/dialog';

export function openCompose(onCreate: (text: string) => Promise<void>, initial = ''): void {
  const area = h('textarea', { class: 'textarea', rows: 10, 'aria-label': '正文', placeholder: '粘贴或输入要保存的文本…', spellcheck: 'false', value: initial });
  const hint = h('p', { class: 'field__hint', text: '保存后会作为一条新记录出现在列表顶部，其它设备也会同步到它。' });
  const save = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, icon('check', { size: 16 }), h('span', { text: '保存' }));
  const sync = (): void => {
    const n = charCount(area.value);
    const tooLong = utf8Bytes(area.value) > TEXT_MAX_BYTES;
    save.disabled = area.value.trim() === '' || tooLong;
    hint.textContent = tooLong ? '正文超过 1 MiB（按 UTF-8 字节算，一个汉字 3 字节），无法保存。' : n > 0 ? `${n} 个字符` : '保存后会作为一条新记录出现在列表顶部，其它设备也会同步到它。';
    hint.dataset.tone = tooLong ? 'error' : '';
  };
  const submit = async (): Promise<void> => {
    if (save.disabled) return;
    save.disabled = true;
    area.disabled = true;
    try {
      await onCreate(area.value);
      modal.close();
    } catch (error) {
      area.disabled = false;
      hint.textContent = error instanceof ApiError ? `保存失败：${error.message}` : '保存失败，请重试。';
      hint.dataset.tone = 'error';
      sync();
    }
  };
  area.addEventListener('input', sync);
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
  save.addEventListener('click', () => void submit());
  const modal = openModal({
    title: '新建文本',
    subtitle: 'Ctrl / ⌘ + Enter 保存',
    size: 'md',
    content: h('div', { class: 'stack' }, area, hint),
    footer: h('div', { class: 'row row--end' }, h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => modal.close() }), save),
  });
  area.focus();
  sync();
}
