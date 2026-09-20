// 对话框基元：确认 / 预览 / 表单三种都建在它上面。
//
// 用原生 `<dialog>` + `showModal()`：焦点陷阱、Esc 关闭、`::backdrop`、惰性化背景都由平台提供。
//
// ⚠️ **结算不依赖 `close` 事件**（V1 实测踩过，写进了 docs/ui.md §3.3 第 4 条）：
// 主路径（确认 / 取消 / Esc）在**决定的当下**结算 Promise，`close` 只作旁路兜底。
// 依赖事件会让"事件不来即永不结算"——实测 headless Chromium 上 `dialog.close()` 之后
// `close` 事件就不派发，调用方 `await` 之后的收尾（提示、刷新）整段丢失。
import { el, svg, clear } from '../dom.js';
import { iconPaths } from '../icons.js';
import { labelButton } from './button.js';
import { setPending } from './toast.js';

/** 自动生成标题 id 用的序号（同一页里可以有多个对话框实例）。 */
let dialogSeq = 0;

/**
 * 建一个对话框外壳。返回的 `open()` 每次调用都重建内容，避免上一次的 DOM 残留。
 *
 * @param {{ title: string, sub?: string, body: (ctx) => Node, foot?: (ctx) => Node[],
 *           closeLabel?: string, onClose?: () => void, canClose?: () => boolean }} spec
 *   `canClose`（可选）：返回 false 时**所有"溜走"的路径都失效** —— ✕、取消、以及平台给的
 *   Esc。用于"已经发出去了的请求"在途期间：那三条路都只 disable 一个确认键，挡不住它们
 *   （见 `createConfirm` 的说明与 `docs/archive/AUDIT-v1-v2-divergence.md` §3.1）。
 */
export function createDialog(spec) {
  const canClose = () => spec.canClose?.() ?? true;
  // 标题的 id 是对话框可访问名的来源（见下面 `<dialog>` 的 `aria-labelledby`）。
  // 没传就自己生成一个：`aria-labelledby` 指向空值等于没有名字，而这正是要避免的。
  const titleId = spec.titleId ?? `dialog-title-${++dialogSeq}`;
  const title = el('h2', { class: 'dialog__title', id: titleId, text: spec.title });
  const sub = el('p', { class: 'dialog__sub', text: spec.sub ?? '', hidden: !spec.sub });
  const titles = el('div', { class: 'dialog__titles' }, [title, sub]);

  const closeBtn = el(
    'button',
    {
      class: 'icon-btn dialog__close',
      type: 'button',
      'aria-label': '关闭',
      title: '关闭',
      dataset: { icon: 'close' },
      // 走同一条守卫：在途时这个 ✕ 不算"取消"
      onclick: () => {
        if (!canClose()) return;
        dialog.close('dismiss');
      },
    },
    [svg(iconPaths('close'))],
  );

  const head = el('div', { class: 'dialog__head' }, [titles, closeBtn]);
  const body = el('div', { class: 'dialog__body' });
  const errorBox = el('p', { class: 'dialog__error', role: 'alert', hidden: true });
  const foot = el('div', { class: 'dialog__foot' });

  const inner = el('div', { class: 'dialog__inner' }, [head, errorBox, body, foot]);
  // 对话框必须有**可访问名**：`<dialog>` 用 `showModal()` 打开时，读屏会宣布"对话框"
  // 加上它的名字；没有名字就只说"对话框"，用户无法知道打开的是哪一个（实测：预览与确认框
  // 在无障碍树里完全同名）。名字取标题（`aria-labelledby`），标题随后可能被 `open()` 改写。
  const dialog = el('dialog', { class: 'dialog', 'aria-labelledby': title.id }, [inner]);
  document.body.append(dialog);

  const ctx = {
    dialog,
    body,
    foot,
    /**
     * 结算并关闭。主路径由**按钮处理器**调用它（而不是直接 `dialog.close()`）：
     * 结算的时机必须是"用户做了决定的那一刻"，不能等 `close` 事件。
     */
    close(value) {
      // 在途时不许从旁边溜走：结算成 `null/false` 会让调用方以为"用户取消了"，
      // 而那个请求其实正在（或已经）成功 —— 调用方的收尾全在 `if (!ok)` 之后。
      if (!canClose()) return;
      settle(value);
      dialog.close();
    },
    /** 就地显示错误（不把用户赶出对话框），并让焦点回到第一个可编辑元素。 */
    showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      const focusable = body.querySelector('input, textarea, select, button');
      focusable?.focus();
    },
    clearError() {
      errorBox.hidden = true;
      errorBox.textContent = '';
    },
  };

  let resolver = null;
  let settled = false;

  function settle(value) {
    if (settled) return;
    settled = true;
    resolver?.(value);
    resolver = null;
  }

  // 平台给的 Esc：`cancel` 事件是**可取消的**，在途时必须挡在这里 ——
  // 等 `close` 事件再拦就晚了（对话框已经关了，而结算已经发生）。
  dialog.addEventListener('cancel', (event) => {
    if (!canClose()) event.preventDefault();
  });

  // `close` 只作**旁路兜底**（例如用户按了 Esc、或平台自行关闭）。主路径已结算时它是空操作。
  dialog.addEventListener('close', () => {
    settle(null);
    spec.onClose?.();
    discardContent();
  });

  // 关闭之后丢弃正文 / 页脚 / 错误行。
  //
  // 为什么必须做：对话框是**启动期创建、常驻 `body`** 的节点 —— `createSheet` 那个尤其致命，
  // 它的 `content` 是整条记录的全文（单条上限见 `api.js` 的响应上限），`buttons` 里那些闭包
  // 又抓着 `item` / `full`。不清就只有"下次 `open()`"这一个释放点：用户不再预览第二条时，
  // 这段内容要到页面销毁才释放（`docs/archive/AUDIT-v1-v2-divergence.md` §4.2，V1 同一次改动）。
  // `errorBox` 一并清：`open()` 只把它 `hidden`、正文留着，而那是**一条服务端错误信息**。
  //
  // ⚠️ **不能**在 `close` 里立刻清：`.dialog` 有退出过渡（`overlay-v2.css` 的 `@starting-style`
  // + `transition-behavior: allow-discrete`，`--dur-base` = 0.2s）。这一刻清掉，用户看到的是
  // 「框还在淡出、字先没了」，而且内容一撤、框的高度也会跟着跳。
  // ⇒ 判据交给浏览器自己：轮询到 `display` 变回 `none`（= 退出过渡真的跑完）再清。
  //   减弱动效、或浏览器不支持 `allow-discrete` 时根本没有过渡，第一帧就是 `none`
  //   ⇒ 立即清，同样不会闪。
  // 实测（1440×900，`test/manual/probe.mjs` 的 `PRVCLOSE`）：点「关闭」之后 `display: block`
  // 一直持续到 ~250ms 才变 `none`，正文在这之前始终可见。
  let discardFrame = null;
  function discardContent() {
    if (discardFrame !== null) return; // 已经在等退出过渡了
    const started = performance.now();
    const tick = () => {
      discardFrame = null;
      // 等待期间又被打开（连续预览两条）：本轮作废，下一次 `close` 会重新排。
      if (dialog.open) return;
      // 1s 只是**兜底**（不是设计值）：标签页进后台时 `requestAnimationFrame` 会被饿死，
      // 那也不能让正文永远留在 DOM 里。
      if (getComputedStyle(dialog).display === 'none' || performance.now() - started > 1000) {
        clear(body);
        clear(foot);
        errorBox.textContent = '';
        errorBox.hidden = true;
        return;
      }
      discardFrame = requestAnimationFrame(tick);
    };
    discardFrame = requestAnimationFrame(tick);
  }

  return {
    ctx,
    node: dialog,

    /**
     * 打开并等待结算。`body` / `foot` 每次打开都重建 —— 上一次的输入、错误、按钮状态
     * 都不该泄漏到这一次。
     *
     * ⚠️ **正文与页脚都属于"这一次调用"**（2026-09-16 线上截图走查抓到的两个真缺陷）：
     * 原来只有 `content` 能被覆盖，页脚固定取 `spec.foot(ctx)`，于是
     *   · `createConfirm.ask()` 先把说明文字 append 进 body、`createSheet.open()` 先把动作按钮
     *     prepend 进 foot，**随后这里 `clear(body)`/`clear(foot)` 把它们全冲掉**
     *     ⇒ 删除确认框只剩标题（"将删除「…」，不可恢复"那段说明看不到）、
     *       预览框只剩「关闭」（复制内容/下载 按钮消失）。
     * 修法不是"再补一次 append"，而是**让调用方通过参数交付内容**，一处拥有、一处清理：
     *   `content` 覆盖正文；`buttons` 是追加在基础按钮**之前**的动作按钮（「关闭」永远在最后）。
     * 调用方只给数据，不再预操作 DOM —— 预操作一个"马上会被 clear 的节点"就是上面那两个缺陷的形态。
     *
     * @param {{ content?: Node, buttons?: Node[] }} [override]
     */
    open(override = {}) {
      // 已经开着就直接返回：双击一行会连发两次预览，而这里只有**一个**模块级的 `resolver` ——
      // 第二次调用会把它覆盖掉，第一个 `open()` 的 Promise 从此永不结算（调用方正 await 它做收尾）。
      if (dialog.open) return Promise.resolve(null);

      settled = false;
      errorBox.hidden = true;
      clear(body);
      clear(foot);

      body.append(override.content ?? spec.body(ctx));
      for (const button of override.buttons ?? []) foot.append(button);
      for (const button of spec.foot ? spec.foot(ctx) : []) foot.append(button);

      dialog.showModal();
      // 焦点：`[data-autofocus]` 优先（销毁性确认框用它把焦点放在**取消**上 —— 键盘用户的 Enter
      // 应当是安全的选择），其次主操作 / 危险操作，最后才退到正文里的第一个可编辑元素。
      // ⚠️ 此前只找 `.btn--primary`，而确认框的确认键是 `.btn--danger`、正文里又只有一个 `<p>` ——
      // 结果**谁都没被聚焦**（焦点按浏览器默认留在头部的关闭键上），与"焦点落在主操作上"这句注释相反。
      (
        foot.querySelector('[data-autofocus]') ??
        foot.querySelector('.btn--primary, .btn--danger') ??
        body.querySelector('input, textarea, button')
      )?.focus();

      return new Promise((resolve) => {
        resolver = resolve;
      });
    },

    /** 由 `foot` 里的按钮调用：结算并关闭。 */
    close(value) {
      // 在途时不许从旁边溜走：结算成 `null/false` 会让调用方以为"用户取消了"，
      // 而那个请求其实正在（或已经）成功 —— 调用方的收尾全在 `if (!ok)` 之后。
      if (!canClose()) return;
      settle(value);
      dialog.close();
    },
  };
}

/**
 * 确认对话框（销毁性操作前问一句）。返回 `true` 表示用户确认。
 *
 * 两个行为细节都是必须的（V1 的约定，原样保留）：
 *   1. **请求在对话框内完成**：确认后按钮转圈、失败就地显示原因可重试，
 *      而不是关闭对话框再飘一个错误——那会逼用户重新走一遍确认。
 *   2. 销毁性操作的主按钮用 `btn--danger`，与"取消"在颜色上分开
 *      （键盘用户还要靠 Tab 顺序：取消在前、确认在后，避免误按回车毁数据）。
 */
export function createConfirm() {
  let action = null;
  let confirmLabel = '确认删除';
  // 「有请求在飞」的旗子：`setPending(confirm, true)` 只 disable 了**确认键**，
  // 而 ✕ / 取消 / Esc 三条路都还能把对话框关掉（见 `foot` 里的说明）。
  let busy = false;

  const dialog = createDialog({
    title: '确认操作',
    body: () => el('div'),
    // 在途期间不许溜走：只要 `busy`，✕ / 取消 / Esc 全部失效（`createDialog` 的 `canClose`）
    canClose: () => !busy,
    // 取消在前、确认在后，且**初始焦点落在取消上**：销毁性操作里 Enter 的默认结果应当是安全的那个
    // （V1 的 `confirm.js` 是同一套约定：原生 dialog 会把焦点给第一个可聚焦元素，也就是右上角的关闭键）。
    foot: (ctx) => {
      const cancel = el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: '取消',
        'data-autofocus': '',
        onclick: () => ctx.close(false),
      });
      const confirm = el('button', {
        class: 'btn btn--danger',
        type: 'button',
        text: confirmLabel,
        async onclick() {
          if (!action) return ctx.close(true);
          ctx.clearError();
          // `setPending` = `data-loading`（转圈）+ `aria-busy` + `disabled`（挡住连点）——
          // 与这一处原来的三个动作完全一致，只是不再各处手写。
          setPending(confirm, true);
          // **整个在途期间把"取消"那三条路也关掉**（2026-09-18 修）：它们此前仍然可用，
          // 于是用户按 Esc / 点 ✕ / 点取消时 `ask()` 结算成 `false`，而请求其实成功了 ——
          // 调用方的收行、清选择集、刷新全写在 `if (!ok)` 之后，界面因此把"已经删掉"当作
          // "没删"，要等 ≤10 秒的轮询才无声消失（批量删除时还继续写着"已选 N 条"）。
          // 见 `docs/archive/AUDIT-v1-v2-divergence.md` §3.1。
          busy = true;
          try {
            await action();
            busy = false;
            ctx.close(true);
          } catch (error) {
            // 失败留在原地：原因写在对话框里，用户可以重试或取消（故这里放开 `busy`）
            busy = false;
            ctx.showError(error?.message ?? String(error));
          } finally {
            setPending(confirm, false);
          }
        },
      });
      return [cancel, confirm];
    },
  });

  return {
    /**
     * @param {{ title: string, message: string, confirmLabel?: string,
     *           action?: () => Promise<unknown> }} spec
     * @returns {Promise<boolean>}
     */
    async ask(spec) {
      if (dialog.node.open) return false;
      const head = dialog.node.querySelector('.dialog__title');
      if (head) head.textContent = spec.title;
      confirmLabel = spec.confirmLabel ?? '确认删除';

      action = spec.action ?? null;
      // 说明文字作为 `content` **交给 open()**，而不是先 append 进 body ——
      // `open()` 会 `clear(body)`，先塞进去的东西必然被冲掉（实测：确认框只剩标题，
      // "将删除「…」，不可恢复"整段不见，而这正是用户判断要不要删的唯一依据）。
      const result = await dialog.open({
        content: el('div', {}, [el('p', { class: 'note', text: spec.message })]),
      });
      action = null;
      return result === true;
    },
  };
}

/**
 * 预览 / 只读信息对话框。
 * 与确认框的区别：它**没有**主操作按钮（内容本身就是目的），只有「关闭」。
 *
 * @param {{ onClose?: () => void }} [hooks]
 *   `onClose` 在对话框关闭时调用 —— 调用方用它做收尾（例如清掉深链接的 hash）。
 */
export function createSheet(hooks = {}) {
  const dialog = createDialog({
    title: '预览',
    body: () => el('div'),
    foot: () => [
      el('button', {
        class: 'btn',
        type: 'button',
        text: '关闭',
        // 走返回对象的 `close()`（它负责结算 Promise）。
        // **不能**写成 `ctx.dialog.close(...)`：`ctx.dialog` 是那个 `<dialog>` DOM 元素，
        // 它的 `close()` 只会让 `close` 事件负责结算，主路径就绕开了。
        onclick: () => sheet.close(null),
      }),
    ],
    onClose: hooks.onClose,
  });

  const sheet = {
    /**
     * @param {{ title: string, sub?: string, content: Node,
     *           actions?: Array<{ label: string, icon?: string, primary?: boolean,
     *                             run: (ctx: object) => Promise<boolean> }> }} spec
     *        `run` 返回 `true` 才算做成（与全局约定一致：actions 返回结果，组件呈现结果）。
     * @returns {Promise<unknown>}
     */
    open(spec) {
      if (dialog.node.open) return Promise.resolve(null);
      const title = dialog.node.querySelector('.dialog__title');
      const sub = dialog.node.querySelector('.dialog__sub');
      if (title) title.textContent = spec.title;
      if (sub) {
        sub.textContent = spec.sub ?? '';
        sub.hidden = !spec.sub;
      }

      // 动作按钮**作为参数交给 open()**，不再先 prepend 进 foot ——
      // 那样做会被 `open()` 的 `clear(foot)` 冲掉（实测：预览框只剩「关闭」，
      // text 记录的「复制内容」与图片记录的「下载」全部消失）。
      // 顺序：动作在前、「关闭」在后（由 `createDialog` 的 `spec.foot` 提供）。
      const buttons = (spec.actions ?? []).map((action) =>
        labelButton({
          label: action.label,
          icon: action.icon ?? null,
          iconSize: 15,
          className: `btn${action.primary ? ' btn--primary' : ''}`,
          async onClick(button) {
            // 进行中的状态统一走 `setPending`（`data-loading` 转圈 + `aria-busy`）
            if (button.hasAttribute('data-loading')) return;
            setPending(button, true);
            try {
              await action.run(dialog.ctx);
            } catch (error) {
              dialog.ctx.showError(error?.message ?? '操作失败，请重试。');
            } finally {
              setPending(button, false);
            }
          },
        }),
      );

      // **把内容与按钮一起传下去**（而不是让 `createDialog` 用它自己那个空占位 div）：
      // 预览的内容每次调用都不同，`spec.body` 这个建对话框时就固定的函数承担不了。
      return dialog.open({ content: spec.content, buttons });
    },

    get isOpen() { return dialog.node.open; },

    updateContent(content, subtitle) {
      if (!dialog.node.open) return;
      dialog.ctx.body.replaceChildren(content);
      const sub = dialog.node.querySelector('.dialog__sub');
      sub.textContent = subtitle ?? '';
      sub.hidden = !subtitle;
    },

    /** 关闭并结算（供外部动作调用，例如"下载并关闭"）。 */
    close: (value) => dialog.close(value),
  };

  return sheet;
}
