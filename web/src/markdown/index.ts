import MarkdownIt from 'markdown-it';
import { calloutPlugin } from './callout';
import { escapeHtml, hasLanguage, highlightCode, normalizeLanguage } from './highlight';
import { wikilinkPlugin } from './wikilink';

/**
 * 全站唯一的 markdown-it 实例（正文、编辑器实时预览、callout 标题都复用它）。
 * html:false —— 语料里的原始 HTML 一律当文本，从根上避免 XSS；
 * 表格里的 `<br>` 在渲染前预处理成空格（见 preprocessBr）。
 */
const md = new MarkdownIt({
  html: false,
  xhtmlOut: false,
  breaks: true, // 与 Obsidian 默认行为一致：单换行即换行
  langPrefix: 'language-',
  linkify: true,
  typographer: false,
});

md.use(wikilinkPlugin);
md.use(calloutPlugin);

/** 标题 slug：保留中英文/数字，其余转 `-`；重复标题自动加 `-2`。 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~[\](){}<>]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// 给标题加 id（TOC / 锚点链接用），并在标题末尾插入一个 `#` 锚点
md.core.ruler.push('heading_ids', (state) => {
  const tokens = state.tokens;
  const used = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;
    const text = inline.content.replace(/[`*_~[\]]/g, '').trim();
    const base = slugifyHeading(text) || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n + 1}`;
    open.attrSet('id', id);

    const anchor = new state.Token('heading_anchor', 'a', 0);
    anchor.content = id;
    anchor.meta = { id };
    // heading_close 紧跟 inline（i+2），把锚点插在它前面
    tokens.splice(i + 2, 0, anchor);
  }
});

md.renderer.rules.heading_anchor = (tokens, idx) => {
  const id = String((tokens[idx].meta as { id?: string } | null)?.id ?? '');
  return `<a class="heading-anchor" href="#${md.utils.escapeHtml(id)}" aria-hidden="true" tabindex="-1">#</a>`;
};

// 代码块：只保留 <pre><code class="language-x">，语言别名归一（pwsh → powershell）
// 长代码在手机上横向滚动，给容器 tabindex 让键盘也能滚（axe: scrollable-region-focusable）
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info ?? '').trim();
  const rawLang = info.split(/\s+/)[0] ?? '';
  const known = rawLang !== '' && hasLanguage(rawLang);
  const code = known ? highlightCode(token.content, rawLang) : escapeHtml(token.content);
  const lang = rawLang ? normalizeLanguage(rawLang).replace(/[^a-z0-9+#.-]/gi, '') : '';
  const classes = ['language-' + (lang || 'text')];
  if (known) classes.push('hljs');
  return `<pre class="code-block" tabindex="0" role="region" aria-label="代码块，可左右滚动"><code class="${classes.join(' ')}">${code}</code></pre>\n`;
};

// 表格外面包一层，手机上可横向滚动而不是撑破页面；同样可键盘聚焦
md.renderer.rules.table_open = () =>
  '<div class="table-wrap" tabindex="0" role="region" aria-label="表格，可左右滚动">\n<table>\n';
md.renderer.rules.table_close = () => '</table>\n</div>\n';

// 站外链接新窗口打开；站内链接交给 router 拦截
const defaultLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet('href') ?? '');
  if (/^https?:\/\//i.test(href) && !href.startsWith(location.origin)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen ? defaultLinkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

/** 去掉开头的 YAML frontmatter（正文渲染用；编辑页仍编辑完整 raw）。 */
export function stripFrontmatter(raw: string): string {
  const s = raw.replace(/^\uFEFF/, '');
  if (!s.startsWith('---')) return s;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * CommonMark（markdown-it）的强调闭合规则：`**` 的右侧 flanking 要求「前面不是标点，或者
 * 后面是空白/标点」。语料里大量 `**本页用途：**汉字…`（中文全角冒号在 `**` 前、汉字在后）
 * 因此**不会被渲染成粗体**，而是显示成字面量 `**`。
 *
 * 修法：在闭括号前插入一个零宽空格（ZWSP），让闭括号的「前一个字符」不再是标点。
 * 视觉上完全无变化，只发生在渲染管线里（保存的 raw 不含 ZWSP）。
 *
 * 只处理 `**…**`；语料里没有 `~~`，`*x*` 的 6 处命中都是行内代码里的路径通配（不处理）。
 */
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const PUNCT_OR_SYMBOL_RE = /[\p{P}\p{S}]/u;
const ZWSP = '\u200B';

function fixBoldFlanking(line: string): string {
  // 先按行内代码切开，避免把 ZWSP 插进 `code` 里
  return splitByInlineCode(line)
    .map((part) => {
      if (part.code) return part.text;
      return part.text.replace(BOLD_RE, (match, inner: string, offset: number, whole: string) => {
        if (!inner) return match;
        const last = inner[inner.length - 1];
        const next = whole[offset + match.length];
        if (!last || !next) return match; // 行首/行尾：标准 flanking 已经成立
        if (/\s/.test(next)) return match;
        const lastPunct = PUNCT_OR_SYMBOL_RE.test(last);
        const nextPunct = PUNCT_OR_SYMBOL_RE.test(next);
        if (!lastPunct || nextPunct) return match;
        return `**${inner}${ZWSP}**`;
      });
    })
    .join('');
}

interface InlinePart {
  code: boolean;
  text: string;
}

function splitByInlineCode(line: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let buffer = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let run = 1;
      while (line[i + run] === '`') run++;
      const marker = '`'.repeat(run);
      const close = line.indexOf(marker, i + run);
      if (close === -1) {
        buffer += line.slice(i, i + run);
        i += run;
        continue;
      }
      if (buffer) {
        parts.push({ code: false, text: buffer });
        buffer = '';
      }
      parts.push({ code: true, text: line.slice(i, close + run) });
      i = close + run;
      continue;
    }
    buffer += line[i];
    i++;
  }
  if (buffer) parts.push({ code: false, text: buffer });
  return parts;
}

/**
 * 渲染前预处理（都在围栏代码块之外进行）：
 * 1. 表格单元格里的 `<br>` → 空格（html:false 下否则会显示成字面量 `<br>`）；
 * 2. 中文标点后的 `**` 闭合补齐 flanking（见 fixBoldFlanking）。
 */
export function preprocess(raw: string): string {
  const lines = raw.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE_LINE_RE.exec(line);
    if (m) {
      const marker = m[1];
      if (!fence) {
        fence = marker;
        continue;
      }
      if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = null;
        continue;
      }
    }
    if (fence) continue;

    let next = line;
    if (next.includes('<br')) next = next.replace(/<br\s*\/?>/gi, ' ');
    if (next.includes('**')) next = fixBoldFlanking(next);
    lines[i] = next;
  }
  return lines.join('\n');
}

/** 正文渲染入口（doc 页与编辑器预览共用）。 */
export function renderMarkdown(raw: string): string {
  return md.render(preprocess(stripFrontmatter(raw)));
}

/** 单行内联渲染（标题、摘要等）。 */
export function renderInline(text: string): string {
  return md.renderInline(text);
}

export { md };
