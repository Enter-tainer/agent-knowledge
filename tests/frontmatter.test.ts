import { describe, expect, it } from 'vitest';
import { deriveTitle, parseFrontmatter, sanitizeFrontmatter } from '../src/lib/frontmatter';

const vaultStyle = `---
title: "示例约定"
aliases: []
tags:
  - demo/示例
  - 索引
source: https://example.com/wiki/abc
node_token: abc
updated: 2026-11-07
---
# 示例约定

正文第一行。`;

describe('parseFrontmatter', () => {
  it('解析 title / tags（块序列）/ aliases（空数组）/ updated（裸日期保持字符串）', () => {
    const { frontmatter } = parseFrontmatter(vaultStyle);
    expect(frontmatter.title).toBe('示例约定');
    expect(frontmatter.tags).toEqual(['demo/示例', '索引']);
    expect(frontmatter.aliases).toEqual([]);
    expect(frontmatter.updated).toBe('2026-11-07');
  });

  it('bodyOffset 精确指向 frontmatter 之后（body 从 # 开始）', () => {
    const { body, bodyOffset } = parseFrontmatter(vaultStyle);
    expect(vaultStyle.slice(bodyOffset)).toBe(body);
    expect(body.startsWith('# 示例约定')).toBe(true);
  });

  it('无 frontmatter 的文件（README）原样返回', () => {
    const raw = '# 无 frontmatter 文档\n\n正文';
    const { frontmatter, body, bodyOffset } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
    expect(bodyOffset).toBe(0);
  });

  it('缺字段/只有 title+tags 也能解析', () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: "总览"\ntags:\n  - MOC\n---\n# x');
    expect(frontmatter.title).toBe('总览');
    expect(frontmatter.tags).toEqual(['MOC']);
  });

  it('不闭合的 frontmatter 不崩，按无 frontmatter 处理', () => {
    const raw = '---\ntitle: "x"\n# no closing';
    expect(() => parseFrontmatter(raw)).not.toThrow();
    expect(parseFrontmatter(raw).frontmatter).toEqual({});
  });

  it('CRLF 的 frontmatter 也能解析（review P1）', () => {
    const raw = '---\r\ntitle: "CRLF"\r\ntags:\r\n  - a\r\n---\r\n# H\r\n\r\n正文\r\n';
    const { frontmatter, body, bodyOffset } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe('CRLF');
    expect(frontmatter.tags).toEqual(['a']);
    expect(raw.slice(bodyOffset)).toBe(body);
    expect(body.startsWith('# H')).toBe(true);
  });
});

describe('deriveTitle', () => {
  it('优先 frontmatter.title', () => {
    expect(deriveTitle({ title: '标题' }, '# H1', 'stem')).toBe('标题');
  });
  it('否则取第一个 H1', () => {
    expect(deriveTitle({}, '# H1 标题\n\n# 第二个', 'stem')).toBe('H1 标题');
  });
  it('再否则用文件名 stem', () => {
    expect(deriveTitle({}, 'plain text', 'stem')).toBe('stem');
  });
});

describe('sanitizeFrontmatter', () => {
  it('丢弃失效的飞书字段，其余保留', () => {
    const fm = sanitizeFrontmatter({
      title: 'x',
      source: 'https://x',
      node_token: 'n',
      obj_token: 'o',
      tags: ['a'],
    });
    expect(fm).toEqual({ title: 'x', tags: ['a'] });
  });
});
