// 详情面板：完整内容（全文 / 大图 / 文件信息）、元数据、动作、文本编辑。
// 宽屏是右侧的并排面板（不遮挡列表）；窄屏是全屏的底部抽屉（见 styles/shell.css）。
//
// 异步内容（全文、图片、文本文件预览）用 ticket + AbortController 守卫：
// 迟到的响应不能覆盖用户已经切走的那条记录。
import { clear, h, icon } from '../lib/dom';
import { api, ApiError } from '../lib/api';
import { itemIsImage } from '../lib/clipboard';
import { charCount, formatAbsolute, formatSize, isTextLikeName, singleUrl, TEXT_MAX_BYTES, titleOf, typeLabel, utf8Bytes } from '../lib/format';
import { iconForKind } from '../lib/icons';
import type { Item } from '../lib/types';
import { isCopyable } from './feed';

export type DetailAct = 'copy' | 'download' | 'star' | 'pin' | 'trash' | 'restore' | 'purge';

export interface DetailActions {
  onClose(): void;
  /** 在列表里切到相邻的一条（-1 上一条 / +1 下一条），不关闭面板 */
  onStep(delta: -1 | 1): void;
  onAct(act: DetailAct, item: Item, button: HTMLElement): void;
  /** 保存编辑：新建一条文本记录。resolve 后面板由控制器切到新记录。 */
  onSaveText(text: string, from: Item): Promise<void>;
  onCopyHash(hash: string): void;
}

const TEXT_FILE_PREVIEW_MAX = 256 * 1024;

export function createDetail(ctx: DetailActions) {
  let current: Item | null = null;
  let ticket = 0;
  let abort: AbortController | null = null;
  let editing = false;
  let fullText: string | null = null;
  let wrap = true;

  const title = h('h2', { class: 'pane__title' });
  const tag = h('span', { class: 'tag' });
  const closeBtn = h('button', { class: 'icon-btn pane__close', type: 'button', 'aria-label': '关闭详情', title: '关闭（Esc）', onclick: () => ctx.onClose() }, icon('close'));
  const prevBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '上一条', title: '上一条（k）', onclick: () => ctx.onStep(-1) }, icon('chevronUp'));
  const nextBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '下一条', title: '下一条（j）', onclick: () => ctx.onStep(1) }, icon('chevronDown'));
  const head = h('header', { class: 'pane__head' }, tag, title, h('div', { class: 'pane__nav' }, prevBtn, nextBtn), closeBtn);
  const content = h('section', { class: 'pane__content', 'aria-live': 'polite' });
  const meta = h('dl', { class: 'meta' });
  const foot = h('footer', { class: 'pane__foot' });
  const empty = h('div', { class: 'pane__empty' }, icon('clipboard', { size: 28 }), h('p', { text: '选择一条记录查看详情' }));
  const scroll = h('div', { class: 'pane__scroll' }, content, meta);
  const el = h('aside', { class: 'pane', 'aria-label': '记录详情', hidden: true }, head, scroll, foot, empty);

  const button = (act: DetailAct, label: string, name: Parameters<typeof icon>[0], className = 'btn', pressed?: boolean): HTMLButtonElement =>
    h('button', { class: className, type: 'button', 'aria-pressed': pressed === undefined ? undefined : String(pressed), onclick: (e: Event) => current && ctx.onAct(act, current, e.currentTarget as HTMLElement) }, icon(name, { size: 16, filled: pressed }), h('span', { text: label }));

  function renderChrome(item: Item): void {
    tag.textContent = typeLabel(item.type);
    tag.dataset.type = item.type;
    title.textContent = item.type === 'Text' ? titleOf(item, 48) : (item.dataName ?? '（无文件名）');
    title.title = title.textContent ?? '';

    clear(meta);
    const row = (label: string, value: string | Node, wide = false): void => {
      meta.append(h('div', { class: 'meta__item', dataset: { wide: String(wide) } }, h('dt', { text: label }), h('dd', null, value)));
    };
    row('类型', typeLabel(item.type));
    row('大小', item.type === 'Text' && !item.textTruncated ? `${charCount(item.text)} 个字符 · ${formatSize(item.size)}` : formatSize(item.size));
    if (item.type !== 'Text' && item.dataName) row('文件名', item.dataName, true);
    row('创建', formatAbsolute(item.createTime));
    row('修改', formatAbsolute(item.lastModified));
    row('最近访问', formatAbsolute(item.lastAccessed));
    row('版本', String(item.version));
    row('哈希', h('button', { class: 'linkish mono', type: 'button', title: '点击复制完整哈希', text: `${item.hash.slice(0, 16)}…`, onclick: () => ctx.onCopyHash(item.hash) }), true);

    clear(foot);
    // 底部的「关闭」只在浮层 / 全屏详情里显示（styles/shell.css）：手机上右上角的关闭键单手够不着
    const footClose = h('button', { class: 'btn pane__foot-close', type: 'button', onclick: () => ctx.onClose() }, icon('close', { size: 16 }), h('span', { text: '关闭' }));
    if (item.isDeleted) {
      foot.append(footClose, h('div', { class: 'pane__foot-main' }, button('restore', '恢复', 'undo', 'btn btn--primary')), h('div', { class: 'pane__foot-side' }, button('purge', '彻底删除', 'trash', 'btn btn--danger-ghost')));
      return;
    }
    const canDownload = item.hasData || item.type === 'Text';
    foot.append(
      footClose,
      h(
        'div',
        { class: 'pane__foot-main' },
        isCopyable(item) ? button('copy', item.type === 'Text' ? '复制' : '复制图片', 'copy', 'btn btn--primary') : button('download', '下载', 'download', 'btn btn--primary'),
        isCopyable(item) && canDownload ? button('download', '下载', 'download') : null,
        linkButton(item),
        item.type === 'Text' ? h('button', { class: 'btn', type: 'button', disabled: editing, onclick: () => startEdit() }, icon('edit', { size: 16 }), h('span', { text: '编辑' })) : null,
      ),
      h('div', { class: 'pane__foot-side' }, button('star', item.starred ? '已收藏' : '收藏', 'star', 'btn btn--ghost', item.starred), button('pin', item.pinned ? '已置顶' : '置顶', 'pin', 'btn btn--ghost', item.pinned), button('trash', '回收站', 'trash', 'btn btn--danger-ghost')),
    );
  }

  /** 整段文本就是一个 http(s) 链接时给「打开链接」：新标签页、不带 opener 与 referrer。 */
  function linkButton(item: Item): HTMLElement | null {
    const href = item.type === 'Text' ? singleUrl(fullText ?? item.text) : null;
    if (!href) return null;
    return h('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer', title: href }, icon('link', { size: 16 }), h('span', { text: '打开链接' }));
  }

  // ---- 内容 ----
  function reader(text: string): HTMLElement {
    const pre = h('pre', { class: 'reader', dataset: { wrap: String(wrap) }, tabindex: '0', text });
    const toggle = h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(wrap), onclick: () => {
      wrap = !wrap;
      pre.dataset.wrap = String(wrap);
      toggle.setAttribute('aria-pressed', String(wrap));
    } }, '自动换行');
    return h('div', { class: 'reader-wrap' }, h('div', { class: 'reader__bar' }, h('span', { class: 'reader__count', text: `${charCount(text)} 个字符 · ${text.split('\n').length} 行` }), toggle), pre);
  }

  function loading(text = '正在加载…'): HTMLElement {
    return h('div', { class: 'pane__loading', role: 'status' }, h('span', { class: 'spinner' }), text);
  }

  function problem(message: string, retry?: () => void): HTMLElement {
    return h('div', { class: 'pane__problem' }, icon('warning', { size: 22 }), h('p', { text: message }), retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, '重试') : null);
  }

  function startEdit(): void {
    const item = current;
    if (!item || item.type !== 'Text' || item.isDeleted) return;
    if (item.textTruncated && fullText === null) return; // 全文还没到，不开放编辑（会把截断的正文存成新记录）
    editing = true;
    const original = fullText ?? item.text;
    const area = h('textarea', { class: 'textarea', rows: 12, spellcheck: 'false', 'aria-label': '编辑正文', value: original });
    const note = h('p', { class: 'field__hint' });
    const save = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, icon('check', { size: 16 }), h('span', { text: '保存为新记录' }));
    const sync = (): void => {
      const n = charCount(area.value);
      const same = area.value === original;
      const tooLong = utf8Bytes(area.value) > TEXT_MAX_BYTES;
      save.disabled = same || area.value.trim() === '' || tooLong;
      note.textContent = tooLong ? '正文超过 1 MiB（按 UTF-8 字节算，一个汉字 3 字节），无法保存。' : same ? '修改后会保存成一条新记录，原记录保持不变。' : `${n} 个字符`;
      note.dataset.tone = tooLong ? 'error' : '';
    };
    const doSave = async (): Promise<void> => {
      if (save.disabled) return;
      save.disabled = true;
      area.disabled = true;
      try {
        await ctx.onSaveText(area.value, item);
        editing = false;
      } catch (error) {
        area.disabled = false;
        note.textContent = error instanceof ApiError ? `保存失败：${error.message}` : '保存失败，请重试。';
        note.dataset.tone = 'error';
        sync();
      }
    };
    area.addEventListener('input', sync);
    area.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void doSave();
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancelEdit();
      }
    });
    save.addEventListener('click', () => void doSave());
    clear(content).append(h('div', { class: 'stack' }, area, note, h('div', { class: 'row row--end' }, h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => cancelEdit() }), save)));
    renderChrome(item);
    area.focus();
    sync();
  }

  function cancelEdit(): void {
    editing = false;
    if (current) paint(current);
  }

  async function loadContent(item: Item): Promise<void> {
    const mine = ++ticket;
    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;
    const live = (): boolean => mine === ticket && !signal.aborted;

    if (item.type === 'Text') {
      if (!item.textTruncated) {
        fullText = item.text;
        clear(content).append(item.text.trim() === '' ? h('p', { class: 'pane__quiet', text: '（空文本）' }) : reader(item.text));
        return;
      }
      clear(content).append(reader(item.text), loading('正在取回全文…'));
      try {
        const full = await api.get(item, signal);
        if (!live()) return;
        fullText = full.text;
        clear(content).append(reader(full.text));
        renderChrome(current ?? item);
      } catch (error) {
        if (!live()) return;
        clear(content).append(reader(item.text), problem(error instanceof ApiError ? error.message : '全文读取失败', () => void loadContent(item)));
      }
      return;
    }

    if (!item.hasData) {
      clear(content).append(problem('服务器上没有这条记录的数据文件（可能已被清理）。'));
      return;
    }

    if (itemIsImage(item)) {
      const img = h('img', { class: 'viewer__img', alt: item.dataName ?? '图片', src: api.dataUrl(item) });
      const frame = h('figure', { class: 'viewer', dataset: { zoom: 'false' } }, loading('正在加载图片…'));
      img.addEventListener('load', () => {
        if (!live()) return;
        clear(frame).append(img);
        frame.title = '点击切换适应窗口 / 原始大小';
      });
      img.addEventListener('error', () => {
        if (!live()) return;
        clear(frame).append(problem('图片加载失败：数据可能已不在服务器上，或该文件不是可显示的图片。'));
      });
      frame.addEventListener('click', () => {
        if (frame.contains(img)) frame.dataset.zoom = String(frame.dataset.zoom !== 'true');
      });
      clear(content).append(frame);
      return;
    }

    if (isTextLikeName(item.dataName) && item.size <= TEXT_FILE_PREVIEW_MAX) {
      clear(content).append(loading('正在读取文件…'));
      try {
        const blob = await api.fetchData(item, { signal });
        const text = await blob.text();
        if (!live()) return;
        clear(content).append(reader(text));
      } catch (error) {
        if (!live()) return;
        clear(content).append(problem(error instanceof ApiError && error.payload?.error === 'data_missing' ? '数据文件已不在服务器上。' : '文件读取失败', () => void loadContent(item)));
      }
      return;
    }

    clear(content).append(
      h('div', { class: 'filecard' }, h('div', { class: 'tile tile--lg', dataset: { type: item.type } }, icon(iconForKind(item.type), { size: 32 })), h('strong', { text: item.dataName ?? '（无文件名）' }), h('span', { class: 'pane__quiet', text: `${formatSize(item.size)} · 此类型不支持在线预览，请下载查看` })),
    );
  }

  function paint(item: Item): void {
    renderChrome(item);
    void loadContent(item);
  }

  function reveal(visible: boolean): void {
    el.hidden = !visible;
    head.hidden = !visible;
    scroll.hidden = !visible;
    foot.hidden = !visible;
    empty.hidden = visible;
  }

  reveal(false);

  return {
    el,
    get key(): string | null {
      return current?.key ?? null;
    },
    /** 打开一条记录（切换记录时重新取内容）。 */
    show(item: Item): void {
      const same = current?.key === item.key;
      current = item;
      if (!same) {
        editing = false;
        fullText = null;
        scroll.scrollTop = 0;
      }
      reveal(true);
      if (same) renderChrome(item);
      else paint(item);
    },
    /** 列表刷新后同步这条记录的最新元数据（星标/置顶/访问时间…），不重取内容。 */
    update(item: Item): void {
      if (!current || current.key !== item.key) return;
      const contentChanged = current.text !== item.text || current.lastModified !== item.lastModified || current.isDeleted !== item.isDeleted;
      current = item;
      renderChrome(item);
      if (contentChanged && !editing) void loadContent(item);
    },
    close(): void {
      ticket += 1;
      abort?.abort();
      current = null;
      editing = false;
      reveal(false);
    },
    /** 列表里有没有上一条 / 下一条（决定两个箭头按钮是否可用） */
    setSteps(prev: boolean, next: boolean): void {
      prevBtn.disabled = !prev;
      nextBtn.disabled = !next;
    },
    focus(): void {
      closeBtn.focus();
    },
  };
}

