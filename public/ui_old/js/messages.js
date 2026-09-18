// 面向用户的**文案**（V1 / 产品面）：把"说什么"从"怎么做"里分出来。
//
// 这些句子不是装饰，它们**逐字对齐了实现语义**，写错的代价是误导用户做决定。最典型的是删除确认：
//   · 带数据文件的记录 —— 软删时服务端**立即清掉 R2 数据文件**（不可恢复），只有元数据留 30 天；
//   · 内联文本 —— 内容就在那一行里，30 天内可以从回收站恢复。
// 两者写成同一句话，要么让前者的用户以为"内容还在"（错），要么让后者的用户白白放弃一次可用的恢复。
// 提成独立模块之后，`test/ui-logic.test.ts` 可以**直接断言这些语义**，
// 而不是靠人去读 `main.js` 里那一段被包在请求逻辑中间的字符串。
//
// ## 为什么 V1 自己有一份（而不是去 import V2 的）
//
// V1（`public/ui_old/`）是**默认界面/产品面**，必须完全自包含：V2（`public/ui/`）是开发测试版、
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
  const after = item.hasData
    ? '服务端会立即清除数据文件（不可恢复），仅元数据保留 30 天后彻底清除。'
    : '这条记录没有数据文件，30 天内还能从回收站恢复。';
  return {
    title: '删除这条记录？',
    message: `将删除 ${describeTarget(item)}。所有同步设备上的这条记录也会被删除；${after}`,
    confirmLabel: '删除',
  };
}

/**
 * 批量删除的确认框文案。逐条差异（哪些带数据文件）在批量场景下无法一一列举，
 * 故这里把两种后果**都说出来**，而不是只挑一种。
 * @param {number} count
 */
export function batchDeleteConfirmSpec(count) {
  return {
    title: `删除选中的 ${count} 条记录？`,
    message:
      '所有同步设备上的这些记录也会被删除。带数据文件的记录会立即清除数据文件（不可恢复），仅元数据保留 30 天；内联文本 30 天内可从回收站恢复。',
    confirmLabel: `删除 ${count} 条`,
  };
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
