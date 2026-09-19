// 活动趋势图：内联 SVG 的**纯函数**，无 DOM 依赖之外的副作用。
//
// 为什么是 SVG 而不是 canvas：这类图最多 30–90 根柱子、一次性绘制、不需要逐帧更新，
// canvas 带来的设备像素比处理与重绘管理在这里是纯负担；而 SVG 的每根柱子是可寻址的 DOM，
// 悬停态的 `title` 直接由元素承担。
//
// 为什么不用图表库：为一个 14 根的柱状图引入依赖（几十 KB）与"零构建"这条架构决定冲突
// （ADR D12）。这里的实现是 40 行。
const NS = 'http://www.w3.org/2000/svg';

/**
 * 画一条活动趋势。
 *
 * @param {Array<{day: string, total: number}>} days 按时间**升序**
 * @param {{ width?: number, height?: number, label?: string }} options
 * @returns {SVGElement}
 */
export function renderSpark(days, { width = 132, height = 28, label = '近两周的剪贴板活动量' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  // 图表是**纯装饰**：同一份数据在抽屉里有可读的文字明细（每个数字都写得出来）。
  // 若在这里塞一段长 alt，读屏用户会先听到一段无法使用的数字串。
  svg.setAttribute('aria-label', label);

  const items = Array.isArray(days) ? days : [];
  if (items.length === 0) return svg;

  // 柱宽 = 总宽 / 根数，间距占柱宽的 34%（8 根以上时看起来最平衡）。
  const gap = 2;
  const barW = Math.max(1, (width - gap * (items.length - 1)) / items.length);
  const max = Math.max(1, ...items.map((d) => Number(d.total) || 0));
  const r = Math.min(2, barW / 2);

  items.forEach((day, index) => {
    const value = Number(day.total) || 0;
    // 高度下限 2px：**零活动的那天也要有一根矮柱**，否则"那天没有记录"与"那天不存在"看起来一样
    const h = value === 0 ? 2 : Math.max(3, (value / max) * height);
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(index * (barW + gap)));
    rect.setAttribute('y', String(height - h));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', String(r));
    rect.setAttribute('fill', 'currentColor');
    // 零活动的那天更淡：它是"有这一天，但没有记录"
    if (value === 0) rect.setAttribute('opacity', '0.3');

    const title = document.createElementNS(NS, 'title');
    title.textContent = `${day.day}：${value} 条`;
    rect.append(title);
    svg.append(rect);
  });

  return svg;
}

/** 活动数据的总量（概览带的"近 14 天"数字用它）。 */
export function totalOf(days) {
  return (Array.isArray(days) ? days : []).reduce((sum, d) => sum + (Number(d.total) || 0), 0);
}
