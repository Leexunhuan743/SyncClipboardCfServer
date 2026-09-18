// 哈希算法单元测试（docs/protocol.md §8；公式对照上游 C# 实现）
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  sha256Hex,
  textProfileHash,
  fileProfileHash,
  groupHashFromEntries,
  parseGroupZip,
  InvalidGroupDataError,
} from '../src/hash';

// 独立参考实现（node crypto，与上游公式一致的计算基准）
import { createHash } from 'node:crypto';
const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex').toUpperCase();

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

describe('sha256Hex', () => {
  it('输出十六进制大写', async () => {
    expect(await sha256Hex('')).toBe('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855');
    expect(await sha256Hex('hello world')).toBe(
      'B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9',
    );
  });
});

describe('textProfileHash', () => {
  it('hash = SHA256hex(UTF8(text))', async () => {
    const text = 'SyncClipboard 测试文本';
    expect(await textProfileHash(text)).toBe(sha256(text));
  });
});

describe('fileProfileHash', () => {
  it('hash = SHA256hex(UTF8($"{fileName}|{contentHashUpper}"))', async () => {
    const fileName = 'report.pdf';
    const content = new TextEncoder().encode('pdf-binary-content');
    const expected = sha256(`${fileName}|${sha256(Buffer.from(content))}`);
    expect(await fileProfileHash(fileName, content)).toBe(expected);
  });
});

describe('groupHashFromEntries', () => {
  it('目录 D|name\\0、文件 F|name|len|hash\\0，按 name UTF-8 字节序排序', async () => {
    const fileContent = new TextEncoder().encode('file-a');
    const entries = [
      { name: 'b.txt', isDir: false, content: fileContent },
      { name: 'dir/', isDir: true },
    ];
    // 手工构造期望值（独立计算）
    const contentHash = sha256(Buffer.from(fileContent));
    const lineA = `F|b.txt|${fileContent.length}|${contentHash}\0`;
    const lineB = 'D|dir/\0';
    // 排序：b.txt 的 UTF-8 字节 < dir/（'b'(0x62) < 'd'(0x64)）
    const expected = sha256(lineA + lineB);
    expect(await groupHashFromEntries(entries)).toBe(expected);
  });

  it('输入顺序无关（排序稳定）', async () => {
    const a = { name: 'a/', isDir: true };
    const b = { name: 'b.txt', isDir: false, content: new TextEncoder().encode('x') };
    const forward = await groupHashFromEntries([a, b]);
    const reverse = await groupHashFromEntries([b, a]);
    expect(forward).toBe(reverse);
  });

  it('空集合 = SHA256(空串)（上游 CaclHashAndSize 的空分支）', async () => {
    // 断言行为而非复述常量：空输入应得到 SHA256(空串) 的十六进制大写
    expect(await groupHashFromEntries([])).toBe('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855');
    expect(await groupHashFromEntries([])).toBe(sha256(Buffer.alloc(0)));
  });
});

describe('parseGroupZip', () => {
  it('解析条目与顶层判定（含隐式目录）', () => {
    const zip = zipSync({
      'dir/': strToU8(''),
      'dir/file.txt': strToU8('hello'),
      'top.txt': strToU8('top'),
    });
    const { entries, topLevel } = parseGroupZip(zip);
    expect(topLevel.sort()).toEqual(['dir', 'top.txt']);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['dir/', 'dir/file.txt', 'top.txt']);
  });

  it('合法空 zip（无条目）→ 无顶层条目', () => {
    const { topLevel } = parseGroupZip(zipSync({}));
    expect(topLevel).toEqual([]);
  });

  it('0 字节（非法 zip）→ 抛错', () => {
    expect(() => parseGroupZip(new Uint8Array(0))).toThrow();
  });

  it('拒绝路径穿越条目', () => {
    const zip = zipSync({ '../evil.txt': strToU8('x') });
    expect(() => parseGroupZip(zip)).toThrow(InvalidGroupDataError);
  });

  it('拒绝绝对路径与反斜杠条目', () => {
    expect(() => parseGroupZip(zipSync({ '/abs.txt': strToU8('x') }))).toThrow(InvalidGroupDataError);
    expect(() => parseGroupZip(zipSync({ 'a\\b.txt': strToU8('x') }))).toThrow(InvalidGroupDataError);
  });

});
