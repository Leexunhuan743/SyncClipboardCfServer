// 哈希算法（协议契约 docs/protocol.md §8）——与上游 C# 实现逐字节一致
import { Unzip, UnzipInflate } from 'fflate';
import { ISOLATE_TRANSFER_BUDGET_BYTES } from './requestLimits';

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
//
// 拆成「内容哈希 → profile 哈希」两步的理由：调用方几乎总是**同时**需要内容字节的 SHA-256
// （落库的 `transferDataHash`，以及 PUT 路径对客户端声明的核对）。此前 `fileProfileHash`
// 内部独占那次摘要，调用方只能再算一遍 —— 同一份内容字节被 SHA-256 两遍，而 CPU 是 Workers
// 的**平均**预算（Free 档 10 ms/调用；平台对偶发越界有 rollover CPU time —— 偶发越界不报错、
// 只有**持续**越界才终止，见 docs/free-plan-account-facts.md），重复摘要就是白烧预算
// （见 src/profile.ts 的 PersistedData.transferDataHash）。
// 传进来的 `contentHash` 不必是大写：`toUpperCase()` 仍在，与旧实现逐字节等价。
export function fileProfileHashFromContentHash(fileName: string, contentHash: string): Promise<string> {
  return sha256Hex(`${fileName}|${contentHash.toUpperCase()}`);
}

// 内容字节 → profile 哈希的薄封装（**不要删**：测试与调用方按名字取用，见 test/hash.test.ts）
export async function fileProfileHash(fileName: string, content: Uint8Array): Promise<string> {
  return fileProfileHashFromContentHash(fileName, await sha256Hex(content));
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
  /** 文件条目的内容哈希（SHA-256 大写 hex）与长度 —— **不保留内容字节本身**。
   *  群组哈希只需 `F|name|len|hash\0` 行，把内容留在内存会让单次解压的峰值内存
   *  变成「body + 2~3×解压总量」（isolate 128MiB 下 20MiB 的 zip 就能撞穿）。 */
  contentHash?: string;
  contentLength?: number;
}

// 条目 → 行（UTF-8）：
//   目录: "D|{name}\0"（name 以 '/' 结尾）
//   文件: "F|{name}|{length}|{contentHashUpper}\0"
// 排序：按 name 的 UTF-8 字节数组升序；拼接后 SHA256hex
export async function groupHashFromEntries(entries: GroupEntrySpec[]): Promise<string> {
  const ordered = entries
    .map((e) => ({ e, key: enc.encode(e.name) }))
    .sort((a, b) => compareBytes(a.key, b.key));

  const parts: string[] = [];
  for (const { e } of ordered) {
    if (e.isDir) {
      parts.push(`D|${e.name}\0`);
    } else {
      parts.push(`F|${e.name}|${e.contentLength}|${e.contentHash?.toUpperCase() ?? ''}\0`);
    }
  }
  const chunks = parts.map((p) => enc.encode(p));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  return sha256Hex(joined);
}

// Group zip 解压上限（F9）：解压在哈希校验**之前**发生，不封顶时一个高压缩比 zip
// 可以让 isolate 在拿到错误前先付出全部解压代价（审计实测 65.7KB → 64MB，≈1000:1）。
// 三条上限都在解压过程中生效：边遍历边累计，超限立即抛错中止，不会先把超限内容物化出来。
export const GROUP_ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 解压后内容总字节上限
export const GROUP_ZIP_MAX_ENTRIES = 1000; // 条目数上限（含目录条目与重复条目）
export const GROUP_ZIP_MAX_COMPRESSION_RATIO = 100; // 单条目 解压后/压缩 字节比上限
export const GROUP_ZIP_MIN_RATIO_CHECK_BYTES = 8 * 1024 * 1024; // 比值守卫的体积下限（以下不判比值）
// 单条目解压上限：fflate 的解压缓冲按 2 倍增长、ondata 交付再复制一份（每份各 ≤ 条目大小），
// 一个超大单条目才是峰值内存的支配项，总量上限管不住它。24 MiB × 3 ≈ 72 MiB，
// 加上请求体（默认 48 MiB 上限）仍落在 isolate 128 MiB 内。
export const GROUP_ZIP_MAX_ENTRY_BYTES = 24 * 1024 * 1024;

// SHA-256("")（空文件条目的内容哈希；大写 hex）
const EMPTY_SHA256 = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';

// 从 zip 字节解析条目集合并计算哈希（服务端校验路径，等价"解压后遍历文件系统"）
// - 目录条目：显式（name 以 '/' 结尾）+ 从文件路径推导的隐式父目录（C# 解压会创建目录并计入）
// - 防穿越：条目名不得解析到解压根之外（上游 ExtractArchiveEntriesAsync 校验）
// - 同名重复条目：上游解压是「首次写入优先」（FileMode.CreateNew + File.Exists 跳过），
//   而 fflate 默认「后者覆盖」。这里显式跳过同名后续条目，与上游保持同一语义（F12）。
// - 解压上限（F9）：改用流式 Unzip（旧实现 unzipSync 会按声明尺寸一次性分配并全量解压），
//   每收到一块解压结果就累计并检查上限，超限抛出 InvalidGroupDataError。
// - 解压预算**随请求体收缩**（2026-09-15）：zip 的压缩体在解压期间一直存活（`contents` 与
//   `zipBytes` 同时占内存），所以「body 上限」与「解压上限」不能各自贴顶。调用方传
//   `groupZipDecompressionCap(zipBytes)`，把两者之和压在 ISOLATE_TRANSFER_BUDGET_BYTES 内。
export function groupZipDecompressionCap(zipBytes: Uint8Array): number {
  const remaining = ISOLATE_TRANSFER_BUDGET_BYTES - zipBytes.length;
  // 峰值不是「body + 解压」而是「body + 2×解压」：全部条目内容被 `contents` 留存一份，
  // fflate 的 ondata 交付与 concatChunks 又各复制一份（单大条目时 ≈ 2 倍）⇒ 预算按 2 分摊。
  // 下限 1 MiB：理论上不会走到（请求体可调到的**上**上限 64 MiB < 预算 96 MiB ⇒ 余量恒 ≥ 32 MiB），
  // 留下它只为防止将来有人把上限调到预算之上时出现"预算为 0 ⇒ 任何 zip 都报错"这种难查的形态。
  return Math.max(1 * 1024 * 1024, Math.min(GROUP_ZIP_MAX_TOTAL_BYTES, remaining / 2));
}

export async function parseGroupZip(
  zipBytes: Uint8Array,
  maxTotalBytes: number = GROUP_ZIP_MAX_TOTAL_BYTES,
): Promise<{ entries: GroupEntrySpec[]; topLevel: string[]; totalSize: number }> {
  // 流式解压不读中央目录，合法性（EOCD 存在）由本函数先判，保持「不是 zip → 抛错」的既有语义
  if (!hasEndOfCentralDirectory(zipBytes)) {
    throw new InvalidGroupDataError('Transfer data is not a zip archive');
  }

  const entryHashes = new Map<string, { hash: string; length: number }>();
  const hashPromises: Promise<void>[] = [];
  const names: string[] = [];
  const seenNames = new Set<string>();
  let entryCount = 0;
  let decompressedBytes = 0;

  const unzip = new Unzip((file) => {
    if (++entryCount > GROUP_ZIP_MAX_ENTRIES) {
      throw new InvalidGroupDataError(`Transfer data contains more than ${GROUP_ZIP_MAX_ENTRIES} entries`);
    }
    if (seenNames.has(file.name)) {
      // 同名重复条目：保留首个（上游首次写入优先）。不调用 start() 即不解压该条目。
      return;
    }
    seenNames.add(file.name);
    names.push(file.name);

    const compressedSize = file.size ?? 0;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      if (chunk.length > 0) {
        size += chunk.length;
        decompressedBytes += chunk.length;
        if (decompressedBytes > maxTotalBytes) {
          throw new InvalidGroupDataError(`Transfer data expands beyond ${maxTotalBytes} bytes`);
        }
        // 单条目上限：fflate 的解压缓冲会按 2 倍增长、ondata 交付又复制一份 ——
        // 一个超大单条目（而非总量）才是峰值内存的支配项；总量上限管不住它。
        // 24 MiB × 3 ≈ 72 MiB + body ≤ 96 MiB 预算（见 groupZipDecompressionCap 的注释）。
        if (size > GROUP_ZIP_MAX_ENTRY_BYTES) {
          throw new InvalidGroupDataError(
            `Transfer data entry exceeds the ${GROUP_ZIP_MAX_ENTRY_BYTES} byte limit: ${file.name}`,
          );
        }
        // 压缩尺寸未知（流式写入的条目）时只能靠总量上限兜底。
        // 体积下限：小文件的比值天然偏高（1KB 文本压到 10 字节 = 100:1 属正常），
        // 只有「解压后 > 8MiB 且比值超限」才判为放大，避免误伤合法小条目。
        if (
          compressedSize > 0 &&
          size > GROUP_ZIP_MIN_RATIO_CHECK_BYTES &&
          size > compressedSize * GROUP_ZIP_MAX_COMPRESSION_RATIO
        ) {
          throw new InvalidGroupDataError(
            `Transfer data entry exceeds the ${GROUP_ZIP_MAX_COMPRESSION_RATIO}:1 compression ratio: ${file.name}`,
          );
        }
        chunks.push(chunk);
      }
      if (final) {
        if (size === 0) {
          entryHashes.set(file.name, { hash: EMPTY_SHA256, length: 0 });
        } else {
          const bytes = concatChunks(chunks);
          // ⚠️ 内容字节用后即弃：只留 32 字节哈希 —— 见 GroupEntrySpec 的注释。
          // ondata 是同步回调，哈希只能异步算：把 promise 收集起来，push 完统一 await。
          hashPromises.push(
            sha256Hex(bytes).then((hash) => {
              entryHashes.set(file.name, { hash, length: size });
            }),
          );
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(zipBytes, true);
  await Promise.all(hashPromises);

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
    const meta = entryHashes.get(rawName);
    if (!meta) {
      // 条目数据流未正常结束（截断/畸形 zip）——不接受半个条目
      throw new InvalidGroupDataError(`Transfer data is invalid with entry: ${rawName}`);
    }
    fileEntries.push({ name: rawName, isDir: false, contentHash: meta.hash, contentLength: meta.length });
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
  const totalSize = fileEntries.reduce((n, e) => n + (e.contentLength ?? 0), 0);

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
  // 盘符与 NUL 必须在入口拒绝，且它们躲得过下面基于 '/' 分段的检查：
  //   `C:/evil`（Windows 绝对路径）没有前导斜杠、也没有 `..` 段；
  //   `a\0b` 带 NUL——落盘时会被截成 `a`，即「名字与哈希时看到的不一致」。
  // 反斜杠已经覆盖了 `C:\evil` 这一形态。
  //
  // 只拒「盘符 + 分隔符」的绝对路径形态，**不能**写成裸的 `^[A-Za-z]:`：
  // `a:b.txt`、`1:30.txt` 这类「第二字符是冒号」的名字在 Linux/macOS 上合法（上游同样按相对路径落盘），
  // 拒掉它们是行为回归（跨平台的上传者会突然收到 422）。
  //
  // 与上游的差别是**有意偏离**（见 docs/protocol.md §10）：上游对越界形态的处置是平台相关的——
  // Windows 上靠 rooted 守卫拒 `C:/evil`（`Path.Combine` 遇 rooted 返回它 ⇒ 不在解压根下），
  // POSIX 上却把它当相对路径落盘（生成名为 `C:` 的目录）；含 NUL 的名字没有专门处理，
  // 落盘时抛未处理异常（500）。本实现不依赖平台，入口一律拒。
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
    throw new InvalidGroupDataError(`Transfer data is invalid with entry: ${name}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(name)) {
    throw new InvalidGroupDataError(`Transfer data is invalid with entry: ${name}`);
  }
  const segments = name.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new InvalidGroupDataError(`Transfer data is invalid with entry: ${name}`);
    }
  }
}

// 最小 zip 合法性判定（与 fflate unzipSync 同一判据）：EOCD 记录（PK\x05\x06）必须出现在
// 末 65558 字节内。流式解压按局部头顺序读，缺失 EOCD 的输入本会被静默当成「空 zip」，
// 因此这一步是「不是 zip → 抛错」语义的承担者。
function hasEndOfCentralDirectory(bytes: Uint8Array): boolean {
  const maxTail = 65558;
  for (let i = bytes.length - 22; i >= 0 && bytes.length - i <= maxTail; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return true;
    }
  }
  return false;
}

// 流式解压按块交付，合并成条目内容（旧 unzipSync 直接返回整块，故此前无此步骤）
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// 服务端 Group 数据校验失败（上游 InvalidDataException / InvalidOperationException → 422 或 400）。
// 「顶层条目为空」由调用方在 parseGroupZip 之后检查 topLevel 并抛 ProfileDataInvalidError
// （对齐上游 ExtractAndVerifyTransferData 的 "Group transfer data contains no entries."），
// 故此处不再另设子类。
export class InvalidGroupDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGroupDataError';
  }
}
