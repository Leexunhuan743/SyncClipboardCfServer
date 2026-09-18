// 预览对话框：文本全文 / 图片原图。
//
// 必须处理好的四处：
// 1. 列表里的正文是**截断过的**（服务端限制 500 字符）。若直接显示截断值，用户看到的是被砍过一半的
//    剪贴板内容——所以调用方（main.js）在 textTruncated 时会先取单条全文再打开（期间显示加载态，
//    而不是让点击看起来没反应）。
// 2. 数据可能根本不在：hasData 是元数据推导，R2 对象可能已被清理。
//    <img> 加载失败必须变成可读的「数据不可用」，而不是一个裂图图标。
// 3. 点背景关闭：原生 <dialog> 默认不这么做，而这是用户对「浮层」最普遍的一次尝试。
//    （确认对话框不在此列——销毁性操作不给「点外面就当我没说」的出口。）
// 4. 打开后焦点落在**主操作**上：键盘用户按 Enter 就该完成这屏最想做的事（复制/下载），
//    而不是先 Tab 过一遍。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { formatAbsolute, formatSize, typeLabel, typeChipClass } from '../format.js';
import { itemIsImage } from '../clipboard.js';
// 数据文件地址只在 `api.dataUrl` 里定义（前缀 + `download=1` 的拼法）：
// 组件里再抄一遍，就是又一处「改了接口前缀、漏了这个文件」的机会。
import { api } from '../api.js';
import { setPending, flashSuccess, isPending } from './toast.js';

export function createPreview({ onCopy, onCopyImage, onDownload, onClose }) {
  const title = el('h2', { class: 'dialog__title', id: 'preview-title' });
  const meta = el('span', { class: 'dialog__meta', id: 'preview-meta' });
  // 类型徽标也放进标题行：同一句「内容」在不同类型下是完全不同的东西
  // （文本能复制、图片能存图、文件只能下载），徽标让"我现在看的是什么"不必靠猜测。
  const typeChipLabel = el('span');
  const typeChip = el('span', { class: 'chip' }, [el('span', { class: 'chip__dot' }), typeChipLabel]);
  const body = el('div', { class: 'dialog__body' });
  const footer = el('div', { class: 'dialog__foot' });
  const closeButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '关闭预览', onclick: () => dialog.close() },
    [svg(iconPaths('close'))],
  );

  const dialog = el(
    'dialog',
    { class: 'dialog', 'aria-labelledby': 'preview-title' },
    [
      // 标题与元信息**上下两行**：此前它们与关闭按钮挤在同一行，长文件名会把
      // 元信息挤到贴住按钮，读起来像三个同权的东西。分组之后"标题—副信息—关闭"层次分明。
      el('div', { class: 'dialog__head' }, [
        el('div', { class: 'dialog__heading' }, [typeChip, title, meta]),
        closeButton,
      ]),
      body,
      footer,
    ],
  );
  // 点背景关闭（点击落在 dialog 自身而不是其内容上时）
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  // 关闭事件对外播一次（Esc、点背景、按钮关闭都会走到这里）。
  // 调用方用它收尾：例如清掉 URL 里的深链接 hash——否则刷新页面会突然弹出上一条看过的记录。
  dialog.addEventListener('close', () => onClose?.());
  document.body.append(dialog);

  // 对话框里的操作按钮：与行内按钮同一套反馈（进行中 → 结果留在按钮上）
  function actionButton({ icon, label, run, successLabel }) {
    const button = el(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          if (isPending(button)) return;
          setPending(button, true);
          try {
            const ok = await run();
            if (ok && successLabel) flashSuccess(button, { label: successLabel });
          } finally {
            setPending(button, false);
          }
        },
      },
      [svg(iconPaths(icon), { size: 15 }), el('span', { class: 'btn__label', text: label })],
    );
    return button;
  }

  function renderText(text) {
    return el('pre', { class: 'dialog__pre', text });
  }

  function renderImage(item) {
    const image = el('img', {
      class: 'dialog__image',
      alt: item.dataName ? `${item.dataName} 的预览` : '剪贴板图片预览',
      src: api.dataUrl(item),
      loading: 'eager',
      decoding: 'async',
    });

    const missing = el('div', { class: 'empty', hidden: true }, [
      svg(iconPaths('warning'), { size: 32 }),
      el('p', { class: 'empty__title', text: '数据不可用' }),
      el('p', {
        class: 'empty__hint',
        text: '这条记录标记为有数据，但服务器上已找不到对应文件（可能已被清理策略删除）。',
      }),
    ]);

    image.addEventListener('error', () => {
      image.remove();
      missing.hidden = false;
    });

    return el('div', { class: 'dialog__body dialog__body--flush' }, [image, missing]);
  }

  function open(item, { text = null, loading = false } = {}) {
    title.textContent = item.type === 'Text' ? '文本内容' : (item.dataName ?? item.type);
    typeChip.className = `chip ${typeChipClass(item.type)}`;
    typeChipLabel.textContent = typeLabel(item.type);
    // 文本显示字符数（size 对 Text 就是字符数，见 profile.ts 的口径说明），
    // 其余类型显示字节数——一个 27 B 的文本说"27 B"远不如说"27 个字符"有用。
    const sizeText =
      item.type === 'Text' ? `${Number(item.size) || 0} 个字符` : formatSize(item.size);
    meta.textContent = `${sizeText} · ${formatAbsolute(item.createTime)}`;
    body.className = 'dialog__body';
    body.replaceChildren();
    footer.replaceChildren(el('span', { class: 'dialog__foot-spacer' }));

    if (loading) {
      // 先开壳再填内容：长文本要一次额外的往返，这段时间不该是「点了没反应」
      body.append(
        el('div', { class: 'empty' }, [
          el('p', { class: 'empty__title', text: '正在读取全文…' }),
          el('p', { class: 'empty__hint', text: '列表里显示的是截断预览，正在取这条记录的完整内容。' }),
        ]),
      );
      if (!dialog.open) dialog.showModal();
      closeButton.focus();
      return;
    }

    if (item.type === 'Text') {
      body.append(renderText(text ?? item.text));
    } else if (item.type === 'Image') {
      body.className = 'dialog__body dialog__body--flush';
      body.append(renderImage(item));
    } else {
      body.append(
        el('div', { class: 'empty' }, [
          svg(iconPaths(item.type === 'Group' ? 'group' : 'file'), { size: 32 }),
          el('p', { class: 'empty__title', text: item.dataName ?? '文件' }),
          el('p', {
            class: 'empty__hint',
            text: `${formatSize(item.size)} · 该类型不支持在网页内预览，可下载后查看。`,
          }),
        ]),
      );
    }

    const primary = [];
    if (item.type === 'Text') {
      primary.push(
        actionButton({
          icon: 'copy',
          label: '复制全文',
          run: () => onCopy(item, text ?? item.text),
          successLabel: '已复制',
        }),
      );
    } else {
      if (itemIsImage(item)) {
        primary.push(
          actionButton({
            icon: 'copy',
            label: '复制图片',
            run: () => onCopyImage(item),
            successLabel: '已复制',
          }),
        );
      }
      primary.push(
        actionButton({
          icon: 'download',
          label: '下载',
          run: () => onDownload(item),
          successLabel: '已下载',
        }),
      );
    }
    footer.append(...primary);

    if (!dialog.open) dialog.showModal();
    // 焦点落在主操作上：Enter 直接完成这屏最想做的事（无操作时退到关闭按钮）
    const first = footer.querySelector('.btn');
    (first ?? closeButton).focus();
  }

  return {
    open,
    close: () => dialog.close(),
  };
}
