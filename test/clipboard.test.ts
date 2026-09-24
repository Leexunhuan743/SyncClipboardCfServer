// `js/clipboard.js` 的判别结果（此前只在浏览器里手工验过：headless Chromium 一律拒绝
// `clipboard.write`，所以「成功路径」从来没有被自动化钉住过）。
//
// 这里不模拟浏览器，只钉**本模块的契约**：什么条件算「环境不支持」、转码失败与权限拒绝
// 分别返回什么、以及底层原因有没有被带进结果（这条是 F5 类问题的根：三者混成一句「不支持」
// 会把用户引到错误的排查方向）。
//
// 覆盖的判别项：
//   - `isImageName` 不含 svg（可渲染内容不为剪贴板开子集，见文件头）
//   - `writeImage`：无 ClipboardItem → unsupported；PNG 直写；非 PNG 先转码；
//     写入被拒 → failed + 底层 message；转码失败 → failed + 明确原因
//   - `writeText`：现代 API 优先，失败退 execCommand，两者都失败才返回 false
import { describe, expect, it, afterEach } from 'vitest';
// @ts-expect-error TS7016：`public/ui_v2/**` 是零构建的原生 ES 模块，不在 tsconfig 的 include 里（同 next-target.test.ts）
import { isImageName, itemIsImage, writeImage, writeText, canWriteImage } from '../public/ui_v2/js/clipboard.js';
// @ts-expect-error TS7016：V1 同样是原生 ES 模块，单独钉住临时文本域的失败清理
import { writeText as writeTextV1, writeImage as writeImageV1 } from '../public/ui_v1/js/clipboard.js';

const g = globalThis as unknown as Record<string, unknown>;

function stubGlobals(values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) g[key] = value;
}

// Node 测试环境默认没有 window/navigator/document/ClipboardItem：用完删掉即可，
// 不保留「原始值」——保留反而会在后续用例里留下一半真一半假的全局。
afterEach(() => {
  for (const key of ['window', 'navigator', 'ClipboardItem', 'createImageBitmap', 'document']) delete g[key];
});

describe('clipboard.isImageName / itemIsImage', () => {
  it('位图扩展名算图片，svg 不算（可渲染内容不为剪贴板开子集）', () => {
    for (const name of ['a.png', 'a.JPG', 'a.jpeg', 'a.webp', 'a.ico', 'a.avif']) {
      expect(isImageName(name), name).toBe(true);
    }
    for (const name of ['a.svg', 'a.txt', 'a', 'a.', 'a.png.txt', '']) {
      expect(isImageName(name), name).toBe(false);
    }
  });

  it('itemIsImage：Image 类型恒真；File/Group 按文件名判', () => {
    expect(itemIsImage({ type: 'Image', dataName: null })).toBe(true);
    expect(itemIsImage({ type: 'File', dataName: 'shot.png' })).toBe(true);
    expect(itemIsImage({ type: 'Group', dataName: 'pack.zip' })).toBe(false);
    expect(itemIsImage({ type: 'File', dataName: null })).toBe(false);
  });
});

describe('clipboard.writeImage 的判别结果', () => {
  it('V1 图片转码失败也释放已解码的位图', async () => {
    let closed = 0;
    stubGlobals({
      window: { isSecureContext: true },
      ClipboardItem: class { constructor(_items: Record<string, Blob>) {} },
      navigator: { clipboard: { write: async () => undefined } },
      createImageBitmap: async () => ({ width: 2, height: 2, close: () => { closed += 1; } }),
      document: { createElement: () => ({ getContext: () => null }) },
    });
    expect(await writeImageV1(new Blob([new Uint8Array(4)], { type: 'image/jpeg' }))).toEqual({
      status: 'failed',
      reason: '图片转码失败',
    });
    expect(closed).toBe(1);
  });

  it('没有 ClipboardItem（http 非 localhost / 老浏览器）→ unsupported，且不去碰 clipboard', async () => {
    const calls: unknown[] = [];
    stubGlobals({ window: { isSecureContext: true }, navigator: { clipboard: { write: (x: unknown) => calls.push(x) } } });
    expect(canWriteImage()).toBe(false);
    expect(await writeImage(new Blob([new Uint8Array(8)], { type: 'image/png' }))).toEqual({
      status: 'unsupported',
      reason: null,
    });
    expect(calls).toEqual([]);
  });

  it('PNG 直写：原样交给 clipboard.write，不转码', async () => {
    const written: Array<{ types: string[]; size: number }> = [];
    class FakeClipboardItem {
      types: string[];
      constructor(items: Record<string, Blob>) {
        this.types = Object.keys(items);
        const only = this.types[0]!;
        written.push({ types: this.types, size: blobSize(items[only]!) });
      }
    }
    stubGlobals({
      window: { isSecureContext: true },
      ClipboardItem: FakeClipboardItem,
      navigator: { clipboard: { write: async () => undefined } },
    });
    const png = new Blob([new Uint8Array(18)], { type: 'image/png' });
    expect(await writeImage(png)).toEqual({ status: 'ok', reason: null });
    expect(written).toEqual([{ types: ['image/png'], size: 18 }]);
  });

  it('非 PNG 先转码：走 createImageBitmap + canvas.toBlob 得到 image/png', async () => {
    const written: string[][] = [];
    class FakeClipboardItem {
      types: string[];
      constructor(items: Record<string, Blob>) {
        this.types = Object.keys(items);
        written.push(this.types);
      }
    }
    const canvasStub = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array(4)], { type: 'image/png' })),
    };
    stubGlobals({
      window: { isSecureContext: true },
      ClipboardItem: FakeClipboardItem,
      navigator: { clipboard: { write: async () => undefined } },
      createImageBitmap: async () => ({ width: 2, height: 2, close: () => undefined }),
      document: { createElement: () => canvasStub },
    });
    const jpeg = new Blob([new Uint8Array(9)], { type: 'image/jpeg' });
    expect(await writeImage(jpeg)).toEqual({ status: 'ok', reason: null });
    expect(written).toEqual([['image/png']]);
  });

  it('转码失败 → failed + 明确原因（不是笼统的「不支持」）', async () => {
    class FakeClipboardItem {
      constructor(_items: Record<string, Blob>) {}
    }
    stubGlobals({
      window: { isSecureContext: true },
      ClipboardItem: FakeClipboardItem,
      navigator: { clipboard: { write: async () => undefined } },
      createImageBitmap: async () => {
        throw new Error('decode error');
      },
      document: { createElement: () => ({ getContext: () => null }) },
    });
    expect(await writeImage(new Blob([new Uint8Array(9)], { type: 'image/jpeg' }))).toEqual({
      status: 'failed',
      reason: '图片转码失败',
    });
  });

  it('写入被拒 → failed，且把底层 message 带出来（用户据此区分权限/激活问题）', async () => {
    class FakeClipboardItem {
      constructor(_items: Record<string, Blob>) {}
    }
    stubGlobals({
      window: { isSecureContext: true },
      ClipboardItem: FakeClipboardItem,
      navigator: {
        clipboard: {
          write: async () => {
            throw new Error('Write permission denied.');
          },
        },
      },
    });
    const result = await writeImage(new Blob([new Uint8Array(8)], { type: 'image/png' }));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('Write permission denied.');
  });
});

describe('clipboard.writeText 的降级链', () => {
  it('V1 旧式复制抛异常时也移除装有全文的临时文本域', async () => {
    let removed = 0;
    stubGlobals({
      window: { isSecureContext: false },
      navigator: {},
      document: {
        body: { append: () => undefined },
        createElement: () => ({
          value: '',
          style: {},
          setAttribute: () => undefined,
          select: () => undefined,
          remove: () => { removed += 1; },
        }),
        execCommand: () => { throw new Error('copy denied'); },
      },
    });
    expect(await writeTextV1('private text')).toBe(false);
    expect(removed).toBe(1);
  });

  it('安全上下文 + 现代 API 可用 → true，不走 execCommand', async () => {
    let execCalls = 0;
    stubGlobals({
      window: { isSecureContext: true },
      navigator: { clipboard: { writeText: async () => undefined } },
      document: { execCommand: () => (execCalls++, true) },
    });
    expect(await writeText('hi')).toBe(true);
    expect(execCalls).toBe(0);
  });

  it('现代 API 被拒 → 退到 execCommand；两者都失败 → false', async () => {
    stubGlobals({
      window: { isSecureContext: true },
      navigator: {
        clipboard: {
          writeText: async () => {
            throw new Error('denied');
          },
        },
      },
      document: {
        body: { append: () => undefined },
        execCommand: () => true,
        createElement: () => ({
          setAttribute: () => undefined,
          style: {},
          select: () => undefined,
          remove: () => undefined,
        }),
      },
    });
    expect(await writeText('hi')).toBe(true);

    // execCommand 也失败
    (globalThis as { document?: { execCommand?: () => boolean } }).document!.execCommand = () => false;
    expect(await writeText('hi')).toBe(false);
  });
});

function blobSize(blob: Blob): number {
  return Number((blob as { size?: number }).size ?? 0);
}
