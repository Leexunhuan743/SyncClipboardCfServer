// 部署信息对话框：把「客户端该填什么地址」这类问题在这里一次说清。
// 这不是装饰——自建服务器的第一个卡点就是服务器地址到底填不填尾斜杠、要不要带 /dav。
//
// 它同时承担**维护面板**（清理状态 / 数据完整性 / 保留策略 / 危险操作）。放在一起是因为
// 「这台服务器现在怎么样」本来是同一个问题；把它们摊到另一个设置页，只会让单用户实例的
// 运维面多出几处必须用命令行才能到达的地方。
import { el, svg } from '../dom.js';
import { iconPaths } from '../../../ui_shared/js/icons.js';
import { api } from '../api.js';
import { formatAbsolute } from '../format.js';
import { setPending, flashSuccess, isPending } from './toast.js';

// 官方客户端在时钟差 > 5 分钟时会中止历史同步（docs/protocol.md §4）
const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000;

// 保留策略的上界：与服务端 `src/ui/maintenance.ts` 的两个常量逐字同值
// （525600 分钟 = 1 年、1000000 条）。写在客户端是为了让越界**在本地就被说清**，
// 而不是发出去换回一个 400 —— 服务端仍然是唯一的裁判，这里只是提前一步。
const RETENTION_MINUTES_MAX = 525_600;
const MAX_SAVED_HISTORY_COUNT_MAX = 1_000_000;

// 内置默认值：与 `src/cleanup.ts` 的 DEFAULT_RETENTION_MINUTES / DEFAULT_MAX_SAVED_HISTORY_COUNT
// 逐字同值。**为什么界面要知道它们**：`/ui/api/info` 在"Meta 与部署环境变量都没设"时返回
// `retentionMinutes: null`，而 null 的语义是"没显式配置"、不是"不限" —— 那一刻真正生效的
// 就是这两个内置默认（cleanup 的 `settings.retentionMinutes ?? DEFAULT_RETENTION_MINUTES`）。把
// null 说成"不限"或"按部署环境变量"，等于让用户去找一个并不存在的配置项。
const DEFAULT_RETENTION_MINUTES = 10_080; // 7 天
const DEFAULT_MAX_HISTORY_COUNT = 1_000;

// 一行「标签 : 值」。标签列定宽、值列吃掉其余宽度 —— 多行并排时标签列彼此对齐，
// 读起来是一张表；旧版是"小标题一行 + 正文一行"堆叠，十来个字段就堆成一堵墙
// （每行的标签都重新起一个视觉层级，而它其实只是同一张表的左列）。
// 窄屏改为上下排布，见 components.css 的 `.kv` 块。
function kvRow(label, value, { mono = false } = {}) {
  return el('div', { class: 'kv__row' }, [
    el('span', { class: 'kv__k', text: label }),
    mono
      ? el('span', { class: 'kv__v mono', text: value })
      : el('span', { class: 'kv__v', text: value }),
  ]);
}

function kvList(rows) {
  return el('div', { class: 'kv' }, rows);
}

// 汇总行的值在保存设置后要就地改写（不必重建整行）
function setFieldValue(field, text) {
  const value = field.querySelector('.kv__v');
  if (value) value.textContent = text;
}

// 维护面板的小节。用 <h3> 而不是一条视觉分隔线：读屏器要能听出「这一段在讲什么」。
function section(title, children) {
  return el('section', { class: 'panel' }, [el('h3', { class: 'panel__title', text: title }), ...children]);
}

// 数据完整性检查的结果渲染。缺失清单只列前 50 条（服务端截断），其余报告数量。
function renderIntegrity(output, result) {
  if (result.missingCount === 0) {
    output.replaceChildren(
      el('span', {
        class: 'note',
        text: `未发现缺失：${result.recordsWithData} 条带数据的记录与存储里的 ${result.historyObjects} 个对象一一对上。`,
      }),
    );
    return;
  }
  const items = result.missing.map((entry) =>
    el('li', { class: 'panel__item' }, [
      el('span', { class: 'mono', text: `${entry.type}-${entry.hash.slice(0, 8)}` }),
      el('span', { class: 'panel__item-text', text: entry.text || '（空文本）' }),
    ]),
  );
  output.replaceChildren(
    el('span', {
      class: 'note note--warn',
      text:
        `发现 ${result.missingCount} 条记录的数据文件已不在存储里` +
        `${result.missingTruncated ? '（下面只列前 50 条）' : ''}：` +
        '这些记录预览/下载时会显示「数据不可用」，可以搜索后移动到回收站。',
    }),
    el('ul', { class: 'panel__list' }, items),
  );
}

// 推送通道的三种状态。offline 不是「坏了」——轮询一直可用，只是改动要等到下一次轮询才可见。
const PUSH_LABELS = {
  live: '已连接（WebSocket 广播，改动立即到达）',
  connecting: '正在连接…（当前仍按轮询刷新）',
  offline: '未连接（轮询刷新，可见时每 10 秒）',
};

/**
 * 分钟数 → 人话。
 *
 * **必须分档**：此前一律 `Math.round(minutes / 1440) 天`，而表单允许填 0..525600 的任意整数 ——
 * 填 60 分钟显示「0 天」、填 1000 分钟显示「1 天」，两个都是能真的填出来的值
 * （0 与 null 另外各有语义，见下面 retentionText）。
 */
function retentionDuration(minutes) {
  if (minutes === 0) return '保留期清理已关闭';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) {
    // 90 分钟 → 1.5 小时（留一位小数）；整小时不写小数
    const hours = minutes % 60 === 0 ? minutes / 60 : Math.round((minutes / 60) * 10) / 10;
    return `${hours} 小时`;
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.round((minutes % 1440) / 60);
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`;
}

/**
 * 保留策略的口径必须区分四种状态，不能只判真假：**未设置**（Meta 与部署环境变量都没有 →
 * 生效值是内置默认）、**已关闭**（0 = 明确关掉该阶段）、**有值**、以及两项各自独立。
 * 写成 `retentionMinutes ? … : '未设置'` 会把「已关闭」显示成「未设置」——那正是用户刚做完的
 * 设置，看起来像没保存上。
 *
 * 导出给 `test/ui-logic.test.ts`：这是一段纯逻辑，而它的三种错法（0 天 / 按部署环境变量 /
 * 不限）都只在特定取值下才现形，靠人眼在界面上看永远看不全。
 */
export function retentionText(retention) {
  const minutes = retention?.retentionMinutes ?? null;
  const maxCount = retention?.maxSavedHistoryCount ?? null;
  if (minutes === null && maxCount === null) {
    // 「未设置」不是「不清理」：cleanup 会用内置默认（7 天 / 1000 条）照常跑，说成「不生效」是错的
    return (
      `未设置（按内置默认清理：保留 ${DEFAULT_RETENTION_MINUTES / 1440} 天、` +
      `最多 ${DEFAULT_MAX_HISTORY_COUNT} 条）`
    );
  }
  const timePart =
    minutes === null
      ? `保留期未设置（按内置默认 ${DEFAULT_RETENTION_MINUTES / 1440} 天）`
      : retentionDuration(minutes);
  const countPart =
    maxCount === null
      ? `条数未设置（按内置默认 ${DEFAULT_MAX_HISTORY_COUNT} 条）`
      : maxCount === 0
        ? '条数裁剪已关闭'
        : `上限 ${maxCount} 条`;
  return `${timePart} · ${countPart}；回收站里的记录再保留 30 天后彻底清除`;
}

/**
 * 「当前生效」那一行的值 + 来源。来源的三种说法必须与生效值一致：`null` ⇒ 内置默认
 * （此前写死成"部署环境变量"，而变量没配时用户会去找一个不存在的东西）、来源 meta ⇒ 此处的设置、
 * 其余 ⇒ 部署环境变量。
 */
export function retentionEffectiveText(retention) {
  const minutes = retention?.retentionMinutes ?? null;
  const maxCount = retention?.maxSavedHistoryCount ?? null;
  const value = (raw, fallback, unit) =>
    raw === null ? `${fallback} ${unit}（内置默认）` : raw === 0 ? `已关闭（0）` : `${raw} ${unit}`;
  const source = (raw) =>
    raw === null ? '内置默认' : retention?.retentionSource === 'meta' ? '此处的设置' : '部署环境变量';
  const sourceOfCount = (raw) =>
    raw === null ? '内置默认' : retention?.maxCountSource === 'meta' ? '此处的设置' : '部署环境变量';
  return (
    `当前生效：保留 ${value(minutes, DEFAULT_RETENTION_MINUTES, '分钟')}、` +
    `上限 ${value(maxCount, DEFAULT_MAX_HISTORY_COUNT, '条')}` +
    `（来源：${source(minutes)} / ${sourceOfCount(maxCount)}）`
  );
}

// ISO 串（`formatAbsolute` 要的就是它）——这层转换只在这里做一次，
// 免得让格式化函数同时接受两种表示（数字会被 `Date.parse` 拒掉、原样返回成裸毫秒串）。
const isoOf = (ms) => new Date(ms).toISOString();

export function createInfo({ onCopyText, onClearAll, getClockOffsetMs, getLastChangeMs, getPushState, onRetry }) {
  const title = el('h2', { class: 'dialog__title', id: 'info-title', text: '部署信息' });
  const body = el('div', { class: 'dialog__body' });

  const dialog = el('dialog', { class: 'dialog', 'aria-labelledby': 'info-title' }, [
    el('div', { class: 'dialog__head' }, [
      title,
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => dialog.close() }, [
        svg(iconPaths('close')),
      ]),
    ]),
    body,
    // 页脚只放一个"关闭"：这个对话框是**只读状态面板 + 就地设置**，没有"确认/应用"这类
    // 需要收口的主操作。给一个明确出口，用户不必去右上角找那颗 ×（也顺带让
    // Esc / 点背景 / 按钮三条关闭路径在界面上都成立）。
    el('div', { class: 'dialog__foot' }, [
      el('span', { class: 'dialog__foot-spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, [
        el('span', { class: 'btn__label', text: '关闭' }),
      ]),
    ]),
  ]);
  // 点背景关闭（点击落在 dialog 自身而不是其内容上）
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);

  // 复制按钮：成功就地显示「已复制」，而不是只弹一条提示（提示条会和其他消息互相顶掉）
  // `label` 只用于"复制的是什么"（提示条文案）；按钮自己的名字统一叫「复制地址」——
  // 动作标签一律"动词 + 对象"（见 list.js 的说明），这里唯一的对象就是上面那个服务器地址。
  function copyButton(getText, label) {
    const button = el(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          if (isPending(button)) return;
          setPending(button, true);
          try {
            if (await onCopyText(getText(), label)) flashSuccess(button, { label: '已复制' });
          } finally {
            setPending(button, false);
          }
        },
      },
      [svg(iconPaths('copy'), { size: 16 }), el('span', { class: 'btn__label', text: '复制地址' })],
    );
    return button;
  }

  // 服务端时间与时钟差：由轮询顺带观测（见 main.js 的 pollOnce），这里只负责如实展示。
  function clockRow() {
    const offset = getClockOffsetMs?.() ?? null;
    // 轮询在首屏之后才回来，故这里可能还没有观测值——如实说明，而不是画一个 0
    if (offset === null || !Number.isFinite(offset)) return kvRow('服务端时间', '尚未观测到（下一次轮询后显示）');
    const seconds = Math.round(offset / 1000);
    const node = kvRow(
      '服务端时间',
      `${formatAbsolute(isoOf(Date.now() + offset))}（本机时钟${seconds >= 0 ? '慢' : '快'} ${Math.abs(seconds)} 秒）`,
    );
    if (Math.abs(offset) > CLOCK_SKEW_WARN_MS) {
      node.append(
        el('span', {
          class: 'note note--warn',
          text: '与本机相差超过 5 分钟：官方客户端会因此中止历史同步，先校准两边的系统时间。',
        }),
      );
    }
    return node;
  }

  // 清理任务的可观测面（F11）：清理把「本轮开始时间 / 失败信息 / 续跑游标」写进 Meta，
  // 这个面板是它唯一的读者——没有它，「静默未清理」就仍然不可见。
  function cleanupSection(cleanup) {
    const cursors = cleanup?.cursors ?? {};
    // 游标非 0 = 该阶段本轮没跑完、下轮续跑；全 0 时不必逐阶段罗列
    const pending = Object.entries(cursors).filter(([, value]) => Number(value) > 0);
    return section('清理任务', [
      kvList([
        kvRow('最近一次运行', cleanup?.lastRunAt ? formatAbsolute(cleanup.lastRunAt) : '从未运行（Cron 未触发过）'),
        kvRow('上次失败', cleanup?.lastError ?? '无'),
        kvRow(
          '续跑游标',
          pending.length > 0 ? pending.map(([phase, value]) => `${phase} ${value}`).join(' · ') : '无积压',
        ),
      ]),
    ]);
  }

  // 保留策略：0 = 关闭该阶段、空 = 回落到部署时的环境变量（服务端语义，见 src/cleanup.ts）。
  // 返回 `{ node, refresh }`：保存成功后调用方要把**上方那条汇总行**一起改写 ——
  // 否则会出现「下面提示已保存、上面还写着旧值」的自相矛盾（对话框重开才会同步）。
  function retentionSection(retention, onSaved, summaryRow) {
    const minutes = el('input', {
      class: 'input input--num',
      type: 'number',
      min: '0',
      max: String(RETENTION_MINUTES_MAX),
      step: '1',
      'aria-label': '历史保留分钟数',
      // 这一栏的错误与"当前生效值"共用下面那行说明（`components.md` §2 的 error 格）：
      // 只把文字换掉、不把字段与它关联起来，读屏用户听到的只是一句孤立的报错。
      'aria-describedby': 'retention-status',
      placeholder: '分钟',
    });
    const maxCount = el('input', {
      class: 'input input--num',
      type: 'number',
      min: '0',
      max: String(MAX_SAVED_HISTORY_COUNT_MAX),
      step: '1',
      'aria-label': '历史条数上限',
      'aria-describedby': 'retention-status',
      placeholder: '条数',
    });
    // 只有**确实来自 Meta 覆盖**时才把值填进输入框：否则「什么都没改直接按保存」会把当前生效值
    // 写成一条 Meta 覆盖，等于把「跟随部署环境变量」静默冻结（复核指出的陷阱）。
    // 来自 env / 内置默认时留空，生效值放在 placeholder 里（看得见、但不会被顺手提交）。
    minutes.value = retention?.retentionSource === 'meta' ? (retention?.retentionMinutes ?? '') : '';
    maxCount.value = retention?.maxCountSource === 'meta' ? (retention?.maxSavedHistoryCount ?? '') : '';
    // placeholder 给**当前生效值**（含内置默认的回落），而不是字面「不限」：
    // `null` 的语义是"没显式配置"，那一刻生效的是 10080 分钟 / 1000 条。
    minutes.placeholder = `当前 ${retention?.retentionMinutes ?? DEFAULT_RETENTION_MINUTES}`;
    maxCount.placeholder = `当前 ${retention?.maxSavedHistoryCount ?? DEFAULT_MAX_HISTORY_COUNT}`;
    // 这一行既是"当前生效…"的说明，也是这一段的**状态与错误出口**：它是两个输入框的
    // `aria-describedby` 目标（`id` 必须与下面两处引用逐字一致），出错时被替换成错误文案。
    // `role="status"` 让错误在读屏里被播报一次 —— 光把文字换掉，读屏用户是听不到的
    // （`components.md` §2 的 error 格要求：信息挨着控件、被 `aria-describedby` 关联、不靠颜色）。
    const source = el('span', { class: 'note', id: 'retention-status', role: 'status' });
    const sourceText = () => retentionEffectiveText(retention);
    source.textContent = sourceText();

    const save = el(
      'button',
      {
        class: 'btn btn--primary',
        type: 'button',
        onclick: async () => {
          if (isPending(save)) return;
          // 每次尝试保存先清掉上一次的字段级错误标记（`aria-invalid` 不是"曾经错过"的历史记录）
          minutes.removeAttribute('aria-invalid');
          maxCount.removeAttribute('aria-invalid');
          // 只接受**整数串**：`Number.parseInt('0.5')` 会得到 0，而 0 的语义是「关闭该阶段」——
          // 用户输入 0.5 就被静默关掉保留期，是那种事后完全看不出原因的故障。小数直接判非法。
          const parse = (input) => {
            const raw = input.value.trim();
            if (raw === '') return null;
            return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
          };
          const patch = { retentionMinutes: parse(minutes), maxSavedHistoryCount: parse(maxCount) };
          // 越界在本地就说清（与服务端同一套上界），不要发出去换一个 400 回来 ——
          // 那会把"填错了"显示成"保存失败：invalid_request"，用户不知道错在哪一栏。
          const bounds = [
            ['保留分钟', patch.retentionMinutes, RETENTION_MINUTES_MAX, minutes],
            ['条数上限', patch.maxSavedHistoryCount, MAX_SAVED_HISTORY_COUNT_MAX, maxCount],
          ];
          const bad = bounds.find(
            ([, value, max]) => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > max),
          );
          if (bad) {
            // 说出**哪一栏**错，并把焦点送过去：这一段的错误只有一行文案，用户得自己去找是哪一个框
            const [, , max, input] = bad;
            input.setAttribute('aria-invalid', 'true');
            input.focus();
            source.textContent =
              `${bad[0]}只能填 0–${max} 之间的整数；留空表示回落到部署时的环境变量。`;
            return;
          }
          setPending(save, true);
          try {
            const next = await api.updateSettings(patch);
            Object.assign(retention ?? {}, next.retention ?? {});
            source.textContent = sourceText();
            onSaved?.(retention);
            flashSuccess(save, { label: '已保存' });
          } catch (error) {
            // 失败留在原地说明原因（对话框内的表单不该用一闪而过的提示条报错）
            source.textContent = `保存失败：${error.message}`;
          } finally {
            setPending(save, false);
          }
        },
      },
      [el('span', { class: 'btn__label', text: '保存' })],
    );

    return section('保留策略', [
      // 生效值（汇总行）与输入框在同一段里：改完就地能看到"当前生效"跟着变，
      // 不必关掉对话框再打开来确认。
      kvList([summaryRow]),
      el('div', { class: 'panel__form' }, [
        // 两个字段**竖排**（2026-09-22 用户要求："现在两个是横排改成竖排"）：此前它们与保存键
        // 挤成一行三列（窄屏再各自折行），"哪个值属于哪个标签"要靠位置去猜；竖排之后一列读下来。
        el('div', { class: 'field-stack' }, [
          el('label', { class: 'field-inline' }, [el('span', { class: 'kv__k', text: '保留分钟' }), minutes]),
          el('label', { class: 'field-inline' }, [el('span', { class: 'kv__k', text: '条数上限' }), maxCount]),
        ]),
        save,
      ]),
      el('span', {
        class: 'note',
        text:
          '留空 = 回落到部署时的环境变量（两边都没有时用内置默认：保留 ' +
          `${DEFAULT_RETENTION_MINUTES / 1440} 天、最多 ${DEFAULT_MAX_HISTORY_COUNT} 条）；` +
          '0 = 关闭对应阶段。改动立即对下一轮清理生效。' +
          `可填范围：保留分钟 0–${RETENTION_MINUTES_MAX}（1 年）、条数 0–${MAX_SAVED_HISTORY_COUNT_MAX}。`,
      }),
      source,
    ]);
  }

  function integritySection() {
    const output = el('div', { class: 'panel__out' });
    const button = el(
      'button',
      { class: 'btn', type: 'button' },
      [svg(iconPaths('refresh'), { size: 16 }), el('span', { class: 'btn__label', text: '开始检查' })],
    );
    button.addEventListener('click', async () => {
      if (isPending(button)) return;
      setPending(button, true);
      output.replaceChildren(el('span', { class: 'note', text: '正在比对记录与存储对象…' }));
      try {
        renderIntegrity(output, await api.integrity());
      } catch (error) {
        output.replaceChildren(el('span', { class: 'note note--warn', text: `检查失败：${error.message}` }));
      } finally {
        setPending(button, false);
      }
    });
    return section('数据完整性', [
      el('span', {
        class: 'note',
        text: '核对「记录说有数据、存储里却没有对象」的条目（这类记录的预览/下载会失败）。检查要列举一遍存储，故只在手动点击时执行。',
      }),
      el('div', { class: 'panel__actions' }, [button]),
      output,
    ]);
  }

  function dangerSection() {
    const button = el(
      'button',
      // 与确认框里的同一个动作保持同一档强度（2026-09-18 统一，理由见 components.css 的说明）
      { class: 'btn btn--danger-solid', type: 'button' },
      [svg(iconPaths('trash'), { size: 16 }), el('span', { class: 'btn__label', text: '清空全部历史' })],
    );
    button.addEventListener('click', async () => {
      if (await onClearAll()) dialog.close();
    });
    return section('危险操作', [
      el('span', {
        class: 'note',
        text: '清空全部历史会删除所有记录（活跃 + 回收站）及其数据文件，无法恢复。只想清回收站时，进回收站视图点结果区头栏的「清空回收站」。',
      }),
      el('div', { class: 'panel__actions' }, [button]),
    ]);
  }

  return {
    open(info) {
      // `open()` 会被**多次**调用（先 `open(cached)` 开壳、数据回来再 `open(fresh)`；「重试」同样再走一遍）。
      // 「第一次打开」这个判据是给下面定焦点用的：只有它才该决定焦点去哪，
      // 后续的调用不能把用户已经移开的焦点抢回来。
      const firstOpen = !dialog.open;
      // 焦点交给**主操作**的判据（2026-09-22 发布前审核实测踩到）：`open(fresh)` 会把 body 整体
      // `replaceChildren` —— 上一轮刚聚焦的那个按钮随之被摘掉，浏览器把焦点落回 `<body>`
      // （实测 `activeElement` 就是 body）。故"已经在框里的焦点"才不动；落回 body 的就算无主。
      const focusMain = (target) => {
        if (firstOpen || !dialog.contains(document.activeElement)) target.focus();
      };
      if (!info) {
        // 首屏就失败时的错误态（2026-09-18 补「重试」）：此前只有一句"暂时取不到"，
        // 而这条路径几乎全是网络/权限类的瞬时故障 —— 让用户关掉再打开一次是没必要的成本。
        const retry = el(
          'button',
          {
            class: 'btn btn--primary',
            type: 'button',
            onclick: async (event) => {
              const button = event.currentTarget;
              if (isPending(button)) return;
              setPending(button, true);
              try {
                // 重试成功时 `onRetry`（main.js 的 openInfo）会用新数据重绘本对话框；
                // 再失败则本函数会带着新的错误态重新进来（对话框已打开，不会重复 showModal）。
                await onRetry?.();
              } finally {
                setPending(button, false);
              }
            },
          },
          [svg(iconPaths('refresh'), { size: 16 }), el('span', { class: 'btn__label', text: '重试' })],
        );
        body.replaceChildren(
          el('p', { text: '暂时取不到部署信息。' }),
          el('span', {
            class: 'note',
            text: '服务器没有返回部署信息（网络或权限问题）。重试一次通常就好；持续失败时看浏览器控制台与 wrangler tail。',
          }),
          el('div', { class: 'panel__actions' }, [retry]),
        );
        // 调用方（`main.js` 的 `openInfo`）会**多次**调 `open()`，而第二次进来时对话框已经开着：
        //   · 有快照 —— 先 `open(cached)` 开壳，那次请求回来再 `open(fresh)` 覆盖；
        //   · 没有快照且请求失败 —— 走 `open(null)`（指出「暂时取不到部署信息」），
        //     用户点「重试」会原样再走一遍，于是又是 `open(null)`。
        // 对一个已经打开的 <dialog> 再调 showModal() 会抛 InvalidStateError，故必须判开合状态。
        if (firstOpen) dialog.showModal();
        // 错误态里的主操作就是「重试」（与成功态落在「复制地址」是同一条判据）
        focusMain(retry);
        return;
      }

      const urlInput = el('input', {
        class: 'input input--url',
        type: 'text',
        readonly: true,
        'aria-label': 'SyncClipboard 客户端的服务器地址',
        value: info.serverUrl,
      });
      urlInput.id = 'server-url';
      urlInput.addEventListener('focus', () => urlInput.select());
      urlInput.addEventListener('click', () => urlInput.select());
      // 提出来单独持有：下面要用它做**初始焦点**（这个对话框存在的理由就是"客户端该填哪个地址"，
      // 键盘用户进来第一件事多半是把地址复制走 —— Enter 直接复制，比落在右上角的 ✕ 有用）。
      const copyUrl = copyButton(() => info.serverUrl, '服务器地址');

      const retention = info.retention ?? {};
      const counts = info.counts ?? {};
      const byType = counts.byType ?? {};
      const transports = (info.hubTransports ?? []).map((entry) => entry.transport).join(' · ');
      const fileSizeMB = info.storage?.totalFileSizeMB ?? 0;
      const lastChangeMs = getLastChangeMs?.() ?? null;
      // 汇总行与「保留策略」小节共用同一个 retention 对象：小节保存成功后回写它，并刷新这一行
      const retentionRow = kvRow('保留策略', retentionText(retention));

      body.replaceChildren(
        // 第一段是**这个对话框存在的理由**（客户端该填哪个地址），故放在最前、不折叠、不缩进
        section('客户端配置', [
          el('label', { class: 'kv__k', for: 'server-url', text: 'SyncClipboard 的「服务器地址」' }),
          el('div', { class: 'panel__form' }, [urlInput, copyUrl]),
          el('span', {
            class: 'note',
            text: '账户与密码和服务端一致（即部署时设置的 USERNAME / PASSWORD）。登出只清除本机 Cookie，不会使已泄露的会话令牌失效；要立即撤销，只能改口令。',
          }),
        ]),
        section('服务器', [
          kvList([
            kvRow('版本', info.version ?? '—'),
            kvRow('传输', transports || '—'),
            kvRow('实时推送', PUSH_LABELS[getPushState?.() ?? 'offline'] ?? '未知'),
            clockRow(),
            kvRow('最近一次变更', Number.isFinite(lastChangeMs) ? formatAbsolute(isoOf(lastChangeMs)) : '尚未观测到'),
          ]),
        ]),
        section('存储', [
          kvList([
            kvRow('数据体积', `${fileSizeMB} MB`),
            kvRow('记录条数', `总计 ${counts.total ?? 0} 条 · 活跃 ${counts.active ?? 0} 条 · 回收站 ${counts.deleted ?? 0} 条`),
            kvRow(
              '按类型',
              `文本 ${byType.Text ?? 0} · 图片 ${byType.Image ?? 0} · 文件 ${byType.File ?? 0} · 组合 ${byType.Group ?? 0}`,
            ),
          ]),
        ]),
        retentionSection(retention, () => setFieldValue(retentionRow, retentionText(retention)), retentionRow),
        cleanupSection(info.cleanup),
        integritySection(),
        dangerSection(),
      );

      // 与上面的 `!info` 分支同一个理由：`open()` 会被**多次**调用（先 `open(cached)` 开壳、
      // 请求回来再 `open(fresh)`；从「重试」按钮进来同样再走一遍）—— 第二次起对话框已经开着，
      // 直接 showModal() 会抛 InvalidStateError，被调用方 catch 吞掉后还会把刚画好的数据
      // 换回「暂时取不到部署信息」（重试成功却显示成失败）。
      if (firstOpen) dialog.showModal();
      // 初始焦点 = 这个对话框的**主操作**（复制服务器地址）。此前落在右上角的 ✕（`showModal()`
      // 的默认），键盘用户要 Tab 过整个面板才够得到唯一想按的那一枚。
      focusMain(copyUrl);
    },
  };
}
