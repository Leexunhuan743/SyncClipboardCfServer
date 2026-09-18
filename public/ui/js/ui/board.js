// 列表：列表头、数据表、时间分组、行对账、选择。
//
// 两条从 V1 继承的硬纪律（它们都是实测换来的，不是风格偏好）：
//
//   ① **同一视图内按行对账**。只有内容签名变了才重建那一行 —— 整表重建会重载缩略图、
//      打断动画、丢掉焦点与 hover，而列表每 10 秒轮询一次，这些副作用本来每 10 秒发生一遍。
//      首屏（第一份非空结果）走一次整表重建 + 错峰入场；之后一律对账，不播动画。
//
//   ② **列表更新一帧落地，不做同文档视图过渡**。`document.startViewTransition` 要对整个
//      结果区做布局/样式快照（实测 6× 降速下 ~60ms，且随页大小上升），换来的只是一个
//      数据表上的交叉淡入 —— 而列表本来就是一帧落地，没有"换面"需要掩饰。
//      `test/ui-contract.test.ts` 有一条守卫盯着它不被重新引入。
import { el, svg, clear, replayAnimation } from '../dom.js';
import { iconPaths } from '../icons.js';
import { dayGroup } from '../format.js';
import { captureFocus, restoreFocus, describeFocusable } from '../focus.js';
import { SORT_FIELDS, PAGE_SIZES, emptyStateKind } from '../filters.js';
import { iconButton, labelButton } from './button.js';
import { renderRow, fillRow, signature } from './row.js';
import { renderBlank, renderFailure } from './blank.js';
import { renderGhost } from './ghost.js';

const ENTER_STAGGER_LIMIT = 10; // 超过 10 行不再错峰：延迟累积会让第 50 行等一秒多

/**
 * @param {{ onSelect, onSelectAll, onOpen, onCopy, onDownload, onStar, onMenu,
 *           onSort, onPageSize, onClearFilters, onOpenDrawer, onRetry }} handlers
 */
export function createBoard(handlers) {
  const table = el('table', { class: 'board__table' });
  const colgroup = el('colgroup');
  const headRow = el('tr', { class: 'board__head-row' });
  const thead = el('thead', {}, [headRow]);
  const tbody = el('tbody');
  table.append(colgroup, thead, tbody);

  const headCount = el('span', { class: 'board-head__count' });
  const sortBtn = labelButton({
    className: 'btn btn--ghost btn--sm',
    icon: 'filter',
    label: '',
    attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    onClick: () => handlers.onSortMenu(sortBtn),
  });

  const pageSizeSelect = el('select', {
    class: 'control control--select',
    'aria-label': '每页条数',
    onchange: (event) => handlers.onPageSize(Number(event.target.value)),
  });
  for (const size of PAGE_SIZES) pageSizeSelect.append(el('option', { value: String(size), text: `${size} 条/页` }));

  // 紧凑模式开关。**放在这里而不是抽屉里**（用户 2026-09-15 的要求）：
  // 它是"改一下这一屏看起来什么样"的**视图开关**，而抽屉是"改设置"的地方。
  // 人们是先看见列表、觉得行太疏、于是想调紧一点 —— 这个念头发生的位置就是列表头，
  // 让用户为此打开抽屉再滚到"视图偏好"是把一步变成三步。
  //
  // 用 `aria-pressed` 而不是 `data-active`：与筛选 chips 保持同一套态表达。
  // 图标是「三条横线」——它同时表达"列表"与"更紧凑"，正好是这个按钮的两个说法。
  //
  // ⚠️ **这个按钮不自己记状态**（第一版在这里错了，实测抓到）：它曾经把 `currentDensity`
  // 记在闭包里、用 `currentDensity === 'compact'` 算下一个值。而 `theme-init.js` 会在
  // **首帧前**从 localStorage 恢复用户上次选的密度 —— 于是闭包里那个初值 `'comfortable'`
  // 与页面真实状态（可能已经是 compact）从加载那一刻就对不上，第一次点击发出的是
  // "设为 compact"（本来就是 compact，等于没变），此后永远卡在同一个值上。
  // 现在改为把**意图**交给调用方，由它按唯一事实源（store）算下一个值。
  const densityBtn = iconButton({
    icon: 'list',
    label: '切换为紧凑行高（同屏显示更多行）',
    onClick: () => handlers.onDensity(),
  });

  const head = el('div', { class: 'board-head' }, [
    headCount,
    el('span', { class: 'board-head__spacer' }),
    sortBtn,
    pageSizeSelect,
    densityBtn,
  ]);

  const root = el('div', { class: 'board-area' }, [head]);

  // 列：选择 / 类型条 / 内容（吃掉剩余宽度）/ 操作。
  // 只有操作列是固定宽 —— 内容列的"弹性"由 `table-layout: fixed` + 不声明宽度的
  // 那一列自动承担，这是"正文优先"的机械保证，不靠百分比去猜。
  for (const width of ['var(--col-check)', 'var(--col-kind)', null, 'var(--col-ops)']) {
    colgroup.append(el('col', width ? { style: { width } } : {}));
  }

  const th = (label, className, node) =>
    el('th', { class: `board__head-cell ${className}`, scope: 'col' }, [node ?? label]);

  // 表头的「内容」列表头同时是排序入口（点击在创建/修改时间之间轮换的直觉不足，
  // 故它只承担"内容"这一列的名字；完整排序在右上角的菜单里）。
  const contentHead = el('span', { text: '内容' });
  const sortIndicator = el(
    'button',
    {
      class: 'sort-btn',
      type: 'button',
      'aria-pressed': 'true',
      dataset: { dir: 'desc' },
      onclick: () => handlers.onToggleOrder(),
    },
    [el('span', { class: 'sort-btn__label', text: '时间' }), svg(iconPaths('chevronDown'), { size: 12, class: 'sort-btn__arrow' })],
  );

  const selectAll = el('input', {
    class: 'check',
    type: 'checkbox',
    'aria-label': '选择本页全部记录',
    onchange: (event) => handlers.onSelectAll(event.target.checked),
  });

  head.prepend(el('label', { class: 'board-head__select' }, [selectAll, '全选']));

  headRow.append(
    th('选择', 'board__head-cell--check'),
    th('类型', ''),
    th(null, 'board__cell--content', el('span', {}, [contentHead, document.createTextNode(' '), sortIndicator])),
    th('操作', 'board__head-cell--ops'),
  );

  const boardNode = el('div', { class: 'board' }, [table]);

  // ── 方向键在行之间移动焦点（2026-09-16 审计 A-31）──
  //
  // 为什么需要：每行有 4 个可聚焦控件（复选框、主操作、收藏、`⋯`），50 行 = 200 个 Tab 停靠点 ——
  // 从第 1 行走到第 40 行要按约 160 次 Tab，列表作为"一列可浏览的内容"在键盘上等于不可导航。
  //
  // 为什么是**加**方向键而不是"每行只留一个 Tab 停靠点"（roving tabindex）：
  // 后者会**减少**现有的 Tab 停靠点，是一种可感知的行为改变；而方向键是纯增量 ——
  // 现有 Tab 顺序一个字节都不动，只是多了一种更快的走法。
  //
  // 规则（与电子表格/列表的通行预期一致）：
  //   · ↓ / ↑ 到相邻行的**同一个控件**（在第 1 行的收藏上按 ↑ 会到第 0 行的收藏，不会跳到别的列）；
  //   · Home / End 到首行/末行的同一个控件。
  // 不拦 Tab，不拦输入（行内没有文本输入）。`focus()` 自带滚动到可视区。
  function onRowKeydown(event) {
    const MOVES = { ArrowDown: 1, ArrowUp: -1 };
    const isHome = event.key === 'Home';
    const isEnd = event.key === 'End';
    if (!(event.key in MOVES) && !isHome && !isEnd) return;
    // 修饰键一律让路：**Shift+方向键是"选中文字"**，不是列表导航（V1 的同行守卫就是这么写的）。
    // 此前这里漏了 shiftKey，于是 Shift+↑ 会把焦点搬走而不是选中上一行 —— 两版手感不一致。
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    const row = document.activeElement?.closest?.('tr.item');
    if (!row || row.parentElement !== tbody) return; // 焦点不在列表行里

    // "同一个控件"用 `focus.js` 的判据（`[data-icon]` / `.check`）—— 与焦点恢复共用一套描述
    const snapshot = describeFocusable(document.activeElement);
    if (!snapshot) return;

    const rows = [...tbody.querySelectorAll('tr.item')];
    const index = rows.indexOf(row);
    const target = isHome ? rows[0] : isEnd ? rows.at(-1) : rows[index + MOVES[event.key]];
    if (!target || target === row) {
      // 到边界（首行再按 ↑、末行再按 ↓）：**吞掉这次按键**，否则页面会跟着滚一下。
      // 与 V1 的列表行为一致 —— 两版的键盘手感不该有差别。
      event.preventDefault();
      return;
    }

    const next = target.querySelector(snapshot.selector);
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  tbody.addEventListener('keydown', onRowKeydown);

  // ===== 渲染状态 =====
  let rowMap = new Map(); // key → { row, signature }
  const dayMap = new Map(); // 分组 key → 那个 `.daymark` 行（复用，见 renderDayMark）
  let rendered = false; // 是否已经画过**第一份非空**结果（决定要不要播入场动画）
  let lastItems = [];

  /**
   * 一行要用的完整 spec（渲染 + 重填 + 就地更新都用它）。
   *
   * 抽出来不只是为了少写几行：这份 7 个回调的包原来在 `buildRow` / `update` / `patchItem`
   * 里各写了一遍，加一个回调（例如回收站的 `onRestore`）就得记得改三处 ——
   * 实测就漏过一处，表现为"回收站主操作改成了恢复，但行内容变化后就变回复制"。
   */
  function rowSpec(item, selected) {
    return {
      item,
      selected,
      onSelect: handlers.onSelect,
      onOpen: handlers.onOpen,
      onCopy: handlers.onCopy,
      onDownload: handlers.onDownload,
      onStar: handlers.onStar,
      onRestore: handlers.onRestore,
      onMenu: handlers.onMenu,
    };
  }

  function renderSortLabel(filters, density) {
    const field = SORT_FIELDS.find((f) => f.value === filters.sort);
    // 每 10 秒的轮询都会走到这里：写 `textContent` 会替换文本节点（真实 DOM 变更），
    // 而"排序字段"几乎从不改变 —— 判等之后再写，让无变化的刷新真的零变更。
    const buttonLabel = field ? field.label : '排序';
    const labelNode = sortBtn.querySelector('.btn__label');
    if (labelNode.textContent !== buttonLabel) labelNode.textContent = buttonLabel;
    if (pageSizeSelect.value !== String(filters.pageSize)) pageSizeSelect.value = String(filters.pageSize);
    sortIndicator.dataset.dir = filters.order;
    const indicatorLabel = filters.sort === 'createTime' ? '时间' : field?.label ?? '时间';
    const indicatorNode = sortIndicator.querySelector('.sort-btn__label');
    if (indicatorNode.textContent !== indicatorLabel) indicatorNode.textContent = indicatorLabel;
    // 排序**方向**必须在无障碍树里说得出来：它此前只存在于 `data-dir`（CSS 靠它转箭头）
    // 与一个恒为 `aria-pressed="true"` 的按钮上，读屏用户听到"时间，已按下"，
    // 永远不知道当前是升序还是降序。
    const dirText = filters.order === 'asc' ? '升序' : '降序';
    const sortLabel = `排序：按${field?.label ?? '时间'}${dirText}（点一下切换方向）`;
    sortIndicator.setAttribute('aria-label', sortLabel);
    sortIndicator.title = sortLabel;

    // 紧凑开关的态：**只由传进来的 density 决定**（不自己存一份，见上面按钮处的说明）。
    // 文案随**当前**状态描述"点它会发生什么"，与主题按钮（显示月亮 = 点了变深色）同一套措辞纪律。
    const compact = density === 'compact';
    densityBtn.setAttribute('aria-pressed', compact ? 'true' : 'false');
    const label = compact ? '切换为宽松行高' : '切换为紧凑行高（同屏显示更多行）';
    densityBtn.setAttribute('aria-label', label);
    densityBtn.title = label;
  }

  /** 建一行（首次）。 */
  function buildRow(item, selected) {
    return renderRow(rowSpec(item, selected));
  }

  /**
   * 时间分组的小标题行。
   *
   * **按分组 key 复用节点、只改文字**：原来每次都新建一个 `<tr>`，于是哪怕整页内容一字未变，
   * `tbody` 的子节点序列也永远"变了"—— 下面那条"顺序没变就跳过 DOM 交换"的优化就永远不生效，
   * 行被反复 detach/attach，焦点每 10 秒被浏览器扔给 `<body>`（见 `focus.js` 的说明）。
   */
  function renderDayMark(group, count) {
    let row = dayMap.get(group.key);
    if (!row) {
      row = el('tr', { class: 'daymark', dataset: { group: group.key } }, [
        el('td', { colspan: '4' }, [el('span'), el('span', { class: 'daymark__count' })]),
      ]);
      dayMap.set(group.key, row);
    }
    const [label, countNode] = [...row.firstElementChild.children];
    // **只在文字真的变了时才写**：给 `textContent` 赋值会替换掉里面的文本节点，
    // 那是一次真实的 DOM 变更（一次刷新 2 次）。轮询每 10 秒来一次，而"今天 28 条"
    // 这种数字几乎每次都不变 —— 判等之后再写，等于把"内容没变就不动 DOM"这条原则
    // 贯彻到文本节点这一层（`states.mjs` 有断言：内容未变的刷新必须零变更）。
    if (label.textContent !== group.label) label.textContent = group.label;
    const countText = `${count} 条`;
    if (countNode.textContent !== countText) countNode.textContent = countText;
    return row;
  }

  /**
   * 主渲染。
   *
   * @param {{ items, total, filters, selection, flashKeys, state }} spec
   *   `state` ∈ `loading | ready | error | empty`
   */
  function update(spec) {
    const { items, total, filters, selection, flashKeys, state, error, busy, density } = spec;

    // 焦点快照：**在任何 DOM 手术之前**取（这一步之前的 DOM 还是用户看到的那一份）。
    // 为什么必须在这一层做：`update()` 是唯一"整页对账"的入口，而它做两件事会让焦点掉 ——
    // tbody 的整段重挂、以及内容变了那一行的就地重填（`fillRow` 会重建操作列）。
    const focus = captureFocus(root);
    applySelectAllState(selectAll, items, selection);
    selectAll.disabled = busy || items.length === 0;

    renderSortLabel(filters, density);
    // 列表头的"共 N 条"：每 10 秒的轮询都会走到这里，而它几乎每次都一样 ——
    // 先拼字符串再比，比"无条件 replaceChildren"省掉每次刷新 3 次 DOM 变更（含文本节点替换）。
    const countText = `${state}\u0001${total ?? 0}\u0001${filters.search ?? ''}`;
    if (headCount.dataset.key !== countText) {
      headCount.dataset.key = countText;
      headCount.replaceChildren(
        el('strong', { text: state === 'loading' ? '…' : String(total ?? 0) }),
        document.createTextNode(state === 'loading' ? ' 正在加载' : ' 条记录'),
        document.createTextNode(filters.search ? ` · 搜索“${filters.search}”` : ''),
      );
    }

    if (busy) boardNode.setAttribute('data-busy', '');
    else boardNode.removeAttribute('data-busy');

    // ---- 非 ready 态：整块换成骨架 / 空状态 / 错误态 ----
    if (state === 'loading') {
      // 骨架行数 = **当前页大小**（上限 50）。这一点是实测校准出来的：
      // 骨架行与真实行同高，所以"行数相等"才等于"高度相等"。原先固定 6 行，
      // 而默认每页 50 行 —— 内容落地时文档高度从 ~1500px 涨到 4454px，可见的页脚与分页
      // 被顶出屏幕，实测 **CLS 0.90**（那一版注释里写着"CLS = 0"，与事实相反）。
      // 上限定在 50：再多的骨架行只是更长的空白，而每行要 3 个节点。
      const rows = Math.min(50, Math.max(3, Number(filters.pageSize) || 10));
      root.replaceChildren(head, renderGhost(rows));
      return;
    }
    if (state === 'error' && items.length === 0) {
      root.replaceChildren(head, renderError(error));
      return;
    }
    if (state === 'empty' || items.length === 0) {
      root.replaceChildren(head, renderEmpty(filters));
      return;
    }

    if (!root.contains(boardNode)) root.replaceChildren(head, boardNode);

    const animate = !rendered;
    const firstPaint = items.length > 0;

    // ---- 时间分组：只在按创建时间排序时才有意义 ----
    // 按大小/类型排序时"今天/昨天"的小标题会把同一组拆散，读起来是错的。
    const grouped = filters.sort === 'createTime';

    // ---- 按 key 对账 ----
    const nextMap = new Map();
    /** 这一帧**按顺序**要有的子节点（小标题行与记录行混排）。 */
    const frames = [];
    let lastGroupKey = null;
    const groupCounts = grouped ? countGroups(items) : null;

    for (const item of items) {
      if (grouped) {
        const group = dayGroup(item.createTime);
        if (group.key !== lastGroupKey) {
          frames.push(renderDayMark(group, groupCounts.get(group.key) ?? 0));
          lastGroupKey = group.key;
        }
      }

      const selected = selection.has(item.key);
      const existing = rowMap.get(item.key);
      const nextSignature = signature(item);
      let row;

      if (existing && existing.row.isConnected && existing.signature === nextSignature) {
        // 内容没变：**原样复用节点**（保住缩略图、焦点、正在进行的按钮状态）
        row = existing.row;
      } else if (existing && existing.row.isConnected) {
        // 内容变了（别的设备改了这条）：就地换内容 + 闪一次。
        // `fillRow` 会把**操作列整段重建**，而用户此刻的焦点可能正落在这一行的按钮上
        // （刚点完收藏、等下一次轮询回来看结果，是最常见的姿势）。所以先记下"焦点是哪个控件"，
        // 换完再还给它 —— 与 `patchItem` 同一条判据。
        // ⚠️ 这一层下面那句 `restoreFocus(root, focus)` 只在**整段重挂**时才跑
        // （`!sameFrames(tbody, frames)`），而这里节点身份没变 ⇒ 它不会触发 ⇒
        // 不在这里显式搬回焦点，键盘用户就会在轮询刷新时被扔回 `<body>`。
        row = existing.row;
        const rowFocus = captureFocus(row);
        fillRow(row, rowSpec(item, selected));
        restoreFocus(row, rowFocus);
        row.setAttribute('data-flashing', '');
        setTimeout(() => row.removeAttribute('data-flashing'), 1300);
      } else {
        row = buildRow(item, selected);
        if (animate) prepareEnter(row, nextMap.size);
      }

      // 选中态是**独立于内容**的：即使行内容是复用的，选择也可能刚变过
      if (selected) row.setAttribute('data-selected', '');
      else row.removeAttribute('data-selected');
      const box = row.querySelector('.check');
      if (box) box.checked = selected;

      // 新记录（轮询/推送发现别处写入了这条）闪一次
      if (flashKeys?.has(item.key) && !existing) {
        row.setAttribute('data-flashing', '');
        setTimeout(() => row.removeAttribute('data-flashing'), 1300);
      }

      nextMap.set(item.key, { row, signature: nextSignature });
      frames.push(row);
    }

    // ---- 落地 ----
    // **顺序与节点都没变就一个节点都不动**。原来无条件 `clear(tbody)` + 重新 append：
    // 行节点虽然被复用了，但"先摘下来再挂回去"仍然会让浏览器把焦点扔给 `<body>`
    // （实测：按 `r` 刷新后 activeElement 从行的复制按钮变成 BODY）。
    // 轮询每 10 秒一次、每次推送广播也刷一次 —— 键盘用户因此每 10 秒被踢回页首。
    if (!sameFrames(tbody, frames)) {
      const fragment = document.createDocumentFragment();
      for (const frame of frames) fragment.append(frame);
      clear(tbody);
      tbody.append(fragment);
      // 真的动过 DOM：把焦点按"行 + 控件"搬回去（`focus.js`）
      restoreFocus(root, focus);
    }

    rowMap = nextMap;
    // 只保留这一帧用到的分组节点，避免历史分组（如 `d6`）永久占着一条 `<tr>`
    for (const key of [...dayMap.keys()]) if (!groupCounts?.has(key)) dayMap.delete(key);
    rendered = rendered || firstPaint;
    lastItems = items;

    // 全选复选框的三态：全选 / 未选 / 部分（`indeterminate` 是唯一能表达"部分"的原生能力）
    applySelectAllState(selectAll, items, selection);
  }

  function prepareEnter(row, index) {
    if (index >= ENTER_STAGGER_LIMIT) return;
    row.style.setProperty('animation-delay', `${index * 28}ms`);
    row.setAttribute('data-entering', '');
    setTimeout(() => {
      row.removeAttribute('data-entering');
      row.style.removeProperty('animation-delay');
    }, 500 + index * 28);
  }

  function renderEmpty(filters) {
    const kind = emptyStateKind(filters);
    return el('div', { class: 'board' }, [
      renderBlank(kind, {
        onAction(key) {
          if (key === 'clear') handlers.onClearFilters({ keepView: true });
          else if (key === 'back') handlers.onExitTrash();
          else handlers.onOpenDrawer();
        },
      }),
    ]);
  }

  function renderError(message) {
    return el('div', { class: 'board' }, [
      renderFailure(message ?? '未知错误', { onRetry: handlers.onRetry }),
    ]);
  }

  return {
    el: root,
    tbody,

    update,

    /**
     * 只重画**列表头**（排序标签、每页条数、紧凑开关）。
     *
     * 为什么需要它单独一个方法（实测换来的）：紧凑模式开关在列表头，而它改变的是行的显示 ——
     * 行的重画由 CSS 变量自动完成（`data-density` 一切换，`--row-h` 就变了），
     * **只有按钮自己的状态需要重画**。而 `boot.js` 的 `renderChrome()` 刻意**不调用** `update()`
     * （那个会整表重建，把正在播的对勾动画、焦点、hover 全打断），于是第一版出现了一个
     * 很难查的现象：行高真的变了、`localStorage` 也真的写了，但按钮的 `aria-pressed`
     * 与文案永远不动 —— **功能生效了，反馈没有**。
     */
    updateChrome({ filters, density }) {
      renderSortLabel(filters, density);
    },

    /** 单个字段变了就地更新那一行（收藏/置顶成功后用，不重拉整页）。 */
    patchItem(item, { pop } = {}) {
      const entry = rowMap.get(item.key);
      if (!entry) return;
      // `fillRow` 会把操作列整段换掉 —— 包括用户此刻正聚焦的那个按钮
      // （点"收藏"时焦点就在它上面）。所以先记下"焦点是哪个控件"，换完再还给它。
      const focus = captureFocus(entry.row);
      fillRow(entry.row, rowSpec(item, entry.row.hasAttribute('data-selected')));
      restoreFocus(entry.row, focus);
      entry.signature = signature(item);
      if (pop === 'star') {
        const star = entry.row.querySelector('.icon-btn[data-icon="star"]');
        if (star) {
          // 用 `replayAnimation`（删属性 → 强制回流 → 写回）而不是裸 `setAttribute`：
          // 同一个属性值不会重启 CSS 动画，连点两次收藏时第二次就没有反馈了。
          replayAnimation(star, 'data-pop', 'star');
          setTimeout(() => star.removeAttribute('data-pop'), 400);
        }
      }
    },

    /**
     * 删除成功后**就地收掉**这一行（随后静默刷新补齐）。
     *
     * 等下一次整页刷新才消失会读成「点了没反应」。收行时**必须把焦点交给邻居**：
     * 焦点原本在被移除的按钮上，不管的话会落到 `<body>`，键盘用户得从页面开头重新 Tab。
     */
    removeItem(item, action) {
      const entry = rowMap.get(item.key);
      if (!entry) return;
      const row = entry.row;
      const nextFocus = neighborButton(row, action);
      row.setAttribute('data-leaving', '');
      const drop = () => {
        if (row.isConnected) row.remove();
        rowMap.delete(item.key);
      };
      // `animationend` 之外还有兜底定时器：reduced-motion 下动画被归零，
      // 那个事件可能不来，没有兜底就会留下一行"永远在淡出"的残影。
      row.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 260);
      if (nextFocus) nextFocus.focus();
    },

    /** 同步选中态（批量条与复选框都要跟着变）。 */
    syncSelection(selection, items) {
      for (const [key, entry] of rowMap) {
        const selected = selection.has(key);
        if (selected) entry.row.setAttribute('data-selected', '');
        else entry.row.removeAttribute('data-selected');
        const box = entry.row.querySelector('.check');
        if (box) box.checked = selected;
      }
      applySelectAllState(selectAll, items ?? lastItems, selection);
    },
  };
}

/**
 * `tbody` 现在的子节点序列是否**就是**这一帧要的序列（同一个节点、同一个顺序）。
 *
 * 判据必须是节点身份而不是"内容相等"：我们关心的是"要不要动 DOM"，
 * 而 DOM 一动就会丢焦点（见 `focus.js`）。内容变了但节点被就地重填的情况，
 * 这个比较会返回 true —— 那正是我们想要的（不需要重挂）。
 */
function sameFrames(tbody, frames) {
  const current = tbody.children;
  if (current.length !== frames.length) return false;
  for (let i = 0; i < frames.length; i += 1) if (current[i] !== frames[i]) return false;
  return true;
}

/** 选择集变化时全选框的三态。 */
function applySelectAllState(selectAll, items, selection) {  if (!selectAll || !items) return;
  const selectedOnPage = items.filter((item) => selection.has(item.key)).length;
  selectAll.checked = items.length > 0 && selectedOnPage === items.length;
  selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < items.length;
}

/** 焦点交给邻居行里的**同一个操作**（都找不到时交给第一行的选择框）。 */
function neighborButton(row, action) {
  if (!action) return null;
  const rows = [...(row.parentElement?.children ?? [])];
  const index = rows.indexOf(row);
  for (const candidate of [rows[index + 1], rows[index - 1]]) {
    const button = candidate?.querySelector?.(`.icon-btn[data-icon="${action}"]`);
    if (button) return button;
  }
  return null;
}

function countGroups(items) {
  const counts = new Map();
  for (const item of items) {
    const { key } = dayGroup(item.createTime);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
