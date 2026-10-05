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
      { name: 'b.txt', isDir: false, contentHash: sha256(Buffer.from(fileContent)), contentLength: fileContent.length },
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
    const b = { name: 'b.txt', isDir: false, contentHash: sha256(Buffer.from('x')), contentLength: 1 };
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
  it('解析条目与顶层判定（含隐式目录）', async () => {
    const zip = zipSync({
      'dir/': strToU8(''),
      'dir/file.txt': strToU8('hello'),
      'top.txt': strToU8('top'),
    });
    const { entries, topLevel } = await parseGroupZip(zip);
    expect(topLevel.sort()).toEqual(['dir', 'top.txt']);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['dir/', 'dir/file.txt', 'top.txt']);
  });

  it('合法空 zip（无条目）→ 无顶层条目', async () => {
    const { topLevel } = await parseGroupZip(zipSync({}));
    expect(topLevel).toEqual([]);
  });

  it('0 字节（非法 zip）→ 抛错', async () => {
    await expect(parseGroupZip(new Uint8Array(0))).rejects.toThrow();
  });

  it('拒绝路径穿越条目', async () => {
    const zip = zipSync({ '../evil.txt': strToU8('x') });
    await expect(parseGroupZip(zip)).rejects.toThrow(InvalidGroupDataError);
  });

  it('拒绝绝对路径与反斜杠条目', async () => {
    await expect(parseGroupZip(zipSync({ '/abs.txt': strToU8('x') }))).rejects.toThrow(InvalidGroupDataError);
    await expect(parseGroupZip(zipSync({ 'a\\b.txt': strToU8('x') }))).rejects.toThrow(InvalidGroupDataError);
  });

  // 审计残余 G5：盘符形态的「绝对路径」与含 NUL 的名字。
  // 两者都躲得过上面那些基于 '/' 分段的检查：`C:/evil.txt` 没有前导斜杠也没有 `..` 段；
  // `a\0b.txt` 落盘时会被截成 `a`（名字与哈希时看到的不再是同一个）。
  it('拒绝盘符条目（Windows 绝对路径形态）', async () => {
    await expect(parseGroupZip(zipSync({ 'C:/evil.txt': strToU8('x') }))).rejects.toThrow(InvalidGroupDataError);
    await expect(parseGroupZip(zipSync({ 'C:\\evil.txt': strToU8('x') }))).rejects.toThrow(InvalidGroupDataError);
    // 目录条目走的是同一条校验，也要拒
    await expect(parseGroupZip(zipSync({ 'D:/dir/': new Uint8Array(0) }))).rejects.toThrow(InvalidGroupDataError);
  });

  it('拒绝含 NUL 的条目名', async () => {
    await expect(parseGroupZip(zipSync({ 'a\0b.txt': strToU8('x') }))).rejects.toThrow(InvalidGroupDataError);
  });

  it('阳性对照：第二字符是冒号的普通名字仍被接受（盘符校验不能写成裸前缀）', async () => {
    // `a:b.txt` / `1:30.txt` 在 Linux/macOS 上合法、上游也能落盘；
    // 裸的 `^[A-Za-z]:` 会把它们一起拒掉，那是行为回归。
    for (const name of ['a:b.txt', '1:30.txt']) {
      const { topLevel } = await parseGroupZip(zipSync({ [name]: strToU8('x') }));
      expect(topLevel, `${name} 应被接受`).toEqual([name]);
    }
  });

  it('阳性对照：普通文件名（单字母前缀、含点）不受影响', async () => {
    const zip = zipSync({ 'a.txt': strToU8('x'), 'sub/c.txt': strToU8('y') });
    const { topLevel, entries } = await parseGroupZip(zip);
    // 顶层条目只看「裁掉尾部斜杠后仍不含 '/'」的名字：`sub/c.txt` 不是顶层，
    // 但它推导出的隐式目录 `sub/` 仍在条目集合里（参与哈希）。
    expect(topLevel).toEqual(['a.txt']);
    expect(entries.some((e) => e.name === 'sub/' && e.isDir)).toBe(true);
  });

  // 2026-10-03（Git history）：条目名的**文件系统语义**归一。
  // 上游算哈希走的是「解压落盘 → 枚举目录树」，所以树里的名字永远是单斜杠；本实现此前按 zip 里的
  // **原始**名字入哈希 ⇒ 含连续斜杠的 zip **两侧都接受、却对同一个文件夹算出不同 hash**。
  // 这类"都接受但不等价"比已登记的偏移更危险（它不是取舍，是漏了对齐），故必须有钉子。
  it('连续斜杠按文件系统语义折叠：`a//b.txt` 与 `a/b.txt` 的条目集/总量/哈希必须完全相同', async () => {
    const messy = zipSync({ 'a//': new Uint8Array(0), 'a//b.txt': strToU8('hello') });
    const clean = zipSync({ 'a/': new Uint8Array(0), 'a/b.txt': strToU8('hello') });

    const m = await parseGroupZip(messy);
    const c = await parseGroupZip(clean);

    expect(m.entries.map((e) => e.name).sort()).toEqual(['a/', 'a/b.txt']);
    expect(m.entries.map((e) => e.name).sort()).toEqual(c.entries.map((e) => e.name).sort());
    expect(m.totalSize).toBe(c.totalSize);
    expect(await groupHashFromEntries(m.entries)).toBe(await groupHashFromEntries(c.entries));
    // 顶层判定**不**归一（上游那一步用的是原始条目名）：`a//` TrimEnd 后不含 '/' ⇒ 仍是顶层
    expect(m.topLevel).toEqual(['a']);
  });

  it('归一后重名只留一条（`a/b.txt` 与 `a//b.txt` 在文件系统上是同一个文件，首见优先）', async () => {
    const zip = zipSync({ 'a/b.txt': strToU8('FIRST'), 'a//b.txt': strToU8('SECOND') });
    const { entries, totalSize } = await parseGroupZip(zip);
    const files = entries.filter((e) => !e.isDir);
    expect(files.map((e) => e.name)).toEqual(['a/b.txt']);
    // 首见优先 = 上游"若能落盘"时树里会有的那一份内容
    expect(files[0]!.contentHash).toBe(await sha256Hex(strToU8('FIRST')));
    expect(totalSize).toBe(5);
  });
});
