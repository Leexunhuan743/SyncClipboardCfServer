// 展示层格式化：类型、体积、时间、日期分组、列表摘要。
// 只做「把值变成给人看的字符串」，不含 DOM、不含网络 —— 因此可以被测试直接覆盖。

// 四种可用的记录类型。`Unknown` / `None` 是协议里的枚举值，但**不会有记录**落在这两个值上
// （服务端 `resolveStrictProfileType` 拒绝它们），故展示层不为其设文案，回落到中性标签。
const TYPE_NAMES = { 0: 'Text', 1: 'File', 2: 'Image', 3: 'Group' };
const TYPE_LABELS = { Text: '文本', Image: '图片', File: '文件', Group: '组合' };
export const KINDS = ['Text', 'Image', 'File', 'Group'];

/** 服务端返回的 type 可能是枚举数字（协议侧）或类型名（UI 侧归一化后），两者都接受。 */
export function typeName(value) {
  if (typeof value === 'string') return value;
  return TYPE_NAMES[value] ?? 'Text';
}

export function typeLabel(name) {
  return TYPE_LABELS[name] ?? name ?? '未知';
}

/** 体积：给人类读的、最多一位小数。0/无效值给破折号而不是「0 B」（后者读起来像"有内容但是空的"）。 */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatClock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 相对时间：列表里读「多久以前」比读绝对时间快；绝对时间放 `title` 里。
 * 45 分钟以内按分钟、当天按小时、昨天给具体时刻、一周内给天数、更久给日期 ——
 * 每一档换一次单位而不是一直用同一个单位，因为「1344 分钟前」是**没算完**的数字。
 */
export function formatRelative(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const diff = now - ms;
  if (diff < 0) return formatClock(new Date(ms)); // 时钟偏差：显示绝对时刻而不是「-3 分钟前」
  if (diff < MINUTE) return '刚刚';
  if (diff < 45 * MINUTE) return `${Math.max(1, Math.round(diff / MINUTE))} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
  const date = new Date(ms);
  if (diff < 2 * DAY) return `昨天 ${formatClock(date)}`;
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)} 天前`;
  return formatDate(date);
}

/** 绝对时间：`2026-09-15 14:20:31`。用于 `title` 与预览对话框。 */
export function formatAbsolute(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso ?? '';
  const d = new Date(ms);
  return `${formatDate(d)} ${formatClock(d)}:${pad(d.getSeconds())}`;
}

/** 本地日界（用户说「今天」指的是自己时区里的今天，不是 UTC 的今天）。 */
export function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 时间分组的**标签**。
 *
 * 为什么在客户端算而不是让服务端给：分组的正确性取决于**用户的时区**，
 * 而服务端只知道 UTC（这也是 `/ui/api/activity` 要收 `tzOffset` 的原因）。
 * 列表分组按"当前这一页的记录"就地算，不需要额外请求。
 *
 * 返回 `{ key, label }`：`key` 用于比较（同一组必须同 key），`label` 是显示文案。
 */
export function dayGroup(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { key: 'unknown', label: '时间未知' };
  const today = startOfDay(now);
  const day = startOfDay(ms);
  const delta = Math.round((today - day) / DAY);
  if (delta <= 0) return { key: 'today', label: '今天' };
  if (delta === 1) return { key: 'yesterday', label: '昨天' };
  if (delta < 7) return { key: `d${delta}`, label: `${delta} 天前 · ${formatDate(new Date(ms))}` };
  if (delta < 30) return { key: `w${Math.floor(delta / 7)}`, label: `${Math.floor(delta / 7)} 周前` };
  return { key: `m${formatDate(new Date(ms)).slice(0, 7)}`, label: `${formatDate(new Date(ms)).slice(0, 7)}` };
}

// 列表单元格里显示的文本：文本记录用正文，文件类用文件名。
// 空文本占位：标签与样式判定共用这一个常量 —— 改动标签不会悄悄丢掉 `data-empty` 样式。
const EMPTY_TEXT = '（空文本）';
const EMPTY_NAME = '（无文件名）';

export function previewText(item) {
  if (item.type === 'Text') {
    const text = (item.text ?? '').trim();
    return text === '' ? EMPTY_TEXT : text;
  }
  return item.dataName ?? EMPTY_NAME;
}

/** 是否显示空占位样式：与 `previewText` 的标签出自同一常量。 */
export function previewIsEmpty(item) {
  const shown = previewText(item);
  return shown === EMPTY_TEXT || shown === EMPTY_NAME;
}

/** 时长（毫秒）→ 「2 分钟前 / 3 小时前」这种短文案。用于同步状态。 */
export function formatAgo(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

/** 把毫秒差说成「快 / 慢 N 分钟」——时钟差用它。`null` 表示无法判定。 */
export function describeClockSkew(offsetMs) {
  if (!Number.isFinite(offsetMs)) return null;
  const minutes = Math.round(offsetMs / MINUTE);
  if (Math.abs(minutes) < 1) return { tone: 'ok', text: '与本机一致' };
  const dir = minutes > 0 ? '快' : '慢';
  const abs = Math.abs(minutes);
  const text = `服务端${dir} ${abs} 分钟`;
  // 官方客户端在 |时钟差| > 5 分钟时**中止历史同步**（docs/protocol.md），
  // 所以这条不只是提示，它是"同步不动"最常见的根因之一。
  return { tone: Math.abs(minutes) > 5 ? 'warn' : 'ok', text };
}
