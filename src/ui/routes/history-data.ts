// `GET /ui/api/history*` 的读路径：列表、单条元数据、数据文件（含 Range）。
import { Hono } from 'hono';
import { Bindings } from '../../env';
import { basename } from '../../db';
import { stores } from '../../stores';
import { drainRequestBody } from '../../auth';
import { UiQueryError, listUiHistory, parseUiHistoryQuery, toUiItem } from '../query';
import { fileHeaders } from '../../contentTypes';
import {
  parsePathIds,
  parseRangeHeader,
  resolveRange,
} from './shared';

export function createHistoryDataRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // GET /ui/api/history —— 列表（筛选/搜索/排序/分页）
  app.get('/ui/api/history', async (c) => {
    let query;
    try {
      query = parseUiHistoryQuery(new URL(c.req.url).searchParams);
    } catch (err) {
      if (err instanceof UiQueryError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
    return Response.json(await listUiHistory(c.env.DB, query));
  });

  // GET /ui/api/history/:type/:hash —— 单条元数据
  app.get('/ui/api/history/:type/:hash', async (c) => {
    const ids = parsePathIds(c.req.param('type'), c.req.param('hash'));
    if (!ids) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
    }
    const record = await stores(c).db.getByTypeAndHash(ids.type!, ids.hash);
    if (!record) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(toUiItem(record));
  });

  // GET /ui/api/history/:type/:hash/data —— 数据文件（图片预览 / 文件下载）
  app.get('/ui/api/history/:type/:hash/data', async (c) => {
    const ids = parsePathIds(c.req.param('type'), c.req.param('hash'));
    if (!ids) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
    }
    const { db, storage } = stores(c);
    const record = await db.getByTypeAndHash(ids.type!, ids.hash);
    if (!record || record.transferDataFile === '') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const fileName = basename(record.transferDataFile);
    // 带合法 Range 时先取元数据（size）：区间是否可满足必须自己判定（理由见 storage.headHistory 注释）。
    // 成本：带 Range 的请求 = 1 次 R2 head + 1 次 R2 区间读（无 Range 仍是 1 次 get），相对
    // src/cleanup.ts 的 SUBREQUEST_BUDGET(800) 可忽略；R2 也只读取命中的那段字节。
    const requested = parseRangeHeader(c.req.header('range'));
    const meta = requested ? await storage.headHistory(record.type, record.hash, fileName) : null;
    // 对象不存在时 size 取 0：下面整段都不会生效，最终由 get 的 null 判定回到 404 data_missing。
    const size = meta?.size ?? 0;
    // 零长度对象按 200 全量处理：RFC 9110 §14.2 允许服务端「对没有内容的表示忽略 Range」——
    // 那种表示按 §14.1.2 只剩「非零后缀区间」一种可满足形态，无论 206 还是 416 都要拼出退化的
    // content-range，不如直接忽略（也避免把零长度区间交给 R2）。
    const slice = requested && size > 0 ? resolveRange(requested, size) : null;
    if (requested && size > 0 && !slice) {
      // 不可满足：不回对象体，只给出总长度（RFC 9110 §14.4 的 `bytes */size`）。
      // 这里**有意不设** cache-control，落到 `/ui/api/*` 中间件的 `no-store`：区间不可满足是
      // 「此刻这个对象的结论」，按数据端点的 60 s 私有缓存留住它，会让客户端在数据变大后仍拿旧结论。
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
      });
    }
    const object = await storage.getHistory(
      record.type,
      record.hash,
      fileName,
      slice ? { offset: slice.start, length: slice.end - slice.start + 1 } : undefined,
    );
    // 记录存在但 R2 对象没了 —— 必须与「记录不存在」区分开：
    // `hasData` 是元数据推导（filePaths.length>0 || transferDataFile!==''），不代表对象真的在。
    // 前端据此渲染「数据不可用」而不是裂图。
    // Range 判定放在这条之前不会削弱它：head 拿不到对象时 slice 为 null，走的仍是原来的全量 get，
    // 由下面的 null 判定返回同一个 404 data_missing。
    if (!object) return Response.json({ error: 'data_missing' }, { status: 404 });

    const headers = fileHeaders(fileName, object.size);
    // 预览要内联、下载要附件。可渲染类型（html/svg）在 fileHeaders 里已被强制降级为附件，
    // 这里只在**非可渲染**类型上覆盖 disposition，不给那类加固开后门。
    if (!headers.has('content-disposition')) {
      const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
      headers.set(
        'content-disposition',
        `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
    }
    headers.set('cache-control', 'private, max-age=60');
    // 206 与 200 共用上面这条缓存策略：`private` 表示只有浏览器本地缓存（本 Worker 既不写边缘缓存、
    // 也不做 Range 分片缓存），因此加 Range 不会削弱预览/缩略图的复用，只是浏览器按 URL 分开存缓存条目。
    headers.set('accept-ranges', 'bytes');
    if (!slice) return new Response(object.body, { headers });
    // 206：fileHeaders 已按整个对象设过 content-length，这里换成切片长度
    headers.set('content-length', String(slice.end - slice.start + 1));
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  });

  return app;
}
