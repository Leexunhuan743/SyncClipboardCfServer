// 顶栏：品牌、**同步状态**、主题切换、设置入口、登出。
//
// V2 相对 V1 的关键改动：品牌之后那片空白拿来放同步状态（场景 S3）。
// "刚在手机上复制了，电脑上有没有过来"是这个界面第二高频的问题，而它此前**在任何地方都看不见** ——
// 用户只能靠"刷新一下试试"来回答。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { formatAgo } from '../format.js';
import { iconButton } from './button.js';

/**
 * @param {{ onToggleTheme: () => void, onLogout: () => void, onOpenDrawer: () => void,
 *           onFocusSearch: () => void }} handlers
 */
export function createAppbar({ onToggleTheme, onLogout, onOpenDrawer, onFocusSearch }) {
  const mark = el('span', { class: 'brand__mark', 'aria-hidden': 'true' }, [
    svg(iconPaths('clipboard'), { size: 17 }),
  ]);
  // 品牌名就是这一页的 `<h1>`：整个应用只有一个页面级标题，而"剪贴板历史"正是它。
  // 用 `<h1>` 而不是 `<span>` 是**可访问性**要求（每页恰好一个一级标题），
  // 而它的视觉大小由 `.brand__name` 决定，与语义层级解耦（h1 不必是页面上最大的字）。
  const name = el('span', { class: 'brand__name', text: 'SyncClipboard' });
  const meta = el('span', { class: 'brand__meta', text: '' });
  const brand = el('div', { class: 'brand' }, [
    mark,
    el('div', { class: 'brand__text' }, [name, meta]),
  ]);

  // 同步状态：点 + 文案。`data-state` 是唯一判据（见 shell-v2.css）。
  const syncDot = el('span', { class: 'sync__dot' });
  const syncLabel = el('span', { class: 'sync__label', text: '' });
  const sync = el('div', { class: 'sync', dataset: { state: 'offline' }, role: 'status' }, [
    syncDot,
    syncLabel,
  ]);

  const who = el('span', { class: 'who', text: '' });

  const searchBtn = iconButton({
    icon: 'search',
    label: '搜索（按 / 或 Ctrl+K）',
    onClick: onFocusSearch,
  });
  // 只在小屏出现（大屏有完整搜索框，这个入口是重复的）—— 由 CSS 的 `data-when` 控制
  searchBtn.setAttribute('data-when', 'narrow');

  // 主题按钮的文案**随当前主题变**（图标表示"点它会切到哪一边"），故这里给的是初始值，
  // 真正的措辞在 `update()` 里按生效主题重写 —— 包括 `title`（见下）。
  const themeBtn = iconButton({ icon: 'moon', label: '切换到深色主题', onClick: onToggleTheme });
  const settingsBtn = iconButton({ icon: 'settings', label: '概览与设置', onClick: onOpenDrawer });
  const logoutBtn = iconButton({ icon: 'logout', label: '退出登录', onClick: onLogout });

  const actions = el('div', { class: 'appbar__actions' }, [
    searchBtn,
    themeBtn,
    settingsBtn,
    logoutBtn,
    who,
  ]);

  const inner = el('div', { class: 'appbar__inner' }, [
    brand,
    el('span', { class: 'appbar__spacer' }),
    sync,
    actions,
  ]);

  const root = inner;

  // 同步状态的三档文案。
  // 措辞刻意用**用户能验证的事实**（"实时同步中"、"每 10 秒检查"），而不是内部机制名
  // （"SignalR 已连接"、"轮询模式"）——后者对使用者没有意义。
  const STATE_TEXT = {
    live: '实时同步中',
    poll: '定时检查中',
    connecting: '正在连接…',
    offline: '未连接',
  };

  return {
    el: root,

    update({ username, version, theme, pushState, lastSyncMs, now }) {
      // 每 10 秒的轮询都会调到这里：`textContent` / `setAttribute` 的赋值本身就是 DOM 变更，
      // 而版本号、用户名几乎从不改变 —— 一律"先比后写"（实测这一处每次刷新 14–16 次变更）。
      const setText = (node, text) => {
        if (node.textContent !== text) node.textContent = text;
      };
      const setAttr = (node, attr, value) => {
        if (node.getAttribute(attr) !== value) node.setAttribute(attr, value);
      };

      // 「开发测试版」是**常驻**标记（2026-09-18 定位调整：默认界面变成 V1 `public/ui_old/`，
      // 这一版降为仓库维护者做实验的地方）。放在顶栏版本号这一行是因为它必须一眼可见 ——
      // 两份界面长得像，只有这行字能立刻回答"我现在看的是哪一版"。
      setText(meta, version ? `v${version} · 开发测试版` : '开发测试版');
      setText(who, username ?? '');

      // 主题图标表示"点它会切到哪一边"：显示月亮的含义是"当前是浅色，点了变深色"。
      // 图标**变了才换**（原来每次 update 都无条件 `replaceWith`）：`renderChrome()` 每 10 秒
      // 轮询都会被调用，而主题至多切一次 —— 无条件的节点替换是白白的 DOM 抖动。
      const themeIcon = theme === 'dark' ? 'sun' : 'moon';
      if (themeBtn.dataset.icon !== themeIcon) {
        const current = themeBtn.querySelector('svg');
        if (current) current.replaceWith(svg(iconPaths(themeIcon), { size: 16 }));
        themeBtn.dataset.icon = themeIcon;
      }
      // `title` 与 `aria-label` 一起改：只改后者会让鼠标用户看到的提示与读屏听到的语义不一致
      const themeLabel = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
      setAttr(themeBtn, 'aria-label', themeLabel);
      if (themeBtn.title !== themeLabel) themeBtn.title = themeLabel;

      // `live` 只在握手成功后出现；`connecting` 是过渡态，展示上与 offline 分开
      // （"正在连接"和"连不上"对用户是两件事，虽然后备行为相同）。
      const state = pushState === 'live' ? 'live' : pushState === 'connecting' ? 'connecting' : 'poll';
      if (sync.dataset.state !== state) sync.dataset.state = state;

      const base = STATE_TEXT[state] ?? STATE_TEXT.poll;
      // 只在**确实有**最近同步时间时才追加，否则会留下一个孤零零的分隔符
      // （实测：`实时同步中 · ` 后面什么都没有，看起来像渲染坏了）。
      // 文案来自 `format.js` 的 `formatAgo` —— 这里原来另写了一份 `relativeShort()`，
      // 于是同一个"多久以前"在顶栏与概览带上的档位不同（"30 秒前" vs "刚刚"）。
      const ago = lastSyncMs ? formatAgo(lastSyncMs, now) : null;
      setText(syncLabel, ago ? `${base} · ${ago}` : base);
      const syncTitle = lastSyncMs
        ? `${base}；最近一次从服务器读到新记录：${new Date(lastSyncMs).toLocaleString()}`
        : base;
      if (sync.title !== syncTitle) sync.title = syncTitle;
    },
  };
}
