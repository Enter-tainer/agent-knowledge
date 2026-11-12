/** 极简 DOM 构造工具。所有用户数据走 textContent，只有渲染好的 markdown 走 html。 */

export type Child = Node | string | null | undefined | false;

type Attrs = {
  class?: string;
  text?: string;
  /** 仅用于「已经是安全 HTML」的内容（markdown 渲染结果 / 转义过的摘要） */
  html?: string;
  [key: string]: unknown;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把一段纯文本里的高亮词包成 <mark>。先转义再加标记，避免注入。 */
export function markHighlights(text: string, highlights: string[]): string {
  const words = highlights.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!words.length) return escapeHtml(text);
  const escapedWords = words.map((w) => escapeHtml(w));
  let html = escapeHtml(text);
  // 占位符方案：避免把刚插入的 <mark> 再匹配一次
  const marks: string[] = [];
  for (const word of escapedWords) {
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => {
      const idx = marks.push(`<mark>${m}</mark>`) - 1;
      return `\u0000${idx}\u0000`;
    });
  }
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => marks[Number(i)] ?? '');
}

/**
 * 后端返回的 snippet 是原文片段（可能带 `**`、反引号、表格竖线、甚至 YAML frontmatter）。
 * 搜索页只做纯文本展示 + <mark>，所以先剥掉这些标记（只影响展示，不改数据）。
 */
export function cleanSnippet(input: string): string {
  let text = input.trim();

  // 1) 开头是 frontmatter：截到闭合的 --- 之后；没有闭合就丢掉元数据行
  if (text.startsWith('---')) {
    const close = text.indexOf('\n---', 3);
    if (close !== -1) {
      text = text.slice(close + 4);
    } else {
      text = text
        .split('\n')
        .filter((line) => !/^\s*(---|[A-Za-z_][\w-]*:|\s*-\s)/.test(line))
        .join('\n');
    }
  } else if (/^[A-Za-z_][\w-]*:\s/m.test(text) && /^(title|aliases|tags|source|updated|node_token|obj_token):/m.test(text)) {
    // 2) 摘要从 frontmatter 中间开始：从第一行正文截起
    const lines = text.split('\n');
    const bodyStart = lines.findIndex(
      (line) => line.trim() && !/^\s*(---|[A-Za-z_][\w-]*:|\s*-\s|\s*\[)/.test(line),
    );
    text = bodyStart === -1 ? '' : lines.slice(bodyStart).join('\n');
  }

  return text
    .replace(/^\s*>\s?/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/>\s*\[![^\]]+\][^\n]*/g, ' ')
    .replace(/>\s?/g, ' ')
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .replace(/\|/g, ' · ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[\[([^[\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 日期展示：只有日期就只显示日期，含时间才追加 HH:mm（避免历史笔记全变成 08:00）。 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const hasTime = /[T ]\d{2}:\d{2}/.test(value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!hasTime) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 只取父目录（用于列表副标题，避免标题/路径重复）。 */
export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).join(' / ');
}

export function shortHash(hash: string): string {
  return hash ? hash.slice(0, 8) : '';
}

export function pathLabel(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

export function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}
