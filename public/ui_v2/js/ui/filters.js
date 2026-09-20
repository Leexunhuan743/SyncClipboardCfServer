// 筛选条：类型 chips + 状态开关 + 时间范围 + 抽屉入口。
//
// V2 相对 V1 的改动：V1 把 8 个控件平铺成一行、权重相同（类型分段 / 收藏 / 回收站 /
// 时间 / 搜索 / 页大小 / 刷新）。V2 按**使用频率**分了三层：
//   ① 常驻且高频：类型 chips（含计数）、收藏、回收站、时间范围
//   ② 抽屉里（低频）：每页条数、排序、紧凑模式、维护信息
//   ③ 顶栏：搜索、刷新（两者都**只在窄屏**，宽屏有各自的常驻控件）、主题、登出
// 判据是"用户每次进页面都要动的"留在外面，其余收起来。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { KINDS, typeLabel } from '../format.js';
import { RANGE_PRESETS } from '../filters.js';
import { iconButton } from './button.js';

/**
 * @param {{ onTypes: (types: string) => void, onToggleStarred: () => void,
 *           onToggleDeleted: () => void, onRange: (range: string) => void,
 *           onRefresh: () => void, onClearFilters: () => void,
 *           onOpenDrawer: () => void, isDefault: () => boolean }} handlers
 */
export function createFilters(handlers) {
  // 窄屏时这行 chips 会横向溢出（只露出半个 chip 提示"能滑"）——触屏可以滑，
  // 键盘不能：容器默认不可聚焦，方向键滚不动它，于是"组合"这个筛选在 390px 下
  // 对键盘用户等于不存在。`tabindex="0"` 让它成为一个可聚焦的滚动区
  // （读屏会把它读成"分组"，进而可以进去按方向键滚）。
  const chips = el('div', {
    class: 'chips',
    role: 'group',
    'aria-label': '按类型筛选',
    tabindex: '0',
  });

  // 类型 chips：`All` 之外的四种各带自己的计数。
  // chips 而不是 V1 的分段控件：类型筛选的真实身份是**筛选条件集合**（可组合、可多选），
  // 分段控件把它画成了"视图切换"，语义偏了。
  const typeChips = new Map();
  for (const kind of ['All', ...KINDS]) {
    const num = el('span', { class: 'chip__num', text: '' });
    const chip = el(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': 'false',
        dataset: { kind },
        onclick: () => handlers.onTypes(kind),
      },
      [el('span', { text: kind === 'All' ? '全部' : typeLabel(kind) }), num],
    );
    typeChips.set(kind, { chip, num });
    chips.append(chip);
  }

  const starredChip = el(
    'button',
    {
      class: 'chip',
      type: 'button',
      'aria-pressed': 'false',
      dataset: { tone: 'star', action: 'starred' },
      onclick: handlers.onToggleStarred,
    },
    [svg(iconPaths('star'), { size: 14, class: 'chip__icon' }), el('span', { text: '收藏' })],
  );

  const trashChip = el(
    'button',
    {
      class: 'chip',
      type: 'button',
      'aria-pressed': 'false',
      dataset: { action: 'trash' },
      onclick: handlers.onToggleDeleted,
    },
    [svg(iconPaths('trash'), { size: 14, class: 'chip__icon' }), el('span', { text: '回收站' })],
  );

  const rangeSelect = el('select', {
    class: 'control control--select',
    'aria-label': '时间范围',
    onchange: (event) => handlers.onRange(event.target.value),
  });
  for (const preset of RANGE_PRESETS) {
    rangeSelect.append(el('option', { value: preset.value, text: preset.label }));
  }

  const clearBtn = el('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    text: '清除筛选',
    hidden: true,
    // 点它 = **回到活跃列表**（`resetFilters()` 清掉全部条件，包括「回收站」这个条件）——
    // 与 V1 `main.js` 的 `onClearFilters`（`setFilters({ ...DEFAULT_FILTERS }, …)`）同答，
    // 空状态里那枚「清除筛选」（`board.js` 的 renderEmpty）走同一条路。
    // 包装一层仍然必要：`el('button', { onclick })` 会把浏览器传进来的 MouseEvent 当第一个实参。
    // 2026-09-20 定案（ADR D19）：这两处此前**行为相反**（空状态那枚传 `{ keepView: true }` ⇒ 留在回收站），
    // 已统一成"回活跃列表"，`boot.js` 的 `keepView` 形参随之删除（原注释里的"尚未定论"到此为止）。
    onclick: () => handlers.onClearFilters(),
  });

  const refreshBtn = iconButton({
    icon: 'refresh',
    label: '刷新',
    onClick: handlers.onRefresh,
  });

  const root = el('div', { class: 'filters' }, [
    chips,
    starredChip,
    trashChip,
    rangeSelect,
    clearBtn,
    el('span', { class: 'filters__spacer' }),
    refreshBtn,
  ]);

  // 类型计数只对「全部」以外的四个显示数字；`全部` 的数字来自 total。
  // `counts === undefined` 表示这份计数不属于当前视图（见 boot.js 的 countsForView），
  // 此时**清空数字**而不是显示另一套 —— 显示错的数字比不显示更糟。
  return {
    el: root,

    /**
     * 只把时间范围下拉框拨回某个值。
     *
     * 场景：用户选了「自定义…」（它是一个**入口**，不是筛选值），界面随即打开抽屉让他填日期，
     * 此时下拉框必须退回**上一次真正生效的范围** —— 否则它会停在"自定义"上，
     * 而列表一条都没筛，用户以为筛过了（实测踩过，用户也报告了）。
     */
    updateRangeValue(range) {
      if (rangeSelect.value !== range) rangeSelect.value = range;
    },

    update({ filters, counts, total, busy }) {
      const active = filters.types;
      // 每 10 秒的轮询都会调到这里，而筛选控件与计数几乎每次都不变 ——
      // `setAttribute` / `textContent` 的赋值本身就是 DOM 变更（实测每次刷新 28 次），
      // 故一律"先比后写"。`setText` / `setAttr` 两个小工具就是这条纪律的落地。
      const setText = (node, text) => {
        if (node.textContent !== text) node.textContent = text;
      };
      const setAttr = (node, name, value) => {
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
      };

      for (const [kind, { chip, num }] of typeChips) {
        setAttr(chip, 'aria-pressed', kind === active ? 'true' : 'false');
        if (kind === 'All') {
          // `total` 是**活跃**记录数（与列表的"共 N 条"同源），不是含回收站的 `totalCount` ——
          // 否则「全部」上的数字会比它下面列表的总数大，读起来像 bug。
          setText(num, Number.isFinite(total) ? String(total) : '');
        } else if (counts) {
          setText(num, String(counts[kind] ?? 0));
        } else {
          setText(num, '');
        }
      }

      setAttr(starredChip, 'aria-pressed', filters.starred ? 'true' : 'false');
      setAttr(trashChip, 'aria-pressed', filters.deleted ? 'true' : 'false');

      // 时间范围：`custom` 时选中的是自定义项，具体的边界在抽屉里看
      if (rangeSelect.value !== filters.range) rangeSelect.value = filters.range;

      clearBtn.hidden = handlers.isDefault();

      if (busy) setAttr(refreshBtn, 'data-loading', '');
      else if (refreshBtn.hasAttribute('data-loading')) refreshBtn.removeAttribute('data-loading');
    },
  };
}
