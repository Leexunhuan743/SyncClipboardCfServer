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
 *           onFocusSearch: () => void, onRefresh: () => void }} handlers
 */
export function createAppbar({ onToggleTheme, onLogout, onOpenDrawer, onFocusSearch, onRefresh }) {
  const mark = el('span', { class: 'brand__mark', 'aria-hidden': 'true' }, [
    svg(iconPaths('clipboard'), { size: 17 }),
  ]);
  // 品牌名**不是**这一页的 `<h1>`：整页唯一的一级标题由工作区提供
  // （`public/ui_v2/app/index.html` 的 `.workspace-heading__title`「剪贴板历史」）。
  // 这里刻意用 `<span>`：顶栏是跨页共用的外壳，让它承载文档级标题会与工作区争同一个层级。
  const name = el('span', { class: 'brand__name', text: 'SyncClipboard' });
  const meta = el('span', { class: 'brand__meta', text: '' });
  const brand = el('div', { class: 'brand' }, [
    mark,
    el('div', { class: 'brand__text' }, [name, meta]),
  ]);

  // 同步状态：点 + 文案。`data-state` 是**视觉**的唯一判据（见 shell-v2.css）。
  const syncDot = el('span', { class: 'sync__dot' });
  const syncLabel = el('span', { class: 'sync__label', text: '' });
  // **播报区与视觉区分开**（2026-09-18 修）：`role="status"` 不能挂在一个带**相对时间**的节点上 ——
  // `formatAgo` 一跨分钟档就变，而 `renderChrome()` 每 10 秒调一次 ⇒ 读屏用户每约一分钟被
  // 主动打断一次，念的是"实时同步中 · N 分钟前"，永远念不完。
  // 做法与 V1 的 `components/header.js` 逐字一致：视觉隐藏的 status 区域只承载**状态词**
  // （不带解释：状态抖动时一长句念不完），且只在真的变化时改写。
  // 它同时解决了窄屏的问题：≤720 时 `.sync__label` 被 `display: none` 移出无障碍树，
  // 而这一份**不随视口变**（`shell-v2.css` 那条注释此前说"文案靠 title/aria-label" ——
  // `title` 确实写了，`aria-label` 从来没设过）。
  const syncStatus = el('span', { class: 'sr-only', role: 'status' });
  // 初值 `offline`（还没握过手，也确实没连上）；它只存在到第一次 `update()`。
  const sync = el('div', { class: 'sync', dataset: { state: 'offline' } }, [
    syncDot,
    syncLabel,
    syncStatus,
  ]);

  const who = el('span', { class: 'who', text: '' });

  const searchBtn = iconButton({
    icon: 'search',
    label: '搜索（按 / 或 Ctrl+K）',
    onClick: onFocusSearch,
  });
  // 只在小屏出现（大屏有完整搜索框，这个入口是重复的）—— 由 CSS 的 `data-when` 控制
  searchBtn.setAttribute('data-when', 'narrow');

  // 刷新入口**也只在窄屏出现**（2026-09-18 补）：宽屏它留在筛选条里（那里离列表更近），
  // 而 ≤720px 时筛选条把它 `display: none` 掉了 —— 那条规则原本的注释说"收进抽屉的一部分"，
  // 但抽屉里**没有**刷新控件，顶栏也没有 ⇒ 手机上唯一的刷新手段是等 10 秒自动轮询
  // （快捷键 `r` 对触屏不存在）。见 `docs/AUDIT-missing-states.md` §3.4。
  const refreshBtn = iconButton({ icon: 'refresh', label: '刷新', onClick: onRefresh });
  refreshBtn.setAttribute('data-when', 'narrow');

  // 主题按钮的文案**随当前主题变**（图标表示"点它会切到哪一边"），故这里给的是初始值，
  // 真正的措辞在 `update()` 里按生效主题重写 —— 包括 `title`（见下）。
  const themeBtn = iconButton({ icon: 'moon', label: '切换到深色主题', onClick: onToggleTheme });
  const settingsBtn = iconButton({ icon: 'settings', label: '概览与设置', onClick: onOpenDrawer });
  const logoutBtn = iconButton({ icon: 'logout', label: '退出登录', onClick: onLogout });

  const actions = el('div', { class: 'appbar__actions' }, [
    refreshBtn,
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
  // 没有 `offline` 这一档：轮询**一直在跑**，所以通道断着时用户能看到的事实就是"定时检查中"
  // （与 V1 的措辞一致）。此前这里定义过一档「未连接」，而代码从不产出它 —— 死配置，
  // 见 `docs/AUDIT-missing-states.md` §2.3。
  const STATE_TEXT = {
    live: '实时同步中',
    poll: '定时检查中',
    connecting: '正在连接…',
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

      // 「开发测试版」是**常驻**标记（2026-09-18 定位调整：默认界面变成 V1 `public/ui_v1/`，
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

      // `data-state` 只有三档可达（色相定义见 `shell-v2.css`）：
      //   live       —— 实时通道握手成功；
      //   connecting —— 正在握手（短暂过渡，与"连不上"对用户确实是两件事）；
      //   poll       —— **其余一切，包括"通道断着"**：轮询一直在跑，所以用户能验证的事实是
      //                 "定时检查中"（与 V1 的措辞一致）。
      // 此前这里多定义了一个 `offline`（「未连接」）档，却把 `pushState === 'offline'` 折进 `'poll'`，
      // 于是那一档文案永远画不出来；而紧接着的注释写的是"展示上与 offline 分开"—— 与代码相反。
      // 见 `docs/AUDIT-missing-states.md` §2.3 / §4.2。
      const state = pushState === 'live' ? 'live' : pushState === 'connecting' ? 'connecting' : 'poll';
      if (sync.dataset.state !== state) sync.dataset.state = state;

      const base = STATE_TEXT[state] ?? STATE_TEXT.poll;
      // 播报区只写**状态词**，且只在真的变化时改写：同值写入本身也可能触发一次播报，
      // 而这里是每 10 秒必被调用的路径（V1 的 `header.js` 有同一条纪律）。
      if (syncStatus.textContent !== base) syncStatus.textContent = base;
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
