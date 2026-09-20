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
import { DEFAULT_FILTERS } from '../filters.js';

const ENTER_STAGGER_LIMIT = 12; // 超过 12 行就不再错峰：延迟累积会让第 50 行等两秒

// 骨架的行数区间。上限 50 与 V2 的 `board.js` 同源：行数只需把折线以下的内容先推开，
// 而 50 行（表格档 50 × 47px；卡片档 50 × 103px）都远超任何视口，每页 500 行时画 500 条骨架没有意义；
// 下限 3 是"页面看起来在加载"的最小量。行数**必须**贴近真实页大小，理由见 renderSkeletonRows。
const SKELETON_MAX_ROWS = 50;
const SKELETON_MIN_ROWS = 3;

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

// 行的「内容签名」存在 WeakMap 里，**不做 DOM 属性**：签名里含最多 500 字符的正文，
// 500 行的页面就是每 10 秒重建 ~250 KB 字符串 + 各写一遍属性（属性写入是真实 DOM 变更）。
// WeakMap 的键就是行节点，行被移除时条目自动回收，判据与原来的 `dataset.sig` 完全一致
// （全仓没有任何 CSS/探针读它，故这一层可以安全地藏进内存）。
const rowSignatures = new WeakMap();

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

// 固定槽位的占位：某个动作对这一行不适用时，用一个等宽的 span 把位置占住。
// 为什么是 `<span aria-hidden>` 而不是 `visibility: hidden` 的按钮：前者从一开始就不在
// 可访问性树里、不可聚焦、不响应指针，语义上就是"这里什么都没有"；后者要靠 CSS 才能
// 达到同样效果，而 `visibility` 一旦被某条媒体查询改回来就会多出一个不可用的按钮。
function actionSlot(button) {
  return button ?? el('span', { class: 'row-actions__slot', 'aria-hidden': 'true' });
}

function buildActions(item, actions) {
  // 回收站里的行只做一件事：恢复。能否恢复由**服务端的守卫**决定——已删除且数据文件名为空
  // （transferDataFile === ''）才允许把 IsDeleted 置回 0；带数据文件的记录在软删时已清掉数据，
  // 服务端会返回 404，故这里直接禁用并说明原因，不让用户白点一次。
  if (item.isDeleted) {
    // 回收站同样用四个槽位，但"恢复"固定在**槽 1**（与活跃视图的"预览"同位）：
    // `.row-actions` 是 `justify-content: flex-end`，只放一个按钮的话它会贴到最右 ——
    // 那正是活跃视图里"删除"所在的位置，肌肉记忆会在切换视图后一次误按就把记录恢复出去。
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
      actionSlot(null),
      actionSlot(null),
      actionSlot(null),
    ]);
  }

  // ===== 四个**固定槽位**：预览 / 复制 / 下载 / 删除（2026-09-18）=====
  // 此前动作是按类型追加的（文本 3 个、图片 4 个），又整体右对齐 —— 于是"下载在哪一列"
  // 逐行不同：鼠标沿行间下移时按钮在跳，每次都要重新找。现在槽位恒定，该类记录没有的
  // 动作放一个等宽占位（`.row-actions__slot`：span，不进可访问性树、不可聚焦）。
  const preview = actionButton({
    action: 'preview',
    label: '预览',
    icon: 'eye',
    run: () => actions.onPreview(item),
  });

  // 图片（或文件名是图片的 File/Group）可以复制到系统剪贴板——clipserver 的行内复制即按此分发
  const copy =
    item.type === 'Text'
      ? actionButton({
          action: 'copy',
          // 文案统一（2026-09-18）：动作标签一律"动词 + 对象"——复制文本 / 复制图片 /
          // 复制地址 / 复制选中。此前同一件事有三个名字（行内"复制内容"、预览里"复制全文"、
          // 部署信息里"复制"），读者会以为是三种不同的行为。
          label: '复制文本',
          icon: 'copy',
          run: () => actions.onCopy(item),
          successLabel: '已复制',
        })
      : itemIsImage(item)
        ? actionButton({
            action: 'copy-image',
            label: '复制图片',
            icon: 'copy',
            run: () => actions.onCopyImage(item),
            successLabel: '已复制',
            disabled: !item.hasData,
            title: item.hasData ? '复制图片' : '数据不可用，无法复制',
          })
        : null;

  // 文本也能下载（2026-09-18，用户要求："文本也可以下载"；同日追加："有原文件时保留原扩展名"）。
  // 第 3 槽对 Text 行**恒满**，四槽固定布局在这一列里不再有空洞。
  // 名字随产物走（动作标签一律"动词 + 对象"）：
  //   · 有数据文件 → 「下载」：取回的是服务端那个**原文件**（原字节 + 原扩展名）；
  //   · 内联文本   → 「下载文本」：对象存储里根本没有它，产物是正文生成的 `.txt`。
  const download =
    item.type === 'Text'
      ? actionButton({
          action: 'download',
          label: item.hasData ? '下载' : '下载文本',
          icon: 'download',
          run: () => actions.onDownloadText(item),
          successLabel: '已下载',
        })
      : actionButton({
          action: 'download',
          label: '下载',
          icon: 'download',
          run: () => actions.onDownload(item),
          successLabel: '已下载',
          disabled: !item.hasData,
          title: item.hasData ? '下载' : '数据不可用，无法下载',
        });

  const remove = actionButton({
    action: 'delete',
    label: '删除',
    icon: 'trash',
    run: () => actions.onDelete(item),
  });

  return el('div', { class: 'row-actions' }, [
    preview,
    actionSlot(copy),
    actionSlot(download),
    remove,
  ]);
}

export function createList(actions) {
  const headInfo = el('span', { class: 'results__count' });
  // 一键复位筛选（2026-09-18）：此前"清除筛选条件"只在**空结果**的空状态里给 ——
  // 有结果、但只是筛得太窄时，用户只能逐项点掉（类型/收藏/时间范围…）。
  // 只在真的有筛选时出现（排序不算筛选：它不改变结果集，只改变顺序）。
  //
  // 2026-09-18 用户反馈"清除筛选按钮明显点"：此前是 `.btn--quiet`（透明底 + 次要色），
  // 和紧挨着的「筛选中 · 共 N 条」是同一种颜色、又没有边框 —— 读起来像那句说明的后半截，
  // 不像一个能按的东西。改成默认 `.btn`（有描边、正文色）：① 一眼是按钮；
  // ② 与**空状态里同一个动作**的按钮长得一样（那里本来就是 `.btn`）——
  // 同一个动作在两处两种强度，是这套界面一直在避免的事。
  const headClear = el(
    'button',
    {
      class: 'btn results__clear',
      type: 'button',
      hidden: true,
      onclick: () => actions.onClearFilters(),
    },
    [svg(iconPaths('close'), { size: 14 }), el('span', { class: 'btn__label', text: '清除筛选' })],
  );
  const headSelection = el('div', { class: 'results__selection', hidden: true });
  const head = el('div', { class: 'results__head' }, [headInfo, headClear, headSelection]);

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

  // 行间方向键（↓/↑/Home/End）：把焦点送到相邻行的**同一个控件**。
  //
  // 为什么需要：活跃视图一行**最多 7 个**可聚焦控件（复选框 + 至多 4 个行内动作 + 收藏/置顶），
  // 一页 50 行就是最多 350 个 Tab 停靠点 ——
  // 从第 1 行走到底部要按上百次 Tab。方向键是**纯增量**：Tab 顺序一个不动
  // （这一点与 V2 的做法一致，V2 也是"加方向键"而不是 roving tabindex）。
  //
  // 委托在 tbody 上而不是每行挂一个监听器：50 行就是 50 个监听器，而这里是同一个行为。
  // 带修饰键（Shift/Ctrl/Alt/Meta）一律让路：Shift+方向键是选文字，不是导航。
  {
    const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);
    tbody.addEventListener('keydown', (event) => {
      if (!NAV_KEYS.has(event.key)) return;
      if (event.defaultPrevented || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const control = event.target.closest?.('button, input, label');
      const row = control?.closest('tr.row');
      if (!row || row.dataset.leaving === 'true') return;
      const rows = [...tbody.children].filter((entry) => entry.dataset.leaving !== 'true');
      const index = rows.indexOf(row);
      if (index < 0) return;
      const targetIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : event.key === 'ArrowDown'
              ? index + 1
              : index - 1;
      // 到边界就吞掉这次按键（否则页面会跟着滚，读起来像"方向键坏了"）
      if (targetIndex < 0 || targetIndex >= rows.length) {
        event.preventDefault();
        return;
      }
      const next = rows[targetIndex];
      // 定位"同一个控件"：动作按钮按 data-action 找。**四个槽位是固定的**
      // （预览 / 复制 / 下载 / 删除，见 `buildActions`），回收站行则是"恢复"固定在槽 1
      // 另加三个等宽占位 —— 所以同一动作在每行的位次一致，跨行找得到。
      // （这里此前写的是"文本行是 预览/复制/删除，图片行还多一个下载"，那是固定槽位之前的行为。）
      // 找不到就退回该行的第一个控件。
      const selector = control.matches('[data-action]')
        ? `[data-action="${control.dataset.action}"]`
        : control.matches('.checkbox')
          ? '.checkbox'
          : null;
      const target = (selector ? next.querySelector(selector) : null) ?? next.querySelector('button, input');
      if (!target) return;
      event.preventDefault();
      target.focus();
    });
  }

  const table = el('table', { class: 'table', role: 'table' }, [
    el('thead', { role: 'rowgroup' }, [
      el('tr', { role: 'row' }, [
        el('th', { class: 'col-check', scope: 'col', role: 'columnheader' }, [selectAllWrap]),
        // 窄屏排序条的引导词（桌面 display: none）。卡片模式下这一行不再是"列名"，
        // 而是一条排序工具条——没有这几个字，一排「类型 大小 创建」会被读成
        // 与下方卡片无关的表头（实测截图里正是这个观感）。
        el('th', { class: 'col-sort-hint', scope: 'col', role: 'columnheader' }, [
          el('span', { text: '排序' }),
        ]),
        sortableHeader('类型', 'type', 'col-type'),
        el('th', { class: 'col-content', scope: 'col', role: 'columnheader' }, [el('span', { text: '内容' })]),
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
  // 骨架：数据还没落地时的占位。`role="status"` 而不是 `alert`——它是一段持续状态，
  // 不该在读屏里抢断（与失联横幅同一条判据，见 main.js 的 setStale）。
  const skeleton = el('div', {
    class: 'skeleton',
    role: 'status',
    'aria-label': '正在加载剪贴板历史',
  });
  const node = el('section', { class: 'results', 'aria-label': '剪贴板历史' }, [
    head,
    table,
    empty,
    skeleton,
  ]);

  // 结果区同一时刻只有一种形态：骨架 / 表格 / 空态（错误态复用空态的容器）。
  // 三者的显隐集中在**这一处**：此前分散在 update() 与 showError() 里各写一遍，
  // 而那正是"骨架还挂着、表格已经出来"这类并存状态的来源。
  function setView(view) {
    skeleton.hidden = view !== 'loading';
    table.hidden = view !== 'table';
    empty.hidden = view !== 'empty';
  }

  // 初始就是加载中：组件被建出来的那一刻数据必然还没到，把这件事写死在这里，
  // 就不必依赖"外层一定会先调一次 render()"这个约定（那是一次隐式的时序依赖）。
  // 骨架的**行**由首帧的 update() 画（`renderSkeletonRows` 需要知道每页条数）。
  setView('loading');

  // 画骨架行。行数按**当前页大小**给 —— 这不是审美取舍，是布局正确性：
  // 骨架行高与真实行同高（`.skeleton__row` 的高度：表格档绑 `.table td`、卡片档绑
  // `.table tr.row` 的盒模型，两处推导都在 components.css），
  // 行数又贴近真实页大小，于是内容落地时折线以上的内容**一点不动**。
  // 反例是 V2 实测过的（A-02）：6 行骨架（384px）对 50 行真实表（3930px），
  // 内容一到，页脚与分页从视口里被整段顶出去 —— CLS 0.90。
  function renderSkeletonRows(pageSize) {
    const requested = Number(pageSize) || DEFAULT_FILTERS.pageSize;
    const rows = Math.min(SKELETON_MAX_ROWS, Math.max(SKELETON_MIN_ROWS, requested));
    // 行数没变就不重建：重建会让 CSS 动画从头播一次，骨架跟着闪一下
    if (skeleton.childElementCount === rows) return;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < rows; index += 1) {
      fragment.append(el('div', { class: 'skeleton__row' }));
    }
    skeleton.replaceChildren(fragment);
  }

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
          // 文案与结果区头栏那个一键复位**逐字一致**（2026-09-18）：同一个动作在同一屏两处
          // 两个名字（"清除筛选条件" vs "清除筛选"）会让人以为是两件事。
          el('span', { class: 'btn__label', text: recycle ? '返回历史记录' : '清除筛选' }),
        ]),
      );
    }
    buttons.push(
      el('button', { class: 'btn btn--primary', type: 'button', onclick: () => actions.onInfo() }, [
        el('span', { class: 'btn__label', text: '如何配置客户端' }),
      ]),
    );

    return [
      svg(iconPaths('clipboard'), { size: 32, class: 'empty__icon' }),
      el('p', { class: 'empty__title', text: title }),
      el('p', { class: 'empty__hint', text: hint }),
      el('div', { class: 'empty__actions' }, buttons),
    ];
  }

  // 回收站视图：行内动作换成「恢复」，选择列照常渲染（批量恢复 / 清空回收站都要用它）
  let recycleMode = false;
  // 最近一次 `update()` 收到的 filters：`removeItem()` 收掉本页最后一行时也要用它（空态文案由
  // 「是否处于筛选态」决定）。此前这份判断只在 `update()` 里内联算过一次，收行那条出口就漏了。
  let lastFilters = null;

  // 当前视图是否处于筛选态 —— 空态的文案与按钮由它决定（"没有匹配…" 还是 "还没有记录"）。
  function isFiltered(filters) {
    return (
      filters.types !== 'All' ||
      filters.starred ||
      filters.search !== '' ||
      filters.range !== 'all' ||
      filters.deleted
    );
  }

  // 复选框（含 Shift 范围选择）。回收站里同样需要它：批量恢复与清空回收站都以选择集为入口。
  //
  // 入参是那一行的**可变引用**（`rowRefs` 里那个），不是构建时的 `item`：行内开关（收藏/置顶）
  // 成功后就地改的是 `ref.item`，而这个闭包如果一直抓着旧对象，之后勾选这一行就会把**旧快照**
  // 存进选择集 —— 选择条的方向与文案随之按旧值算（"已置顶的记录点置顶没反应"就是这么来的）。
  function buildCheckbox(ref, index) {
    const item = ref.item; // 这里只用它读 key / type / hash 这些**不随写入变化**的字段
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
    checkbox.addEventListener('change', () => actions.onSelect(ref.item, checkbox.checked));
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

    const checkboxWrap = buildCheckbox(ref, index);

    const preview = previewText(item);

    const body = el('div', { class: 'cell-content__body' }, [
      // 正文与徽标**同一行**（`.cell-content__line`），而不是上下两行。
      // 原因见 components.css 的 .cell-content__line：堆叠时「文本 19 + 2 + 徽标 22 = 43」
      // 会超过行高基线（53 = 32 + 20 内边距 + 1 边框），把那一行撑到 64px；
      // 折成两行时是 83px —— 于是同一张表出现 4 种行高。
      el('div', { class: 'cell-content__line' }, [
        el('div', {
          class: `cell-content__text${previewIsEmpty(item) ? ' cell-content__text--empty' : ''}`,
          text: preview,
        }),
        buildFlags(item),
      ]),
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

  function renderHead({ total, filtered, selection: selected, loading = false }) {
    const hasSelection = selected.size > 0;
    headInfo.hidden = hasSelection;
    headSelection.hidden = !hasSelection;
    if (!hasSelection) {
      // 「共 0 条记录」在首屏是一句**假话**（还没到 ≠ 一条都没有），故加载态单独一档。
      // 文案与 V2 的 board.js 同形（那边是「… 正在加载」）。
      headInfo.textContent = loading
        ? '正在加载…'
        : recycleMode
          ? `回收站 · 共 ${total} 条`
          : filtered
            ? `筛选中 · 共 ${total} 条`
            : `共 ${total} 条记录`;
      // 有筛选时才给"一键复位"；选中态那一行已被批量按钮占满，故那时也收起
      headClear.hidden = !filtered;
      return;
    }
    headClear.hidden = true;

    // 批量按钮的文案随选区**当前状态**反过来：选中的都已收藏时给的是「取消收藏」。
    // 固定写「收藏」会让用户对着已收藏的记录点一个看起来没反应的按钮（服务端确实写了一次，
    // 状态却不变）——这类「点了没反应」正是要避免的。
    const chosen = [...selected.values()];
    const batchButton = (action, label, icon, handler) =>
      // 销毁性动作（删除选中 / 清空回收站）用**填色红**，与"取消选择"等中性按钮分开。
      // 2026-09-18 统一：此前 V1 有两档危险样式（描边红 `--danger` 与填色红 `--danger-solid`），
      // 同一个动作在"选择条"里是描边、在它弹出的确认框里是填色，看起来像两个不同的动作；
      // V2 本来就只有一档（填色），现在 V1 也是。
      el(
        'button',
        {
          class: action === 'delete' ? 'btn btn--danger-solid' : 'btn',
          type: 'button',
          // 进行中态 + 重入守卫（2026-09-18）：批量复制可能发 N 个分片请求（每片 100 条），
          // 批量写也要逐条走服务端 —— 没有 pending 态的按钮在这几秒里读起来就是"点了没反应"。
          // `isPending` 那道守卫与确认框同一个理由：`pointer-events: none` 只挡鼠标、挡不住键盘 Enter。
          onclick: async (event) => {
            const button = event.currentTarget;
            if (isPending(button)) return;
            setPending(button, true);
            try {
              await handler();
            } finally {
              // 批量成功后选择集被清空、这条按钮随之被移除：对已 detach 的节点收尾是无害的
              setPending(button, false);
            }
          },
        },
        [svg(iconPaths(icon), { size: 16 }), el('span', { class: 'btn__label', text: label })],
      );

    const buttons = recycleMode
      ? [
          batchButton('restore', '恢复选中', 'undo', () => actions.onBatchRestore()),
          batchButton('delete', '清空回收站', 'trash', () => actions.onEmptyTrash()),
        ]
      : [
          // 复制在最前：它是这个页面最高频的动作（与工具栏把搜索放最前是同一条理由）。
          batchButton('copy', '复制选中', 'copy', () => actions.onBatchCopy()),
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
      if (existing && rowSignatures.get(existing) === sig) {
        next.push(existing);
        continue;
      }
      const row = buildRow(item, index, false, flashKeys);
      rowSignatures.set(row, sig);
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

      // 「还没到」与「真的没有」是两件事（2026-09-18 修）。
      // 此前没有这一档：`items.length === 0` 同时充当这两个含义，于是从 boot 到首屏那次
      // `refresh()` 落地之间的整段时间（真机上是几百毫秒到数秒），界面都在断言
      // 「还没有任何记录」—— 库里明明有一千多条。库里的记录越多，这句假话越刺眼。
      // 顺带修掉同一个来源的第二处：结果区头栏那时写的是「共 0 条记录」。
      //
      // 判据放在视图层、而不是各调用点：任何路径只要没把 loading 收掉，画出来的就是骨架，
      // 而不是一个伪造的空状态。
      if (state.loading && items.length === 0) {
        renderSkeletonRows(filters.pageSize);
        setView('loading');
        lastHead = { total: 0, filtered: false, loading: true };
        renderHead({ ...lastHead, selection });
        return;
      }

      // 上一次请求失败、而这一份 state 里仍然一条数据都没有：**保持错误态**。
      // 错误态是 `showError()` 画在 `empty` 容器里的，而它之后还会有 `render()` 进来 ——
      // 例如用户在失败后点任一筛选 chip（`main.js` 的 `setFilters` 会先画一次再发请求）。
      // 没有这一档，那次重绘会把「加载失败 + 重试」整块换成「还没有任何记录」：条数明明未知，
      // 界面却给出了确定的结论，而且把唯一的重试入口也一并抹掉。
      // （同一条判据在 V2 是 `boot.js` 的 `boardState()` —— 两版对"现在是不是失败态"必须同答。）
      if (state.error && items.length === 0) return;

      // 入场错峰**只在首屏**（第一份非空结果）播一次，那是「页面来了」的一次性仪式；此后任何更新
      // （切类型、翻页、改筛选、轮询）都走按行对账：级联的尾巴是 **440ms**，在用户**已经在看
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
          rowSignatures.set(row, signature(items[index]));
          rowByKey.set(items[index].key, row);
          tbody.append(row);
        }
      } else {
        reconcile(items, flashKeys ?? new Set());
      }

      lastFilters = filters;
      const filtered = isFiltered(filters);
      setView(items.length > 0 ? 'table' : 'empty');
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

      lastHead = { total, filtered, loading: false };
      renderHead({ ...lastHead, selection });
    },

    // 初次加载失败：不能把骨架屏留在那里（那就是「无限骨架」），要给出可操作的错误态。
    // 已经有内容时不用它——那种情况下保留旧数据 + 一条提示比清空更正确。
    showError(message, onRetry) {
      setView('empty');
      // **头栏的口径也必须一起改**（2026-09-18 补）：加载档刚把这里写成「正在加载…」，
      // 而失败路径不调 render()（见 main.js 的 catch），留着它就会出现
      // 上面说"还在取"、下面说"加载失败"的自相矛盾。失败时条数**未知**，
      // 故这里既不给数字也不给替代文案 —— 说明由错误态正文单独承担。
      headInfo.textContent = '';
      headClear.hidden = true;
      empty.replaceChildren(
        svg(iconPaths('warning'), { size: 32, class: 'empty__icon' }),
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
      // 展开 `lastHead` 而不是逐个字段抄：头栏的口径（总数/是否筛选中/是否加载中）只该有
      // `lastHead` 一个来源，逐个抄会在下次给头栏加字段时漏一处。
      renderHead({ ...lastHead, selection });
    },

    // 写操作结果就地更新该行：不重拉整页，也不重建行——重建会丢掉焦点，
    // 而键盘用户刚按下的那个开关正是焦点所在。
    // `pop` 指定要重放动画的那个开关（'star' | 'pin'），其余情况不动画。
    patchItem(item, { pop = null } = {}) {
      const row = rowByKey.get(item.key);
      if (!row) return;
      const ref = rowRefs.get(row);
      if (ref) ref.item = item;
      rowSignatures.set(row, signature(item));
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
        // `.empty` 建出来时是**空的**，内容只在 `update()` 的空结果分支里填（见那处）。删掉本页
        // 最后一行、批量删完、回收站批量恢复完都会走到这条出口 —— 不在这里填上，屏上就只剩一块
        // 128px 的空白（上下各 64px 内边距），要等紧随其后的静默刷新落地才有内容；那次若失败
        // 就一直空着。
        setView('empty');
        empty.replaceChildren(
          ...buildEmptyState({
            filtered: lastFilters ? isFiltered(lastFilters) : false,
            search: lastFilters?.search ?? '',
            recycle: recycleMode,
          }),
        );
      }
      syncSelectAll();
      // 展开 `lastHead` 而不是逐个字段抄：头栏的口径（总数/是否筛选中/是否加载中）只该有
      // `lastHead` 一个来源，逐个抄会在下次给头栏加字段时漏一处。
      renderHead({ ...lastHead, selection });
    },

    // 把焦点交回结果区（调用方在确认对话框**关闭之后**调用）。
    // 目标链：相邻行里的同一个操作 → 空状态的主按钮 → 表头全选框。
    // 不做这件事的后果是实测过的：焦点随被移除的按钮一起消失、落到 <body>，
    // 键盘用户得从页面开头重新 Tab。
    //
    // 2026-09-18：批量收藏/置顶不再过确认框（见 main.js 的 runBatch），它们不会移除任何行，
    // 于是 `pendingFocus` 是空的 —— 这时不要再直接返回，否则"选择条隐藏 → 焦点落到 <body>"
    // 会在每次批量操作后发生。没有来源记录时按 index 0 落点，最终由下面那条链退回全选框。
    restoreFocus() {
      const { action, index } = pendingFocus ?? { action: null, index: 0 };
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
      //
      // 但重试的判据不能只有「焦点不是 target」：那个 0.5s 窗口里**用户的手只要有动作**
      // （点搜索框、点下一行的按钮），下一轮就会把他拽回全选框。故只接手"无主"的焦点 ——
      // 没有任何元素、或仍停在正在关闭的对话框里；焦点一旦落在别的可交互元素上就交还给用户。
      const focusIsIdle = () => {
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) return true;
        return typeof active.closest === 'function' && active.closest('dialog') !== null;
      };
      let rounds = 0;
      const place = () => {
        if (!target.isConnected) return;
        // 「上一轮落下之后**留住了**」才算成功：不能在 focus() 之后立刻判成功——
        // 浏览器的补焦晚 1–2ms 到（实测：focus() 成功的同一毫秒内就被 focusout 夺走）。
        if (document.activeElement === target) return;
        if (!focusIsIdle()) return;
        target.focus();
        rounds += 1;
        if (rounds < 8) setTimeout(place, 60);
      };
      setTimeout(place, 0);
    },
  };
}
