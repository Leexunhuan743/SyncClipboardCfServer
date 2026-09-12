// WebDAV PROPFIND 多状态响应（RFC 4918 §9.1）
//
// 上游 ASP.NET 对 PROPFIND 只 `return Ok()`（空体）。官方客户端的 WebDAV 适配器在
// `PreciseDelete=true` 时会调用 `WebDavBase.GetFolderSubList` → `XmlDocument.LoadXml(响应体)`，
// 空体将抛 XmlException 并让上传流程失败；真正的 WebDAV 服务器（Nextcloud 等）会返回 multistatus。
// 这里实现合法 multistatus，使 WebDAV 模式下的清理路径可用（官方服务器类型不受影响）。

export interface DavEntry {
  // 相对站点根的绝对路径（如 `/file/report.pdf`），内部按段 URL 编码
  path: string;
  isCollection: boolean;
  size?: number;
  lastModified?: Date;
}

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch]!);
}

// 逐段编码：保留 `/`，其余按 URL 规则编码（客户端会做 HttpUtility.UrlDecode 还原）
export function encodeHrefPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function responseXml(entry: DavEntry): string {
  const parts: string[] = [];
  parts.push('<D:response>');
  parts.push(`<D:href>${escapeXml(encodeHrefPath(entry.path))}</D:href>`);
  parts.push('<D:propstat><D:prop>');
  if (entry.isCollection) {
    parts.push('<D:resourcetype><D:collection/></D:resourcetype>');
  } else {
    // 非集合必须出现 resourcetype（可为空元素），客户端据此判断 IsFolder
    parts.push('<D:resourcetype/>');
    if (entry.size !== undefined) {
      parts.push(`<D:getcontentlength>${entry.size}</D:getcontentlength>`);
    }
  }
  if (entry.lastModified) {
    parts.push(`<D:getlastmodified>${escapeXml(entry.lastModified.toUTCString())}</D:getlastmodified>`);
  }
  parts.push('</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>');
  parts.push('</D:response>');
  return parts.join('');
}

export function multistatusXml(entries: DavEntry[]): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:multistatus xmlns:D="DAV:">' +
    entries.map(responseXml).join('') +
    '</D:multistatus>'
  );
}

export function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 207,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
