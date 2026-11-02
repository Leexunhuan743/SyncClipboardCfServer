// 「外观」对话框：选风格（每张卡片是该风格的缩小预览）+ 明暗（仅默认风格可用）。
// 选择即时生效、即时保存；不需要"确定"按钮。
import { h, icon } from '../lib/dom';
import { getThemeMode, getThemeStyle, setThemeMode, setThemeStyle, STYLES, THEME_LABELS, type ThemeMode, type ThemeStyle } from '../theme';
import { openModal } from '../ui/dialog';

/** 一张风格预览：`.style-preview[data-style]` 在局部作用域里套用该风格的颜色令牌。 */
export function stylePreview(style: ThemeStyle): HTMLElement {
  return h(
    'div',
    { class: 'style-preview', dataset: { style }, 'aria-hidden': 'true' },
    h('i'),
    h('div', { class: 'style-preview__main' }, h('div', { class: 'style-preview__row' }, h('b'), h('span'), h('span')), h('div', { class: 'style-preview__row' }, h('b'), h('span'), h('span')), h('span', { class: 'style-preview__btn', text: '按钮' })),
  );
}

export function openAppearance(): void {
  const grid = h('div', { class: 'style-grid', role: 'group', 'aria-label': '界面风格' });
  const modeRow = h('div', { class: 'mode-row' });

  const paint = (): void => {
    const current = getThemeStyle();
    grid.replaceChildren(
      ...STYLES.map((s) =>
        h(
          'button',
          { class: 'style-card', type: 'button', 'aria-pressed': String(s.id === current), onclick: () => { setThemeStyle(s.id); paint(); } },
          stylePreview(s.id),
          h('span', { class: 'style-card__name' }, s.name, s.id === current ? icon('check', { size: 18 }) : null),
          h('span', { class: 'style-card__desc', text: s.desc }),
        ),
      ),
    );

    const auto = current === 'default';
    const mode = getThemeMode();
    modeRow.replaceChildren(
      h('span', { class: 'mode-row__label', text: '明暗' }),
      ...(['system', 'light', 'dark'] as ThemeMode[]).map((m) =>
        h('button', { class: 'chip-btn', type: 'button', disabled: !auto, 'aria-pressed': String(auto && mode === m), onclick: () => { setThemeMode(m); paint(); } }, THEME_LABELS[m]),
      ),
      h('span', { class: 'mode-row__hint', text: auto ? '默认风格可以跟随系统或手动选浅色 / 深色。' : '这套风格自带固定的明暗配色（深色夜景或纸色），所以明暗开关只对「默认」风格可用。' }),
    );
  };
  paint();

  openModal({ title: '外观', subtitle: '选一套你喜欢的风格，立即生效，下次打开仍然记得', size: 'md', content: h('div', null, grid, modeRow) });
}
