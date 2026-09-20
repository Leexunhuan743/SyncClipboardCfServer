// 行的渲染：结构（`renderRow`）+ 内容签名（`signature`）。
//
// 两行结构是 V2 的核心信息架构决定（docs/ui-v2-design.md §3.1）：
//   第一行：类型词 + 预览（"是什么"）
//   第二行：标识 · 大小 · 时间（"多大、什么时候"）
// V1 把「大小/创建/修改/访问」做成四个独立列，合计比正文还宽；V2 把它们收进第二行，
// 正文因此拿回宽度。代价是行高从 56 涨到 64 —— 这个交换在截图里是明显的净收益。
import { el, svg } from '../dom.js';
import { iconPaths, iconForKind } from '../icons.js';
import { typeLabel, formatSize, formatRelative, formatAbsolute, previewText, previewIsEmpty, truncateText } from '../format.js';
import { itemIsImage } from '../clipboard.js';
// 数据文件地址来自 `../paths.js` 的纯函数（**不是**在这里再拼一遍模板串，也不是去 import `api.js`）：
// 这条路径 `api.js` 与这里都要用，两处各写一份就会在改接口前缀时漏掉一处 —— 而缩略图 404
// 只会表现为"图片都没了"，与请求本身成功与否无关。理由见该模块的文件头。
import { dataPath } from '../paths.js';
import { renderRowOps } from './rowops.js';

// 缩略图的体积上限：超过它就不拉原图。
// 依据：一页 50 行里若有十来张几 MB 的图，列表会变成一次几十 MB 的下载，
// 而缩略图只有 40px —— 用户看不出差别，流量差三个数量级。
export const THUMB_MAX_BYTES = 512 * 1024;

/**
 * 行的「内容签名」：只有这些字段之一变了，才需要重建该行的内容。
 *
 * 为什么必须有它：列表每 10 秒轮询一次、推送每次广播都触发刷新，整表重建会
 * 重载缩略图、打断动画、丢掉焦点 —— 这些副作用本来每 10 秒发生一遍（V1 的实测结论）。
 *
 * ⚠️ `lastModified` / `lastAccessed` **必须**在签名里：它们是变得最勤的两个字段
 * （每次同步都推进 `lastAccessed`），不在签名里就会导致轮询后行不重建、
 * 两列时间停在首次渲染值 —— 按「访问时间」排序时看起来像排序坏了。
 */
export function signature(item) {
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

/**
 * 建一行的骨架。结构与内容分开，是为了让「对账」能只换内容、不换节点
 * （换节点就会丢掉焦点与正在进行中的按钮状态）。
 *
 * @param {{ item: object,
 *           selected: boolean,
 *           onSelect: (item, checked: boolean, event: Event) => void,
 *           onCopy, onDownload, onStar, onMenu }} spec
 */
export function renderRow(spec) {
  const { item, selected } = spec;

  const check = el('input', {
    class: 'check',
    type: 'checkbox',
    'aria-label': `选择 ${typeLabel(item.type)} 记录`,
    checked: selected,
    onchange: (event) => spec.onSelect(item, event.target.checked, event),
  });

  // `role` = 显式写出隐式语义：≤720px 时这些单元格的 `display` 变成 block/grid，
  // 浏览器就不再从元素类型推导表格语义了（见 `board.js` 建表处的说明）。
  const checkCell = el('td', { class: 'board__cell board__cell--check', role: 'cell' }, [check]);
  const kindCell = el('td', { class: 'board__cell', role: 'cell' });
  const contentCell = el('td', { class: 'board__cell board__cell--content', role: 'cell' });
  const opsCell = el('td', { class: 'board__cell board__cell--ops', role: 'cell' });

  const row = el(
    'tr',
    {
      class: 'item',
      role: 'row',
      dataset: { key: item.key, type: item.type },
      // 双击整行 = 预览。这是列表类界面的通用手势，且**不冲突**任何单击行为
      // （单击行不做任何事，选择靠复选框）。
      ondblclick: () => spec.onOpen?.(item),
    },
    [checkCell, kindCell, contentCell, opsCell],
  );

  fillRow(row, spec);
  return row;
}

/** 把内容写进一行（重建 contentCell 与 opsCell 的内容，保留行与单元格节点本身）。 */
export function fillRow(row, spec) {
  const { item, selected } = spec;
  row.dataset.key = item.key;
  row.dataset.type = item.type;

  const check = row.querySelector('.check');
  if (check) {
    check.checked = selected;
    check.setAttribute('aria-label', `选择 ${typeLabel(item.type)} 记录`);
  }

  // 类型色条：`data-type` 换色，宽度取自 `--col-kind`。它在表格最左，承担"扫视识别"。
  const kindCell = row.querySelector('.board__cell:nth-child(2)');
  if (kindCell) {
    const bar = el('span', { class: 'item__kind', dataset: { type: item.type } });
    kindCell.replaceChildren(bar);
  }

  const contentCell = row.querySelector('.board__cell--content');
  if (contentCell) contentCell.replaceChildren(renderEntry(item, spec.onOpen));

  const opsCell = row.querySelector('.board__cell--ops');
  if (opsCell) opsCell.replaceChildren(renderRowOps({ ...spec, item }));
}

/** 行内容：缩略图 + 两行文本。 */
function renderEntry(item, onOpen) {
  const thumb = renderThumb(item);

  const kind = el('span', {
    class: 'entry__kind',
    dataset: { kind: item.type },
    text: typeLabel(item.type),
  });

  const text = previewText(item);
  const textNode = el('span', {
    class: 'entry__text',
    text,
    // `data-empty` 是 CSS 的空占位判据。用字面属性名而不是 `dataset` 对象：`dataset` 里值为 null
    // 会被 `el()` 跳过，而 `data-empty=""` 这种"存在即语义"的属性需要一个真的空串。
    //
    // 这里原来还有一个写死 `'2'` 的 `data-lines`（"行数档位"），而 CSS 里只有
    // `[data-lines="1"]` 一条规则、没有任何生产者 ⇒ 那档永远不会出现（`docs/AUDIT-missing-states.md` §3.2）。
    // 现已删除：紧凑模式的单行截断改由 `:root[data-density="compact"]` 直接驱动 CSS（见 `board-v2.css`）。
    'data-empty': previewIsEmpty(item) ? '' : null,
  });

  const meta = renderMeta(item);

  return el('button', {
    class: 'entry',
    type: 'button',
    'aria-label': `预览${typeLabel(item.type)}：${truncateText(text, 80)}`,
    dataset: { action: 'preview' },
    onclick: () => onOpen?.(item),
  }, [
    thumb,
    el('div', { class: 'entry__body' }, [
      el('div', { class: 'entry__line' }, [kind, textNode]),
      meta,
    ]),
  ]);
}

/**
 * 第二行的元数据：`标识 · 大小 · 时间`。
 *
 * 三个字段的取舍：
 *   · 标识 —— 文本记录给短哈希（同内容的记录无法区分，哈希是唯一的身份）；
 *     文件/图片/组合给文件名（那是用户认得出的东西）。
 *   · 大小 —— Text 类型若没有数据文件就是"内联文本"，大小意义不大，仍显示（用户会用来判断截断）
 *   · 时间 —— 给**相对时间**（"1 小时前"），绝对时间放 `title`。
 *     列表里读"多久以前"比读"2026-09-15 14:20"快得多。
 */
function renderMeta(item) {
  const parts = [];

  // 标识
  if (item.type === 'Text') {
    parts.push(el('span', { class: 'mono', text: shortHash(item.hash), title: item.hash ?? '' }));
  } else if (item.dataName) {
    parts.push(el('span', { class: 'mono', text: item.dataName, title: item.dataName }));
  } else {
    // 没有数据文件的 File/Image/Group 是**异常状态**（服务端本该拒绝入库），
    // 用警示色标出来而不是静默显示空 —— 与 /ui/api/integrity 能查出的形态一致。
    parts.push(el('span', { class: 'note--warn', text: '数据缺失' }));
  }

  parts.push(el('span', { text: '·' }));
  parts.push(el('span', { text: formatSize(item.size) }));

  parts.push(el('span', { text: '·' }));
  parts.push(
    el('span', {
      // 与**分组标题同一个字段**（`createTime`，2026-09-18 修）。
      // 此前这里是 `lastAccessed ?? lastModified ?? createTime`，而列表的时间分组与默认排序
      // 都按 `createTime`（`board.js` 的 `dayGroup`）⇒ 一条刚被同步过的旧记录会同时出现
      // 「3 天前」的小标题与「刚刚」的行内时间，两句都在说"这条是什么时候的"，却是两个口径。
      // V1 的主时间列（`.col-created`）用的也是 `createTime`，修改/访问各有独立列。
      // 三个值仍然全在 `title` 里。见 `docs/archive/AUDIT-v1-v2-divergence.md` §5.4。
      text: formatRelative(item.createTime),
      title: `创建 ${formatAbsolute(item.createTime)} · 修改 ${formatAbsolute(
        item.lastModified,
      )} · 访问 ${formatAbsolute(item.lastAccessed)}`,
    }),
  );

  // 状态徽标：只放**异常或需要解释**的两种。
  // 收藏/置顶不进这里 —— 它们已经由行尾的按钮状态表达，再放一个徽标就是同一件事说两遍。
  if (item.textTruncated) {
    parts.push(el('span', { class: 'tag', text: '正文已截断', title: '列表里的正文截断到 500 字符；预览或复制时会取回全文' }));
  }
  if (item.isDeleted) {
    parts.push(el('span', { class: 'tag', 'data-tone': 'warn', text: '已删除' }));
  }

  return el('div', { class: 'entry__meta' }, parts);
}

/**
 * 缩略图。
 *
 * 四条规则：
 *   · 只有**看起来是图片**的记录才请求图片（`itemIsImage`：Image 类型，或文件名带图片扩展名）；
 *   · 超过 `THUMB_MAX_BYTES` 不拉原图，给类型图标（避免一页几十 MB）；
 *   · `hasData` 为假 **且类型本该有数据文件** → `data-missing` 占位（斜纹 + 警示图标）。
 *     「本该有数据」只包含 File / Image / Group —— **Text 记录没有数据文件是常态**
 *     （内联文本就在 `text` 里），把它也标成"数据缺失"会让每一行都挂一个警示图标
 *     （实测截图里就是这个样子：一屏全是三角警示，等于没有警示）；
 *   · 图片加载失败同样降级为占位。线上真有"元数据说有数据、R2 里没有"的记录
 *     （数据被已修复的孤儿清理事故误删过），必须与"记录不存在"分开。
 */
function renderThumb(item) {
  const box = el('div', { class: 'entry__thumb' });
  box.setAttribute('aria-hidden', 'true');

  const wantsImage = itemIsImage(item) && item.hasData && Number(item.size) <= THUMB_MAX_BYTES;
  if (!wantsImage) {
    // `needsData`：这一类的记录在服务端语义上**必须**有数据文件才有意义
    const needsData = item.type !== 'Text';
    const missing = needsData && !item.hasData;
    box.append(svg(iconPaths(missing ? 'warning' : iconForKind(item.type)), { size: 18 }));
    if (missing) box.setAttribute('data-missing', '');
    return box;
  }

  const alt = item.dataName ? `${item.dataName} 的缩略图` : '记录缩略图';
  const img = el('img', {
    src: dataPath(item),
    alt,
    loading: 'lazy',
    decoding: 'async',
  });
  // 加载失败 → 降级成占位。用 `error` 事件而不是预先探测：
  // 为每一行预先发一次 HEAD 是 50 次子请求，而这个事件只有真的坏掉时才触发。
  img.addEventListener('error', () => box.setAttribute('data-missing', ''));
  box.append(img);
  return box;
}

function shortHash(hash) {
  if (!hash) return '—';
  return hash.length > 10 ? `${hash.slice(0, 8)}…` : hash;
}
