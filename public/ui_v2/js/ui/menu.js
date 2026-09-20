// 行溢出菜单（`⋯`）：把"低频但存在"的动作收起来，让 rest 态只留主操作。
//
// ── 为什么不用 `<dialog>` + `showModal()`（第一版的实现，实测有两个用户可见的缺陷）──
//
// 1. **点外部关不掉。** `showModal()` 会铺一层**全屏遮罩**，所有"点空白处"的点击都被遮罩
//    吃掉、到不了 `document`；而关闭逻辑挂在 `document` 的 `pointerdown` 上，于是永远不触发。
//    遮罩还是**透明**的，用户看不见它、却确实在被它拦。
// 2. **滚动时菜单不跟着走、也不关。** `showModal()` 只锁 `body` 的滚动，本页滚的是
//    `documentElement`，所以页面照样滚；而菜单是 `position: fixed`，于是它钉在视口上
//    **飘到了完全不相干的另一条记录旁边**，用户看着一个"不认识的"菜单。
//
// 现在的做法：一个 `position: fixed` 的**真遮罩**（透明、自己负责响应点外部）+ 一个
// `position: fixed` 的菜单，外加"**一滚就关**"。后者不只是修 bug，它本身就是下拉菜单的通行行为：
// 菜单是"此刻这一行的操作"，行的位置变了，这个前提就不成立了。
import { el, svg, clear } from '../dom.js';
import { iconPaths } from '../icons.js';

const MARGIN = 8;
const GAP = 6;

/**
 * 建一个可复用的菜单。同一次点击只开一个 —— 菜单是"此刻的操作对象"，不是面板。
 */
export function createMenu() {
  const list = el('div', { class: 'menu__list' });
  const panel = el('div', { class: 'menu', role: 'menu', hidden: true }, [list]);

  // 遮罩：透明、铺满视口、**唯一**的"点外部"判据。
  // 用 `pointerdown` 而不是 `click`：后者会在拖动选择文本结束时误触发关闭。
  const backdrop = el('div', {
    class: 'menu-backdrop',
    hidden: true,
    onpointerdown: () => close(),
  });

  document.body.append(backdrop, panel);

  let resolveClose = null;
  let open = false;
  /** 当前菜单属于哪个锚点按钮（用于"再点一次收起"，以及关闭时把焦点还给它）。 */
  let currentAnchor = null;

  /** 可聚焦的菜单项（跳过分隔线与禁用项）——方向键导航用。 */
  function enabledItems() {
    return [...list.querySelectorAll('.menu__item:not(:disabled)')];
  }

  function close() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    backdrop.hidden = true;
    // 开态**只由原生 `hidden` 表达**（配 CSS 的 `.menu[hidden]` 与 `.menu-backdrop[hidden]`）。
    // 这里原有一句 `panel.removeAttribute('data-open')`，但全仓**没有任何地方设过它**
    // （`data-open` 只此一处出现、CSS 里也没有对应规则）⇒ 2026-09-19 删除，免得读代码的人
    // 以为存在一个 `data-open` 开态。见审计 N-13 与 `docs/ui-v2-design.md` §5 词汇表的订正。
    // 锚点按钮的 `aria-expanded` 必须跟着关：读屏靠它知道"菜单还开着吗"
    if (currentAnchor?.hasAttribute('aria-expanded')) currentAnchor.setAttribute('aria-expanded', 'false');

    // 焦点还给锚点按钮。菜单打开时焦点被移进了菜单项，若不还回去，关闭后
    // 焦点落在 `<body>` —— 键盘用户要从页面开头重新 Tab（而在 50 行的列表里，
    // 那意味着几十次 Tab）。只在"焦点确实在菜单里、或已经掉到 body"时还，
    // 免得抢走用户主动点到别处的焦点。
    const active = document.activeElement;
    if (currentAnchor?.isConnected && (panel.contains(active) || active === document.body || active === backdrop)) {
      currentAnchor.focus({ preventScroll: true });
    }

    const resolve = resolveClose;
    resolveClose = null;
    resolve?.(null);
  }

  // 「一滚就关」：捕获阶段同时收 `scroll` 与 `wheel`/`touchmove`。
  // 只用 `scroll` 不够 —— 有些容器（含本页的 `.board`）在内容不变时会吞掉 scroll；
  // 而 `wheel` 在光标停在菜单自身上时也要算（用户就是想滚页面）。
  window.addEventListener('scroll', close, { capture: true, passive: true });
  window.addEventListener('wheel', close, { capture: true, passive: true });
  window.addEventListener('touchmove', close, { capture: true, passive: true });
  // 窗口尺寸变了，菜单与锚点的相对位置就不再成立
  window.addEventListener('resize', close);
  // 键盘：Esc 关闭、Tab 关闭（`role="menu"` 的通行模型）、方向键在菜单项之间移动。
  //
  // ⚠️ 必须注册在**捕获**阶段（2026-09-16 实测抓到的缺陷）：`boot.js` 也在 `document` 上监听
  // keydown 处理 Esc（"清空选择集"）。两个监听器挂在**同一个节点**上，而 `stopPropagation()`
  // 只能阻止向其它节点传播，压不住同节点的另一个监听器（那是 `stopImmediatePropagation()` 的职责）。
  // 后果：打开 ⋯ 菜单后按 Esc，菜单关了、**同时整个选择集被清空** —— 用户只是想取消一次菜单
  // 操作，却丢掉了刚选好的那些行。注册在捕获阶段才有效（此时事件还没走到 document 的冒泡监听）。
  function onKeydown(event) {
    if (!open) return;

    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // 不拦 Tab：让焦点按浏览器默认顺序走出去，菜单只是不再留着
      close();
      return;
    }

    const items = enabledItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);

    let next = null;
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    if (!next) return;

    event.preventDefault();
    next.focus();
  }

  document.addEventListener('keydown', onKeydown, { capture: true });

  return {
    /**
     * @param {{ anchor: HTMLElement,
     *           items: Array<{ label: string, icon?: string, tone?: 'danger'|'normal',
     *                          disabled?: boolean, separator?: boolean, run: () => unknown }> }} spec
     */
    open({ anchor, items }) {
      // 再点一次同一个锚点 = 收起（下拉菜单的通行行为；否则用户只能用 Esc 或点别处）
      if (open && currentAnchor === anchor) {
        close();
        return Promise.resolve(null);
      }

      clear(list);
      for (const item of items) {
        if (item.separator) {
          list.append(el('div', { class: 'menu__sep' }));
          continue;
        }
        list.append(
          el(
            'button',
            {
              class: 'menu__item',
              type: 'button',
              role: 'menuitem',
              disabled: item.disabled === true,
              dataset: { tone: item.tone === 'danger' ? 'danger' : 'normal' },
              onclick: () => {
                // 先关再执行：动作可能会弹对话框（确认删除），
                // 让菜单留在对话框底下会形成两层遮罩。
                close();
                item.run();
              },
            },
            [
              item.icon ? svg(iconPaths(item.icon), { size: 16 }) : el('span', { style: { width: '16px' } }),
              el('span', { text: item.label }),
            ],
          ),
        );
      }

      // 锚点身份：用于"再点一次收起"、关闭时还焦点。行内按钮没有 id（50 行就 50 个），
      // 直接留住元素引用最省事也最准确。
      currentAnchor = anchor;
      if (anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'true');

      backdrop.hidden = false;
      panel.hidden = false;
      open = true;

      // 先量后摆：`hidden` 去掉之后尺寸才是真的。摆放前先藏起来，避免看到它从
      // 左上角跳到按钮旁边（一帧的跳动在弹出菜单上很显眼）。
      panel.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        place(panel, anchor);
        panel.style.visibility = '';
        // 焦点进第一项：菜单是"此刻这一行的操作"，键盘用户按回车打开后应当能直接选
        enabledItems()[0]?.focus();
      });

      return new Promise((resolve) => {
        resolveClose = resolve;
      });
    },

    /** 供外部（比如行被删掉时）主动收起。 */
    close,
  };
}

/** 把菜单摆到锚点旁边；两个方向都要判，因为操作列在**最右**、行又可能在**最底**。 */
function place(panel, anchor) {
  const rect = anchor.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = rect.right - box.width;
  if (left < MARGIN) left = MARGIN;
  if (left + box.width > vw - MARGIN) left = Math.max(MARGIN, vw - MARGIN - box.width);

  let top = rect.bottom + GAP;
  if (top + box.height > vh - MARGIN) top = Math.max(MARGIN, rect.top - box.height - GAP);

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  // 菜单本身也可能因内容极长而溢出：交给浏览器滚动，不在这里截断
  panel.style.maxHeight = `${vh - MARGIN * 2}px`;
  panel.style.overflowY = 'auto';
}
