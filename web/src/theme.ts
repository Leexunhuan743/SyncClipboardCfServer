// 主题 = 「风格」×「明暗」。
//   · 风格（style）：默认 / 海岸暮色 / 暖纸田园 / 网点俱乐部 —— 每套是一整套颜色令牌 + 造型 + 装饰（styles/themes.css）；
//   · 明暗（mode）：跟随系统 / 浅色 / 深色 —— **只对默认风格有意义**。三套特色风格各自带固定的明暗
//     （海岸暮色是深蓝夜色，另两套是纸色），强行反色会毁掉配色，所以选了它们时明暗开关不可用。
// 首帧由 static/theme-init.js 在 <head> 里同步写好（避免闪一帧默认风格），这里负责之后的切换。
export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeStyle = 'default' | 'coast' | 'paper' | 'pop';

export interface StyleInfo {
  id: ThemeStyle;
  name: string;
  desc: string;
  /** 固定明暗；`auto` = 由 ThemeMode 决定（仅默认风格） */
  scheme: 'auto' | 'dark' | 'light';
  /** 浏览器 UI（移动端地址栏/状态栏）的颜色；auto 风格用 [浅, 深] */
  chrome: string | [string, string];
}

export const STYLES: readonly StyleInfo[] = [
  { id: 'default', name: '默认', desc: '干净的冷灰蓝，浅色 / 深色 / 跟随系统。', scheme: 'auto', chrome: ['#f5f6fa', '#0d111f'] },
  { id: 'coast', name: '海岸暮色', desc: '复古丝网印刷：深海军蓝夜空、橙色落日与珊瑚点睛，胶囊圆角与细网点。', scheme: 'dark', chrome: '#1f2a40' },
  { id: 'paper', name: '暖纸田园', desc: '中世纪现代插画：米黄纸张、铁锈橙与鼠尾草绿，无描边大圆角，底部层叠山丘。', scheme: 'light', chrome: '#F2E8D2' },
  { id: 'pop', name: '网点俱乐部', desc: '双色波普海报：米白纸 + 深海军蓝 + 朱红，粗描边、硬偏移阴影、半调网点。', scheme: 'light', chrome: '#EDE4D2' },
];

declare global {
  interface Window {
    /** 由 static/theme-init.js 定义：按风格 / 明暗重画标签页图标 */
    __clipFavicon?: (style: string, dark: boolean) => void;
  }
}

const MODE_KEY = 'clip-theme';
const STYLE_KEY = 'clip-style';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 隐私模式：本次会话仍然生效 */
  }
}

export function getThemeMode(): ThemeMode {
  const saved = read(MODE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function getThemeStyle(): ThemeStyle {
  const saved = read(STYLE_KEY);
  return STYLES.some((s) => s.id === saved) ? (saved as ThemeStyle) : 'default';
}

export function styleInfo(id: ThemeStyle): StyleInfo {
  return STYLES.find((s) => s.id === id) ?? STYLES[0]!;
}

function apply(): void {
  const style = styleInfo(getThemeStyle());
  const mode = getThemeMode();
  const dark = style.scheme === 'auto' ? mode === 'dark' || (mode === 'system' && media.matches) : style.scheme === 'dark';
  const root = document.documentElement;
  root.dataset.style = style.id;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themeMode = mode;
  const chrome = Array.isArray(style.chrome) ? style.chrome[dark ? 1 : 0] : style.chrome;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chrome);
  window.__clipFavicon?.(style.id, dark);
}

export function setThemeMode(mode: ThemeMode): void {
  write(MODE_KEY, mode === 'system' ? null : mode);
  apply();
}

export function setThemeStyle(style: ThemeStyle): void {
  write(STYLE_KEY, style === 'default' ? null : style);
  apply();
}

export function initTheme(): void {
  media.addEventListener('change', () => {
    if (getThemeMode() === 'system') apply();
  });
  apply();
}

export const THEME_LABELS: Record<ThemeMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
