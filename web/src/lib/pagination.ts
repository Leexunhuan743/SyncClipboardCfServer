// 分页的纯逻辑（视图在 views/pager.ts）。

/**
 * 页码窗口：始终含**前 3 页**、**后 2 页**与当前页前后各一页，中间用 `…` 折叠。
 * 前面留 3 页是因为最常翻的就是靠前的几页（最新的记录在前）；后面 2 页够到"最旧"那一端。
 * 被折叠的若只有一页，就直接显示这一页：一个 `…` 占的位置和一个页码一样，却什么也没告诉用户。
 */
export function pageWindow(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, 2, 3, pages - 1, pages, page - 1, page, page + 1]);
  const out: (number | '…')[] = [];
  let last = 0;
  for (let n = 1; n <= pages; n += 1) {
    if (!keep.has(n)) continue;
    if (n - last === 2) out.push(last + 1);
    else if (n - last > 2) out.push('…');
    out.push(n);
    last = n;
  }
  return out;
}
