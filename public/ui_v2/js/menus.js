// 菜单项的**构造**（不建 DOM、不开关菜单）：入参是数据与回调，出参是菜单项数组。
//
// 抽出来的理由（2026-09-16 审计 A-38）：这一段的判据（"回收站里主操作是恢复""不可恢复的要禁用
// 并说明原因""按当前排序字段打勾"）是**产品决定**，但原来它们埋在 `boot.js` 的两百行中间，
// 只能靠人读。放这里之后可以直接断言结构与文案，`boot.js` 只负责把结果交给 `menu.open`。
//
// 项的形状由 `ui/menu.js` 定义：
//   { label, icon?, tone?, disabled?, separator?, run }

/**
 * 一行的 `⋯` 菜单。
 *
 * @param {object} item 记录
 * @param {{ onPreview, onCopy, onDownload, onRestore, onTogglePin, onDelete }} handlers
 * @returns {Array<object>}
 */
export function rowMenuItems(item, handlers) {
  const items = [
    { label: '预览', icon: 'eye', run: () => handlers.onPreview(item) },
    item.type === 'Text'
      ? { label: '复制内容', icon: 'copy', run: () => handlers.onCopy(item) }
      : { label: '下载', icon: 'download', run: () => handlers.onDownload(item) },
  ];

  if (item.isDeleted) {
    // 回收站：所有记录都能恢复（2026-09-22，ADR D29）。此前按 `hasData` 禁用是上游语义
    // （软删即清数据 ⇒ 带数据的记录恢复必 404）的直接后果，真回收站之后不再成立。
    items.push({
      label: '恢复到历史记录',
      icon: 'undo',
      run: () => handlers.onRestore(item),
    });
  } else {
    items.push({
      label: item.pinned ? '取消置顶' : '置顶',
      icon: 'pin',
      run: () => handlers.onTogglePin(item),
    });
  }

  items.push({ separator: true });
  items.push({
    label: item.isDeleted ? '彻底删除' : '删除',
    icon: 'trash',
    tone: 'danger',
    run: () => handlers.onDelete(item),
  });

  return items;
}

/**
 * 列表头的排序菜单。当前字段打勾；点同一字段翻转方向，换字段保留方向。
 *
 * @param {{ sort: string, order: 'asc'|'desc' }} filters
 * @param {Array<{ value: string, label: string }>} sortFields
 * @param {(patch: object) => void} onSelect 收 `{ sort, order, page }`
 */
export function sortMenuItems(filters, sortFields, onSelect) {
  return sortFields.map((field) => ({
    label: field.label,
    icon: filters.sort === field.value ? 'check' : null,
    run: () =>
      onSelect({
        sort: field.value,
        // 点同一字段则翻转方向；换字段时保留当前方向
        order:
          filters.sort === field.value ? (filters.order === 'desc' ? 'asc' : 'desc') : filters.order,
        page: 1,
      }),
  }));
}
