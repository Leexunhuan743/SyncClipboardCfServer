// 哈希算法（协议契约 docs/protocol.md §8）——与上游 C# 实现逐字节一致
import { unzipSync } from 'fflate';

const enc = new TextEncoder();

// SHA-256 → 十六进制大写（C# Convert.ToHexString 等价）
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

// ===== Text（上游 TextProfile.ComputeHash）=====
// hash = SHA256hex(UTF8(text))
export function textProfileHash(text: string): Promise<string> {
  return sha256Hex(text);
}

// ===== File / Image（上游 FileProfile.CombineHash / GetSHA256HashFromFile）=====
// contentHash = SHA256hex(内容)
// hash = SHA256hex(UTF8($"{fileName}|{contentHash.toUpperCase()}"))
export async function fileProfileHash(fileName: string, content: Uint8Array): Promise<string> {
  const contentHash = await sha256Hex(content);
  return sha256Hex(`${fileName}|${contentHash.toUpperCase()}`);
}

// ===== Group（上游 GroupProfile.CaclHashAndSize / CalculateEntriesHashAsync）=====

// 无符号字节数组字典序比较（C# ByteArrayComparer 等价）
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export interface GroupEntrySpec {
  name: string; // EntryName：相对 zip 根，目录以 '/' 结尾
  isDir: boolean;
  content?: Uint8Array; // 目录无内容
}

// 条目 → 行（UTF-8）：
//   目录: "D|{name}\0"（name 以 '/' 结尾）
//   文件: "F|{name}|{length}|{contentHashUpper}\0"
// 排序：按 name 的 UTF-8 字节数组升序；拼接后 SHA256hex
export async function groupHashFromEntries(entries: GroupEntrySpec[]): Promise<string> {
  const ordered = entries
    .map((e) => ({ e, key: enc.encode(e.name) }))
    .sort((a, b) => compareBytes(a.key, b.key));

  const chunks: Uint8Array[] = [];
  const parts: string[] = [];
  for (const { e } of ordered) {
    if (e.isDir) {
      parts.push(`D|${e.name}\0`);
    } else {
      const contentHash = await sha256Hex(e.content!);
      parts.push(`F|${e.name}|${e.content!.length}|${contentHash.toUpperCase()}\0`);
    }
  }
  for (const p of parts) {
    chunks.push(enc.encode(p));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  return sha256Hex(joined);
}

// 空条目集合的哈希（上游 CaclHashAndSize 空分支）：SHA256hex(空串)
export const EMPTY_GROUP_HASH = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';

// 从 zip 字节解析条目集合并计算哈希（服务端校验路径，等价"解压后遍历文件系统"）
// - 目录条目：显式（name 以 '/' 结尾）+ 从文件路径推导的隐式父目录（C# 解压会创建目录并计入）
// - 防穿越：条目名不得解析到解压根之外（上游 ExtractArchiveEntriesAsync 校验）
// - 同名重复条目：上游解压是「首次写入优先」（FileMode.CreateNew + File.Exists 跳过），
//   而 fflate 默认「后者覆盖」。这里显式跳过同名后续条目，与上游保持同一语义（F12）。
export function parseGroupZip(zipBytes: Uint8Array): { entries: GroupEntrySpec[]; topLevel: string[]; totalSize: number } {
  const seenNames = new Set<string>();
  const unzipped = unzipSync(zipBytes, {
    filter: (file: { name: string }) => {
      if (seenNames.has(file.name)) {
        return false; // 同名重复条目：保留首个（上游首次写入优先）
      }
      seenNames.add(file.name);
      return true;
    },
  });
  const names = Object.keys(unzipped);
  if (names.length === 0) {
    return { entries: [], topLevel: [], totalSize: 0 };
  }

  const fileEntries: GroupEntrySpec[] = [];
  const dirSet = new Set<string>();

  for (const rawName of names) {
    const isDirEntry = rawName.endsWith('/');
    if (isDirEntry) {
      assertSafeEntryName(rawName);
      dirSet.add(rawName);
      continue;
    }
    // 文件条目：校验路径合法（无 .. 段、不以 / 开头、非绝对路径）
    assertSafeEntryName(rawName);
    fileEntries.push({ name: rawName, isDir: false, content: unzipped[rawName] });
    // 推导隐式父目录（逐级；C# 解压会创建目录并在哈希重算时计入）
    const segments = rawName.split('/');
    segments.pop(); // 去掉文件名
    let acc = '';
    for (const seg of segments) {
      acc += seg + '/';
      dirSet.add(acc);
    }
  }

  const dirEntries: GroupEntrySpec[] = [...dirSet].map((name) => ({ name, isDir: true }));
  const entries = [...dirEntries, ...fileEntries];

  // 解压后条目总字节数（上游 GroupProfile 的 Size = totalSize = 各条目长度之和，非 zip 体积）
  const totalSize = fileEntries.reduce((n, e) => n + e.content!.length, 0);

  // 顶层条目：TrimEnd('/') 后不含 '/'（上游 entry.FullName.TrimEnd('/')，裁掉**全部**尾斜杠）
  const topLevel = new Set<string>();
  for (const name of names) {
    const trimmed = name.replace(/\/+$/, '');
    if (trimmed !== '' && !trimmed.includes('/')) {
      topLevel.add(trimmed);
    }
  }

  return { entries, topLevel: [...topLevel], totalSize };
}

function assertSafeEntryName(name: string): void {
  if (name.startsWith('/') || name.includes('\\')) {
    throw new InvalidGroupDataError(`Transfer data is invalid with entry: ${name}`);
  }
  const segments = name.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new InvalidGroupDataError(`Transfer data is invalid with entry: ${name}`);
    }
  }
}

// 服务端 Group 数据校验失败（上游 InvalidDataException / InvalidOperationException → 422 或 400）
export class InvalidGroupDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGroupDataError';
  }
}

// 顶层条目为空（上游 "Group transfer data contains no entries." → InvalidDataException）
export class EmptyGroupDataError extends InvalidGroupDataError {
  constructor() {
    super('Group transfer data contains no entries.');
    this.name = 'EmptyGroupDataError';
  }
}
