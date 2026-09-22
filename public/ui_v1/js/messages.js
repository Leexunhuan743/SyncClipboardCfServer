// 面向用户的**文案**（V1 / 产品面）：把"说什么"从"怎么做"里分出来。
//
// 这些句子不是装饰，它们**逐字对齐了实现语义**，写错的代价是误导用户做决定。最典型的是两个动作的名字：
//   · 移动到回收站（软删）—— 进回收站，30 天内**连数据文件一起**可以恢复（2026-09-22 ADR D29 起；
//     此前软删会立即清掉 R2 数据文件，于是图片/文件的"回收站"其实是单向门）；
//   · 彻底删除 / 30 天硬删 —— D1 行与它的数据目录**立刻**都没了，不可撤销。
// 两者写成同一句话，要么让前者的用户以为"内容还在"（错），要么让后者的用户白白放弃一次可用的恢复。
// ⚠️ 这两句里的"数据文件"三个字是**承重**的：ADR D29 恰好改动过它，改文案前先读 `docs/protocol.md` §10。
// 提成独立模块之后，`test/ui-logic.test.ts` 可以**直接断言这些语义**，
// 而不是靠人去读 `main.js` 里那一段被包在请求逻辑中间的字符串。
//
// ## 为什么 V1 自己有一份（而不是去 import V2 的）
//
// V1（`public/ui_v1/`）是**默认界面/产品面**，必须完全自包含：V2（`public/ui_v2/`）是开发测试版、
// 可能被破坏性重构甚至删除，产品面不得依赖它（`test/ui-guard.test.ts` 的"V1 不跨目录依赖 public/ui"
// 守卫就是这条）。因此这份文件是 V1 自己的副本，而**不是**共享模块。
//
// ## 这份副本的守卫（很重要，别删）
//
// 自包含的代价是"两份必然漂移"，而这里漂移的后果是**删除语义被写错**。
// `test/ui-guard.test.ts` 有一条对等守卫：`V1 的 messages.js` 与 `V2 的 messages.js` 的函数体
// 必须逐字一致（V2 真被删掉时，连同那条守卫一起删）。改文案时**两版都要改**，守卫会告诉你漏了哪边。
//
// 本模块**不碰 DOM、不碰网络、不碰状态**：入参是数据，出参是字符串。
import { typeLabel, truncateText } from './format.js';

/** 「移动到回收站」的确认里"动的是哪一条"：文本给正文开头，其余给文件名/类型名。 */
function describeTarget(item) {
  if (item.type === 'Text') {
    // 按**字符**截而不是码元（2026-09-18 修）：`slice(0, 40)` 落在代理对中间时会留下半个
    // 字符，确认框里渲染成 `�`。这一整段在两版之间逐字一致（见文件头的对等守卫）。
    // 先 `trim()` 再判空：**空文本与"只含空白"的文本在确认框里必须看得出来** ——
    // 直接把原串嵌进引号会渲染成「「   …」」，用户根本不知道自己要动的是哪一条
    // （列表里同一个位置写的是「（空文本）」，`format.js` 的 `previewText` 做的正是这个 trim）。
    // 2026-09-22 发布前审核第 8 轮实测：一个纯空白记录（12 个空格/制表/换行）的确认框就是这样。
    const text = truncateText(item.text ?? '', 40).trim();
    if (text === '') return '「（空文本）」';
    return `「${text}…」`;
  }
  return `「${item.dataName ?? typeLabel(item.type)}」`;
}

/**
 * 单条「移动到回收站」的确认框文案。
 * @param {{ type: string, text?: string, dataName?: string, hasData?: boolean }} item
 * @returns {{ title: string, message: string, confirmLabel: string }}
 */
export function deleteConfirmSpec(item) {
  // 2026-09-22（ADR D29）：软删**不再**立即清数据文件 —— 回收站保留 30 天、期间可恢复（数据文件
  // 一并保留），想立刻清字节要用回收站里的「彻底删除」。于是这一句**不再按 hasData 分叉**：
  // 两种情况现在都能拿回来，而"能不能拿回来"正是用户按这个按钮前唯一要知道的事。
  // ⚠️ **这个动作的名字是「移动到回收站」，不是「删除」**（2026-09-22 用户定案）：同一个界面里
  // 「删除」二字必须只指那件不可撤销的事（`purgeConfirmSpec` 的「彻底删除」），否则用户没法从
  // 按钮上判断按下去还能不能后悔。措辞与 `list.js` 的行内动作、选择条、`preview.js` 的页脚逐字一致。
  return {
    title: '把这条记录移动到回收站？',
    message: `把 ${describeTarget(item)} 移动到回收站。所有同步设备上的这条记录也会消失；30 天内可以从回收站恢复（数据文件同样保留），之后自动彻底清除。`,
    confirmLabel: '移动到回收站',
  };
}

/**
 * 批量「移动到回收站」的确认框文案。
 * @param {number} count
 */
export function batchDeleteConfirmSpec(count) {
  return {
    title: `把选中的 ${count} 条记录移动到回收站？`,
    message:
      '所有同步设备上的这些记录也会消失；30 天内可以从回收站恢复（数据文件同样保留），之后自动彻底清除。',
    confirmLabel: `移动到回收站 ${count} 条`,
  };
}

/**
 * 「彻底删除」的确认框文案（回收站里那条不可恢复的出口）。
 *
 * 与 `deleteConfirmSpec` 的差别必须说清：软删是「进回收站、30 天内**连数据一起**捞得回来」，
 * 彻底删除是「D1 行与它的数据目录**立刻**都没了、不可撤销」（ADR D29 起软删不再清数据，
 * 「彻底」二字如今多的正是那份数据）。
 * @param {{ type: string, text?: string, dataName?: string, hasData?: boolean }} item
 */
export function purgeConfirmSpec(item) {
  return {
    title: '彻底删除这条记录？',
    message: `将从服务器永久删除 ${describeTarget(item)}（元数据行及其数据文件）—— 回收站里也不会再出现，此操作不可撤销。`,
    confirmLabel: '彻底删除',
  };
}

/**
 * 批量「彻底删除」的确认框文案。
 * @param {number} count
 */
export function batchPurgeConfirmSpec(count) {
  return {
    title: `彻底删除选中的 ${count} 条记录？`,
    message: '这些记录会从服务器永久删除（元数据行及其数据文件），回收站里也不会再出现。此操作不可撤销。',
    confirmLabel: `彻底删除 ${count} 条`,
  };
}

/**
 * 批量操作的**进度**文案：写进确认框的正文，替下原来那段静态说明。
 * @param {number} done 已完成批数（客户端按 100 条一批）
 * @param {number} total 批数合计
 */
export function batchProgressText(done, total) {
  return `正在处理第 ${done} / ${total} 批…`;
}

/**
 * 批量操作**部分未生效**时的说明。
 *
 * 为什么不叫"失败"：批量是服务端**逐条**判定的，落空通常只是那几条被别的设备改过、或已经删了，
 * 而其余几十条已经生效。原文案「有 N 条未生效」读起来像整体失败，用户会白重做一遍。
 * @param {number} updated
 * @param {number} failed
 */
export function batchPartialText(updated, failed) {
  return `已生效 ${updated} 条，未生效 ${failed} 条（通常是那几条已被其它设备或本页其它标签页删掉/改过，列表已刷新）。`;
}

/**
 * 用户**中止**长批量时的说明。
 *
 * 与 `batchPartialText` 的区别：那不是失败、也不是被服务端拒绝，而是用户在途按了「中止」——
 * 已经发出去的那一批会跑完（服务端一次请求内部不会被打断），后面的批次不再发。
 * 所以措辞要让人知道"停下来了、停下之前生效了多少"。
 * @param {number} done 已生效条数
 */
export function batchAbortedText(done) {
  return `已中止：停下之前已生效 ${done} 条（列表已刷新）。`;
}

/**
 * 「编辑」按钮在正文过大时的**禁用说明**（不是错误，是"这条为什么点不动"）。
 * @param {string} limit 人类可读的上限（如 `1 MB`）
 */
export function editTooLargeText(limit) {
  return `正文超过 ${limit}，在浏览器里编辑会卡住；请用「下载文本」在本地编辑。`;
}

/**
 * 编辑保存成功后的提示条文案（对话框**不关**，正文换成刚保存的那一段，ADR D30 的 Q3=c）。
 * 长度按提示条写（2.6s 内读完一行）：编辑的语义是**新建**（正文一改 hash 就变），
 * 说明这一点就够 —— "原来那条仍在历史里""列表已刷新"是用户在列表里一眼可见的事实，
 * 塞进提示条只会让它在读完之后还占着屏幕底部。
 * @param {number} chars
 */
export function textSavedNote(chars) {
  return `已保存为新记录（${chars} 个字符）`;
}

/**
 * 编辑保存失败时的就地说明（挨着控件、不靠提示条 —— `components.md` 的 error 格）。
 *
 * `reason` 是**一句话的片段**：服务端给的是光秃秃的细节（`text_too_large` 或
 * `1048577 字节，上限 1048576`），而界面自己编的那几条（例如 `api.js` 的「服务器返回了无法读取的数据，
 * 请刷新后重试。」）**自带句号** —— 不剥掉就会渲染成「…重试。。你改的内容还在这」。
 * 故这里统一把结尾的句号去掉一个（那些句子在别处要独立成句，不能改成不带句号的写法）。
 * @param {string} reason 服务端/网络给的原因
 */
export function textSaveFailedText(reason) {
  const detail = String(reason ?? '').replace(/。\s*$/, '');
  return `保存失败：${detail}。你改的内容还在这，可以改完再存一次。`;
}

/**
 * 清空历史的确认框文案。
 * @param {'trash'|'all'} scope
 */
export function clearHistorySpec(scope) {
  const label = scope === 'trash' ? '清空回收站' : '清空全部历史';
  const message =
    scope === 'trash'
      ? '回收站里的记录会被永久删除（D1 行 + 数据目录）。此操作不可撤销。'
      : '所有历史记录会被永久删除（D1 行 + R2 数据目录），当前剪贴板内容不受影响。此操作不可撤销。';
  return { label, title: `${label}？`, message, confirmLabel: label };
}

/**
 * 列表错误的**人话翻译**。
 *
 * 400 基本只有一个来源：搜索词超过服务端上限（48 字节，约 16 个汉字）。
 * 直接把服务端的校验串给用户看会得到「SearchText must be at most 48 bytes」这种文案。
 *
 * @param {{ status?: number, message?: string }|null} error
 * @param {string} search 当前搜索词（用来判断 400 是不是搜索引起的）
 */
export function describeListError(error, search) {
  if (error?.status === 400 && search !== '') {
    return '搜索词过长：服务端上限 48 字节（约 16 个汉字），缩短后再试';
  }
  if (error?.status === 400) return `筛选条件不被服务端接受：${error.message}`;
  // 429 = 认证失败限速（src/rateLimit.ts：窗口内失败到阈值就封锁）。服务端的响应体是纯文本
  // （`Too Many Requests`），真正有用的信息在 `Retry-After` 头里（`src/auth.ts` 的 tooManyRequests），
  // 而 `api.js` 已把它带进 `error.retryAfterSeconds`。不看这一条，用户会对着英文猜还要等多久。
  if (error?.status === 429) {
    const seconds = Number(error.retryAfterSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return '请求过于频繁，请稍后再试。';
    if (seconds < 60) return `请求过于频繁：请在 ${seconds} 秒后重试。`;
    return `请求过于频繁：请在约 ${Math.ceil(seconds / 60)} 分钟后重试。`;
  }
  return `无法读取历史记录：${error?.message ?? '未知错误'}`;
}

/**
 * 剪贴板写入失败时的「原因」那一句。
 *
 * 这个仓库里有**两处**会写剪贴板（复制记录正文、复制服务器地址），而它们原来各写了一句含糊的
 * "浏览器拒绝了剪贴板访问，请手动复制"。实测的真相是：失败的绝大多数发生在**站点跑在 http
 * （局域网 IP）** 时 —— `navigator.clipboard` 只在安全上下文（https / localhost）存在，
 * 回退路径 `document.execCommand('copy')` 也已被浏览器逐步禁用。
 * 用户看到"拒绝了访问"只会以为是自己点错了，于是反复点。
 * 说清"不是 https"这一条，用户才可能去想"那我换个地址访问"或"手动复制"。
 *
 * @param {boolean} secureContext `window.isSecureContext`
 * @param {string} retreat 该处**具体的**退路（"在哪、怎么做"），由调用方给
 */
export function clipboardFailureHint(secureContext, retreat) {
  return secureContext
    ? `浏览器拒绝了剪贴板权限。${retreat}`
    : `这个页面不是 https，浏览器不允许网页直接写剪贴板。${retreat}`;
}
