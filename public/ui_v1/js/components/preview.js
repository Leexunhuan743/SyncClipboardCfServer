// 预览对话框：文本全文 / 图片原图。
//
// 必须处理好的四处：
// 1. 列表里的正文是**截断过的**（服务端限制 500 字符）。若直接显示截断值，用户看到的是被砍过一半的
//    剪贴板内容——所以调用方（main.js）在 textTruncated 时会先取单条全文再打开（期间显示加载态，
//    而不是让点击看起来没反应）。
// 2. 数据可能根本不在：hasData 是元数据推导，R2 对象可能已被清理。
//    <img> 加载失败必须变成可读的「数据不可用」，而不是一个裂图图标。
// 3. 点背景关闭：原生 <dialog> 默认不这么做，而这是用户对「浮层」最普遍的一次尝试。
//    **编辑态例外**（2026-09-22 用户要求）：编辑中段误点不关框，退出编辑只有「取消」与 Esc 两个显式入口。
//    （确认对话框不在此列——销毁性操作不给「点外面就当我没说」的出口。）
// 4. 打开后焦点落在**正文框**上（`.dialog__body` 带 `tabindex="-1"`，2026-09-22 用户要求）：
//    滚轮与键盘（↑↓ / PageUp·Down / Space）立刻能滚这段内容。**不是**"落在第一个按钮上" ——
//    页脚最左那枚是销毁性的（「移动到回收站」/「彻底删除」），而按钮位置本身还会随记录类型变。
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';
import { formatAbsolute, formatSize, typeLabel, typeChipClass } from '../format.js';
import { itemIsImage } from '../clipboard.js';
// 数据文件地址只在 `api.dataUrl` 里定义（前缀 + `download=1` 的拼法）：
// 组件里再抄一遍，就是又一处「改了接口前缀、漏了这个文件」的机会。
import { api } from '../api.js';
import { setPending, flashSuccess, isPending } from './toast.js';
// 编辑态的两句**语义文案**（过大禁用的说明 / 保存失败的就地说明）：它们逐字对齐实现语义，
// 故住在 messages.js（与删除确认同一纪律，两版逐字一致）。保存成功的文案在 main.js 那侧用
// （`textSavedNote`），因为它弹的是全局提示条。
import { editTooLargeText, textSaveFailedText } from '../messages.js';

// 本组件负责的快捷键（**只描述**，实现就在下面：对话框级的 `keydown` 派发 + 页脚按钮）：
// 帮助浮层（`shortcuts.js`）读这份描述来渲染，因此"帮助里写的"与"实际绑的"不会漂移。
export const PREVIEW_SHORTCUTS = [
  { keys: ['c'], label: '复制（文本或图片，按记录类型）' },
  { keys: ['d'], label: '下载' },
  { keys: ['e'], label: '编辑正文（仅文本记录，且不超过 1 MiB）' },
  { keys: ['Esc'], label: '关闭预览' },
];

export const EDIT_SHORTCUTS = [
  { keys: ['Ctrl', 'Enter'], label: '保存为新记录' },
  { keys: ['Esc'], label: '退出编辑，不保存' },
];

// 「编辑」的体积上限（UTF-8 字节），与 `src/ui/routes.ts` 的 `UI_TEXT_CREATE_MAX_BYTES` **必须一致**：
// 前端拦在按钮上（超了直接禁用 + 说明），服务端那一条是纵深防御。改一处就要改另一处。
const EDIT_MAX_BYTES = 1024 * 1024;

export function createPreview({ onCopy, onCopyImage, onDownload, onDownloadText, onEdit, onDelete, onPurge, onClose }) {
  const title = el('h2', { class: 'dialog__title', id: 'preview-title' });
  const meta = el('span', { class: 'dialog__meta' });
  // 类型徽标也放进标题行：同一句「内容」在不同类型下是完全不同的东西
  // （文本能复制、图片能存图、文件只能下载），徽标让"我现在看的是什么"不必靠猜测。
  const typeChipLabel = el('span');
  const typeChip = el('span', { class: 'chip' }, [el('span', { class: 'chip__dot' }), typeChipLabel]);
  // `tabindex="-1"`：正文框是**可聚焦的滚动容器**（2026-09-22 用户要求）—— 打开预览/退出编辑后
  // 焦点落在它上面，于是鼠标滚轮与键盘（↑↓ / PageUp·Down / Space）都能直接滚正文，
  // 不必先去够滚动条。`-1` 只给**程序化**聚焦，不进 Tab 顺序（Tab 仍然先到页脚那几个按钮），
  // 这与 WAI-ARIA 对"可滚动区域应可聚焦"的建议同向。
  const body = el('div', { class: 'dialog__body', tabindex: '-1' });
  const footer = el('div', { class: 'dialog__foot' });
  // 编辑保存失败的就地错误盒（挂在 textarea 下面，`role="alert"` —— 与确认框、登录页同一套
  // `.alert--error`；`components.md` 的 error 格要求"信息挨着控件、被 `aria-describedby` 关联、
  // 不靠颜色单独传达"）。textarea 静态指向它（与 `info.js` 的保留策略表单同一手法）：文案为空时
  // 它仍是 `hidden`，读屏不会念一个空描述。
  const editError = el('p', {
    class: 'alert--error',
    id: 'preview-edit-error',
    role: 'alert',
    hidden: true,
  });
  // ✕ 与点背景都要过这一道：**保存途中不许关框**（与 `confirm.js` 的 F2 同一条理由）——
  // 这一刻关掉，失败就会落在已经关掉的框里（提示条在顶层对话框**之下**，实测 `elementFromPoint`
  // 在提示条自己的中心返回的是 `dialog`），用户只看到"点了保存、什么都没发生"。
  const requestClose = () => {
    if (saving) return;
    dialog.close();
  };
  const closeButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '关闭预览',
      onclick: () => requestClose(),
    },
    [svg(iconPaths('close'))],
  );

  // 保存成功的反馈**不在这里**：走全局那一条真提示条（`toast.js` 的 `createToasts`，由动作的
  // 拥有者 `main.js` 的 `createTextRecord` 弹），因此本组件不再自己造一条"长得像提示条"的东西。

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
  // 点背景关闭（点击落在 dialog 自身而不是其内容上时）。保存途中的点背景与 ✕ 一样被挡（见 requestClose）。
  // **编辑态不关框**（2026-09-22 用户要求）：编辑框里可能是一段没保存的长文，而"点外面关掉浮层"
  // 是用户对浮层最自觉的一次尝试 —— 越自觉越容易误触，误触的代价是整段正文。与 ADR D30 的 Q4
  // （编辑态 Esc 只退编辑、不关框）同一条精神：退出编辑的**显式**入口只有「取消」与 Esc。
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && !editing) requestClose();
  });

  // 滚轮落在**页眉 / 页脚**上时转给正文（2026-09-22 用户实测报的）：
  // 用户点完「编辑」（或「预览」）之后指针还停在那个按钮上，那一刻滚轮本该滚正文，但页脚自己不可滚、
  // 模态又把背后页面压着 —— 观感就是"滚不动"。判据只有一条：**指针不在正文区**才接管；
  // 落在正文上时一律让浏览器自己处理（编辑态里正文就是 `<textarea>`，它自己会滚）。
  // 不拦的情况：当前滚动容器没有可滚内容（短文本）——那时连 `preventDefault` 都不做，
  // 免得把"本来就无处可滚"变成一次被吞掉的滚轮。
  dialog.addEventListener(
    'wheel',
    (event) => {
      if (event.target instanceof Element && event.target.closest('.dialog__body') !== null) return;
      const target = scrollTarget();
      if (target === null || target.scrollHeight <= target.clientHeight + 1) return;
      // `deltaMode`：0 = 像素（触控板/多数鼠标）、1 = 行、2 = 页。不换算的话行模式下
      // 一次滚轮只走 3px，读起来还是"滚不动"。
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientHeight : 1;
      target.scrollTop += event.deltaY * unit;
      event.preventDefault();
    },
    { passive: false },
  );
  // Esc：**编辑态下只退出编辑、不关对话框**（2026-09-22，ADR D30 的 Q4）—— 一段几千字的编辑
  // 不该被一个 Esc 丢掉。`cancel` 是可取消事件，`preventDefault()` 就能拦住 UA 的关框行为
  // （与 `confirm.js` 在途挡 Esc 是同一个手法）；非编辑态保持原样（Esc 关框）。
  dialog.addEventListener('cancel', (event) => {
    if (!editing) return;
    event.preventDefault();
    exitEdit();
  });
  // Ctrl/⌘ + Enter = 保存（编辑态；2026-09-22 用户要求"保存和取消合理设置快捷键"）。
  // 为什么不是 Ctrl+S：那是浏览器自己的"保存网页"，要抢就得拦默认行为；而 Ctrl+Enter 在多行
  // 编辑器里就是"提交/应用"的通用键，且与"Enter 换行"不冲突（换行是用户在正文里的正常操作，
  // 绝不能拿 Enter 当保存）。
  // `isComposing`：中日文输入法组字期间 Enter 是"上屏"，那一下不是保存。
  // 用 `event.key` 而非 `code`：小键盘 Enter 的 code 是 NumpadEnter，key 才是 'Enter'。
  dialog.addEventListener('keydown', (event) => {
    if (!editing || saving) return;
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    activeSave?.();
  });
  // 预览框自己的键：`c` 复制 / `d` 下载 / `e` 编辑。做法是**找到并点击对应页脚按钮**，
  // 而不是另写一套动作 —— 按钮那侧已经带着"无数据时隐藏、超限时禁用并说明原因、在途时挡重复点击"
  // 这些判据，抄一份必然会分叉。`e` 因此在文本过大时自然变成"按了没反应"（按钮是 disabled 的，
  // 而它的 hover 提示写着为什么）。
  // 列表页那条派发器见到 `dialog[open]` 会退出（见 main.js 的 installShortcuts），两边不重叠。
  dialog.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (editing) return; // 编辑态只有保存/取消两个键（见上面的 Ctrl+Enter 与 `cancel` 分支）
    const label = { c: '复制', d: '下载', e: '编辑' }[event.key];
    if (label === undefined) return;
    const button = [...footer.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').trim().startsWith(label),
    );
    if (!button || button.disabled || isPending(button)) return;
    event.preventDefault();
    button.click();
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
        replaceOwn(body);
        replaceOwn(footer);
        return;
      }
      discardFrame = requestAnimationFrame(tick);
    };
    discardFrame = requestAnimationFrame(tick);
  }

  // 重建正文/页脚：**只清本组件自己放进去的节点**。
  //
  // 为什么不能直接 `replaceChildren`：有对话框开着时，提示条宿主 `#toasts` 会**暂住在页脚里**
  // （`toast.js` 的 `dockHost` —— 模态在 top layer，宿主留在 body 下就既被压暗又点不动）。
  // 整块 `replaceChildren` 会把它连同正在显示的提示一起从 DOM 摘掉 —— 那不只是少一条提示，
  // 而是把**全局提示系统**摘下来：此后所有提示都写进游离节点，永远看不见（2026-09-22 用户实测
  // "已保存为新记录的 toast 为什么不会消失"就是这条：宿主被摘掉后提示留在游离树里）。
  // 判据是"不是本组件放的都留着"—— 目前唯一的外部节点就是 `#toasts`。
  function replaceOwn(node, ...children) {
    for (const child of [...node.children]) {
      if (child.id !== 'toasts') child.remove();
    }
    node.append(...children);
  }

  // 对话框里的操作按钮：与行内按钮同一套反馈（进行中 → 结果留在按钮上）。
  // `disabled` / `title` 与 `list.js` 的同类按钮同义：**禁用必须带原因**（title 是"为什么点不动"
  // 唯一的传达通道，见 components.css 里 `.btn[disabled]` 的注释）。
  function actionButton({ icon, label, run, successLabel, disabled = false, title: titleText = null, className = 'btn' }) {
    const button = el(
      'button',
      {
        class: className,
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
  //   · Q3(c) 保存后**不关框**：正文换成刚保存的那段、由调用方弹一条「已保存为新记录」提示条，
  //           复制/下载都跟着屏幕上的这段走（见 `currentText` 的用法）；
  //   · Q4    等宽 textarea；**Esc = 退出编辑（不关对话框）**；> 1 MiB 不给编辑；允许改空；
  //           内容没变就保存 = 什么都不发。
  let currentItem = null;
  // 屏幕上这段正文。它是**编辑保存后就地替换**的那份，也是复制/下载的唯一来源 ——
  // 这样"屏幕上是什么、复制/下载就是什么"，不会出现"刚存完却复制到旧文本"的坑。
  let currentText = '';
  let editing = false;
  let saving = false; // 保存请求在途：挡住关框（见 requestClose）
  // 本次编辑会话的保存动作。按钮点击与 Ctrl/⌘+Enter 走**同一个函数**（在 `enterEdit` 里登记、
  // `exitEdit` 里清空）—— 两条入口各写一份，迟早出现"快捷键保存的东西和按钮不一样"。
  let activeSave = null;

  // 当前"该被滚动的那个元素"：编辑态是 `<textarea>`（正文框里只有它，正文框自己不滚），
  // 其余是正文框本身。给滚轮转发用（见 dialog 的 `wheel` 监听）。
  function scrollTarget() {
    if (editing) return body.querySelector('.dialog__edit') ?? body;
    return body;
  }

  // 头部（标题 / 类型徽标 / 「N 个字符 · 时间」）的**唯一绘制点**：`open()` 与"保存成功后改指向新记录"
  // 两处调它，别在别处散写 `title` / `meta`。
  //
  // 字符数**用服务端给的 `size`**，而不是本地按屏幕上那段算：两条理由 ——
  //   ① 口径统一：列表、头部、提示条讲的都是"这条记录多大"（服务端 `dto.text.length`，UTF-16 码元），
  //      同屏两个口径的数字（例如正文里 10 个 emoji：本地 `charCount` 说 10、服务端说 20）会互相打脸；
  //   ② 成本：`charCount` 走 `Intl.Segmenter`，实测 1.1 MB 的正文要 **169ms**（Node 24，本机），
  //      而重新打开一条大文本预览本来就要一次往返 —— 不该再叠一次百毫秒级的主线程计算。
  // 这不是新决定：`docs/archive/AUDIT-v1-v2-divergence.md` §12.2 早就把"V1 预览里的「N 个字符」
  // 读服务端 `size`、**有意不改**"记成了结论（那条与 V2 的口径分歧因此是有记录的）。
  // 2026-09-22 起"已保存为新记录（N 个字符）"那条提示条也取同一个数（服务端的 `size`），
  // 于是同一屏上不会出现两个不同的字符数。
  function renderHead(item) {
    title.textContent = item.type === 'Text' ? '文本内容' : (item.dataName ?? item.type);
    typeChip.className = `chip ${typeChipClass(item.type)}`;
    typeChipLabel.textContent = typeLabel(item.type);
    // 深链接会先开壳（那时只知道类型与 hash，见 `main.js` 的 `openDeepLink`）——
    // 缺字段就**不写**副信息：写「0 个字符」或「undefined」都是假话，而空着只是"还没到"。
    const sizeText =
      item.size === undefined
        ? ''
        : item.type === 'Text'
          ? `${Number(item.size) || 0} 个字符`
          : formatSize(item.size);
    const timeText = item.createTime ? formatAbsolute(item.createTime) : '';
    meta.textContent = [sizeText, timeText].filter(Boolean).join(' · ');
  }

  function renderView() {
    body.className = 'dialog__body';
    replaceOwn(body, renderText(currentText));
  }

  function renderViewActions() {
    const item = currentItem;
    const primary = [];
    // 页脚最左那枚是**销毁性的视图级动作**（2026-09-22 用户指定：位置就是原来「编辑」占的最左处，
    // 钉在页脚左缘）：活跃记录给「移动到回收站」（30 天内可恢复），回收站里的记录给「彻底删除」
    // （不可撤销）—— 后者与行内槽 4 是同一个动作、同一句确认文案（`purgeConfirmSpec`）。
    // 两档都在同一位置：切换视图不会让"最左那枚"变成另一个动词而位置不变，读起来是一致的。
    const destructive =
      item.isDeleted === true
        ? actionButton({
            icon: 'trash',
            label: '彻底删除',
            className: 'btn btn--danger-solid',
            run: () => onPurge(item),
            title: '彻底删除这条记录（不可撤销，数据文件一并清除）',
          })
        : actionButton({
            icon: 'trash',
            label: '移动到回收站',
            className: 'btn btn--danger-solid',
            run: () => onDelete(item),
            title: '移动到回收站（30 天内可以从回收站恢复）',
          });
    if (item.type === 'Text') {
      // 编辑（2026-09-22，ADR D30）：它原本在最左；2026-09-22 起「移动到回收站」占了最左那一位，
      // 编辑退到第二位（用户指定：位置就是原来「编辑」占的最左处）。右侧是既有的复制/下载。
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
            : '编辑这段文本（保存成一条新记录，当前剪贴板不受影响）（e）',
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
          title: '复制这段文本（c）',
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
          title: `${item.hasData ? '下载这条记录的数据文件' : '把这段正文存成 .txt'}（d）`,
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
            title: '复制这张图片（c）',
          }),
        );
      }
      primary.push(
        actionButton({
          icon: 'download',
          label: '下载',
          run: () => onDownload(item),
          successLabel: '已下载',
          title: '下载这条记录（d）',
        }),
      );
    }
    // 组装顺序 = 视觉顺序（用户 2026-09-22 用截图定的形）：**视图级那枚销毁性动作钉在页脚最左边缘**，
    // 其余动作仍靠右 —— `[移动到回收站|彻底删除] [spacer] [编辑] [复制文本] [下载文本]`。
    // 判据是 spacer 的位置：`.dialog__foot-spacer` 是 `flex: 1 1 auto`（components.css），
    // 它把**排在它后面**的东西推到右边 ⇒ 把销毁性那枚放在 spacer 之前，它就贴在左缘。
    replaceOwn(footer, destructive, el('span', { class: 'dialog__foot-spacer' }), ...primary);
    // 初始焦点落在**正文框**上（2026-09-22 用户要求）：滚轮与键盘立刻能滚这段内容。
    // 此前它落在页脚第一枚动作上（那还是"编辑"时留下的巧合），而正文框当时根本不可聚焦 ——
    // 鼠标停在正文上滚是能滚的，但键盘没有任何落点。
    // `preventScroll`：聚焦本身不该让浏览器把对话框滚进视口（那是打开动作的事，不是焦点的事）。
    body.focus({ preventScroll: true });
  }

  // ===== 编辑框的高度：与正文区**同一套规则**（用户 2026-09-22 两问）=====
  //
  //   · 「编辑页面和预览页面为什么高度不同差别那么大 为什么不复用一下」——此前是两套规则：
  //     正文区 = 内容高度、封顶 `min(64vh, 620px)`；编辑框 = 写死 `40vh`（ADR D31 的"理想高度"）。
  //     实测 11 000 字符记录（1440×900）：正文区 576px ⇒ 编辑框 360px，对话框 724 → 508px。
  //   · 「短文本上编辑的时候可以随着文字的输入高度升高」——所以高度还得跟着内容长。
  //
  // 于是：**进编辑时取正文区此刻的高度**（`previewBodyHeight`，短文本就是内容高度 ⇒ 两态同高），
  // 之后每次输入重算、封顶与正文区同一个值（长文本两态同高，都在上限）。
  // ⚠️ 顶到上限后**不再量**：`style.height='auto'` + 读 `scrollHeight` 每按键一次的代价实测
  // 200 字符 0.1ms / 20 000 字符 ~2ms / **500 000 字符 ~60ms**（那就是按键卡顿）。
  // 顶到上限时高度已经定了（内部滚动接管），故用"上次设的高度是否已达上限"当判据 —— 不去读布局。
  // 顶到上限后的短路有个副作用（删短了不缩），**由 scheduleRefit 补上**：停止输入 200ms 后重量一次。
  let editorAtCap = false;
  // 顶到上限之后的**重量定时器**：见 scheduleRefit
  let refitTimer = 0;

  function editorCap() {
    // 与 `.dialog__body` 的 `max-height: min(64vh, 620px)` 同一个值（改一处要改两处）
    return Math.min(Math.round(window.innerHeight * 0.64), 620);
  }

  function fitEditor(area, cap) {
    if (editorAtCap) return;
    area.style.height = 'auto';
    const next = Math.min(area.scrollHeight, cap);
    area.style.height = `${next}px`;
    editorAtCap = next >= cap;
  }

  // 顶到上限之后再重量一次（**延后到停止输入之后**）：`editorAtCap` 的短路是为了不每次按键都付排版钱
  // （实测 500 KB ≈ 60ms/次），但它会让"把长文删短到能放下"时框不肯缩回去 —— 用户 2026-09-22 明确否掉
  // 了这个代价（"如果是长文本删减文字，框高不会对应减小，这种问题你居然没有考虑到"）。
  // 于是：删到能放下时，停止输入 200ms 后重量一次并缩回去；连打时这个定时器被反复重置，不会触发。
  function scheduleRefit(area, cap) {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      refitTimer = 0;
      if (!editing || !area.isConnected) return;
      editorAtCap = false; // 允许重量（若内容仍然超出上限，fitEditor 会再次把它设回上限）
      fitEditor(area, cap);
    }, 200);
  }

  function enterEdit() {
    // 初始高度 = **正文区此刻的高度**（两态同高，见上面那一段）；正文区已经在滚动（内容比它高）
    // 说明是长文本 ⇒ 直接取上限，既与正文区同高、又不必为量它的内容付一次排版（实测 1 MB ≈ 87ms）。
    const cap = editorCap();
    const previewBodyHeight = Math.round(body.getBoundingClientRect().height);
    const previewScrollable = body.scrollHeight > body.clientHeight + 1;
    editorAtCap = previewScrollable;
    editing = true;
    const area = el('textarea', {
      class: 'dialog__edit',
      spellcheck: 'false',
      // 可访问名与可见按钮同源（"编辑"这个动作的对象就是这段正文）；
      // 失败说明**静态关联**到这个框（与 `info.js` 那两个数字输入框同一手法：目标节点常驻、
      // 无错时是 `hidden`，故不会有空描述被念出来）。
      'aria-label': '编辑这段文本',
      'aria-describedby': 'preview-edit-error',
      // `style` 必须是**对象**：`el()` 走 `Object.assign(node.style, value)`，传字符串会去设
      // `style[0]`/`style[1]`…（CSSStyleDeclaration 的索引属性只读）⇒ 严格模式下直接抛
      // `TypeError: Failed to set an indexed property`，整段 `enterEdit()` 就此中断（实测踩到过）。
      style: { height: `${previewScrollable ? cap : previewBodyHeight}px` },
    });
    area.value = currentText;
    body.className = 'dialog__body dialog__body--edit';
    replaceOwn(body, area, editError);

    // 两枚按钮的 hover 提示就是各自的**快捷键**（2026-09-22 用户要求"hover 显示对应的快捷键"）：
    // 用原生 `title`（与页脚其余动作、行内槽位同一套提示通道，见 actionButton 的说明），
    // 另加 `aria-keyshortcuts` 让读屏也能报出按键。取消那枚不写"不保存"以外的语义 ——
    // 它**只**退出编辑，改动留在记录里（编辑的是本地副本）。
    const cancel = el(
      'button',
      {
        class: 'btn',
        type: 'button',
        title: '退出编辑，不保存改动（Esc）',
        'aria-keyshortcuts': 'Escape',
        onclick: () => exitEdit(),
      },
      [el('span', { class: 'btn__label', text: '取消' })],
    );
    const save = el(
      'button',
      {
        class: 'btn btn--primary',
        type: 'button',
        title: '保存为新记录（Ctrl/⌘ + Enter）',
        'aria-keyshortcuts': 'Control+Enter Meta+Enter',
      },
      [el('span', { class: 'btn__label', text: '保存' })],
    );
    const saveEdit = async () => {
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
      // `aria-invalid` 不是"曾经错过"的历史记录：每次重试先清掉（`info.js` 的保留策略表单同一条）
      area.removeAttribute('aria-invalid');
      saving = true;
      setPending(save, true);
      closeButton.disabled = true; // 在途不许关框：提示条压在这个模态之下，关掉就等于把失败丢在屏幕外
      try {
        // `onEdit` 保证回传刚创建的那条记录（形状不对时 `api.createText` 已经抛了），
        // 故这里不写"万一是别的形状"的兼容分支 —— 那样只会把一个猜出来的状态画到屏幕上。
        const created = await onEdit(currentItem, next);
        currentText = next;
        // 对话框**改指向刚创建的那条**：头部（字符数 / 时间）与后续的「编辑」「复制文本」「下载文本」
        // 从此描述的都是屏幕上这段 —— 不改的话会出现"头说旧记录的字符数、正文是新文本"的自相矛盾。
        currentItem = created;
        renderHead(created);
        // 保存成功的提示由 `main.js` 的 `createTextRecord` 弹（真提示条，见 `toast.js` 的 dockHost）
        exitEdit();
      } catch (error) {
        // 就地报错（挨着控件、被 `aria-describedby` 关联），**留在编辑态**：用户改的内容还在，可以再存一次。
        editError.textContent = textSaveFailedText(error?.message ?? '未知错误');
        editError.hidden = false;
        // 只有"这段正文本身不合规"（服务端 400：超限）才标字段错；网络/500 不是字段的问题，
        // 标了 `aria-invalid` 会让读屏说"这个输入框有误"（`docs/ui.md` §3.3 第 19 条同一条判据）。
        if (error?.status === 400) area.setAttribute('aria-invalid', 'true');
        area.focus();
      } finally {
        saving = false;
        closeButton.disabled = false;
        setPending(save, false);
      }
    };
    save.addEventListener('click', saveEdit);
    activeSave = saveEdit; // Ctrl/⌘+Enter 走的也是这一个
    replaceOwn(footer, el('span', { class: 'dialog__foot-spacer' }), cancel, save);

    if (!dialog.open) dialog.showModal();
    // **焦点立刻给，但"光标落到末尾"放到第一帧画完之后**（2026-09-22 用户实测："编辑打开之后
    // 需要等待一下，长文本明显"）。实测这条链上唯一贵的是"把光标滚进视口"：
    //   `textarea.focus()` 1 MB = 144ms / 500 KB = 83ms / 100 KB = 12.6ms（本机无节流；6× 节流下是秒级），
    //   而 `focus({ preventScroll: true })` 三个量级都是 **0ms** —— 它逼浏览器为定位光标把整段文本
    //   排版一次。同步付这笔钱会把"画编辑框"推迟到它之后 ⇒ 用户看到的是"点了编辑、等一会才出现"。
    // 于是：先 `preventScroll` 聚焦（免费，键盘立刻可用），再在下一帧把光标放到末尾并滚到末尾。
    area.focus({ preventScroll: true });
    // 用户**动过光标/打过字**的旗子：延迟那一步绝不能抢他已经放好的光标。
    // ⚠️ 判据不能用"selection 是不是 0/0"：聚焦一个从未聚焦过的 textarea，浏览器**默认就把光标放在
    // 末尾**（实测 `selSync = [10240, 10240]`）—— 用它当判据会让延迟那一步永远被跳过，
    // 于是"光标在末尾、视口却停在开头"（打字会突然跳到底部）。
    let caretTouched = false;
    const markTouched = () => {
      caretTouched = true;
      // 随输入长高；已经顶到上限时不再每次按键都量（那是 60ms/次的排版），改为**停止输入后**重量一次
      // —— 于是"删短了"也能缩回去（见 scheduleRefit）。
      if (editorAtCap) scheduleRefit(area, cap);
      else fitEditor(area, cap);
    };
    area.addEventListener('input', markTouched);
    area.addEventListener('keydown', markTouched);
    area.addEventListener('mousedown', markTouched);
    requestAnimationFrame(() => {
      // 再等一个宏任务：rAF 回调跑在**绘制之前**，直接在里面做这笔重活等于把它挪回关键路径。
      setTimeout(() => {
        if (!editing || !area.isConnected || caretTouched) return; // 退出编辑 / 关框 / 用户已动过
        area.setSelectionRange(area.value.length, area.value.length); // 光标落在末尾（原有行为）
        area.scrollTop = area.scrollHeight; // 与光标位置一致：打开就停在结尾
      }, 0);
    });
  }

  function exitEdit() {
    editing = false;
    activeSave = null; // 编辑会话结束：快捷键不再指向一个已经不存在的 textarea 上的闭包
    clearTimeout(refitTimer); // 离开编辑态：不再有"停止输入后重量"这回事（定时器会改一个已被移除的节点）
    refitTimer = 0;
    editError.hidden = true;
    editError.textContent = '';
    renderView();
    renderViewActions();
  }

  function open(item, { text = null, loading = false } = {}) {
    currentItem = item;
    currentText = text ?? item.text ?? '';
    editing = false;
    activeSave = null; // 同上：换记录时旧编辑会话的保存闭包必须失联
    renderHead(item);
    body.className = 'dialog__body';
    replaceOwn(body);
    replaceOwn(footer, el('span', { class: 'dialog__foot-spacer' }));

    // ⚠️ **先 `showModal()`，再画、再定焦点。** `showModal()` 自己会把焦点移到第一个可聚焦元素
    // （这里是右上角的 ✕），在它**之前**调 `focus()` 等于白调 —— 于是文件头那句"打开后焦点落在
    // 主操作上"此前只是注释里的愿望（2026-09-22 发布前审核实测：文本与图片预览的初始焦点都是 ✕）。
    if (!dialog.open) dialog.showModal();

    if (loading) {
      // 先开壳再填内容：长文本要一次额外的往返，这段时间不该是「点了没反应」。
      // 两条路都会走到这里：列表里被截断的记录、以及**深链接**（后者此刻连记录都还没有）。
      // 文案因此必须对两者都成立 —— 不能写"列表里显示的是截断预览"（深链接那条不成立）。
      body.append(
        el('div', { class: 'empty' }, [
          el('p', { class: 'empty__title', text: '正在读取全文…' }),
          el('p', { class: 'empty__hint', text: '正在取这条记录的完整内容。' }),
        ]),
      );
      // 加载态也把焦点交给**正文框**（2026-09-22 用户实测报的"焦点好像要等一会才对"）：
      // 此前这里落在 ✕ 上，等全文到了再跳到正文框 —— 用户看到的是"焦点过一会儿才到位"。
      // 现在从第一帧起就在正文框上（里面是「正在读取全文…」那段占位），全文到达后**不动焦点**
      // （`renderViewActions()` 再 focus 一次同一个节点，无观感差异）。
      // 短文本（不需要额外往返）走的是下面那条路，同样落在正文框。
      body.focus({ preventScroll: true });
      return;
    }

    if (item.type === 'Text') {
      renderView();
      renderViewActions(); // 里面把焦点交给正文框（可滚动）——必须发生在 showModal 之后
      body.scrollTop = 0; // 每次打开都从正文开头看起（正文框是常驻节点，上一条记录的滚动位置会留着）
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
    body.scrollTop = 0; // 同上：图片/不支持档也从头看起（滚动位置是常驻节点的残留状态）
  }

  return {
    open,
    // 程序化关闭也过 `requestClose()`：`#29` 把"保存途中不许关框"写成了硬约束
    // （那一刻关掉，失败会落在已经关掉的框里、提示条又在模态之下），而两个入口必须同一条规矩
    // —— 目前唯一的程序化调用方是 `main.js` 取全文失败时收壳（那时不在编辑态，不受影响）。
    close: () => requestClose(),
  };
}
