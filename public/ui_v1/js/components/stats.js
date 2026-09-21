// 统计条：三个真实数字（不是编造的指标）+ 一条明细行。
// 数据**有两个来源**：首屏走 `main.js` 的 `refreshOverview()`（`/ui/api/overview` 的合成快照，
// 一次往返带回 stats + byType + info + marker + serverTime），此后由 `refreshStats()`
// 补 `/ui/api/statistics`（切视图、写操作之后）。这里此前写着"全部来自 /ui/api/statistics"，
// 与首屏的实际路径相反。
//
// 形态（2026-09-17 重做）：三个「数字在上、标签在下」的格子 + 一条明细行（全库条数 · 活动趋势）。
// 旧版是三张 100px 高的卡片（合计 111px），把「最近一次同步」这类真正要读的内容推到首屏之外；
// 判据是量出来的：1440×900 下表格首行原本落在 y=357（39% 的视口被上方 chrome 吃掉）。
//
// 明细行只留两件事：
//   · 全库条数 —— 与「记录」格（活跃数）合起来才看得出库的规模；
//   · 活动趋势 —— 见 setActivity 的说明。
// 回收站入口与它的条数**不在这一行**（2026-09-17 用户指出）：工具栏已经有一个「回收站」按钮，
// 那条信息在那里是同一个入口的第二份；「30 天后彻底清除」属于保留策略，写在部署信息里。
//
// **不再列类型明细**（2026-09-17 用户指出两行冗余后删掉）。原因不是"重复"，而是"同标签两个数"：
// 统计条的明细按**恒活跃**口径（文本 795），工具栏的类型 chips 按**当前视图**口径
// （回收站视图下是文本 1590）—— 两个口径各自都对（服务端 `byType` / `byTypeActive` 就是这么分的），
// 但并排显示会被读成自相矛盾。按类型的分布属于「部署信息 → 按类型」，那里没有同屏对照。
import { el } from '../dom.js';
import { formatSize, formatRelative } from '../format.js';

// 时钟差的告警阈值：官方客户端在 |差| > 5 分钟时**中止历史同步**（docs/protocol.md）。
// 超过它就不是"一个数字"，而是"同步不动"的根因，故排障条上要变色。
const CLOCK_SKEW_WARN_SECONDS = 5 * 60;

// 趋势柱的高度上限（px）。与 `.stats__spark` 的 height 一致：柱高是**写死的像素**而不是百分比，
// 因为柱子的容器是 flex 行、每根柱的高度基准是容器高度而不是最大值 —— 用百分比要先知道容器高度，
// 而那个值在 CSS 里（18px）；把同一组数字写在两处迟早漂移。这里直接算像素，CSS 只管样式。
const SPARK_HEIGHT = 18;

function createStat(label) {
  const value = el('span', { class: 'stat__value' });
  const number = el('span');
  const unit = el('span', { class: 'stat__unit' });
  value.replaceChildren(number, unit);
  // 数字在上、标签在下。旧版是「标签居左 / 数字居右」的一行，在 1280px 的内容宽度里
  // 每格 426px —— 标签与它的数字相隔 ~350px，三格并排读不出「谁是谁的数字」。
  // 上下排布后数字自己成为视觉主体，三格的分隔线也不再是唯一的归属线索。
  const node = el('div', { class: 'stat' }, [value, el('span', { class: 'stat__label', text: label })]);
  return {
    node,
    set(numberText, unitText = '') {
      number.textContent = numberText;
      unit.textContent = unitText;
      // 空单位不留占位：`gap: 4px` 会让「20 KB」右侧多出 4px 的空隙，
      // 三格并排时这类 4px 就是"数字没有对齐"的来源。
      unit.hidden = unitText === '';
    },
  };
}

export function createStats() {
  const records = createStat('记录');
  const starred = createStat('已收藏');
  const storage = createStat('存储占用');
  const meta = el('div', { class: 'stats__meta' });
  // 趋势柱：近 N 天每天一条记录数（`/ui/api/activity` 借自 V2）。
  // 纯 CSS 柱而不是 SVG：零新模块、零依赖，高度用 CSSOM 写（CSP 只允许本站样式表）。
  const spark = el('span', { class: 'stats__spark' });
  // 柱子旁边必须有字：14 根小柱子单独放在行尾时，读者不知道它画的是天、是条、还是别的。
  // 这行字同时是它的单位说明（`aria-label` 里是完整口径，见 setActivity）。
  const sparkLabel = el('span', { class: 'stats__spark-label', text: '近 14 天新增' });
  // 初值 hidden：趋势是**附加信息**，取不到就不该占位（见 main.js 的 refreshActivity ——
  // 它失败时是静默的）。此前它的标签是常驻节点，于是「接口挂了」在界面上表现为
  // 一行「近 14 天新增」后面什么都没有 —— 一个没有图的图注。拿到数据才显示。
  const sparkWrap = el('span', { class: 'stats__spark-wrap', hidden: true }, [sparkLabel, spark]);
  // 排障面（2026-09-18）：最近一次同步 / 时钟差 / 清理状态。
  // 为什么放首屏：这三样是"同步不动"最常见的三个根因，而它们此前**只在**部署信息对话框里
  // （要用户主动点开、并且知道去那里找）。它们的数据来自每次轮询与首屏的合成快照，本就不额外花钱。
  const health = el('span', { class: 'stats__health' });

  const node = el('section', { class: 'stats', 'aria-label': '用量统计' }, [
    records.node,
    starred.node,
    storage.node,
    meta,
  ]);

  return {
    el: node,
    // 两个计数卡都随**当前视图**走（与工具栏的类型计数同一条约定：控件必须与列表同源）。
    // 此前它们恒取整个库的口径：回收站视图里卡片写「记录 67 条」而列表写着 69 条；
    // 活跃视图里卡片写「已收藏 12 条」，点开「收藏」筛选却只有 9 条（那 12 里混着回收站里的记录）。
    // 两个数都是**全表聚合**（活跃 / 回收站各一个，与取数时选的视图无关），故不存在
    // "这份响应属于哪个视图"的问题 —— 与 `main.js` 里 `countsForView` 的守卫不是一回事。
    update(stats, deleted = false) {
      if (!stats) return;
      records.set(String((deleted ? stats.deletedCount : stats.activeCount) ?? 0), '条');
      starred.set(String((deleted ? stats.starredCountDeleted : stats.starredCountActive) ?? 0), '条');

      storage.set(formatSize(Number(stats.totalFileSizeMB ?? 0) * 1024 * 1024));

      // 「全库」而不是「共」：结果区的头栏已经写着「共 N 条记录」（那是**当前视图**的条数），
      // 同一个"共"字配两个数照样会被读成矛盾。
      const total = el('span', { class: 'stats__total', text: `全库 ${stats.totalCount ?? 0} 条` });
      // 回收站**不在这里再列一次**（2026-09-17 用户指出）：工具栏已经有一个「回收站」按钮，
      // 这里是同一条信息的第二个入口，而它后面那句"30 天后清除"属于保留策略
      // （部署信息 → 保留策略里已经写着）。这一段只留结果区头栏读不出来的那个数。
      // sparkWrap 是**常驻节点**（柱子的内容由 setActivity 单独填），故每次都重新挂上它
      meta.replaceChildren(total, health, sparkWrap);
    },

    /**
     * 排障面：最近一次同步、本机与服务端的时钟差、清理任务的状态。
     *
     * 三样都**有就显示、没有就整条不显示** —— 观测值要等第一次轮询/快照，
     * 新部署的实例也可能还没跑过清理；画一个"尚未观测到"只会让首屏多一句噪音。
     * 超过阈值的那两项（时钟差 > 5 分钟、清理上次失败）换成警示色，并把原因放进 title。
     */
    setHealth({ lastChangeMs = null, clockOffsetMs = null, cleanup = null } = {}) {
      const parts = [];
      if (Number.isFinite(lastChangeMs) && lastChangeMs > 0) {
        parts.push(
          el('span', {
            class: 'stats__health-item',
            text: `最近同步 ${formatRelative(new Date(lastChangeMs).toISOString())}`,
            title: `服务端最新一条记录的修改时间：${new Date(lastChangeMs).toLocaleString('zh-CN')}`,
          }),
        );
      }
      if (Number.isFinite(clockOffsetMs)) {
        const seconds = Math.round(clockOffsetMs / 1000);
        const skew = Math.abs(seconds);
        const warn = skew > CLOCK_SKEW_WARN_SECONDS;
        parts.push(
          el('span', {
            class: `stats__health-item${warn ? ' stats__health-item--warn' : ''}`,
            text: `时钟差 ${skew} 秒`,
            title: warn
              ? '与本机相差超过 5 分钟：官方客户端会因此中止历史同步，先校准两边的系统时间（详见「部署信息」）'
              : '本机与服务器的时间差：官方客户端在 |差| > 5 分钟时会中止历史同步',
          }),
        );
      }
      if (cleanup?.lastError) {
        parts.push(
          el('span', {
            class: 'stats__health-item stats__health-item--warn',
            text: '清理任务上次失败',
            title: `清理失败：${cleanup.lastError}（详见「部署信息」→ 清理任务）`,
          }),
        );
      } else if (cleanup?.lastRunAt) {
        parts.push(
          el('span', {
            class: 'stats__health-item',
            text: '清理正常',
            title: `最近一次清理：${new Date(cleanup.lastRunAt).toLocaleString('zh-CN')}`,
          }),
        );
      }
      health.replaceChildren(...parts);
      health.hidden = parts.length === 0;
    },

    /**
     * 活动趋势。数据来自 `/ui/api/activity`：`{ days: [{day,total,…}], max }`。
     *
     * 它回答的是统计条另外三个数字回答不了的问题：「最近是怎么涨上来的」。
     * 空白日**也画柱子**（最矮的一档、灰色）——把没有活动的日子抽掉，会让两段分开的日子看起来
     * 像连续的，趋势图就从"事实"变成"印象"了。
     */
    setActivity(activity) {
      const days = activity?.days ?? [];
      if (days.length === 0) {
        sparkWrap.hidden = true;
        return;
      }
      const max = Math.max(1, Number(activity.max) || 1);
      spark.replaceChildren(
        ...days.map((day, index) => {
          const total = Number(day.total) || 0;
          const bar = el('span', { class: 'spark__bar' });
          // 0 条也保留 2px：一条 0 高的柱子在视觉上等于"这天不存在"
          bar.style.height = `${total > 0 ? Math.max(3, Math.round((total / max) * SPARK_HEIGHT)) : 2}px`;
          if (total === 0) bar.dataset.zero = 'true';
          if (index === days.length - 1) bar.dataset.today = 'true';
          return bar;
        }),
      );
      const total = days.reduce((sum, day) => sum + (Number(day.total) || 0), 0);
      const label = `近 ${days.length} 天新增记录趋势：共 ${total} 条，单日最多 ${max} 条`;
      spark.setAttribute('role', 'img');
      spark.setAttribute('aria-label', label);
      spark.setAttribute('title', label);
      sparkWrap.hidden = false;
    },
  };
}
