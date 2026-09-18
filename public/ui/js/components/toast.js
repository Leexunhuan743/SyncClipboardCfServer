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
import { iconPaths } from '../icons.js';

const MAX_TOASTS = 4;
const LEAVE_MS = 200;

export function createToasts(container) {
  function dismiss(node) {
    if (!node || !node.isConnected || node.dataset.leaving === 'true') return;
    node.dataset.leaving = 'true';
    setTimeout(() => node.remove(), LEAVE_MS);
  }

  function show(message, { error = false, duration = 2600 } = {}) {
    const node = el(
      'div',
      { class: `toast${error ? ' toast--error' : ''}`, role: error ? 'alert' : 'status' },
      [svg(iconPaths(error ? 'warning' : 'info'), { size: 14 }), el('span', { text: message })],
    );
    container.append(node);
    // 超出上限先收掉最早的：窄屏上堆到第五条会把列表底部的操作整片盖住。
    // **同步移除**是被挤掉那条的正确处置（它多半还没被读到，动画只是推迟腾位置），
    // 也是这段循环的正确性前提：`dismiss` 只是打标记、由计时器稍后移除，
    // 在循环条件里等它会让 children.length 永不下降 —— 那就是一个死循环，整个页面卡住。
    const excess = container.children.length - MAX_TOASTS;
    if (excess > 0) {
      for (const stale of [...container.children].slice(0, excess)) stale.remove();
    }
    setTimeout(() => dismiss(node), duration);
  }

  return {
    info: (message) => show(message),
    error: (message) => show(message, { error: true, duration: 4000 }),
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
