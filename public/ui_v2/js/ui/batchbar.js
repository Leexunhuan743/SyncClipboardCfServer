// 批量操作条：选中 ≥1 条时从底部升起。
//
// 两个设计决定：
//   ① **悬浮**而不是把布局顶上去 —— 列表高度不变，用户的阅读位置不跳。
//   ② 覆盖的字段与单条 PATCH **完全一致**（收藏 / 置顶 / 删除 / 恢复），
//      且服务端逐条走同一条写路径（`historyOps.applyHistoryUpdate`）。不做"批量捷径"：
//      捷径会让"界面改的"与"客户端改的"逐渐分叉。
import { el } from '../dom.js';
import { labelButton } from './button.js';
import { setPending } from './toast.js';


/**
 * @param {{ onClose: () => void, onAction: (name: string, items: object[]) => Promise<boolean> }} handlers
 */
export function createBatchbar({ onClose, onAction }) {
  // `role="status"`：批量条是在用户按键（Space 选中一行）之后**才出现**的，
  // 而它出现在 DOM 的很后面 —— 读屏用户不会"路过"它，必须有人告诉他发生了什么。
  // 计数变化（"已选 3 条"）由这个实时区域播报，这是选中状态唯一的可访问反馈。
  const count = el('span', { class: 'batchbar__count', text: '', role: 'status' });
  // `id` 必须**自己带上**：HTML 里那个 `<div id="batchbar">` 只是**挂载点**，
  // `boot.js` 用 `replaceWith` 把它整个换掉。不带 id 的话任何按 id 找它的地方都会拿到 null ——
  // 而它在屏幕上好好的，于是这个问题在肉眼层面完全不可见。
  // （同一个坑在 `overview.js` 上先踩过一次；两处的修法与理由相同，`states.mjs` 里有断言守着。）
  // `role="group"` 而不是 `role="toolbar"`（2026-09-16 审计 A-32）：`toolbar` 这个角色**承诺**了
  // "方向键在一组控件之间移动"的键盘模型，而这里没有实现它 —— 读屏用户会按工具条的预期去按方向键，
  // 然后发现什么都没发生。`group` 只是"这是一组相关控件"，与"每个按钮都能 Tab 到"的现状相符。
  // （另一种修法是补 roving tabindex + 方向键；但那会让 6 个按钮只剩 1 个 Tab 停靠点，
  //  对这个只有 6 个按钮的条子来说，Tab 已经足够快，不值得为它引入一套键盘模型。）
  const root = el('div', {
    class: 'batchbar',
    id: 'batchbar',
    role: 'group',
    'aria-label': '批量操作',
    hidden: true,
  });

  // 五个动作。删/恢复的可用性随视图变（活跃列表能删、回收站能恢复），
  // 其余在两个视图里都成立 —— 故按钮集合固定、按视图禁用，而不是重建按钮。
  const ACTIONS = [
    { name: 'star', label: '收藏', icon: 'star' },
    { name: 'pin', label: '置顶', icon: 'pin' },
    { name: 'download', label: '下载', icon: 'download' },
    { name: 'restore', label: '恢复', icon: 'undo' },
    { name: 'delete', label: '删除', icon: 'trash', tone: 'danger' },
  ];

  const buttons = new Map();
  for (const action of ACTIONS) {
    const button = labelButton({
      label: action.label,
      className: 'btn btn--sm',
      dataset: { action: action.name, tone: action.tone ?? 'normal' },
      async onClick(node) {
        // 进行中的按钮不该被再点一次；`setPending` 同时写 `data-loading`（CSS 画转圈）
        // 与 `aria-busy`（读屏据此知道它在忙）—— 这套状态全站只有这一处实现。
        if (node.hasAttribute('data-loading')) return;
        setPending(node, true);
        try {
          await onAction(action.name, items);
        } finally {
          setPending(node, false);
        }
      },
    });
    buttons.set(action.name, button);
    root.append(button);
  }

  // 这个按钮刻意**不用** `iconButton()`：它显示的是一个文字字形 `✕` 而不是图标路径，
  // 换成 SVG 会改变它的视觉观感（本轮的整理以"行为与观感都不变"为界）。
  const closeBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': '取消选择',
    title: '取消选择',
    text: '✕',
    onclick: onClose,
  });

  // 计数放最前、关闭放最后：读屏顺序是"选了几条 → 能做什么 → 怎么退出"
  root.prepend(el('span', { class: 'batchbar__sep' }));
  root.prepend(count);
  root.append(el('span', { class: 'batchbar__sep' }), closeBtn);

  let items = [];

  return {
    el: root,

    update({ selection, deleted }) {
      items = [...selection.values()];
      const size = items.length;
      root.hidden = size === 0;
      if (size === 0) return;

      count.textContent = `已选 ${size} 条`;

      // 视图决定可用性：活跃列表里没有"恢复"，回收站里没有"删除"（那是重复删除）。
      // 收藏/置顶在回收站里仍可用（记录还在，只是已删除），
      // 但**下载**只在有数据文件时可用 —— 软删已经清掉了数据文件，点了必然 404。
      const hasData = items.some((item) => item.hasData === true && item.type !== 'Text');
      set(buttons.get('delete'), !deleted && size > 0);
      set(buttons.get('restore'), deleted && items.some((item) => item.hasData !== true));
      set(buttons.get('download'), !deleted && hasData);
    },
  };
}

function set(button, enabled) {
  if (button) button.disabled = !enabled;
}
