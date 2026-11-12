import { describe, expect, it } from 'vitest';
import { buildLinkIndex, dirOf, resolveWikilink, scanWikilinks, stemOf } from '../src/lib/links';

const sample = [
  '# 标题',
  '',
  '普通 [[A]] 和嵌入 ![[B]]。',
  '',
  '行内代码 `[[不是链接]]` 应被忽略。',
  '',
  '```text',
  '[[代码块里的也不是链接]]',
  '```',
  '',
  '| 列 | 值 |',
  '|-|-|',
  '| x | [[C|别名]] |',
  '',
  '锚点 [[D#小节]] 和块 [[E#^blk1]]。',
  '重复 [[A]]。',
].join('\n');

describe('scanWikilinks', () => {
  const links = scanWikilinks(sample);

  it('只统计真实双链（跳过行内代码与围栏代码块）', () => {
    expect(links.map((l) => l.target)).toEqual(['A', 'B', 'C', 'D', 'E', 'A']);
  });

  it('解析别名 / heading / block', () => {
    const c = links.find((l) => l.target === 'C');
    expect(c?.alias).toBe('别名');
    const d = links.find((l) => l.target === 'D');
    expect(d?.heading).toBe('小节');
    const e = links.find((l) => l.target === 'E');
    expect(e?.block).toBe('blk1');
  });

  it('line/col 指向 [[ 的位置（1-based）', () => {
    const first = links[0];
    expect(first?.line).toBe(3);
    const lineText = sample.split('\n')[(first?.line ?? 1) - 1] ?? '';
    expect(lineText.slice((first?.col ?? 1) - 1).startsWith('[[A]]')).toBe(true);
  });
});

describe('resolveWikilink（Obsidian 规则）', () => {
  const paths = [
    'a/N.md',
    'b/M.md',
    'c/d/E.md',
    'a/Z.md',
    'b/Z.md',
    'docs/设备逆向.md',
    'docs/设备逆向/压感真相.md',
  ];
  const index = buildLinkIndex(paths);

  it('同目录优先', () => {
    expect(resolveWikilink('a/N', 'N', index)).toBe('a/N');
  });

  it('全库唯一文件名（大小写不敏感）', () => {
    expect(resolveWikilink('a/N', 'M', index)).toBe('b/M');
    expect(resolveWikilink('a/N', 'm', index)).toBe('b/M');
  });

  it('带 .md 后缀也能解析', () => {
    expect(resolveWikilink('a/N', 'M.md', index)).toBe('b/M');
  });

  it('同名文件 → 视为断链（需人工消歧）', () => {
    expect(resolveWikilink('c/d/E', 'Z', index)).toBeNull();
  });

  it('子目录相对路径 / 根路径', () => {
    expect(resolveWikilink('a/N', 'b/M', index)).toBe('b/M');
  });

  it('folder note（文件 stem 与目录同名）仍可解析', () => {
    expect(resolveWikilink('docs/设备逆向/压感真相', '设备逆向', index)).toBe('docs/设备逆向');
  });

  it('不存在的目标 → null', () => {
    expect(resolveWikilink('a/N', '不存在', index)).toBeNull();
  });

  it('URL 目标 → null（不进入链接图）', () => {
    expect(resolveWikilink('a/N', 'https://example.com', index)).toBeNull();
  });
});

describe('path helpers', () => {
  it('stemOf / dirOf', () => {
    expect(stemOf('docs/协议数据.md')).toBe('协议数据');
    expect(dirOf('docs/设备逆向/x.md')).toBe('docs/设备逆向');
    expect(dirOf('root.md')).toBe('');
  });
});
