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
import { formatRelative, formatAbsolute, formatSize, previewText, typeLabel, typeChipClass } from '../format.js';
import { itemIsImage } from '../clipboard.js';
import { setPending, flashSuccess, isPending } from './toast.js';

const ENTER_STAGGER_LIMIT = 12; // 超过 12 行就不再错峰：延迟累积会让第 50 行等两秒

// 行的「内容签名」：只有这些字段变了才需要重建该行。
// 不含 createdTime 这类只影响展示格式、由服务端保证不变的字段。
function signature(item) {
  return [
    item.type,
    item.starred,
    item.pinned,
    item.size,
    item.hasData,
    item.textTruncated,
    item.dataName ?? '',
    item.text ?? '',
  ].join('\u0001');
}

// 行 → 该行当前的 item 与可变引用（收藏状态在行内就地更新，闭包不能拿旧对象）
const rowRefs = new WeakMap();

function buildThumb(item) {
  if (item.type !== 'Image') return null;

  if (!item.hasData) {
    return el('div', { class: 'cell-content__thumb cell-content__thumb--missing', title: '服务器上没有这条记录的图片数据' }, [
      svg(iconPaths('warning'), { size: 16 }),
    ]);
  }

  const image = el('img', {
    class: 'cell-content__thumb',
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    src: `/ui/api/history/${encodeURIComponent(item.type)}/${encodeURIComponent(item.hash)}/data`,
  });
  image.addEventListener('error', () => {
    // 记录说 hasData，但对象已被清理（线上真实存在这种记录）——换成可读状态
    image.replaceWith(
      el('div', { class: 'cell-content__thumb cell-content__thumb--missing', title: '数据不可用：文件已不在服务器上' }, [
        svg(iconPaths('warning'), { size: 16 }),
      ]),
    );
  });
  return image;
}

function buildFlags(item) {
  const flags = [];
  if (item.pinned) flags.push(el('span', { class: 'chip chip--neutral' }, [svg(iconPaths('pin'), { size: 11 }), el('span', { text: '置顶' })]));
  // 防御性分支：服务端拒绝写入「非 Text 且没有传输数据」的 Profile（profile.ts 的
  // `Transfer data is required for …`），因此**当前数据不变量下不可达**（实测线上 + 本地
  // 226 条非 Text 记录中 hasData=false 为 0 条）。保留是因为 hasData 由服务端推导、
  // 类型上允许为假，且历史上（F26 修复前）确实产生过这类行——真出现时不该渲染成可下载。
  if (!item.hasData && item.type !== 'Text') {
    flags.push(el('span', { class: 'chip chip--warn', text: '数据不可用' }));
  } else if (item.type === 'Text' && item.hasData) {
    flags.push(el('span', { class: 'chip chip--neutral', text: '含数据文件' }));
  }
  if (item.textTruncated) flags.push(el('span', { class: 'chip chip--neutral', text: '长文本' }));
  return flags.length ? el('div', { class: 'cell-content__flags' }, flags) : null;
}

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
        setPending(button, true);
        try {
          const ok = await run();
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

function applyStarState(button, starred) {
  const label = starred ? '取消收藏' : '收藏';
  button.setAttribute('aria-pressed', starred ? 'true' : 'false');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

// 重放收藏动画：同一个 data-pop 属性不会重启动画，故先删、强制回流、再置上。
function playStarPop(button) {
  const icon = button.querySelector('svg');
  if (!icon) return;
  delete button.dataset.pop;
  void button.offsetWidth;
  button.dataset.pop = 'true';
  icon.addEventListener('animationend', () => delete button.dataset.pop, { once: true });
}

function buildActions(item, actions, ref) {
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
    const button = el('button', {
      class: 'th-sort',
      type: 'button',
      title: '排序',
      onclick: () => actions.onSort(field),
    }, [el('span', { text: label }), arrow]);
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
        sortableHeader('时间', 'createTime', 'col-time'),
        el('th', { class: 'col-star', scope: 'col', role: 'columnheader' }, [el('span', { class: 'sr-only', text: '收藏' })]),
        el('th', { class: 'col-actions', scope: 'col', role: 'columnheader' }, [el('span', { class: 'sr-only', text: '操作' })]),
      ]),
    ]),
    tbody,
  ]);

  const empty = el('div', { class: 'empty', hidden: true });
  const node = el('section', { class: 'results', 'aria-label': '剪贴板历史' }, [head, table, empty]);

  const rowByKey = new Map();
  let lastViewToken = null;
  let currentItems = [];
  let selection = new Set();
  // 范围选择的锚点（Shift+点击的起点）
  let anchorIndex = null;
  // 选择变化时也要知道「总数/是否在筛选中」，否则头部计数会被当前页长度覆盖
  // （实测缺陷：勾选任意一行后，「共 788 条记录」变成「共 50 条记录」）。
  let lastHead = { total: 0, filtered: false };

  function buildEmptyState({ filtered, search }) {
    const title = filtered ? '没有符合条件的记录' : '还没有任何记录';
    const hint = filtered
      ? search
        ? `没有匹配「${search}」的记录。可以换个关键词，或清除筛选条件。`
        : '当前筛选条件下没有记录。可以清除筛选条件查看全部。'
      : '在任意设备上复制内容后，SyncClipboard 客户端会把它同步到这台服务器，记录会出现在这里。';
    const buttons = [];
    if (filtered) {
      buttons.push(
        el('button', { class: 'btn', type: 'button', onclick: () => actions.onClearFilters() }, [
          el('span', { class: 'btn__label', text: '清除筛选条件' }),
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

  function buildRow(item, index, animate, flashKeys) {
    const row = el('tr', {
      class: 'row',
      role: 'row',
      dataset: {
        key: item.key,
        selected: selection.has(item.key) ? 'true' : 'false',
        enter: animate && index < ENTER_STAGGER_LIMIT ? 'true' : 'false',
        flash: flashKeys.has(item.key) ? 'true' : 'false',
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
    const checkboxWrap = el('label', { class: 'check-wrap' }, [checkbox]);

    const body = el('div', { class: 'cell-content__body' }, [
      el('div', {
        class: `cell-content__text${previewText(item) === '（空文本）' ? ' cell-content__text--empty' : ''}`,
        text: previewText(item),
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

    const starButton = el(
      'button',
      {
        class: 'icon-btn star-btn',
        type: 'button',
        dataset: { action: 'star' },
        'aria-pressed': item.starred ? 'true' : 'false',
        'aria-label': item.starred ? '取消收藏' : '收藏',
        title: item.starred ? '取消收藏' : '收藏',
        onclick: async () => {
          if (isPending(starButton)) return;
          const current = ref.item;
          setPending(starButton, true);
          try {
            await actions.onStar(current, !current.starred);
          } finally {
            setPending(starButton, false);
          }
        },
      },
      [svg(iconPaths('star'))],
    );

    const timeCell = el('td', { class: 'cell-time', role: 'cell' }, [
      el('span', { text: formatRelative(item.createTime), title: formatAbsolute(item.createTime) }),
    ]);

    row.append(
      el('td', { class: 'col-check', role: 'cell' }, [checkboxWrap]),
      el('td', { class: 'col-type', role: 'cell' }, [
        el('span', { class: `chip ${typeChipClass(item.type)}` }, [
          el('span', { class: 'chip__dot' }),
          el('span', { text: typeLabel(item.type) }),
        ]),
      ]),
      el('td', { class: 'row__cell-content', role: 'cell' }, [content]),
      el('td', { class: 'col-size', role: 'cell' }, [el('span', { text: formatSize(item.size) })]),
      timeCell,
      el('td', { class: 'col-star', role: 'cell' }, [starButton]),
      el('td', { class: 'col-actions', role: 'cell' }, [buildActions(item, actions, ref)]),
    );

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
      headInfo.textContent = filtered ? `筛选中 · 共 ${total} 条` : `共 ${total} 条记录`;
      return;
    }
    headSelection.replaceChildren(
      el('span', { text: `已选 ${selected.size} 条` }),
      el('button', { class: 'btn btn--danger', type: 'button', onclick: () => actions.onBatchDelete() }, [
        svg(iconPaths('trash'), { size: 15 }),
        el('span', { class: 'btn__label', text: '删除选中' }),
      ]),
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
      const { items, total, filters, viewToken, flashKeys } = state;
      selection = state.selection;
      currentItems = items;

      const animate = viewToken !== lastViewToken;
      lastViewToken = viewToken;

      if (animate) {
        // 新视图（首次/翻页/改筛选）：整表重建并错峰入场——这时「整块换掉」正是要表达的
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

      const filtered = filters.types !== 'All' || filters.starred || filters.search !== '';
      empty.hidden = items.length > 0;
      table.hidden = items.length === 0;
      if (items.length === 0) {
        empty.replaceChildren(...buildEmptyState({ filtered, search: filters.search }));
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

    // 收藏结果就地更新该行：不重拉整页，也不重建行——重建会丢掉焦点，
    // 而键盘用户刚按下的那个星标正是焦点所在。
    patchItem(item, { pop = false } = {}) {
      const row = rowByKey.get(item.key);
      if (!row) return;
      const ref = rowRefs.get(row);
      if (ref) ref.item = item;
      row.dataset.sig = signature(item);
      const star = row.querySelector('[data-action="star"]');
      if (star) {
        applyStarState(star, !!item.starred);
        if (pop) playStarPop(star);
      }
      const index = currentItems.findIndex((entry) => entry.key === item.key);
      if (index >= 0) currentItems[index] = item;
    },

    // 删除成功后立刻把行收掉：等下一次整页刷新再消失，读起来是「点了没反应」。
    // 后续的静默刷新会对账剩下的行（并补齐本页缺的一条）。
    removeItem(key) {
      const row = rowByKey.get(key);
      if (!row) return;
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
  };
}
