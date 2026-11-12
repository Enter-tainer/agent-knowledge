/**
 * 检索文本变换（写入端与查询端必须共用本文件）。
 * 设计见 docs/TECH-69-67-plan.md §4.3 / research/bench/README.md。
 *
 * 写入：CJK 连续段 → 重叠 bigram（空格分隔）；ASCII 词 → 整词 + 子 token（去 0x、切分隔符、切 camelCase）
 * 查询：同一变换后，CJK 段用 phrase，纯 ASCII 标识符用前缀，其它用 phrase，全部 AND。
 */

export const TOKENIZER_VERSION = 1;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[A-Za-z0-9][A-Za-z0-9_.\-/+:]*/g;
const CAMEL_RE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;
const SIMPLE_ASCII_RE = /^[A-Za-z0-9_]+$/;

const isCjk = (ch: string): boolean => CJK_RE.test(ch);

/** 写入端：把一段 md 文本变成可进 FTS5(unicode61) 的 token 串。 */
export function transformText(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    if (isCjk(text[i] ?? '')) {
      let j = i;
      while (j < n && isCjk(text[j] ?? '')) j++;
      const run = text.slice(i, j);
      if (run.length >= 2) {
        for (let k = 0; k + 1 < run.length; k++) out.push(run.slice(k, k + 2));
      } else {
        out.push(run);
      }
      i = j;
      continue;
    }

    let j = i;
    while (j < n && !isCjk(text[j] ?? '')) j++;
    const seg = text.slice(i, j);
    for (const m of seg.matchAll(WORD_RE)) {
      const word = m[0];
      out.push(word);

      const hexDigits = word.match(/^0x([0-9a-fA-F]+)$/)?.[1];
      if (hexDigits && hexDigits.length >= 2) out.push(hexDigits);

      for (const part of word.split(/[_.\-/+:]+/)) {
        if (!part) continue;
        if (part !== word && part.length >= 2) out.push(part);
        for (const cm of part.matchAll(CAMEL_RE)) {
          const piece = cm[0];
          if (piece.length >= 2 && piece !== part && piece !== word) out.push(piece);
        }
      }
    }
    i = j;
  }

  return out.join(' ');
}

export interface QueryAnalysis {
  /** FTS5 MATCH 表达式；空串表示没有可用词。 */
  expr: string;
  /** 用于高亮/后验的原始词。 */
  terms: string[];
  /** 查询里出现过 1 个汉字的词（本索引不支持，接口据此给提示）。 */
  hasShortCjk: boolean;
}

/** 查询端：把用户输入变成 FTS5 MATCH 表达式（安全构造，永不拼接原始输入）。 */
export function analyzeQuery(query: string): QueryAnalysis {
  const parts: string[] = [];
  const terms: string[] = [];
  let hasShortCjk = false;

  for (const chunk of query.trim().split(/\s+/).filter(Boolean)) {
    terms.push(chunk);

    const tokens = transformText(chunk).split(' ').filter(Boolean);
    if (tokens.length === 0) continue;

    const cjkOnly = [...chunk].every(isCjk);
    if (cjkOnly) {
      if (chunk.length < 2) hasShortCjk = true;
      parts.push(quotePhrase(tokens));
      continue;
    }

    // 纯 ASCII 标识符：前缀查询（F 方案），例如 0x100b51cf* / getUserBy*
    if (SIMPLE_ASCII_RE.test(chunk) && chunk.length >= 2) {
      parts.push(`${chunk.toLowerCase()}*`);
      continue;
    }

    // 含分隔符或中英混排：用完整变换序列做 phrase（写入端保证同样序列）
    parts.push(quotePhrase(tokens));
  }

  return { expr: parts.join(' AND '), terms, hasShortCjk };
}

function quotePhrase(tokens: string[]): string {
  const escaped = tokens.map((t) => t.replace(/"/g, '""'));
  return `"${escaped.join(' ')}"`;
}
