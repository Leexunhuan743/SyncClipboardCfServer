// 面向用户的**文案**：把"说什么"从"怎么做"里分出来。
//
// 为什么值得单独一个模块（2026-09-16 审计的 A-38）：这些句子不是装饰，它们**逐字对齐了实现语义**，
// 写错的代价是误导用户做决定。最典型的是删除确认：
//   · 带数据文件的记录 —— 软删时服务端**立即清掉 R2 数据文件**（不可恢复），只有元数据留 30 天；
//   · 内联文本 —— 内容就在那一行里，30 天内可以从回收站恢复。
// 两者写成同一句话，要么让前者的用户以为"内容还在"（错），要么让后者的用户白白放弃一次可用的恢复。
// 句子放在这里之后，`test/ui-logic.test.ts` 可以**直接断言这些语义**，
// 而不是靠人去读 `boot.js` 里那一段被包在请求逻辑中间的字符串。
//
// 本模块**不碰 DOM、不碰网络、不碰状态**：入参是数据，出参是字符串。
import { typeLabel, truncateText } from './format.js';

/** 删除确认里"删的是哪一条"：文本给正文开头，其余给文件名/类型名。 */
function describeTarget(item) {
  if (item.type === 'Text') {
    // 按**字符**截而不是码元（2026-09-18 修）：`slice(0, 40)` 落在代理对中间时会留下半个
    // 字符，确认框里渲染成 `�`。这一整段在两版之间逐字一致（见文件头的对等守卫）。
    const text = truncateText(item.text ?? '', 40);
    return `「${text}…」`;
  }
  return `「${item.dataName ?? typeLabel(item.type)}」`;
}

/**
 * 单条删除的确认框文案。
 * @param {{ type: string, text?: string, dataName?: string, hasData?: boolean }} item
 * @returns {{ title: string, message: string, confirmLabel: string }}
 */
export function deleteConfirmSpec(item) {
  // 2026-09-22（ADR D29）：删除**不再**立即清数据文件 —— 回收站保留 30 天、期间可恢复（数据文件
  // 一并保留），想立刻清字节要用回收站里的「彻底删除」。于是这一句**不再按 hasData 分叉**：
  // 两种情况现在都能拿回来，而"能不能拿回来"正是用户按这个按钮前唯一要知道的事。
  return {
    title: '删除这条记录？',
    message: `将删除 ${describeTarget(item)}。所有同步设备上的这条记录也会被删除；30 天内可以从回收站恢复（数据文件同样保留），之后自动彻底清除。`,
    confirmLabel: '删除',
  };
}

/**
 * 批量删除的确认框文案。
 * @param {number} count
 */
export function batchDeleteConfirmSpec(count) {
  return {
    title: `删除选中的 ${count} 条记录？`,
    message:
      '所有同步设备上的这些记录也会被删除；30 天内可以从回收站恢复（数据文件同样保留），之后自动彻底清除。',
    confirmLabel: `删除 ${count} 条`,
  };
}

/**
 * 「彻底删除」的确认框文案（回收站里那条不可恢复的出口）。
 *
 * 与 `deleteConfirmSpec` 的差别必须说清：软删是「进回收站、30 天内还能捞回来」，
 * 彻底删除是「服务器上不再有这一行」。带数据文件的记录在软删那一刻数据就已经清了，
 * 所以这里更彻底掉的只是元数据行 —— 但仍要标「不可撤销」，因为连那一行也没了。
 * @param {{ type: string, text?: string, dataName?: string, hasData?: boolean }} item
 */
export function purgeConfirmSpec(item) {
  return {
    title: '彻底删除这条记录？',
    message: `将从服务器永久删除 ${describeTarget(item)}（元数据行）—— 回收站里也不会再出现，此操作不可撤销。`,
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
    message: '这些记录会从服务器永久删除（元数据行），回收站里也不会再出现。此操作不可撤销。',
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
 * 编辑保存成功后的**就地说明**：对话框**不关**，正文换成刚保存的那一段（ADR D30 的 Q3=c）。
 * 必须说明"这是一条新记录、原来那条还在" —— 编辑的语义是新建（正文一改 hash 就变），
 * 不写清楚用户会以为旧的那条被改掉了。
 * @param {number} chars
 */
export function textSavedNote(chars) {
  return `已保存为一条新记录（${chars} 个字符）。原来那条仍在历史里，列表已刷新。`;
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
