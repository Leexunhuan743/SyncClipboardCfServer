// 结果区：计数/选择条 + 数据表 + 空状态。
//
// 五件容易做错的事，这里都明确处理：
// 1. 正文全部走 textContent（剪贴板内容不可信，本页与数据端点同源）；
// 2. 图片缩略图加载失败要变成「数据不可用」，不是裂图；hasData 为假时直接不请求；
// 3. 行入场只在「新视图」时做（首次/翻页/改筛选），轮询刷新不得整页重放动画——
//    否则每次刷新整页闪一遍，正是「幻灯片式入场」的失败形态；
// 4. **同一视图内的刷新按行对账**（reconcile）：内容没变的行原样留着，不重建 DOM。
//    整表重建会重载缩略图、打断正在跑的动画、丢掉焦点与 hover——
//    轮询每 10 秒一次，这些副作用本来每 10 秒发生一遍；
// 5. 行内操作就地给出「进行中 → 结果」：用户按的是哪个按钮，反馈就落在哪个按钮上
//    （列表刷新不会把它冲掉，因为按钮属于行的状态，不属于一次渲染）。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { formatRelative, formatAbsolute, formatSize, previewText, previewIsEmpty, typeLabel, typeChipClass } from '../format.js';
import { itemIsImage } from '../clipboard.js';
import { buildThumb, buildFlags, TOGGLES, applyToggleState, playPop } from './row-content.js';
import { setPending, flashSuccess, isPending } from './toast.js';

const ENTER_STAGGER_LIMIT = 12; // 超过 12 行就不再错峰：延迟累积会让第 50 行等两秒

// 行的「内容签名」：只有这些字段变了才需要重建该行。
// createTime 不在其中（它真的是常量）；但**修改/访问时间必须在内**——它们是这两个字段里
// 变得最勤的（每次同步都推进 LastAccessed），不进签名会让轮询刷新后行不重建、
// 两列时间停在首次渲染的值：按「访问」排序时时间会显得不单调，看起来像排序坏了。
function signature(item) {
  return [
    item.type,
    item.starred,
    item.pinned,
    item.isDeleted,
    item.size,
    item.hasData,
    item.textTruncated,
    item.dataName ?? '',
    item.text ?? '',
    item.lastModified ?? '',
    item.lastAccessed ?? '',
  ].join('\u0001');
}

// 行 → 该行当前的 item 与可变引用（收藏状态在行内就地更新，闭包不能拿旧对象）
const rowRefs = new WeakMap();

// 最近一次按下的行内操作与它所属的行（见 actionButton 里的说明）。
let lastRowAction = null;

// 行内操作按钮：跑 action → 成功就地显示结果、失败留给 action 自己提示（toast）。
// action 返回 `true` 才显示成功态——「发过请求」不等于「做成了」。
function actionButton({ action, label, icon, run, successLabel = null, disabled = false, title = null }) {
  const button = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      dataset: { action },
      'aria-label': label,
      title: title ?? label,
      disabled,
      onclick: async () => {
        if (isPending(button)) return;
        // 记下「按的是哪一行的哪个操作」：删除要走确认对话框，等它关闭时焦点已经不在这一行了
        // （showModal 把焦点搬进对话框，关闭时又还给那个**可能已被移除**的按钮），
        // 所以来源只能在按下的当下记。
        lastRowAction = { key: button.closest('tr')?.dataset.key ?? null, action };
        setPending(button, true);
        try {
          const ok = await run(button);
          if (ok && successLabel) flashSuccess(button, { label: successLabel });
        } finally {
          setPending(button, false);
        }
      },
    },
    [svg(iconPaths(icon))],
  );
  return button;
}

function buildActions(item, actions) {
  // 回收站里的行只做一件事：恢复。能否恢复由**服务端的守卫**决定——已删除且数据文件名为空
  // （transferDataFile === ''）才允许把 IsDeleted 置回 0；带数据文件的记录在软删时已清掉数据，
  // 服务端会返回 404，故这里直接禁用并说明原因，不让用户白点一次。
  if (item.isDeleted) {
    return el('div', { class: 'row-actions' }, [
      actionButton({
        action: 'restore',
        label: '恢复',
        icon: 'undo',
        run: () => actions.onRestore(item),
        successLabel: '已恢复',
        disabled: item.hasData,
        title: item.hasData ? '数据文件已随删除清除，不可恢复' : '恢复到历史记录',
      }),
    ]);
  }

  const buttons = [
    actionButton({
      action: 'preview',
      label: '预览',
      icon: 'eye',
      run: () => actions.onPreview(item),
    }),
  ];

  if (item.type === 'Text') {
    buttons.push(
      actionButton({
        action: 'copy',
        label: '复制内容',
        icon: 'copy',
        run: () => actions.onCopy(item),
        successLabel: '已复制',
      }),
    );
  } else {
    // 图片（或文件名是图片的 File/Group）可以复制到系统剪贴板——clipserver 的行内复制即按此分发
    if (itemIsImage(item)) {
      buttons.push(
        actionButton({
          action: 'copy-image',
          label: '复制图片',
          icon: 'copy',
          run: () => actions.onCopyImage(item),
          successLabel: '已复制',
          disabled: !item.hasData,
          title: item.hasData ? '复制图片' : '数据不可用，无法复制',
        }),
      );
    }
    buttons.push(
      actionButton({
        action: 'download',
        label: '下载',
        icon: 'download',
        run: () => actions.onDownload(item),
        successLabel: '已下载',
        disabled: !item.hasData,
        title: item.hasData ? '下载' : '数据不可用，无法下载',
      }),
    );
  }

  buttons.push(
    actionButton({
      action: 'delete',
      label: '删除',
      icon: 'trash',
      run: () => actions.onDelete(item),
    }),
  );

  return el('div', { class: 'row-actions' }, buttons);
}

export function createList(actions) {
  const headInfo = el('span', { class: 'results__count' });
  const headSelection = el('div', { class: 'results__selection', hidden: true });
  const head = el('div', { class: 'results__head' }, [headInfo, headSelection]);

  const selectAll = el('input', { class: 'checkbox', type: 'checkbox', 'aria-label': '全选本页' });
  selectAll.addEventListener('change', () => actions.onSelectAll(selectAll.checked));
  // 用 label 承载命中区：input 本身只有 20px，触屏上点到旁边不会勾选（见 components.css 的 .check-wrap）
  const selectAllWrap = el('label', { class: 'check-wrap' }, [selectAll]);

  const sortArrows = new Map();
  function sortableHeader(label, field, extraClass) {
    const arrow = svg(iconPaths('arrowUp'), { size: 12, class: 'th-sort__arrow' });
    sortArrows.set(field, arrow);
    const button = el(
      'button',
      {
        class: 'th-sort',
        type: 'button',
        title: '排序',
        onclick: () => actions.onSort(field),
      },
      [el('span', { text: label }), arrow]
    );
    return el('th', { class: extraClass, scope: 'col', role: 'columnheader' }, [button]);
  }

  const tbody = el('tbody', { role: 'rowgroup' });
  const table = el('table', { class: 'table', role: 'table' }, [
    el('thead', { role: 'rowgroup' }, [
      el('tr', { role: 'row' }, [
        el('th', { class: 'col-check', scope: 'col', role: 'columnheader' }, [selectAllWrap]),
        sortableHeader('类型', 'type', 'col-type'),
        el('th', { scope: 'col', role: 'columnheader' }, [el('span', { text: '内容' })]),
        sortableHeader('大小', 'size', 'col-size'),
        sortableHeader('创建', 'createTime', 'col-time'),
        sortableHeader('修改', 'lastModified', 'col-modified'),
        sortableHeader('访问', 'lastAccessed', 'col-accessed'),
        el('th', { class: 'col-star', scope: 'col', role: 'columnheader' }, [
          el('span', { class: 'sr-only', text: '收藏与置顶' })
        ]),
        el('th', { class: 'col-actions', scope: 'col', role: 'columnheader' }, [
          el('span', { class: 'sr-only', text: '操作' })
        ]),
      ]),
    ]),
    tbody,
  ]);

  const empty = el('div', { class: 'empty', hidden: true });
  const node = el('section', { class: 'results', 'aria-label': '剪贴板历史' }, [head, table, empty]);

  const rowByKey = new Map();
  // 首屏是否已经画过：入场错峰只属于首屏（见 update 里的说明）
  let hasRendered = false;
  let currentItems = [];
  let selection = new Set();
  // 范围选择的锚点（Shift+点击的起点）
  let anchorIndex = null;
  // 收行后焦点该落到哪里：removeItem 记下（哪个操作、第几行），调用方在**对话框关闭之后**
  // 调 restoreFocus() 落地——模态期间文档是 inert 的，那时候 focus() 会被忽略。
  let pendingFocus = null;
  // 选择变化时也要知道「总数/是否在筛选中」，否则头部计数会被当前页长度覆盖
  // （实测缺陷：勾选任意一行后，「共 788 条记录」变成「共 50 条记录」）。
  let lastHead = { total: 0, filtered: false };

  function buildEmptyState({ filtered, search, recycle }) {
    const title = recycle ? '回收站是空的' : filtered ? '没有符合条件的记录' : '还没有任何记录';
    const hint = recycle
      ? '删除的记录会在这里保留 30 天：元数据仍在（可恢复的会给出「恢复」按钮），数据文件在删除时已被清除。'
      : filtered
        ? search
          ? `没有匹配「${search}」的记录。可以换个关键词，或清除筛选条件。`
          : '当前筛选条件下没有记录。可以清除筛选条件查看全部。'
        : '在任意设备上复制内容后，SyncClipboard 客户端会把它同步到这台服务器，记录会出现在这里。';
    const buttons = [];
    if (filtered || recycle) {
      buttons.push(
        el('button', { class: 'btn', type: 'button', onclick: () => actions.onClearFilters() }, [
          el('span', { class: 'btn__label', text: recycle ? '返回历史记录' : '清除筛选条件' }),
        ]),
      );
    }
    buttons.push(
      el('button', { class: 'btn btn--primary', type: 'button', onclick: () => actions.onInfo() }, [
        el('span', { class: 'btn__label', text: '如何配置客户端' }),
      ]),
    );

    return [
      svg(iconPaths('clipboard'), { size: 34, class: 'empty__icon' }),
      el('p', { class: 'empty__title', text: title }),
      el('p', { class: 'empty__hint', text: hint }),
      el('div', { class: 'empty__actions' }, buttons),
    ];
  }

  // 回收站视图：行内动作换成「恢复」，选择列照常渲染（批量恢复 / 清空回收站都要用它）
  let recycleMode = false;

  // 复选框（含 Shift 范围选择）。回收站里同样需要它：批量恢复与清空回收站都以选择集为入口。
  function buildCheckbox(item, index) {
    const checkbox = el('input', {
      class: 'checkbox',
      type: 'checkbox',
      'aria-label': `选择 ${item.type} ${item.hash.slice(0, 8)}`,
    });
    checkbox.checked = selection.has(item.key);
    // Shift+点击选择整段（起点是上一次点的那个复选框）：批量删除一条条勾是纯体力活。
    // 必须挂在 click（而不是 change）上：preventDefault 能挡住原生行为，change 就不会触发。
    checkbox.addEventListener('click', (event) => {
      if (event.shiftKey && anchorIndex !== null && anchorIndex !== index) {
        event.preventDefault();
        const from = Math.min(anchorIndex, index);
        const to = Math.max(anchorIndex, index);
        actions.onSelectRange(currentItems.slice(from, to + 1));
        return;
      }
      anchorIndex = index;
    });
    checkbox.addEventListener('change', () => actions.onSelect(item, checkbox.checked));
    return el('label', { class: 'check-wrap' }, [checkbox]);
  }

  function buildRow(item, index, animate, flashKeys) {
    const row = el('tr', {
      class: 'row',
      role: 'row',
      dataset: {
        key: item.key,
        selected: selection.has(item.key) ? 'true' : 'false',
        enter: animate && index < ENTER_STAGGER_LIMIT ? 'true' : 'false',
        flash: flashKeys.has(item.key) ? 'true' : 'false',
        deleted: item.isDeleted ? 'true' : 'false',
      },
    });
    if (animate && index < ENTER_STAGGER_LIMIT) row.style.setProperty('--row-index', String(index));
    // 类型色条：把类型写进行内变量，CSS 用它给 hover 时的左侧色条上色
    row.style.setProperty(
      '--row-accent',
      `var(--type-${item.type.toLowerCase()}, var(--accent))`,
    );

    const ref = { item };
    rowRefs.set(row, ref);

    const checkboxWrap = buildCheckbox(item, index);

    const preview = previewText(item);

    const body = el('div', { class: 'cell-content__body' }, [
      el('div', {
        class: `cell-content__text${previewIsEmpty(item) ? ' cell-content__text--empty' : ''}`,
        text: preview,
      }),
      buildFlags(item),
      // 窄屏专用的元信息行（类型 · 大小 · 时间）：桌面由独立列承担，故这里 display:none。
      // 放在内容单元内部（而不是单独一列）是为了让窄屏换行**确定**：
      // 单独成列时它和行内操作是否同行取决于 flex-basis 恰好放不放得下，
      // 于是 414 会比 375 更窄、Image 行（多一个按钮）又是另一种折行。
      el('div', { class: 'cell-content__meta' }, [
        el('span', { class: `chip ${typeChipClass(item.type)}` }, [
          el('span', { class: 'chip__dot' }),
          el('span', { text: typeLabel(item.type) }),
        ]),
        item.type === 'Text' ? null : el('span', { class: 'cell-content__meta-item', text: formatSize(item.size) }),
        el('span', {
          class: 'cell-content__meta-item',
          text: formatRelative(item.createTime),
          title: formatAbsolute(item.createTime),
        }),
      ]),
    ]);

    const content = el('div', { class: 'cell-content' }, [buildThumb(item), body].filter(Boolean));

    // 收藏 / 置顶：同一形状的开关按钮，只差图标、字段与文案。
    // 目标状态取**按下那一刻**的行数据（不是构建时的闭包值）——连点两次的第二次必须反向。
    function toggleButton(action) {
      const spec = TOGGLES[action];
      const on = Boolean(ref.item[spec.field]);
      const button = el(
        'button',
        {
          class: `icon-btn ${action}-btn`,
          type: 'button',
          dataset: { action },
          'aria-pressed': on ? 'true' : 'false',
          'aria-label': on ? spec.labels.on : spec.labels.off,
          title: on ? spec.labels.on : spec.labels.off,
          onclick: async () => {
            if (isPending(button)) return;
            const current = ref.item;
            setPending(button, true);
            try {
              await actions[action === 'star' ? 'onStar' : 'onPin'](current, !Boolean(current[spec.field]));
            } finally {
              setPending(button, false);
            }
          },
        },
        [svg(iconPaths(action))],
      );
      return button;
    }

    // 已删除的行没有这两个动作：收藏与置顶都是活跃记录的属性（回收站里只该有「恢复」）
    const flagButtons = item.isDeleted ? [] : [toggleButton('star'), toggleButton('pin')];

    // 三个时间列：创建 / 修改 / 访问。都是可排序表头（白名单见 src/ui/query.ts 的 SORT_COLUMNS），
    // 之前只有创建时间可点，另两个字段要手改 URL 才用得上。
    const timeCell = (className, value) =>
      el('td', { class: `cell-time ${className}`, role: 'cell' }, [
        el('span', { text: formatRelative(value), title: formatAbsolute(value) }),
      ]);

    const cells = [
      el('td', { class: 'col-check', role: 'cell' }, [checkboxWrap]),
      el('td', { class: 'col-type', role: 'cell' }, [
        el('span', { class: `chip ${typeChipClass(item.type)}` }, [
          el('span', { class: 'chip__dot' }),
          el('span', { text: typeLabel(item.type) }),
        ]),
      ]),
      el('td', { class: 'row__cell-content', role: 'cell' }, [content]),
      el('td', { class: 'col-size', role: 'cell' }, [el('span', { text: formatSize(item.size) })]),
      timeCell('col-created', item.createTime),
      timeCell('col-modified', item.lastModified),
      timeCell('col-accessed', item.lastAccessed),
      // 回收站里的行没有收藏/置顶动作（见 flagButtons）
      el('td', { class: 'col-star', role: 'cell' }, flagButtons),
      el('td', { class: 'col-actions', role: 'cell' }, [buildActions(item, actions)]),
    ];
    row.append(...cells.filter(Boolean));

    // 整行可点开预览：点在按钮/复选框/标签上时不触发；
    // 用户正在选文字（想手动复制）时也不触发——那一下点是在划线，不是在「打开」。
    row.addEventListener('click', (event) => {
      if (event.target.closest('button, input, a, label')) return;
      if ((window.getSelection()?.toString() ?? '') !== '') return;
      actions.onPreview(item);
    });

    return row;
  }

  function renderHead({ total, filtered, selection: selected }) {
    const hasSelection = selected.size > 0;
    headInfo.hidden = hasSelection;
    headSelection.hidden = !hasSelection;
    if (!hasSelection) {
      headInfo.textContent = recycleMode
        ? `回收站 · 共 ${total} 条`
        : filtered
          ? `筛选中 · 共 ${total} 条`
          : `共 ${total} 条记录`;
      return;
    }

    // 批量按钮的文案随选区**当前状态**反过来：选中的都已收藏时给的是「取消收藏」。
    // 固定写「收藏」会让用户对着已收藏的记录点一个看起来没反应的按钮（服务端确实写了一次，
    // 状态却不变）——这类「点了没反应」正是要避免的。
    const chosen = [...selected.values()];
    const batchButton = (action, label, icon, handler) =>
      el('button', { class: action === 'delete' ? 'btn btn--danger' : 'btn', type: 'button', onclick: handler }, [
        svg(iconPaths(icon), { size: 15 }),
        el('span', { class: 'btn__label', text: label }),
      ]);

    const buttons = recycleMode
      ? [
          batchButton('restore', '恢复选中', 'undo', () => actions.onBatchRestore()),
          batchButton('delete', '清空回收站', 'trash', () => actions.onEmptyTrash()),
        ]
      : [
          batchButton(
            'star',
            chosen.every((item) => item.starred) ? '取消收藏' : '收藏',
            'star',
            () => actions.onBatchFlag('star'),
          ),
          batchButton(
            'pin',
            chosen.every((item) => item.pinned) ? '取消置顶' : '置顶',
            'pin',
            () => actions.onBatchFlag('pin'),
          ),
          batchButton('delete', '删除选中', 'trash', () => actions.onBatchDelete()),
        ];

    headSelection.replaceChildren(
      el('span', { text: `已选 ${selected.size} 条` }),
      ...buttons,
      el('button', { class: 'btn btn--quiet', type: 'button', onclick: () => actions.onSelectAll(false) }, [
        el('span', { class: 'btn__label', text: '取消选择' }),
      ]),
    );
  }

  function syncSelectAll() {
    selectAll.checked = currentItems.length > 0 && currentItems.every((item) => selection.has(item.key));
    selectAll.indeterminate = !selectAll.checked && currentItems.some((item) => selection.has(item.key));
  }

  // 同一视图内的刷新：按 key 对账，只重建内容变化的行。
  // 未变化的行**不重建**——否则每 10 秒一次的轮询会重载缩略图、打断动画、丢掉焦点。
  function reconcile(items, flashKeys) {
    const wanted = new Set();
    const next = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      wanted.add(item.key);
      const sig = signature(item);
      const existing = rowByKey.get(item.key);
      if (existing && existing.dataset.sig === sig) {
        next.push(existing);
        continue;
      }
      const row = buildRow(item, index, false, flashKeys);
      row.dataset.sig = sig;
      if (existing) {
        // 内容变了（多半是别的设备改了这条）：闪一次说明「它刚被更新」
        row.dataset.flash = 'true';
        existing.remove();
      }
      rowByKey.set(item.key, row);
      next.push(row);
    }
    for (const [key, row] of [...rowByKey]) {
      if (wanted.has(key)) continue;
      row.remove();
      rowByKey.delete(key);
    }
    // 落位：只在顺序不对时插入（移动节点保留焦点，重建不保留）
    for (let index = 0; index < next.length; index += 1) {
      const current = tbody.children[index] ?? null;
      if (current !== next[index]) tbody.insertBefore(next[index], current);
    }
  }

  return {
    el: node,

    update(state) {
      const { items, total, filters, flashKeys } = state;
      selection = state.selection;
      recycleMode = Boolean(filters.deleted);

      // 入场错峰**只在首屏**（第一份非空结果）播一次，那是「页面来了」的一次性仪式；此后任何更新
      // （切类型、翻页、改筛选、轮询）都走按行对账：级联 12 行 × 40ms = 440ms 的尾巴在用户**已经在看
      // 这张表**时只会读成「内容慢半拍」，而且它要求整表重建（节点全新建）——实测（6× CPU 降速）
      // 这类切换一次要 250~350ms 主线程，去掉后 38ms。
      //
      // 判据不能用「视图标记变了」：boot 的顺序是 `render()`（items 还是空的）→ `refresh()`，
      // 两次的 token 相同，首屏会被自己吃掉（复核发现过一次同类问题——`hasRendered` 无条件置位）。
      const firstPaint = !hasRendered && items.length > 0;
      if (items.length > 0) hasRendered = true;
      currentItems = items;

      if (firstPaint) {
        // 首屏：整表重建并错峰入场——这时「整块换掉」正是要表达的
        tbody.replaceChildren();
        rowByKey.clear();
        const flash = flashKeys ?? new Set();
        for (let index = 0; index < items.length; index += 1) {
          const row = buildRow(items[index], index, true, flash);
          row.dataset.sig = signature(items[index]);
          rowByKey.set(items[index].key, row);
          tbody.append(row);
        }
      } else {
        reconcile(items, flashKeys ?? new Set());
      }

      const filtered =
        filters.types !== 'All' ||
        filters.starred ||
        filters.search !== '' ||
        filters.range !== 'all' ||
        filters.deleted;
      empty.hidden = items.length > 0;
      table.hidden = items.length === 0;
      if (items.length === 0) {
        empty.replaceChildren(
          ...buildEmptyState({ filtered, search: filters.search, recycle: recycleMode }),
        );
      }

      syncSelectAll();

      for (const [field, arrow] of sortArrows) {
        const isActive = filters.sort === field;
        // aria-sort 属于表头单元格（th），不是按钮——指示器样式也从 th 出发（components.css）
        arrow
          .closest('th')
          ?.setAttribute('aria-sort', isActive ? (filters.order === 'asc' ? 'ascending' : 'descending') : 'none');
      }

      lastHead = { total, filtered };
      renderHead({ total, filtered, selection });
    },

    // 初次加载失败：不能把骨架屏留在那里（那就是「无限骨架」），要给出可操作的错误态。
    // 已经有内容时不用它——那种情况下保留旧数据 + 一条提示比清空更正确。
    showError(message, onRetry) {
      table.hidden = true;
      empty.hidden = false;
      empty.replaceChildren(
        svg(iconPaths('warning'), { size: 34, class: 'empty__icon' }),
        el('p', { class: 'empty__title', text: '加载失败' }),
        el('p', { class: 'empty__hint', text: message }),
        el('div', { class: 'empty__actions' }, [
          el('button', { class: 'btn btn--primary', type: 'button', onclick: onRetry }, [
            el('span', { class: 'btn__label', text: '重试' }),
          ]),
        ]),
      );
    },

    // 选择变化只改受影响的行：整表重建会让滚动位置与动画每次都重来
    updateSelection(nextSelection) {
      selection = nextSelection;
      for (const [key, row] of rowByKey) {
        const selected = selection.has(key);
        row.dataset.selected = selected ? 'true' : 'false';
        const checkbox = row.querySelector('.checkbox');
        if (checkbox && checkbox.checked !== selected) checkbox.checked = selected;
      }
      syncSelectAll();
      renderHead({ total: lastHead.total, filtered: lastHead.filtered, selection });
    },

    // 写操作结果就地更新该行：不重拉整页，也不重建行——重建会丢掉焦点，
    // 而键盘用户刚按下的那个开关正是焦点所在。
    // `pop` 指定要重放动画的那个开关（'star' | 'pin'），其余情况不动画。
    patchItem(item, { pop = null } = {}) {
      const row = rowByKey.get(item.key);
      if (!row) return;
      const ref = rowRefs.get(row);
      if (ref) ref.item = item;
      row.dataset.sig = signature(item);
      for (const [action, spec] of Object.entries(TOGGLES)) {
        const button = row.querySelector(`[data-action="${action}"]`);
        if (button) applyToggleState(button, Boolean(item[spec.field]), spec.labels);
      }
      // 徽标（置顶/数据可用性/长文本）也要跟着变：置顶按钮按下后，徽标不该等到下一次轮询才出现
      const flags = row.querySelector('.cell-content__flags');
      if (flags) flags.replaceWith(buildFlags(item));
      if (pop) playPop(row.querySelector(`[data-action="${pop}"]`));
      const index = currentItems.findIndex((entry) => entry.key === item.key);
      if (index >= 0) currentItems[index] = item;
    },

    // 删除成功后立刻把行收掉：等下一次整页刷新再消失，读起来是「点了没反应」。
    // 后续的静默刷新会对账剩下的行（并补齐本页缺的一条）。
    // 焦点不在**这里**交接：删除都要过确认对话框，收行时焦点还在对话框里、文档是 inert 的，
    // 这时候 focus() 会被忽略。这里只记下「哪个操作、第几行」，由调用方在对话框关闭后
    // 调 restoreFocus() 落地。
    removeItem(key) {
      const row = rowByKey.get(key);
      if (!row) return;
      const index = currentItems.findIndex((item) => item.key === key);
      // 来源优先取「按下时记下的操作」（对话框是模态的，那一刻的焦点已经不可靠）；
      // 没有对话框的场景（例如将来从别处收行）再看当前焦点是否还在这行里。
      const focusedInRow = row.contains(document.activeElement)
        ? (document.activeElement.closest('[data-action]')?.dataset.action ?? null)
        : null;
      const originAction = lastRowAction?.key === key ? lastRowAction.action : focusedInRow;
      pendingFocus = { action: originAction, index };

      rowByKey.delete(key);
      currentItems = currentItems.filter((item) => item.key !== key);
      const drop = () => row.remove();
      row.dataset.leaving = 'true';
      row.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 240); // 兜底：reduced-motion 或动画被跳过时也要收掉
      lastHead = { ...lastHead, total: Math.max(0, lastHead.total - 1) };
      if (currentItems.length === 0) {
        table.hidden = true;
        empty.hidden = false;
      }
      syncSelectAll();
      renderHead({ total: lastHead.total, filtered: lastHead.filtered, selection });
    },

    // 把焦点交回结果区（调用方在确认对话框**关闭之后**调用）。
    // 目标链：相邻行里的同一个操作 → 空状态的主按钮 → 表头全选框。
    // 不做这件事的后果是实测过的：焦点随被移除的按钮一起消失、落到 <body>，
    // 键盘用户得从页面开头重新 Tab。
    restoreFocus() {
      if (!pendingFocus) return;
      const { action, index } = pendingFocus;
      pendingFocus = null;
      const survivors = [...tbody.children].filter((row) => row.dataset.leaving !== 'true');
      const neighbor = survivors[index] ?? survivors[index - 1] ?? null;
      const target =
        (action ? neighbor?.querySelector(`[data-action="${action}"]`) : null) ??
        (empty.hidden ? null : empty.querySelector('button')) ??
        selectAll;
      if (!target) return;
      // 落点必须**晚于**对话框的焦点还原：那是浏览器关闭模态时的补焦步骤（还回去的元素——
      // 行内删除按钮——已被移除，于是焦点先落到 viewport，实测 1–2ms 后又变一次）。
      // 而且 rAF 不能用来重试：headless 与后台标签页里它不会连续触发（实测只跑到第一帧）。
      // 故在**删除确认后的固定窗口内**用定时器反复落点（上限 ~0.5s），一旦落地就停手。
      // 判据不能用「焦点在别的元素上就停」——实测那一刻焦点可能还停在正在关闭的对话框里。
      let rounds = 0;
      const place = () => {
        if (!target.isConnected) return;
        // 「上一轮落下之后**留住了**」才算成功：不能在 focus() 之后立刻判成功——
        // 浏览器的补焦晚 1–2ms 到（实测：focus() 成功的同一毫秒内就被 focusout 夺走）。
        if (document.activeElement === target) return;
        target.focus();
        rounds += 1;
        if (rounds < 8) setTimeout(place, 60);
      };
      setTimeout(place, 0);
    },
  };
}
