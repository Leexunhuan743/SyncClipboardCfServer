// 部署信息：把「客户端该填什么」「同步为什么不动」「库里有多少东西」「怎么清」放在一处。
// 排障信息（时钟差、最近清理、完整性自检）是这页存在的主要理由 —— 它们是"同步不动"最常见的几个根因。
//
// 布局：顶部一条状态总览（一眼看出"有没有问题"），下面是卡片网格 ——
// 窄屏单列、桌面两栏、带鱼屏三栏（见 styles/feed.css 的 `.settings`），长表单（保留策略）横跨多栏。
import { api, ApiError } from '../lib/api';
import { clear, h, icon } from '../lib/dom';
import { describeMinutes, formatAbsolute, formatRelative, formatSize, minutesUntilNextCleanup, typeLabel } from '../lib/format';
import type { DeploymentInfo, IntegrityReport, PushState, Retention } from '../lib/types';
import { openModal } from '../ui/dialog';
import { toast } from '../ui/toast';
import { typeBar } from './typebar';

export interface SettingsContext {
  push: PushState;
  skewMs: number | null;
  copyText(text: string, doneMessage: string): Promise<void>;
  onEmptyTrash(): Promise<void>;
  onClearAll(): Promise<void>;
  onShortcuts(): void;
}

const SOURCE: Record<Retention['maxCountSource'], string> = { meta: '在这里设置的值', env: '部署环境变量', default: '内置默认值' };
const PUSH_TEXT: Record<PushState, string> = { live: '已连接（实时推送）', connecting: '正在连接…', offline: '未连接（每 10 秒轮询）' };
const SKEW_LIMIT_MS = 5 * 60_000; // 官方客户端在时钟差 > 5 分钟时会中止历史同步
const PROJECT_URL = 'https://github.com/Leexunhuan743/SyncClipboardCfServer';

// 与服务端 PUT /ui/api/settings 的上界一致（src/ui/maintenance.ts）：超了服务端只会回一句 invalid_request
const COUNT_MAX = 1_000_000;
const MINUTES_MAX = 525_600;

const COUNT_PRESETS: [string, number][] = [['不限制', 0], ['500 条', 500], ['1000 条', 1000], ['5000 条', 5000]];
const MINUTES_PRESETS: [string, number][] = [['不限制', 0], ['7 天', 7 * 1440], ['30 天', 30 * 1440], ['90 天', 90 * 1440]];

function skewText(ms: number): string {
  const seconds = Math.round(Math.abs(ms) / 1000);
  if (seconds === 0) return '0 秒（一致）';
  return `${ms >= 0 ? '服务器快' : '服务器慢'} ${seconds} 秒`;
}

export function openSettings(ctx: SettingsContext): void {
  const body = h('div', { class: 'settings-wrap' }, h('div', { class: 'pane__loading' }, h('span', { class: 'spinner' }), '正在读取部署信息…'));
  const modal = openModal({ title: '部署信息', subtitle: '服务器地址、同步健康、存储与保留策略', content: body, size: 'xl' });

  const section = (title: string, className: string, ...children: (Node | null)[]): HTMLElement =>
    h('section', { class: `card-section ${className}`.trim() }, h('h3', { class: 'section-title', text: title }), ...children);
  const kv = (label: string, value: string | Node, tone?: 'warn' | 'ok'): HTMLElement =>
    h('div', { class: 'kv' }, h('dt', { text: label }), h('dd', { dataset: tone ? { tone } : undefined }, value));

  function overview(info: DeploymentInfo): HTMLElement {
    const skew = ctx.skewMs;
    const warns: string[] = [];
    const notes: string[] = [];
    if (skew !== null && Math.abs(skew) > SKEW_LIMIT_MS) warns.push(`本机与服务器时钟相差约 ${Math.round(Math.abs(skew) / 60_000)} 分钟，官方客户端会中止历史同步。`);
    if (info.cleanup.lastError) warns.push(`上一轮自动清理失败：${info.cleanup.lastError}`);
    if (ctx.push === 'offline') notes.push('实时推送未连接，界面靠每 10 秒轮询刷新（实时性稍差，同步不受影响）。');
    if (!info.cleanup.lastCompletedAt) notes.push('自动清理还没有完整跑过一轮（每 20 分钟一次，部署后稍等即可）。');
    const ok = warns.length === 0;
    return h(
      'div',
      { class: 'health', dataset: { tone: ok ? 'ok' : 'warn' }, role: ok ? 'status' : 'alert' },
      icon(ok ? 'check' : 'warning', { size: 22 }),
      h(
        'div',
        { class: 'health__text' },
        h('strong', { text: ok ? '运行正常' : `${warns.length} 项需要关注` }),
        h('ul', null, [...warns.map((w) => h('li', { class: 'health__warn', text: w })), ...notes.map((n) => h('li', { text: n }))]),
        ok && notes.length === 0 ? h('span', { class: 'health__sub', text: `版本 ${info.version} · 推送${PUSH_TEXT[ctx.push].split('（')[0]} · 时钟正常 · 清理正常` }) : null,
      ),
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => void reload() }, icon('refresh', { size: 16 }), '重新读取'),
    );
  }

  function paint(info: DeploymentInfo): void {
    clear(body);
    // 地址取**浏览器此刻真正在用的**（含 https）：服务端经隧道/反代看到的往往是 http，给出去的地址会连不上
    const serverUrl = `${location.origin}/`;
    const urlInput = h('input', { class: 'input input--mono', readonly: true, value: serverUrl, 'aria-label': '服务器地址' });
    urlInput.addEventListener('focus', () => urlInput.select());
    const skew = ctx.skewMs;
    const skewBad = skew !== null && Math.abs(skew) > SKEW_LIMIT_MS;
    const cleanup = info.cleanup;
    const c = info.counts;

    const connection = section(
      '连接客户端',
      'settings__connection',
      h('ol', { class: 'steps' }, h('li', null, '在 SyncClipboard 客户端里选类型 ', h('b', { text: 'SyncClipboard' }), '（不要选 WebDAV）'), h('li', null, '服务器地址填下面这串（末尾的斜杠保留）'), h('li', { text: '用户名、密码与你登录这个页面用的一致' })),
      h('div', { class: 'row row--nowrap' }, urlInput, h('button', { class: 'btn', type: 'button', onclick: () => void ctx.copyText(serverUrl, '已复制服务器地址') }, icon('copy', { size: 16 }), '复制')),
      h(
        'dl',
        { class: 'kvs' },
        kv('服务端版本', info.version),
        kv('推送通道', PUSH_TEXT[ctx.push]),
        kv('可用传输', info.hubTransports.map((t) => t.transport).join(' / ') || '—'),
        kv('单文件上传上限', formatSize(info.limits.maxUploadBytes)),
        kv('项目', h('a', { href: PROJECT_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Leexunhuan743/SyncClipboardCfServer' })),
      ),
    );

    const health = section(
      '同步健康',
      '',
      h(
        'dl',
        { class: 'kvs' },
        kv('本机与服务器时钟差', skew === null ? '尚未测得' : skewText(skew) + (skewBad ? '（超过 5 分钟）' : ''), skewBad ? 'warn' : 'ok'),
        kv('最近一次清理', cleanup.lastCompletedAt ? `${formatRelative(cleanup.lastCompletedAt)} · ${formatAbsolute(cleanup.lastCompletedAt)}` : cleanup.lastRunAt ? '开始过但还没完成' : '还没有运行过', cleanup.lastError ? 'warn' : undefined),
        kv('下一次清理', `约 ${minutesUntilNextCleanup()} 分钟后（每 20 分钟一次）`),
        cleanup.lastError ? kv('上轮失败原因', cleanup.lastError, 'warn') : null,
      ),
    );

    const storage = section(
      '存储',
      '',
      h('div', { class: 'storage__total' }, h('strong', { text: formatSize(info.storage.totalBytes ?? 0) }), h('span', { text: '占用（含回收站里的数据文件）' })),
      typeBar(c.byType),
      h('dl', { class: 'kvs' }, kv('记录', `${c.active} 条活跃 · ${c.deleted} 条在回收站 · ${c.starred} 条已收藏`), kv('回收站', '移到回收站的记录保留 30 天，到期自动彻底清除')),
    );

    // ---- 保留策略：数字输入 + 预设 + 人话换算 ----
    const field = (label: string, hint: string, value: number, presets: [string, number][], human: (n: number) => string, source: string, max: number, key: 'maxSavedHistoryCount' | 'retentionMinutes') => {
      const input = h('input', { class: 'input', type: 'number', min: 0, max, step: 1, inputmode: 'numeric', value: String(value), 'aria-label': label });
      const live = h('span', { class: 'field__live' });
      const sync = (): void => {
        const n = Number(input.value);
        live.textContent = input.value === '' || !Number.isInteger(n) || n < 0 ? '请填不小于 0 的整数' : n > max ? `不能超过 ${max.toLocaleString()}` : `= ${human(n)}`;
        live.dataset.tone = live.textContent.startsWith('=') ? '' : 'error';
        chips.forEach(([chip, preset]) => chip.setAttribute('aria-pressed', String(Number(input.value) === preset)));
      };
      const chips = presets.map(([text, preset]) => [h('button', { class: 'chip-btn', type: 'button', text, onclick: () => { input.value = String(preset); sync(); } }), preset] as const);
      input.addEventListener('input', sync);
      sync();
      return {
        input,
        sync,
        el: h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label' }, h('span', { class: 'field__row' }, h('span', { text: label }), live), input),
          // 「恢复为部署默认」是预设里的最后一项（和 不限制 / 500 条 … 并排）：它也是"选一个值"，只不过值来自部署环境
          h('div', { class: 'chips' }, chips.map(([chip]) => chip), h('button', { class: 'chip-btn chip-btn--reset', type: 'button', title: '清除这里的覆盖值，回落到部署时的环境变量', onclick: async () => {
            try {
              paintRetention((await api.updateSettings({ [key]: null })).retention);
              toast('已恢复为部署默认', { tone: 'success' });
            } catch (e) {
              toast(e instanceof ApiError ? e.message : '保存失败', { tone: 'error' });
            }
          } }, icon('undo', { size: 14 }), '恢复为部署默认')),
          h('p', { class: 'field__hint', text: `${hint} 当前值来自：${source}。` }),
        ),
      };
    };
    const countField = field('最多保留条数', '超出时从最旧的开始清理（已收藏、置顶以及放进收藏夹的不受影响）。', info.retention.maxSavedHistoryCount, COUNT_PRESETS, (n) => (n === 0 ? '不限制' : `${n} 条`), SOURCE[info.retention.maxCountSource], COUNT_MAX, 'maxSavedHistoryCount');
    const minutesField = field('保留时长（分钟）', '超过这个时长的记录会被清理；0 = 不按时间清理。', info.retention.retentionMinutes, MINUTES_PRESETS, describeMinutes, SOURCE[info.retention.retentionSource], MINUTES_MAX, 'retentionMinutes');
    const retentionNote = h('p', { class: 'field__hint' });
    const saveRetention = h('button', { class: 'btn btn--primary', type: 'button', text: '保存' });
    const paintRetention = (r: Retention): void => {
      countField.input.value = String(r.maxSavedHistoryCount);
      minutesField.input.value = String(r.retentionMinutes);
      countField.sync();
      minutesField.sync();
      info.retention = r;
    };
    saveRetention.addEventListener('click', async () => {
      const count = Number(countField.input.value);
      const minutes = Number(minutesField.input.value);
      if (![count, minutes].every((n) => Number.isInteger(n) && n >= 0) || countField.input.value === '' || minutesField.input.value === '' || count > COUNT_MAX || minutes > MINUTES_MAX) {
        retentionNote.textContent = `请填写整数：条数 0–${COUNT_MAX.toLocaleString()}，时长 0–${MINUTES_MAX.toLocaleString()} 分钟。`;
        retentionNote.dataset.tone = 'error';
        return;
      }
      saveRetention.disabled = true;
      try {
        paintRetention((await api.updateSettings({ maxSavedHistoryCount: count, retentionMinutes: minutes })).retention);
        retentionNote.textContent = '';
        toast('保留策略已保存，下一轮清理起生效', { tone: 'success' });
      } catch (e) {
        retentionNote.textContent = e instanceof ApiError ? `保存失败：${e.message}` : '保存失败，请重试。';
        retentionNote.dataset.tone = 'error';
      } finally {
        saveRetention.disabled = false;
      }
    });
    const retention = section('保留策略', '', h('div', { class: 'grid2' }, countField.el, minutesField.el), retentionNote, h('div', { class: 'row row--end' }, saveRetention));

    // ---- 数据维护 ----
    const report = h('div', { class: 'integrity' });
    const check = h('button', { class: 'btn', type: 'button' }, icon('check', { size: 16 }), '检查数据完整性');
    const paintReport = (r: IntegrityReport): void => {
      clear(report);
      if (r.missingCount === 0) {
        report.append(h('p', { class: 'ok-line' }, icon('check', { size: 16 }), `一切正常：${r.recordsWithData} 条带数据的记录都能在存储里找到对应对象（共 ${r.historyObjects} 个对象）。`));
        return;
      }
      report.append(
        h('p', { class: 'form-error', text: `发现 ${r.missingCount} 条记录的数据文件不在存储里${r.missingTruncated ? '（只列出前 50 条）' : ''}：` }),
        h('ul', { class: 'plain-list' }, r.missing.map((m) => h('li', null, h('span', { class: 'tag', text: typeLabel(m.type) }), ` ${m.text || '（无文本）'} · ${formatSize(m.size)} · ${formatAbsolute(m.createTime)}`))),
      );
    };
    check.addEventListener('click', async () => {
      check.disabled = true;
      check.dataset.busy = 'true';
      clear(report).append(h('div', { class: 'pane__loading' }, h('span', { class: 'spinner' }), '正在对照数据库与对象存储…'));
      try {
        paintReport(await api.integrity());
      } catch (e) {
        clear(report).append(h('p', { class: 'form-error', text: e instanceof ApiError ? e.message : '检查失败' }));
      } finally {
        check.disabled = false;
        delete check.dataset.busy;
      }
    });
    const maintenance = section('数据维护', '', h('p', { class: 'note', text: '自检会列举一遍对象存储，需要几秒钟，所以只在你点击时才运行。' }), h('div', { class: 'row' }, check), report);

    const danger = section(
      '危险操作',
      'card-section--danger',
      h('div', { class: 'danger-row' }, h('div', null, h('strong', { text: '清空回收站' }), h('p', { class: 'note', text: '永久删除回收站里的全部记录及其数据文件。' })), h('button', { class: 'btn btn--danger-ghost', type: 'button', onclick: async () => { await ctx.onEmptyTrash(); void reload(); } }, '清空回收站')),
      h('div', { class: 'danger-row' }, h('div', null, h('strong', { text: '清空全部记录' }), h('p', { class: 'note', text: '删除所有记录（含收藏、置顶和收藏夹里的）和全部数据文件，无法恢复；收藏夹本身（空的）会保留。' })), h('button', { class: 'btn btn--danger', type: 'button', onclick: async () => { await ctx.onClearAll(); void reload(); } }, '清空全部')),
    );

    body.append(
      overview(info),
      // 卡片高矮差很多：用 CSS 多栏（columns）让浏览器自己平衡各栏高度，而不是网格硬排出空白
      h('div', { class: 'settings' }, connection, health, storage, retention, maintenance, danger),
      h('p', { class: 'note settings__foot' }, h('button', { class: 'linkish', type: 'button', text: '键盘快捷键', onclick: () => { modal.close(); ctx.onShortcuts(); } })),
    );
  }

  async function reload(): Promise<void> {
    try {
      paint(await api.info());
    } catch (e) {
      clear(body).append(h('div', { class: 'pane__problem' }, icon('warning', { size: 22 }), h('p', { text: e instanceof ApiError ? e.message : '读取失败' }), h('button', { class: 'btn', type: 'button', text: '重试', onclick: () => void reload() })));
    }
  }
  void reload();
}
