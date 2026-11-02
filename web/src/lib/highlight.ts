// 搜索命中高亮：把一段文本按搜索词切成 [{text, hit}]。纯函数，视图拿它逐段建节点
// （命中段包进 <mark>，其余走 textContent —— 用户内容永远不经过 innerHTML）。

export interface Segment {
  text: string;
  hit: boolean;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 切段。大小写不敏感；空搜索词返回单个未命中段。
 * 命中段数封顶（`maxHits`）：一个很短的词（"a"）在 500 字的正文里能命中几百次，
 * 建几百个 <mark> 没有意义，封顶后剩下的当普通文本。
 */
export function highlightSegments(text: string, term: string, maxHits = 24): Segment[] {
  const needle = term.trim();
  if (needle === '' || text === '') return [{ text, hit: false }];
  const pattern = new RegExp(escapeRegExp(needle), 'giu');
  const out: Segment[] = [];
  let last = 0;
  let hits = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0] === '') continue;
    if (start > last) out.push({ text: text.slice(last, start), hit: false });
    out.push({ text: match[0], hit: true });
    last = start + match[0].length;
    hits += 1;
    if (hits >= maxHits) break;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}

/**
 * 卡片里只显示正文的开头几行：命中如果出现在很靠后的位置，用户看到的就是一段"没有命中"的文字。
 * 所以第一处命中离开头超过 `lead` 个字符时，从命中前 `lead` 个字符处开始截取并加省略号。
 */
export function excerptAround(text: string, term: string, lead = 48): string {
  const needle = term.trim();
  if (needle === '') return text;
  const index = text.search(new RegExp(escapeRegExp(needle), 'iu'));
  if (index <= lead * 2) return text;
  let start = index - lead;
  // 别把代理对从中间劈开（会留下一个孤立的低位代理，显示成 �）
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return `…${text.slice(start)}`;
}
