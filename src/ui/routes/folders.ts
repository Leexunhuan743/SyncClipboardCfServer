// `/ui/api/folders*` 与 `POST /ui/api/history/batch-folder`：收藏夹（本站独有，官方协议不感知）。
//
// 语义（都在 docs/ui.md 的「收藏夹」一节里）：
//   · 用户自定义名字，名字唯一、≤30 个字符、至多 50 个；
//   · 一条记录至多放进一个收藏夹，独立于星标；
//   · 放进收藏夹的记录**不会被自动清理**（豁免条件在 src/db.ts 的 softDeleteOldest）；
//   · 删除收藏夹时里面的记录移出（变回普通记录），不会连记录一起删。
// 收藏夹列表随 `/ui/api/overview` 一起返回（见 info.ts），这里只有写端点：前端每次写完就拿到最新列表。
import { Hono } from 'hono';
import { Bindings } from '../../env';
import { stores } from '../../stores';
import { drainRequestBody } from '../../auth';
import { maxRequestBodyBytes, readBodyTextCapped } from '../../requestLimits';
import { FOLDER_NAME_MAX_CHARS, FOLDERS_MAX, normalizeFolderName } from '../../db';
import { parseProfileType } from '../../serialization';
import { isValidProfileHash } from '../../types';
import type { ProfileType } from '../../types';

// 一次最多处理的记录数：与 batch-update 同口径（前端按 100 分片）
const BATCH_FOLDER_MAX_ITEMS = 100;

type Parsed = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/** 写端点共用的请求体读取：只收 application/json、整包过体量上限、必须是对象。 */
async function readJsonObject(raw: Request, env: Bindings): Promise<Parsed> {
  if (!(raw.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    await drainRequestBody(raw);
    return { ok: false, response: Response.json({ error: 'unsupported_media_type' }, { status: 415 }) };
  }
  try {
    const text = await readBodyTextCapped(raw, maxRequestBodyBytes(env));
    if (text === null) return { ok: false, response: new Response('Payload Too Large', { status: 413 }) };
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, response: Response.json({ error: 'invalid_request' }, { status: 400 }) };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: Response.json({ error: 'invalid_request' }, { status: 400 }) };
  }
}

function parseFolderId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

const writeError = (kind: 'exists' | 'too_many' | 'not_found'): Response =>
  kind === 'exists'
    ? Response.json({ error: 'folder_exists' }, { status: 409 })
    : kind === 'too_many'
      ? Response.json({ error: 'too_many_folders', detail: `最多 ${FOLDERS_MAX} 个收藏夹` }, { status: 400 })
      : Response.json({ error: 'not_found' }, { status: 404 });

export function createFolderRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // POST /ui/api/folders —— 新建
  app.post('/ui/api/folders', async (c) => {
    const read = await readJsonObject(c.req.raw, c.env);
    if (!read.ok) return read.response;
    const name = normalizeFolderName(read.body.name);
    if (name === null) {
      return Response.json(
        { error: 'invalid_name', detail: `名字不能为空、不能含控制字符，且不超过 ${FOLDER_NAME_MAX_CHARS} 个字符` },
        { status: 400 },
      );
    }
    const { db } = stores(c);
    const result = await db.createFolder(name, Date.now());
    if (result.kind !== 'ok') return writeError(result.kind);
    return Response.json({ id: result.id, folders: await db.listFolders() });
  });

  // PATCH /ui/api/folders/:id —— 改名
  app.patch('/ui/api/folders/:id', async (c) => {
    const id = parseFolderId(c.req.param('id'));
    if (id === null) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'invalid_folder_id' }, { status: 400 });
    }
    const read = await readJsonObject(c.req.raw, c.env);
    if (!read.ok) return read.response;
    const name = normalizeFolderName(read.body.name);
    if (name === null) {
      return Response.json(
        { error: 'invalid_name', detail: `名字不能为空、不能含控制字符，且不超过 ${FOLDER_NAME_MAX_CHARS} 个字符` },
        { status: 400 },
      );
    }
    const { db } = stores(c);
    const result = await db.renameFolder(id, name);
    if (result.kind !== 'ok') return writeError(result.kind);
    return Response.json({ id, folders: await db.listFolders() });
  });

  // DELETE /ui/api/folders/:id —— 删除收藏夹；里面的记录移出（不删记录）
  app.delete('/ui/api/folders/:id', async (c) => {
    await drainRequestBody(c.req.raw);
    const id = parseFolderId(c.req.param('id'));
    if (id === null) return Response.json({ error: 'invalid_folder_id' }, { status: 400 });
    const { db } = stores(c);
    const result = await db.deleteFolder(id);
    if (result.kind !== 'ok') return writeError('not_found');
    return Response.json({ moved: result.moved, folders: await db.listFolders() });
  });

  // POST /ui/api/history/batch-folder —— 把一批记录放进收藏夹（folderId=null 或 0 = 移出）
  app.post('/ui/api/history/batch-folder', async (c) => {
    const read = await readJsonObject(c.req.raw, c.env);
    if (!read.ok) return read.response;
    const { items, folderId } = read.body as { items?: unknown; folderId?: unknown };
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items_required' }, { status: 400 });
    }
    if (items.length > BATCH_FOLDER_MAX_ITEMS) {
      return Response.json({ error: 'too_many_items' }, { status: 400 });
    }
    let target = 0;
    if (folderId !== null && folderId !== undefined) {
      if (typeof folderId !== 'number' || !Number.isSafeInteger(folderId) || folderId < 0) {
        return Response.json({ error: 'invalid_folder_id' }, { status: 400 });
      }
      target = folderId;
    }
    const pairs: { type: ProfileType; hash: string }[] = [];
    for (const entry of items) {
      const item = (entry ?? {}) as { type?: unknown; hash?: unknown };
      const type = typeof item.type === 'string' ? parseProfileType(item.type) : undefined;
      if (type === undefined || typeof item.hash !== 'string' || !isValidProfileHash(item.hash)) {
        return Response.json({ error: 'invalid_item' }, { status: 400 });
      }
      pairs.push({ type, hash: item.hash });
    }
    const { db } = stores(c);
    // 目标收藏夹必须存在：否则记录会带着一个不存在的 FolderId 永远豁免清理、又谁也看不见
    if (target !== 0 && !(await db.folderExists(target))) return writeError('not_found');
    const updated = await db.setFolder(pairs, target);
    return Response.json({ updated, failed: pairs.length - updated, folders: await db.listFolders() });
  });

  return app;
}
