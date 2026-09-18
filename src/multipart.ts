// 兼容性 multipart/form-data 解析器
// 背景：undici 的 Request.formData() 要求 Content-Disposition 的 name/filename 带引号，
// 而 .NET HttpClient MultipartFormDataContent 生成无引号格式（name=hash），上游 ASP.NET
// MultipartReader 两种都接受。为保证官方客户端兼容，按字节手工解析。

export interface MultipartPart {
  name: string;
  filename?: string;
  content: Uint8Array; // 字段值（文本部分）或二进制内容（文件部分）
  text: string; // 文本字段的 UTF-8 解码值（文件部分为空）
}

export interface MultipartResult {
  parts: MultipartPart[];
  // 按名字取字段值（大小写不敏感，无则 null）
  get(name: string): string | null;
  // 文件部分（仅当存在且内容非空时非 null）
  data: MultipartPart | null;
  // data 部分是否「存在」——含 0 字节的 data 部分。
  // 上游按 part 是否存在决定是否保存数据流（空流仍传），因此 `data===null` 不等于「没有 data 部分」；
  // 两者的区别决定 Text 记录是走「接受数据」还是「无数据」分支（F14）。
  dataPresent: boolean;
}

const CRLF = '\r\n';

// RFC 2046 规定分界串最长 70 字节。此前直接采用请求头里的任意长度分界串，
// 而分界串查找代价与之成正比（审计实测 64KB 请求体：61 字节分界串 48ms、2048 字节 267ms）。
export const MAX_BOUNDARY_LENGTH = 70;

export function parseBoundary(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) return null;
  const boundary = match[1] ?? match[2] ?? null;
  // 超长分界串按「无合法 boundary」处理：调用方据此返回 400，且不必读请求体、不进入解构
  if (boundary === null || boundary.length > MAX_BOUNDARY_LENGTH) return null;
  return boundary;
}

export function parseMultipart(bytes: Uint8Array, boundary: string): MultipartResult {
  if (boundary.length > MAX_BOUNDARY_LENGTH) {
    throw new Error(`Invalid multipart: boundary exceeds ${MAX_BOUNDARY_LENGTH} bytes`);
  }
  const enc = new TextDecoder();
  const encoder = new TextEncoder();
  // 本部分的终止串 = CRLF + "--" + 分界串；分界串本体取其尾部视图（零拷贝）
  const partTerminator = encoder.encode(CRLF + `--${boundary}`);
  const delimBytes = partTerminator.subarray(2);
  // 分界串在循环里被反复查找，编码一次复用（旧实现在每轮循环里新建 TextEncoder 并重编码）
  const headerTerminator = encoder.encode(CRLF + CRLF);
  const parts: MultipartPart[] = [];

  let pos = 0;
  // 起始：--boundary\r\n
  const firstDelim = findSubarray(bytes, delimBytes, 0);
  if (firstDelim < 0) {
    throw new Error('Invalid multipart: boundary not found');
  }
  pos = firstDelim + delimBytes.length;
  if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) {
    // 空 multipart（--boundary--）
    return makeResult(parts);
  }
  // 跳过 \r\n
  pos = skipCrlf(bytes, pos);

  while (pos < bytes.length) {
    // 找本部分的 header 结束（\r\n\r\n）
    const headerEnd = findSubarray(bytes, headerTerminator, pos);
    if (headerEnd < 0) {
      throw new Error('Invalid multipart: missing header terminator');
    }
    const headerBlock = enc.decode(bytes.subarray(pos, headerEnd));
    pos = headerEnd + 4;

    // 找本部分 body 结束（\r\n--boundary）
    const bodyEnd = findSubarray(bytes, partTerminator, pos);
    if (bodyEnd < 0) {
      throw new Error('Invalid multipart: missing part terminator');
    }
    // subarray 是视图（零拷贝），不是副本：文件部分直接透传给 R2。
    // 此前用 slice 会为整个 body 再复制一份，是峰值内存的主要来源之一。
    const content = bytes.subarray(pos, bodyEnd);
    pos = bodyEnd + 2 + delimBytes.length; // \r\n--boundary

    const disposition = parseContentDisposition(headerBlock);
    if (disposition) {
      parts.push({
        name: disposition.name,
        filename: disposition.filename,
        content,
        text: '',
      });
    }

    // 结束符 --boundary-- 或下一个部分
    if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) {
      break;
    }
    pos = skipCrlf(bytes, pos);
  }

  // 文本字段按需解码（文件部分不解码，避免大文件内存翻倍）
  const dec = new TextDecoder();
  for (const p of parts) {
    if (p.name.toLowerCase() !== 'data') {
      p.text = dec.decode(p.content);
    }
  }

  return makeResult(parts);
}

function makeResult(parts: MultipartPart[]): MultipartResult {
  const byLowerName = new Map<string, MultipartPart>();
  for (const p of parts) {
    if (!byLowerName.has(p.name.toLowerCase())) {
      byLowerName.set(p.name.toLowerCase(), p);
    }
  }
  return {
    parts,
    get(name: string): string | null {
      return byLowerName.get(name.toLowerCase())?.text ?? null;
    },
    data: parts.find((p) => p.content.length > 0 && p.name.toLowerCase() === 'data') ?? null,
    dataPresent: parts.some((p) => p.name.toLowerCase() === 'data'),
  };
}

// Content-Disposition: form-data; name="hash"; filename="x.bin"
// 兼容无引号：name=hash
function parseContentDisposition(headerBlock: string): { name: string; filename?: string } | null {
  const lines = headerBlock.split(CRLF);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!lower.startsWith('content-disposition:')) continue;
    const paramsStr = line.slice(line.indexOf(':') + 1);
    // 提取 name / filename 参数（引号或无引号）
    const name = extractParam(paramsStr, 'name');
    if (name === null) return null;
    const filename = extractParam(paramsStr, 'filename');
    return { name, filename: filename ?? undefined };
  }
  return null;
}

function extractParam(paramsStr: string, key: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const m = re.exec(paramsStr);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

// 子串查找：先用原生 Uint8Array.indexOf 定位首字节（memchr 级扫描，跳过不可能匹配的区间），
// 再逐字节校验余部。旧实现在每个起始位置都从头比较整条分界串，代价随分界串长度线性增长，
// 而分界串完全由请求方控制（F9）。
// 注意：TypedArray.prototype.indexOf 只按数值搜索（按规范对非数值参数做 ToNumber → NaN → -1），
// 因此不能把 needle 直接交给它——必须自己扫描首字节。
function findSubarray(haystack: Uint8Array, needle: Uint8Array, start: number): number {
  if (needle.length === 0) return start;
  const first = needle[0]!;
  const last = haystack.length - needle.length;
  let i = haystack.indexOf(first, start);
  while (i >= 0 && i <= last) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    i = haystack.indexOf(first, i + 1);
  }
  return -1;
}

function skipCrlf(bytes: Uint8Array, pos: number): number {
  if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) return pos + 2;
  return pos;
}
