// 服务层共享原语：Profile 校验/持久化、DTO 映射与错误类型。
// 两条写编排在 src/profileWrite.ts（PUT /SyncClipboard.json）与 src/profileHistory.ts（POST /api/history）。
import { HistoryDb, basename, BadRequestError } from './db';
import { R2Storage } from './storage';
import {
  sha256Hex,
  textProfileHash,
  fileProfileHashFromContentHash,
  groupHashFromEntries,
  groupZipDecompressionCap,
  parseGroupZip,
} from './hash';
import { ProfileType, HistoryRecordEntity, ProfileDto } from './types';
import { profileDtoToJson, profileDtoToWire } from './serialization';

// `BadRequestError`/`basename` 的唯一定义处在 src/db.ts；此处转出以保持既有导入面
// （两个路由与 test/limits.test.ts 从 './profile' 取），并与 db 侧 `instanceof` 同源。
export { BadRequestError, basename };

// ===== 异常 =====

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// 传输数据超过 MAX_REQUEST_BODY_BYTES（**按暂存对象的实际大小**判定，不看 content-length）。
// 为什么必须存在这条：`PUT /file/{name}` 是**流式**写 R2 的（不吃内存），把大对象暂存进去
// 完全不花代价；而落库这一步要把它整包读回内存做哈希校验 —— 若只靠 content-length 预检，
// 客户端只要"先流式暂存 100MB、再用一个很小的 JSON 提交"就能绕过预检，让 isolate 在 arrayBuffer()
// 处直接 OOM（后果是同一 isolate 上并发中的**其他**请求一起 503，比 413 严重得多）。
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
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
  /** 传输数据文件（R2 对象）的 SHA-256，大写 hex —— 与 `hash`（Profile 哈希）**不是同一个值**
   * （`fileProfileHash` 是 `sha256(fileName|contentHash)`、Group 是条目哈希）。上游 3.3.0 的
   * `TransferDataHash` 列存的就是它。 */
  transferDataHash: string;
  text: string;
  size: number;
  transferDataFile: string; // 相对工作目录的文件名（= R2 history key 的末段）
  filePaths: string[];
}

export interface NotifyHandlers {
  notifyProfile: (dto: Record<string, unknown>) => Promise<void> | void;
  notifyHistory: (dto: Record<string, unknown>) => Promise<void> | void;
}

// ===== 共享原语 =====

export function hashEquals(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

// 上游 `ToProfileDto` 恒返回 Size = GetSize()（long? 仅 null 时省略；0 也会序列化），
// 因此 inline Text 也带 size，不能在无 data 时省略。
export function entityToProfileDto(e: HistoryRecordEntity): ProfileDto {
  const dto: ProfileDto = { type: e.type, hash: e.hash, text: e.text, hasData: false, size: e.size };
  if (e.transferDataFile !== '') {
    dto.hasData = true;
    dto.dataName = basename(e.transferDataFile);
    // 上游 3.3.0：`TransferDataHash = _hasTransferData ? TransferDataHash : null`（有数据就带）。
    // 只在**合法**时回带：空串/非法值（迁移前入库的旧记录）省略，客户端据此跳过校验
    // （与 GET /data 回带头的同一判据，见 src/routes/history.ts）。
    if (/^[0-9a-fA-F]{64}$/.test(e.transferDataHash ?? '')) {
      dto.transferDataHash = e.transferDataHash!.toUpperCase();
    }
  }
  return dto;
}

// 校验 dto 数据并写入 history 持久区（上游 CreateAndSaveNewProfile 的 SetAndMoveTransferData 等价）
// 校验失败抛 ProfileDataInvalidError（PUT 路径由路由映射为 400）
//
// `contentHash` = 调用方**已经**为 `content` 算出的 SHA-256（PUT 路径核对客户端声明的
// `transferDataHash` 时必然算过一次）。三种类型的持久化结果都要它：
//   · Text  —— 它就是 profile hash 本身
//   · File/Image —— profile hash = sha256(fileName|contentHash)，且 transferDataHash = 它
//   · Group —— transferDataHash = 它（profile hash 是条目哈希，与 zip 字节无关）
// 不传时按需现算。传进来只影响「同一份字节被摘要几遍」，哈希值与落库值逐字节不变。
export async function validateAndPersistData(
  storage: R2Storage,
  dto: ProfileDto,
  dataName: string,
  content: Uint8Array,
  contentHash?: string,
): Promise<PersistedData> {
  const type = dto.type;

  if (type === ProfileType.Text) {
    // 大文本以临时文件传输：哈希 = SHA256hex(内容)
    const hash = await textProfileHashOf(content, dto.hash, contentHash);
    const persisted: PersistedData = {
      hash,
      // 传输文件的 SHA-256 = 同一份字节的哈希（textProfileHashOf 已算过，复用）
      transferDataHash: hash,
      text: dto.text,
      // 上游 TextProfile.Persist：Size = GetSize()，即 dto.Size 优先，缺失时才按全文长度计算
      // （UTF-16 字符数），不是文件的 UTF-8 字节数。
      size: dto.size ?? new TextDecoder().decode(content).length,
      transferDataFile: dataName,
      // 上游 TextProfile.Persist：FilePaths = path is null ? [] : [path]（文本有数据时为文件名）
      filePaths: [dataName],
    };
    await storage.putHistory(type, hash, dataName, content, 'application/octet-stream');
    return persisted;
  }

  if (type === ProfileType.File || type === ProfileType.Image) {
    // 内容字节只摘要一次：它既是 profile hash 的输入，又是 transferDataHash 本身
    const bytesHash = contentHash ?? (await sha256Hex(content));
    const hash = await fileProfileHashFromContentHash(dataName, bytesHash);
    if (dto.hash && !hashEquals(hash, dto.hash)) {
      throw new ProfileDataInvalidError('Hash is not match data.');
    }
    await storage.putHistory(type, hash, dataName, content);
    // 上游 FileProfile(dto).Size = dto.Size 且 GetSize 对非 null 的 Size 直接返回（不再按文件测量）：
    // 声明值优先，缺失时才回退到内容长度。
    return {
      hash,
      transferDataHash: bytesHash,
      text: dataName,
      size: dto.size ?? content.length,
      transferDataFile: dataName,
      filePaths: [dataName],
    };
  }

  if (type === ProfileType.Group) {
    // 解压预算随请求体收缩：压缩体在解压期间一直存活，两者之和必须留在 isolate 预算内
    const { entries, topLevel, totalSize } = await parseGroupZip(content, groupZipDecompressionCap(content));
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
    // 上游 Group 的 Size = 解压后条目长度之和，不是 zip 体积
    return {
      hash,
      // zip **字节**的 SHA-256（≠ 上面的条目哈希）；调用方算过就复用
      transferDataHash: contentHash ?? (await sha256Hex(content)),
      text,
      size: totalSize,
      transferDataFile: dataName,
      filePaths: topLevel,
    };
  }

  throw new ProfileDataInvalidError(`Unsupported profile type: ${ProfileType[type]}`);
}

async function textProfileHashOf(
  content: Uint8Array,
  expected: string,
  contentHash?: string,
): Promise<string> {
  // 上游 PUT 路径按**文件字节**求哈希（TextProfile.SetTransferData → CalculateFileSHA256），
  // 与 POST 路径一致；经解码再编码会在非 UTF-8 字节流上产生偏差。
  const hash = contentHash ?? (await sha256Hex(content));
  if (expected && !hashEquals(hash, expected)) {
    throw new ProfileDataInvalidError('Hash is not match data.');
  }
  return hash;
}

// 当前 profile 的落库 + 广播（PUT 路径命中复用分支与新建分支共用）
export async function saveAndNotifyCurrentProfile(
  db: HistoryDb,
  entity: HistoryRecordEntity,
  notify: NotifyHandlers,
): Promise<void> {
  const dto = entityToProfileDto(entity);
  await db.setCurrentProfileJson(profileDtoToJson(dto));
  await notify.notifyProfile(profileDtoToWire(dto));
}
