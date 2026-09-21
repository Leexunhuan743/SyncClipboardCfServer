// 提示条与**原地状态**：两种反馈通道，职责不重叠。
//
//   · `toasts`       —— 需要解释或跨控件的反馈（错误、降级原因）。瞬时、右下角、最多 4 条。
//   · `setPending` / `flashOk` —— **原地**状态：用户按的是哪个控件，结果就落在哪个控件上。
//     「请求发出去了」不等于「做成了」，所以调用方必须传一个真实结果。
//
// V1 的教训（docs/ui.md §3.3 第 2 条）：原地反馈优先于提示条。一个"已复制"的角标比右下角
// 飘过的一句话更容易被看见 —— 因为用户的眼睛正停在刚点的那个按钮上。
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';

const MAX_TOASTS = 4;
/** 原地成功态（对勾）显示多久。 */
const OK_DURATION = 1600;
/**
 * 提示条停留多久。错误给得明显更长（2026-09-16 审计 A-34）：
 * 错误提示是**唯一**说明"为什么没做成"的地方，3.2 秒读不完一句中文长句；
 * 而它随鼠标悬停暂停（见 `add()`），所以给长一点不会赖在屏幕上。
 */
const OK_TOAST_DURATION = 3200;
const ERROR_DURATION = 10_000;

export function createToasts(host) {
  const icons = { info: 'info', ok: 'check', error: 'warning' };

  function remove(node) {
    // 溢出时同步移除，不走离场动画：动画期间它会占着位置，用户看到的是"卡住的一条"
    node.remove();
  }

  function add(message, tone) {
    // 不再给每条提示加 `role="status"`：提示条的宿主（`#toasts`）已经是
    // `aria-live="polite"`，在里面再嵌一个实时区域会造成**同一句话被播报两遍**
    // （外层 atomic=false、内层 role=status 隐含 atomic=true，两个区域各播一次）。
    // 让它只由宿主宣布。
    const node = el('div', { class: 'toast', dataset: { tone } }, [
      svg(iconPaths(icons[tone] ?? 'info'), { size: 15, class: 'toast__icon' }),
      el('span', { text: message }),
    ]);
    host.append(node);

    while (host.children.length > MAX_TOASTS) remove(host.firstElementChild);

    // 计时器分两段：`life` 是停留时长、`leave` 是离场动画的兜底（reduced-motion 下
    // `animationend` 可能不来，没有它就会留下一条永远不消失的提示）。
    // **鼠标停在上面时暂停**（2026-09-16 审计 A-34）：错误提示只有 6–10 秒，
    // 而"把鼠标移过去读"是最自然的反应 —— 读着读着它自己消失是最糟的体验。
    const life = tone === 'error' ? ERROR_DURATION : OK_TOAST_DURATION;
    let remaining = life;
    let startedAt = Date.now();
    let lifeTimer = 0;
    let leaveTimer = 0;

    const dismiss = () => {
      clearTimeout(lifeTimer);
      clearTimeout(leaveTimer);
      node.setAttribute('data-leaving', '');
      leaveTimer = setTimeout(() => node.remove(), 400);
    };

    const startLife = () => {
      startedAt = Date.now();
      lifeTimer = setTimeout(dismiss, remaining);
    };

    const pauseLife = () => {
      clearTimeout(lifeTimer);
      remaining = Math.max(600, remaining - (Date.now() - startedAt));
    };

    startLife();
    node.addEventListener('mouseenter', pauseLife);
    node.addEventListener('mouseleave', startLife);

    node.addEventListener('click', () => {
      clearTimeout(lifeTimer);
      clearTimeout(leaveTimer);
      node.remove();
    });
    return node;
  }

  return {
    info: (message) => add(message, 'info'),
    ok: (message) => add(message, 'ok'),
    error: (message) => add(message, 'error'),
  };
}

// ===== 原地状态（行内按钮与对话框按钮共用）=====

/**
 * 置"进行中"。同时置 `aria-busy`（读屏据此知道该控件在忙），并记下原标签以便还原。
 *
 * @param {HTMLElement} node
 * @param {boolean} pending
 * @param {{ disable?: boolean }} [options]
 *   `disable`（默认 `true`）会顺带把按钮置灰 —— 对对话框里的按钮是对的（挡住连点、
 *   失败后由 `finally` 恢复）。但**行内按钮不能这么做**：给聚焦中的按钮加 `disabled`
 *   会让浏览器立刻把焦点移走（`<body>`），而行的"就地更新"要靠焦点还回来播对勾动画 ——
 *   于是"防连点"和"保住焦点"在这里是冲突的，行内按钮用默认的 `data-loading` 守卫即可
 *   （守卫本身已经能挡住重复提交，`disabled` 只是额外的视觉反馈）。
 */
export function setPending(node, pending, { disable = true } = {}) {
  if (!node) return;
  if (pending) {
    if (!node.dataset.label) node.dataset.label = node.textContent ?? '';
    node.setAttribute('data-loading', '');
    node.setAttribute('aria-busy', 'true');
    if (disable) node.disabled = true;
  } else {
    node.removeAttribute('data-loading');
    node.removeAttribute('aria-busy');
    if (disable) node.disabled = false;
  }
}

export function isPending(node) {
  return Boolean(node?.hasAttribute('data-loading'));
}

/**
 * 原地显示成功态（对勾 + 结果文案），`OK_DURATION` 后还原。
 *
 * `label` 是**结果**而不是动作（"已复制 1234 个字符"，不是"复制"）——
 * 这句话要能回答"我做的事到底成了没有、成了什么"。
 *
 * 图标按钮的还原靠 `dataset.icon`（由 `rowops.js` 写入的图标名）：
 * 不还原的话，行内按钮会**永久停在对勾上**，而那个按钮还承担着"再点一次"的职责。
 */
export function flashOk(node, label) {
  if (!node) return;
  const original = node.dataset.label ?? node.textContent ?? '';
  node.dataset.label = original;
  node.setAttribute('data-state', 'ok');

  const iconOnly = node.classList.contains('icon-btn');
  if (iconOnly) {
    const current = node.querySelector('svg');
    if (current) current.replaceWith(svg(iconPaths('check'), { size: 16 }));
  } else {
    node.textContent = label ?? '已完成';
  }

  setTimeout(() => {
    node.removeAttribute('data-state');
    if (iconOnly) {
      const name = node.dataset.icon || 'info';
      const current = node.querySelector('svg');
      if (current) current.replaceWith(svg(iconPaths(name), { size: 16 }));
    } else {
      node.textContent = original;
    }
  }, OK_DURATION);
}
