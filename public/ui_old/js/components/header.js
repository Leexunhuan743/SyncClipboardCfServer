// 顶栏：标识、实时通道状态、部署信息、主题切换、会话操作。
// 高度 --header-h（56px），吸顶，一条底边。不做悬停放大之类的花活。
//
// 2026-09-17 增补两处（此前都没有可见入口）：
//   · **实时通道状态**：`live / connecting / offline` 三态只写在 js/signalr.js 里，
//     用户唯一能看到它的地方是「部署信息」对话框（要主动点开）。而这三态直接决定
//     「别的设备改了这边多快看见」：live = 立即，offline = 等下一次轮询。做成顶栏的一枚
//     状态点后，它从「要查的参数」变成「一眼看到的状态」；点它进同一个对话框（不新增面板）。
//   · **会话区收拢**：用户名与登出此前是两个各自独立的控件，中间隔着 8px，读起来像两个
//     无关动作。合成一枚 user chip（名字 + 分隔线 + 登出）后，顶栏右侧清楚分成
//     「状态 · 动作组 · 会话」三段。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';

// 三种状态各自有「点」（颜色）与「词」（文案），不靠颜色单独表意。
// connecting 用琥珀而不是灰：它是**进行中**，与 offline（终态、需用户知情）不是一回事。
const PUSH_STATES = {
  live: { label: '实时推送', hint: '实时推送已连接：其他设备的改动会立即出现在这里', tone: 'live' },
  connecting: { label: '正在连接', hint: '正在建立实时通道，当前仍按轮询刷新', tone: 'connecting' },
  offline: { label: '轮询刷新', hint: '实时通道未连接：改动会在下一次轮询时出现（可见时每 10 秒）', tone: 'offline' },
};

export function createHeader({ onToggleTheme, onLogout, onInfo }) {
  const who = el('span', { class: 'who' });
  const meta = el('span', { class: 'brand__meta' });
  const statusLabel = el('span', { class: 'status__label' });

  // 点它进「部署信息」：那里有完整解释（传输清单、轮询间隔、最近变更），状态点自己只给结论。
  const statusButton = el(
    'button',
    { class: 'status', type: 'button', 'aria-live': 'polite', onclick: () => onInfo() },
    [el('span', { class: 'status__dot' }), statusLabel],
  );

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
    {
      class: 'btn btn--quiet',
      type: 'button',
      'aria-label': '部署信息',
      title: '部署信息',
      onclick: () => onInfo(),
    },
    // 带文字而不是只有 ⓘ：这是「客户端该填哪个地址」的唯一入口，而在旧版里它是一枚
    // 无标签的图标——`docs/ui.md` §9.5 与 V1 的 README 都把它记为"第一次使用者找不到"。
    // 窄屏（≤560px）由 CSS 收起文字，只留图标；`aria-label` 保证那时读屏仍然读得出来。
    [svg(iconPaths('info')), el('span', { class: 'btn__label', text: '部署信息' })],
  );

  const logoutButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '登出', title: '登出', onclick: () => onLogout() },
    [svg(iconPaths('logout'))],
  );

  // 会话区：用户名与登出合成一枚 chip（窄屏由 CSS 收成只有图标）
  const userChip = el('div', { class: 'user-chip' }, [who, logoutButton]);

  const node = el('div', { class: 'app-header__inner' }, [
    el('div', { class: 'brand' }, [
      svg(iconPaths('clipboard'), { size: 26 }),
      el('div', { class: 'brand__text' }, [el('h1', { text: '剪贴板历史' }), meta]),
    ]),
    el('span', { class: 'app-header__spacer' }),
    el('div', { class: 'app-header__actions' }, [
      statusButton,
      el('span', { class: 'app-header__divider' }),
      infoButton,
      themeButton,
      el('span', { class: 'app-header__divider' }),
      userChip,
    ]),
  ]);

  // 图标随主题切换（月亮 ↔ 太阳），并且把选择写进 localStorage
  function syncThemeIcon(theme) {
    themeButton.replaceChildren(svg(iconPaths(theme === 'dark' ? 'sun' : 'moon')));
  }

  return {
    el: node,
    update({ username, version, theme, pushState }) {
      who.textContent = username ?? '';
      meta.textContent = version ? `v${version}` : '';
      syncThemeIcon(theme);
      const state = PUSH_STATES[pushState] ?? PUSH_STATES.offline;
      statusLabel.textContent = state.label;
      statusButton.dataset.tone = state.tone;
      statusButton.title = state.hint;
      statusButton.setAttribute('aria-label', state.hint);
    },
  };
}
