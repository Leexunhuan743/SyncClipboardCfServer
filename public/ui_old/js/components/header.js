// 顶栏：标识、**实时通道状态（兼部署信息入口）**、复制最近一条、主题切换、会话操作。
// 高度 --header-h（56px），吸顶，一条底边。不做悬停放大之类的花活。
//
// 2026-09-17 增补两处（此前都没有可见入口）：
//   · **实时通道状态**：`live / connecting / offline` 三态只写在 js/signalr.js 里，
//     用户唯一能看到它的地方是「部署信息」对话框（要主动点开）。而这三态直接决定
//     「别的设备改了这边多快看见」：live = 立即，offline = 等下一次轮询。做成顶栏的一枚
//     状态点后，它从「要查的参数」变成「一眼看到的状态」。
//   · **会话区收拢**：用户名与登出此前是两个各自独立的控件，中间隔着 8px，读起来像两个
//     无关动作。合成一枚 user chip（名字 + 分隔线 + 登出）后，顶栏右侧清楚分成
//     「状态 · 动作组 · 会话」三段。
//
// 2026-09-18 合并（用户定的形态）：**部署信息那枚独立按钮与推送状态合成一枚控件**。
//
// 形态：`[图标 部署信息]`，放在「复制最近一条」**后面**（它属于动作组，不属于状态区）：
//   · **可见文字只有「部署信息」** —— 控件的名字就是它做的事（点开对话框）；
//   · **推送状态只在那枚图标里**：三种状态三个字形（实时推送＝广播/信号、正在连接＝缺口圆环
//     旋转、轮询刷新＝刷新箭头），**hover 只显示状态词**（"实时推送"/"正在连接"/"轮询刷新"）；
//   · 整枚可点（图标与文字是一个命中区，不做"图标只是指示、只有文字可点"那种要靠猜的划分）。
//
// 这一版之前的两次尝试都错了，记在这里免得回头再走：
//   ① `[● 实时推送 ｜ 部署信息]`（两个词都上屏）：把"状态"当成按钮的名字读，且顶栏多出四个字；
//   ② `[● 实时推送 ⓘ]`：可见文字是**状态**而动作是**打开对话框**，名字与动作对不上，
//      入口还退化成一枚 12px 的 ⓘ —— 正是 `docs/ui.md` §9.5 记过的老毛病。
// 现在这条路的判据是"**文字说明动作、图标承载状态、hover 补状态名**"。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';

// 三种状态各有一个字形、一个色调、一个状态词、一句解释。
//   · 字形是形状层的区分（信号 / 缺口圆环 / 刷新箭头）——不依赖颜色也能分开；
//   · 色调是识别层的加速（青 / 琥珀 / 灰）；
//   · 状态词与解释**只在 hover 与无障碍名里**（屏上只有"部署信息"四个字）：
//     hover 给的是"状态词 + 一句解释"（`hint`），因为只给状态词的话，
//     "轮询刷新"这种说法对第一次用的人等于没说 —— 它没告诉他"改动还会来，只是晚一点"。
// connecting 用琥珀而不是灰：它是**进行中**，与 offline（终态、需用户知情）不是一回事。
const PUSH_STATES = {
  live: {
    label: '实时推送',
    icon: 'push',
    tone: 'live',
    hint: '实时推送已连接：其他设备的改动会立即出现',
  },
  connecting: {
    label: '正在连接',
    icon: 'connecting',
    tone: 'connecting',
    hint: '正在连接实时通道：当前仍按轮询刷新',
  },
  offline: {
    label: '轮询刷新',
    icon: 'refresh',
    tone: 'offline',
    hint: '轮询刷新中：实时通道未连接，改动会在下一次轮询时出现（可见时每 10 秒）',
  },
};

export function createHeader({ onToggleTheme, onLogout, onInfo, onCopyLatest }) {
  const who = el('span', { class: 'who' });
  const meta = el('span', { class: 'brand__meta' });
  // 图标是**唯一**承载状态的地方，故它随状态整体替换（三个字形互不相同，见 PUSH_STATES）
  const statusIcon = el('span', { class: 'status__icon-slot' });

  // 状态 + 入口合一：整枚可点，进「部署信息」—— 那里有完整解释
  // （传输清单、轮询间隔、保留策略、最近变更），胶囊自己只说结论。
  const statusButton = el(
    'button',
    { class: 'status', type: 'button', 'aria-live': 'polite', onclick: () => onInfo() },
    [statusIcon, el('span', { class: 'status__entry', text: '部署信息' })],
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

  // 「复制最近一条」（2026-09-18）：真实场景是"我在手机上复制了东西，现在想在电脑上粘出来"，
  // 而此前要先找到那一行（还得知道排序是创建时间倒序）再点它的复制键。放在顶栏是因为
  // 顶栏吸顶、永远在视野里，而它是这个页面唯一"跨筛选、跨分页"的动作。
  // 没有记录时整个按钮隐藏（而不是禁用着占位）：那时它没有任何可做的事。
  const copyLatestButton = el(
    'button',
    {
      class: 'btn btn--quiet',
      type: 'button',
      hidden: true,
      'aria-label': '复制最近一条',
      title: '把服务器上最新的一条剪贴板内容复制到本机剪贴板',
      onclick: (event) => onCopyLatest(event.currentTarget),
    },
    [svg(iconPaths('copy')), el('span', { class: 'btn__label', text: '复制最近一条' })],
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
      copyLatestButton,
      // 「部署信息（带推送状态图标）」紧跟「复制最近一条」：它是动作组的一员（点开对话框），
      // 状态只是它携带的一枚图标 —— 故不再单独立组、也不在前面放分隔线。
      statusButton,
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
    update({ username, version, theme, pushState, canCopyLatest }) {
      who.textContent = username ?? '';
      meta.textContent = version ? `v${version}` : '';
      copyLatestButton.hidden = !canCopyLatest;
      syncThemeIcon(theme);
      const state = PUSH_STATES[pushState] ?? PUSH_STATES.offline;
      statusIcon.replaceChildren(svg(iconPaths(state.icon), { size: 16, class: 'status__icon' }));
      statusButton.dataset.tone = state.tone;
      // hover 给「状态词 + 一句解释」（用户定的粒度）：例如"实时推送已连接：其他设备的改动会立即出现"。
      // 可访问名则**以动作为首**、只带状态词（"部署信息（实时推送）"）——理由有两条：
      //   ① 按钮的名字该说明它做什么，而它在屏幕上的文字就是"部署信息"（可访问名与可见标签一致）；
      //   ② 完整解释是给"看的人"读的，读屏用户进来就能在对话框里听到同一件事，
      //      把它塞进按钮名只会让每次状态变化都念一长句。
      statusButton.title = state.hint;
      statusButton.setAttribute('aria-label', `部署信息（${state.label}）`);
    },
  };
}
