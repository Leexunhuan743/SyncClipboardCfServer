// 轻量 hover tooltip（2026-09-21 用户定案；docs/ui.md §3.3 硬约束 #26）。
//
// 语义（grilling 走完全部分支）：
//   · 触发：mouseenter / focus 后 **150ms** 出现（扫过不闪、停住即出）；键盘聚焦即时
//   · 只在内容真正被截断时出现：调用方传 `check(trigger)`（如 `scrollWidth > clientWidth`），
//     返回 false 就不出现 —— 短文本不白占 hover
//   · **到达并停住**：tooltip 贴着触发元素出现（无断带），鼠标可移入 tooltip 滚动/复制；
//     离开触发元素后留 ~120ms 宽限（够指针落到相邻的 tooltip 上），移开两者才消失
//   · 无障碍：`role="tooltip"` + 触发元素 `aria-describedby`（键盘聚焦即达，读屏读到内容）；
//     Esc 收起；触屏无 hover → 这是渐进增强，触屏走既有点击路径
//   · 单例：全页一个 tooltip 节点；触发元素在 `<dialog>` 里时挂进该 dialog —— 否则会被
//     模态顶层盖住（对话框标题那条就是这种场景）
import { el } from '../dom.js';

const SHOW_DELAY = 150; // 停住即出；扫过（<150ms 离开）不出现（2026-09-21 用户定：悬停一律 150ms）
const HIDE_GRACE = 120; // 离开触发元素后的宽限，让指针能落到相邻的 tooltip 上

export function createTooltip() {
  const node = el('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  node.id = 'ui-tooltip'; // aria-describedby 的目标；页面唯一
  document.body.append(node);
  let host = document.body;
  let showTimer = null;
  let hideTimer = null;
  let currentTrigger = null;

  function place(trigger, content) {
    node.replaceChildren(content);
    // 挂载点：触发元素在 <dialog> 里时挂进该 dialog（模态顶层会盖住 body 上的节点）
    const target = trigger.closest('dialog') ?? document.body;
    if (target !== host) {
      target.append(node);
      host = target;
    }
    node.hidden = false;
    node.setAttribute('aria-hidden', 'false');
    // 视口定位（position: fixed）：贴着触发元素下方，放不下翻到上方、不越视口
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    let left = rect.left;
    let top = rect.bottom + margin;
    const tw = node.offsetWidth;
    const th = node.offsetHeight;
    if (left + tw > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - tw - margin);
    if (top + th > window.innerHeight - margin) top = Math.max(margin, rect.top - th - margin);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
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
    if (currentTrigger) {
      currentTrigger.removeAttribute('aria-describedby');
      currentTrigger = null;
    }
    node.hidden = true;
    node.setAttribute('aria-hidden', 'true');
    node.replaceChildren();
  }

  // tooltip 自身可达：移入即取消隐藏宽限、可停留；移出才关（到达并停住）
  node.addEventListener('mouseenter', () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  node.addEventListener('mouseleave', () => hide());

  // 滚动 / 缩放：快照内容不跟随，收起最干净（capture 连内层滚动容器一起收）
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);

  return {
    /**
     * 把一个 hover tooltip 挂到触发元素上。
     * @param {Element} trigger 触发元素
     * @param {(trigger: Element) => Node} getContent 返回显示的内容节点（show 时求值，读到最新值）
     * @param {{ check?: (trigger: Element) => boolean }} opts check 返回 false 时不出现（如未截断）
     */
    attach(trigger, getContent, { check = null } = {}) {
      // 触屏门：只有精指针 + 支持 hover 的设备才挂监听 —— 触屏模拟的 mouseenter 也会触发
      // mouseenter，不拦的话点一下会先闪一个浮层再走点击动作（仓库硬规则：hover 只活在
      // `@media (hover: hover) and (pointer: fine)` 内）。
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      const schedule = (delay) => {
        if (check && !check(trigger)) return;
        clearTimeout(showTimer);
        showTimer = setTimeout(() => {
          if (currentTrigger === trigger) return; // 已在显示
          currentTrigger = trigger;
          trigger.setAttribute('aria-describedby', node.id);
          place(trigger, getContent(trigger));
        }, delay);
      };
      trigger.addEventListener('mouseenter', () => schedule(SHOW_DELAY));
      trigger.addEventListener('mouseleave', (event) => {
        // 到达并停住：指针直接落到 tooltip 上不关；否则给 ~120ms 宽限
        if (node.contains(event.relatedTarget)) return;
        clearTimeout(showTimer);
        if (!node.hidden) hideTimer = setTimeout(hide, HIDE_GRACE);
      });
      // 键盘等价：聚焦即时显示（读屏经 aria-describedby 读到内容），失焦 / Esc 收起
      trigger.addEventListener('focus', () => schedule(0));
      trigger.addEventListener('blur', () => hide());
      trigger.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hide();
      });
    },
  };
}
