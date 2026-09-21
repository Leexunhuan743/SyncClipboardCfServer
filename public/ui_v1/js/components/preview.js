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
import { iconPaths } from '../../../ui_shared/js/icons.js';
import { formatAbsolute, formatSize, typeLabel, typeChipClass } from '../format.js';
import { itemIsImage } from '../clipboard.js';
// 数据文件地址只在 `api.dataUrl` 里定义（前缀 + `download=1` 的拼法）：
// 组件里再抄一遍，就是又一处「改了接口前缀、漏了这个文件」的机会。
import { api } from '../api.js';
import { setPending, flashSuccess, isPending } from './toast.js';

export function createPreview({ onCopy, onCopyImage, onDownload, onDownloadText, onClose }) {
  const title = el('h2', { class: 'dialog__title', id: 'preview-title' });
  const meta = el('span', { class: 'dialog__meta' });
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
  dialog.addEventListener('close', () => {
    onClose?.();
    discardBody();
  });
  document.body.append(dialog);

  // 关闭之后丢弃正文与页脚。
  //
  // 为什么必须做：`dialog` 是**启动期创建、常驻 `body`** 的节点 —— 正文那棵 `<pre>` 装着
  // 整条记录的全文、页脚按钮的闭包抓着 `item`/`text`。不清就只有"下次打开预览"这一个释放点，
  // 用户不再预览第二条时，这段内容要到页面销毁才释放（`docs/archive/AUDIT-v1-v2-divergence.md` §4.2）。
  //
  // ⚠️ **不能**在 `close` 里立刻清：`.dialog` 有退出过渡（`motion.css` 的 `@starting-style` +
  // `transition-behavior: allow-discrete`，`--dur-standard` = 0.3s）。这一刻清掉，用户看到的是
  // 「框还在淡出、字先没了」，而且内容一撤、框的高度也会跟着跳。
  // ⇒ 判据交给浏览器自己：轮询到 `display` 变回 `none`（= 退出过渡真的跑完）再清。
  //   减弱动效、或浏览器不支持 `allow-discrete` 时根本没有过渡，第一帧就是 `none`
  //   ⇒ 立即清，同样不会闪。
  // 实测（1440×900，`test/manual/probe-ui-v1.mjs` 的 `PRVCLOSE`）：点 ✕ 之后 `display: block`
  // 一直持续到 ~400ms 才变 `none`，正文在这之前始终可见。
  let discardFrame = null;
  function discardBody() {
    if (discardFrame !== null) return; // 已经在等退出过渡了
    const started = performance.now();
    const tick = () => {
      discardFrame = null;
      // 等待期间又被打开（点完关闭马上点下一行）：本轮作废，下一次 `close` 会重新排。
      if (dialog.open) return;
      // 1s 只是**兜底**（不是设计值）：标签页进后台时 `requestAnimationFrame` 会被饿死，
      // 那也不能让正文永远留在 DOM 里。
      if (getComputedStyle(dialog).display === 'none' || performance.now() - started > 1000) {
        body.replaceChildren();
        footer.replaceChildren();
        return;
      }
      discardFrame = requestAnimationFrame(tick);
    };
    discardFrame = requestAnimationFrame(tick);
  }

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
      [svg(iconPaths(icon), { size: 16 }), el('span', { class: 'btn__label', text: label })],
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
    // 文本显示「字符数」，其余类型显示字节数——一个 27 B 的文本说"27 B"远不如说"27 个字符"有用。
    // ⚠️ 但这个数值是 **UTF-16 码元数**，不是字素簇数：服务端对 Text 取 `text.length`／客户端声明的
    // `dto.size`（见 `src/profile.ts`），emoji 之类会算 2。V2 同一格改用 `charCount()`，所以同一条
    // 记录两版可能显示不同的数字。此处**有意不改代码**：V1 在这个位置拿不到全文（列表正文截断到 500），
    // 能用的只有服务端给的 size。
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
    } else if (itemIsImage(item)) {
      // 判据与行内缩略图、行内「复制图片」按钮同一份（理由见 row-content.js 的 buildThumb）：
      // 文件名叫 shot.png 的 File 记录同样是可显示的图片，不该落到下面的「不支持预览」分支。
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
          // 与行内动作同一个名字（动作标签一律"动词 + 对象"，见 list.js 的说明）。
          // 预览里显示的本来就是全文，故"全文"两字不承担信息。
          label: '复制文本',
          run: () => onCopy(item, text ?? item.text),
          successLabel: '已复制',
        }),
        // 文本也能下载（2026-09-18）：与行内那一槽同一个动作、同一个名字 ——
        // 有数据文件时是"取回原文件"（叫「下载」，原扩展名保留），内联文本才是「下载文本」
        // （产物是正文生成的 `.txt`，见 main.js 的 downloadTextItem）。放在这里是因为
        // 用户已经在看这条记录的全文了，"存一份"是最自然的下一步。
        actionButton({
          icon: 'download',
          label: item.hasData ? '下载' : '下载文本',
          run: () => onDownloadText(item),
          successLabel: '已下载',
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
