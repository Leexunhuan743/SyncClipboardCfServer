// 前端纯逻辑：筛选语义（`filters.js`）、展示格式化（`format.js`，含用户可见的「字符」口径）、API 边界的归一化（`api.js`）。
//
// 为什么值得一个套件：`public/ui_v2/**` 是零构建的，不在 `tsc` 的 include 里；此前的守卫只有
// `ui-contract`（类名/属性/import 闭包/能否被原生解析）与 `next-target`、`clipboard` 两个纯函数用例。
// 而「界面显示错了」最常出在这三处：时间范围算错一天（本地日界 vs UTC）、
// 归一化漏字段（type 数字 → 枚举名）、查询串里丢了非默认值。
// 这些都不需要 DOM 与网络，属于纯逻辑，可以直接钉住。
//
// 提示：`@ts-expect-error` 必须紧贴**报错行**——多行 import 的 TS7016 报在 `} from '…'` 那一行，
// 所以下面这些导入一律写成单行；三条各配一条指令（少一条就报 7016，多一条就报 unused directive）。
// @ts-expect-error TS7016：`public/ui_v2/**` 是零构建的原生 ES 模块（同 next-target.test.ts）
import { normalizeItem, buildQuery } from '../public/ui_v2/js/api.js';
// @ts-expect-error TS7016：`public/ui_v2/**` 是零构建的原生 ES 模块（同 next-target.test.ts）
import { DEFAULT_FILTERS, rangeBounds, toDateInput, fromDateInput, filtersFromUrl, filtersToApi, filtersToSearch, isDefaultFilters, startOfDay } from '../public/ui_v2/js/filters.js';
// @ts-expect-error TS7016：同上
import { typeName, typeLabel, formatSize, formatRelative, previewText, truncateText, charCount } from '../public/ui_v2/js/format.js';
// @ts-expect-error TS7016：同上
import { parseFrames, classifyMessage, createPushChannel } from '../public/ui_v2/js/push.js';
// @ts-expect-error TS7016：同上
import { deleteConfirmSpec, batchDeleteConfirmSpec, clearHistorySpec, describeListError, clipboardFailureHint } from '../public/ui_v2/js/messages.js';
// @ts-expect-error TS7016：同上
import { rowMenuItems, sortMenuItems } from '../public/ui_v2/js/menus.js';
// 这一条破例取 **V1** 的模块：保留策略的显示口径（未设置 / 已关闭 / 有值 / 分档）只在特定取值下
// 才现形 —— 60 分钟显示成「0 天」、null 显示成「不限」都不会在默认实例上出现，靠人眼看永远看不全。
// @ts-expect-error TS7016：`public/ui_v1/**` 同样是零构建的原生 ES 模块（同上的理由）
import { retentionText, retentionEffectiveText } from '../public/ui_v1/js/components/info.js';
// 下载的**落盘文件名**（V1 `format.js` 的纯函数）：有原文件就保留原扩展名，没有才生成
// `<type>-<hash8>.txt`；而名字来自客户端的 `dataName`（不可信）—— 这条判据只能在单测里逐值钉住。
// @ts-expect-error TS7016：同上
import { downloadNameForText, safeFileName, truncateText as truncateTextV1, charCount as charCountV1 } from '../public/ui_v1/js/format.js';
import { describe, expect, it, vi } from 'vitest';

const DAY = 86_400_000;

describe('filters · 时间范围的边界', () => {
  it('预设按**本地**日界算：今天 = 本地 00:00，不是 UTC 的 00:00', () => {
    // 取一个本地时间的中午，避免正好落在日界上导致断言随运行时刻抖动
    const now = new Date(2026, 8, 13, 12, 0, 0).getTime();
    expect(rangeBounds({ range: 'today' }, now)).toEqual({ after: new Date(2026, 8, 13).getTime(), before: null });
    expect(rangeBounds({ range: '7d' }, now)).toEqual({ after: new Date(2026, 8, 7).getTime(), before: null });
    expect(rangeBounds({ range: '30d' }, now)).toEqual({ after: new Date(2026, 7, 15).getTime(), before: null });
    expect(rangeBounds({ range: 'all' }, now)).toEqual({ after: null, before: null });
  });

  it('自定义范围原样透传；未设的一侧是 null', () => {
    expect(rangeBounds({ range: 'custom', after: 100, before: 200 })).toEqual({ after: 100, before: 200 });
    expect(rangeBounds({ range: 'custom', after: 100, before: null })).toEqual({ after: 100, before: null });
  });

  it('end 侧是**开区间上界**：选到某天，次日 00:00 才是上界（否则会漏掉当天）', () => {
    const start = fromDateInput('2026-09-13', 'start');
    const end = fromDateInput('2026-09-13', 'end');
    expect(start).toBe(new Date(2026, 8, 13).getTime());
    expect(end! - start!).toBe(DAY);
    // 服务端 `CreateTime < before` ⇒ 用 end 作 before 时，9-13 23:59 的记录仍会被包含进来
    expect(new Date(end! - 1).getDate()).toBe(13);
  });

  it('日期串 ↔ 毫秒往返不丢天；畸形输入返回 null 而不是 Invalid Date', () => {
    const ms = new Date(2026, 0, 5).getTime();
    expect(toDateInput(ms)).toBe('2026-01-05');
    expect(fromDateInput(toDateInput(ms), 'start')).toBe(ms);
    expect(fromDateInput('', 'start')).toBeNull();
    expect(fromDateInput('2026-13-99', 'start')).toBeNull();
    expect(toDateInput(null)).toBe('');
  });
});

describe('filters · URL 往返', () => {
  it('筛选进 URL 再解析回来是同一个状态（可分享、可后退、刷新不丢）', () => {
    const state = {
      ...DEFAULT_FILTERS,
      page: 3,
      pageSize: 100,
      types: 'Image',
      starred: true,
      search: 'zzz',
      range: 'custom',
      after: new Date(2026, 8, 10).getTime(),
      before: new Date(2026, 8, 13).getTime(),
      deleted: true,
      sort: 'size',
      order: 'asc',
    };
    expect(filtersFromUrl(filtersToSearch(state))).toEqual(state);
  });

  it('预设范围的边界**不**写进 URL（边界每次请求重算，写死会让链接语义漂移）', () => {
    const query = filtersToSearch({ ...DEFAULT_FILTERS, range: '7d' });
    expect(query).toBe('?range=7d');
  });

  it('旧链接（只有 after/before、没有 range）被还原成自定义范围', () => {
    const parsed = filtersFromUrl('?after=100&before=200');
    expect(parsed.range).toBe('custom');
    expect(parsed.after).toBe(100);
    expect(parsed.before).toBe(200);
  });

  it('非法值不抛错：range/sort 回落默认，pageSize 夹到上限', () => {
    const parsed = filtersFromUrl('?range=last-week&sort=constructor&pageSize=99999&page=-3&deleted=yes');
    expect(parsed.range).toBe(DEFAULT_FILTERS.range);
    expect(parsed.sort).toBe(DEFAULT_FILTERS.sort);
    expect(parsed.pageSize).toBe(500);
    expect(parsed.page).toBe(1);
    expect(parsed.deleted).toBe(false); // 只有 '1' 算真
  });

  it('isDefaultFilters 认得出新增的两个维度（时间范围、回收站）', () => {
    expect(isDefaultFilters({ ...DEFAULT_FILTERS })).toBe(true);
    expect(isDefaultFilters({ ...DEFAULT_FILTERS, range: 'today' })).toBe(false);
    expect(isDefaultFilters({ ...DEFAULT_FILTERS, deleted: true })).toBe(false);
  });
});

describe('filters · 请求参数', () => {
  const now = new Date(2026, 8, 13, 12, 0, 0).getTime();

  it('默认状态只发分页与排序（不制造无意义的过滤条件）', () => {
    const query = filtersToApi({ ...DEFAULT_FILTERS }, now);
    expect(query).toEqual({ page: 1, pageSize: 50, sort: 'createTime', order: 'desc' });
  });

  it('回收站与时间范围映射到 deleted / after（服务端用 CreateTime 过滤）', () => {
    const query = filtersToApi({ ...DEFAULT_FILTERS, deleted: true, range: '7d' }, now);
    expect(query.deleted).toBe('true');
    expect(query.after).toBe(String(new Date(2026, 8, 7).getTime()));
    expect(query.before).toBeUndefined();
  });

  it('自定义范围两侧都带上；只有一侧时另一侧不出现', () => {
    const both = filtersToApi({ ...DEFAULT_FILTERS, range: 'custom', after: 111, before: 222 }, now);
    expect([both.after, both.before]).toEqual(['111', '222']);
    const one = filtersToApi({ ...DEFAULT_FILTERS, range: 'custom', after: null, before: 222 }, now);
    expect(one.after).toBeUndefined();
    expect(one.before).toBe('222');
  });
});

describe('filters · startOfDay', () => {
  it('落在本地零点且不改变日期', () => {
    const ms = startOfDay(new Date(2026, 8, 13, 23, 59, 59).getTime());
    const date = new Date(ms);
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([2026, 8, 13, 0]);
  });
});

describe('format · 展示层', () => {
  it('type 数字 → 枚举名（服务端按数字序列化枚举，空值按 Text 处理）', () => {
    expect(typeName(0)).toBe('Text');
    expect(typeName(3)).toBe('Group');
    expect(typeName('Image')).toBe('Image');
    expect(typeName(undefined)).toBe('Text');
    expect(typeLabel('Group')).toBe('组合');
  });

  it('体积格式化：0/负数/非数不显示成 0 B，跨单位进位正确', () => {
    expect(formatSize(0)).toBe('—');
    expect(formatSize(-5)).toBe('—');
    expect(formatSize(Number.NaN)).toBe('—');
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 * 1024 * 3)).toBe('3.0 MB');
  });

  it('相对时间分档：未来时间显式说"以后"，超过一周退回日期', () => {
    const now = new Date(2026, 8, 13, 12, 0, 0).getTime();
    const iso = (ms: number): string => new Date(ms).toISOString();
    expect(formatRelative(iso(now - 10_000), now)).toBe('刚刚');
    expect(formatRelative(iso(now - 5 * 60_000), now)).toBe('5 分钟前');
    expect(formatRelative(iso(now - 3 * 3_600_000), now)).toBe('3 小时前');
    expect(formatRelative(iso(now - 30 * DAY), now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 未来时间戳**必须显式说"以后"**（2026-09-18 修）：这条原来断言未来值退回 `hh:mm`，
    // 于是一条 2035 年的记录在列表里显示成 "09:03" —— 读起来像"今天早上刚发生的"，
    // 把"这台设备的时钟可能不对"这条线索（协议侧 >5 分钟就中止历史同步）整个藏掉。
    // 断言随行为一起改，别让旧断言继续固化已被判定为缺陷的行为（AGENTS.md §1）。
    expect(formatRelative(iso(now + 60_000), now)).toBe('1 分钟后');
    expect(formatRelative(iso(now + 3 * 3_600_000), now)).toBe('3 小时后');
    expect(formatRelative(iso(now + 3 * DAY), now)).toBe('3 天后');
    expect(formatRelative(iso(now + 30 * DAY), now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('列表摘要：空文本有占位，非 Text 用数据文件名', () => {
    expect(previewText({ type: 'Text', text: '   ' })).toBe('（空文本）');
    expect(previewText({ type: 'Text', text: ' hello ' })).toBe('hello');
    expect(previewText({ type: 'File', dataName: 'a.zip' })).toBe('a.zip');
    expect(previewText({ type: 'Group' })).toBe('（无文件名）');
  });
});

describe('signalr · 原生推送通道的分帧与分类', () => {
  // 这两条是「协议形状」的纯逻辑：错误的分帧会静默丢广播（帧尾 RS 没剥、多条消息只读第一条），
  // 而错误分类会让心跳被当成广播，把整页刷新变成每 15 秒一次。
  it('按 RS 拆分一帧里的多条消息；尾部与连续分隔符不算消息', () => {
    expect(parseFrames('{}\x1e{"type":6}\x1e')).toEqual(['{}', '{"type":6}']);
    expect(parseFrames('{}\x1e\x1e')).toEqual(['{}']);
    expect(parseFrames('')).toEqual([]);
  });

  it('分类：1=广播、6=心跳、7=关闭、无 type 的 {} = 握手响应、解析不了 = unknown', () => {
    expect(classifyMessage('{"type":1,"target":"RemoteHistoryChanged","arguments":[]}')).toBe(1);
    expect(classifyMessage('{"type":6}')).toBe(6);
    expect(classifyMessage('{"type":7}')).toBe(7);
    expect(classifyMessage('{}')).toBe('handshake');
    expect(classifyMessage('not json')).toBe('unknown');
  });
});

describe('signalr · 推送通道的生命周期', () => {
  // 用一个最小假 WebSocket 驱动真实模块：这条竞态（迟到的 close 抹掉新连接的心跳）无法靠读代码
  // 保证——它只在事件顺序上成立，子代理用同一手法确定性复现过。变异守卫：把 teardown 的
  // `if (socket !== nextSocket) return;` 去掉，本用例立刻红。
  class FakeSocket {
    static instances: FakeSocket[] = [];
    // 模块用 `WebSocket.OPEN` 判可发送——假实现少这个常量，心跳就会静默不发（写这条用例时踩到）
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    private listeners = new Map<string, ((event: unknown) => void)[]>();
    constructor(public url: string) {
      FakeSocket.instances.push(this);
    }
    addEventListener(type: string, fn: (event: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    send(message: string): void {
      this.sent.push(message);
    }
    close(): void {
      this.readyState = 3;
    }
    fire(type: string, event: unknown = {}): void {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    /** 服务端握手响应到达（`{}` + RS）→ 通道进入 live 并开始心跳 */
    handshake(): void {
      this.readyState = 1;
      this.fire('open');
      this.fire('message', { data: '\u001e{}' });
    }
  }

  it('旧连接迟到的 close 不得清掉新连接的心跳与状态', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'example.test' });
    FakeSocket.instances.length = 0;
    try {
      const channel = createPushChannel({
        acquireTicket: async () => '/SyncClipboardHub?id=test',
        onSignal: () => {},
      });
      channel.start();
      await vi.advanceTimersByTimeAsync(0);
      const first = FakeSocket.instances[0]!;
      first.handshake();
      expect(channel.state).toBe('live');

      // 隐藏 → 可见：旧连接被关掉，新连接建起来并握手
      channel.stop();
      channel.start();
      await vi.advanceTimersByTimeAsync(0);
      const second = FakeSocket.instances[1]!;
      expect(second, '第二次 start 必须建一条新连接').toBeTruthy();
      second.handshake();
      expect(channel.state).toBe('live');

      // 旧连接的 close **迟到**：不能影响新连接
      first.fire('close', { code: 1000, reason: '' });
      expect(channel.state, '迟到的 close 不得把状态置回 offline').toBe('live');
      const before = second.sent.length;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(
        second.sent.slice(before).some((message) => message.includes('"type":6')),
        '新连接的心跳必须还在（迟到 close 不该 clearInterval 掉它）',
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('当前连接出错（error → close）必须收尾并重连，不能停在假 live', async () => {
    // 断网、DO 重启、笔记本休眠恢复都是这条序列：浏览器先派 error，紧接着必派 close。
    // 上一版的 teardown 守卫把「socket 已被 error 清空」当成「迟到 close」直接返回 ——
    // 于是状态永远停在 live（面板显示「已连接」）、轮询停在 60 秒看门狗档、也不再重连。
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'example.test' });
    FakeSocket.instances.length = 0;
    try {
      const channel = createPushChannel({ acquireTicket: async () => '/SyncClipboardHub?id=test' });
      channel.start();
      await vi.advanceTimersByTimeAsync(0);
      FakeSocket.instances[0]!.handshake();
      expect(channel.state).toBe('live');

      const first = FakeSocket.instances[0]!;
      first.fire('error', {});
      first.fire('close', { code: 1006, reason: 'abnormal' });
      expect(channel.state, '当前连接断开后必须离开 live').toBe('offline');

      // 退避 2 秒后重连（RETRY_MIN_MS）
      await vi.advanceTimersByTimeAsync(2_100);
      expect(FakeSocket.instances.length, '断开后必须自动重连一次').toBe(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('api · 边界归一化', () => {
  it('列表项：type 归一成枚举名、key 由 type+hash 派生、textTruncated 收紧成布尔', () => {
    const item = normalizeItem({ type: 2, hash: 'ABC', text: 'x', textTruncated: 'yes' });
    expect(item).toMatchObject({ type: 'Image', key: 'Image-ABC', textTruncated: false });
  });

  it('畸形输入返回 null（调用方据此过滤，而不是渲染出半条记录）', () => {
    expect(normalizeItem(null)).toBeNull();
    expect(normalizeItem('text')).toBeNull();
  });

  it('查询串只带**有值**的参数：空串 / false / null / undefined 都不出现', () => {
    expect(buildQuery({ page: 1, search: '', starred: false, after: null, x: undefined, deleted: true })).toBe(
      'page=1&deleted=true',
    );
  });
});

// 2026-09-16 审计（A-38）把"面向用户的文案"与"菜单项构造"从 `boot.js` 里提了出来：
// 它们不是装饰 —— 句子逐字对齐了服务端语义（能不能恢复、数据文件会不会没），
// 项的禁用与语气决定了用户能不能做出正确选择。提到纯模块之后就可以直接断言了。
describe('messages · 用户文案对齐服务端语义', () => {
  it('删除**带数据文件**的记录：必须说"立即清除、不可恢复"，不能说"30 天后才清"', () => {
    const spec = deleteConfirmSpec({
      type: 'Image',
      dataName: 'photo.png',
      hasData: true,
    });
    expect(spec.message).toContain('立即清除数据文件（不可恢复）');
    expect(spec.message).not.toContain('还能从回收站恢复');
    expect(spec.message).toContain('photo.png');
    expect(spec.confirmLabel).toBe('删除');
  });

  it('删除**内联文本**：必须说"30 天内还能恢复"（否则用户会白白放弃一次可用的恢复）', () => {
    const spec = deleteConfirmSpec({ type: 'Text', text: 'a'.repeat(80), hasData: false });
    expect(spec.message).toContain('30 天内还能从回收站恢复');
    expect(spec.message).not.toContain('不可恢复');
    // 长正文只取开头，避免把一行对话框撑成正文
    expect(spec.message).toContain(`「${'a'.repeat(40)}…」`);
  });

  it('批量删除：两种后果都要说，且标题带上条数', () => {
    const spec = batchDeleteConfirmSpec(7);
    expect(spec.title).toBe('删除选中的 7 条记录？');
    expect(spec.message).toContain('不可恢复');
    expect(spec.message).toContain('内联文本 30 天内可从回收站恢复');
    expect(spec.confirmLabel).toBe('删除 7 条');
  });

  it('清空历史的两种作用域：回收站不含"当前剪贴板"，全部历史要说明它不受影响', () => {
    const trash = clearHistorySpec('trash');
    expect(trash.label).toBe('清空回收站');
    expect(trash.message).toContain('不可撤销');
    const all = clearHistorySpec('all');
    expect(all.label).toBe('清空全部历史');
    expect(all.message).toContain('当前剪贴板内容不受影响');
  });

  it('列表错误翻译：400 且搜索词非空 → 说"搜索词过长"，而不是把服务端原文抛给用户', () => {
    expect(describeListError({ status: 400, message: 'SearchText must be at most 48 bytes' }, 'abcd')).toBe(
      '搜索词过长：服务端上限 48 字节（约 16 个汉字），缩短后再试',
    );
    // 同样的 400，但搜索词为空 → 那是别的筛选条件问题，文案不能提"搜索词"
    expect(describeListError({ status: 400, message: 'after must be less than before' }, '')).toContain(
      '筛选条件不被服务端接受',
    );
    expect(describeListError({ status: 500, message: 'boom' }, '')).toBe('无法读取历史记录：boom');
    expect(describeListError(null, '')).toContain('未知错误');
  });

  // 429 的两条精细文案（"请在 N 秒后重试"）需要 `error.retryAfterSeconds` 才可达。
  // 这条断言存在的意义：`api.js` 曾经**从不填**这个字段（`ApiError` 构造只带三个参数），
  // 于是这两条文案是不可达的死分支，用户对着"请求过于频繁"猜还要等多久。
  // 只测 `messages.js` 这一侧的话，两边可以各自"正确"却永远接不上 —— 所以还要有
  // `test/ui-input.test.ts` 那条"从响应头带出 retryAfterSeconds"的断言。
  it('列表错误翻译：429 带 retryAfterSeconds 时给出等待时长，缺失时退回通用文案', () => {
    expect(describeListError({ status: 429, message: 'Too Many Requests', retryAfterSeconds: 30 }, '')).toBe(
      '请求过于频繁：请在 30 秒后重试。',
    );
    expect(describeListError({ status: 429, message: 'Too Many Requests', retryAfterSeconds: 600 }, '')).toBe(
      '请求过于频繁：请在约 10 分钟后重试。',
    );
    // 缺字段 / 非法值：退回通用文案，而不是显示 "NaN 秒"
    expect(describeListError({ status: 429, message: 'Too Many Requests' }, '')).toBe('请求过于频繁，请稍后再试。');
    expect(describeListError({ status: 429, retryAfterSeconds: 0 }, '')).toBe('请求过于频繁，请稍后再试。');
  });

  it('剪贴板失败：http 站点要点名"不是 https"，安全上下文才说"权限"', () => {
    expect(clipboardFailureHint(false, '请手动复制。')).toContain('不是 https');
    expect(clipboardFailureHint(true, '请手动复制。')).toContain('剪贴板权限');
    // 退路文案必须原样带上：只说原因不给出路，用户只会反复点
    expect(clipboardFailureHint(false, '服务器地址在抽屉里。')).toContain('服务器地址在抽屉里。');
  });
});

describe('menus · 菜单项构造（判据是产品决定，不是实现细节）', () => {
  // 被导入的是**无类型**的零构建模块，TS 无法推断回调参数，故这里显式给出形状
  // （`tsc --noEmit` 会因 `noImplicitAny` 报 TS7006，而 `npm run check` 包含 typecheck）。
  type MenuItem = {
    label?: string;
    icon?: string | null;
    tone?: string;
    disabled?: boolean;
    separator?: boolean;
    run?: () => void;
  };
  type SortPatch = { sort: string; order: string; page: number };

  const noop = () => {};
  const handlers = {
    onPreview: noop,
    onCopy: noop,
    onDownload: noop,
    onRestore: noop,
    onTogglePin: noop,
    onDelete: noop,
  };
  const labelOf = (items: MenuItem[]): string[] =>
    items.filter((i: MenuItem) => !i.separator).map((i: MenuItem) => i.label!);

  it('活跃的文本记录：预览 + 复制内容 + 置顶 + 分隔线 + 删除', () => {
    const items = rowMenuItems({ type: 'Text', text: 'hi', starred: false, pinned: false }, handlers) as MenuItem[];
    expect(labelOf(items)).toEqual(['预览', '复制内容', '置顶', '删除']);
    expect(items.some((i: MenuItem) => i.separator)).toBe(true);
    // 删除永远在最后、且带 danger 语气（与"取消/确认"的视觉分级对应）
    expect(items.at(-1)).toMatchObject({ label: '删除', tone: 'danger', icon: 'trash' });
  });

  it('非文本记录给"下载"而不是"复制内容"', () => {
    const items = rowMenuItems({ type: 'Image', dataName: 'a.png', hasData: true }, handlers) as MenuItem[];
    expect(labelOf(items)).toEqual(['预览', '下载', '置顶', '删除']);
  });

  it('已置顶 → "取消置顶"（文案随状态描述**下一个**动作）', () => {
    const items = rowMenuItems({ type: 'Text', text: 'x', pinned: true }, handlers) as MenuItem[];
    expect(labelOf(items)).toContain('取消置顶');
  });

  it('回收站：主操作是"恢复"，且带数据文件的记录**禁用并说明原因**', () => {
    const restorable = rowMenuItems(
      { type: 'Text', text: 'x', isDeleted: true, hasData: false },
      handlers,
    ) as MenuItem[];
    expect(labelOf(restorable)).toEqual(['预览', '复制内容', '恢复到历史记录', '彻底删除']);
    expect(restorable.find((i: MenuItem) => i.label === '恢复到历史记录')).toMatchObject({ disabled: false });

    const lost = rowMenuItems(
      { type: 'Image', dataName: 'a.png', isDeleted: true, hasData: true },
      handlers,
    ) as MenuItem[];
    expect(lost.find((i: MenuItem) => i.icon === 'undo')).toMatchObject({
      label: '不可恢复（数据已清除）',
      disabled: true,
    });
    expect(labelOf(lost)).not.toContain('置顶'); // 回收站里不提供置顶
  });

  it('排序菜单：当前字段打勾；点同一字段翻转方向，换字段保留方向', () => {
    const fields = [
      { value: 'createTime', label: '创建时间' },
      { value: 'lastAccessed', label: '访问时间' },
    ];
    const picked: SortPatch[] = [];
    const items = sortMenuItems({ sort: 'createTime', order: 'desc' }, fields, (patch: SortPatch) =>
      picked.push(patch),
    ) as MenuItem[];
    expect(items.map((i: MenuItem) => i.icon)).toEqual(['check', null]);

    items[0]!.run!(); // 点当前字段 → 翻转
    items[1]!.run!(); // 换字段 → 保留方向
    expect(picked).toEqual([
      { sort: 'createTime', order: 'asc', page: 1 },
      { sort: 'lastAccessed', order: 'desc', page: 1 },
    ]);
  });
});

describe('部署信息 · 保留策略的人话口径（V1 `info.js`）', () => {
  const summary = (minutes: number | null, maxCount: number | null = 1000) =>
    retentionText({ retentionMinutes: minutes, maxSavedHistoryCount: maxCount });

  it('分钟数分档：小时级不能再写成「0 天」', () => {
    // 只看**时间那一格**：整句里还有「条数上限 1000 条」「30 天后彻底清除」，
    // 拿整句做 "不包含 0 天" 的断言会被 "30 天" 里的 "0 天" 骗到（第一版就是这么写错的）。
    const timePart = (minutes: number | null) => String(summary(minutes)).split(' · ')[0];
    const cases: [number, string][] = [
      [1, '1 分钟'],
      [30, '30 分钟'],
      [60, '1 小时'],
      [90, '1.5 小时'],
      [1000, '16.7 小时'],
      [1440, '1 天'],
      [1441, '1 天'],
      [10_080, '7 天'],
    ];
    // 这些值以前**全都**落到 `Math.round(m / 1440) 天`：前五行会变成「0 天」、1441 变成「1 天」
    for (const [minutes, expected] of cases) {
      expect(timePart(minutes), `${minutes} 分钟的时间格`).toBe(expected);
    }
  });

  it('0 = 明确关闭该阶段，不能被说成「未设置」', () => {
    const off = retentionText({ retentionMinutes: 0, maxSavedHistoryCount: 0 });
    expect(off).toContain('保留期清理已关闭');
    expect(off).toContain('条数裁剪已关闭');
    expect(off).not.toContain('未设置');
  });

  it('null = 没显式配置，生效值是内置默认（7 天 / 1000 条），不是「不限」也不是「按部署环境变量」', () => {
    const both = summary(null, null);
    expect(both).toContain('未设置');
    expect(both).toContain('7 天');
    expect(both).toContain('1000 条');

    // 只有一项是 null 时，另一项照常显示，且这一项说清回落值
    const mixed = summary(null, 5000);
    expect(mixed).toContain('内置默认 7 天');
    expect(mixed).toContain('上限 5000 条');
    expect(mixed).not.toContain('不限');

    const note = retentionEffectiveText({ retentionMinutes: null, maxSavedHistoryCount: 500 });
    expect(note).toContain('10080 分钟（内置默认）');
    expect(note).toContain('来源：内置默认');
    expect(note).not.toContain('不限');
    expect(note).not.toContain('按部署环境变量');
  });

  it('来源与生效值一致：meta = 此处的设置、env = 部署环境变量', () => {
    const note = retentionEffectiveText({
      retentionMinutes: 1440,
      maxSavedHistoryCount: 1000,
      retentionSource: 'meta',
      maxCountSource: 'env',
    });
    expect(note).toContain('保留 1440 分钟');
    expect(note).toContain('此处的设置');
    expect(note).toContain('部署环境变量');
  });
});

describe('下载的落盘名（V1 `format.js`）', () => {
  const name = (item: Record<string, unknown>) => downloadNameForText({ type: 'Text', hash: 'ABCD1234XYZ', ...item });

  it('有原文件就保留原名与扩展名；内联文本才生成 .txt', () => {
    expect(name({ dataName: null })).toBe('Text-ABCD1234.txt');
    expect(name({ dataName: '' })).toBe('Text-ABCD1234.txt');
    expect(name({ dataName: '   ' })).toBe('Text-ABCD1234.txt');
    expect(name({ dataName: 'f4-mu5pak2v.txt' })).toBe('f4-mu5pak2v.txt');
    // 用户定的口径：那是他自己原本的文件，不替他改名
    expect(name({ dataName: 'notes.md' })).toBe('notes.md');
    expect(name({ dataName: 'archive.tar.gz' })).toBe('archive.tar.gz');
    expect(name({ dataName: 'data.json' })).toBe('data.json');
  });

  it('文件名来自客户端 → 必须洗掉路径分隔符与控制字符、去掉结尾的点与空白、限长', () => {
    // 先取 basename：路径分量根本进不来（与服务端 `db.ts` 的 basename() 同一口径）
    expect(name({ dataName: '../../etc/passwd' })).toBe('passwd');
    expect(name({ dataName: 'C:\\Users\\me\\note.txt' })).toBe('note.txt');
    expect(name({ dataName: 'a\\b:c*d?e"f<g>h|i.txt' })).toBe('b-c-d-e-f-g-h-i.txt');
    expect(name({ dataName: 'trailing. ' })).toBe('trailing');
    // 限长时**保留扩展名**：`.txt` 被砍掉的话，双击就不知道该用什么打开了
    expect(name({ dataName: `${'x'.repeat(200)}.txt` })).toBe(`${'x'.repeat(60)}.txt`);
  });

  it('safeFileName：文件/图片下载共用同一个入口（无原名时用调用方给的回退名）', () => {
    expect(safeFileName('shot.png', 'Image-abc')).toBe('shot.png');
    expect(safeFileName('', 'File-ABCD1234')).toBe('File-ABCD1234');
    expect(safeFileName('nil', 'File-ABCD1234')).toBe('nil');
    expect(safeFileName('/etc/hosts', 'File-ABCD1234')).toBe('hosts');
  });
});


// ===== 用户可见的「字符」（2026-09-19 补）=====
//
// 判据来自一个真实缺陷：两版 `format.js` 的 `slice(0, 40/80)` 与 `.length` 按 **UTF-16 码元**
// 处理「用户看到的字符」——39 个 ASCII + 一个 emoji 会被切成半个代理对（渲染成 `\uFFFD`），
// 10 个 emoji 会被报成「20 个字符」。修复引入了 `truncateText()` / `charCount()`，
// 而这两个函数**两版各有一份、不共享**（见 AGENTS.md §1），只有纪律要求「改其一同时改另一版」。
// 本节补上此前完全缺失的断言：① 切不出半个代理对；② 计数按字素簇；③ 两版结果一致。
describe('字符口径（两版 format.js 各一份，行为必须一致）', () => {
  const IMPLS = [
    { name: 'V2', truncateText, charCount },
    { name: 'V1', truncateText: truncateTextV1, charCount: charCountV1 },
  ];
  const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // 家庭 emoji（3 个码点 + 2 个零宽连接符，故用转义写法，避免不可见字符被吃掉）

  /** 扫码元：出现孤立的高/低代理位即为「切坏了」。 */
  function hasLoneSurrogate(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  for (const impl of IMPLS) {
    it(`${impl.name}：截断不切出半个代理对`, () => {
      const text = `${'a'.repeat(39)}😀`; // 恰好 40 个字素，第 40 个是 emoji
      const whole = impl.truncateText(text, 40);
      expect(whole).toBe(text);
      expect(hasLoneSurrogate(whole)).toBe(false);

      // 收到 39：字素簇口径留下 39 个 a；码点回退同理。**不许**只留下高代理位
      const clipped = impl.truncateText(text, 39);
      expect(hasLoneSurrogate(clipped)).toBe(false);
      expect(clipped).toBe('a'.repeat(39));
    });

    it(`${impl.name}：字符数按「用户看到的一个字」算，不按码元`, () => {
      expect(impl.charCount('😀'.repeat(10))).toBe(10); // 码元口径会报 20
      expect(impl.charCount('')).toBe(0);
      expect(impl.charCount(null)).toBe(0); // 函数体里的 `text ?? ''` 兜底
      // 家庭 emoji：字素簇 1 个；回退（Firefox < 125）按码点数成 5 段（8 个码元里含两个 ZWJ）。
      // 两种都不切出半个字符 —— 这正是注释承诺的口径，故这里把两个分支都钉住
      expect(impl.charCount(FAMILY)).toBe(hasSegmenter ? 1 : 5); // FAMILY 写成转义：ZWJ 不可见，字面量会被工具链吃掉
    });
  }

  it('两版实现给出一致结果（改其一必须同时改另一版）', () => {
    const samples = ['', 'a', '\u{1F600}', `${'a'.repeat(39)}\u{1F600}`, FAMILY, '中'.repeat(50) + '🎉'.repeat(5)];
    for (const sample of samples) {
      for (const max of [0, 1, 5, 40, 80]) {
        expect(
          truncateTextV1(sample, max),
          `两版 truncateText 结果不一致（max=${max}）：${JSON.stringify(sample).slice(0, 24)}`,
        ).toBe(truncateText(sample, max));
      }
      expect(
        charCountV1(sample),
        `两版 charCount 结果不一致：${JSON.stringify(sample).slice(0, 24)}`,
      ).toBe(charCount(sample));
    }
  });
});
