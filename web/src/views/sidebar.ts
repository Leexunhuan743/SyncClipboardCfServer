// 侧栏：品牌、视图导航（类型库 / 收藏 / 回收站）、连接状态、设置与账户。
// 宽屏常驻；窄屏是抽屉（由 `state.navOpen` 控制，见 styles/shell.css）。
import { h, icon } from '../lib/dom';
import { iconForKind, type IconName } from '../lib/icons';
import { formatAbsolute, formatRelative, typeLabel } from '../lib/format';
import type { ItemType, TypeFilter } from '../lib/types';
import { openAppearance } from './appearance';
import { currentNav, type AppState, type NavView } from '../state';

export interface SidebarActions {
  onNav(view: NavView): void;
  onNewFolder(): void;
  onSettings(): void;
  onHelp(): void;
  onLogout(): void;
  onCloseDrawer(): void;
}

const LIBRARY: TypeFilter[] = ['All', 'Text', 'Image', 'File', 'Group'];
const PUSH_LABEL = { live: '实时同步', connecting: '正在连接', offline: '定时刷新' } as const;

interface NavButton {
  el: HTMLButtonElement;
  count: HTMLElement;
  match: (view: NavView) => boolean;
  countOf: (state: AppState) => number | null;
}

export function createSidebar(actions: SidebarActions) {
  const buttons: NavButton[] = [];

  const navButton = (
    label: string,
    iconName: IconName,
    view: NavView,
    match: NavButton['match'],
    countOf: NavButton['countOf'],
  ): HTMLButtonElement => {
    const count = h('span', { class: 'nav__count' });
    const el = h(
      'button',
      {
        class: 'nav__item',
        type: 'button',
        onclick: () => {
          actions.onNav(view);
          actions.onCloseDrawer();
        },
      },
      icon(iconName, { size: 18 }),
      h('span', { class: 'nav__label', text: label }),
      count,
    );
    buttons.push({ el, count, match, countOf });
    return el;
  };

  const library = LIBRARY.map((type) =>
    navButton(
      type === 'All' ? '全部' : typeLabel(type),
      type === 'All' ? 'inbox' : iconForKind(type),
      { kind: 'type', type },
      (view) => view.kind === 'type' && view.type === type,
      (state) => {
        const by = state.overview?.byTypeActive;
        if (!by) return null;
        if (type === 'All') return Object.values(by).reduce((sum, n) => sum + (n ?? 0), 0);
        return by[type as ItemType] ?? 0;
      },
    ),
  );
  const starred = navButton('收藏', 'star', { kind: 'starred' }, (v) => v.kind === 'starred', (s) => s.overview?.starredCountActive ?? null);
  const trash = navButton('回收站', 'trash', { kind: 'trash' }, (v) => v.kind === 'trash', (s) => s.overview?.stats.deletedCount ?? null);

  // 收藏夹：数量与名字都是动态的，列表在 render 里按签名重建（没变就不碰 DOM，避免打断悬停 / 焦点）
  const folderList = h('div', { class: 'nav__group' });
  const newFolder = h(
    'button',
    { class: 'nav__item nav__item--add', type: 'button', onclick: () => actions.onNewFolder() },
    icon('plus', { size: 18 }),
    h('span', { class: 'nav__label', text: '新建收藏夹' }),
  );
  let folderSig = '';

  const pushDot = h('span', { class: 'status__dot' });
  const pushText = h('span', { class: 'status__text' });
  // 「最近同步」：回答「刚在另一台设备上复制了，这里有没有过来」—— 以前只能靠刷新一下来试
  const pushAgo = h('span', { class: 'status__ago' });
  const status = h('button', { class: 'status', type: 'button', title: '同步通道状态 · 点击查看部署信息', onclick: () => actions.onSettings() }, pushDot, pushText, pushAgo);

  const themeButton = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '外观与主题', title: '外观与主题（t）', onclick: () => openAppearance() }, icon('palette'));

  const userName = h('span', { class: 'user__name' });
  const el = h(
    'aside',
    { class: 'sidebar', 'aria-label': '导航' },
    h(
      'div',
      { class: 'sidebar__brand' },
      h('span', { class: 'brand__mark' }, icon('clipboard', { size: 20 })),
      h('div', { class: 'brand__text' }, h('strong', { text: '剪贴板' }), h('span', { text: 'SyncClipboard' })),
      h('button', { class: 'icon-btn sidebar__close', type: 'button', 'aria-label': '关闭导航', onclick: () => actions.onCloseDrawer() }, icon('close')),
    ),
    h('nav', { class: 'nav', 'aria-label': '视图' }, h('p', { class: 'nav__title', text: '全部记录' }), library, h('p', { class: 'nav__title', text: '整理' }), starred, trash, h('p', { class: 'nav__title', text: '收藏夹', title: '放进收藏夹的记录不会被自动清理' }), folderList, newFolder),
    h(
      'div',
      { class: 'sidebar__foot' },
      status,
      h(
        'div',
        { class: 'sidebar__tools' },
        h('button', { class: 'btn btn--ghost sidebar__settings', type: 'button', onclick: () => actions.onSettings() }, icon('settings', { size: 16 }), '部署信息'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '键盘快捷键', title: '键盘快捷键（?）', onclick: () => actions.onHelp() }, icon('keyboard')),
        themeButton,
      ),
      h('div', { class: 'user' }, h('span', { class: 'user__avatar', 'aria-hidden': 'true' }), userName, h('button', { class: 'icon-btn', type: 'button', 'aria-label': '退出登录', title: '退出登录', onclick: () => actions.onLogout() }, icon('logout'))),
    ),
  );

  return {
    el,
    render(state: AppState): void {
      const view = currentNav(state.filters);
      for (const b of buttons) {
        const active = b.match(view);
        if (active) b.el.setAttribute('aria-current', 'page');
        else b.el.removeAttribute('aria-current');
        const n = b.countOf(state);
        b.count.textContent = n === null ? '' : String(n);
      }
      const folders = state.overview?.folders ?? [];
      const activeFolder = view.kind === 'folder' ? view.id : 0;
      const sig = JSON.stringify([folders.map((f) => [f.id, f.name, f.count]), activeFolder]);
      if (sig !== folderSig) {
        folderSig = sig;
        folderList.replaceChildren(
          ...folders.map((folder) =>
            h(
              'button',
              {
                class: 'nav__item',
                type: 'button',
                title: `${folder.name}（放进来的记录不会被自动清理）`,
                'aria-current': folder.id === activeFolder ? 'page' : undefined,
                onclick: () => {
                  actions.onNav({ kind: 'folder', id: folder.id });
                  actions.onCloseDrawer();
                },
              },
              icon('folder', { size: 18 }),
              h('span', { class: 'nav__label', text: folder.name }),
              h('span', { class: 'nav__count', text: String(folder.count) }),
            ),
          ),
        );
      }
      pushText.textContent = PUSH_LABEL[state.push];
      status.dataset.state = state.stale ? 'stale' : state.push;
      if (state.stale) pushText.textContent = '连接中断';
      pushAgo.textContent = state.lastSyncAt === null ? '' : formatRelative(state.lastSyncAt);
      status.title = state.lastSyncAt === null ? '同步通道状态 · 点击查看部署信息' : `最近一次与服务器同步：${formatAbsolute(state.lastSyncAt)}（点击查看部署信息）`;
      userName.textContent = state.user;
      el.dataset.open = String(state.navOpen);
    },
  };
}
