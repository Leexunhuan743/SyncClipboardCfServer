// WebDAV 兼容端点（docs/protocol.md §4；行为对照 SyncClipboardController）
import { Hono } from 'hono';
import { Bindings } from '../env';
import { HistoryDb, basename, BadRequestError as DbBadRequestError } from '../db';
import { R2Storage } from '../storage';
import { putSyncProfile, BadRequestError, NotFoundError } from '../profile';
import { parseProfileDto, profileDtoToJson, classifyStoredProfile } from '../serialization';
import type { StoredProfileHealth } from '../serialization';
import { textProfileHash } from '../hash';
import { ProfileType, ProfileDto, isValidProfileHash } from '../types';
import { broadcast } from '../hub';
import { multistatusXml, xmlResponse } from '../webdavXml';

// 附件 Content-Type 映射。上游用 .NET FileExtensionContentTypeProvider（~370 项）；
// 这里覆盖剪贴板常见类型，其余回退 application/octet-stream。
// 注意：**可渲染类型必须在表内**，否则会因回退 octet-stream 而绕过 RENDERABLE_TYPES 加固
// （octet-stream 浏览器不会渲染，但显式映射更贴近上游语义）。
const CONTENT_TYPES: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  // 文档 / 文本
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  // 音视频
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  // 压缩 / 归档
  zip: 'application/zip',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  // 办公
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function contentTypeOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  // 用 hasOwn 而非直接下标：`x.constructor` / `a.tostring` 会命中 Object.prototype 的成员，
  // 返回函数而非 Content-Type 字符串（同类项目审计发现的「原型链查找」缺陷）。
  return Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext]! : 'application/octet-stream';
}

// 会被浏览器当作可执行内容渲染的类型。附件与 API 同源，而浏览器会为同源请求自动附带
// 已缓存的 Basic 凭据 → 直接打开此类附件可读取全部剪贴板历史（存储型 XSS 面）。
const RENDERABLE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]);

// 附件响应头：一律禁 MIME 嗅探；可渲染类型额外叠加 CSP + 强制下载。
// 注：上游 ASP.NET `File(bytes, contentType)` 不做这些加固——桌面客户端不读这些头，
// 因此这是纯增益的安全偏离（同类项目审计将其列为严重缺陷）。
export function fileHeaders(fileName: string, size?: number): Headers {
  const contentType = contentTypeOf(fileName);
  const headers = new Headers({
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  });
  if (RENDERABLE_TYPES.has(contentType)) {
    headers.set('content-security-policy', "default-src 'none'; sandbox");
    headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  }
  if (size !== undefined && Number.isFinite(size)) {
    headers.set('content-length', String(size));
  }
  return headers;
}

function invalidFileName(name: string): boolean {
  return name.includes('\\') || name.includes('/');
}

export function createWebdavRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false }) // 尾斜杠容忍：对齐 ASP.NET 路由（客户端 AdjustDirectoryUrl 会加 /）;

  const handlers = (c: { env: Bindings }) => ({
    db: new HistoryDb(c.env.DB),
    storage: new R2Storage(c.env.R2),
  });

  // GET / —— "Server is running."
  app.get('/', (c) => c.text('Server is running.'));

  // PROPFIND —— 返回 WebDAV multistatus（207）。
  // 上游只 `return Ok()`（空体 200）；但官方客户端 WebDAV 适配器在 PreciseDelete=true 时
  // 会 `XmlDocument.LoadXml(响应体)` 解析目录列表，空体会抛 XmlException 使上传失败。
  // 客户端两处调用都是 2xx 判定（DirectoryExist 只看 404；GetFolderSubList 用
  // EnsureSuccessStatusCode），故 207 与上游 200 同样被接受，且符合 RFC 4918。
  app.on('PROPFIND', '/', async (c) => {
    return xmlResponse(multistatusXml([{ path: '/', isCollection: true }]));
  });

  app.on('PROPFIND', '/file', async (c) => {
    const { storage } = handlers(c);
    const objects = await storage.listTempObjects();
    return xmlResponse(
      multistatusXml([
        { path: '/file/', isCollection: true },
        ...objects.map((o) => ({
          path: `/file/${o.name}`,
          isCollection: false,
          size: o.size,
        })),
      ]),
    );
  });

  // MKCOL /file —— 200 空体（上游 `Ok()`；客户端 CreateDirectory 只判 2xx）
  app.on('MKCOL', '/file', (c) => c.body(null, 200));

  // GET /SyncClipboard.json —— 当前 Profile。
  // 三个降级出口逐字对齐上游 GetSyncProfile：无存储值 / 存储值损坏 → 空 TextProfile dto
  // （hash=SHA256("")、size=0）；存储值为字面 `null` → `new ProfileDto()`（hash=""、size 省略键）。
  app.get('/SyncClipboard.json', async (c) => {
    const { db } = handlers(c);
    const json = await db.getCurrentProfileJson();
    // null 存储值 = 上游「文件不存在」分支
    const health: StoredProfileHealth | 'missing' =
      json === null ? 'missing' : classifyStoredProfile(json);
    if (health === 'ok') {
      return new Response(json!, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    if (health === 'null-dto') {
      // 上游 `Deserialize<ProfileDto>("null") ?? new ProfileDto()`：Hash 为空串（非 SHA256("")），
      // Size 为 null → WhenWritingNull 省略该键
      const fallback: ProfileDto = {
        type: ProfileType.Text,
        hash: '',
        text: '',
        hasData: false,
      };
      return c.json(JSON.parse(profileDtoToJson(fallback)), 200);
    }
    // 上游 GetSyncProfile 无文件时返回 new TextProfile(string.Empty).ToProfileDto：
    //   Hash = GetHash() = SHA256("")，Text = ""，HasData = false，DataName = null（整键省略），
    //   Size = GetSize() = 0（Size 为 long?，仅 WhenWritingNull 才省略 → wire 必含 "size":0）（F11）
    const empty: ProfileDto = {
      type: ProfileType.Text,
      hash: await textProfileHash(''),
      text: '',
      hasData: false,
      size: 0,
    };
    return c.json(JSON.parse(profileDtoToJson(empty)), 200);
  });

  // PUT /SyncClipboard.json —— 上传剪贴板（含历史复用/新建+数据校验+广播）
  app.put('/SyncClipboard.json', async (c) => {
    const { db, storage } = handlers(c);
    let dto: ProfileDto;
    try {
      dto = parseProfileDto(await c.req.text());
    } catch {
      return c.text('Invalid JSON body', 400);
    }
    // 上游 `GetWorkingDirName` 拒绝含路径分隔符的 hash（抛 ArgumentException）。这里在写路径
    // 入口给出可诊断的 400，避免入库一条 hash 含 `/` 的坏记录并被设为当前 profile（推给客户端）。
    if (dto.hash !== '' && !isValidProfileHash(dto.hash)) {
      return c.text('Hash contains invalid path characters', 400);
    }
    try {
      await putSyncProfile(db, storage, dto, {
        notifyProfile: (p) => broadcast(c.env, 'RemoteProfileChanged', p),
        notifyHistory: (h) => broadcast(c.env, 'RemoteHistoryChanged', h),
      });
      return c.body(null, 200);
    } catch (err) {
      if (err instanceof BadRequestError) return c.text(err.message, 400);
      if (err instanceof NotFoundError) return c.text(err.message, 404);
      if (err instanceof DbBadRequestError) return c.text(err.message, 400);
      throw err;
    }
  });

  // GET/HEAD /file/{fileName} —— 历史查找下载（GetRecentTransferFile 语义）
  app.on(['GET', 'HEAD'], '/file/:fileName', async (c) => {
    const { db, storage } = handlers(c);
    const fileName = c.req.param('fileName')!;
    if (invalidFileName(fileName)) {
      return c.text('Bad Request', 400);
    }
    // 上游对 LastAccessed 倒序的同名记录逐条检查 `File.Exists`，文件缺失时**继续回退**到
    // 更旧的同名记录；因此这里遍历全部候选，返回第一个存储层真实存在的对象。
    for (const rec of await db.listTransferFileCandidates(fileName)) {
      const obj = await storage.getHistory(rec.type, rec.hash, basename(rec.transferDataFile));
      if (obj) {
        return new Response(obj.body, { headers: fileHeaders(fileName, obj.size) });
      }
    }
    return c.text('Not Found', 404);
  });

  // PUT /file/{fileName} —— 暂存数据文件（不校验）
  app.put('/file/:fileName', async (c) => {
    const { storage } = handlers(c);
    const fileName = c.req.param('fileName')!;
    if (invalidFileName(fileName)) {
      return c.text('Bad Request', 400);
    }
    const body = c.req.raw.body ?? new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    await storage.putTemp(fileName, body, contentTypeOf(fileName));
    return c.body(null, 200);
  });

  // DELETE /file —— 清空暂存区
  app.delete('/file', async (c) => {
    const { storage } = handlers(c);
    await storage.clearTempFolder();
    return c.body(null, 200);
  });

  // DELETE /file/{fileName} —— 删除单个暂存文件
  app.delete('/file/:fileName', async (c) => {
    const { storage } = handlers(c);
    const fileName = c.req.param('fileName')!;
    if (invalidFileName(fileName)) {
      return c.text('Bad Request', 400);
    }
    await storage.deleteTemp(fileName);
    return c.body(null, 200);
  });

  return app;
}
