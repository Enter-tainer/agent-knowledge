/**
 * 段落级切块（只切搜索索引，原文不动）。
 * 规则：
 * - 遇到 h1–h6 另起一块；围栏代码块里的 `#` 不算标题；
 * - 块内到段落边界且长度 ≥ target 时切；块长度上限 ~3×target；
 * - 超长单行（>1200 字符）硬切成 1200 字符段，避免单行把 FTS 行撑过 D1 的 2MB；
 * - 只有标题/很短内容的文档也保证产出至少一个 chunk（否则标题都搜不到）。
 * 返回的 start/end 是 raw 的 JS 字符串下标，用于从原文取摘要。
 */

export interface Chunk {
  ord: number;
  heading: string | null;
  start: number;
  end: number;
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const DEFAULT_TARGET = 600;
const MAX_FACTOR = 3;
const MAX_LINE_SEGMENT = 1200;

export function chunkMarkdown(raw: string, target = DEFAULT_TARGET): Chunk[] {
  const lines = raw.split('\n');
  const lineStarts: number[] = [];
  let off = 0;
  for (const line of lines) {
    lineStarts.push(off);
    off += line.length + 1;
  }

  const chunks: Chunk[] = [];
  let ord = 0;
  let heading: string | null = null;
  let start = 0;
  let end = 0;
  let hasContent = false;
  let fence: string | null = null;

  const emit = (s: number, e: number): void => {
    const text = raw.slice(s, e);
    if (text.trim().length === 0) return;
    chunks.push({ ord: ord++, heading, start: s, end: e, text });
  };
  const flush = (): void => {
    if (hasContent) emit(start, end);
    hasContent = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineStart = lineStarts[i] ?? 0;
    const lineEnd = lineStart + line.length;
    const fenceMatch = FENCE_RE.exec(line);

    // 围栏代码块：内部内容一律当正文，`#` 不触发新块
    if (fence) {
      if (fenceMatch && (fenceMatch[1] ?? '').startsWith(fence)) fence = null;
      if (!hasContent) {
        if (line.trim().length === 0) continue;
        start = lineStart;
        hasContent = true;
      }
      end = lineEnd;
      continue;
    }
    if (fenceMatch) {
      fence = (fenceMatch[1] ?? '`')[0] ?? '`';
      if (!hasContent) {
        start = lineStart;
        hasContent = true;
      }
      end = lineEnd;
      continue;
    }

    // 超长单行：先结束当前块，再按 MAX_LINE_SEGMENT 硬切
    if (line.length > MAX_LINE_SEGMENT) {
      flush();
      for (let s = lineStart; s < lineEnd; s += MAX_LINE_SEGMENT) {
        emit(s, Math.min(s + MAX_LINE_SEGMENT, lineEnd));
      }
      start = Math.min(lineEnd + 1, raw.length);
      end = start;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flush();
      heading = (headingMatch[2] ?? '').trim();
      start = Math.min(lineEnd + 1, raw.length);
      end = start;
      continue;
    }

    if (!hasContent) {
      if (line.trim().length === 0) continue;
      start = lineStart;
      hasContent = true;
    }
    end = lineEnd;

    const len = end - start;
    const atParagraphBoundary = line.trim().length === 0;
    if (len >= target && atParagraphBoundary) {
      flush();
      start = Math.min(lineEnd + 1, raw.length);
      end = start;
      continue;
    }
    if (len >= target * MAX_FACTOR) {
      flush();
      start = Math.min(lineEnd + 1, raw.length);
      end = start;
    }
  }
  flush();

  // 只有标题 / 只有零散内容：至少给一个 chunk，否则这篇的标题无法被检索
  if (chunks.length === 0) emit(0, raw.length);
  return chunks;
}
