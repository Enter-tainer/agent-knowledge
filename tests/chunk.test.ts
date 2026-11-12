import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/lib/chunk';

const sample = [
  '---',
  'title: "测试"',
  'tags:',
  '  - a',
  '---',
  '# 第一节',
  '',
  '第一段内容。'.repeat(50),
  '',
  '## 子节',
  '',
  '第二段内容。'.repeat(30),
  '',
  '### 第三节',
  '',
  '短内容。',
].join('\n');

describe('chunkMarkdown', () => {
  it('产出多个块，且 start/end 与 text 严格对齐', () => {
    const chunks = chunkMarkdown(sample.slice(sample.indexOf('# 第一节')));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const body = sample.slice(sample.indexOf('# 第一节'));
    for (const c of chunks) {
      expect(body.slice(c.start, c.end)).toBe(c.text);
      expect(c.text.trim().length).toBeGreaterThan(0);
      expect(c.start).toBeLessThan(c.end);
    }
  });

  it('ord 从 0 连续递增', () => {
    const chunks = chunkMarkdown(sample.slice(sample.indexOf('# 第一节')));
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  it('heading 记录块所属标题', () => {
    const body = sample.slice(sample.indexOf('# 第一节'));
    const chunks = chunkMarkdown(body);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('第一节');
    expect(headings).toContain('子节');
  });

  it('按 target 控制块大小（不会一块吞下整篇）', () => {
    const body = sample.slice(sample.indexOf('# 第一节'));
    const chunks = chunkMarkdown(body, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.end - c.start).toBeLessThan(100 * 3 + 200);
  });

  it('空内容不产生块', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('\n\n\n')).toEqual([]);
  });

  it('未闭合代码块不会崩', () => {
    const raw = '# T\n\n```\ncode without closing fence\n\nmore';
    expect(() => chunkMarkdown(raw)).not.toThrow();
  });

  it('围栏代码块里的 `#` 不当标题（review P1）', () => {
    const raw = '# T\n\n```bash\n# 这是注释不是标题\nsudo rm -rf /\n```\n\n正文。';
    const chunks = chunkMarkdown(raw);
    expect(chunks.some((c) => c.heading?.includes('这是注释'))).toBe(false);
    expect(chunks.some((c) => c.heading === 'T')).toBe(true);
    // 代码内容要进入正文索引，而不是被当成空块丢掉
    expect(chunks.some((c) => c.text.includes('sudo rm -rf'))).toBe(true);
  });

  it('超长单行会硬切（避免单 chunk 撞 D1 2MB 行上限）', () => {
    const raw = `# T\n\n${'长'.repeat(5000)}`;
    const chunks = chunkMarkdown(raw);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(1200);
    // 硬切不丢内容：拼起来等于原文（忽略被跳过的空行）
    const joined = chunks.map((c) => c.text).join('');
    expect(joined.includes('长'.repeat(1200))).toBe(true);
  });

  it('只有标题的文档也产出 1 个 chunk（否则标题搜不到，review P1）', () => {
    const chunks = chunkMarkdown('# 只有标题\n');
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text.includes('只有标题')).toBe(true);
  });

  it('CRLF 文档 heading/偏移仍正确（review P1）', () => {
    const raw = '# 第一行\r\n\r\n内容一\r\n\r\n## 子标题\r\n\r\n内容二\r\n';
    const chunks = chunkMarkdown(raw);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(raw.slice(c.start, c.end)).toBe(c.text);
    expect(chunks.some((c) => c.heading === '子标题')).toBe(true);
  });
});
