// 行内操作按钮：rest 态可见 + 原地 loading/成功态。
//
// V2 相对 V1 的改动（问题 5）：V1 把 5 个 16px 灰图标放在行尾、几乎只能靠 hover 发现，
// 而"复制"是这个界面第二高频的动作。V2：
//   · 只留**三个**：主操作（复制/下载/恢复）+ 收藏 + `⋯`（其余动作收进菜单）
//   · rest 态不透明度 0.55（可发现），hover/聚焦/选中时全亮（不抢注意力）
//   · 触屏下不透明度恒为 1（没有 hover 这回事，不能拿它当发现机制）
//
// 按钮构造本身在 `./button.js`（全站共用，见那里的说明）；
// "原地成功态"在 `./toast.js` 的 `flashOk`（同样全站共用）——
// 后者原来在本文件里又实现了一遍（`flash()`），两处都改同一种交互时必然漂移。
import { el } from '../dom.js';
import { flashOk, isPending, setPending } from './toast.js';
import { iconButton } from './button.js';

/**
 * 行内按钮的点击包装：**进行中不再接受第二次点击**。
 *
 * 为什么需要（2026-09-16 实测抓到）：连点两次收藏会发出**两个** `PATCH`
 * （闭包里的 `item.starred` 在第一次响应回来之前没变，于是两次都算出"设为 true"），
 * 用户点两下只会看到一次变化 —— 第二下被静默丢掉，却真实地打了一次服务端。
 * 复制同理（两次取全文 + 两条提示）。
 *
 * `disable: false`：行内按钮**不能**靠 `disabled` 防连点 —— 给聚焦中的按钮加 `disabled`
 * 会让焦点掉到 `<body>`，而行的就地更新正要靠焦点还回来播对勾（见 `toast.js` 的说明）。
 */
function guarded(button, run) {
  if (isPending(button)) return Promise.resolve(false);
  setPending(button, true, { disable: false });
  return Promise.resolve(run()).finally(() => setPending(button, false, { disable: false }));
}

/**
 * 一行的操作区。
 *
 * @param {{ item: object,
 *           onCopy: (item) => Promise<boolean>,
 *           onDownload: (item) => Promise<boolean>,
 *           onStar: (item, next: boolean) => Promise<boolean>,
 *           onRestore: (item) => Promise<boolean>,
 *           onMenu: (item, anchor: HTMLElement) => void }} spec
 */
export function renderRowOps({ item, onCopy, onDownload, onStar, onRestore, onMenu }) {
  const wrap = el('div', { class: 'rowops' });

  // 主操作：「这条记录**此刻最可能被用来做什么**」，而不是"哪个实现简单"。
  //
  // **回收站视图里是「恢复」**（2026-09-15 修）：用户进回收站几乎总是为了把某条找回来，
  // 而原来主操作是"复制"——"恢复"只能去 `⋯` 菜单里找，等于把该视图的首要任务藏起来了。
  // 判据用 `item.isDeleted`（它就在行的内容签名里，所以切进/切出回收站时行会正确重建）。
  //
  // 2026-09-22（ADR D29，与 V1 同一次改）：**不再按 `hasData` 禁用**。真回收站保留了数据，
  // 带数据文件的记录恢复时会连数据一起回来 —— 此前禁用它是上游语义（软删即毁数据）的直接后果。
  if (item.isDeleted) {
    wrap.append(
      iconButton({
        icon: 'undo',
        label: '恢复到历史记录',
        title: '恢复到历史记录（含数据文件）',
        onClick: (button) => guarded(button, async () => {
          const ok = await onRestore(item);
          if (ok) flashOk(button);
          return ok;
        }),
      }),
    );
  } else if (item.type === 'Text') {
    wrap.append(
      iconButton({
        icon: 'copy',
        label: '复制内容到剪贴板',
        onClick: (button) => guarded(button, async () => {
          const ok = await onCopy(item);
          if (ok) flashOk(button);
          return ok;
        }),
      }),
    );
  } else {
    wrap.append(
      iconButton({
        icon: 'download',
        label: '下载数据文件',
        onClick: (button) => guarded(button, async () => {
          const ok = await onDownload(item);
          if (ok) flashOk(button);
          return ok;
        }),
      }),
    );
  }

  const star = iconButton({
    icon: 'star',
    label: item.starred ? '取消收藏' : '收藏',
    pressed: item.starred === true,
    onClick: (button) => guarded(button, () => onStar(item, !item.starred)),
  });
  wrap.append(star);

  wrap.append(
    iconButton({
      icon: 'dots',
      label: '更多操作',
      // 它开的是一个 `role="menu"` 的面板：读屏要靠这两个属性预告"这里会弹出一个菜单、
      // 现在是不是开着"。`aria-expanded` 由 `menu.js` 在开关时同步（它就认识这个按钮）。
      menu: true,
      onClick: (button) => onMenu(item, button),
    }),
  );

  return wrap;
}

// 原地成功态由 `./toast.js` 的 `flashOk` 提供（原来在这里又实现了一遍，已合并）。
