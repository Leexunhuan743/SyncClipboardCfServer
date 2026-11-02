// 展示层格式化的纯逻辑：体积、相对时间、分组标签、截断、文件名安全化。
import { describe, expect, it } from 'vitest';
import {
  charCount, dayLabel, downloadNameForText, formatClock, formatRelative, formatSize, isTextLikeName,
  previewIsEmpty, previewText, safeFileName, titleOf, truncateText, typeLabel, typeName,
  CLEANUP_MINUTES, describeMinutes, minutesUntilNextCleanup,
} from '../src/lib/format';

const NOW = new Date(2026, 10, 1, 15, 30, 0).getTime();

describe('typeName / typeLabel', () => {
  it('服务端的数字枚举归一成类型名；未知值回落 Text', () => {
    expect([0, 1, 2, 3].map(typeName)).toEqual(['Text', 'File', 'Image', 'Group']);
    expect(typeName('Image')).toBe('Image');
    expect(typeName('Bogus')).toBe('Text');
    expect(typeName(99)).toBe('Text');
    expect(typeLabel('Group')).toBe('组合');
  });
});

describe('formatSize', () => {
  it('0 是真值，不是"取不到"', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(Number.NaN)).toBe('—');
    expect(formatSize('abc')).toBe('—');
  });
  it('单位阶梯与取整', () => {
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(10 * 1024)).toBe('10 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(104.857_600_000_000_01)).toBe('105 B');
  });
});

describe('formatRelative', () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  it('过去的时间用相对说法', () => {
    expect(formatRelative(ago(20_000), NOW)).toBe('刚刚');
    expect(formatRelative(ago(5 * 60_000), NOW)).toBe('5 分钟前');
    expect(formatRelative(ago(3 * 3_600_000), NOW)).toBe('3 小时前');
    expect(formatRelative(ago(3 * 86_400_000), NOW)).toBe('3 天前');
  });
  it('未来的时间必须说"以后"，不能画成过去的某个时刻', () => {
    expect(formatRelative(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBe('10 分钟后');
    expect(formatRelative(new Date(NOW + 2 * 3_600_000).toISOString(), NOW)).toBe('2 小时后');
  });
  it('非法输入回落破折号', () => {
    expect(formatRelative('not a date', NOW)).toBe('—');
  });
});

describe('dayLabel / formatClock', () => {
  it('今天 / 昨天 / 本周 / 更早', () => {
    const at = (days: number) => new Date(2026, 10, 1 - days, 9, 0, 0).getTime();
    expect(dayLabel(at(0), NOW)).toBe('今天');
    expect(dayLabel(at(1), NOW)).toBe('昨天');
    expect(dayLabel(at(3), NOW)).toMatch(/^周[日一二三四五六] · \d{2}-\d{2}$/);
    expect(dayLabel(at(20), NOW)).toBe('10 月 12 日');
    expect(dayLabel(new Date(2025, 5, 3).getTime(), NOW)).toBe('2025-06-03');
    expect(dayLabel(NOW + 3 * 86_400_000, NOW)).toBe('之后');
  });
  it('今天只显示时分，其它日子带日期', () => {
    expect(formatClock(new Date(2026, 10, 1, 8, 5).getTime(), NOW)).toBe('08:05');
    expect(formatClock(new Date(2026, 9, 30, 8, 5).getTime(), NOW)).toBe('10-30 08:05');
  });
});

describe('truncateText / charCount（用户眼里的字符）', () => {
  it('不会把 emoji 切成半个字符', () => {
    const text = '😀😀😀';
    expect(charCount(text)).toBe(3);
    expect(truncateText(text, 2)).toBe('😀😀');
    expect(truncateText('abc', 10)).toBe('abc');
    expect(truncateText(null, 3)).toBe('');
  });
});

describe('previewText / titleOf', () => {
  it('文本用正文、文件类用文件名、空文本有占位', () => {
    expect(previewText({ type: 'Text', text: '  hello \n', dataName: null })).toBe('hello');
    expect(previewText({ type: 'File', text: '', dataName: 'a.zip' })).toBe('a.zip');
    expect(previewText({ type: 'File', text: '', dataName: null })).toBe('（无文件名）');
    expect(previewIsEmpty({ type: 'Text', text: '   ', dataName: null })).toBe(true);
    expect(previewIsEmpty({ type: 'Text', text: 'x', dataName: null })).toBe(false);
  });
  it('标题取第一行非空文本并限长', () => {
    expect(titleOf({ type: 'Text', text: '\n\nfirst line\nsecond', dataName: null })).toBe('first line');
    expect(titleOf({ type: 'Text', text: 'x'.repeat(100), dataName: null }, 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('safeFileName（落盘文件名不可信）', () => {
  it('去路径、替换非法字符、去结尾点与空白', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\a\\b.txt')).toBe('b.txt');
    expect(safeFileName('a:b*c?.txt')).toBe('a-b-c-.txt');
    expect(safeFileName('name. . ')).toBe('name');
    expect(safeFileName('', 'fallback.bin')).toBe('fallback.bin');
    expect(safeFileName('...', 'fb')).toBe('fb');
  });
  it('超长时截断但保留扩展名', () => {
    const name = safeFileName(`${'a'.repeat(200)}.tar.gz`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith('.gz')).toBe(true);
  });
  it('文本记录：有原文件保留原名，否则按哈希前 8 位生成 .txt', () => {
    expect(downloadNameForText({ type: 'Text', hash: 'ABCDEF1234567890', dataName: 'notes.md' })).toBe('notes.md');
    expect(downloadNameForText({ type: 'Text', hash: 'ABCDEF1234567890', dataName: null })).toBe('Text-ABCDEF12.txt');
  });
});

describe('isTextLikeName', () => {
  it('按扩展名判断能否直接读文本', () => {
    expect(isTextLikeName('a.md')).toBe(true);
    expect(isTextLikeName('A.JSON')).toBe(true);
    expect(isTextLikeName('a.exe')).toBe(false);
    expect(isTextLikeName('noext')).toBe(false);
    expect(isTextLikeName(null)).toBe(false);
  });
});

describe('describeMinutes（保留时长的人话）', () => {
  it('整天 / 整小时 / 整分钟取最大的整除单位', () => {
    expect(describeMinutes(0)).toBe('不限制');
    expect(describeMinutes(-5)).toBe('不限制');
    expect(describeMinutes(30)).toBe('30 分钟');
    expect(describeMinutes(60)).toBe('1 小时');
    expect(describeMinutes(180)).toBe('3 小时');
    expect(describeMinutes(1440)).toBe('1 天');
    expect(describeMinutes(43200)).toBe('30 天');
  });
  it('不能整除时拆成"天 小时 分钟"', () => {
    expect(describeMinutes(1500)).toBe('1 天 1 小时');
    expect(describeMinutes(90)).toBe('1 小时 30 分钟');
    expect(describeMinutes(1441)).toBe('1 天 1 分钟');
  });
});

describe('minutesUntilNextCleanup（每小时 7/27/47 分触发，UTC 分钟位）', () => {
  const at = (minute: number, second = 0) => Date.UTC(2026, 10, 1, 12, minute, second);
  it('触发点之间取下一个', () => {
    expect(CLEANUP_MINUTES).toEqual([7, 27, 47]);
    expect(minutesUntilNextCleanup(at(0))).toBe(7);
    expect(minutesUntilNextCleanup(at(8))).toBe(19);
    expect(minutesUntilNextCleanup(at(27, 30))).toBe(20);
    expect(minutesUntilNextCleanup(at(46, 30))).toBe(1);
  });
  it('过了最后一个触发点，回绕到下一个小时的第 7 分', () => {
    expect(minutesUntilNextCleanup(at(48))).toBe(19);
    expect(minutesUntilNextCleanup(at(59))).toBe(8);
  });
  it('结果恒在 1..20 之间', () => {
    for (let m = 0; m < 60; m += 1) {
      const v = minutesUntilNextCleanup(at(m, 15));
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
  });
});
