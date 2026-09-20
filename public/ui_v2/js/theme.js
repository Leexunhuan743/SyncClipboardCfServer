// 主题与密度：读写 `localStorage`、切换 `<html>` 上的属性、同步 `theme-color`。
//
// 与 `theme-init.js` 的分工：那个是**阻塞式经典脚本**，只负责首帧前定好属性（避免白闪）；
// 这个是模块，负责运行期的**切换**。两者共享同一套存储键 —— 键名重复两次是刻意的，
// 因为经典脚本不能 import 模块（那会把首帧推迟到模块加载之后，正是它要避免的事）。
const THEME_KEY = 'sb-ui-theme';
const DENSITY_KEY = 'sb-ui-density';

// 与 `tokens-v2.css` 的 `--bg` 一致。原注释给的理由是「切换后 `getComputedStyle` 会立即返回
// **旧值**（样式重算是异步的），于是 theme-color 总是慢一步」—— **2026-09-20 实测证伪**：
// 同一个同步块里改完 `data-theme` 再读，计算值立刻就是新主题的 `--bg`
// （dark `#191817` → light `#faf8f5`；见 `docs/progress.md` §94 第 17 行）。
// 仍用显式映射是为了**不依赖时序**，不是因为计算值会慢。
const BG = { light: '#f5f2ee', dark: '#15191a' };

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function currentDensity() {
  return document.documentElement.dataset.density === 'compact' ? 'compact' : 'comfortable';
}

function syncThemeColor(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', BG[theme] ?? BG.light);
}

export function setTheme(theme, { persist = true } = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  syncThemeColor(next);
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* 隐私模式下写不进去：本次会话仍然生效 */
    }
  }
  return next;
}

export function setDensity(density, { persist = true } = {}) {
  const next = density === 'compact' ? 'compact' : 'comfortable';
  if (next === 'compact') document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
  if (persist) {
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      /* 同上 */
    }
  }
  return next;
}
