// 批量操作条：选中记录后浮在列表底部。回收站视图里换成"恢复 / 彻底删除"。
// 长批量可以中止，但写操作只在批次边界停 —— 已生效的数量如实保留（见 api.batchUpdate）。
import { clear, h, icon } from '../lib/dom';
import type { AppState } from '../state';

export interface BatchActions {
  onCopy(): void;
  onStar(on: boolean): void;
  onPin(on: boolean): void;
  onFolder(anchor: HTMLElement): void;
  onTrash(): void;
  onRestore(): void;
  onPurge(): void;
  onClear(): void;
  onCancelRun(): void;
}

export function createBatchBar(ctx: BatchActions) {
  const label = h('span', { class: 'batch__count' });
  const actions = h('div', { class: 'batch__actions' });
  const progress = h('div', { class: 'batch__progress', role: 'status', hidden: true });
  const progressText = h('span');
  const cancel = h('button', { class: 'btn btn--ghost', type: 'button', text: '中止', onclick: () => ctx.onCancelRun() });
  progress.append(h('span', { class: 'spinner' }), progressText, cancel);
  const el = h(
    'div',
    { class: 'batch', role: 'toolbar', 'aria-label': '批量操作', hidden: true },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '取消选择', title: '取消选择（Esc）', onclick: () => ctx.onClear() }, icon('close')),
    label,
    actions,
    progress,
  );
  let running = false;

  const act = (name: Parameters<typeof icon>[0], text: string, run: (button: HTMLElement) => void, className = 'btn btn--ghost'): HTMLButtonElement =>
    h('button', { class: className, type: 'button', 'aria-label': text, title: text, onclick: (event: Event) => run(event.currentTarget as HTMLElement) }, icon(name, { size: 16 }), h('span', { text }));

  return {
    el,
    /** 批量写进行中：显示进度并锁住按钮；传 null 结束 */
    setProgress(text: string | null): void {
      running = text !== null;
      progress.hidden = !running;
      actions.hidden = running;
      if (text !== null) progressText.textContent = text;
    },
    render(state: AppState): void {
      const selected = state.items.filter((item) => state.selection.has(item.key));
      el.hidden = selected.length === 0 && !running;
      label.textContent = `已选 ${selected.length} 项`;
      if (running) return;
      clear(actions);
      if (state.filters.deleted) {
        actions.append(act('undo', '恢复', ctx.onRestore, 'btn btn--primary'), act('trash', '彻底删除', ctx.onPurge, 'btn btn--danger-ghost'));
        return;
      }
      const allStarred = selected.length > 0 && selected.every((i) => i.starred);
      const allPinned = selected.length > 0 && selected.every((i) => i.pinned);
      const copyable = selected.some((i) => i.type === 'Text');
      if (copyable) actions.append(act('copy', '复制文本', ctx.onCopy, 'btn btn--primary'));
      actions.append(
        act('star', allStarred ? '取消收藏' : '收藏', () => ctx.onStar(!allStarred)),
        act('pin', allPinned ? '取消置顶' : '置顶', () => ctx.onPin(!allPinned)),
        act('folder', '放入收藏夹', (button) => ctx.onFolder(button)),
        act('trash', '移到回收站', ctx.onTrash, 'btn btn--danger-ghost'),
      );
    },
  };
}
