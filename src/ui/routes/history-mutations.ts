// `POST|PATCH /ui/api/history*` 的写路径：单条 PATCH、新建文本、批量写/硬删/清空、批量正文。
import { Hono } from 'hono';
import { Bindings } from '../../env';
import { stores } from '../../stores';
import { drainRequestBody } from '../../auth';
import {
  parseProfileType,
  parseHistoryRecordUpdateDto,
  entityToDtoWire,
} from '../../serialization';
import { applyHistoryUpdate, clearAllHistory, purgeTrash } from '../../historyOps';
import { broadcast, broadcastMany } from '../../hub';
import { addRecordDto } from '../../profileHistory';
import { maxRequestBodyBytes, readBodyTextCapped } from '../../requestLimits';
import { textProfileHash } from '../../hash';
import { isValidProfileHash, ProfileType } from '../../types';
import type { HistoryRecordUpdateDto } from '../../types';
import { BATCH_META_MAX_ITEMS, readBatchMeta, toUiItem } from '../query';
import type { BatchMetaItem } from '../query';
import { parsePathIds } from './shared';

// 「编辑文本」保存时的体积上限（UTF-8 字节）。1 MiB 是**编辑器的**上限而不是协议的：
// 协议侧的记录可以有 48 MiB，但把这个量级的正文塞进 `<textarea>` 只会把页面卡死
// （前端同一条判据见 `preview.js` 的 `EDIT_MAX_BYTES` —— 两处必须一致，改一处就要改另一处）。
// 超限时服务端回 400 `text_too_large`（前端在按钮上就拦下，正常走不到这里；这是纵深防御）。
export const UI_TEXT_CREATE_MAX_BYTES = 1024 * 1024;

// 批量写的有界并发（见本文件里 batch-update 的注释）。
// 10 是保守值：生产实测串行 663ms/条，10 路并行把 100 条从 ~66s 压到 ~5s，同时
// D1/DO/R2 的并发压力可控；总量子请求不变（不影响 1000 上限的记账）。
export const BATCH_UPDATE_CONCURRENCY = 10;

// 有界并发执行：同时最多 `limit` 个 `fn` 在跑，保序（results 按下标填）。
// 批量循环里每条相互独立，串行等的是网络往返；并行是纯粹地摊销延迟。
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      // index 由 cursor 递增保证 < items.length（取号与越界判定在同一同步段，无竞争）；
      // `noUncheckedIndexedAccess` 收窄不掉这个不变量，显式断言。
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createHistoryMutationRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // PATCH /ui/api/history/:type/:hash —— 收藏 / 置顶 / 删除
  app.patch('/ui/api/history/:type/:hash', async (c) => {
    const ids = parsePathIds(c.req.param('type'), c.req.param('hash'));
    if (!ids) {
      // 这条路径**带 body**（前端发的就是 JSON）：不排空就返回 400 会触发运行时错误
      // 并让本 isolate 的后续请求 503（与守卫、login、logout 同一处理）
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
    }

    let parsed: HistoryRecordUpdateDto;
    try {
      const text = await readBodyTextCapped(c.req.raw, maxRequestBodyBytes(c.env));
      if (text === null) return new Response('Payload Too Large', { status: 413 });
      parsed = parseHistoryRecordUpdateDto(text);
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const fields: HistoryRecordUpdateDto = {
      starred: parsed.starred,
      pinned: parsed.pinned,
      isDelete: parsed.isDelete,
    };
    // 「触碰访问时间」：界面在**复制/下载成功之后**发一条 `{lastAccessed, lastModified, version}`
    // 来推进这条记录的访问时间 —— 因为"使用一条记录"这件事在协议语义里由客户端负责（上游
    // `HistoryManager.AddLocalProfile(updateLastAccessed: true)` 推进它，服务端只存回），
    // 而本界面就是同一个协议的一个客户端。
    // ⚠️ `lastModified` / `version` **只在带 `lastAccessed` 时**一并透传，且用途是"**别动它们**"：
    // `db.updateHistory` 的缺省是 `newVersion = version + 1`、`newLastModified = max(now, …)`
    // ⇒ 只发 lastAccessed 会顺带抬高版本、改掉修改时间；回显这两者之后落库改动的只有 `lastAccessed`
    // （版本不动 ⇒ 官方客户端随后对该记录的正常同步不会被 `shouldUpdate` 判成冲突；
    // 修改时间不动 ⇒「修改」列不因一次复制而跳）。三者都是协议 PATCH 本来就接受的字段。
    const touched = parsed.lastAccessed != null;
    if (touched) {
      fields.lastAccessed = parsed.lastAccessed;
      fields.lastModified = parsed.lastModified;
      fields.version = parsed.version;
    }
    if (fields.starred == null && fields.pinned == null && fields.isDelete == null && !touched) {
      return Response.json({ error: 'no_supported_field' }, { status: 400 });
    }

    // 直接把字段交给同一条写路径（`applyHistoryUpdate` → `db.updateHistory`）：版本与时间戳的
    // 单调推进由 `updateHistory` 内部那**一次**读负责，这里不再预读一遍（预读是每条记录
    // 白多出来的 1 次 D1 子请求，在批量里就是 100 次）。
    const result = await applyHistoryUpdate(c.env, ids.type!, ids.hash, fields);
    if (result.kind === 'notFound') return Response.json({ error: 'not_found' }, { status: 404 });
    if (result.kind === 'conflict') return Response.json({ error: 'conflict' }, { status: 409 });
    return Response.json(toUiItem(result.entity));
  });

  // POST /ui/api/history —— 新建一条**文本**记录（预览框里的「编辑」保存时用）。
  //
  // 为什么是"新建"而不是"改这一条"：文本记录的 `hash = SHA256(utf8(正文))`，正文一改
  // hash 必变 —— 在协议模型里它就是**另一条记录**（同 hash 才能覆盖）。于是这里走的是协议
  // `POST /api/history` 的同一套写路径 `addRecordDto`：
  //   · 它只广播 `RemoteHistoryChanged`（**不碰当前剪贴板**，`notifyProfile` 压根不会被调用）
  //     ⇒ 其它设备只是多一条历史，不会有人被迫换掉自己的剪贴板；
  //   · 官方客户端没有"编辑历史"这个概念，所以这次编辑对它们就是普通的新记录。
  // `version` 取 **0**（= 客户端不带 version 时的默认）：`shouldUpdate` 在 5 分钟窗口内比的是
  // `newVersion >= oldVersion`，若这里写 1，客户端随后重传同一条文本（带 0）会被判冲突而丢更新。
  //
  // 只认 Text：File/Image/Group 没有"编辑正文"这回事，交给行内的下载/预览。
  app.post('/ui/api/history', async (c) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let body: unknown;
    try {
      // 整包读的一律走 capped（预检只信 content-length，chunked 会绕过它）
      const text = await readBodyTextCapped(c.req.raw, maxRequestBodyBytes(c.env));
      if (text === null) return new Response('Payload Too Large', { status: 413 });
      body = JSON.parse(text) as unknown;
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const text = (body ?? {}) as { text?: unknown };
    if (typeof text.text !== 'string') {
      return Response.json({ error: 'text_required' }, { status: 400 });
    }
    const bytes = new TextEncoder().encode(text.text).length;
    if (bytes > UI_TEXT_CREATE_MAX_BYTES) {
      return Response.json(
        { error: 'text_too_large', detail: `${bytes} 字节，上限 ${UI_TEXT_CREATE_MAX_BYTES}` },
        { status: 400 },
      );
    }

    const { db, storage } = stores(c);
    const now = Date.now();
    const dto = await addRecordDto(
      db,
      storage,
      {
        hash: await textProfileHash(text.text),
        type: ProfileType.Text,
        text: text.text,
        size: text.text.length, // 与 profile.ts 对 Text 的口径一致（`dto.text.length`）
        createTime: now,
        lastModified: now,
        lastAccessed: now,
        starred: false,
        pinned: false,
        version: 0,
        isDeleted: false,
      },
      null, // 不带传输数据：正文就在 text 列里（官方客户端对普通文本也是这样）
      {
        notifyProfile: (p) => broadcast(c.env, 'RemoteProfileChanged', p),
        notifyHistory: (h) => broadcast(c.env, 'RemoteHistoryChanged', h),
      },
    );
    // 回读一次拿**实体**（`addRecordDto` 返回的是 DTO，而 `/ui/api` 的其它写端点一律回
    // `toUiItem(entity)`）：1 次 D1 读换"与 PATCH 同一形状的响应"，前端可以复用同一个归一化函数。
    // 同 hash 已存在时 `addRecordDto` 会走更新分支，回读拿到的正是落库后的最新状态 ✓。
    const entity = await db.getByTypeAndHash(ProfileType.Text, dto.hash);
    if (!entity) return Response.json({ error: 'not_found' }, { status: 500 });
    return Response.json(toUiItem(entity));
  });

  // POST /ui/api/history/batch-update —— 批量写（收藏 / 置顶 / 删除 / 恢复）
  //
  // 逐条走 `applyHistoryUpdate`（与单条 PATCH、官方 PATCH **同一条写路径**）：各自广播、
  // 各自做 shouldUpdate 判定、删除时各自清 R2 数据目录。因此这里不做任何「批量捷径」——
  // 捷径会让「界面改的」与「客户端改的」逐渐分叉。
  //
  // **并发**：每条记录的处理相互独立（各自 D1 读、写、DO 广播、R2 清理），串行是纯浪费 ——
  // 生产实测 100 条删除串行 **66s**（663ms/条，瓶颈是每条约 5 次子请求的往返延迟）。
  // 有界并发是外层包装，**逐条语义不变**（`shouldUpdate` 在时间差 >5 分钟时要求
  // `newLastModified >= oldLastModified`，靠 `updateHistory` 内部的缺省值满足）。
  //
  // 成本（子请求记账）：一条记录 ≈ 1 读 + 1 写 + 1 广播（删除时再 +2 的 R2 目录清理），
  // 100 条封顶 ≈ 500 次，留一倍余量（200 条正好顶到单次调用 1000 次的内部子请求上限、零余量）。
  // 超出的部分由调用方分片（js/api.js 的 batchUpdate），不是拒绝服务。
  app.post('/ui/api/history/batch-update', async (c) => {
    // 只接受 application/json：跨站**表单**（`enctype=text/plain` 或 `multipart/form-data`）能直接
    // 发出 POST 且不经过 CORS 预检，而 JSON 必须由脚本构造（那类请求会被来源校验挡下）。它与来源
    // 校验是纵深的两层，且不改变本页自身的行为 —— `js/api.js` 的 `request()` 对所有带 body
    // 的调用恒带 `content-type: application/json`。
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let body: unknown;
    try {
      // 整包读的一律走 capped（预检只信 content-length，chunked 会绕过它）
      const text = await readBodyTextCapped(c.req.raw, maxRequestBodyBytes(c.env));
      if (text === null) return new Response('Payload Too Large', { status: 413 });
      body = JSON.parse(text) as unknown;
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const { items, update } = (body ?? {}) as { items?: unknown; update?: unknown };
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items_required' }, { status: 400 });
    }
    // 上限 100 而不是 200：每条记录 ≈5 次子请求（1 读 + 1 写 + 1 次 DO 广播，删除再 +2 次 R2
    // 目录清理），200 条正好等于单次调用的 1000 次内部子请求上限、**零余量** —— 任一条走到冲突回读
    // 或目录多一页 list 就会中途超限。100 条 = 约 500 次，留一倍余量。
    // 调用方（js/api.js 的 batchUpdate）按 100 分片串行发，选 200 条也能一次做完。
    if (items.length > 100) {
      return Response.json({ error: 'too_many_items' }, { status: 400 });
    }
    // 字段白名单与单条 PATCH 一致：只认 starred / pinned / isDelete，且必须是布尔。
    // 非布尔的静默忽略会让「批量收藏」在某个拼错的字段名下变成一次静默成功的空操作。
    const raw = (update ?? {}) as Record<string, unknown>;
    const fields: { starred?: boolean; pinned?: boolean; isDelete?: boolean } = {};
    for (const key of ['starred', 'pinned', 'isDelete'] as const) {
      if (raw[key] === undefined || raw[key] === null) continue;
      if (typeof raw[key] !== 'boolean') {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      fields[key] = raw[key] as boolean;
    }
    if (Object.keys(fields).length === 0) {
      return Response.json({ error: 'no_supported_field' }, { status: 400 });
    }

    // 有界并发跑完每一条（保序），再聚合 —— 语义与串行完全一致，只是不再一条条等网络往返。
    // **广播合并成一次**：`deferBroadcast` 让每条只写库、把待广播的载荷带回主线程，整批跑完后
    // 一次 `broadcastMany` 投出去（100 条从 100 次 DO 子请求降到 1 次；消息内容与顺序不变，
    // 客户端收到的东西与逐条广播时一模一样）。
    const outcomes = await mapLimit(items, BATCH_UPDATE_CONCURRENCY, async (rawItem) => {
      const entry = rawItem as { type?: unknown; hash?: unknown };
      const ids =
        typeof entry?.type === 'string' && typeof entry?.hash === 'string'
          ? parsePathIds(entry.type, entry.hash)
          : null;
      if (!ids) return { failed: 'invalid' };
      const result = await applyHistoryUpdate(c.env, ids.type!, ids.hash, fields, {
        deferBroadcast: true,
      });
      return result.kind === 'updated'
        ? { payload: entityToDtoWire(result.entity) }
        : { failed: `${entry.type}-${entry.hash}` };
    });
    const payloads: unknown[] = [];
    const failed: string[] = [];
    for (const outcome of outcomes) {
      if ('payload' in outcome) payloads.push(outcome.payload);
      else failed.push(outcome.failed);
    }
    // 一次子请求广播整批（顺序与逐条一致：`mapLimit` 保序返回，这里也保序收集）。
    // 与单条写同一条纪律：**在响应返回前 await 完成**，否则推送会非确定性丢失。
    await broadcastMany(c.env, 'RemoteHistoryChanged', payloads);
    return Response.json({ updated: payloads.length, failed: failed.length });
  });

  // POST /ui/api/history/batch-purge —— 回收站的「彻底删除」：**本地硬删行**，不是协议面。
  //
  // 回收站只有「恢复」与「清空回收站」两个出口时，永久删掉**几条**做不到 —— 只能整罐倒。
  // 上游也没有这个能力（它的硬删是 30 天定时任务），所以这是本站自己的面：路由在 `/ui/api/*` 下，
  // 官方客户端不感知。
  //
  // 与 batch-update 的差别，逐条都为了把成本压到最小：
  //   · **不做应答/版本判定** —— 硬删的语义就是"从库里拿掉"，没有可合并的并发语义；
  //   · **不广播** —— 与 `clear scope=trash` 同一判据（见 clear 的三条理由：上游广播触发点
  //     清单里没有删除；逐条广播会顶子请求上限；本站其它标签页靠 `/ui/api/poll` 收敛）；
  //   · **顺带清扫 R2 目录**（每条 +1 次列举）—— 回收站里是真数据，彻底删除的语义就是立刻连字节一起没了；
  //   · 安全判据写在 SQL 里：只删 `IsDeleted != 0` 的行 ⇒ **活跃记录删不掉**（不许绕过回收站）。
  // ⇒ 每条 **1 次 D1 子请求**（对照：软删每条 6 次），100 条封顶 = 100 次，留的余量足够。
  app.post('/ui/api/history/batch-purge', async (c) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let body: unknown;
    try {
      // 整包读的一律走 capped（预检只信 content-length，chunked 会绕过它）
      const text = await readBodyTextCapped(c.req.raw, maxRequestBodyBytes(c.env));
      if (text === null) return new Response('Payload Too Large', { status: 413 });
      body = JSON.parse(text) as unknown;
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const { items } = (body ?? {}) as { items?: unknown };
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items_required' }, { status: 400 });
    }
    // 上限与 batch-update 对齐（100）：这里每条只要 1 次子请求，本可以放更宽，但**接口口径统一**
    // 比"每个端点各自算自己的上限"更好记；调用方（js/api.js 的 batchPurge）同样按 100 分片。
    if (items.length > 100) {
      return Response.json({ error: 'too_many_items' }, { status: 400 });
    }

    const { db, storage } = stores(c);
    const outcomes = await mapLimit(items, BATCH_UPDATE_CONCURRENCY, async (rawItem) => {
      const entry = rawItem as { type?: unknown; hash?: unknown };
      const ids =
        typeof entry?.type === 'string' && typeof entry?.hash === 'string'
          ? parsePathIds(entry.type, entry.hash)
          : null;
      if (!ids) return 'invalid';
      if (!(await db.purgeDeletedRecord(ids.type!, ids.hash))) {
        return `${entry.type}-${entry.hash}`;
      }
      // 行删掉了 ⇒ 顺手把它的数据目录清掉。**必需**：真回收站保留数据，不扫就等于把字节留给
      // 孤儿阶段（最长 20 分钟），而"彻底删除"的语义就是立刻没了。
      // 成本：每条 +1 次 R2 列举（目录不存在/为空时只有这一次），仍是本端点最便宜的那一段。
      await storage.deleteHistoryWorkingDir(ids.type!, ids.hash);
      return null;
    });
    let purged = 0;
    const failed: string[] = [];
    for (const outcome of outcomes) {
      if (outcome === null) purged++;
      else failed.push(outcome);
    }
    return Response.json({ purged, failed: failed.length });
  });

  // POST /ui/api/history/clear —— 清空历史：`scope=trash` 只清回收站，`scope=all` 清全部。
  //
  // 与协议端点 `DELETE /api/history/clear` 同语义，但**不逐条广播**（有意如此，三条理由）：
  //   ① 上游的广播触发点清单里没有 clear，逐条补广播会成为新的有意偏离；
  //   ② 1000 条记录逐条广播 = 1000 次 DO 子请求，超过单次调用 1000 次子请求的上限 —— 饱和时必然半途失败；
  //   ③ 本站的其它标签页靠 `/ui/api/poll` 的变更信号收敛（计数变化必然触发），本页自己做完即刷新。
  app.post('/ui/api/history/clear', async (c) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let scope: unknown;
    try {
      const text = await readBodyTextCapped(c.req.raw, maxRequestBodyBytes(c.env));
      if (text === null) return new Response('Payload Too Large', { status: 413 });
      scope = ((JSON.parse(text) as { scope?: unknown }) ?? {})?.scope;
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (scope !== 'trash' && scope !== 'all') {
      return Response.json({ error: 'invalid_scope' }, { status: 400 });
    }
    const { db } = stores(c);
    if (scope === 'trash') {
      // 先删行、再按集合清扫数据目录（`purgeTrash` 里写清了顺序与理由）。
      // 回收站里躺的是**真数据**，不扫就是把它留给孤儿阶段（最长 20 分钟）。
      return Response.json({ scope, deleted: await purgeTrash(c.env) });
    }
    // 清全部：与协议端点共用同一份实现（含成本与窄竞态的说明）
    return Response.json({ scope, deleted: await clearAllHistory(c.env) });
  });

  // POST /ui/api/history/batch-meta —— 按 (type,hash) 批量取记录（含**完整正文**）
  //
  // 用途：列表里的正文被截断到 500 字符，「选中多条 → 一起复制/下载」需要全文，
  // 而逐条走单条端点是 O(N) 次请求。
  app.post('/ui/api/history/batch-meta', async (c) => {
    // 只接受 application/json：与 batch-update / clear 同一条理由 ——
    // 跨站**表单**能直接发出 POST 且不经过 CORS 预检，而 JSON 必须由脚本构造（那类请求被来源校验挡下）。
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let body: unknown;
    try {
      // 整包读的一律走 capped（预检只信 content-length，chunked 会绕过它）
      const text = await readBodyTextCapped(c.req.raw, maxRequestBodyBytes(c.env));
      if (text === null) return new Response('Payload Too Large', { status: 413 });
      body = JSON.parse(text) as unknown;
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const raw = (body ?? {}) as { items?: unknown };
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
      return Response.json({ error: 'items_required' }, { status: 400 });
    }
    if (raw.items.length > BATCH_META_MAX_ITEMS) {
      return Response.json({ error: 'too_many_items' }, { status: 400 });
    }

    const items: BatchMetaItem[] = [];
    for (const entry of raw.items) {
      const item = (entry ?? {}) as { type?: unknown; hash?: unknown };
      const type = typeof item.type === 'string' ? parseProfileType(item.type) : undefined;
      // hash 与写路径同一判据（含路径分隔符的一律拒）：读路径不收合法进不了写路径的形态
      if (type === undefined || typeof item.hash !== 'string' || !isValidProfileHash(item.hash)) {
        return Response.json({ error: 'invalid_item' }, { status: 400 });
      }
      items.push({ type, hash: item.hash });
    }

    const entities = await readBatchMeta(c.env.DB, items);
    // 用 `toUiItem`（与列表同一份映射）而不是 `entityToDto`：调用方拿到的东西必须与
    // 列表项**同形**，否则前端要维护两条归一化路径。
    return Response.json({ items: entities.map(toUiItem) });
  });

  return app;
}
