// 手机底部标签栏：拇指够得到的四个主入口（记录 / 收藏 / 回收站 / 更多）。
// 只在窄屏显示（≤860px，见 styles/shell.css）；「更多」打开侧栏抽屉，那里有按类型的完整导航与设置。
import { h, icon } from '../lib/dom';
import type { IconName } from '../lib/icons';
import { currentNav, type AppState, type NavView } from '../state';

export interface TabbarActions {
  onNav(view: NavView): void;
  onMore(): void;
}

export function createTabbar(actions: TabbarActions) {
  const tab = (label: string, name: IconName, onclick: () => void) => {
    const el = h('button', { class: 'tabbar__item', type: 'button', onclick }, icon(name, { size: 22 }), h('span', { text: label }));
    return el;
  };
  const records = tab('记录', 'inbox', () => actions.onNav({ kind: 'type', type: 'All' }));
  const starred = tab('收藏', 'star', () => actions.onNav({ kind: 'starred' }));
  const trash = tab('回收站', 'trash', () => actions.onNav({ kind: 'trash' }));
  const more = tab('更多', 'menu', () => actions.onMore());
  const el = h('nav', { class: 'tabbar', 'aria-label': '主导航' }, records, starred, trash, more);

  const mark = (button: HTMLElement, on: boolean): void => {
    if (on) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  };

  return {
    el,
    render(state: AppState): void {
      const view = currentNav(state.filters);
      mark(records, view.kind === 'type');
      mark(starred, view.kind === 'starred');
      mark(trash, view.kind === 'trash');
      mark(more, state.navOpen);
    },
  };
}
