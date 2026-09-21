// 附件 Content-Type 与响应头策略。
//
// 独立成模块的原因：WebDAV 端点与 UI 的数据/下载端点都要「按文件名定类型 + 叠加安全头」，
// 两处各写一份必然分叉（UI 少一道 nosniff 就是一个存储型 XSS 面）。
//
// 2026-09-21 重写（取舍、差集与读数见 docs/progress.md §106）：
//
//   ① **类型映射改用 `mrmime`（438 项，MIT，零依赖）打底 + 12 项本地补遗**。上游 .NET 是
//      `FileExtensionContentTypeProvider`（~370 项），本实现此前手写 46 项，实测缺
//      `.yaml`/`.yml`/`.json5`/`.toml`/`.wasm`/`.epub`/`.ai` 等常见类型（一律被标成 octet-stream）。
//      ⚠️ **只引 mrmime 会退步**：它的表里没有 `.docx`/`.xlsx`/`.pptx`/`.xls`/`.ppt`/`.7z`/`.rar`/
//      `.tar`/`.ico`/`.avi`/`.mkv`/`.flac`（12 项，与旧表求差集得到的完整名单），所以这些留在
//      `EXTRA_TYPES` 里 —— 它是"mrmime 未收录"的补遗，不是第二份映射表。
//      唯一取值冲突是 `.xml`：旧表写 `application/xml`，mrmime 给标准的 `text/xml`（RFC 3023，
//      也是 .NET 那一侧的取值）⇒ 采 mrmime（安全判定已改成按后缀，见下，故不影响加固）。
//
//   ② **内联策略从"黑名单"改成"默认-deny 白名单"**（可渲染类型另加 CSP 沙箱）。
//      ⚠️ 这两条**不能分开做**：`.xml` 换表后变成 `text/xml`，而旧黑名单恰好**删掉了** `text/xml`
//      （当时判定"表里没有扩展名映射到它、不可达"，见 `docs/AUDIT-redundancies.md` D-03）
//      ⇒ 只换表就会让 `.xml` 变成「浏览器可渲染、却不加任何加固」，把 `docs/ui.md` §7 登记为
//      **已修**的存储型 XSS 链重新打开（附件与 API 同源，浏览器会为同源请求自动带上已缓存的
//      Basic 凭据）。所以加固判据一并从"枚举 4 项"改成"按后缀判定 XML/HTML 家族"。
import { mimes } from 'mrmime';

// mrmime 未收录、但剪贴板里常见的类型（12 项）。取值与上游 .NET 的口径一致，逐项抄自
// 本模块 2026-09-21 之前的表 —— 那一版 46 项里，其余 34 项已由 mrmime 提供（含 `.xml` 的取值改动）。
const EXTRA_TYPES: Record<string, string> = {
  ico: 'image/x-icon',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  flac: 'audio/flac',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// 类型映射。**绕开 mrmime 的 `lookup()` 自己判定**：`mimes` 是普通对象字面量，
// `lookup('x.constructor')` 会命中 `Object.prototype.constructor` 并返回一个**函数**（实测），
// 那正是 F20 修过的「原型链查找」形态（`test/fixes.test.ts` 有断言）。两处都走 `Object.hasOwn`。
// 顺序：补遗在前（本仓库核对过的取值优先），两者按构造不相交。
export function contentTypeOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (ext === '') return 'application/octet-stream';
  if (Object.hasOwn(EXTRA_TYPES, ext)) return EXTRA_TYPES[ext]!;
  return Object.hasOwn(mimes, ext) ? (mimes as Record<string, string>)[ext]! : 'application/octet-stream';
}

// 允许**内联**（浏览器直接打开/预览）的白名单 —— 默认-deny：不在名单里的一律 attachment。
// 只收"按纯数据展示、不构成标记/脚本渲染面"的类型：
//   · 图片：`image/*` **除 svg**（svg 是 XML 文档，能引外部资源/执行脚本）；
//   · 纯文本：`text/plain`、`text/csv`、`text/markdown`（界面的文本预览取的就是 `.txt`）；
//   · `application/json`（浏览器按文本树显示）、`application/pdf`（阅读器是独立沙箱）。
// 其余（含 `text/html`、`text/xml`、全部 `+xml`、压缩包、Office 文档、未知类型）一律强制下载。
function isInlineAllowed(contentType: string): boolean {
  if (contentType.startsWith('image/')) return contentType !== 'image/svg+xml';
  return (
    contentType === 'text/plain' ||
    contentType === 'text/csv' ||
    contentType === 'text/markdown' ||
    contentType === 'application/json' ||
    contentType === 'application/pdf'
  );
}

// 浏览器可能**渲染或执行**的类型（HTML/XML 家族）：即使将来有人把它们加进内联白名单，也必须
// 叠加 CSP 沙箱。判据按**后缀**而不是枚举 —— mrmime 里 `+xml` 家族有几十项
// （`xhtml`/`rss`/`atom`/`mathml`/`svg`…），枚举必然漏，`.xml` 那次正是漏在枚举上。
function isRenderable(contentType: string): boolean {
  return (
    contentType === 'text/html' ||
    contentType === 'text/xml' ||
    contentType === 'application/xml' ||
    contentType.endsWith('+xml')
  );
}

// 附件响应头：一律禁 MIME 嗅探；**非内联白名单**或可渲染类型强制下载；可渲染类型另加 CSP。
// 注：上游 ASP.NET `File(bytes, contentType)` 不做这些加固——桌面客户端不读这些头，
// 因此这是纯增益的安全偏离（同类项目审计将其列为严重缺陷）。
export function fileHeaders(fileName: string, size?: number): Headers {
  const contentType = contentTypeOf(fileName);
  const headers = new Headers({
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  });
  const renderable = isRenderable(contentType);
  if (renderable || !isInlineAllowed(contentType)) {
    headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  }
  if (renderable) {
    headers.set('content-security-policy', "default-src 'none'; sandbox");
  }
  if (size !== undefined && Number.isFinite(size)) {
    headers.set('content-length', String(size));
  }
  return headers;
}
