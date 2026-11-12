import { api } from '../api';
import { NotFoundError, humanizeError } from '../api/errors';
import type { BacklinksResponse, Doc, LinkRef, LinksResponse } from '../api/types';
import { renderMarkdown } from '../markdown';
import { docUrl, editUrl, navigate, replaceUrl } from '../router';
import { loadTree } from '../store';
import { el, formatDate, parentPath, shortHash } from '../ui/dom';
import { openNewNoteDialog } from '../ui/newNote';
import { errorState, shell } from '../ui/shell';
import { loadDoc } from './data';

/** `/d/<path>`：渲染正文 + 目录 + 反链/出链面板；wikilink 用事件委托跳转。 */
export async function renderDoc(inputPath: string): Promise<HTMLElement> {
  let doc: Doc;
  try {
    doc = await loadDoc(inputPath);
  } catch (err) {
    if (err instanceof NotFoundError) return docNotFoundPage(inputPath);
    return shell({
      active: 'doc',
      content: errorState('这篇笔记加载失败', humanizeError(err), () => {
        window.dispatchEvent(new Event('kb:navigate'));
      }),
    });
  }

  // wikilink 用的是短名时，把地址栏换成真实路径
  if (doc.path !== inputPath) replaceUrl(docUrl(doc.path));
  document.title = `${doc.title || doc.path} · 私有知识库`;

  const article = el('article', { class: 'markdown-body', html: renderMarkdown(doc.raw) });
  stripDuplicateTitle(article, doc.title);
  enhanceHeadingAnchors(article);
  attachWikilinkNavigation(article);

  const [backlinks, links] = await Promise.all([
    safe(api.backlinks(doc.path)),
    safe(api.links(doc.path)),
  ]);
  if (links) markUnresolved(article, links.links);

  const content = el(
    'main',
    { class: 'doc-page' },
    el(
      'div',
      { class: 'doc-toolbar' },
      el('a', { class: 'back-link', href: '/', text: '← 目录' }),
      el('span', { class: 'doc-crumb', text: parentPath(doc.path) || '根目录' }),
    ),
    el(
      'header',
      { class: 'doc-head' },
      el('h1', { class: 'doc-title', text: doc.title || doc.path }),
      el(
        'div',
        { class: 'doc-meta' },
        el('span', { class: 'doc-updated', text: `更新于 ${formatDate(doc.updated) || '未知'}` }),
        doc.tags?.length
          ? el(
              'span',
              { class: 'tags' },
              ...doc.tags.map((tag) => el('span', { class: 'tag', text: tag })),
            )
          : null,
        el('a', { class: 'btn btn-primary', href: editUrl(doc.path), text: '编辑' }),
      ),
      versionDetails(doc),
    ),
    buildToc(article),
    article,
    backlinksPanel(backlinks),
    linksPanel(links),
  );

  // 表格/代码横向滚动的「可滑动」提示需要布局后才能判断
  window.setTimeout(() => enhanceScrollHints(article), 0);

  return shell({ active: 'doc', content });
}

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** 404：不显示后端英文，给搜索/回目录/新建 + 「你可能想找」 */
async function docNotFoundPage(inputPath: string): Promise<HTMLElement> {
  const asked = inputPath.split('/').pop() ?? inputPath;
  const suggestions = await similarDocs(inputPath);
  document.title = '没有这篇笔记 · 私有知识库';

  const content = el(
    'main',
    { class: 'doc-page' },
    el('div', { class: 'doc-toolbar' }, el('a', { class: 'back-link', href: '/', text: '← 目录' })),
    el(
      'div',
      { class: 'notfound' },
      el('h1', { class: 'doc-title', text: '没有这篇笔记' }),
      el('p', {
        class: 'notfound-text',
        text: '它可能已经被删除、改了名字，或者链接写错了。你可以搜一下，或从目录里找。',
      }),
      el(
        'div',
        { class: 'notfound-actions' },
        el('a', { class: 'btn btn-primary', href: `/search?q=${encodeURIComponent(asked)}`, text: '搜索这个标题' }),
        el('a', { class: 'btn btn-ghost', href: '/', text: '回目录' }),
        el('button', { type: 'button', class: 'btn btn-ghost', text: '＋ 新建笔记', onclick: () => openNewNoteDialog() }),
      ),
      suggestions.length
        ? el(
            'div',
            { class: 'notfound-suggestions' },
            el('h2', { class: 'panel-title', text: '你可能想找' }),
            el(
              'ul',
              { class: 'link-list' },
              ...suggestions.map((entry) =>
                el(
                  'li',
                  { class: 'link-item' },
                  el('a', { class: 'link-title', href: docUrl(entry.path), text: entry.title || entry.path }),
                  entry.path !== entry.title
                    ? el('span', { class: 'link-path muted', text: parentPath(entry.path) })
                    : null,
                ),
              ),
            ),
          )
        : null,
    ),
  );

  return shell({ active: 'doc', content });
}

interface SimilarDoc {
  path: string;
  title: string;
  score: number;
}

/** 按「标题/路径包含 + 字符重合」给几个可能的候选（36 篇量级，线性扫很快）。 */
async function similarDocs(inputPath: string): Promise<SimilarDoc[]> {
  let entries;
  try {
    entries = await loadTree();
  } catch {
    return [];
  }
  const asked = (inputPath.split('/').pop() ?? inputPath).toLowerCase();
  const chars = [...new Set(asked.replace(/\s/g, ''))].filter((c) => /[\p{L}\p{N}]/u.test(c));

  const scored: SimilarDoc[] = [];
  for (const entry of entries) {
    const hay = `${entry.title} ${entry.path}`.toLowerCase();
    let score = 0;
    if (hay.includes(asked)) score += 10;
    if (entry.title.toLowerCase().includes(asked)) score += 6;
    for (const c of chars) if (hay.includes(c)) score += 1;
    if (score >= Math.max(4, chars.length * 0.5)) {
      scored.push({ path: entry.path, title: entry.title || entry.path, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

function stripDuplicateTitle(article: HTMLElement, title: string): void {
  const first = article.firstElementChild;
  if (!first || first.tagName !== 'H1') return;
  // 标题里带了锚点 `<a>#</a>`，textContent 会多一个 `#`
  const text = (first.textContent ?? '').replace(/#/g, '').trim();
  if (text === title.trim() || text === '') first.remove();
}

/** 给标题锚点补上可读的 aria-label（渲染出来的是纯 `#`）。 */
function enhanceHeadingAnchors(article: HTMLElement): void {
  for (const heading of article.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4')) {
    const id = heading.id;
    if (!id) continue;
    const anchor = heading.querySelector<HTMLAnchorElement>('.heading-anchor');
    if (!anchor) continue;
    anchor.setAttribute('aria-hidden', 'false');
    anchor.setAttribute('aria-label', `复制「${(heading.textContent ?? '').replace('#', '').trim()}」的链接`);
    anchor.title = '复制这一节的链接';
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      const url = `${location.origin}${location.pathname}#${encodeURIComponent(id)}`;
      history.replaceState(null, '', `#${id}`);
      void navigator.clipboard?.writeText(url).then(
        () => {
          anchor.classList.add('is-copied');
          window.setTimeout(() => anchor.classList.remove('is-copied'), 1200);
        },
        () => {
          /* 剪贴板不可用时只跳转 */
        },
      );
      heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}

/** 文档页目录：从已渲染的标题生成，3 个以内不出目录；手机默认收起。 */
function buildToc(article: HTMLElement): HTMLElement | null {
  const headings = [...article.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4')].filter((h) => h.id);
  if (headings.length < 3) return null;
  const isMobile = window.matchMedia('(max-width: 860px)').matches;

  const details = el('details', { class: 'toc' });
  if (!isMobile) details.open = true;
  details.appendChild(
    el(
      'summary',
      { class: 'toc-summary' },
      el('span', { text: `本页目录（${headings.length} 节）` }),
      el('span', { class: 'toc-hint muted', text: '点标题跳转' }),
    ),
  );

  const list = el('ul', { class: 'toc-list' });
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    list.appendChild(
      el(
        'li',
        { class: `toc-item toc-level-${level}` },
        el('a', { class: 'toc-link', href: `#${heading.id}`, text: (heading.textContent ?? '').replace('#', '').trim() }),
      ),
    );
  }
  details.appendChild(list);
  return details;
}

function versionDetails(doc: Doc): HTMLElement {
  return el(
    'details',
    { class: 'doc-version' },
    el('summary', { class: 'doc-version-summary', text: '版本信息' }),
    el(
      'div',
      { class: 'doc-version-body' },
      el('span', { text: `版本 ${shortHash(doc.hash)}` }),
      el('span', { class: 'dot' }),
      el('span', { text: `第 ${doc.revision} 次保存` }),
      doc.tags?.length ? el('span', { class: 'dot' }) : null,
      doc.tags?.length ? el('span', { text: `标签：${doc.tags.join('、')}` }) : null,
    ),
  );
}

/** 事件委托：文章内所有 `.wikilink` 点击都走 SPA 导航，不在这里发请求。 */
function attachWikilinkNavigation(article: HTMLElement): void {
  article.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('.wikilink');
    if (!anchor) return;
    const name = anchor.getAttribute('data-target');
    if (!name) return;
    event.preventDefault();
    void navigate(`/d/${encodeURIComponent(name)}/`);
  });
}

function markUnresolved(article: HTMLElement, links: LinkRef[]): void {
  const unresolved = new Set(links.filter((l) => !l.resolved).map((l) => l.target.trim().toLowerCase()));
  if (unresolved.size === 0) return;
  for (const anchor of article.querySelectorAll<HTMLAnchorElement>('.wikilink')) {
    const target = (anchor.getAttribute('data-target') ?? '').trim().toLowerCase();
    if (!target) continue;
    if (unresolved.has(target)) {
      anchor.classList.add('wikilink-broken');
      anchor.title = `链接目标不存在：${anchor.getAttribute('data-target')}`;
    }
  }
}

/** 给可横向滚动的表格加「左右滑动」提示（只在真的溢出时加）。 */
function enhanceScrollHints(article: HTMLElement): void {
  for (const wrap of article.querySelectorAll<HTMLElement>('.table-wrap')) {
    if (wrap.scrollWidth <= wrap.clientWidth + 4 || wrap.dataset.hinted === '1') continue;
    wrap.dataset.hinted = '1';
    wrap.classList.add('is-scrollable');
    wrap.insertAdjacentElement(
      'beforebegin',
      el('div', { class: 'scroll-hint', 'aria-hidden': 'true', text: '← 左右滑动查看完整表格 →' }),
    );
  }
  for (const pre of article.querySelectorAll<HTMLElement>('pre.code-block')) {
    if (pre.scrollWidth <= pre.clientWidth + 4) continue;
    pre.classList.add('is-scrollable');
  }
}

function backlinksPanel(data: BacklinksResponse | null): HTMLElement {
  const panel = el('section', { class: 'panel', 'aria-labelledby': 'backlinks-title' });
  const items = data?.backlinks ?? [];
  panel.appendChild(
    el(
      'h2',
      { class: 'panel-title', id: 'backlinks-title' },
      '哪些笔记提到了这篇',
      el('span', { class: 'badge', text: String(items.length) }),
    ),
  );

  if (!data) {
    panel.appendChild(el('p', { class: 'panel-hint', text: '反链暂时加载失败，刷新页面可重试。' }));
    return panel;
  }
  if (items.length === 0) {
    panel.appendChild(el('p', { class: 'panel-hint', text: '还没有别的笔记提到这篇。' }));
    return panel;
  }

  const list = el('ul', { class: 'link-list' });
  for (const item of items) {
    list.appendChild(
      el(
        'li',
        { class: 'link-item' },
        el('a', { class: 'link-title', href: docUrl(item.path), text: item.title || item.path }),
        el('span', { class: 'mention-count', text: `提到 ${item.count} 次` }),
        el('span', { class: 'link-path muted', text: parentPath(item.path) }),
      ),
    );
  }
  panel.appendChild(list);
  return panel;
}

function linksPanel(data: LinksResponse | null): HTMLElement {
  const panel = el('section', { class: 'panel', 'aria-labelledby': 'links-title' });
  const items = data?.links ?? [];
  panel.appendChild(
    el(
      'h2',
      { class: 'panel-title', id: 'links-title' },
      '这篇引用的笔记',
      el('span', { class: 'badge', text: String(items.length) }),
    ),
  );

  if (!data) {
    panel.appendChild(el('p', { class: 'panel-hint', text: '引用列表暂时加载失败，刷新页面可重试。' }));
    return panel;
  }
  if (items.length === 0) {
    panel.appendChild(el('p', { class: 'panel-hint', text: '这篇没有引用别的笔记。' }));
    return panel;
  }

  const list = el('ul', { class: 'link-list' });
  for (const link of items) {
    if (!link.resolved || !link.dstPath) {
      list.appendChild(
        el(
          'li',
          { class: 'link-item' },
          el('span', { class: 'link-broken', text: link.target }),
          el('span', { class: 'badge badge-warn', text: '链接目标不存在' }),
        ),
      );
      continue;
    }
    list.appendChild(
      el(
        'li',
        { class: 'link-item' },
        el('a', {
          class: 'link-title',
          href: docUrl(link.dstPath),
          text: link.target,
        }),
      ),
    );
  }
  panel.appendChild(list);
  return panel;
}
