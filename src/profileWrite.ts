// PUT /SyncClipboard.json 的写编排（行为对照上游 SyncClipboardController.CreateAndSaveNewProfile）
import { HistoryDb, basename, BadRequestError } from './db';
import { R2Storage } from './storage';
import { MAX_REQUEST_BODY_BYTES } from './requestLimits';
import { sha256Hex, textProfileHash } from './hash';
import { ProfileType, HistoryRecordEntity, ProfileDto, HARD_CODED_USER_ID } from './types';
import { profileDtoToJson, profileDtoToWire, entityToDtoWire } from './serialization';
import { NotFoundError, PayloadTooLargeError, ProfileDataInvalidError } from './profile';
import { validateAndPersistData, entityToProfileDto, hashEquals } from './profile';
import type { PersistedData, NotifyHandlers } from './profile';

// 上游 `Profile.Create(ProfileDto dto)`：type=File 且 DataName 是图片扩展名时**提升为 ImageProfile**，
// 因此落库的 Type 是 Image 而非 File。扩展名表取自上游 `ImageTool.ImageExtensions`
// （不含 webp/heic/avif —— 那些在 ImageHelper.ExImageExtensions，仅供本机转换判断）。
// 只有本路径做提升；POST /api/history 直接用 dto.Type 建 profile。
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

// PUT /SyncClipboard.json 的无 data 分支（上游 `CreateAndSaveNewProfile` 的 `IsLocalDataValid(false)`）：
// Text = 内联全文哈希 == 声明 Hash（空 hash 视为有效）；其余类型没有内联数据 ⇒ false（要 data 文件）。
async function isInlineDataValid(dto: ProfileDto): Promise<boolean> {
  if (dto.type !== ProfileType.Text) return false;
  if (!dto.hash) return true;
  return hashEquals(await textProfileHash(dto.text), dto.hash);
}

function defaultInlineSize(dto: ProfileDto): number {
  return dto.type === ProfileType.Text ? dto.text.length : 0;
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
    existing.transferDataHash = persisted.transferDataHash;
    existing.filePaths = persisted.filePaths;
    existing.text = persisted.text;
    existing.size = persisted.size;
  }
  existing.version++;
  await db.updateEntity(existing);
  return existing;
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
    // inline Text 的 Size 取客户端声明值（= 文本长度），缺失时回退文本长度（上游 TextProfile(dto) 的 Size 来自 dto.Size）
    size: persisted?.size ?? dto.size ?? defaultInlineSize(dto),
    transferDataFile: persisted?.transferDataFile ?? '',
    transferDataHash: persisted?.transferDataHash ?? '',
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
  // 空 hash 的 Text 记录要存计算出的全文哈希（而非空串），否则同内容的重复 PUT 命中不到历史复用分支。
  if (entity.hash === '' && entity.type === ProfileType.Text) {
    entity.hash = await textProfileHash(entity.text);
  }
  // 并发抢先插入同 hash（唯一约束冲突）时走 AddProfile 的既有行分支，而不是 insert() 默认的 AddRecordDto 合并语义
  const inserted = await db.insert(entity, (conflict) =>
    mergeExistingProfile(db, conflict, persisted, now),
  );
  await notifyHistory(entityToDtoWire(inserted));
  return inserted;
}

export async function putSyncProfile(
  db: HistoryDb,
  storage: R2Storage,
  dto: ProfileDto,
  notify: NotifyHandlers,
  // 传输数据上限（由调用方传 maxRequestBodyBytes(env)，见 src/requestLimits.ts）。默认取常量供测试直接调用。
  maxDataBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<HistoryRecordEntity> {
  const now = Date.now();

  // 上游 3.3.0 #413：`TransferDataHash` 只能在 `hasData=true` 时声明，否则是自相矛盾的请求。
  // ⚠️ 位置与上游一致：在既有记录复用分支**之前**（上游先在控制器里判，再查既有 profile）。
  // 官方客户端不会发这种组合，但它是可观测的协议面行为，不该与上游分叉。
  if (!dto.hasData && dto.transferDataHash !== null && dto.transferDataHash !== undefined) {
    throw new BadRequestError('TransferDataHash cannot be set when HasData is false');
  }

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
  // 落库类型随之改变；但上面的既有记录查询用的是**原始 dto.Type**（GetExistingProfileAsync 在 Create 之前调用），
  // 故这里只在创建分支使用提升后的类型。
  const createDto: ProfileDto = { ...dto, type: resolveCreateProfileType(dto) };
  let persisted: PersistedData | null = null;
  if (dto.hasData) {
    if (!dto.dataName) {
      throw new BadRequestError('DataName cannot be null or empty when HasData is true');
    }
    const fileName = basename(dto.dataName);
    const temp = await storage.getTemp(fileName);
    if (!temp) {
      throw new NotFoundError('Transfer data file not found');
    }
    // 按**对象实际大小**判定（不信 content-length）：暂存是流式的，只靠 content-length 预检会被绕过，
    // 落库这一步整包读回内存做哈希校验才是内存的真实护栏。
    if (temp.size > maxDataBytes) {
      await storage.deleteTemp(fileName);
      throw new PayloadTooLargeError(
        `Transfer data exceeds the ${maxDataBytes} byte limit (staged object is ${temp.size} bytes)`,
      );
    }
    const content = new Uint8Array(await temp.arrayBuffer());
    try {
      // 上游 3.3.0 #413：`ProfileDto.TransferDataHash` 声明的是**传输数据文件的 SHA-256**，
      // 声明了就必须与暂存文件的实际字节一致（不符 ⇒ 400）；没声明则跳过（旧客户端不受影响）。
      // 这一次摘要同时是 File/Image 的 profile 哈希输入与 transferDataHash 本身，故往下传，
      // 避免 validateAndPersistData 对同一份字节再摘要一遍。
      let contentHash: string | undefined;
      if (dto.transferDataHash !== null && dto.transferDataHash !== undefined) {
        contentHash = await sha256Hex(content);
        if (!hashEquals(dto.transferDataHash, contentHash)) {
          throw new ProfileDataInvalidError('Hash is not match data.');
        }
      }
      persisted = await validateAndPersistData(storage, createDto, fileName, content, contentHash);
    } catch {
      // 上游 catch 全部异常 → BadRequest("Hash is not match data.")
      throw new BadRequestError('Hash is not match data.');
    }
    // 上游 SetAndMoveTransferData 是 File.Move：暂存被服务器消费掉，成功后不再保留。
    // 删除失败不影响主响应（数据已落持久区），故放在 try 之外。
    await storage.deleteTemp(fileName);
  }

  // File/Image/Group 必须有传输数据；Text 可以只有内联文本，但**必须**与声明哈希一致（严格校验）。
  // 上游 3.3.0（#413）：`!HasData && !IsLocalDataValid(false)` ⇒ 400 `Inline data does not match the profile hash.`
  if (!dto.hasData && !(await isInlineDataValid(createDto))) {
    throw new BadRequestError('Inline data does not match the profile hash.');
  }

  const entity = await addProfile(db, createDto, persisted, now, notify.notifyHistory);
  await saveAndNotifyCurrentProfile(db, entity, notify);
  return entity;
}
