// 附件 Content-Type 与响应头策略。
//
// 独立成模块的原因：WebDAV 端点与 UI 的数据/下载端点都要「按文件名定类型 + 叠加安全头」，
// 两处各写一份必然分叉（UI 少一道 nosniff 就是一个存储型 XSS 面）。
//
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
