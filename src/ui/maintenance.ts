// 后台维护端点：数据完整性自检（docs/backend-gaps.md §2.4）与保留策略在线可调（§2.5）。
//
// 保留策略**没有单独的读端点**：生效值与来源（env / meta）都随 `/ui/api/info` 一起返回 ——
// 界面只打开部署信息对话框，为它多开一条 GET 只会留下一个无人调用的端点（复核时删掉的正是这种）。
//
// 注册纪律：本文件的路由必须由 createUiRoutes() 注册在 `app.route('/', guarded)` **之后** ——
// `/ui/api/*` 的鉴权不是路由自带的，而是 `guarded.use('/ui/api/*', uiAuthMiddleware())` 这条注册顺序的产物；
// 注册到 guarded 之前，端点照常工作但**不再要求凭据**（静默失效）。test/ui-guard.test.ts 的遍历式回归守着这条不变式。
import { Hono } from 'hono';
import { Bindings } from '../env';
import { HistoryDb, basename } from '../db';
import { R2Storage, historyKey } from '../storage';
import { drainRequestBody } from '../auth';
import { toIso } from '../serialization';
import { ProfileType } from '../types';
import { readRetentionSettings, SETTINGS_META_KEYS } from '../cleanup';

// 自检清单的条数上限：完整计数走 missingCount，这里只截断清单。
// 缺数据的记录是事故残留（docs/backend-gaps.md §2.4：线上实测 12 条），超过 50 条就是系统性问题；
// DB 侧按 CreateTime 倒序返回，取前 50 = 最新的 50 条（最可能是刚刚发生的故障），更多只会撑大响应体。
const MISSING_LIMIT = 50;
// 摘要长度：清单只需让人认出「是哪条剪贴板」，60 字符够（列表端点截到 500 是另一套口径）。
const SNIPPET_LIMIT = 60;

// PUT /ui/api/settings 的取值上界（契约固定：1 年 / 100 万条）。上界只挡手写请求；
// 界面按同一套约束渲染，正常路径不会碰到。
const RETENTION_MINUTES_MAX = 525_600;
const MAX_SAVED_HISTORY_COUNT_MAX = 1_000_000;

// 自检清单条目（与响应契约逐字对应；不导出 —— 没有第二个消费者）
interface IntegrityMissingItem {
  type: string;
  hash: string;
  text: string;
  createTime: string;
  size: number;
}

// PUT 的单字段判定：clear = 清除覆盖（删键回落 env）、set = 覆盖、invalid = 400。
type SettingInput = { kind: 'clear' } | { kind: 'set'; value: number } | { kind: 'invalid' };

// 只接受非负**整数**（0 合法：0 = 关闭该阶段，见 src/cleanup.ts 的 disabledReason），
// null 单独放行（= 清除覆盖）。超上界、小数、字符串（哪怕是 "30"）、布尔一律非法 ——
// 请求体是 JSON，契约里的值就是数字，放宽类型只会让「30」与「"30"」走上两条解析路径。
function parseSettingInput(raw: unknown, max: number): SettingInput {
  if (raw === null) return { kind: 'clear' };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= max) {
    return { kind: 'set', value: raw };
  }
  return { kind: 'invalid' };
}

// 截断到 limit 个字符，且不留半截代理对（半截代理对是非法字符串，JSON 序列化与前端渲染都会出问题）。
// src/ui/query.ts 有同款私有函数（truncateText），但它不导出；这三行复制比为一个字段扩大导出面便宜。
function snippet(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function createUiMaintenanceRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>({ strict: false });

  // 与 routes.ts 的同名局部函数一致：两个无状态薄封装，每次请求新建，不缓存绑定
  const stores = (c: { env: Bindings }) => ({
    db: new HistoryDb(c.env.DB),
    storage: new R2Storage(c.env.R2),
  });

  // GET /ui/api/integrity —— 数据完整性自检：DB 声明有数据、R2 里却没有对应对象的记录清单。
  // 判定方式是「目录级差集」，不是逐条 HEAD（理由与成本写在 src/storage.ts 的 listHistoryObjectKeys 注释里）：
  // 成本 = 1 次 D1 查询 + ceil(history 对象数 / 1000) 次 R2 列举，与记录条数基本无关。
  // 本端点由界面手动触发，允许比列表端点慢；但轮数仍受平台「单次调用 1000 次内部子请求」上限约束。
  app.get('/ui/api/integrity', async (c) => {
    const { db, storage } = stores(c);
    const [records, objectKeys] = await Promise.all([
      db.listActiveRecordsWithData(),
      storage.listHistoryObjectKeys(),
    ]);

    const missing: IntegrityMissingItem[] = [];
    let missingCount = 0;
    for (const r of records) {
      // 期望 key 与写入路径同构（src/storage.ts 的 historyKey）：
      // history/{Type}_{Hash}/{basename(TransferDataFile)}。
      // Hash 用 DB 里的**原样大小写**：R2 key 区分大小写，写入时用的就是这个值
      // （查记录可以大小写不敏感，key 不能，两者不能混）。
      if (objectKeys.has(historyKey(r.type, r.hash, basename(r.transferDataFile)))) continue;
      missingCount++;
      if (missing.length < MISSING_LIMIT) {
        missing.push({
          type: ProfileType[r.type],
          hash: r.hash,
          text: snippet(r.text, SNIPPET_LIMIT),
          createTime: toIso(r.createTime),
          size: r.size,
        });
      }
    }

    return Response.json({
      checkedAt: new Date().toISOString(),
      recordsWithData: records.length,
      historyObjects: objectKeys.size,
      missingCount,
      missingTruncated: missingCount > MISSING_LIMIT,
      missing,
    });
  });

  // PUT /ui/api/settings —— 设置覆盖：数字 = 覆盖、null = 清除覆盖（删 Meta 键、回落 env）、
  // 缺省字段 = 不改动。响应与 GET 同形，且是**回读生效值**而不是回显请求体。
  app.put('/ui/api/settings', async (c) => {
    // 只接受 application/json：与 batch-update 同一条理由（跨站表单能不经预检发出这些方法，
    // 而 JSON 必须由脚本构造，那类请求会被来源校验挡下）。
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      await drainRequestBody(c.req.raw);
      return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const input = body as { retentionMinutes?: unknown; maxSavedHistoryCount?: unknown };

    const sets: Record<string, string> = {};
    const clears: string[] = [];
    const fields = [
      ['retentionMinutes', SETTINGS_META_KEYS.retentionMinutes, RETENTION_MINUTES_MAX],
      ['maxSavedHistoryCount', SETTINGS_META_KEYS.maxSavedHistoryCount, MAX_SAVED_HISTORY_COUNT_MAX],
    ] as const;
    for (const [field, key, max] of fields) {
      if (!(field in input)) continue;
      const parsed = parseSettingInput(input[field], max);
      if (parsed.kind === 'invalid') return Response.json({ error: 'invalid_request' }, { status: 400 });
      if (parsed.kind === 'clear') clears.push(key);
      else sets[key] = String(parsed.value);
    }
    if (clears.length === 0 && Object.keys(sets).length === 0) {
      // 一个可识别字段都没有：静默 200 会让界面以为改动已生效（下次刷新才发现没有）
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }

    // 成本：≤3 次 D1 子请求（UPSERT 覆盖 + DELETE 清除 + 回读生效值）。人工触发，不占 Cron 的预算。
    const { db } = stores(c);
    if (Object.keys(sets).length > 0) await db.setMetaValues(sets);
    await db.deleteMetaValues(clears);
    return Response.json({ retention: await readRetentionSettings(db, c.env) });
  });

  return app;
}
