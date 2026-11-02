// 快捷键：只是加速器 —— 每个键位都有可见的等价入口；帮助表与派发器出自同一份注册表。
import { h } from '../lib/dom';
import { openModal } from './dialog';

export interface Shortcut {
  /** `event.key` 的取值，如 `'j'`、`'/'`、`'Delete'` */
  keys: string[];
  /** 展示用的键帽文字（不写则用 keys[0]） */
  caps?: string[];
  label: string;
  group: string;
  run: (event: KeyboardEvent) => void;
  /** 返回 false 时不触发（也不拦截按键） */
  when?: () => boolean;
}

// 注册表是**整张替换**的：应用每次启动（登录 / 会话过期后重新登录）都会重新注册一份，
// 闭包里捕获的是那一次启动的 state。若是追加，重新登录后 `registry.find` 命中的仍是已停止的旧应用的条目，
// 按键就会作用在一个已经不渲染的旧状态上（表现为快捷键「按了没反应」或操作了看不见的数据）。
let registry: Shortcut[] = [];

export function registerShortcuts(list: Shortcut[]): void {
  registry = [...list];
}

/** 应用停止时调用：之后的按键不再派发到已销毁的应用。 */
export function clearShortcuts(): void {
  registry = [];
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

let installed = false;

/** 全局只装一次（重复启动应用时不叠加监听器）。 */
export function installShortcutDispatcher(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target)) return;
    // 模态框或弹出菜单打开时一律不抢键（它们自己处理方向键与 Esc）
    if (document.querySelector('dialog[open], .menu:popover-open')) return;
    const hit = registry.find((s) => s.keys.includes(event.key) && (s.when?.() ?? true));
    if (!hit) return;
    event.preventDefault();
    hit.run(event);
  });
}

export function showShortcutHelp(): void {
  const groups = new Map<string, Shortcut[]>();
  for (const s of registry) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  const content = h(
    'div',
    { class: 'shortcuts' },
    [...groups].map(([group, list]) =>
      h(
        'section',
        { class: 'shortcuts__group' },
        h('h3', { class: 'section-title', text: group }),
        h(
          'dl',
          { class: 'shortcuts__list' },
          list.flatMap((s) => [
            h('dt', null, (s.caps ?? [s.keys[0] ?? '']).map((cap) => h('kbd', { class: 'kbd', text: cap }))),
            h('dd', { text: s.label }),
          ]),
        ),
      ),
    ),
  );
  openModal({ title: '键盘快捷键', subtitle: '在输入框里时不会触发', content, size: 'md' });
}
