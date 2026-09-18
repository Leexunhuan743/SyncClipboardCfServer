// 主搜索框：44px 高、全宽。
//
// V2 相对 V1 的位置改动：V1 把搜索压成 200px 挤在工具栏里，而「找回来」是这个界面
// 最高频的动作（场景 S1/S2）。把一个高频动作的目标做成最窄的那个，是使用成本最直接的来源。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { debounce } from '../dom.js';

/**
 * @param {{ onSearch: (value: string) => void }} handlers
 *        `onSearch` 是**去抖后**的最终值；调用方不必再自己 debounce。
 */
export function createOmnibox({ onSearch }) {
  const icon = svg(iconPaths('search'), { size: 17, class: 'omnibox__icon' });

  const input = el('input', {
    class: 'omnibox__input',
    id: 'omnibox-input',
    type: 'search',
    placeholder: '搜索剪贴板内容…',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-label': '搜索剪贴板内容',
  });

  const clearBtn = el(
    'button',
    {
      class: 'omnibox__clear',
      type: 'button',
      'aria-label': '清空搜索',
      title: '清空搜索',
      hidden: true,
      dataset: { icon: 'close' },
      onclick: () => {
        emit.cancel();
        input.value = '';
        syncClear();
        onSearch('');
        input.focus();
      },
    },
    [svg(iconPaths('close'), { size: 15 })],
  );

  // `aria-hidden`：这只是一个给鼠标用户看的快捷键提示，对读屏它是一段没有上下文的
  // 裸文本（"Ctrl K" 会被念出来，用户不知道那是什么）。快捷键本身在 `boot.js` 里实现。
  const kbd = el('kbd', { class: 'kbd', text: shortcutLabel(), 'aria-hidden': 'true' });

  const root = el('div', { class: 'omnibox' }, [icon, input, clearBtn, kbd]);

  function syncClear() {
    clearBtn.hidden = input.value === '';
  }

  // 输入去抖 240ms：比敲键间隔略长，又短到不觉得迟钝。
  // 每次按键都发请求会在一次搜索里打十几次 D1（每次都是一条 `LIKE %…%`）。
  const emit = debounce((value) => onSearch(value.trim()), 240);
  let composing = false;
  let committedValue = '';

  input.addEventListener('compositionstart', () => {
    composing = true;
    emit.cancel();
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    syncClear();
    emit(input.value);
  });

  input.addEventListener('input', () => {
    syncClear();
    if (!composing) emit(input.value);
  });

  // Esc：清空并保持焦点（第二次 Esc 才失焦，由浏览器默认行为处理）
  input.addEventListener('keydown', (event) => {
    if (!composing && !event.isComposing && event.key === 'Escape' && input.value !== '') {
      event.preventDefault();
      emit.cancel();
      input.value = '';
      syncClear();
      onSearch('');
    }
  });

  // Enter：立刻搜索，不等去抖（用户已明确表示"就这个"）
  input.addEventListener('keydown', (event) => {
    if (!composing && !event.isComposing && event.key === 'Enter') {
      event.preventDefault();
      emit.cancel();
      onSearch(input.value.trim());
    }
  });

  return {
    el: root,
    input,

    setValue(value, { force = false } = {}) {
      const next = value ?? '';
      // 背景刷新不能覆盖正在输入的草稿；只有已提交筛选变化才同步输入框。
      if (!force && committedValue === next) return;
      committedValue = next;
      emit.cancel();
      input.value = next;
      syncClear();
    },

    focus() {
      input.focus();
      input.select();
    },

    /**
     * 忙碌态：搜索是**输入驱动**的，本地没有可显示的进度。
     * 这里只标记 `data-busy`（把图标降透明），不做转圈 —— 转圈会让人以为"搜索在跑"，
     * 而实际上只是等一次往返，通常 100ms 内就回来了。
     */
    setBusy(busy) {
      if (busy) root.setAttribute('data-busy', '');
      else root.removeAttribute('data-busy');
    },
  };
}

// `navigator.platform` 已废弃但仍是最可靠的同步判据；`userAgentData` 是异步的，
// 而这段文案要在首帧就画出来。误判的代价只是提示一个不生效的快捷键。
function shortcutLabel() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return isMac ? '⌘K' : 'Ctrl K';
}
