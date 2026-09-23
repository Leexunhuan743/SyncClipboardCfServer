// 反馈层：瞬时提示条 + **原地**状态（进行中 / 成功）。
//
// 为什么成功反馈必须留在原地：一闪而过的提示等于没有确认。用户按下的是**那个按钮**，
// 结果就该出现在那个按钮上（组件状态矩阵的 loading / success 两栏），且不受列表刷新影响。
// 提示条只承载需要解释、或跨控件的反馈：错误、降级、后台发生的变化。
//
// 两个原地状态都只改 `data-*` 与标签文本，外观交给 CSS：
//   data-loading="true" → 标签/图标让位给转圈（`.btn` 与 `.icon-btn` 同一套规则）
//   data-state="ok"     → 换成对勾 + 结果文案，ms 后自动还原
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';

const MAX_TOASTS = 4;
const LEAVE_MS = 200;

export function createToasts(container) {
  function dismiss(node) {
    if (!node || !node.isConnected || node.dataset.leaving === 'true') return;
    node.dataset.leaving = 'true';
    setTimeout(() => node.remove(), LEAVE_MS);
  }

  // 模态对话框进的是 **top layer**：宿主留在 body 下时，提示条既被半透明 backdrop 压暗、又**完全
  // 收不到点击**（2026-09-22 实测：宿主在 body 下点提示条中心，命中的是 `dialog`）。
  // 换成 `popover="manual"` 也不行 —— 模态把 top layer 之外的 popover 也置为 inert，实测同样点不中。
  // 唯一"既看得见、又点得动"的落点是把宿主**临时搬进**最上层那个对话框：在 top layer 之内它照样是
  // 同一个组件、同一套样式与同一条 `aria-live`。位置由 CSS 钉在页脚**之上**（`.dialog__foot > .toasts`），
  // 故它不参与对话框的列布局、也不盖住页脚按钮。
  //
  // ⚠️ **"最上层"必须按 `showModal()` 的先后取，不能按文档序**（2026-09-23 实测修）：
  // `document.querySelectorAll('dialog[open]')` 给的是**文档序**，而四个对话框是模块求值时
  // 按创建顺序（confirm → preview → info → help）append 进 body 的，于是"预览开着、确认框开在
  // 它上面"这一档里，文档序在后的那个反而是**下面**的那个（实测：`open[len-1]` 是预览，
  // 而该点命中的是确认框）⇒ 提示条会落进被压住的框里。这里用打开栈记录真实顺序。
  const openStack = [];
  // `toggle` 在 `<dialog>` 打开/关闭时触发，且**不冒泡** ⇒ 只能挂在捕获阶段。
  // 挂在打开时机上还顺带堵住了另一个洞：此前只在 `show()` 里停靠，于是"提示条**先**显示、
  // 对话框**后**打开"这一档里宿主留在 body —— 用户看得见那条提示、却点不动它，而且点下去
  // 命中 backdrop 会把对话框关掉（2026-09-23 实测：真实鼠标点「重试」位置 ⇒ `dlgOpen=false`）。
  document.addEventListener(
    'toggle',
    (event) => {
      const node = event.target;
      if (!(node instanceof HTMLDialogElement)) return;
      const at = openStack.indexOf(node);
      if (at >= 0) openStack.splice(at, 1);
      if (node.open) openStack.push(node);
      dockHost();
    },
    true,
  );

  function dockHost() {
    const top = openStack.length > 0 ? openStack[openStack.length - 1] : null;
    if (top === null) {
      if (container.parentElement !== document.body) document.body.append(container);
      return;
    }
    const host = top.querySelector('.dialog__foot') ?? top;
    if (container.parentElement === host) return; // 已经停在这里
    host.append(container);
  }

  function show(message, { error = false, duration = 2600, action = null } = {}) {
    // `action`（2026-09-18）：把"重试"这一类补救动作**放在提示条里**。
    // 为什么值得：失败路径此前只有两种结局 —— 对话框内失败可原地重试（好），
    // 而提示条类失败（复制/下载/取全文/批量）只能让用户自己重来一遍，
    // 而"重来"的成本正好是刚刚失败的那一步（再去找到那一行、再点一次）。
    // 带动作时把停留时间拉长到 10 秒：2.6 秒既读不完也来不及点。
    const timeout = action ? Math.max(duration, 10_000) : duration;
    // **不给每条提示加 `role`**（2026-09-18 修）：宿主（`index.html` 的 `#toasts`）已经是
    // `aria-live="polite"`，在里面再嵌一个实时区域会让**同一句话被播报两遍** ——
    // 外层 `aria-atomic="false"`、内层 `role="status"` 隐含 `atomic=true`，两个区域各播一次；
    // 错误那条还会被 `role="alert"` 当成打断来念第二遍。V2 的 `ui/toast.js` 逐字记着这件事
    // 并已经删掉，V1 漏了（见 `docs/archive/AUDIT-v1-v2-divergence.md` §1.6）。让它只由宿主宣布。
    const node = el(
      'div',
      { class: `toast${error ? ' toast--error' : ''}` },
      [
        svg(iconPaths(error ? 'warning' : 'info'), { size: 14 }),
        el('span', { text: message }),
        action
          ? el(
              'button',
              {
                class: 'toast__action',
                type: 'button',
                // 提示条容器是 `pointer-events: none`（不挡页面），动作按钮自己打开命中区
                onclick: () => {
                  dismiss(node);
                  action.run();
                },
              },
              [el('span', { text: action.label })],
            )
          : null,
      ],
    );
    // 宿主被摘掉（别的模块整块 `replaceChildren` 是可能的）就先接回来：否则这条提示会写进一个
    // 游离节点，永远看不见 —— 而那种失败**完全静默**（2026-09-22 实测踩到过：预览框重建页脚时
    // 把停靠中的宿主一起清掉，此后所有提示都不再出现）。一行自愈，代价为零。
    if (!container.isConnected) document.body.append(container);
    dockHost(); // 有对话框开着就先搬进它的 top layer（见 dockHost 的说明）
    container.append(node);
    // 超出上限先收掉最早的：窄屏上堆到第五条会把列表底部的操作整片盖住。
    // **同步移除**是被挤掉那条的正确处置（它多半还没被读到，动画只是推迟腾位置），
    // 也是这段循环的正确性前提：`dismiss` 只是打标记、由计时器稍后移除，
    // 在循环条件里等它会让 children.length 永不下降 —— 那就是一个死循环，整个页面卡住。
    const excess = container.children.length - MAX_TOASTS;
    if (excess > 0) {
      // 先挤掉**没有动作**的老提示：带「重试」的那条要停留 10 秒，用户可能正准备点它；
      // 被后面接连冒出来的即时提示顶掉，等于那个补救入口凭空消失。
      const all = [...container.children];
      const noAction = all.filter((child) => !child.querySelector('.toast__action'));
      for (const stale of [...new Set([...noAction, ...all])].slice(0, excess)) stale.remove();
    }
    setTimeout(() => dismiss(node), timeout);
  }

  return {
    info: (message) => show(message),
    /**
     * 错误提示。`action`（可选）形如 `{ label, run }` —— 带上它就有了"重试"入口，
     * 停留时间自动拉长到 10 秒（见 show 的说明）。
     */
    error: (message, options = {}) => show(message, { error: true, duration: 4000, ...options }),
  };
}

// ===== 原地状态（list / preview / info 共用）=====

const successState = new WeakMap();

function restoreSuccess(button) {
  const saved = successState.get(button);
  if (!saved) return;
  successState.delete(button);
  clearTimeout(saved.timer);
  delete button.dataset.state;
  if (saved.labelNode) saved.labelNode.textContent = saved.label;
  // 行被重建过时旧图标已不在文档里，此时不再动它（新行有自己的状态）
  if (saved.checkSvg?.isConnected && saved.prevSvg) saved.checkSvg.replaceWith(saved.prevSvg);
  if (saved.prevAria === null) button.removeAttribute('aria-label');
  else button.setAttribute('aria-label', saved.prevAria);
  if (saved.prevTitle === null) button.removeAttribute('title');
  else button.setAttribute('title', saved.prevTitle);
}

/**
 * 成功态：把按钮就地变成「对勾 + 结果文案」，`ms` 后还原。
 * 连点时不叠加计时器——先还原再重放。
 */
export function flashSuccess(button, { label = '已完成', ms = 1600 } = {}) {
  if (!button) return;
  if (successState.has(button)) restoreSuccess(button);

  const saved = {
    labelNode: button.querySelector('.btn__label'),
    label: null,
    prevSvg: null,
    checkSvg: null,
    prevAria: button.getAttribute('aria-label'),
    prevTitle: button.hasAttribute('title') ? button.getAttribute('title') : null,
    timer: 0,
  };

  if (saved.labelNode) {
    saved.label = saved.labelNode.textContent;
    saved.labelNode.textContent = label;
  } else {
    const icon = button.querySelector('svg');
    if (icon) {
      const check = svg(iconPaths('check'));
      saved.prevSvg = icon;
      saved.checkSvg = check;
      icon.replaceWith(check);
    }
  }

  button.dataset.state = 'ok';
  button.setAttribute('aria-label', label);
  if (saved.prevTitle !== null) button.setAttribute('title', label);
  saved.timer = setTimeout(() => restoreSuccess(button), ms);
  successState.set(button, saved);
}

/**
 * 进行中态：数据回来之前禁掉重复触发（指针与键盘都禁），并让按钮自己转起来。
 * 不用 `disabled`——那会让按钮整体变灰，读起来像「不可用」而不是「正在做」。
 */
export function setPending(button, pending) {
  if (!button) return;
  if (pending) {
    button.dataset.loading = 'true';
    button.setAttribute('aria-busy', 'true');
  } else {
    delete button.dataset.loading;
    button.removeAttribute('aria-busy');
  }
}

/** 是否处于进行中（点击处理器用它挡住重入） */
export function isPending(button) {
  return button?.dataset.loading === 'true';
}
