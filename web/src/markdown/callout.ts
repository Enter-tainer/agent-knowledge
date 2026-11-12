import type { MarkdownIt, StateCore, Token } from 'markdown-it';

/**
 * callout 插件（只支持 `> [!tip]` / `> [!note]`）：
 *
 *   > [!tip] 💡
 *   > 正文……
 *
 * 在 core 阶段把「引用块的第一个段落」拆成标题 + 正文：
 *   <blockquote class="callout callout-tip">
 *     <p class="callout-title">💡</p>
 *     <p>正文……</p>
 *   </blockquote>
 *
 * 未知类型（`> [!warning]` 等）**原样降级**为普通 `<blockquote>`，不做任何处理。
 * 标题里的行内 markdown 由 md.renderInline 渲染（html:false 下自动转义，XSS 安全）。
 */

const KNOWN_TYPES = new Set(['tip', 'note']);

const DEFAULT_TITLE: Record<string, string> = {
  tip: '提示',
  note: '备注',
};

const HEADER_RE = /^[ \t]{0,3}\[!([A-Za-z][\w-]*)\][ \t]*(.*)$/;

export function calloutPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'callout', (state: StateCore) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (open.type !== 'blockquote_open') continue;

      const pOpen = tokens[i + 1];
      const inline = tokens[i + 2];
      const pClose = tokens[i + 3];
      if (
        !pOpen ||
        pOpen.type !== 'paragraph_open' ||
        !inline ||
        inline.type !== 'inline' ||
        !pClose ||
        pClose.type !== 'paragraph_close'
      ) {
        continue;
      }
      // 必须是这个 blockquote 的直接子段落（排除嵌套引用块）
      if (pOpen.level !== open.level + 1) continue;

      const firstLine = inline.content.split('\n', 1)[0] ?? '';
      const header = HEADER_RE.exec(firstLine);
      if (!header) continue;

      const type = header[1].toLowerCase();
      if (!KNOWN_TYPES.has(type)) continue; // 未知类型：降级普通引用块

      const titleText = header[2].trim() || DEFAULT_TITLE[type] || '';

      open.attrJoin('class', `callout callout-${type}`);

      const titleToken = new state.Token('callout_title', '', 0) as Token;
      titleToken.content = titleText;
      titleToken.block = true;
      titleToken.level = pOpen.level;

      const restLines = inline.content.split('\n');
      const rest = restLines.slice(1).join('\n').replace(/^\n+/, '');

      const replacement: Token[] = [titleToken];
      if (rest.trim()) {
        // 复用原段落 token，只把 inline 内容换成去掉标题行之后的部分并重新解析
        inline.content = rest;
        inline.children = [];
        state.md.inline.parse(rest, state.md, state.env, inline.children);
        replacement.push(pOpen, inline, pClose);
      }
      tokens.splice(i + 1, 3, ...replacement);
    }
  });

  md.renderer.rules.callout_title = (tokens, idx) => {
    const text = tokens[idx].content;
    const html = text ? md.renderInline(text, {}) : '';
    return `<p class="callout-title">${html}</p>\n`;
  };
}
