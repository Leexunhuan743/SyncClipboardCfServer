// 统计条：三个真实数字（不是编造的指标——全部来自 /ui/api/statistics）。
// 三个一行的形态用「一条边框 + 分隔线」实现，而不是三张浮动卡片：后者是生成式页面最典型的形状。
import { el } from '../dom.js';
import { formatSize } from '../format.js';

function createStat(label) {
  const value = el('span', { class: 'stat__value' });
  const unit = el('span', { class: 'stat__unit' });
  const sub = el('span', { class: 'stat__sub' });
  const node = el('div', { class: 'stat' }, [el('span', { class: 'stat__label', text: label }), value, sub]);
  return {
    node,
    set(numberText, unitText, subText = '') {
      value.replaceChildren(el('span', { text: numberText }), unit);
      unit.textContent = unitText ?? '';
      sub.replaceChildren(el('span', { text: subText }));
    },
    // 把副标题换成任意节点（回收站计数是个可点的入口，不是纯文本）
    setSub(child) {
      sub.replaceChildren(child);
    },
  };
}

const TYPE_LABELS = [
  ['Text', '文本'],
  ['Image', '图片'],
  ['File', '文件'],
  ['Group', '组合'],
];

export function createStats({ onOpenRecycle } = {}) {
  const records = createStat('记录');
  const starred = createStat('已收藏');
  const storage = createStat('存储占用');

  const node = el('section', { class: 'stats', 'aria-label': '用量统计' }, [
    records.node,
    starred.node,
    storage.node,
  ]);

  return {
    el: node,
    update(stats) {
      if (!stats) return;
      const active = stats.activeCount ?? 0;
      const deleted = stats.deletedCount ?? 0;
      records.set(String(active), '条');
      if (deleted > 0) {
        // 回收站入口：这是唯一一处告诉用户「删掉的东西还在、30 天后才清除」的地方，
        // 也是进回收站视图最自然的入口（数字本身可点，不必先去工具栏找筛选器）。
        records.setSub(
          el(
            'button',
            {
              class: 'stat__link',
              type: 'button',
              title: '查看回收站',
              onclick: () => onOpenRecycle?.(),
            },
            [el('span', { text: `另有 ${deleted} 条在回收站（30 天后清除）` })],
          ),
        );
      } else {
        records.setSub(el('span', { text: '无已删除记录' }));
      }
      starred.set(String(stats.starredCount ?? 0), '条', `共 ${stats.totalCount ?? 0} 条记录`);

      const mb = Number(stats.totalFileSizeMB ?? 0);
      // 「存储占用」的明细必须用**恒活跃**的那一份（`byTypeActive`）：已删记录的 R2 数据文件
      // 在软删时就删了，拿随视图走的 `byType` 会把已删计数写到这行，与标题对不上。
      // 兜底 `?? stats.byType`：只在版本混用（缓存里的旧服务端响应）时可能缺这个键。
      const byType = stats.byTypeActive ?? stats.byType ?? {};
      const breakdown = TYPE_LABELS.filter(([key]) => (byType[key] ?? 0) > 0)
        .map(([key, label]) => `${label} ${byType[key]}`)
        .join(' · ');
      storage.set(formatSize(mb * 1024 * 1024), '', breakdown || '暂无数据文件');
    },
  };
}
