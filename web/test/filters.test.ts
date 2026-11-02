// 筛选状态 ⇄ URL ⇄ 服务端参数。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS, PAGE_SIZES, deepLinkFor, fromDateInput, isFiltered, isTimeSort, membershipChanged,
  parseDeepLink, parseFilters, rangeBounds, searchProblem, serializeFilters, startOfDay, toApiParams, toDateInput,
} from '../src/lib/filters';

describe('parseFilters / serializeFilters', () => {
  it('空查询串 = 默认值；默认值序列化成空串', () => {
    expect(parseFilters('')).toEqual(DEFAULT_FILTERS);
    expect(serializeFilters(DEFAULT_FILTERS)).toBe('');
  });

  it('往返一致：只写与默认值不同的项', () => {
    const filters = { ...DEFAULT_FILTERS, types: 'Image' as const, search: '你好 world', starred: true, sort: 'size' as const, order: 'asc' as const, page: 3, pageSize: 120 };
    const text = serializeFilters(filters);
    expect(text).toBe('?type=Image&q=%E4%BD%A0%E5%A5%BD+world&starred=1&sort=size&order=asc&size=120&page=3');
    expect(parseFilters(text)).toEqual(filters);
  });

  it('非法值一律回落默认，不抛', () => {
    const f = parseFilters('?type=Bogus&sort=;DROP&order=sideways&range=yesterday&page=-5&size=abc');
    expect(f).toMatchObject({ types: 'All', sort: 'createTime', order: 'desc', range: 'all', page: 1, pageSize: DEFAULT_FILTERS.pageSize });
  });

  it('页大小吸附到最近的档位（手写 ?size=37 也能落在下拉里的选项上）', () => {
    expect(PAGE_SIZES).toContain(parseFilters('?size=37').pageSize);
    expect(parseFilters('?size=37').pageSize).toBe(30);
    expect(parseFilters('?size=9999').pageSize).toBe(500);
  });

  it('自定义范围保留毫秒边界；两端都缺则退回"全部时间"', () => {
    expect(parseFilters('?range=custom&from=1000&to=2000')).toMatchObject({ range: 'custom', after: 1000, before: 2000 });
    expect(parseFilters('?range=custom').range).toBe('all');
  });
});

describe('rangeBounds / toApiParams', () => {
  const now = new Date(2026, 10, 15, 13, 0, 0).getTime();
  it('预设范围按"现在"重算（日历日，不是 ±24h）', () => {
    expect(rangeBounds({ ...DEFAULT_FILTERS, range: 'today' }, now)).toEqual({ after: startOfDay(now), before: null });
    const week = rangeBounds({ ...DEFAULT_FILTERS, range: '7d' }, now);
    expect(new Date(week.after!).getDate()).toBe(9);
    expect(new Date(week.after!).getHours()).toBe(0);
    expect(rangeBounds(DEFAULT_FILTERS, now)).toEqual({ after: null, before: null });
  });

  it('服务端参数：All 与关着的开关不出现在参数里', () => {
    const p = toApiParams({ ...DEFAULT_FILTERS, types: 'Text', deleted: true, search: 'x' }, now);
    expect(p).toMatchObject({ types: 'Text', deleted: 'true', search: 'x', sort: 'createTime', order: 'desc', starred: '', after: '', before: '' });
    expect(toApiParams(DEFAULT_FILTERS, now).types).toBe('');
  });
});

describe('isFiltered / membershipChanged / isTimeSort', () => {
  it('排序、翻页、页大小不算筛选，也不改变结果集成员资格', () => {
    const sorted = { ...DEFAULT_FILTERS, sort: 'size' as const, order: 'asc' as const, page: 4, pageSize: 120 };
    expect(isFiltered(sorted)).toBe(false);
    expect(membershipChanged(DEFAULT_FILTERS, sorted)).toBe(false);
  });
  it('类型 / 收藏 / 回收站 / 搜索 / 范围会改变成员资格（必须清选择集）', () => {
    for (const patch of [{ types: 'Text' as const }, { starred: true }, { deleted: true }, { search: 'a' }, { range: 'today' as const }, { range: 'custom' as const, after: 1 }]) {
      expect(membershipChanged(DEFAULT_FILTERS, { ...DEFAULT_FILTERS, ...patch }), JSON.stringify(patch)).toBe(true);
    }
  });
  it('只有按时间排序才分日分组', () => {
    expect(['createTime', 'lastModified', 'lastAccessed'].every((s) => isTimeSort(s as never))).toBe(true);
    expect(isTimeSort('size')).toBe(false);
    expect(isTimeSort('type')).toBe(false);
  });
});

describe('日期输入', () => {
  it('本地日界：结束日取次日 00:00（开区间上界），回显时减回去', () => {
    const start = fromDateInput('2026-09-13', 'start')!;
    const end = fromDateInput('2026-09-13', 'end')!;
    expect(end - start).toBe(86_400_000);
    expect(toDateInput(start)).toBe('2026-09-13');
    expect(toDateInput(end - 1)).toBe('2026-09-13');
    expect(fromDateInput('', 'start')).toBeNull();
    expect(fromDateInput('2026/09/13', 'start')).toBeNull();
    expect(toDateInput(null)).toBe('');
  });
});

describe('深链接 #Type-hash', () => {
  it('编码往返；含 # ? % 的 hash 不会截断', () => {
    const item = { type: 'Text' as const, hash: 'AB#C?%D' };
    expect(parseDeepLink(deepLinkFor(item))).toEqual(item);
  });
  it('拒绝路径分隔符与非法类型', () => {
    expect(parseDeepLink('#Text-a%2Fb')).toBeNull();
    expect(parseDeepLink('#Text-a%5Cb')).toBeNull();
    expect(parseDeepLink('#Bogus-abc')).toBeNull();
    expect(parseDeepLink('#Text-')).toBeNull();
    expect(parseDeepLink('#Text-%E0%A4%A')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });
});

describe('searchProblem（服务端搜索词上限 48 字节）', () => {
  it('合法：英文 48 个字母、汉字 16 个（每个 3 字节）', () => {
    expect(searchProblem('a'.repeat(48))).toBeNull();
    expect(searchProblem('你'.repeat(16))).toBeNull();
    expect(searchProblem('')).toBeNull();
  });
  it('超长：49 个字母、17 个汉字', () => {
    expect(searchProblem('a'.repeat(49))).toMatch(/太长/);
    expect(searchProblem('你'.repeat(17))).toMatch(/太长/);
  });
  it('% _ \\ 在 LIKE 里要加反斜杠，各算 2 个：25 个 % 就越线', () => {
    expect(searchProblem('%'.repeat(24))).toBeNull();
    expect(searchProblem('%'.repeat(25))).toMatch(/太长/);
    expect(searchProblem('_'.repeat(25))).toMatch(/太长/);
  });
});

describe('收藏夹筛选（?folder=）', () => {
  it('解析：正整数才算；非法 / 0 / 负数 / 小数一律当没有，不抛', () => {
    expect(parseFilters('?folder=3').folder).toBe(3);
    for (const bad of ['', '?folder=', '?folder=0', '?folder=-1', '?folder=abc', '?folder=1.5', '?folder=99999999999999999999']) {
      expect(parseFilters(bad).folder, bad).toBeNull();
    }
  });

  it('序列化：只在有收藏夹时写，且往返一致', () => {
    expect(serializeFilters({ ...DEFAULT_FILTERS })).toBe('');
    const f = { ...DEFAULT_FILTERS, folder: 7 };
    expect(serializeFilters(f)).toBe('?folder=7');
    expect(parseFilters(serializeFilters(f))).toEqual(f);
  });

  it('请求参数：folder 只在有值时带上', () => {
    expect(toApiParams({ ...DEFAULT_FILTERS, folder: 4 }).folder).toBe(4);
    expect(toApiParams({ ...DEFAULT_FILTERS }).folder).toBe('');
  });

  it('换收藏夹 / 进出收藏夹都改变结果集成员资格（必须清选择集）；翻页不算', () => {
    const base = { ...DEFAULT_FILTERS };
    expect(membershipChanged(base, { ...base, folder: 1 })).toBe(true);
    expect(membershipChanged({ ...base, folder: 1 }, { ...base, folder: 2 })).toBe(true);
    expect(membershipChanged({ ...base, folder: 1 }, { ...base, folder: 1, page: 2 })).toBe(false);
  });

  it('收藏夹算筛选（isFiltered）', () => {
    expect(isFiltered({ ...DEFAULT_FILTERS })).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, folder: 1 })).toBe(true);
  });
});

