// 类型构成条：一条按数量比例分段的横条 + 图例。概览条（带鱼屏）与部署信息的"存储"共用。
import { h } from '../lib/dom';
import { typeLabel } from '../lib/format';
import type { ByType, ItemType } from '../lib/types';

const ORDER: ItemType[] = ['Text', 'Image', 'File', 'Group'];

export function typeBar(byType: ByType | undefined, { legend = true }: { legend?: boolean } = {}): HTMLElement {
  const counts = ORDER.map((type) => [type, byType?.[type] ?? 0] as const);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const bar = h('div', { class: 'typebar__bar', role: 'img', 'aria-label': total === 0 ? '暂无记录' : counts.filter(([, n]) => n > 0).map(([t, n]) => `${typeLabel(t)} ${n}`).join('，') });
  for (const [type, n] of counts) {
    if (n === 0) continue;
    const seg = h('span', { class: 'typebar__seg', dataset: { type }, title: `${typeLabel(type)} ${n} 条（${Math.round((n / total) * 100)}%）` });
    seg.style.flexGrow = String(n); // 比例交给 flex：不必自己算百分比，也不会因取整加起来不等于 100%
    bar.append(seg);
  }
  if (total === 0) bar.dataset.empty = 'true';
  return h(
    'div',
    { class: 'typebar' },
    bar,
    legend
      ? h(
          'ul',
          { class: 'typebar__legend' },
          counts.map(([type, n]) => h('li', null, h('i', { class: 'typebar__dot', dataset: { type } }), `${typeLabel(type)} `, h('b', { text: String(n) }))),
        )
      : null,
  );
}
