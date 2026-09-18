// 协议路径的**字面段**大小写归一（对齐 ASP.NET Core 的路由匹配）
//
// 上游是 ASP.NET Core：它的 endpoint 路由对**字面段**用 OrdinalIgnoreCase 匹配
// （`GET /API/version`、`/SyncClipboard.JSON`、`/api/history/Statistics`、`POST /SYNCCLIPBOARDHUB/negotiate`
// 全部命中并返回 200），而 Hono 的路径匹配是精确的（区分大小写）⇒ 同一批请求在本实现上会 404/400。
// 2026-09-15 用官方 v3.2.0 服务端发布件 A/B 实测确认（见 docs/progress.md §44），本模块是那次实测的修复。
//
// 设计约束（改动时务必保持）：
//   1. **只归一"上游确实存在字面路由"的那些位置**，其余段一律原样透传。因为
//      `/file/{fileName}` 与 `/api/history/{profileId}` 的**取值语义必须保留大小写**：
//      `/file/Statistics` 是一个名为 "Statistics" 的文件，归一成 `statistics` 就会查错对象。
//      这正是"部分不区分"比"全都不区分"更安全的原因。
//   2. 覆盖范围**只到协议面**：`/ui/*` 与静态资源不在其列 —— 静态资源由 Cloudflare 直接托管、
//      根本不经过 Worker（`[assets] directory = "./public"`，见 wrangler.toml），而 `/ui/api/*`
//      是我们自己的面、上游无参系物（用户 2026-09-15 决策：只修协议面）。
//   3. **表漏项必须能被测试发现**：`test/protocol.test.ts` 有一条守卫遍历 `app.routes`，断言协议面
//      每一个字面段都落在本表覆盖的位置上；新增端点若引入新的字面段而忘记登记，守卫会红。

// 位置（`path.split('/')` 的索引，1 起）→ 该位置上可被归一的字面段，**写法即路由里的真实写法**
// （注意 `SyncClipboard.json` / `SyncClipboardHub` 是大小写混合：归一必须还原成这个写法，
//   而不是统统转小写——路由表是精确匹配，转小写反而 404）
const SEGMENT_1: readonly string[] = ['api', 'file', 'SyncClipboard.json', 'SyncClipboardHub'];
const SEGMENT_2: readonly string[] = ['version', 'time', 'history', 'negotiate'];
const SEGMENT_3: readonly string[] = ['statistics', 'query', 'clear'];
// `/api/history/{profileId}/data` 的 `data`（上游 `[HttpGet("api/history/{profileId}/data")]` 同样不区分大小写）
const SEGMENT_4: readonly string[] = ['data'];

/**
 * 把协议路径里的**字面段**归一为规范大小写；无需改动时返回 `null`。
 * 只处理路径，不动 query（调用方用 `URL.pathname` 赋值即可保留 query）。
 */
export function normalizeProtocolPath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const segs = path.split('/'); // segs[0] 恒为空串
  if (segs.length < 2) return null;

  let changed = false;
  const setIfMatch = (index: number, allowed: readonly string[]): void => {
    const current = segs[index];
    if (current === undefined) return;
    const lower = current.toLowerCase();
    // 命中则写回**路由里的真实写法**（大小写混合的 `SyncClipboard.json` 不能转小写）
    const canonical = allowed.find((candidate) => candidate.toLowerCase() === lower);
    if (canonical !== undefined && canonical !== current) {
      segs[index] = canonical;
      changed = true;
    }
  };

  // 第一段决定这条路径属于哪一族；不属于协议面（如 /ui/*）一律不动
  switch ((segs[1] ?? '').toLowerCase()) {
    case 'api':
      setIfMatch(1, SEGMENT_1);
      // `/api/history/{profileId}` 的第三段是**取值**（`Text-<hash>`），只有统计/查询/清空是字面段
      setIfMatch(2, SEGMENT_2);
      if ((segs[2] ?? '').toLowerCase() === 'history') {
        setIfMatch(3, SEGMENT_3);
        setIfMatch(4, SEGMENT_4);
      }
      break;
    case 'file':
      setIfMatch(1, SEGMENT_1);
      break;
    case 'syncclipboard.json':
      setIfMatch(1, SEGMENT_1);
      break;
    case 'syncclipboardhub':
      setIfMatch(1, SEGMENT_1);
      setIfMatch(2, SEGMENT_2); // /SyncClipboardHub/negotiate
      break;
    default:
      return null;
  }
  return changed ? segs.join('/') : null;
}

/**
 * 字面段归一表覆盖的位置（供守卫测试与文档引用；**不是**路由表本身）。
 * 键 = `path.split('/')` 的索引（1 起，与上面的 `setIfMatch` 一致）。
 */
export const LITERAL_POSITIONS: Readonly<Record<number, readonly string[]>> = {
  1: SEGMENT_1,
  2: SEGMENT_2,
  3: SEGMENT_3,
  4: SEGMENT_4,
};
