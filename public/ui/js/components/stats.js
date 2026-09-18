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
    set(numberText, unitText, subText) {
      value.replaceChildren(el('span', { text: numberText }), unit);
      unit.textContent = unitText ?? '';
      sub.textContent = subText ?? '';
    },
  };
}

const TYPE_LABELS = [
  ['Text', '文本'],
  ['Image', '图片'],
  ['File', '文件'],
  ['Group', '组合'],
];

export function createStats() {
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
      records.set(
        String(active),
        '条',
        deleted > 0 ? `另有 ${deleted} 条在回收站（30 天后清除）` : '无已删除记录',
      );
      starred.set(String(stats.starredCount ?? 0), '条', `共 ${stats.totalCount ?? 0} 条记录`);

      const mb = Number(stats.totalFileSizeMB ?? 0);
      const byType = stats.byType ?? {};
      const breakdown = TYPE_LABELS.filter(([key]) => (byType[key] ?? 0) > 0)
        .map(([key, label]) => `${label} ${byType[key]}`)
        .join(' · ');
      storage.set(formatSize(mb * 1024 * 1024), '', breakdown || '暂无数据文件');
    },
  };
}
