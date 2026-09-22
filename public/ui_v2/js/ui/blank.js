// 空状态：**设计过的状态**，不是一块空白。
//
// 三种语境要分开写文案与出口（V1 的教训，docs/ui.md §9.3）：
//   · `filter` —— 有记录，但被筛选条件挡住了 → 出口是「清除筛选」
//   · `trash`  —— 回收站是空的（这是**好消息**）→ 出口是「返回历史记录」
//   · `empty`  —— 一条记录都没有（还没配客户端）→ 出口是「怎么配置客户端」
// 三者共用一句话会让至少两种语境读起来是错的。
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';

const COPY = {
  filter: {
    icon: 'filter',
    title: '没有符合条件的记录',
    text: '当前的类型、时间范围或搜索词把结果过滤掉了。放宽条件通常就能看到内容。',
    actions: [{ key: 'clear', label: '清除筛选条件', primary: true }],
  },
  trash: {
    icon: 'check',
    title: '回收站是空的',
    text: '移动到回收站的记录（连同数据文件）会在这里保留 30 天，期间可以恢复；30 天后由清理任务彻底删除。',
    actions: [{ key: 'back', label: '返回历史记录', primary: true }],
  },
  empty: {
    icon: 'inbox',
    title: '还没有任何剪贴板记录',
    text: '把 SyncClipboard 客户端的服务器地址指向本站（部署信息里有可复制的地址），复制一次内容就会出现在这里。',
    actions: [{ key: 'info', label: '查看部署信息', primary: true }],
  },
};

/**
 * @param {'filter'|'trash'|'empty'} kind
 * @param {{ onAction: (key: string) => void }} handlers
 */
export function renderBlank(kind, { onAction }) {
  const spec = COPY[kind] ?? COPY.empty;

  return el('div', { class: 'blank', dataset: { kind } }, [
    el('div', { class: 'blank__icon' }, [svg(iconPaths(spec.icon), { size: 24 })]),
    el('p', { class: 'blank__title', text: spec.title }),
    el('p', { class: 'blank__text', text: spec.text }),
    el(
      'div',
      { class: 'blank__actions' },
      spec.actions.map((action) =>
        el('button', {
          class: `btn${action.primary ? ' btn--primary' : ''}`,
          type: 'button',
          text: action.label,
          onclick: () => onAction(action.key),
        }),
      ),
    ),
  ]);
}

/** 首屏加载失败：给出可操作的错误态 + 重试，而不是把骨架屏永远留在那里。 */
export function renderFailure(message, { onRetry }) {
  return el('div', { class: 'blank', dataset: { kind: 'error' } }, [
    el('div', { class: 'blank__icon' }, [svg(iconPaths('warning'), { size: 24 })]),
    el('p', { class: 'blank__title', text: '加载失败' }),
    el('p', { class: 'blank__text', text: message }),
    el('div', { class: 'blank__actions' }, [
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: '重试',
        onclick: () => onRetry(),
      }),
    ]),
  ]);
}
