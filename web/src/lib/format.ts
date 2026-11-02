// 展示层格式化：类型、体积、时间、摘要。纯函数，不碰 DOM（test/ui-logic.test.ts 直接覆盖）。
import type { Item, ItemType } from './types';

// 服务端按上游惯例把 type 序列化成数字
const TYPE_NAMES: Record<number, ItemType> = { 0: 'Text', 1: 'File', 2: 'Image', 3: 'Group' };
const TYPE_LABELS: Record<string, string> = { Text: '文本', Image: '图片', File: '文件', Group: '组合' };

export function typeName(value: unknown): ItemType {
  if (typeof value === 'string') return (value in TYPE_LABELS ? value : 'Text') as ItemType;
  return TYPE_NAMES[value as number] ?? 'Text';
}

export function typeLabel(name: string): string {
  return TYPE_LABELS[name] ?? name;
}

/** 体积。`0` 是真值（"0 B"），不是"取不到"。 */
export function formatSize(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  if (n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
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

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dateText = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 相对时间。未来时间戳必须显式说"以后"：官方客户端所在机器的时钟偏快时，服务端就存着未来值，
 * 把它画成一个过去的时刻会藏掉"这台设备的时钟可能不对"这条线索。
 */
export function formatRelative(value: string | number, now = Date.now()): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return '—';
  const diff = now - ms;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < MINUTE) return '刚刚';
    if (ahead < 45 * MINUTE) return `${Math.round(ahead / MINUTE)} 分钟后`;
    if (ahead < DAY) return `${Math.round(ahead / HOUR)} 小时后`;
    if (ahead < 7 * DAY) return `${Math.round(ahead / DAY)} 天后`;
    return dateText(new Date(ms));
  }
  if (diff < MINUTE) return '刚刚';
  if (diff < 45 * MINUTE) return `${Math.max(1, Math.round(diff / MINUTE))} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
  const d = new Date(ms);
  if (diff >= 7 * DAY) return dateText(d);
  // 「昨天」是日历概念：47 小时前也可能是前天（现在周三 23:00，对方周一 23:30），不能按小时数判
  const days = calendarDaysBetween(d, new Date(now));
  return days <= 1 ? `昨天 ${clock(d)}` : `${days} 天前`;
}

/** 两个时刻相隔的自然日数（按本地日历，夏令时当天不会差一天） */
function calendarDaysBetween(earlier: Date, later: Date): number {
  const a = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  const b = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
  return Math.round((b - a) / DAY);
}

export function formatAbsolute(value: string | number): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return String(value);
  const d = new Date(ms);
  return `${dateText(d)} ${clock(d)}:${pad(d.getSeconds())}`;
}

/** 时钟时刻（今天只显示时分，否则带日期）。列表的分组内时间用它。 */
export function formatClock(value: string | number, now = Date.now()): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  const sameDay = dateText(d) === dateText(new Date(now));
  return sameDay ? clock(d) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}`;
}

/** 按日历日分组用的标签：今天 / 昨天 / 本周几 / 日期。 */
export function dayLabel(value: string | number, now = Date.now()): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return '未知时间';
  const startOf = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOf(now) - startOf(ms)) / DAY);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 0) return '之后';
  const d = new Date(ms);
  if (days < 7) return `周${'日一二三四五六'[d.getDay()]} · ${dateText(d).slice(5)}`;
  return d.getFullYear() === new Date(now).getFullYear() ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : dateText(d);
}

// 「用户眼里的一个字符」：emoji/组合字符很常见，按 UTF-16 码元切会切出半个字符（渲染成 �）。
const SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function splitChars(text: string | null | undefined): string[] {
  const value = text ?? '';
  if (SEGMENTER === null) return Array.from(value);
  return [...SEGMENTER.segment(value)].map((part) => part.segment);
}

/** 截断到最多 `max` 个字符（不切坏字素簇）。省略号由调用方加。 */
export function truncateText(text: string | null | undefined, max: number): string {
  const parts = splitChars(text);
  return parts.length <= max ? parts.join('') : parts.slice(0, max).join('');
}

export function charCount(text: string | null | undefined): number {
  return splitChars(text).length;
}

const EMPTY_TEXT = '（空文本）';

/** 列表里显示的主文本：文本记录用正文，文件类用文件名。 */
type Previewable = Pick<Item, 'type' | 'text' | 'dataName'>;

export function previewText(item: Previewable): string {
  if (item.type === 'Text') {
    const text = (item.text ?? '').trim();
    return text === '' ? EMPTY_TEXT : text;
  }
  return item.dataName ?? '（无文件名）';
}

export function previewIsEmpty(item: Previewable): boolean {
  return previewText(item) === EMPTY_TEXT;
}

/**
 * 落盘文件名的安全化。`dataName` 来自客户端，不可信：
 * ① 取 basename ② 替换文件系统不认的字符 ③ 去结尾的 `- . 空白` ④ 限长 64 并保留扩展名。
 */
export function safeFileName(rawName: string | null | undefined, fallback = 'download'): string {
  const raw = (rawName ?? '').trim();
  const base = raw === '' ? '' : (raw.split(/[\\/]/).pop() ?? '');
  const cleaned = (base || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/[-.\s]+$/, '');
  if (cleaned === '') return fallback;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  const stem = ext === '' ? cleaned : cleaned.slice(0, dot);
  return `${stem.slice(0, Math.max(1, 64 - ext.length))}${ext}`;
}

/** 文本记录下载名：有原文件保留原名，否则 `<type>-<hash 前 8 位>.txt`。 */
export function downloadNameForText(item: Pick<Item, 'type' | 'hash' | 'dataName'> | null | undefined): string {
  const fallback = `${item?.type ?? 'Text'}-${(item?.hash ?? '').slice(0, 8)}.txt`;
  return safeFileName(item?.dataName ?? '', fallback);
}

/** 记录的"标题"：第一行非空文本，限长。 */
export function titleOf(item: Previewable, max = 60): string {
  const text = previewText(item);
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? text;
  const cut = truncateText(first.trim(), max);
  return cut.length < first.trim().length ? `${cut}…` : cut;
}

const TEXTLIKE = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml', 'ini', 'conf', 'js', 'ts', 'css', 'html', 'py', 'sh', 'sql']);

/** 文件名是否是可在详情里直接读文本的类型（大小另判）。 */
export function isTextLikeName(name: string | null | undefined): boolean {
  if (!name) return false;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXTLIKE.has(name.slice(dot + 1).toLowerCase());
}

/**
 * 整段文本恰好是一个 http(s) 链接时返回它（规范化后的 href），否则 null。
 * 只认**整段就是一个链接**：正文里夹着的链接不处理（点开的是"整条记录"，不是其中某个词）。
 * 协议白名单只放 http/https —— `javascript:`、`data:`、`file:` 一律不当链接。
 */
export function singleUrl(text: string | null | undefined): string | null {
  const value = (text ?? '').trim();
  if (value === '' || value.length > 2048 || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** 保留时长的人话：`43200` → "30 天"，`0` → "不限制"。 */
export function describeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '不限制';
  // 整除就只说一个单位；否则拆成"天 小时 分钟"（超过一天时不说"25 小时"这种别扭的写法）
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes < 1440 && minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时`;
  if (minutes < 60) return `${minutes} 分钟`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ');
}

/**
 * 定时清理每小时的第几分钟触发（UTC 分钟位，与 wrangler.toml 的 `crons = ["7,27,47 * * * *"]` 一致；
 * `test/ui-guard.test.ts` 守着两处同步）。
 */
export const CLEANUP_MINUTES: readonly number[] = [7, 27, 47];

/** 距离下一次清理还有几分钟（1..20）。 */
export function minutesUntilNextCleanup(now: number = Date.now()): number {
  const date = new Date(now);
  const current = date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const next = CLEANUP_MINUTES.find((m) => m > current) ?? (CLEANUP_MINUTES[0] ?? 0) + 60;
  return Math.max(1, Math.ceil(next - current));
}

/** 服务端对"新建/编辑文本"正文的上限：1 MiB（**字节**，UTF-8）。一个汉字 3 字节，所以按字符数判是错的。 */
export const TEXT_MAX_BYTES = 1024 * 1024;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
