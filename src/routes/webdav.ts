// WebDAV 兼容端点（docs/protocol.md §4；行为对照 SyncClipboardController）
import { Hono } from 'hono';
import { Bindings } from '../env';
import { HistoryDb, basename, BadRequestError } from '../db';
import { R2Storage } from '../storage';
import { putSyncProfile, NotFoundError, PayloadTooLargeError } from '../profile';
import { parseProfileDto, profileDtoToJson, classifyStoredProfile } from '../serialization';
import type { StoredProfileHealth } from '../serialization';
import { textProfileHash } from '../hash';
import { ProfileType, ProfileDto, isValidProfileHash } from '../types';
import { broadcast } from '../hub';
import { multistatusXml, xmlResponse } from '../webdavXml';
import { isUiEnabled } from '../uiEnabled';
import { maxRequestBodyBytes } from '../requestLimits';
import { contentTypeOf, fileHeaders } from '../contentTypes';

function invalidFileName(name: string): boolean {
  return name.includes('\\') || name.includes('/');
}

export function createWebdavRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false }) // 尾斜杠容忍：对齐 ASP.NET 路由（客户端 AdjustDirectoryUrl 会加 /）;

  const handlers = (c: { env: Bindings }) => ({
    db: new HistoryDb(c.env.DB),
    storage: new R2Storage(c.env.R2),
  });

  // GET / —— 浏览器访问站点根时引导到 Web UI；其余调用方（含官方客户端的探活）保持原响应。
  // 官方客户端从不 GET 根路径：Test() 与 GetFolderSubList() 都是 PROPFIND（WebDavBase.cs:271/321），
  // 这里的 Accept 判断只是让任何按文本协议探活的脚本行为完全不变。
  // 界面被关闭时（GitHub 变量 UI_ENABLED=false）不再把人引到不存在的 /ui/，直接返回探活响应。
  //
  // 跳转目标是 **`/ui/app/`**（V2 的应用本体），不是 `/ui/`：后者是静态资源的目录索引，
  // 而它唯一做的事就是再跳一次到 `/ui/app/`。少一跳，浏览器历史里也少一条记录。
  app.get('/', (c) => {
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/html') && isUiEnabled(c.env)) return c.redirect('/ui/app/', 302);
    return c.text('Server is running.');
  });

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
      await putSyncProfile(
        db,
        storage,
        dto,
        {
          notifyProfile: (p) => broadcast(c.env, 'RemoteProfileChanged', p),
          notifyHistory: (h) => broadcast(c.env, 'RemoteHistoryChanged', h),
        },
        maxRequestBodyBytes(c.env),
      );
      return c.body(null, 200);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return c.text('Payload Too Large', 413);
      if (err instanceof BadRequestError) return c.text(err.message, 400);
      if (err instanceof NotFoundError) return c.text(err.message, 404);
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
