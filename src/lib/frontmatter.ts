/**
 * 最小 frontmatter 解析：只取 title / tags / updated / aliases，原文（raw）始终原样保存。
 * 语料实测只有标量、块序列、空 flow 数组三种写法（research/corpus/inventory.md §A2）。
 */

export interface Frontmatter {
  [key: string]: string | string[];
}

export interface ParsedDoc {
  frontmatter: Frontmatter;
  body: string;
  /** body 在 raw 里的起始下标（用于切块偏移对齐）。 */
  bodyOffset: number;
}

export function parseFrontmatter(raw: string): ParsedDoc {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw, bodyOffset: 0 };

  const lines = raw.split('\n');
  const lineStarts: number[] = [];
  let off = 0;
  for (const line of lines) {
    lineStarts.push(off);
    off += line.length + 1;
  }
  const clean = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);

  if (clean(lines[0] ?? '').trim() !== '---') return { frontmatter: {}, body: raw, bodyOffset: 0 };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (clean(lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { frontmatter: {}, body: raw, bodyOffset: 0 };

  const fm: Frontmatter = {};
  const fmLines = lines.slice(1, end).map(clean);
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i] ?? '';
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? '';
    const inline = (m[2] ?? '').trim();

    // 块序列：value 为空，后续缩进的 "- x" 行
    if (inline === '') {
      const items: string[] = [];
      while (i + 1 < fmLines.length) {
        const next = fmLines[i + 1] ?? '';
        const item = /^\s+-\s*(.*)$/.exec(next);
        if (!item) break;
        items.push(unquote((item[1] ?? '').trim()));
        i++;
      }
      if (items.length > 0) {
        fm[key] = items;
        continue;
      }
      fm[key] = '';
      continue;
    }

    // flow 数组：[a, b] / []
    if (inline.startsWith('[') && inline.endsWith(']')) {
      const inner = inline.slice(1, -1).trim();
      fm[key] = inner
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
      continue;
    }

    fm[key] = unquote(inline);
  }

  // 正文从 closing `---` 那一行之后的换行处开始；lineStarts 已按原始长度累计（兼容 CRLF）
  const bodyOffset = Math.min((lineStarts[end] ?? 0) + (lines[end]?.length ?? 0) + 1, raw.length);
  return { frontmatter: fm, body: raw.slice(bodyOffset), bodyOffset };
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

export function asStringArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** title 取值顺序：frontmatter.title → 第一个 H1 → 文件名（不含 .md）。 */
export function deriveTitle(fm: Frontmatter, body: string, stem: string): string {
  const t = fm['title'];
  if (typeof t === 'string' && t.trim()) return t.trim();
  const h1 = /^#\s+(.+?)\s*$/m.exec(body);
  if (h1?.[1]) return h1[1].trim();
  return stem;
}

/** 去掉只会引起误导的失效字段（飞书原空间已删除）。 */
export function sanitizeFrontmatter(fm: Frontmatter): Frontmatter {
  const out: Frontmatter = { ...fm };
  for (const k of ['source', 'node_token', 'obj_token']) delete out[k];
  return out;
}
