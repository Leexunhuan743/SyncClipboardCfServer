// 概览条：三个真实数字 + 近 14 天的活动柱 + 需要处理的健康提示（时钟差、清理失败、连接中断）。
// 它回答"现在库里是什么状态"，不抢列表的位置：一行，跟着列表一起滚走。
import { clear, h, icon } from '../lib/dom';
import { formatSize } from '../lib/format';
import type { ActivityDay } from '../lib/types';
import type { AppState } from '../state';
import { typeBar } from './typebar';

const SKEW_WARN_MS = 5 * 60_000; // 官方客户端在时钟差 > 5 分钟时会中止历史同步

function sparkline(days: ActivityDay[]): HTMLElement {
  const max = Math.max(1, ...days.map((d) => d.total));
  const bars = days.map((day, index) => {
    const bar = h('span', { class: 'spark__bar', title: `${day.day} · ${day.total} 条`, dataset: { today: String(index === days.length - 1), zero: String(day.total === 0) } });
    bar.style.height = `${Math.max(3, Math.round((day.total / max) * 28))}px`;
    return bar;
  });
  return h('div', { class: 'spark', role: 'img', 'aria-label': `近 ${days.length} 天新增：${days.map((d) => d.total).join('、')}` }, bars);
}

export function createSummary() {
  const el = h('section', { class: 'summary', 'aria-label': '概览' });
  const notices = h('div', { class: 'notices' });

  return {
    el,
    notices,
    render(state: AppState): void {
      const o = state.overview;
      clear(el);
      const tile = (label: string, value: string, unit = '', extra = false) =>
        h('div', { class: `stat${extra ? ' stat--extra' : ''}` }, h('span', { class: 'stat__label', text: label }), h('span', { class: 'stat__value' }, value, unit && h('small', { text: unit })));
      if (!o) {
        for (const label of ['记录', '收藏', '存储']) el.append(tile(label, '—'));
      } else {
        el.append(
          tile('记录', String(o.stats.activeCount), ' 条'),
          tile('收藏', String(o.starredCountActive), ' 条'),
          tile('存储', o.info.storage.totalBytes === null ? '—' : formatSize(o.info.storage.totalBytes)),
          // 下面两张只在宽屏（带鱼屏）显示：横向空间多了，把"回收站里有多少"和"类型构成"也摆出来
          tile('回收站', String(o.stats.deletedCount), ' 条', true),
          h('div', { class: 'stat stat--extra stat--types' }, h('span', { class: 'stat__label', text: '类型构成' }), typeBar(o.byTypeActive, { legend: true })),
        );
      }
      if (state.activity && state.activity.length > 0) {
        el.append(h('div', { class: 'stat stat--spark' }, h('span', { class: 'stat__label', text: `近 ${state.activity.length} 天新增` }), sparkline(state.activity)));
      }

      // 健康提示：只在真有问题时出现，且都是"需要你做点什么"的那类
      clear(notices);
      const add = (tone: 'warn' | 'error', text: string): void => {
        notices.append(h('div', { class: 'notice', dataset: { tone }, role: tone === 'error' ? 'alert' : 'status' }, icon('warning', { size: 18 }), h('span', { text })));
      };
      if (state.stale) add('error', '与服务器的连接中断，正在重试；当前显示的可能不是最新内容。');
      if (state.skewMs !== null && Math.abs(state.skewMs) > SKEW_WARN_MS) {
        const minutes = Math.round(Math.abs(state.skewMs) / 60_000);
        add('warn', `本机时钟与服务器相差约 ${minutes} 分钟：官方客户端在时钟差超过 5 分钟时会中止历史同步。`);
      }
      const cleanup = o?.info.cleanup;
      if (cleanup?.lastError) add('warn', `上一轮自动清理失败：${cleanup.lastError}`);
    },
  };
}
