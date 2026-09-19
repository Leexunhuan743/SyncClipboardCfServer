// 骨架屏：**保留布局**的加载占位，不是转圈。
//
// 转圈的问题不是"难看"，是它不传递任何**结构**信息 —— 用户不知道等在后面的是
// 一张一行的提示还是一张 50 行的表。骨架屏提前把那件事画出来，等待因此变得可预期。
//
// ⚠️ 行数必须**尽量接近真实页大小**（2026-09-16 实测）：骨架行高与真实行同高，
// 但骨架只有 6 行（384px）而默认每页 50 行（3930px）—— 内容落地时整页高度从 804px
// 涨到 4454px，把页脚与分页整段推出屏幕，实测 **CLS = 0.90**（其中单次位移 0.8987，
// 见 `docs/ui-v2-audit.md` §2 的 A-02；`board.js` 与 `boot.js` 的注释用的是同一个 0.90），
// 而原来的注释还写着"CLS = 0"。行数由调用方按**当前页大小**给出（见 `board.js`）。
import { el } from '../dom.js';

/** 建 N 行骨架。行高与真实行同高（`--row-h`），所以**每行**落位不跳；
 * 但总高度取决于行数：`rows` 与真实页大小差得远时整页高度仍会突变（文件头记的 CLS = 0.90 就是这么来的），
 * 故调用方必须按当前页大小传 `rows`（见 `board.js`）；这里的 6 只是兜底默认值。 */
export function renderGhost(rows = 6) {  const fragment = document.createDocumentFragment();
  for (let i = 0; i < rows; i += 1) {
    fragment.append(
      el('div', { class: 'ghost', 'aria-hidden': 'true' }, [
        el('span', { class: 'ghost__bar ghost__bar--kind' }),
        el('span', { class: 'ghost__bar ghost__bar--wide' }),
        el('span', { class: 'ghost__bar ghost__bar--short' }),
      ]),
    );
  }

  const wrap = el('div', { class: 'board', role: 'status', 'aria-label': '正在加载剪贴板历史' }, [fragment]);
  return wrap;
}
