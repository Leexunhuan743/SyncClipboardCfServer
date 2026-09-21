// 悬停预览浮层（2026-09-21；docs/ui.md §3.3 硬约束 #26）。
//
// 它只做一件事：**把被 CSS 裁掉的正文，在原地给回多一点**。
//
// 两条硬前提 —— 重做（2026-09-21）就是被它们逼出来的，改之前先读 docs/progress.md §122：
//
//   ① **不接收指针事件**（CSS `pointer-events: none`）。浮层贴在行下方，必然压住后面几行；
//      只要它能命中，那几行的 hover 与点击就被它吞掉 —— 实测 `elementFromPoint` 在浮层
//      覆盖处返回的是浮层本身，鼠标顺着一列往下走会"走不过去"，被压住的行连点都点不到。
//      这是一次**有意的取舍**：代价是不能移进去选中/滚动，而那不是本页取全文的路径（见 ②）。
//   ② **正文按行数封顶**（CSS 里 `max-height: calc(6 * 1.6em)`），超出的裁掉、不做内部滚动、
//      也不挂任何"还有更多"的说明（2026-09-21 用户定：不加提示行）。内部滚动的前提是能移进去，
//      与 ① 直接冲突；而"这条被裁过"本来就有行内的 `长文本` 徽标与「预览」按钮在说。
//      取全文的路径始终是那两个：行内「预览」按钮（可访问、键盘可达）与点击行体。
//
// 浮层标 `aria-hidden="true"`，**不承担无障碍职责**：正文的完整文本本来就在 DOM 里 ——
// `.cell-content__text` 只是被 CSS 裁切，它的文本节点一直是从头到尾的完整串，读屏直接读得到。
// （第一版在这里搞错了：它挂 `aria-describedby`、写 `role="tooltip"`、还留了 focus/blur 监听，
// 而触发元素是个**不可聚焦**的 `div`，那三个监听永远不会响 —— 声称支持键盘、实则没有的死代码。）
import { el } from '../dom.js';

const SHOW_DELAY = 150; // 停住即出；扫过（<150ms 离开）不出现（2026-09-21 用户定：悬停一律 150ms）
const HIDE_GRACE = 80; // 离开触发元素后的宽限：只用来压住边界抖动 —— 浮层不可移入，不需要"够指针落上去"

export function createTooltip() {
  const text = el('div', { class: 'tooltip__text' });
  const node = el('div', { class: 'tooltip', 'aria-hidden': 'true' }, [text]);
  node.id = 'ui-tooltip'; // 页面唯一；调试与探针靠它定位
  node.hidden = true;
  document.body.append(node);

  let showTimer = null;
  let hideTimer = null;
  let currentTrigger = null;

  function place(trigger, content) {
    text.textContent = content;
    node.hidden = false;
    // 视口定位（position: fixed）：贴着触发元素下方；放不下翻到上方；**最后统一夹回视口内**。
    // 最后那一步不是保险丝而是必需品：触发元素在视口外时（探针的合成事件就能造出这种情形，
    // 2026-09-21 实测量到 `top: -1584`），前两条会算出一个负坐标，浮层被画到视口外面 ——
    // 那既看不见、也测不到（`elementFromPoint` 直接返回 null）。
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    let top = rect.bottom + margin;
    if (top + height > window.innerHeight - margin) top = rect.top - height - margin;
    const left = Math.min(Math.max(rect.left, margin), maxLeft);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(Math.min(Math.max(top, margin), maxTop))}px`;
  }

  function hide() {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    currentTrigger = null;
    node.hidden = true;
    text.textContent = '';
  }

  // 滚动 / 缩放：快照内容不跟随，收起最干净（capture 连内层滚动容器一起收）
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);

  return {
    /**
     * 把悬停预览挂到触发元素上。
     * @param {Element} trigger 触发元素（行内正文）
     * @param {(trigger: Element) => string} getContent 显示时求值，返回要显示的文本（读到最新值）
     * @param {{ check?: (trigger: Element) => boolean }} opts check 返回 false 时不出现（如未截断）
     */
    attach(trigger, getContent, { check = null } = {}) {
      // 触屏门：只有精指针 + 支持 hover 的设备才挂监听。触屏模拟出来的 mouseenter 一样会响，
      // 不拦的话点一下会先闪一个浮层再走点击动作（仓库硬规则：hover 只活在
      // `@media (hover: hover) and (pointer: fine)` 内）。
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

      trigger.addEventListener('mouseenter', () => {
        if (check && !check(trigger)) return;
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        hideTimer = null;
        showTimer = setTimeout(() => {
          showTimer = null;
          if (currentTrigger === trigger && !node.hidden) return; // 已经在显示同一条
          currentTrigger = trigger;
          place(trigger, getContent(trigger));
        }, SHOW_DELAY);
      });

      trigger.addEventListener('mouseleave', () => {
        clearTimeout(showTimer);
        showTimer = null;
        if (node.hidden) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          hideTimer = null;
          hide();
        }, HIDE_GRACE);
      });
    },

    /**
     * 触发行被对账重建 / 移出文档之后主动收起。
     *
     * 必需：指针**不动**时节点被 `remove()` 不会产生 `mouseleave`，光靠上面两个监听收不掉 ——
     * 实测（2026-09-21）行被 `reconcile` 重建后，浮层连着旧内容照旧留在屏幕上，且位置不动，
     * 指针底下已经是另一行了。调用点在 `list.js` 的 `update()`（对账之后）。
     */
    prune() {
      if (currentTrigger !== null && !currentTrigger.isConnected) hide();
    },
  };
}
