// 分页的纯逻辑（视图在 views/pager.ts）。

/** 页码窗口：始终含首尾页与当前页前后各一页，中间用 `…` 折叠。 */
export function pageWindow(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1]);
  const out: (number | '…')[] = [];
  let last = 0;
  for (let n = 1; n <= pages; n += 1) {
    if (!keep.has(n)) continue;
    if (n - last > 1) out.push('…');
    out.push(n);
    last = n;
  }
  return out;
}

