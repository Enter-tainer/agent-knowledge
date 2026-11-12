import type { MarkdownIt, StateInline } from 'markdown-it';

/**
 * wikilink 插件：`[[目标]]` / `[[目标|别名]]` / `[[目标#小标题]]`
 *
 * 输出固定为 `<a class="wikilink" data-target="目标">目标</a>`，**不在这里发请求**：
 * 导航统一由 doc 页面的 click 事件委托处理（跳到 `/d/<encodeURIComponent(target)>`）。
 *
 * XSS：target 与显示文本都走 md.utils.escapeHtml，只作为文本节点内容，不接受 HTML。
 * 行内代码里的 `[[…]]` 不会命中本规则（backticks 规则先于 link 规则消费掉）。
 */

const AT_OPEN = 0x5b; // [
const AT_BANG = 0x21; // !

export interface WikilinkMeta {
  target: string;
}

export function wikilinkPlugin(md: MarkdownIt): void {
  const rule = (state: StateInline, silent: boolean): boolean => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== AT_OPEN || src.charCodeAt(pos + 1) !== AT_OPEN) return false;
    // `![[…]]`（Obsidian 嵌入）本方案不支持，交给正常解析，避免把 `!` 吞掉
    if (pos > 0 && src.charCodeAt(pos - 1) === AT_BANG) return false;

    const close = src.indexOf(']]', pos + 2);
    if (close === -1) return false;

    const inner = src.slice(pos + 2, close);
    if (!inner || inner.includes('[') || inner.includes(']') || inner.includes('\n')) return false;

    // 目标 / 别名 / 锚点：只取目标作为 data-target（与后端 links 解析口径一致）
    const pipe = inner.indexOf('|');
    let target = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? '' : inner.slice(pipe + 1);
    const hash = target.indexOf('#');
    if (hash !== -1) target = target.slice(0, hash);
    target = target.trim();
    if (!target) return false;

    const label = (alias.trim() || target).trim();
    if (!silent) {
      const token = state.push('wikilink', '', 0);
      token.content = label;
      token.markup = '[[';
      token.meta = { target } satisfies WikilinkMeta;
      token.attrSet('class', 'wikilink');
      token.attrSet('data-target', target);
    }
    state.pos = close + 2;
    return true;
  };

  md.inline.ruler.before('link', 'wikilink', rule);

  // 渲染：文本节点 + 属性；不使用 innerHTML 拼接用户数据
  md.renderer.rules.wikilink = (tokens, idx) => {
    const token = tokens[idx];
    const meta = token.meta as unknown as WikilinkMeta | null;
    const target = typeof meta?.target === 'string' ? meta.target : token.content;
    return `<a class="wikilink" data-target="${md.utils.escapeHtml(target)}">${md.utils.escapeHtml(
      token.content,
    )}</a>`;
  };
}
