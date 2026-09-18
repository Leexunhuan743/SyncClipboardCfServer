// 展示层格式化：类型、体积、时间、列表摘要。这里只做“把值变成给人看的字符串”，不含 DOM。

// 服务端返回的 type 是枚举数字（与官方协议一致：ASP.NET 默认按数字序列化枚举）
const TYPE_NAMES = { 0: 'Text', 1: 'File', 2: 'Image', 3: 'Group' };

const TYPE_LABELS = { Text: '文本', Image: '图片', File: '文件', Group: '组合' };
const TYPE_CHIP = { Text: 'chip--text', Image: 'chip--image', File: 'chip--file', Group: 'chip--group' };

export function typeName(value) {
  if (typeof value === 'string') return value;
  return TYPE_NAMES[value] ?? 'Text';
}

export function typeLabel(name) {
  return TYPE_LABELS[name] ?? name;
}

export function typeChipClass(name) {
  return TYPE_CHIP[name] ?? 'chip--neutral';
}

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

// 相对时间：列表里读“多久以前”比读绝对时间快；绝对时间放 title。
export function formatRelative(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const diff = now - ms;
  // 未来时间戳**必须显式说"以后"**：此前它退回 `formatClock`，于是一条 2035 年的记录
  // 在列表里显示成 "09:03" —— 看起来像"今天早上刚发生的"（截图走查发现）。
  //
  // 未来值不是臆想：官方客户端所在机器的时钟偏快时，服务端就存下未来时间戳
  // （docs/protocol.md §4 的"时钟差 > 5 分钟中止历史同步"正是为这类场景设的），
  // 而本仓库的写库测试也刻意写未来值来保证新记录排到首页。把这种值画成一个时刻，
  // 等于把"这台设备的时钟可能不对"这条线索藏掉。
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < MINUTE) return '刚刚';
    if (ahead < 45 * MINUTE) return `${Math.round(ahead / MINUTE)} 分钟后`;
    if (ahead < DAY) return `${Math.round(ahead / HOUR)} 小时后`;
    if (ahead < 7 * DAY) return `${Math.round(ahead / DAY)} 天后`;
    return formatDate(new Date(ms));
  }
  if (diff < MINUTE) return '刚刚';
  if (diff < 45 * MINUTE) return `${Math.max(1, Math.round(diff / MINUTE))} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return `昨天 ${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)} 天前`;
  return formatDate(new Date(ms));
}

function formatClock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatAbsolute(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${formatDate(d)} ${formatClock(d)}:${pad(d.getSeconds())}`;
}

// 列表单元格里显示的文本：文本记录用正文，文件类用文件名。
// 空文本占位：标签与样式判定共用这一个常量——改动标签不会悄悄丢掉 `--empty` 样式。
const EMPTY_TEXT = '（空文本）';

export function previewText(item) {
  if (item.type === 'Text') {
    const text = (item.text ?? '').trim();
    return text === '' ? EMPTY_TEXT : text;
  }
  return item.dataName ?? '（无文件名）';
}

// 是否显示空文本占位样式：与 previewText 的标签出自同一常量。
export function previewIsEmpty(item) {
  return previewText(item) === EMPTY_TEXT;
}
