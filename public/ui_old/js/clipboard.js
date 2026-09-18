// 剪贴板写入：文本与图片，含各环境的降级。
//
// 单独成模块的原因：这条链上有三处环境差异必须逐一处理，散在调用点必然各写一份、漏一份——
//   1. 安全上下文：`navigator.clipboard` 只在 https 或 localhost 存在（局域网 http 部署时没有）；
//   2. 格式：异步剪贴板对写入格式的支持因浏览器而异，PNG 是最稳的，其它格式需先转码；
//   3. 失败必须可降级：写不进去时要把内容以可手动复制的方式呈现，而不是静默失败。

// 可当作图片复制/预览的扩展名（含 svg 之外的常见位图格式）
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'jpe', 'gif', 'webp', 'bmp', 'avif', 'ico']);

// 文件名是否像一张位图。
// 刻意不含 svg：SVG 属于「可渲染内容」，附件链路里已被强制降级为下载，
// 剪贴板这条路径不为它开口子。
export function isImageName(name) {
  if (!name) return false;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function canWriteText() {
  return Boolean(window.isSecureContext && navigator.clipboard?.writeText);
}

// 一条记录是否可按图片复制：Image 类型，或文件名带图片扩展名的 File/Group。
// （clipserver 的行内复制就是按这个规则分发的：类型是图片、或文件名是图片扩展名。）
export function itemIsImage(item) {
  return item.type === 'Image' || isImageName(item.dataName);
}

// 写文本：现代 API 优先，失败退到 execCommand，再失败返回 false 由调用方呈现内容
export async function writeText(text) {
  if (canWriteText()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 继续降级 */
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function canWriteImage() {
  return Boolean(
    window.isSecureContext && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write,
  );
}

// 写图片的结果必须可判别，且失败时要带上底层原因：
// 把「环境不支持」「权限被拒」「失去焦点」混成一句「不支持」，会把用户引到错误的排查方向。
// 返回 { status: 'ok' | 'unsupported' | 'failed', reason: string | null }。
//
// 非 PNG 先转码（异步剪贴板对非 PNG 的支持不稳定；转码失败或写入被拒都归为 failed）。
export async function writeImage(blob) {
  if (!canWriteImage()) return { status: 'unsupported', reason: null };
  try {
    const png = blob.type === 'image/png' ? blob : await toPng(blob);
    if (!png) return { status: 'failed', reason: '图片转码失败' };
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return { status: 'ok', reason: null };
  } catch (error) {
    return { status: 'failed', reason: error?.message ?? String(error) };
  }
}

async function toPng(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await new Promise((resolve) => canvas.toBlob((result) => resolve(result), 'image/png'));
  } catch {
    return null;
  }
}
