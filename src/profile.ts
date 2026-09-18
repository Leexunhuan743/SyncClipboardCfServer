// 服务层：Profile 校验/持久化与历史记录编排（行为对照上游 HistoryService / SyncClipboardController）
import { HistoryDb, shouldUpdate } from './db';
import { R2Storage, tempKey } from './storage';
import { sha256Hex, textProfileHash, fileProfileHash, groupHashFromEntries, parseGroupZip, InvalidGroupDataError, EmptyGroupDataError } from './hash';
import { ProfileType, HistoryRecordEntity, HistoryRecordDto, ProfileDto, HARD_CODED_USER_ID } from './types';
import { profileDtoToJson, profileDtoToWire, entityToDto, entityToDtoWire } from './serialization';

// ===== 异常 =====

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// 数据校验失败（上游 InvalidDataException / InvalidOperationException 系列）
// 映射：PUT SyncClipboard.json → 400 "Hash is not match data."；POST /api/history → 422
export class ProfileDataInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileDataInvalidError';
  }
}

// ===== 类型 =====

export interface PersistedData {
  hash: string;
  text: string;
  size: number;
  transferDataFile: string; // 相对工作目录的文件名（= R2 history key 的末段）
  filePaths: string[];
}

export interface NotifyHandlers {
  notifyProfile: (dto: Record<string, unknown>) => Promise<void> | void;
  notifyHistory: (dto: Record<string, unknown>) => Promise<void> | void;
}

// 生成 Group 上传文件的新名称（上游 `GroupProfile.CreateNewDataFileName`）
// 上游：$"File_{Utility.CreateTimeBasedFileName()}.zip" —— 后缀是 `.zip`（此前误写成 `.tmp.zip`，
// 与上游命名不符；虽然 SetTransferData 只校验 EndsWith(".zip") 故功能未受影响，仍属多余偏差）
export function createNewGroupDataFileName(now = new Date()): string {
  return `File_${timeStampSuffix(now)}.zip`;
}

// 生成 Text 传输数据文件的新名称（上游 TextProfile：_transferDataName ??= $"{Type}_{CreateTimeBasedFileName}.txt"）
export function createNewTextDataFileName(now = new Date()): string {
  return `Text_${timeStampSuffix(now)}.txt`;
}

// 对齐上游 `Utility.CreateTimeBasedFileName()` = $"{DateTime.Now:yyyy-MM-dd_HH-mm-ss}_{Path.GetRandomFileName()}"。
// 注意 `Path.GetRandomFileName()` 的形状是 8 个随机字符 + '.' + 3 个随机字符（含点），故上游文件名里
// 随机段自带一个点；这里保持同一形状，避免存储层命名与上游相左。
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

// 上游 `Profile.Create(ProfileDto dto)`：type=File 且 DataName 是图片扩展名时**提升为 ImageProfile**，
// 因此落库的 Type 是 Image 而非 File。扩展名表取自上游 `ImageTool.ImageExtensions`
// （注意不含 webp/heic/avif —— 那些在 ImageHelper.ExImageExtensions，仅供本机转换判断）。
// 仅 PUT /SyncClipboard.json 走这条 Promotion；POST /api/history 不提升（上游 HistoryService 直接用
// dto.Type 建 profile），故此处只用于 PUT 路径。
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.gif', '.bmp', '.png']);

export function resolveCreateProfileType(dto: ProfileDto): ProfileType {
  if (dto.type === ProfileType.File && dto.dataName) {
    const dot = dto.dataName.lastIndexOf('.');
    if (dot >= 0 && IMAGE_EXTENSIONS.has(dto.dataName.slice(dot).toLowerCase())) {
      return ProfileType.Image;
    }
  }
  return dto.type;
}

// ===== 数据校验与持久化 =====

// 校验 dto 数据并写入 history 持久区（CreateAndSaveNewProfile 的 SetAndMoveTransferData 等价）
// 校验失败抛 ProfileDataInvalidError（PUT 路径由路由映射为 400）
export async function validateAndPersistData(
  storage: R2Storage,
  dto: ProfileDto,
  dataName: string,
  content: Uint8Array,
): Promise<PersistedData> {
  const type = dto.type;

  if (type === ProfileType.Text) {
    // 大文本以临时文件传输：哈希 = SHA256hex(内容)
    const hash = await textProfileHashOf(content, dto.hash);
    const persisted: PersistedData = {
      hash,
      text: dto.text,
      // 上游 TextProfile.Persist：Size = GetSize()，即 dto.Size 优先，缺失时才按全文长度计算
      // （UTF-16 字符数），不是文件的 UTF-8 字节数（F11）
      size: dto.size ?? new TextDecoder().decode(content).length,
      transferDataFile: dataName,
      // 上游 TextProfile.Persist：FilePaths = path is null ? [] : [path]（文本有数据时为文件名）
      filePaths: [dataName],
    };
    await storage.putHistory(type, hash, dataName, content, 'application/octet-stream');
    return persisted;
  }

  if (type === ProfileType.File || type === ProfileType.Image) {
    const hash = await fileProfileHash(dataName, content);
    if (dto.hash && !hashEquals(hash, dto.hash)) {
      throw new ProfileDataInvalidError('Hash is not match data.');
    }
    await storage.putHistory(type, hash, dataName, content);
    // 上游 FileProfile(dto).Size = dto.Size 且 GetSize 对非 null 的 Size 直接返回（不再按文件测量）：
    // 声明值优先，缺失时才回退到内容长度（F11）
    return { hash, text: dataName, size: dto.size ?? content.length, transferDataFile: dataName, filePaths: [dataName] };
  }

  if (type === ProfileType.Group) {
    const { entries, topLevel, totalSize } = parseGroupZip(content);
    if (topLevel.length === 0) {
      throw new ProfileDataInvalidError('Group transfer data contains no entries.');
    }
    const hash = await groupHashFromEntries(entries);
    if (dto.hash && !hashEquals(hash, dto.hash)) {
      throw new ProfileDataInvalidError('Hash is not match data.');
    }
    // text = 顶层条目 basename，\n 连接（上游 GroupProfile.Persist）
    const text = topLevel.join('\n');
    await storage.putHistory(type, hash, dataName, content, 'application/zip');
    // 上游 Group 的 Size = 解压后条目长度之和，不是 zip 体积（F11）
    return { hash, text, size: totalSize, transferDataFile: dataName, filePaths: topLevel };
  }

  throw new ProfileDataInvalidError(`Unsupported profile type: ${ProfileType[type]}`);
}

async function textProfileHashOf(content: Uint8Array, expected: string): Promise<string> {
  // 上游 PUT 路径按**文件字节**求哈希（TextProfile.SetTransferData → CalculateFileSHA256），
  // 与 POST 路径一致；经解码再编码会在非 UTF-8 字节流上产生偏差。
  const hash = await sha256Hex(content);
  if (expected && !hashEquals(hash, expected)) {
    throw new ProfileDataInvalidError('Hash is not match data.');
  }
  return hash;
}

// ===== 当前 Profile（Meta）=====

export function entityToProfileDto(e: HistoryRecordEntity): ProfileDto {
  // 上游 ToProfileDto 恒返回 Size = GetSize()（long? 仅 null 时省略；0 也会序列化），
  // 因此 inline Text 也带 size，不能在无 data 时省略（F11）。
  const dto: ProfileDto = { type: e.type, hash: e.hash, text: e.text, hasData: false, size: e.size };
  if (e.transferDataFile !== '') {
    dto.hasData = true;
    dto.dataName = basenameOf(e.transferDataFile);
  }
  return dto;
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

async function saveAndNotifyCurrentProfile(
  db: HistoryDb,
  entity: HistoryRecordEntity,
  notify: NotifyHandlers,
): Promise<void> {
  const dto = entityToProfileDto(entity);
  await db.setCurrentProfileJson(profileDtoToJson(dto));
  await notify.notifyProfile(profileDtoToWire(dto));
}

// ===== PUT /SyncClipboard.json 编排 =====

export async function putSyncProfile(
  db: HistoryDb,
  storage: R2Storage,
  dto: ProfileDto,
  notify: NotifyHandlers,
): Promise<HistoryRecordEntity> {
  const now = Date.now();

  // GetExistingProfileAsync 分支：命中且未删除 → 复用记录
  if (dto.hash) {
    const existing = await db.getByTypeAndHash(dto.type, dto.hash);
    if (existing && !existing.isDeleted) {
      existing.lastModified = now;
      existing.lastAccessed = now;
      existing.version++;
      await db.updateEntity(existing);
      await notify.notifyHistory(entityToDtoWire(existing));
      await saveAndNotifyCurrentProfile(db, existing, notify);
      return existing;
    }
  }

  // CreateAndSaveNewProfile 分支：上游 `Profile.Create(dto)` 会把 File+图片扩展名提升为 Image，
  // 落库类型随之改变；但上面的既有记录查询用的是 **原始 dto.Type**（上游 GetExistingProfileAsync
  // 在 Create 之前调用），故这里只在创建分支使用提升后的类型。
  const createDto: ProfileDto = { ...dto, type: resolveCreateProfileType(dto) };
  let persisted: PersistedData | null = null;
  if (dto.hasData) {
    if (!dto.dataName) {
      throw new BadRequestError('DataName cannot be null or empty when HasData is true');
    }
    const fileName = basenameOf(dto.dataName);
    const temp = await storage.getTemp(fileName);
    if (!temp) {
      throw new NotFoundError('Transfer data file not found');
    }
    const content = new Uint8Array(await temp.arrayBuffer());
    try {
      persisted = await validateAndPersistData(storage, createDto, fileName, content);
    } catch (err) {
      // 上游 catch 全部异常 → BadRequest("Hash is not match data.")
      throw new BadRequestError('Hash is not match data.');
    }
    // 上游 SetAndMoveTransferData 是 File.Move：暂存被服务器消费掉，成功后不再保留（F4）。
    // 删除失败不影响主响应（数据已落持久区），故放在 try 之外。
    await storage.deleteTemp(fileName);
  }

  // File/Image/Group 必须有传输数据：上游这些 Profile 的 Persist() 在没有数据时抛异常
  // （FileProfile: "Cannot persist a FileProfile with no data."；GroupProfile:
  // "No local data available to prepare persistent storage."），请求被拒绝。
  // 此前本实现静默入库 → 写入一条永远取不到数据的坏记录，并把当前 profile 也污染成
  // 无数据形态（客户端拉到后反复重试下载 404）。这里明确拒绝（400 而非上游的未处理异常 500）。
  if (!persisted && createDto.type !== ProfileType.Text) {
    throw new BadRequestError(
      `Transfer data is required for ${ProfileType[createDto.type]} profile`,
    );
  }

  const entity = await addProfile(db, createDto, persisted, now, notify.notifyHistory);
  await saveAndNotifyCurrentProfile(db, entity, notify);
  return entity;
}

// AddProfile 语义：已存在（含 IsDeleted）→ 复活/更新；否则新建
async function addProfile(
  db: HistoryDb,
  dto: ProfileDto,
  persisted: PersistedData | null,
  now: number,
  notifyHistory: (dto: Record<string, unknown>) => Promise<void> | void,
): Promise<HistoryRecordEntity> {
  const existing = dto.hash ? await db.getByTypeAndHash(dto.type, dto.hash) : null;
  if (existing) {
    const merged = await mergeExistingProfile(db, existing, persisted, now);
    await notifyHistory(entityToDtoWire(merged));
    return merged;
  }

  const entity: HistoryRecordEntity = {
    userId: HARD_CODED_USER_ID,
    type: dto.type,
    text: persisted?.text ?? dto.text,
    // inline Text 的 Size 取客户端声明值（= 文本长度），缺失时回退文本长度；
    // 上游 TextProfile(dto) 的 Size 来自 dto.Size，而非硬编码 0（F11）
    size: persisted?.size ?? dto.size ?? defaultInlineSize(dto),
    transferDataFile: persisted?.transferDataFile ?? '',
    filePaths: persisted?.filePaths ?? [],
    hash: (persisted?.hash ?? dto.hash ?? '').toUpperCase(),
    createTime: now,
    lastAccessed: now,
    lastModified: now,
    stared: false,
    pinned: false,
    version: 0,
    isDeleted: false,
  };
  // 上游 TextProfile 对空 hash 会 ComputeHash(全文) 并存储计算值，而不是存空串（F11）；
  // 否则同内容的重复 PUT 永远命中不到历史复用分支，历史会持续膨胀。
  if (entity.hash === '' && entity.type === ProfileType.Text) {
    entity.hash = await textProfileHash(entity.text);
  }
  // 并发抢先插入同 hash（唯一约束冲突）时，走 AddProfile 的既有行分支，
  // 而不是 insert() 默认的 AddRecordDto 合并语义（F5）
  const inserted = await db.insert(entity, (conflict) =>
    mergeExistingProfile(db, conflict, persisted, now),
  );
  await notifyHistory(entityToDtoWire(inserted));
  return inserted;
}

// 上游 AddProfile 的「已存在」分支：复活该记录、用本次持久化结果覆盖内容字段、版本自增。
// 同时作为 insert() 并发冲突（唯一约束）时的合并回调，保证两条路径语义一致。
async function mergeExistingProfile(
  db: HistoryDb,
  existing: HistoryRecordEntity,
  persisted: PersistedData | null,
  now: number,
): Promise<HistoryRecordEntity> {
  existing.lastAccessed = now;
  existing.isDeleted = false;
  existing.lastModified = now;
  if (persisted) {
    existing.transferDataFile = persisted.transferDataFile;
    existing.filePaths = persisted.filePaths;
    existing.text = persisted.text;
    existing.size = persisted.size;
  }
  existing.version++;
  await db.updateEntity(existing);
  return existing;
}

function defaultInlineSize(dto: ProfileDto): number {
  return dto.type === ProfileType.Text ? dto.text.length : 0;
}

// ===== POST /api/history 编排（上游 HistoryService.AddRecordDto）=====

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

export async function addRecordDto(
  db: HistoryDb,
  storage: R2Storage,
  incoming: IncomingRecord,
  content: Uint8Array | null,
  notify: NotifyHandlers,
): Promise<HistoryRecordDto> {
  const existing = await db.getByTypeAndHash(incoming.type, incoming.hash);
  if (existing) {
    // UpdateExistingRecordDto
    if (existing.isDeleted) {
      if (content) {
        const persisted = await saveTransferData(db, storage, existing, content); // 失败 → ProfileDataInvalidError（422）
        // 补数据后确保记录指向实际写入位置（正常场景复用旧名、路径不变；
        // 同时覆盖记录原本无名字的异常场景，避免复活后 /data 404）
        if (existing.transferDataFile !== persisted.transferDataFile) {
          existing.transferDataFile = persisted.transferDataFile;
          existing.filePaths = persisted.filePaths;
          await db.updateEntity(existing);
        }
      } else {
        await ensureExistingRecordData(db, storage, existing); // 失败 → BadRequestError（400）
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
      await deleteDataIfNeed(db, storage, existing);
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
    const persisted = await saveTransferData(db, storage, entity, content); // 失败 → 422
    entity.text = persisted.text;
    entity.size = persisted.size;
    entity.hash = persisted.hash;
    entity.transferDataFile = persisted.transferDataFile;
    entity.filePaths = persisted.filePaths;
  }

  if (!(await isLocalDataValid(db, storage, entity))) {
    throw new BadRequestError('Needs tranfer data.');
  }

  const inserted = await db.insert(entity);
  await notify.notifyHistory(entityToDtoWire(inserted));
  await deleteDataIfNeed(db, storage, inserted);
  return entityToDto(inserted);
}

// 写数据流到历史区并校验（上游 SaveTransferDataAsync + SetTransferData(verify:true)）
// 校验失败抛 ProfileDataInvalidError → 路由映射 422
async function saveTransferData(
  db: HistoryDb,
  storage: R2Storage,
  entity: HistoryRecordEntity,
  content: Uint8Array,
): Promise<PersistedData> {
  if (entity.type === ProfileType.Text) {
    return await saveTextTransferData(storage, entity, content);
  }

  // 写入文件名（上游 NeedsTransferData）：
  //   File/Image：{entity.text}（multipart text = 文件名）
  //   Group：复用实体已有 _transferDataName（上游 `_transferDataName ?? CreateNewDataFileName()`），
  //         否则已删除记录带 data 重传时会写到新随机名，记录仍指向旧名 → /data 404 且留下孤儿对象
  let fileName: string;
  if (entity.type === ProfileType.Group) {
    fileName = entity.transferDataFile ? basenameOf(entity.transferDataFile) : createNewGroupDataFileName();
  } else {
    if (!entity.text) {
      throw new ProfileDataInvalidError('Profile does not support transfer data.');
    }
    fileName = basenameOf(entity.text);
  }

  try {
    return await validateAndPersistWithName(
      storage,
      entity.type,
      fileName,
      content,
      entity.hash,
    );
  } catch (err) {
    if (err instanceof ProfileDataInvalidError) throw err;
    throw new ProfileDataInvalidError(err instanceof Error ? err.message : String(err));
  }
}

// Text 类型的 transfer data（上游 TextProfile.NeedsTransferData + SaveTransferDataAsync）：
// 上游顺序是「先看内联文本是否已满足声明的哈希」——满足则 NeedsTransferData 返回 null，
// SaveTransferDataAsync 抛 "Profile does not support transfer data."（422）；
// 不满足才回落到「接受上传的数据」并按文件字节校验哈希。
// 因此判据不是 size 的大小，而是内联哈希是否已匹配声明值（F2/F14）。
async function saveTextTransferData(
  storage: R2Storage,
  entity: HistoryRecordEntity,
  content: Uint8Array,
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
  // 文件名复用实体已有名（上游 `_transferDataName ?? $"{Type}_{CreateTimeBasedFileName()}.txt"`）：
  // 否则已删除记录带 data 重传会写新随机名、记录仍指向旧名 → /data 404 + 孤儿对象（同 B1/Group）
  const fileName = entity.transferDataFile
    ? basenameOf(entity.transferDataFile)
    : createNewTextDataFileName();
  await storage.putHistory(entity.type, hash, fileName, content, 'text/plain');
  return {
    hash,
    text: entity.text, // 内联截断文本保持不变（上游 _text）
    // 上游 POST 路径的 Size 口径：`HistoryService.ParseLong(metadata,"size")` → 0（缺失/非法时），
    // 存入实体后 `TextProfile(ProfilePersistentInfo)` 赋值 `Size = entity.Size`
    // —— `ProfilePersistentInfo.Size` 是 `required long`（非空），故 `GetSize()` 直接返回它，
    // **不会回落到读文件**（该回落只存在于 PUT 路径：`TextProfile(ProfileDto)` 的 `Size` 可为 null）。
    size: entity.size,
    transferDataFile: fileName,
    filePaths: [fileName],
  };
}

// 按明确类型/文件名/哈希校验并持久化（saveTransferData 用）
async function validateAndPersistWithName(
  storage: R2Storage,
  type: ProfileType,
  fileName: string,
  content: Uint8Array,
  expectedHash: string,
): Promise<PersistedData> {
  if (type === ProfileType.File || type === ProfileType.Image) {
    const hash = await fileProfileHash(fileName, content);
    if (expectedHash && !hashEquals(hash, expectedHash)) {
      throw new ProfileDataInvalidError('File transfer data hash mismatch.');
    }
    await storage.putHistory(type, hash, fileName, content);
    // 上游 POST 路径此处**忽略 dto.Size**：`FileProfile(ProfilePersistentInfo)` 不设置 Size
    // （保持 null）→ Persist 时 `GetSize()` 走 ComputeSize → `FileInfo(FullPath).Length`，
    // 即实际写入的字节数。（PUT 路径相反：`FileProfile(ProfileDto)` 会带上 dto.Size，故那边优先声明值。）
    return { hash, text: fileName, size: content.length, transferDataFile: fileName, filePaths: [fileName] };
  }

  if (type === ProfileType.Group) {
    if (!fileName.toLowerCase().endsWith('.zip')) {
      throw new ProfileDataInvalidError('File is not a zip archive');
    }
    const { entries, topLevel, totalSize } = parseGroupZip(content);
    if (topLevel.length === 0) {
      throw new ProfileDataInvalidError('Group transfer data contains no entries.');
    }
    const hash = await groupHashFromEntries(entries);
    if (expectedHash && !hashEquals(hash, expectedHash)) {
      throw new ProfileDataInvalidError(`Group data hash mismatch. Expected: ${expectedHash}, Actual: ${hash}`);
    }
    const text = topLevel.join('\n');
    await storage.putHistory(type, hash, fileName, content, 'application/zip');
    // Size = 解压后条目长度之和（上游 totalSize），不是 zip 体积（F11）
    return { hash, text, size: totalSize, transferDataFile: fileName, filePaths: topLevel };
  }

  throw new ProfileDataInvalidError(`Unsupported profile type: ${ProfileType[type]}`);
}

// IsLocalDataValid(true) 快速校验（上游 quick 语义）
async function isLocalDataValid(
  db: HistoryDb,
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
    return !!(await storage.getHistory(entity.type, entity.hash, basenameOf(entity.transferDataFile)));
  }
  if (entity.transferDataFile === '') return false;
  const obj = await storage.getHistory(entity.type, entity.hash, basenameOf(entity.transferDataFile));
  if (!obj) return false;
  if (entity.type === ProfileType.Group && entity.filePaths.length === 0) return false;
  return true;
}

// 已删除记录的本地数据校验（上游 EnsureExistingRecordData）
async function ensureExistingRecordData(
  db: HistoryDb,
  storage: R2Storage,
  existing: HistoryRecordEntity,
): Promise<void> {
  if (!(await isLocalDataValid(db, storage, existing))) {
    throw new BadRequestError('Needs tranfer data.');
  }
}

// IsDeleted 时删除历史工作目录（上游 DeleteProfileDataIfNeed）
async function deleteDataIfNeed(
  db: HistoryDb,
  storage: R2Storage,
  entity: HistoryRecordEntity,
): Promise<void> {
  if (!entity.isDeleted) return;
  await storage.deleteHistoryWorkingDir(entity.type, entity.hash);
}

function hashEquals(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}
