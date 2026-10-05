// WebDAV 兼容端点（docs/protocol.md §4；行为对照 SyncClipboardController）
import { Hono } from 'hono';
import { Bindings } from '../env';
import { basename, BadRequestError } from '../db';
import { putSyncProfile, NotFoundError, PayloadTooLargeError } from '../profile';
import { parseProfileDto, profileDtoToJson, classifyStoredProfile } from '../serialization';
import type { StoredProfileHealth } from '../serialization';
import { textProfileHash } from '../hash';
import { ProfileType, ProfileDto, isValidProfileHash } from '../types';
import { broadcast } from '../hub';
import { multistatusXml, xmlResponse } from '../webdavXml';
import { isUiEnabled } from '../uiEnabled';
import { maxRequestBodyBytes, readBodyTextCapped } from '../requestLimits';
import { contentTypeOf, fileHeaders } from '../contentTypes';
import { stores } from '../stores';

// 上游的 `InvalidFileName` 口径：只拒 `\` 与 `/`，其余交给文件系统（`SyncClipboardController.cs:24-27`）。
function invalidFileName(name: string): boolean {
  return name.includes('\\') || name.includes('/');
}


export function createWebdavRoutes(): Hono<{ Bindings: Bindings }> {
  // `strict: false` = 尾斜杠容忍，对齐 ASP.NET 路由（客户端 AdjustDirectoryUrl 会加 `/`）。
  // （此前这句写在声明行行尾，把分号一起注释掉了 —— 语句只是靠 ASI 才成立。）
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // GET / —— 浏览器访问站点根时引导到 Web UI；其余调用方（含官方客户端的探活）保持原响应。
  // 官方客户端从不 GET 根路径：Test() 与 GetFolderSubList() 都是 PROPFIND（WebDavBase.cs:271/321），
  // 这里的 Accept 判断只是让任何按文本协议探活的脚本行为完全不变。
  // 界面被关闭时（GitHub 变量 UI_ENABLED=false）不再把人引到不存在的界面，直接返回探活响应。
  //
  // 跳转目标是 **`/ui_v1/`**（V1 是默认界面，2026-09-19 改名后挂在 `/ui_v1/`）—— 少一跳：
  // `/ui/` 那层壳（老书签的入口）自己也会 meta refresh 到同一个地址，两处必须一致，
  // 守卫见 `test/ui-guard.test.ts` 的「默认界面的入口链一致」。
  // （V2 —— `public/ui_v2/` —— 是**开发测试版**，应用本体在 `/ui_v2/app/`。）
  app.get('/', (c) => {
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/html') && isUiEnabled(c.env)) return c.redirect('/ui_v1/', 302);
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
    const { storage } = stores(c);
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
    const { db } = stores(c);
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
      // 直接以 profileDtoToJson 的**字面量**为 body：`c.json(JSON.parse(...))` 会
      // stringify → parse → stringify 三轮（同一份 DTO 编码两次、还要建一棵临时对象树）。
      // content-type 必须逐字照抄 Hono `c.json` 写出的那一个：`application/json`（**不带 charset**）。
      return new Response(profileDtoToJson(fallback), {
        headers: { 'content-type': 'application/json' },
      });
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
    // 同上：body 就是字面量，content-type 与 Hono `c.json` 一致（`application/json`，无 charset）
    return new Response(profileDtoToJson(empty), {
      headers: { 'content-type': 'application/json' },
    });
  });

  // PUT /SyncClipboard.json —— 上传剪贴板（含历史复用/新建+数据校验+广播）
  app.put('/SyncClipboard.json', async (c) => {
    const { db, storage } = stores(c);
    let dto: ProfileDto;
    try {
      // 整包读也要过体量上限：F9 预检只信 content-length，chunked 请求会绕过它
      const text = await readBodyTextCapped(c.req.raw, maxRequestBodyBytes(c.env));
      if (text === null) return c.text('Payload Too Large', 413);
      dto = parseProfileDto(text);
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
    const { db, storage } = stores(c);
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
    const { storage } = stores(c);
    const fileName = c.req.param('fileName')!;
    // 写入侧额外拒含 **NUL** 的名字（GET/DELETE 不收紧，保持上游口径）。
    // 上游对它是**未处理异常**：`Path.Combine` + `FileStream` 遇到非法路径字符 ⇒ 抛 ⇒ 控制器兜底 **500**
    // （`SyncClipboardController.cs:107-122` 只拦 `\` 与 `/`），而 NUL 这个名字在本实现里**确实能到达**
    // handler —— 实测 `PUT /file/a%00b.txt` 到得了（URL 解析不会归一化它），落到 R2 上会成为一个
    // 带 NUL 的键。判据与 zip 条目名的 `assertSafeEntryName` 同一套（那里拒 NUL 是因为文件系统会截断；
    // 这里是为了不制造"上游拒、我们收"的新分叉），并给可诊断的 400 而不是 500。
    // ⚠️ 不要把 `.`/`..` 也加进来（试过，2026-10-03 撤回）：**平台在 Worker 之前就把点段归一化了** ——
    // 实测原始请求（`node:http`，不经 URL 库）`PUT /file/..`、`/file/.`、`/file/%2E%2E`、`/file/%2E`
    // 全部落到别处（`/` 或 `/file/`）→ **404**，连 handler 都进不来 ⇒ 那种名字根本存不进 R2，
    // 也就不存在"客户端 `PreciseDelete` 删不掉"的泄漏（见 `docs/protocol.md` §10 与 Git history）。
    // 可达性：官方客户端发的是 `EscapeDataString(Path.GetFileName(localPath))`（真实文件名），
    // 而任何文件系统都不允许含 NUL 的文件 ⇒ 不可达，属"更严但不伤兼容"的入口校验。
    if (invalidFileName(fileName) || fileName.includes('\0')) {
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
    const { storage } = stores(c);
    await storage.clearTempFolder();
    return c.body(null, 200);
  });

  // DELETE /file/{fileName} —— 删除单个暂存文件
  app.delete('/file/:fileName', async (c) => {
    const { storage } = stores(c);
    const fileName = c.req.param('fileName')!;
    if (invalidFileName(fileName)) {
      return c.text('Bad Request', 400);
    }
    await storage.deleteTemp(fileName);
    return c.body(null, 200);
  });

  return app;
}
