import katex from 'katex';
import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';

/**
 * KaTeX 数学公式插件：
 * - 块级公式：`$$ ... $$`（单行或多行）与 `\[ ... \]`（独立行块）
 * - 行内公式：`$ ... $`、`$$ ... $$`（行内居中展示）与 `\( ... \)`
 *
 * 行内规则注册在 `escape` 之前，这样 `\( ... \)` 不会被 `escape` 吃掉反斜杠；
 * 反引号行内代码由各自规则在起始位置消费（`$`/`\(` 不匹配 `` ` ``，所以代码内 `$a$` 原样保留）。
 */

const KATEX_OPTS = {
  throwOnError: false,
  strict: 'ignore' as const,
};

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), { ...KATEX_OPTS, displayMode });
  } catch {
    return escapeHtml(tex);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isEscaped(src: string, pos: number): boolean {
  let backslashes = 0;
  let i = pos - 1;
  while (i >= 0 && src.charCodeAt(i) === 0x5c /* \ */) {
    backslashes += 1;
    i -= 1;
  }
  return backslashes % 2 === 1;
}

function isWhitespace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

function isDigit(ch: number): boolean {
  return ch >= 0x30 && ch <= 0x39;
}

/** 行内 `$...$`、`$$...$$` 与 `\(...\)` 解析。 */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state;
  const ch = src.charCodeAt(pos);

  // 1) \( ... \)
  if (ch === 0x5c /* \ */ && src.charCodeAt(pos + 1) === 0x28 /* ( */) {
    if (isEscaped(src, pos)) return false;
    let scan = pos + 2;
    let close = -1;
    while (scan < src.length - 1) {
      if (src.charCodeAt(scan) === 0x5c && src.charCodeAt(scan + 1) === 0x29 /* ) */ && !isEscaped(src, scan)) {
        close = scan;
        break;
      }
      scan += 1;
    }
    if (close === -1) return false;
    const tex = src.slice(pos + 2, close);
    if (!tex.trim()) return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.markup = '\\(';
      token.content = tex;
    }
    state.pos = close + 2;
    return true;
  }

  if (ch !== 0x24 /* $ */) return false;
  if (isEscaped(src, pos)) return false;

  // 2) 行内 $$ ... $$
  if (src.charCodeAt(pos + 1) === 0x24 /* $ */) {
    let scan = pos + 2;
    let close = -1;
    while (scan < src.length - 1) {
      if (src.charCodeAt(scan) === 0x24 && src.charCodeAt(scan + 1) === 0x24 && !isEscaped(src, scan)) {
        close = scan;
        break;
      }
      scan += 1;
    }
    if (close === -1) return false;
    const tex = src.slice(pos + 2, close);
    if (!tex.trim()) return false;
    if (!silent) {
      const token = state.push('math_inline_display', 'math', 0);
      token.markup = '$$';
      token.content = tex;
    }
    state.pos = close + 2;
    return true;
  }

  // 3) 行内 $ ... $：首尾不能贴空白，不跨行，闭合 `$` 后不能紧接数字（避免 `$100+$200` 误判）
  const nextCh = src.charCodeAt(pos + 1);
  if (!nextCh || isWhitespace(nextCh)) return false;

  let scan = pos + 1;
  let close = -1;
  while (scan < src.length) {
    const cur = src.charCodeAt(scan);
    if (cur === 0x0a /* \n */ || cur === 0x0d /* \r */) return false;
    if (cur === 0x24 /* $ */ && !isEscaped(src, scan)) {
      close = scan;
      break;
    }
    scan += 1;
  }
  if (close === -1 || close === pos + 1) return false;
  if (isWhitespace(src.charCodeAt(close - 1))) return false;
  const afterClose = src.charCodeAt(close + 1);
  if (afterClose && isDigit(afterClose)) return false;

  const tex = src.slice(pos + 1, close);
  if (!tex.trim()) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.markup = '$';
    token.content = tex;
  }
  state.pos = close + 1;
  return true;
}

/** 块级 `$$ ... $$` 与独立块 `\[ ... \]` 解析。 */
function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;

  const startPos = state.bMarks[startLine]! + state.tShift[startLine]!;
  const maxPos = state.eMarks[startLine]!;
  const line = state.src.slice(startPos, maxPos);

  let openMarker: '$$' | '\\[' | null = null;
  let closeMarker: '$$' | '\\]' = '$$';
  if (line.startsWith('$$')) {
    openMarker = '$$';
    closeMarker = '$$';
  } else if (line.startsWith('\\[')) {
    openMarker = '\\[';
    closeMarker = '\\]';
  }
  if (!openMarker) return false;

  const firstRest = line.slice(openMarker.length);
  const sameLineClose = firstRest.lastIndexOf(closeMarker);

  // 单行块：`$$ E = mc^2 $$` 或 `\[ E = mc^2 \]`
  if (sameLineClose !== -1) {
    const afterClose = firstRest.slice(sameLineClose + closeMarker.length).trim();
    if (afterClose !== '') return false;
    const content = firstRest.slice(0, sameLineClose).trim();
    if (!content) return false;
    if (silent) return true;

    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.markup = openMarker;
    token.content = content;
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }

  // 多行块
  let nextLine = startLine;
  let foundClose = false;
  let lastLineContent = '';

  while (nextLine + 1 < endLine) {
    nextLine += 1;
    const pos = state.bMarks[nextLine]! + state.tShift[nextLine]!;
    const max = state.eMarks[nextLine]!;
    if (pos < max && state.sCount[nextLine]! < state.blkIndent) break;

    const curLine = state.src.slice(pos, max);
    const trimmed = curLine.trim();
    if (trimmed.endsWith(closeMarker)) {
      const idx = curLine.lastIndexOf(closeMarker);
      if (curLine.slice(idx + closeMarker.length).trim() === '' && !isEscaped(curLine, idx)) {
        lastLineContent = curLine.slice(0, idx);
        foundClose = true;
        break;
      }
    }
  }

  // 多行 `\[` 必须有明确的闭合 `\]`，否则按普通段落处理，避免误吃后续正文
  if (!foundClose && openMarker === '\\[') return false;
  if (silent) return true;

  const bodyLines: string[] = [];
  if (firstRest.trim()) bodyLines.push(firstRest);
  for (let i = startLine + 1; i < nextLine; i++) {
    const p = state.bMarks[i]! + state.tShift[i]!;
    const m = state.eMarks[i]!;
    bodyLines.push(state.src.slice(p, m));
  }
  if (foundClose && lastLineContent.trim()) bodyLines.push(lastLineContent);

  const finalLine = foundClose ? nextLine + 1 : endLine;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.markup = openMarker;
  token.content = bodyLines.join('\n').trim();
  token.map = [startLine, finalLine];
  state.line = finalLine;
  return true;
}

export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', mathInlineRule);
  md.block.ruler.before('fence', 'math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  md.renderer.rules.math_inline = (tokens, idx) => {
    const html = renderKatex(tokens[idx]!.content, false);
    return `<span class="math-inline">${html}</span>`;
  };

  md.renderer.rules.math_inline_display = (tokens, idx) => {
    const html = renderKatex(tokens[idx]!.content, true);
    return `<span class="math-display">${html}</span>`;
  };

  md.renderer.rules.math_block = (tokens, idx) => {
    const html = renderKatex(tokens[idx]!.content, true);
    return `<div class="math-block" tabindex="0" role="region" aria-label="数学公式">${html}</div>\n`;
  };
}
