// 顶栏：标识、部署信息、主题切换、会话操作。
// 64px（product 方言的实测高度），吸顶，一条底边。不做悬停放大之类的花活。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';

export function createHeader({ onToggleTheme, onLogout, onInfo }) {
  const who = el('span', { class: 'who' });
  const meta = el('span', { class: 'brand__meta' });

  const themeButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '切换深浅色',
      title: '切换深浅色',
      onclick: () => onToggleTheme(),
    },
    [svg(iconPaths('moon'))],
  );

  const infoButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '部署信息', title: '部署信息', onclick: () => onInfo() },
    [svg(iconPaths('info'))],
  );

  const logoutButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '登出', title: '登出', onclick: () => onLogout() },
    [svg(iconPaths('logout'))],
  );

  const node = el('div', { class: 'app-header__inner' }, [
    el('div', { class: 'brand' }, [
      svg(iconPaths('clipboard'), { size: 26 }),
      el('div', { class: 'brand__text' }, [el('h1', { text: '剪贴板历史' }), meta]),
    ]),
    el('span', { class: 'app-header__spacer' }),
    el('div', { class: 'app-header__actions' }, [infoButton, themeButton, who, logoutButton]),
  ]);

  // 图标随主题切换（月亮 ↔ 太阳），并且把选择写进 localStorage
  function syncThemeIcon(theme) {
    themeButton.replaceChildren(svg(iconPaths(theme === 'dark' ? 'sun' : 'moon')));
  }

  return {
    el: node,
    update({ username, version, theme }) {
      who.textContent = username ?? '';
      meta.textContent = version ? `v${version}` : '';
      syncThemeIcon(theme);
    },
  };
}
