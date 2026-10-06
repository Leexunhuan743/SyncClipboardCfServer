// POST /api/history 的写编排（行为对照上游 HistoryService.AddRecordDto）
import { HistoryDb, basename, BadRequestError } from './db';
import { R2Storage } from './storage';
import { sha256Hex, textProfileHash, fileProfileHashFromContentHash, groupHashFromEntries, groupZipDecompressionCap, parseGroupZip } from './hash';
import { ProfileType, HistoryRecordEntity, HistoryRecordDto, HARD_CODED_USER_ID } from './types';
import { entityToDto, entityToDtoWire } from './serialization';
import { ProfileDataInvalidError } from './profile';
import { hashEquals } from './profile';
import type { PersistedData, NotifyHandlers } from './profile';
import { shouldUpdate } from './db';

// ===== 传输数据文件名生成（上游 `Utility.CreateTimeBasedFileName`）=====

// 上游 `GroupProfile.CreateNewDataFileName`：$"File_{CreateTimeBasedFileName()}.zip"
export function createNewGroupDataFileName(now = new Date()): string {
  return `File_${timeStampSuffix(now)}.zip`;
}

// 上游 TextProfile：`_transferDataName ??= $"{Type}_{CreateTimeBasedFileName}.txt"`
export function createNewTextDataFileName(now = new Date()): string {
  return `Text_${timeStampSuffix(now)}.txt`;
}

// 对齐上游 `Utility.CreateTimeBasedFileName()` = $"{yyyy-MM-dd_HH-mm-ss}_{Path.GetRandomFileName()}"。
// `Path.GetRandomFileName()` 的形状是 8 个随机字符 + '.' + 3 个随机字符（随机段自带一个点），
// 这里保持同一形状，避免存储层命名与上游相左。
function timeStampSuffix(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${stamp}_${randomNameSegment()}`;
}

const RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomNameSegment(): string {
  const bytes = new Uint8Array(11);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 11; i++) {
    if (i === 8) out += '.';
    out += RANDOM_CHARS[bytes[i]! % RANDOM_CHARS.length];
  }
  return out;
}

// ===== 入参 =====

export interface IncomingRecord {
  type: ProfileType;
  hash: string;
  text: string;
  size: number;
  createTime: number;
  lastModified: number;
  lastAccessed: number;
  starred: boolean;
  pinned: boolean;
  version: number;
  isDeleted: boolean;
}

// ===== 校验与持久化 =====

// 按明确类型/文件名/哈希校验并持久化（saveTransferData 用）
async function validateAndPersistWithName(
  storage: R2Storage,
  type: ProfileType,
  fileName: string,
  content: Uint8Array,
  expectedHash: string,
): Promise<PersistedData> {
  if (type === ProfileType.File || type === ProfileType.Image) {
    // 内容字节只摘要一次：它既是 profile hash 的输入，又是 transferDataHash 本身
    const bytesHash = await sha256Hex(content);
    const hash = await fileProfileHashFromContentHash(fileName, bytesHash);
    if (expectedHash && !hashEquals(hash, expectedHash)) {
      throw new ProfileDataInvalidError('File transfer data hash mismatch.');
    }
    await storage.putHistory(type, hash, fileName, content);
    // POST 路径忽略 dto.Size：上游 `FileProfile(ProfilePersistentInfo)` 不设置 Size（保持 null），
    // Persist 时回落到实际写入的字节数（与 PUT 路径相反，那边 `FileProfile(ProfileDto)` 会带上 dto.Size）。
    return {
      hash,
      // 传输文件的 SHA-256 是**原样字节**的哈希，与上面的 `hash`（= fileProfileHash）不同
      transferDataHash: bytesHash,
      text: fileName,
      size: content.length,
      transferDataFile: fileName,
      filePaths: [fileName],
    };
  }

  if (type === ProfileType.Group) {
    if (!fileName.toLowerCase().endsWith('.zip')) {
      throw new ProfileDataInvalidError('File is not a zip archive');
    }
    // 解压预算随请求体收缩：压缩体在解压期间一直存活，两者之和必须留在 isolate 预算内
    const { entries, topLevel, totalSize } = await parseGroupZip(content, groupZipDecompressionCap(content));
    if (topLevel.length === 0) {
      throw new ProfileDataInvalidError('Group transfer data contains no entries.');
    }
    const hash = await groupHashFromEntries(entries);
    if (expectedHash && !hashEquals(hash, expectedHash)) {
      throw new ProfileDataInvalidError(`Group data hash mismatch. Expected: ${expectedHash}, Actual: ${hash}`);
    }
    const text = topLevel.join('\n');
    await storage.putHistory(type, hash, fileName, content, 'application/zip');
    // Size = 解压后条目长度之和（上游 totalSize），不是 zip 体积
    return {
      hash,
      // zip **字节**的 SHA-256 ≠ 条目哈希（groupHashFromEntries）
      transferDataHash: await sha256Hex(content),
      text,
      size: totalSize,
      transferDataFile: fileName,
      filePaths: topLevel,
    };
  }

  throw new ProfileDataInvalidError(`Unsupported profile type: ${ProfileType[type]}`);
}

// Text 类型的 transfer data（上游 TextProfile.NeedsTransferData + SaveTransferDataAsync）：
// 上游顺序是「先看内联文本是否已满足声明的哈希」——满足则 NeedsTransferData 返回 null，
// SaveTransferDataAsync 抛 "Profile does not support transfer data."（422）；
// 不满足才回落到「接受上传的数据」并按文件字节校验哈希。故判据不是 size 大小，而是内联哈希是否已匹配声明值。
async function saveTextTransferData(
  storage: R2Storage,
  entity: HistoryRecordEntity,
  content: Uint8Array,
  declaredTransferDataHash: string | null = null,
): Promise<PersistedData> {
  const declared = entity.hash.toUpperCase();
  if (declared) {
    const inlineHash = await textProfileHash(entity.text);
    if (inlineHash === declared) {
      // 内联文本本身就是声明的那份内容 → 上游认为不需要 transfer data → 422
      throw new ProfileDataInvalidError('Profile does not support transfer data.');
    }
  }
  // 上游 SetTransferData(verify:true) 按**文件字节**计算 SHA256 并与实体 Hash 比较
  const hash = await sha256Hex(content);
  if (declared && hash !== declared) {
    throw new ProfileDataInvalidError(
      `Transfer data file content does not match the text hash. Expected: ${declared}, Actual: ${hash}`,
    );
  }
  // 上游 3.3.0 #413：请求头里声明的传输数据哈希同样要核对（没有头 ⇒ null，跳过）
  if (declaredTransferDataHash !== null && !hashEquals(declaredTransferDataHash, hash)) {
    throw new ProfileDataInvalidError('Hash is not match data.');
  }
  // 文件名复用实体已有名（上游 `_transferDataName ?? $"{Type}_{CreateTimeBasedFileName()}.txt"`）：
  // 否则已删除记录带 data 重传会写新随机名、记录仍指向旧名 → /data 404 + 孤儿对象
  const fileName = entity.transferDataFile
    ? basename(entity.transferDataFile)
    : createNewTextDataFileName();
  await storage.putHistory(entity.type, hash, fileName, content, 'text/plain');
  return {
    hash,
    // 同一份字节的 SHA-256 —— 上面已经算过，不要重复算
    transferDataHash: hash,
    text: entity.text, // 内联截断文本保持不变
    // POST 路径的 Size 口径：`ParseLong(metadata,"size")` → 0（缺失/非法时），存入实体后
    // `TextProfile(ProfilePersistentInfo)` 直接赋值 —— `ProfilePersistentInfo.Size` 非空，故不回落到读文件。
    size: entity.size,
    transferDataFile: fileName,
    filePaths: [fileName],
  };
}

// 写数据流到历史区并校验（上游 SaveTransferDataAsync + SetTransferData(verify:true)）
// 校验失败抛 ProfileDataInvalidError → 路由映射 422
async function saveTransferData(
  db: HistoryDb,
  storage: R2Storage,
  entity: HistoryRecordEntity,
  content: Uint8Array,
  declaredTransferDataHash: string | null = null,
): Promise<PersistedData> {
  if (entity.type === ProfileType.Text) {
    return await saveTextTransferData(storage, entity, content, declaredTransferDataHash);
  }
  // File/Image/Group 共用 validateAndPersistWithName；声明的传输数据哈希在下面统一校验
  let fileName: string;
  if (entity.type === ProfileType.Group) {
    fileName = entity.transferDataFile ? basename(entity.transferDataFile) : createNewGroupDataFileName();
  } else {
    if (!entity.text) {
      throw new ProfileDataInvalidError('Profile does not support transfer data.');
    }
    fileName = basename(entity.text);
  }

  try {
    const persisted = await validateAndPersistWithName(
      storage,
      entity.type,
      fileName,
      content,
      entity.hash,
    );
    // 上游 3.3.0 #413：客户端可在请求头里声明传输数据文件的 SHA-256，服务端必须核对（无头 ⇒ null，跳过）
    if (declaredTransferDataHash !== null && !hashEquals(declaredTransferDataHash, persisted.transferDataHash)) {
      throw new ProfileDataInvalidError('Hash is not match data.');
    }
    return persisted;
  } catch (err) {
    if (err instanceof ProfileDataInvalidError) throw err;
    throw new ProfileDataInvalidError(err instanceof Error ? err.message : String(err));
  }
}

// ===== 本地数据校验 =====

// IsLocalDataValid(true) 快速校验（上游 quick 语义）
async function isLocalDataValid(
  storage: R2Storage,
  entity: HistoryRecordEntity,
): Promise<boolean> {
  if (entity.type === ProfileType.Text) {
    // 上游 TextProfile.IsLocalDataValid(quick=true)：
    //   HasTransferData = TransferDataFile 非空 || Size > Text.Length
    //   无 transfer data → true；有 → 要求数据文件存在
    const hasTransferData = entity.transferDataFile !== '' || entity.size > entity.text.length;
    if (!hasTransferData) return true;
    if (entity.transferDataFile === '') return false;
    return !!(await storage.getHistory(entity.type, entity.hash, basename(entity.transferDataFile)));
  }
  if (entity.transferDataFile === '') return false;
  const obj = await storage.getHistory(entity.type, entity.hash, basename(entity.transferDataFile));
  if (!obj) return false;
  if (entity.type === ProfileType.Group && entity.filePaths.length === 0) return false;
  return true;
}

// 严格校验（上游 `IsLocalDataValid(quick: false)`，只服务「POST 新建记录、无 data」这一处）。
// 判据是**两条**（`TextProfile.IsLocalDataValid(false)` → `IsInMemoryTextValid`）：
//   ① `HasTransferData = TransferDataFile 非空 || Size > Text.Length` 为真 ⇒ false ——
//      「声称正文比内联文本更长」却没有数据文件，说明 `text` 只是截断预览；
//   ② 否则内联全文哈希必须等于声明 Hash。**空 hash 视为有效**：上游是 `Hash is not null && !SHA256Same(...)`
//      才判失败（服务端会为它算哈希，也是 PUT {"size":5} 这类"无 hash 的 inline Text"能落库的前提）。
// 本函数只服务「无 data 的新建」这一处，`TransferDataFile` 恒为 `''` ⇒ ① 只剩 `Size > Text.Length` 可能为真。
// File/Image/Group 没有内联数据（新建记录此时也还没有数据文件）⇒ 一律 false。
async function isLocalDataValidStrict(entity: HistoryRecordEntity): Promise<boolean> {
  if (entity.type !== ProfileType.Text) return false;
  if (entity.size > entity.text.length) return false;
  if (!entity.hash) return true;
  return hashEquals(await textProfileHash(entity.text), entity.hash);
}

// 已删除记录的本地数据校验（上游 EnsureExistingRecordData）
async function ensureExistingRecordData(
  storage: R2Storage,
  existing: HistoryRecordEntity,
): Promise<void> {
  if (!(await isLocalDataValid(storage, existing))) {
    throw new BadRequestError('Needs tranfer data.'); // `tranfer` = 上游拼写
  }
}

// ===== 编排 =====

export async function addRecordDto(
  db: HistoryDb,
  storage: R2Storage,
  incoming: IncomingRecord,
  content: Uint8Array | null,
  notify: NotifyHandlers,
  /** 请求头 `X-SyncClipboard-Transfer-Data-Hash` 的声明值（已归一化、大写；null = 客户端未声明）。
   *  上游 3.3.0 #413：声明值与文件实际 SHA-256 不符 ⇒ 422（上游把 `InvalidDataException` 包成
   *  `HistoryTransferDataException` → ProblemDetails 422；本实现同状态码、同形错误体）。 */
  declaredTransferDataHash: string | null = null,
): Promise<HistoryRecordDto> {
  const existing = await db.getByTypeAndHash(incoming.type, incoming.hash);
  if (existing) {
    // UpdateExistingRecordDto
    if (existing.isDeleted) {
      if (content) {
        const persisted = await saveTransferData(db, storage, existing, content, declaredTransferDataHash); // 失败 → ProfileDataInvalidError（422）
        // 补数据后确保记录指向实际写入位置（正常场景复用旧名、路径不变；
        // 同时覆盖记录原本无名字的异常场景，避免复活后 /data 404）
        if (existing.transferDataFile !== persisted.transferDataFile) {
          existing.transferDataFile = persisted.transferDataFile;
          existing.transferDataHash = persisted.transferDataHash;
          existing.filePaths = persisted.filePaths;
          await db.updateEntity(existing);
        }
      } else {
        await ensureExistingRecordData(storage, existing); // 失败 → BadRequestError（400）
      }
    }

    const shouldUpdateFlag =
      existing.isDeleted ||
      shouldUpdate(
        existing.version,
        incoming.version,
        existing.lastModified,
        incoming.lastModified,
      );
    if (shouldUpdateFlag) {
      existing.createTime = incoming.createTime;
      existing.lastAccessed = incoming.lastAccessed;
      existing.lastModified = incoming.lastModified;
      existing.stared = incoming.starred;
      existing.pinned = incoming.pinned;
      existing.version = Math.max(incoming.version, existing.version + 1);
      existing.isDeleted = incoming.isDeleted;
      await db.updateEntity(existing);
      await notify.notifyHistory(entityToDtoWire(existing));
      // **软删不再清数据目录**：真回收站要能**连数据**把记录拿回来，所以数据留到"真的没了"那一刻
      // （30 天硬删 / 用户点「彻底删除」/「清空回收站」）。别照上游的 DeleteProfileDataIfNeed 加回来 ——
      // 那会让回收站对图片/文件又变成单向门。
    }
    return entityToDto(existing);
  }

  // AddNewRecordDto
  const entity: HistoryRecordEntity = {
    userId: HARD_CODED_USER_ID,
    type: incoming.type,
    text: incoming.text,
    size: incoming.size,
    transferDataFile: '',
    filePaths: [],
    hash: incoming.hash.toUpperCase(),
    createTime: incoming.createTime,
    lastAccessed: incoming.lastAccessed,
    lastModified: incoming.lastModified,
    stared: incoming.starred,
    pinned: incoming.pinned,
    version: incoming.version,
    isDeleted: incoming.isDeleted,
  };

  if (content) {
    const persisted = await saveTransferData(db, storage, entity, content, declaredTransferDataHash); // 失败 → 422
    entity.text = persisted.text;
    entity.size = persisted.size;
    entity.hash = persisted.hash;
    entity.transferDataFile = persisted.transferDataFile;
    entity.transferDataHash = persisted.transferDataHash;
    entity.filePaths = persisted.filePaths;
  }

  if (content === null && !(await isLocalDataValidStrict(entity))) {
    // 新建记录的无 data 分支用严格校验（内联全文哈希必须等于声明 Hash；
    // File/Image/Group 没有数据文件 ⇒ 一律拒绝）。
    throw new BadRequestError('Local data is missing or does not match the profile hash.');
  }

  const inserted = await db.insert(entity);
  await notify.notifyHistory(entityToDtoWire(inserted));
  // 同上：这条新记录若自带 `isDeleted: true`，它的数据同样留在回收站里等硬删。
  return entityToDto(inserted);
}
