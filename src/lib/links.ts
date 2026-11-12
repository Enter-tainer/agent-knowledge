/**
 * 双链扫描与解析（与 Obsidian 一致；语料实测只有 [[文件名]] 一种形态，
 * 但 scanner 仍按通用语法处理别名/heading/blockid/嵌入，便于以后 agent 写入）。
 *
 * 重要不变式：maskCode() 必须严格保持 UTF-16 长度不变——否则 rename 按 (line,col) splice 会写坏原文。
 */

export interface RawLink {
  /** [[…]] 里的目标文本（已去掉 |别名 与 #锚点）。 */
  target: string;
  /** 原始匹配文本（含开头的 !）。 */
  raw: string;
  embed: boolean;
  alias: string | null;
  heading: string | null;
  block: string | null;
  line: number;
  col: number;
}

const WIKILINK_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/** 扫描 raw 中所有 [[…]]，跳过围栏代码块与行内代码。line/col 为 1-based（按 UTF-16 code unit）。 */
export function scanWikilinks(raw: string): RawLink[] {
  const masked = maskCode(raw);
  if (masked.length !== raw.length) {
    throw new Error(`maskCode 改变了长度：${masked.length} !== ${raw.length}`);
  }
  const lineStarts = buildLineStarts(raw);
  const out: RawLink[] = [];
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const start = m.index ?? 0;
    const inner = (m[2] ?? '').trim();
    let target = inner;
    let alias: string | null = null;
    let heading: string | null = null;
    let block: string | null = null;

    const pipe = target.indexOf('|');
    if (pipe >= 0) {
      alias = target.slice(pipe + 1).trim();
      target = target.slice(0, pipe).trim();
    }
    const hash = target.indexOf('#');
    if (hash >= 0) {
      const anchor = target.slice(hash + 1).trim();
      target = target.slice(0, hash).trim();
      if (anchor.startsWith('^')) block = anchor.slice(1);
      else heading = anchor;
    }
    if (!target) continue;

    const lineIndex = findLine(lineStarts, start);
    out.push({
      target,
      raw: m[0],
      embed: m[1] === '!',
      alias,
      heading,
      block,
      line: lineIndex + 1,
      col: start - (lineStarts[lineIndex] ?? 0) + 1,
    });
  }
  return out;
}

function buildLineStarts(raw: string): number[] {
  const starts = [0];
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function findLine(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 把围栏代码块与行内代码替换成空格（保留换行与 UTF-16 长度），行列号因此与原文一致。 */
function maskCode(raw: string): string {
  const lines = raw.split('\n');
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && (fenceMatch[1] ?? '').startsWith(fence)) fence = null;
      out.push(' '.repeat(line.length));
      continue;
    }
    if (fenceMatch) {
      fence = (fenceMatch[1] ?? '`')[0] ?? '`';
      out.push(' '.repeat(line.length));
      continue;
    }
    out.push(maskInlineCode(line));
  }
  return out.join('\n');
}

function maskInlineCode(line: string): string {
  // 用 code unit 数组（不是 code point）：emoji 会占 2 个单元，替换成 2 个空格，长度守恒
  const chars = line.split('');
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '`') {
      i++;
      continue;
    }
    let run = 0;
    while (i + run < chars.length && chars[i + run] === '`') run++;
    const start = i;
    let j = i + run;
    let closed = -1;
    while (j < chars.length) {
      if (chars[j] === '`') {
        let r = 0;
        while (j + r < chars.length && chars[j + r] === '`') r++;
        if (r === run) {
          closed = j;
          j += r;
          break;
        }
        j += r;
      } else {
        j++;
      }
    }
    if (closed < 0) break;
    for (let k = start; k < j; k++) chars[k] = ' ';
    i = j;
  }
  return chars.join('');
}

export interface LinkIndex {
  /** lower(path) → path */
  paths: Map<string, string>;
  /** lower(stem) → paths[]（同名歧义检测） */
  byStem: Map<string, string[]>;
}

export function buildLinkIndex(paths: Iterable<string>): LinkIndex {
  const index: LinkIndex = { paths: new Map(), byStem: new Map() };
  for (const rawPath of paths) {
    // DB 里 path 不带 .md；这里也统一剥掉，避免两种写法混用导致解析不到
    const p = rawPath.replace(/\.md$/i, '');
    index.paths.set(p.toLowerCase(), p);
    const stem = stemOf(p).toLowerCase();
    const list = index.byStem.get(stem) ?? [];
    list.push(p);
    index.byStem.set(stem, list);
  }
  return index;
}

export function stemOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Obsidian 解析规则：同目录 → 全库唯一文件名 → 相对路径 → 根路径；大小写不敏感。 */
export function resolveWikilink(fromPath: string, target: string, index: LinkIndex): string | null {
  if (/^https?:/i.test(target)) return null;
  let t = target.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/\.md$/i.test(t)) t = t.slice(0, -3);
  if (!t) return null; // 纯 #heading 自引用

  const dir = dirOf(fromPath);
  const sameDir = (dir ? `${dir}/${t}` : t).toLowerCase();
  const hitSameDir = index.paths.get(sameDir);
  if (hitSameDir) return hitSameDir;

  if (!t.includes('/')) {
    const candidates = index.byStem.get(t.toLowerCase()) ?? [];
    if (candidates.length === 1) return candidates[0] ?? null;
    if (candidates.length > 1) return null; // 同名歧义 → 断链（需人工消歧）
    return null;
  }

  const lower = t.toLowerCase();
  const fromRoot = index.paths.get(lower);
  if (fromRoot) return fromRoot;
  return null;
}
