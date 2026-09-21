// 结果行的行内内容：缩略图与降级、状态徽标、收藏/置顶开关的字段与文案。
//
// 从 list.js 拆出：那边剩下的是列表生命周期（表格骨架、按行对账、选择与焦点交接），
// 这里只回答「给定一条记录，它在行内长什么样；按下开关，状态怎么就地更新」。
// 成员都是呈现层：入参是记录或按钮，不读列表的对账状态。
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';
import { formatSize } from '../format.js';
import { api } from '../api.js';
import { itemIsImage } from '../clipboard.js';

// 缩略图只对「小图」直接取原图。数据端点不做缩放（R2 透传），所以一条 32 MiB 的图片记录
// 就是一整张 32 MiB 的下载——`loading="lazy"` 只推迟它，不减少它。超过阈值改用占位，
// 要看原图走行内「预览」（那是一次**用户主动**的请求）。
const THUMB_MAX_BYTES = 512 * 1024;

function thumbPlaceholder(className, title, icon) {
  return el('div', { class: `cell-content__thumb ${className}`, title }, [svg(iconPaths(icon), { size: 16 })]);
}

function buildThumb(item) {
  // 判据与「复制图片」按钮、预览对话框**必须同一份**（`clipboard.js` 的 `itemIsImage`：
  // Image 类型，或文件名带图片扩展名）。此前这里判的是 `type !== 'Image'`，于是
  // 一条 `POST /api/history` 同步过来的 `File/shot.png`（上游只在 PUT 路径把 File 提升成
  // Image，见 src/profile.ts）会出现「有『复制图片』按钮、却没有缩略图、点开还说不能预览」
  // 这种自相矛盾。V2 的缩略图用的就是这个判据（public/ui_v2/js/ui/row.js）。
  if (!itemIsImage(item)) return null;

  if (!item.hasData) {
    return thumbPlaceholder('cell-content__thumb--missing', '服务器上没有这条记录的图片数据', 'warning');
  }

  // 大图不拉原图：见 THUMB_MAX_BYTES 的说明
  if (Number(item.size) > THUMB_MAX_BYTES) {
    return thumbPlaceholder(
      'cell-content__thumb--large',
      `图片较大（${formatSize(item.size)}），点击预览查看`,
      'image',
    );
  }

  const image = el('img', {
    class: 'cell-content__thumb',
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    src: api.dataUrl(item),
  });
  image.addEventListener('error', () => {
    // 两种原因都会走到这里，故文案要对两者都成立：对象已被清理（线上真有这种记录），
    // 或者文件名看着像图片、内容其实不是（服务端不校验 File 的扩展名与内容是否一致）。
    // 不要写成「数据不可用：文件已不在服务器上」—— 后者在第二种情况下是误报。
    image.replaceWith(
      thumbPlaceholder(
        'cell-content__thumb--missing',
        '缩略图加载失败：数据可能已不在服务器上，或该文件不是可显示的图片',
        'warning',
      ),
    );
  });
  return image;
}

function buildFlags(item) {
  const flags = [];
  if (item.pinned) flags.push(el('span', { class: 'chip chip--neutral' }, [
    svg(iconPaths('pin'), { size: 12 }),
    el('span', { text: '置顶' })
  ]));
  // 防御性分支：服务端拒绝写入「非 Text 且没有传输数据」的 Profile（profile.ts 的
  // `Transfer data is required for …`），因此**当前数据不变量下不可达**（实测线上 + 本地
  // 226 条非 Text 记录中 hasData=false 为 0 条）。保留是因为 hasData 由服务端推导、
  // 类型上允许为假，且历史上（F26 修复前）确实产生过这类行——真出现时不该渲染成可下载。
  if (!item.hasData && item.type !== 'Text') {
    flags.push(el('span', { class: 'chip chip--warn', text: '数据不可用' }));
  } else if (item.type === 'Text' && item.hasData) {
    flags.push(el('span', { class: 'chip chip--neutral', text: '含数据文件' }));
  }
  if (item.textTruncated) flags.push(el('span', { class: 'chip chip--neutral', text: '长文本' }));
  // 恒返回容器（空容器由 CSS 的 `:empty` 隐藏）：收藏/置顶是行内开关，按下之后徽标要立刻跟上——
  // 有稳定容器才能就地替换，而不是等下一次轮询重建整行（重建会丢焦点、重载缩略图）。
  return el('div', { class: 'cell-content__flags' }, flags);
}

// 行内开关（收藏 / 置顶）：字段与文案成对出现——行内按钮、批量操作、就地更新三处都读这一份，
// 各写一份必然出现「行内按钮说取消收藏、批量按钮说收藏」这类自相矛盾的界面。
const TOGGLES = {
  star: { field: 'starred', labels: { on: '取消收藏', off: '收藏' } },
  pin: { field: 'pinned', labels: { on: '取消置顶', off: '置顶' } },
};

function applyToggleState(button, on, labels) {
  const label = on ? labels.on : labels.off;
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

// 重放开关动画：同一个 data-pop 属性不会重启动画，故先删、强制回流、再置上。
function playPop(button) {
  if (!button) return;
  const icon = button.querySelector('svg');
  if (!icon) return;
  delete button.dataset.pop;
  void button.offsetWidth;
  button.dataset.pop = 'true';
  icon.addEventListener('animationend', () => delete button.dataset.pop, { once: true });
}

export { buildThumb, buildFlags, TOGGLES, applyToggleState, playPop };
