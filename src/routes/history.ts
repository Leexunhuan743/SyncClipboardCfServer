// 官方历史 API（docs/protocol.md §5；行为对照 HistoryController + HistoryService）
import { Hono } from 'hono';
import { Bindings } from '../env';
import { HistoryDb, basename, BadRequestError } from '../db';
import { R2Storage } from '../storage';
import { addRecordDto, NotFoundError, ProfileDataInvalidError, IncomingRecord } from '../profile';
import {
  entityToDto,
  entityToUpdateDto,
  parseProfileType,
  parseProfileTypeFilter,
  parseHistoryRecordUpdateDto,
  parseDateOrNow,
  updateDtoToJson,
  historyDtoToJson,
  historyListToJson,
  historySizeMB,
  InvalidQueryValueError,
  normalizeSearchText,
} from '../serialization';
import { ProfileType, HistoryQueryDto, INT32_MIN, INT32_MAX, isValidProfileHash } from '../types';
import { broadcast } from '../hub';
import { applyHistoryUpdate, clearAllHistory } from '../historyOps';
import { parseBoundary, parseMultipart, MultipartResult } from '../multipart';
import { drainRequestBody } from '../auth';

const UNPROCESSABLE_ENTITY = 422;

function problemDetails(detail: string): Response {
  return Response.json(
    {
      status: UNPROCESSABLE_ENTITY,
      title: 'History transfer data is invalid',
      code: 'history_data_invalid',
      detail,
    },
    { status: UNPROCESSABLE_ENTITY },
  );
}

// "Type-Hash" 解析（上游 Profile.ParseProfileId）
function parseProfileId(profileId: string): { type: ProfileType; hash: string } | null {
  const parts = profileId.split('-');
  if (parts.length < 2) return null;
  const type = parseProfileType(parts[0]);
  if (type === undefined) return null;
  const hash = parts.slice(1).join('-');
  if (!hash) return null;
  return { type, hash };
}

// FormData 小写 key 取值（multipart 字段大小写不敏感）
function formGet(form: MultipartResult, key: string): string | null {
  return form.get(key);
}

function parseDateOrNull(s: string | null): Date | null {
  if (s === null || s === '') return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms);
}

// 上游 [FromForm] 的 `bool?`/`bool` 模型绑定：值为空 → null（bool?）/默认值；
// 非空且非 true/false → ModelState 失败 → [ApiController] 自动 400。
// 此前非法值静默当作 null / false，会把「拼错的过滤条件」变成「返回全部记录 / 按未过滤排序」。
function parseBoolOrNull(s: string | null, fieldName: string): boolean | null {
  if (s === null || s.trim() === '') return null;
  const t = s.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  throw new InvalidQueryValueError(`Invalid ${fieldName} value: ${s}`);
}

// 上游 [FromForm] int Page 的模型绑定 = C# int.TryParse（可选正负号 + 十进制数字，且落在 int32 内），
// 绑定失败时 [ApiController] 自动返回 400；控制器随后 `if (query.Page < 1) query.Page = 1;`。
function parseCSharpInt32(raw: string): number | null {
  const s = raw.trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) return null;
  return n;
}

function parsePage(form: MultipartResult): number {
  const raw = formGet(form, 'Page');
  if (raw === null || raw.trim() === '') return 1; // 缺省 → DTO 默认值 1
  const n = parseCSharpInt32(raw);
  // 非 int32 绑定失败 → 400。此前把 5e21 这类值原样带进 offset，以 REAL 绑定到
  // LIMIT/OFFSET 会触发 SQLite 'datatype mismatch' → 500（F9）。
  if (n === null) throw new BadRequestError('Page is out of range');
  return n < 1 ? 1 : n;
}

function parseQueryForm(form: MultipartResult): HistoryQueryDto {
  const page = parsePage(form);
  const types = parseProfileTypeFilter(formGet(form, 'Types'));
  const starred = parseBoolOrNull(formGet(form, 'Starred'), 'Starred');
  const sortByLastAccessed =
    parseBoolOrNull(formGet(form, 'SortByLastAccessed'), 'SortByLastAccessed') === true;
  return {
    page,
    before: parseDateOrNull(formGet(form, 'Before')),
    after: parseDateOrNull(formGet(form, 'After')),
    modifiedAfter: parseDateOrNull(formGet(form, 'ModifiedAfter')),
    types,
    // 超长会让 D1 的 LIKE 直接报错（未处理的 500）⇒ 在入口按字节校验并回 400。
    searchText: normalizeSearchText(formGet(form, 'SearchText')),
    starred,
    sortByLastAccessed,
  };
}

function parseIncomingForm(form: MultipartResult): IncomingRecord {
  const hash = formGet(form, 'hash');
  if (!hash) throw new BadRequestError('hash is required');
  // 同 PUT：拒绝含路径分隔符的 hash（上游 GetWorkingDirName 语义），给出可诊断的 400
  if (!isValidProfileHash(hash)) {
    throw new BadRequestError('Hash contains invalid path characters');
  }
  const type = parseProfileType(formGet(form, 'type'));
  if (type === undefined || type === ProfileType.None || type === ProfileType.Unknown) {
    throw new BadRequestError('Type is invalid or missing');
  }
  // 上游用 bool.TryParse / int.TryParse / long.TryParse：语法不合法即取默认值 0（不抛错）。
  const toBool = (v: string | null): boolean => (v ?? '').trim().toLowerCase() === 'true';
  const toInt = (v: string | null): number => {
    const raw = (v ?? '').trim();
    if (raw === '') return 0;
    // 此前用 parseInt：'3abc' → 3、'3.9' → 3、'0x10' → 16，与 int.TryParse 的「整体必须合法」相左（F27）
    return parseCSharpInt32(raw) ?? 0;
  };
  const toLong = (v: string | null): number => {
    const raw = (v ?? '').trim();
    if (raw === '') return 0;
    if (!/^[+-]?\d+$/.test(raw)) return 0;
    const n = Number(raw);
    // long.TryParse 接受负数；但 JS 无法精确表示 |n| > 2^53，超界取 0（客户端不会发这种值）。
    // 此前用 Number() 会让 '1e999' 变成 Infinity，而 Infinity 绑定进 D1 会存成 NULL
    // （即便列声明 NOT NULL）（F9）
    return Number.isSafeInteger(n) ? n : 0;
  };
  return {
    hash,
    type,
    text: formGet(form, 'text') ?? '',
    size: toLong(formGet(form, 'size')),
    createTime: parseDateOrNow(formGet(form, 'createTime')),
    lastModified: parseDateOrNow(formGet(form, 'lastModified')),
    lastAccessed: parseDateOrNow(formGet(form, 'lastAccessed')),
    starred: toBool(formGet(form, 'starred')),
    pinned: toBool(formGet(form, 'pinned')),
    version: toInt(formGet(form, 'version')),
    isDeleted: toBool(formGet(form, 'isDeleted')),
  };
}

// 表单请求体的媒体类型判定（对齐上游的模型绑定，差异表见 docs/protocol.md §10）：
//   POST /api/history        —— 上游显式标注 `[Consumes("multipart/form-data")]`：其他媒体类型在
//                               模型绑定**之前**就被拒 → 415（不是 400）。客户端按状态码分支，故必须一致。
//   POST /api/history/query  —— 上游只有 `[FromForm]`、没有 Consumes 约束：ASP.NET 的
//                               FormValueProviderFactory 同时接受 multipart/form-data 与
//                               application/x-www-form-urlencoded，故两者都要能解析。
const UNSUPPORTED_MEDIA_TYPE = 415;

function mediaType(contentType: string): string {
  const semi = contentType.indexOf(';');
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

// urlencoded 表单 → MultipartResult 形状（字段名大小写不敏感，与 multipart 侧同一套取值语义）
function urlEncodedResult(params: URLSearchParams): MultipartResult {
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    const lower = key.toLowerCase();
    if (!values.has(lower)) values.set(lower, value);
  }
  return {
    parts: [],
    get: (name: string) => values.get(name.toLowerCase()) ?? null,
    data: null,
    dataPresent: false,
  };
}

interface FormRequest {
  req: {
    header(name: string): string | undefined;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    raw: Request;
  };
}

// 解析表单请求体；失败时返回可直接回给客户端的 Response（400/415）
async function parseFormBody(c: FormRequest, allowUrlEncoded: boolean): Promise<MultipartResult | Response> {
  const contentType = c.req.header('content-type') ?? '';
  const type = mediaType(contentType);

  if (allowUrlEncoded && type === 'application/x-www-form-urlencoded') {
    return urlEncodedResult(new URLSearchParams(await c.req.text()));
  }
  if (!allowUrlEncoded && type !== 'multipart/form-data') {
    // 提前返回前先排空请求体：否则本 isolate 的后续请求会以 503 结束（见 src/auth.ts 同名说明）
    await drainRequestBody(c.req.raw);
    return new Response('Unsupported Media Type', { status: UNSUPPORTED_MEDIA_TYPE });
  }

  const boundary = parseBoundary(contentType);
  if (!boundary) {
    await drainRequestBody(c.req.raw);
    return new Response('Invalid or missing multipart/form-data boundary', { status: 400 });
  }
  try {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return parseMultipart(bytes, boundary);
  } catch (err) {
    console.log(`[HISTORY] multipart parse failed: ${(err as Error).message}`);
    return new Response('Invalid or missing multipart/form-data boundary', { status: 400 });
  }
}

export function createHistoryRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false }) // 尾斜杠容忍：对齐 ASP.NET 路由（客户端 AdjustDirectoryUrl 会加 /）;

  const handlers = (c: { env: Bindings }) => ({
    db: new HistoryDb(c.env.DB),
    storage: new R2Storage(c.env.R2),
  });

  // GET /api/history/statistics —— 先于 :profileId 注册（Hono 同段静态优先，注册顺序保险）
  app.get('/api/history/statistics', async (c) => {
    const { db, storage } = handlers(c);
    const bytes = await storage.totalHistorySize();
    const stats = await db.statistics(historySizeMB(bytes));
    return c.json(stats, 200);
  });

  // GET /api/history/{profileId} —— 单条记录元数据
  app.get('/api/history/:profileId', async (c) => {
    const { db } = handlers(c);
    const parsed = parseProfileId(c.req.param('profileId')!);
    if (!parsed) {
      return c.text("Invalid profileId format. Expected format: 'Type-Hash'", 400);
    }
    const rec = await db.getByTypeAndHash(parsed.type, parsed.hash);
    if (!rec) return c.text('Not Found', 404);
    return new Response(historyDtoToJson(entityToDto(rec)), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // GET /api/history/{profileId}/data —— 记录数据文件
  app.get('/api/history/:profileId/data', async (c) => {
    const { db, storage } = handlers(c);
    const parsed = parseProfileId(c.req.param('profileId')!);
    // 上游此端点的 profileId 解析失败走 `GetTransferDataFileByProfileId` 返回 null → **404**
    // （与 GET /api/history/{profileId} 的 400 不同：那是控制器自己校验格式）
    if (!parsed) {
      return c.text('Not Found', 404);
    }
    const rec = await db.getByTypeAndHash(parsed.type, parsed.hash);
    if (!rec || rec.transferDataFile === '') {
      return c.text('Not Found', 404);
    }
    const fileName = basename(rec.transferDataFile);
    const obj = await storage.getHistory(rec.type, rec.hash, fileName);
    if (!obj) {
      return c.text('Not Found', 404);
    }
    // 出口统一编码（与 contentTypes.ts:92 / ui/routes.ts:168 同款）：写路径不拦控制字符
    // （既有坏数据也必须可下载），因此 dataName 可能含 CR/LF/NUL——原样拼进头值会让
    // Response 构造抛 TypeError，使该条记录的 /data 恒 500（F5）。
    //   filename=   ASCII 兜底串（控制字符与非 ASCII → `_`；去掉会破坏引号串的 `"` 与 `\`）
    //   filename*=  RFC 5987，encodeURIComponent 把控制字符编码为 %XX（仍是合法头值）
    const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    });
  });

  // POST /api/history/query —— 分页查询（multipart 表单）
  app.post('/api/history/query', async (c) => {
    const { db } = handlers(c);
    // 上游此端点只有 [FromForm]：multipart 与 urlencoded 都接受
    const parsed = await parseFormBody(c, true);
    if (parsed instanceof Response) return parsed;
    let q: HistoryQueryDto;
    try {
      q = parseQueryForm(parsed);
    } catch (err) {
      if (err instanceof BadRequestError) return c.text(err.message, 400);
      // 非法查询参数值（如拼错的 Types 名）→ 上游 [ApiController] 枚举绑定失败 400
      if (err instanceof InvalidQueryValueError) return c.text(err.message, 400);
      throw err;
    }
    try {
      const list = await db.queryList(q);
      return new Response(historyListToJson(list.map(entityToDto)), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      if (err instanceof BadRequestError) return c.text(err.message, 400);
      throw err;
    }
  });

  // POST /api/history —— 历史上传（multipart；data 文件部分）
  app.post('/api/history', async (c) => {
    const { db, storage } = handlers(c);
    // 上游此端点有显式 [Consumes("multipart/form-data")]：非 multipart 一律 415
    const parsed = await parseFormBody(c, false);
    if (parsed instanceof Response) return parsed;

    let incoming: IncomingRecord;
    try {
      incoming = parseIncomingForm(parsed);
    } catch (err) {
      if (err instanceof BadRequestError) {
        console.log(`[HISTORY POST] 400 (parse): ${err.message}`);
        return c.text(err.message, 400);
      }
      throw err;
    }

    // data 部分「存在」即视为有传输数据——含 0 字节的部分。上游按 part 是否存在决定是否
    // 保存数据流（空流仍传），把空部分当作「无 data」会让 Text 记录静默入库（F14）。
    const content = parsed.dataPresent
      ? parsed.data?.content ?? new Uint8Array(0)
      : null;

    try {
      const dto = await addRecordDto(db, storage, incoming, content, {
        notifyProfile: (p) => broadcast(c.env, 'RemoteProfileChanged', p),
        notifyHistory: (h) => broadcast(c.env, 'RemoteHistoryChanged', h),
      });
      return new Response(historyDtoToJson(dto), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      if (err instanceof ProfileDataInvalidError) return problemDetails(err.message);
      if (err instanceof BadRequestError) {
        console.log(`[HISTORY POST] 400 (addRecordDto): ${err.message}`);
        return c.text(err.message, 400);
      }
      if (err instanceof NotFoundError) return c.text(err.message, 404);
      throw err;
    }
  });

  // PATCH /api/history/{type}/{hash} —— 部分更新（版本/时间戳判定，409 冲突）
  app.patch('/api/history/:type/:hash', async (c) => {
    const type = parseProfileType(c.req.param('type')!);
    if (type === undefined) {
      return c.text('Bad Request', 400);
    }
    const hash = c.req.param('hash')!;
    // 含路径分隔符的 hash 在删除路径会构造 R2 前缀（deleteHistoryWorkingDir）→ 拒绝
    if (!isValidProfileHash(hash)) {
      return c.text('Bad Request', 400);
    }
    let dto;
    try {
      dto = parseHistoryRecordUpdateDto(await c.req.text());
    } catch {
      return c.text('Bad Request', 400);
    }

    // 判定 + 广播 + 数据目录清理都在 applyHistoryUpdate 里（与 UI 的收藏/删除共用同一实现）
    const result = await applyHistoryUpdate(c.env, type, hash, dto);
    if (result.kind === 'notFound') {
      return c.text('Not Found', 404);
    }
    if (result.kind === 'conflict') {
      return c.json(JSON.parse(updateDtoToJson(entityToUpdateDto(result.entity))), 409);
    }
    return c.body(null, 200);
  });

  // DELETE /api/history/clear
  app.delete('/api/history/clear', async (c) => {
    // 与 UI 的清空共用一份实现（src/historyOps.ts 的 clearAllHistory），顺序与成本写在那里
    return c.json({ deleted: await clearAllHistory(c.env) }, 200);
  });

  return app;
}
