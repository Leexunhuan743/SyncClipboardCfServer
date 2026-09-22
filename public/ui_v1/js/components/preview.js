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
import { formatAbsolute, formatSize, charCount, typeLabel, typeChipClass } from '../format.js';
import { itemIsImage } from '../clipboard.js';
// 数据文件地址只在 `api.dataUrl` 里定义（前缀 + `download=1` 的拼法）：
// 组件里再抄一遍，就是又一处「改了接口前缀、漏了这个文件」的机会。
import { api } from '../api.js';
import { setPending, flashSuccess, isPending } from './toast.js';
// 编辑态的三句**语义文案**（过大禁用的说明 / 保存成功的就地说明 / 保存失败的就地说明）：
// 它们逐字对齐实现语义，故住在 messages.js（与删除确认同一纪律，两版逐字一致）。
import { editTooLargeText, textSavedNote, textSaveFailedText } from '../messages.js';

// 「编辑」的体积上限（UTF-8 字节），与 `src/ui/routes.ts` 的 `UI_TEXT_CREATE_MAX_BYTES` **必须一致**：
// 前端拦在按钮上（超了直接禁用 + 说明），服务端那一条是纵深防御。改一处就要改另一处。
const EDIT_MAX_BYTES = 1024 * 1024;

export function createPreview({ onCopy, onCopyImage, onDownload, onDownloadText, onEdit, onClose }) {
  const title = el('h2', { class: 'dialog__title', id: 'preview-title' });
  const meta = el('span', { class: 'dialog__meta' });
  // 类型徽标也放进标题行：同一句「内容」在不同类型下是完全不同的东西
  // （文本能复制、图片能存图、文件只能下载），徽标让"我现在看的是什么"不必靠猜测。
  const typeChipLabel = el('span');
  const typeChip = el('span', { class: 'chip' }, [el('span', { class: 'chip__dot' }), typeChipLabel]);
  const body = el('div', { class: 'dialog__body' });
  const footer = el('div', { class: 'dialog__foot' });
  // 编辑保存失败的就地错误盒（挂在 textarea 下面，`role="alert"` —— 与确认框、登录页同一套
  // `.alert--error`；`components.md` 的 error 格要求"信息挨着控件、不靠颜色单独传达"）。
  const editError = el('p', { class: 'alert--error', role: 'alert', hidden: true });
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
  // Esc：**编辑态下只退出编辑、不关对话框**（2026-09-22，ADR D30 的 Q4）—— 一段几千字的编辑
  // 不该被一个 Esc 丢掉。`cancel` 是可取消事件，`preventDefault()` 就能拦住 UA 的关框行为
  // （与 `confirm.js` 在途挡 Esc 是同一个手法）；非编辑态保持原样（Esc 关框）。
  dialog.addEventListener('cancel', (event) => {
    if (!editing) return;
    event.preventDefault();
    exitEdit();
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

  // 对话框里的操作按钮：与行内按钮同一套反馈（进行中 → 结果留在按钮上）。
  // `disabled` / `title` 与 `list.js` 的同类按钮同义：**禁用必须带原因**（title 是"为什么点不动"
  // 唯一的传达通道，见 components.css 里 `.btn[disabled]` 的注释）。
  function actionButton({ icon, label, run, successLabel, disabled = false, title: titleText = null }) {
    const button = el(
      'button',
      {
        class: 'btn',
        type: 'button',
        disabled,
        title: titleText,
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
      // 两句必须同时成立（与行内缩略图 `row-content.js` 的同一处文案同源）：`error` 事件
      // 分不出"对象已被清理策略删掉"与"对象在、但内容不是可显示的图片"（服务端不校验
      // 扩展名与内容是否一致，上传被截断也会落到这里）。只写前者会在第二种情况下误报
      // —— 2026-09-21 实测：三条 18 B 的假 PNG 记录，数据端点回 200/18 B，弹窗却说"已找不到文件"。
      el('p', {
        class: 'empty__hint',
        text: '这条记录标记为有数据，但服务器上已找不到对应文件（可能已被清理策略删除），或文件内容不是可显示的图片。',
      }),
    ]);

    image.addEventListener('error', () => {
      image.remove();
      missing.hidden = false;
    });

    return el('div', { class: 'dialog__body dialog__body--flush' }, [image, missing]);
  }

  // ===== 编辑态（2026-09-22，ADR D30）=====
  //
  // 两态机：**预览 ⇄ 编辑**。语义按用户的四个决定落地：
  //   · Q1(a) 保存 = **新建一条记录**（正文一改 hash 就变，见 ADR D30），当前剪贴板不动；
  //   · Q2    只对 `Text` 类型的记录开放（其余类型根本没有"编辑正文"这回事）；
  //   · Q3(c) 保存后**不关框**：正文换成刚保存的那段、就地给一条「已保存为新记录」的说明，
  //           复制/下载都跟着屏幕上的这段走（见 `currentText` 的用法）；
  //   · Q4    等宽 textarea；**Esc = 退出编辑（不关对话框）**；> 1 MiB 不给编辑；允许改空；
  //           内容没变就保存 = 什么都不发。
  let currentItem = null;
  // 屏幕上这段正文。它是**编辑保存后就地替换**的那份，也是复制/下载的唯一来源 ——
  // 这样"屏幕上是什么、复制/下载就是什么"，不会出现"刚存完却复制到旧文本"的坑。
  let currentText = '';
  let savedNote = null; // 保存成功后的就地说明（下次 open 清掉）
  let editing = false;

  function renderView() {
    body.className = 'dialog__body';
    const children = [];
    if (savedNote !== null) children.push(el('p', { class: 'dialog__note', text: savedNote }));
    children.push(renderText(currentText));
    body.replaceChildren(...children);
  }

  function renderViewActions() {
    const item = currentItem;
    const primary = [];
    if (item.type === 'Text') {
      // 编辑（2026-09-22，ADR D30）：放在最左（用户指定），右侧是既有的复制/下载。
      // 正文过大时**禁用并说明原因**（1 MiB 上限，与服务端 `UI_TEXT_CREATE_MAX_BYTES` 一致）——
      // 在 textarea 里放几十 MB 会把页面卡死，那时唯一可行的路径是「下载文本」。
      const tooLarge = new TextEncoder().encode(currentText).length > EDIT_MAX_BYTES;
      primary.push(
        actionButton({
          icon: 'edit',
          label: '编辑',
          disabled: tooLarge,
          title: tooLarge
            ? editTooLargeText(formatSize(EDIT_MAX_BYTES))
            : '编辑这段文本（保存成一条新记录，当前剪贴板不受影响）',
          run: () => {
            enterEdit();
            return true;
          },
        }),
        actionButton({
          icon: 'copy',
          // 与行内动作同一个名字（动作标签一律"动词 + 对象"，见 list.js 的说明）。
          // 预览里显示的本来就是全文，故"全文"两字不承担信息。
          label: '复制文本',
          run: () => onCopy(item, currentText),
          successLabel: '已复制',
        }),
        // 文本也能下载（2026-09-18）：与行内那一槽同一个动作、同一个名字 ——
        // 有数据文件时是"取回原文件"（叫「下载」，原扩展名保留），内联文本才是「下载文本」
        // （产物是正文生成的 `.txt`，见 main.js 的 downloadTextItem）。放在这里是因为
        // 用户已经在看这条记录的全文了，"存一份"是最自然的下一步。
        // ⚠️ 传 `currentText`：编辑保存之后屏幕上是**新**那段，下载必须跟着屏幕走。
        actionButton({
          icon: 'download',
          label: item.hasData ? '下载' : '下载文本',
          run: () => onDownloadText(item, currentText),
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
    footer.replaceChildren(el('span', { class: 'dialog__foot-spacer' }), ...primary);
    const first = footer.querySelector('.btn');
    (first ?? closeButton).focus();
  }

  function enterEdit() {
    editing = true;
    dialog.dataset.editing = 'true';
    const area = el('textarea', {
      class: 'dialog__edit',
      spellcheck: 'false',
      // 可访问名与可见按钮同源（"编辑"这个动作的对象就是这段正文）
      'aria-label': '编辑这段文本',
    });
    area.value = currentText;
    body.className = 'dialog__body dialog__body--edit';
    body.replaceChildren(area, editError);

    const cancel = el('button', { class: 'btn', type: 'button', onclick: () => exitEdit() }, [
      el('span', { class: 'btn__label', text: '取消' }),
    ]);
    const save = el('button', { class: 'btn btn--primary', type: 'button' }, [
      el('span', { class: 'btn__label', text: '保存' }),
    ]);
    save.addEventListener('click', async () => {
      if (isPending(save)) return;
      const next = area.value;
      // 「没改字」的判据必须**先把行尾归一**再比：`<textarea>` 的 `value` 会把 CRLF 折成 LF
      // （HTML 规范的 API value），而记录里存的可能是 CRLF —— 官方客户端从 Windows 剪贴板
      // 发出的正文就是 CRLF，服务端原样保存。不归一的话，**只点一下保存**也会比出"有变化"，
      // 从而凭空生成一条"只差行尾"的新记录。
      const unchanged = next === currentText.replace(/\r\n?/g, '\n');
      if (unchanged) {
        exitEdit();
        return;
      }
      editError.hidden = true;
      setPending(save, true);
      try {
        await onEdit(currentItem, next);
        currentText = next;
        savedNote = textSavedNote(charCount(next));
        exitEdit();
      } catch (error) {
        // 就地报错（挨着控件、`role="alert"`），**留在编辑态**：用户改的内容还在，可以再存一次
        editError.textContent = textSaveFailedText(error?.message ?? '未知错误');
        editError.hidden = false;
      } finally {
        setPending(save, false);
      }
    });
    footer.replaceChildren(el('span', { class: 'dialog__foot-spacer' }), cancel, save);

    if (!dialog.open) dialog.showModal();
    area.focus();
    // 光标落到末尾：改一段已有文本，接着写比全选更常见
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function exitEdit() {
    editing = false;
    dialog.dataset.editing = 'false';
    editError.hidden = true;
    editError.textContent = '';
    renderView();
    renderViewActions();
  }

  function open(item, { text = null, loading = false } = {}) {
    currentItem = item;
    currentText = text ?? item.text ?? '';
    savedNote = null;
    editing = false;
    dialog.dataset.editing = 'false';
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
      renderView();
      renderViewActions();
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (itemIsImage(item)) {
      // 判据与行内缩略图、行内「复制图片」按钮同一份（理由见 row-content.js 的 buildThumb）：
      // 文件名叫 shot.png 的 File 记录同样是可显示的图片，不该落到下面的「不支持预览」分支。
      body.className = 'dialog__body dialog__body--flush';
      body.append(renderImage(item));
    } else {
      body.className = 'dialog__body';
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

    renderViewActions();

    if (!dialog.open) dialog.showModal();
  }

  return {
    open,
    close: () => dialog.close(),
  };
}
