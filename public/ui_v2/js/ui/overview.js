// 概览带：一条 60px 里放「一眼掌握」的四件事（场景 S3）。
//
// 设计取舍（docs/ui-v2-design.md §2 原则 3）：方案 B 的洞察在这里，但**只占一行** ——
// V1 用一张 3 格卡片吃掉 90px 却只放三个数字；V2 把同步状态、活动趋势、用量、类型分布
// 压进一条，细则（清理状态、保留策略、类型明细）点开进抽屉。
//
// 整条是一个 `<button>`：它的**唯一**动作是打开抽屉。里面不再嵌可点元素 ——
// 按钮里套按钮在 HTML 里是无效结构，读屏也会读成两个重叠的可交互区域。
// 故类型分布在这里是**展示**；筛选由筛选条的 chips 承担（那里才是正确的语义）。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { renderSpark, totalOf } from '../spark.js';
import { formatAgo } from '../format.js';

/**
 * @param {{ onOpenDrawer: () => void }} handlers
 */
export function createOverview({ onOpenDrawer }) {
  const root = el('button', {
    class: 'overview',
    type: 'button',
    // `id` 必须**自己带上**：HTML 里那个 `<button id="overview">` 只是**挂载点**，
    // `boot.js` 用 `replaceWith` 把它整个换掉（占位元素不该留在 DOM 里）。
    // 不带 id 的话，任何按 id 找它的地方（探针、深链接、将来的 e2e）都会拿到 null ——
    // 而"按钮看起来在屏幕上"会让这个问题完全不可见。实测：`probe.mjs` 因此打不开抽屉。
    id: 'overview',
    'aria-haspopup': 'dialog',
    'aria-label': '打开概览与设置',
    onclick: onOpenDrawer,
  });

  const totalValue = el('span', { class: 'overview__value', text: '—' });
  // 标签写「活跃记录」：这个数字是 `boot.js` 传下来的 `stats.activeCount`（**活跃**口径，
  // 与列表的"共 N 条"同一个数），**不含**回收站里的已删除行。
  // 回收站的量在抽屉里单独给，不占概览带的位置。
  // （此前这里写的是 `totalCount`，与 `boot.js` 的接线相反；`totalCount` 只出现在抽屉的
  //  存储明细里，两处口径不同是有意的。）
  const totalLabel = el('span', { class: 'overview__label', text: '活跃记录' });
  const totalStat = el('span', { class: 'overview__stat' }, [totalValue, totalLabel]);

  const syncValue = el('span', { class: 'overview__value' });
  const syncLabel = el('span', { class: 'overview__label', text: '最近同步' });
  const syncStat = el('span', { class: 'overview__stat' }, [syncValue, syncLabel]);

  const spark = el('span', { class: 'overview__spark' });

  const sizeValue = el('span', { class: 'overview__value' });
  const sizeLabel = el('span', { class: 'overview__label', text: '存储占用' });
  const sizeStat = el('span', { class: 'overview__stat' }, [sizeValue, sizeLabel]);

  /**
   * 可点提示：右端一个淡淡的 `›`。
   *
   * 为什么需要它：整条是一个 `<button>`（打开抽屉），但它长得完全像一个信息卡片 ——
   * 没有任何东西告诉用户"这里能点"。实测走查时我自己的第一反应也是"这是展示区"。
   * 顶栏那个 ⚙ 做同一件事，两个入口互相削弱（用户不知道它们通向同一个地方）。
   * 加了 `›` 之后语义与视觉一致了：**有箭头的地方就能点**。
   */
  const hint = el('span', { class: 'overview__hint', 'aria-hidden': 'true' }, [
    svg(iconPaths('chevronRight'), { size: 15 }),
  ]);

  // 类型分布**已从这里移除**（2026-09-15 第二轮）。
  //
  // 原先概览带右侧放了四个「文本 903 / 图片 17 / 文件 72 / 组合 17」，而筛选条的 chips
  // 同时显示着这四个数 —— 同一份数据在一屏里出现两遍，且第二遍（这里）**不可点**，
  // 于是它既不是信息（重复）也不是控件（点不了），纯粹是噪声。
  //
  // 保留的是 chips（它才是类型筛选的正确形态：可点、有 `aria-pressed`、计数与当前视图同源）。
  // 概览带空出来的位置留给"存储占用"——那是**只有这里有**的一个数字。
  root.append(
    totalStat,
    el('span', { class: 'overview__sep' }),
    syncStat,
    el('span', { class: 'overview__sep' }),
    spark,
    el('span', { class: 'overview__spacer' }),
    sizeStat,
    hint,
  );

  let current = { total: null, deletedCount: null, sizeBytes: null, lastSyncMs: null, activity: null };

  /**
   * 未加载时的占位。
   *
   * 为什么不是一个破折号「—」：不确定的时候给一条淡色的小骨架条，它同时表达了"这里将会有一个
   * 数字"和"还没到"；而破折号只能读成"取不到"。
   *
   * 本来还有一条更强的理由（"主数字是 24–30px，破折号在那个尺寸下是一条又粗又长的黑横杠"）——
   * 那条描述的是真事、但**不是现在**：2026-09-17 起 `.overview__value` 挂的是 `--fs-title`
   * （**17px**），2026-09-20 那个 `--fs-display` 令牌连同 `shell-v2.css` 里 `≤380px` 的
   * "数字降一档"一起删掉了（见 `docs/progress.md` §94.17）。所以骨架条在这里**只按它自己的
   * 理由**保留：它不靠字号大小成立。把它记成"设计意图 vs 实现的分歧"的那一轮见
   * `docs/AUDIT-missing-states.md` §5.3。
   */
  function placeholder() {
    return el('span', { class: 'overview__ghost', 'aria-hidden': 'true' });
  }

  function setValue(node, text) {
    // **只有内容真的变了才改 DOM**（2026-09-16 审计）：`renderChrome()` 每 10 秒的轮询都会
    // 调到这里，而概览带上的数字几乎每次都不变。无条件 `replaceChildren` 会替换掉整段子节点
    // （实测：每次刷新 20 次 DOM 变更），既浪费又让"这次刷新到底动了什么"难以判断。
    //
    // ⚠️ 判据不能写成 `const shown = node.dataset.value ?? null`（2026-09-18 修）：首次调用时
    // `dataset.value` 是 **`undefined`**（`dom.js` 的 `text` 只写 `textContent`），而首次传入的
    // `text` 也是 `null`（`renderChrome()` 先于 `/ui/api/overview` 落地）—— `undefined ?? null`
    // 与 `null` 相等 ⇒ **在 append(placeholder()) 之前就 return 了**，于是构造时写死的那个 `—`
    // 一直留到数据到达，而 `.overview__ghost` **一次都没被绘制过**（`placeholder()` 只在
    // "有值 → 又变回 null" 时才会走到，而 `stats` 从不写回 null）。
    // 见 `docs/AUDIT-missing-states.md` §1.3：那份设计文档把"未加载时给淡色骨架条"记成已修，
    // 实际是死代码 —— 与 V1 首屏骨架那次是同一个机制。
    const nextText = text === null || text === undefined ? null : String(text);
    const next = nextText ?? '';
    const shown = Object.hasOwn(node.dataset, 'value') ? node.dataset.value : undefined;
    if (shown === next) return;
    node.dataset.value = next;
    node.replaceChildren();
    if (nextText === null) node.append(placeholder());
    else node.append(el('span', { text: nextText }));
  }

  function paint() {
    const { total, deletedCount, sizeBytes, lastSyncMs, activity } = current;

    setValue(totalValue, total === null ? null : formatCount(total));

    // 回收站的量放在主数字的**标签行**里（那里是小字，不抢主数字的位置）。
    // 它是「活跃记录」这个数字的必要注脚：不说的话，用户会以为被删的记录不见了。
    const label = deletedCount ? `活跃记录 · 回收站 ${formatCount(deletedCount)}` : '活跃记录';
    if (totalLabel.textContent !== label) totalLabel.textContent = label;

    // 同步：给**相对时间**而不是时间戳。用户问的是"多久之前"，不是"几点几分"。
    const ago = lastSyncMs ? formatAgo(lastSyncMs) : null;
    setValue(syncValue, ago);

    setValue(sizeValue, sizeBytes === null ? null : formatSizeShort(sizeBytes));

    // 趋势：数据没到之前不画空图（空图会被读成"这段时间没有活动"，而事实是"还没加载"）。
    // 图只在**数据本身变了**时重画：它是 14 个 `<rect>`，重建一次的代价远大于比一次字符串。
    const sparkKey = activity && activity.length > 0 ? `${activity.length}:${totalOf(activity)}` : '';
    if (sparkKey !== spark.dataset.key) {
      spark.dataset.key = sparkKey;
      spark.replaceChildren();
      if (sparkKey) {
        spark.append(renderSpark(activity, { width: 132, height: 26 }));
        spark.title = `近 ${activity.length} 天：${totalOf(activity)} 条记录`;
      }
    }
  }

  return {
    el: root,

    update({ total, deletedCount, sizeBytes, lastSyncMs, activity }) {
      current = {
        total,
        deletedCount: deletedCount ?? current.deletedCount,
        sizeBytes,
        lastSyncMs,
        activity: activity ?? current.activity,
      };
      paint();
    },
  };
}

function formatCount(n) {
  if (!Number.isFinite(n)) return '—';
  return String(n);
}

/** 体积的短写：概览带上只有几十像素，`1.2 GB` 比 `1234.5 MB` 好读。 */
function formatSizeShort(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
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
