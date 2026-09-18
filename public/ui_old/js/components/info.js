// 部署信息对话框：把「客户端该填什么地址」这类问题在这里一次说清。
// 这不是装饰——自建服务器的第一个卡点就是服务器地址到底填不填尾斜杠、要不要带 /dav。
//
// 它同时承担**维护面板**（清理状态 / 数据完整性 / 保留策略 / 危险操作）。放在一起是因为
// 「这台服务器现在怎么样」本来是同一个问题；把它们摊到另一个设置页，只会让单用户实例的
// 运维面多出几处必须用命令行才能到达的地方。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
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
        '这些记录预览/下载时会显示「数据不可用」，可以搜索后删除。',
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

// 保留策略的口径必须区分三种状态，不能只判真假：**未设置**（Meta 与部署环境变量都没有）、
// **已关闭**（0 = 明确关掉该阶段）、**有值**。写成 `retentionMinutes ? … : '未设置'` 会把
// 「已关闭」显示成「未设置」——那正是用户刚做完的设置，看起来像没保存上。
function retentionText(retention) {
  const minutes = retention?.retentionMinutes ?? null;
  const maxCount = retention?.maxSavedHistoryCount ?? null;
  if (minutes === null && maxCount === null) {
    // 「未设置」不是「不清理」：cleanup 会用内置默认（7 天 / 1000 条）照常跑，说成「不生效」是错的
    return '未设置（按内置默认清理：保留 7 天、最多 1000 条）';
  }
  const timePart =
    minutes === null ? '保留期：按部署环境变量' : minutes === 0 ? '保留期清理已关闭' : `${Math.round(minutes / 1440)} 天`;
  const countPart =
    maxCount === null ? '条数：按部署环境变量' : maxCount === 0 ? '条数裁剪已关闭' : `上限 ${maxCount} 条`;
  return `${timePart} · ${countPart}；已删除的记录再保留 30 天后彻底清除`;
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
      placeholder: '分钟',
    });
    const maxCount = el('input', {
      class: 'input input--num',
      type: 'number',
      min: '0',
      max: String(MAX_SAVED_HISTORY_COUNT_MAX),
      step: '1',
      'aria-label': '历史条数上限',
      placeholder: '条数',
    });
    // 只有**确实来自 Meta 覆盖**时才把值填进输入框：否则「什么都没改直接按保存」会把当前生效值
    // 写成一条 Meta 覆盖，等于把「跟随部署环境变量」静默冻结（复核指出的陷阱）。
    // 来自 env / 内置默认时留空，生效值放在 placeholder 里（看得见、但不会被顺手提交）。
    minutes.value = retention?.retentionSource === 'meta' ? (retention?.retentionMinutes ?? '') : '';
    maxCount.value = retention?.maxCountSource === 'meta' ? (retention?.maxSavedHistoryCount ?? '') : '';
    minutes.placeholder = retention?.retentionMinutes === null ? '不限' : `当前 ${retention.retentionMinutes}`;
    maxCount.placeholder = retention?.maxSavedHistoryCount === null ? '不限' : `当前 ${retention.maxSavedHistoryCount}`;
    const source = el('span', { class: 'note' });
    const sourceText = () =>
      `当前生效：保留 ${retention?.retentionMinutes ?? '不限'} 分钟、上限 ${retention?.maxSavedHistoryCount ?? '不限'} 条` +
      `（来源：${retention?.retentionSource === 'meta' ? '此处的设置' : '部署环境变量'} / ` +
      `${retention?.maxCountSource === 'meta' ? '此处的设置' : '部署环境变量'}）`;
    source.textContent = sourceText();

    const save = el(
      'button',
      {
        class: 'btn btn--primary',
        type: 'button',
        onclick: async () => {
          if (isPending(save)) return;
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
            ['保留分钟', patch.retentionMinutes, RETENTION_MINUTES_MAX],
            ['条数上限', patch.maxSavedHistoryCount, MAX_SAVED_HISTORY_COUNT_MAX],
          ];
          const bad = bounds.find(
            ([, value, max]) => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > max),
          );
          if (bad) {
            source.textContent =
              `${bad[0]}只能填 0–${bad[2]} 之间的整数；留空表示回落到部署时的环境变量。`;
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
        el('label', { class: 'field-inline' }, [el('span', { class: 'kv__k', text: '保留分钟' }), minutes]),
        el('label', { class: 'field-inline' }, [el('span', { class: 'kv__k', text: '条数上限' }), maxCount]),
        save,
      ]),
      el('span', {
        class: 'note',
        text:
          '留空 = 用部署时的环境变量；0 = 关闭对应阶段。改动立即对下一轮清理生效。' +
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
        text: '清空全部历史会删除所有记录（活跃 + 回收站）及其数据文件，无法恢复。只想清回收站时，进回收站视图用选择条上的按钮。',
      }),
      el('div', { class: 'panel__actions' }, [button]),
    ]);
  }

  return {
    open(info) {
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
        // 已经有快照的调用方会先开壳、再在刷新失败时用 open(null) 覆盖它 ——
        // 对一个已经打开的 <dialog> 再调 showModal() 会抛 InvalidStateError，故必须判开合状态。
        if (!dialog.open) dialog.showModal();
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
          el('div', { class: 'panel__form' }, [urlInput, copyButton(() => info.serverUrl, '服务器地址')]),
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
            kvRow('记录条数', `总计 ${counts.total ?? 0} 条 · 活跃 ${counts.active ?? 0} 条 · 已删除 ${counts.deleted ?? 0} 条`),
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

      dialog.showModal();
    },
  };
}
