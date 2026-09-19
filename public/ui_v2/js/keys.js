// 全局快捷键：**一份实现，一处判据**。
//
// 抽出来的理由（2026-09-16 审计 A-38）：这几条快捷键的判据都被实测修过，而它们原来埋在 `boot.js`
// 的装配逻辑里 —— 改一条要先读懂那一大段。特别是两个"不能想当然"的判据：
//   1. **模态打开时不接管**：删除确认框开着时按 `r` 会刷新**对话框下面**的列表，
//      用户正在确认"删除这条"，而那条记录所在的数据集在他确认之前就被换掉了；
//      按 `/` 还会把焦点从对话框里拽走。
//   2. **Esc 的"正在输入"判据与其它键不同**：复选框也是 `HTMLInputElement`，
//      而"用键盘选中一行"必然把焦点留在复选框上 —— 用同一套 `typing` 判据，
//      Esc 就正好在用户最需要退出批量模式时失效。
//
// 本模块只做**判定与分派**，不碰状态与网络：回调由调用方给。
import { isTypingTarget, isTextInput } from './dom.js';

/**
 * @param {{
 *   onFocusSearch: () => void,
 *   onEscapeSelection: () => boolean,  // 返回 true 表示"这次 Esc 我处理了"
 *   onRefresh: () => void,
 *   isModalOpen: () => boolean,
 * }} handlers
 * @returns {() => void} 解绑函数
 */
export function bindShortcuts(handlers) {
  const listener = (event) => {
    // 模态期间只有模态内部的动作有效（见文件头）
    if (handlers.isModalOpen()) return;

    const target = event.target;
    const typing = isTypingTarget(target);

    // `/` 与 `Ctrl/Cmd+K` 聚焦搜索（在输入框里不抢）
    if (!typing && (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'))) {
      event.preventDefault();
      handlers.onFocusSearch();
      return;
    }

    // Esc：先清选择集（逐级退出，而不是一次清光）。判据见文件头第 2 条。
    if (event.key === 'Escape' && !isTextInput(target) && handlers.onEscapeSelection()) return;

    // `r` 刷新（不在输入框里时）
    if (!typing && event.key === 'r' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      handlers.onRefresh();
    }
  };

  document.addEventListener('keydown', listener);
  return () => document.removeEventListener('keydown', listener);
}
