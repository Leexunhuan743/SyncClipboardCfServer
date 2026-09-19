// 竞态守卫：一次往返的「**最新请求胜出**」。从 V1 原样保留（逻辑已被测试覆盖）。
//
// 为什么必须有（V1 实测复现过）：列表与统计的响应可能**乱序到达**（慢的旧请求后落地），
// 而界面此时已按新筛选渲染。结果是「控件与 URL 说 Text，列表显示的是图片」——
// 拦截首个列表请求延迟 2.5s、120ms 内先后点「图片」「文本」：900ms 时列表正确，
// 3.5s 时迟到的图片响应把 46 行图片盖了上去，且之后不会自愈。
//
// 修复靠两条：① 发起新请求时 abort 上一个（顺带省掉一次 D1 读）；
// ② 序号不匹配的响应直接丢弃（abort 与响应到达可能同时发生，序号才是最终判据）。
//
// 独立成模块的原因：这是**纯逻辑**，能被测试直接覆盖；散在调用点则每一处都要重写一遍
// 「记得判断自己是不是最新的」——那正是它最初被漏掉的原因。
export function createLatestGate() {
  let seq = 0;
  let controller = null;

  return {
    /** 开一次请求：上一个请求被 abort，返回的 ticket 含本次序号与 signal。 */
    begin() {
      controller?.abort();
      controller = new AbortController();
      seq += 1;
      return { seq, signal: controller.signal };
    },

    /** 这个 ticket 是否仍是最新的一次。false ⇒ 调用方**必须**丢弃它的结果。 */
    isCurrent(ticket) {
      return ticket.seq === seq;
    },
  };
}
