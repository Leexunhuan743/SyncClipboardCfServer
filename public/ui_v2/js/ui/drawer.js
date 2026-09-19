// 抽屉：低频控件 + 维护信息 + 部署信息。
//
// 为什么是抽屉而不是又一个对话框：抽屉容纳"可以边看边改"的设置与只读信息，
// 对话框适合"必须做出决定才能继续"的内容。混用会让用户猜每个入口的后果。
//
// 这里同时落地了 `docs/backend-gaps.md` §1 的几条"已建未接"能力：
//   §1.1 清理状态（`/ui/api/info` 一直在返回 `cleanup`，此前**无人消费**）
//   §1.5 页大小档位补齐到 500（服务端白名单的上限）
//   §1.6 `PATCH` 响应体的版本/时间戳被采纳（不在这里，在 boot.js 的 adoptPatch）
//   §1.8 服务端时钟与本机的差值（官方客户端在 |差| > 5 分钟时**中止历史同步**）
import { el, clear } from '../dom.js';
import { PAGE_SIZES, SORT_FIELDS, toDateInput, fromDateInput } from '../filters.js';
import { formatAbsolute, describeClockSkew, typeLabel } from '../format.js';
import { iconButton, labelButton } from './button.js';
import { flashOk, setPending } from './toast.js';

/**
 * @param {{ onSetPageSize: (n: number) => void,
 *           onSort: (field: string, order: string) => void, onCustomRange: (after: number|null, before: number|null) => void,
 *           onSaveSettings: (patch: object) => Promise<boolean>,
 *           onCheckIntegrity: () => Promise<object|null>,
 *           onClear: (scope: string) => Promise<boolean> }} handlers
 */
export function createDrawer(handlers) {
  const body = el('div', { class: 'drawer__body' });
  // 标题带 id：`<dialog>` 需要 `aria-labelledby` 才有可访问名，否则读屏只说"对话框"
  const title = el('h2', { class: 'drawer__title', id: 'drawer-title', text: '概览与设置' });
  const closeBtn = iconButton({ icon: 'close', label: '关闭', onClick: () => dialog.close(null) });

  /** 最近一次收到的数据：抽屉关着时只存不画（见 `update`），打开时用它补画一次。 */
  let lastSpec = null;

  const dialog = el('dialog', { class: 'drawer', 'aria-labelledby': 'drawer-title' }, [
    el('div', { class: 'drawer__inner' }, [
      el('div', { class: 'drawer__head' }, [title, closeBtn]),
      body,
    ]),
  ]);
  document.body.append(dialog);

  // ---- 各区块（只建一次，数据用 update 填）----
  // 顺序见文件末尾的 `body.append(...)`，那里写了"为什么是这个顺序"。

  // 活动趋势（明细）：概览带上的图是缩略，这里是能读出数字的那一份。
  //
  // 折成一行摘要 + `<details>`：它的信息（"最近有没有在用"）一句话就够，
  // 而十四根柱子要 333px —— 在一个总高 1536px、视口只有 833px 的抽屉里，
  // 把最占地方又最不常看的一块默认展开是不合理的。用原生 `<details>` 而不是自己做折叠：
  // 键盘可达、`aria-expanded` 语义、打印时的展开行为都由平台负责。
  const barsBox = el('div', { class: 'bars' });
  const activitySummary = el('summary', { class: 'details__summary' });
  const activitySection = el('details', { class: 'details' }, [activitySummary, barsBox]);

  // ② 视图偏好：每页条数 / 排序。
  //
  // **紧凑模式原先在这里，已移到列表头**（用户 2026-09-15 的要求）：
  // 它是"这一屏看起来什么样"的视图开关，而人们是在**看着列表**时产生"行太疏"的念头的。
  // 抽屉里只留一句指向它的说明 —— 不能两处都能改同一个设置：
  // 两处控件各自显示自己的状态，改了一处另一处不刷新，用户会以为设置没生效。
  const densityHint = el('span', { class: 'row__hint', text: '' });
  const pageSizeSelect = el('select', {
    class: 'control control--select',
    'aria-label': '每页条数',
    onchange: (event) => handlers.onSetPageSize(Number(event.target.value)),
  });
  for (const size of PAGE_SIZES) {
    pageSizeSelect.append(el('option', { value: String(size), text: `${size} 条` }));
  }

  const sortSelect = el('select', {
    class: 'control control--select',
    // 三个下拉都必须自己带可访问名：它们的"标签"是左侧的 `<span class="row__label">`，
    // 而 span 不是 `<label for>`，读屏只会念"组合框，创建时间"，用户不知道它在选什么。
    // （同文件的日期输入框都写了 `aria-label`，这三处此前漏了 —— 属于不一致而非有意。）
    'aria-label': '排序字段',
    onchange: (event) => handlers.onSort(event.target.value, orderSelect.value),
  });
  for (const field of SORT_FIELDS) {
    sortSelect.append(el('option', { value: field.value, text: field.label }));
  }
  const orderSelect = el('select', {
    class: 'control control--select',
    'aria-label': '排序方向',
    onchange: (event) => handlers.onSort(sortSelect.value, event.target.value),
  });
  orderSelect.append(
    el('option', { value: 'desc', text: '降序' }),
    el('option', { value: 'asc', text: '升序' }),
  );

  const viewSection = section('视图偏好', [
    row('每页条数', null, pageSizeSelect),
    row('排序', null, el('div', { class: 'row__control' }, [sortSelect, orderSelect])),
    row('行高', null, densityHint),
  ]);

  // ③ 自定义时间范围：只在选了「自定义…」时才有意义，故放在抽屉里而不是筛选条上
  const afterInput = el('input', { class: 'input', type: 'date', 'aria-label': '起始日期' });
  const beforeInput = el('input', { class: 'input', type: 'date', 'aria-label': '截止日期' });
  const applyRange = labelButton({
    label: '应用',
    className: 'btn btn--sm',
    onClick: () => {
      // `start` 边含当天 00:00、`end` 边到次日 00:00（不含）—— 与服务端 `CreateTime < before` 对齐。
      // 用 `end` 语义直接给「截止到今天」的话，今天 00:00 之后的记录会被整体漏掉。
      const after = fromDateInput(afterInput.value, 'start');
      const before = fromDateInput(beforeInput.value, 'end');
      handlers.onCustomRange(after, before);
      dialog.close(null);
    },
  });
  const rangeSection = section('自定义时间范围', [
    row('从', null, afterInput),
    row('到', null, beforeInput),
    row(null, '「到」包含当天整日（服务端的上界是开区间）', applyRange),
  ]);

  // ④ 保留策略：在线可调（Meta 覆盖优先、env 回落）。
  //    这里必须显示**来源** —— 否则用户改了这里却在想"为什么没生效"（值可能来自部署变量）。
  // 上下界与 `src/ui/maintenance.ts` 同值（那里按**分钟**，这里按**天** ⇒ 525600 / 1440 = 365）。
  // 写在客户端是为了让越界**在本地就说清**，而不是发出去换回一个 `invalid_request`（服务端仍是唯一裁判）。
  const RETENTION_DAYS_MAX = 365;
  const MAX_SAVED_HISTORY_COUNT_MAX = 1_000_000;
  const retentionInput = el('input', { class: 'input', type: 'number', min: '0', step: '1', max: String(RETENTION_DAYS_MAX), 'aria-label': '保留天数', 'aria-describedby': 'retention-status' });
  const maxCountInput = el('input', { class: 'input', type: 'number', min: '0', step: '1', max: String(MAX_SAVED_HISTORY_COUNT_MAX), 'aria-label': '最多保留条数', 'aria-describedby': 'retention-status' });
  // 渲染时记下两件"这一栏的当前状态"，保存路径要用：
  //   · `oddMetaMinutes` = Meta 里那种**用整天表示不出来**的分钟数（只有 V1 那份按分钟的输入写得出来，
  //     见 `public/ui_v1/js/components/info.js` 的「历史保留分钟数」）。用户没动「保留天数」时（留空）
  //     必须把原值**原样发回去** —— 发 null 的语义是"清除 Meta 覆盖"，会把用户设在 V1 的策略静默改成
  //     部署变量值，那正是本段注释反复警告的"静默改了配置"。
  //   · `retentionKnown` = 我们**知不知道**当前值（= `/ui/api/info` 取到过 retention）。不知道时保存
  //     既不能发 null（会清掉一条用户看不见的覆盖），也不能沿用旧值。
  let oddMetaMinutes = null;
  let retentionKnown = false;
  // `role="status"`：这一行同时是"当前生效值"的说明与**错误出口**（两个输入框的 `aria-describedby`
  // 目标），错误只改文字而不被播报的话，读屏用户听不到（与 `components.md` §2 的 error 格同一条要求）。
  const retentionSource = el('span', { class: 'row__hint', role: 'status', id: 'retention-status' });
  // ⚠️ 这个按钮**必须自己带文字**（2026-09-16 修的缺陷）：它原来是一个
  // `<button class="btn btn--sm btn--primary" data-icon="check"></button>` ——
  // 既没有文字、也没有图标子节点、还没有 `aria-label`，而 CSS 里也没有任何
  // `[data-icon]` 规则替它画一个图标。于是它在界面上只是一个 **26×28px 的蓝色小方块**，
  // 读屏则只会念"按钮"。而它是**唯一**能保存保留策略的入口：
  // 用户填完"保留天数"却找不到保存，只会认为这个设置根本改不了（实测截图确认）。
  // 教训：`.btn` 的图标不是靠 `data-icon` 属性画出来的，必须真的放进子节点。
  const saveRetention = labelButton({
    label: '保存保留策略',
    icon: 'check',
    className: 'btn btn--sm btn--primary',
    async onClick(button) {
      if (button.hasAttribute('data-loading')) return;
      // 每次尝试保存先清掉上一次的字段级标记（`aria-invalid` 不是"曾经错过"的历史记录）
      retentionInput.removeAttribute('aria-invalid');
      maxCountInput.removeAttribute('aria-invalid');
      // 只接受**非负整数字符串**。此前用的是裸 `Number.parseInt`，两种错法都能被用户自己填出来：
      //   · `1.5` → `parseInt` 得 1 ⇒ 用户以为存了 1.5 天，实际存了 1 天；
      //   · `e` / `1e3` → `NaN` ⇒ `NaN * 1440` 经 `JSON.stringify` 变成 **null**，
      //     而 null 的语义是"清除 Meta 覆盖"，与用户想做的**正好相反**（静默改了配置）。
      // V1 的 `components/info.js` 一直有这套校验（`/^\d+$/` + 越界就地提示），V2 此前漏了。
      const parseInteger = (input) => {
        const raw = input.value.trim();
        if (raw === '') return null;
        return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      };
      const days = parseInteger(retentionInput);
      const count = parseInteger(maxCountInput);
      const bounds = [
        ['保留天数', days, RETENTION_DAYS_MAX, retentionInput],
        ['最多条数', count, MAX_SAVED_HISTORY_COUNT_MAX, maxCountInput],
      ];
      const bad = bounds.find(
        ([, value, max]) => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > max),
      );
      if (bad) {
        // 说出**哪一栏**错，并把焦点送过去（这一段的错误只有一行文案，用户得自己找是哪个框）
        const [label, , max, input] = bad;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        retentionSource.textContent = `${label}只能填 0–${max} 之间的整数；空值的意思见下方说明。`;
        return;
      }
      setPending(button, true);
      try {
        // 空输入 = 清除覆盖（回落部署环境变量）；**0 是合法值**，含义是"关闭该阶段"。
        // 把空串当 0 会让"清除覆盖"变成"关掉清理" —— 语义正好相反（V1 的注释记过这个坑）。
        // 两条例外，都是"别在用户不知情时改他的配置"：
        //   ① `oddMetaMinutes` 非 null：Meta 里存着一个整天表示不出来的值 ⇒ 原样发回，不能清除；
        //   ② `retentionKnown` 为假（部署信息一次都没取到）：**省略该字段** —— 服务端把"缺省"
        //      理解为"不改动"（`src/ui/maintenance.ts:102`），发 null 会清掉一条用户看不见的覆盖。
        const payload = {};
        if (days !== null) payload.retentionMinutes = days * 1440;
        else if (retentionKnown) payload.retentionMinutes = oddMetaMinutes;
        if (count !== null) payload.maxSavedHistoryCount = count;
        else if (retentionKnown) payload.maxSavedHistoryCount = null;
        if (Object.keys(payload).length === 0) {
          // 一个字段都没得发（两栏都空 + 部署信息未知）：服务端会回 400，不如就地说明原因。
          retentionSource.textContent = '部署信息还没取到，暂时无法保存：先刷新一次再试。';
          return;
        }
        await handlers.onSaveSettings(payload);
      } finally {
        setPending(button, false);
      }
    },
  });
  const retentionSection = section('保留策略', [
    row('保留天数', '超过这个天数的未收藏、未置顶记录会被软删', retentionInput),
    row('最多条数', '超过后从最旧的开始软删', maxCountInput),
    row(null, null, saveRetention),
    retentionSource,
  ]);

  // ⑤ 清理状态（backend-gaps §1.1：这个可观测面此前无人消费）
  const cleanupFacts = el('div', { class: 'facts' });
  const cleanupSection = section('清理任务', cleanupFacts);

  // ⑥ 部署信息
  const deployFacts = el('div', { class: 'facts' });
  const copyLine = el('div', { class: 'copyline' });
  const deploySection = section('部署信息', [deployFacts, copyLine]);

  // ⑦ 维护
  const integrityBox = el('div', { class: 'facts' });
  const checkBtn = labelButton({
    label: '检查数据完整性',
    icon: 'check',
    className: 'btn btn--sm',
    async onClick(button) {
      if (button.hasAttribute('data-loading')) return;
      setPending(button, true);
      integrityBox.replaceChildren(el('p', { class: 'note', text: '正在检查…' }));
      try {
        const result = await handlers.onCheckIntegrity();
        paintIntegrity(result);
      } finally {
        setPending(button, false);
      }
    },
  });

  const clearTrashBtn = labelButton({
    label: '清空回收站',
    icon: 'trash',
    className: 'btn btn--sm',
    onClick: () => handlers.onClear('trash'),
  });

  const maintenanceSection = section('维护', [checkBtn, clearTrashBtn, integrityBox]);

  // 区块顺序 = **用户多久用一次**（2026-09-15 重排）。
  //
  // 原来把「活动趋势」放在第一位，而它占了整整 333px（视口只有 833px）—— 点开抽屉先看到
  // 一片图表，要滚很久才够到"每页条数""保留策略"这些真正会动手改的东西。实测各块高度：
  // 活动趋势 333 / 视图偏好 160 / 自定义时间范围 155 / 保留策略 232 / 清理任务 107 /
  // 部署信息 248 / 维护 109 = 总计 1536px。
  //
  // 现在的取舍：
  //   · **会动手改的在前**（视图偏好 → 自定义范围 → 保留策略），
  //   · **只看的在后**（活动趋势 → 清理任务 → 部署信息 → 维护），
  //   · 活动趋势折成一行摘要（`.details` + `<details>`），点开才展开图表 ——
  //     它的信息（"最近有没有在用"）一句话就够，而十四根柱子要 333px。
  body.append(
    viewSection,
    rangeSection,
    retentionSection,
    activitySection,
    cleanupSection,
    deploySection,
    maintenanceSection,
  );

  // 默认收起"自定义时间范围"（只有 range === 'custom' 时才展开）
  rangeSection.hidden = true;

  function paintIntegrity(result) {
    clear(integrityBox);
    if (!result) {
      integrityBox.append(el('p', { class: 'note note--warn', text: '检查失败（服务端未返回结果）。' }));
      return;
    }
    integrityBox.append(
      fact('检查时间', formatAbsolute(result.checkedAt)),
      fact('有数据的记录', String(result.recordsWithData)),
      fact('R2 对象数', String(result.historyObjects)),
      result.missingCount > 0
        ? fact('缺失数据', `${result.missingCount} 条`, 'warn')
        : fact('缺失数据', '无'),
    );
    if (result.missingCount > 0) {
      integrityBox.append(
        el('p', {
          class: 'note note--warn',
          text: `有 ${result.missingCount} 条记录的元数据声明有数据，但 R2 里找不到对应对象。列表里这些行会显示"数据缺失"。`,
        }),
      );
    }
  }

  /**
   * 只在**用户没有正在这个框里打字**时才回写。
   *
   * 为什么必须有：`paint()` 由 `renderChrome()` 驱动，而它**每 10 秒**（轮询）就会被调一次 ——
   * 抽屉开着、用户正在填「保留天数 / 最大条数 / 自定义起止日期」时，无条件赋值会把半成品
   * 覆盖回服务端的旧值 ⇒ 用户敲的东西**静默消失**，看起来像"填不进去"。
   * V1 对同一件事有这条守卫（`ui_v1/js/main.js` 的 `editing` 判据，注释写着"正在输入时不覆盖"），
   * V2 此前漏了（见 `docs/AUDIT-v1-v2-divergence.md` §1.1）。
   */
  function setInputValue(node, value) {
    if (document.activeElement === node) return;
    if (node.value !== value) node.value = value;
  }

  function paint(spec) {
  const { info, activity, filters, density, clockOffsetMs } = spec;

  // ---- 活动趋势 ----
  clear(barsBox);
  // **「还没取到」不是「没有活动」**：`activity === null` 表示还没取到（`refreshActivity` 失败时
  // 静默退出且不重试，见 `boot.js`），`[]` 才是"这段时间真的没有活动"（`docs/AUDIT-missing-states.md` §2.2）。
  // 把两者读成同一档，会把"取数失败"讲成"这台服务器从来没被用过"。
  const loaded = Array.isArray(activity);
  const days = loaded ? activity : [];
  // 摘要行：把"最近有没有在用"一句话说完，图表要展开才看（理由见上面区块声明处）
  const activeDays = days.filter((d) => Number(d.total) > 0).length;
  const sum = days.reduce((n, d) => n + (Number(d.total) || 0), 0);
  activitySummary.replaceChildren(
    el('span', { class: 'section__title', text: '活动趋势' }),
    el('span', {
      class: 'details__value',
      text: !loaded
        ? '尚未取到'
        : days.length === 0
          ? '还没有数据'
          : `近 ${days.length} 天 ${sum} 条 · ${activeDays} 天有记录`,
    }),
  );
  if (!loaded) {
    barsBox.append(el('p', { class: 'note', text: '活动数据还没取到，稍后会自己补上。' }));
  } else if (days.length === 0) {
    barsBox.append(el('p', { class: 'note', text: '还没有活动数据。' }));
  } else {
    const max = Math.max(1, ...days.map((d) => Number(d.total) || 0));
    // 柱子按**当天占比最高的类型**上色：`data-kind` 是 CSS 的判据（`overlay-v2.css` 的
    // `.bar__fill[data-kind=…]`），而服务端**每天都给了四个类型的计数**
    // （`readActivity` 的 `Text / Image / File / Group`）—— 此前前端一个都没读，
    // 于是那四条颜色规则从未生效过，所有柱子恒为强调色（`docs/AUDIT-missing-states.md` §3.2）。
    // 0 条的那天没有"主导类型"，不写 `data-kind`，落到 CSS 的基础色。
    const KINDS = ['Text', 'Image', 'File', 'Group'];
    const dominantOf = (day) => {
      let best = null;
      for (const kind of KINDS) {
        const n = Number(day[kind]) || 0;
        if (n > 0 && (best === null || n > best.n)) best = { kind, n };
      }
      return best;
    };
    // 只展示最近 14 天：抽屉里再长就读不完，完整曲线由概览带的缩略图承担
    for (const day of days.slice(-14)) {
      const value = Number(day.total) || 0;
      const dominant = dominantOf(day);
      const breakdown = KINDS.map((kind) => `${typeLabel(kind)} ${Number(day[kind]) || 0}`).join(' / ');
      barsBox.append(
        el('div', { class: 'bar', title: `${day.day ?? ''}：共 ${value} 条（${breakdown}）` }, [
          // `String(day.day ?? '')`：`day.day` 是服务端字段，格式异常时 `.slice` 会抛 TypeError，
          // 而它抛在 `paint()` 里 —— 整个抽屉的内容都画不出来。一个字段坏掉不该让整块面板空白
          // （`spark.js` / `overview.js` 对同一个字段都做了同样的防护）。
          el('span', { class: 'bar__label', text: String(day.day ?? '').slice(5) }),
          el('span', { class: 'bar__track' }, [
            el('span', {
              class: 'bar__fill',
              dataset: dominant ? { kind: dominant.kind } : {},
              style: { width: `${Math.round((value / max) * 100)}%` },
            }),
          ]),
          el('span', { class: 'bar__num', text: String(value) }),
        ]),
      );
    }
  }

  // ---- 视图偏好 ----
  // 行高**不在这里改**（开关在列表头），这里只如实报告当前状态并指出开关在哪。
  densityHint.textContent =
    density === 'compact'
      ? '紧凑（在列表右上角的 ☰ 按钮切换）'
      : '宽松（在列表右上角的 ☰ 按钮切换）';
  if (pageSizeSelect.value !== String(filters.pageSize)) pageSizeSelect.value = String(filters.pageSize);
  if (sortSelect.value !== filters.sort) sortSelect.value = filters.sort;
  if (orderSelect.value !== filters.order) orderSelect.value = filters.order;

  // ---- 自定义范围 ----
  if (filters.range === 'custom') {
    rangeSection.hidden = false;
    setInputValue(afterInput, toDateInput(filters.after));
    setInputValue(beforeInput, toDateInput(filters.before));
  } else {
    rangeSection.hidden = true;
  }

  // ---- 保留策略 ----
  const retention = info?.retention;
  if (retention) {
    // 分钟 → 天。两件事都在这里定：
    //   ① **只在能被整天整除时**才有整数天可回填（8641 分钟回填成 `"6.001"` 会被保存路径的
    //      `parseInteger` 拒掉；四舍五入成 6 又会**改变用户的配置**，两者都不能做）；
    //   ② **只回填来自 Meta 的值**。把部署变量/内置默认的生效值填进输入框，"什么都没改直接按保存"
    //      就会把它写成一条 Meta 覆盖 —— 等于把"跟随部署变量"静默冻结（V1 `components/info.js`
    //      的注释记过这个陷阱，V2 此前两个栏位都有）。生效值仍看得见，放在 placeholder 里。
    const isMeta = retention.retentionSource === 'meta';
    const minutes = retention.retentionMinutes;
    const wholeDays =
      typeof minutes === 'number' && minutes >= 0 && minutes % 1440 === 0 ? minutes / 1440 : null;
    setInputValue(retentionInput, isMeta && wholeDays !== null ? String(wholeDays) : '');
    const count = retention.maxSavedHistoryCount;
    setInputValue(
      maxCountInput,
      retention.maxCountSource === 'meta' && count !== null && count !== undefined ? String(count) : '',
    );
    retentionInput.placeholder =
      minutes === null || minutes === undefined ? '跟随部署变量' : `当前 ${minutes}`;
    maxCountInput.placeholder =
      count === null || count === undefined ? '跟随部署变量' : `当前 ${count}`;

    // 非整天数且**来自 Meta** 时，这个值必须被保住（保存时原样发回，见 `oddMetaMinutes` 的声明处）；
    // 来自部署变量时留空反而是对的（那里本来就是"跟随部署变量"）。
    const oddMinutes = typeof minutes === 'number' && minutes % 1440 !== 0 ? minutes : null;
    oddMetaMinutes = isMeta ? oddMinutes : null;
    // 这一栏的"空值"到底是什么意思，取决于**我们知不知道当前状态**（见保存路径）。
    retentionKnown = true;

    // 非整天数要如实报出：否则输入框是空的，用户会以为"没设置过"，而实际是他设过的值 —— 只是这一栏按天填不下它。
    const oddNote =
      oddMinutes === null
        ? null
        : isMeta
          ? `当前保留期是 ${oddMinutes} 分钟（此处设置的旧值，不是整天数）；这一栏留空 = 保持它不变，要清除请填 0 或整天数`
          : `当前保留期是 ${oddMinutes} 分钟（来自部署环境变量，不是整天数）；这一栏留空不影响它`;
    const sourceText = [
      `保留期来源：${sourceLabel(retention.retentionSource)}`,
      `条数上限来源：${sourceLabel(retention.maxCountSource)}`,
      oddNote,
      oddMetaMinutes === null
        ? '留空 = 清除这里的设置、回落到部署变量；填 0 = 关闭对应的清理阶段。'
        : '（保留期那一栏见上；条数上限留空 = 回落到部署变量、填 0 = 关闭条数裁剪。）',
    ]
      .filter((part) => part !== null)
      .join(' · ');
    retentionSource.textContent = sourceText;
  } else {
    // 取不到部署信息：把上一次的"已知状态"清掉 —— 否则保存会沿用一个已经过期的判断
    // （既可能静默保留旧值，也可能静默清除覆盖，见保存路径的两个分支）。
    oddMetaMinutes = null;
    retentionKnown = false;
    retentionInput.placeholder = '跟随部署变量';
    maxCountInput.placeholder = '跟随部署变量';
  }

  // ---- 清理状态 ----
  clear(cleanupFacts);
  const cleanup = info?.cleanup;
  if (!info) {
    // 部署信息**一次都没取到**：此时"清理任务跑过没有"是**未知**的。
    // 此前这里会落进下面那条断言，于是界面替服务器说"清理任务还没有运行过"——
    // 把"我不知道"说成"它没跑过"（`docs/AUDIT-missing-states.md` §2.2）。
    cleanupFacts.append(
      el('p', { class: 'note', text: '部署信息还没取到，暂时无法判断清理任务的状态。' }),
    );
  } else if (!cleanup || !cleanup.lastRunAt) {
    cleanupFacts.append(
      el('p', {
        class: 'note',
        text: '清理任务还没有运行过。它由 Cron 每 20 分钟触发一次，部署后一般很快就会有记录。',
      }),
    );
  } else {
    cleanupFacts.append(
      fact('上次运行', formatAbsolute(cleanup.lastRunAt)),
      cleanup.lastError
        ? fact('上次错误', cleanup.lastError, 'warn')
        : fact('上次错误', '无'),
    );
    const pending = Object.entries(cleanup.cursors ?? {}).filter(([, value]) => Number(value) > 0);
    cleanupFacts.append(
      pending.length > 0
        ? fact('未跑完', pending.map(([phase, value]) => `${phase} ${value}`).join(' · '))
        : fact('未跑完', '无'),
    );
  }

  // ---- 部署信息 ----
  //
  // **只放别处没有的**（2026-09-15 精简）。原先这里有五行：版本 / 存储占用 / 记录数 /
  // 时钟差 / 实时传输 —— 而前三个概览带上**已经**各有一个更大的数字，第四个顶栏的
  // 同步状态区也报了。同一份数据说两遍不会更清楚，只会让这一块多占 248px，
  // 把真正的设置挤到看不见的地方。
  // 保留：**服务器地址**（只有这里有，且可复制 —— 它是客户端配置要填的东西）、
  // 实时传输（排查"客户端连不上推送"时要看的）、以及**时钟差超限时**的那条警告
  // （它是"同步不动"最常见的根因，值得在设置面板里再说一次）。
  clear(deployFacts);
  const skew = describeClockSkew(clockOffsetMs);
  if (info) {
    const transports = (info.hubTransports ?? []).map((t) => t.transport).join(' / ');
    if (transports) deployFacts.append(fact('实时传输', transports));
    if (skew?.tone === 'warn') {
      deployFacts.append(fact('时钟差', skew.text, 'warn'));
      deployFacts.append(
        el('p', {
          class: 'note note--warn',
          text: '官方客户端在服务端与本机时钟差超过 5 分钟时会中止历史同步。请校准其中一侧的时钟。',
        }),
      );
    }
  }

  // 服务器地址：一键复制。客户端配置里填的就是这个。
  clear(copyLine);
  const url = info?.serverUrl ?? `${location.origin}/`;
  copyLine.append(
    el('span', { class: 'copyline__text', text: url }),
    iconButton({
      icon: 'copy',
      label: '复制服务器地址',
      // 复制成功的原地反馈交给 `flashOk`（对勾 → 1.6 秒后还原成本来的图标）
      onClick: async (button) => {
        if (await handlers.onCopyServerUrl(url)) flashOk(button);
      },
    }),
  );
  }

  return {
    el: dialog,

    /**
     * 收下最新状态。
     *
     * **抽屉没打开时只记住、不画**（2026-09-16 审计）：
     * `boot.js` 的 `renderChrome()` 每 10 秒的轮询都会调到这里，而它会 `clear()` + 重建
     * 活动趋势的 14 根柱子、清理任务与部署信息的两组 fact —— 实测**每轮刷新 88 次 DOM 变更**，
     * 全部发生在一个用户看不见的（`<dialog>` 未打开）子树上。值不值得省不是问题：
     * 那是纯粹的浪费，而且它让"每次刷新到底动了什么"变得难以判断。
     * 打开时（`open()`）用最后一份 spec 补画一次，因此不会看到过期内容。
     *
     * @param {{ info, activity, filters, density, clockOffsetMs }} spec
     */
    update(spec) {
      lastSpec = spec;
      if (!dialog.open) return;
      paint(spec);
    },

    open() {
      // 双击概览带会连发两次 `showModal()`：实测不会抛错，但会白建一次 Promise 与监听
      if (dialog.open) return Promise.resolve(null);
      if (lastSpec) paint(lastSpec);
      dialog.showModal();
      return new Promise((resolve) => {
        dialog.addEventListener('close', () => resolve(null), { once: true });
      });
    },

    /** 让「自定义时间范围」区块可见并把焦点送进第一个日期框（筛选条选了「自定义…」时调用）。 */
    focusRange() {
      rangeSection.hidden = false;
      afterInput.focus();
    },

    close: () => dialog.close(null),
  };

  /**
   * 真正把这批数据画上去。只在抽屉打开时调用（见 `update`）。
   */
}

// ===== 小构造器 =====

function section(titleText, content) {
  const node = el('div', { class: 'section' }, [el('h3', { class: 'section__title', text: titleText })]);
  for (const child of Array.isArray(content) ? content : [content]) node.append(child);
  return node;
}

function row(labelText, hintText, control) {
  const label = labelText
    ? el('span', { class: 'row__label' }, [
        el('span', { text: labelText }),
        hintText ? el('span', { class: 'row__hint', text: hintText }) : null,
      ])
    : hintText
      ? el('span', { class: 'row__label' }, [el('span', { class: 'row__hint', text: hintText })])
      : el('span', { class: 'row__label' });
  return el('div', { class: 'row' }, [label, control ?? el('span')]);
}

function fact(key, value, tone) {
  return el('div', { class: 'fact' }, [
    el('span', { class: 'fact__key', text: key }),
    el('span', { class: 'fact__value', text: value, 'data-tone': tone ?? null }),
  ]);
}

function sourceLabel(source) {
  return source === 'meta' ? '此处设置' : '部署环境变量';
}

