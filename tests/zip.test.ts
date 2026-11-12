import { describe, expect, it } from 'vitest';
import { zipStore } from '../src/lib/zip';

describe('zipStore', () => {
  const entries = [
    { name: '示例库/中文名.md', data: new TextEncoder().encode('# 内容\n') },
    { name: 'README.md', data: new TextEncoder().encode('hello') },
  ];
  const zip = zipStore(entries);

  it('以 local header 签名开头', () => {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
  });

  it('EOCD 在结尾，条目数为 2', () => {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocdOffset = zip.length - 22;
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(eocdOffset + 8, true)).toBe(2);
    expect(view.getUint16(eocdOffset + 10, true)).toBe(2);
  });

  it('文件名（UTF-8）出现在 archive 里', () => {
    const text = new TextDecoder().decode(zip);
    expect(text).toContain('README.md');
    expect(text).toContain('示例库/中文名.md');
  });
});
