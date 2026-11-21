import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Edit3,
  FilePlus2,
  FolderInput,
  Hash,
  Link2,
  MoreHorizontal,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ApiError, NotFoundError, humanizeError } from '../api/errors';
import type { Backlink, Doc, LinkRef, TreeEntry } from '../api/types';
import { renderMarkdown, stripFrontmatter } from '../markdown';
import { currentRouteUrl, docUrl, editUrl, navigate, replaceUrl } from '../router';
import { invalidateTree, loadTree } from '../store';
import { formatDate, parentPath, shortHash } from '../ui/dom';
import { openNewNoteDialog } from '../ui/newNote';
import { createReactPageView } from '../ui/react-view';
import { toast } from '../ui/shell';
import { buildTree, collectDocs } from '../ui/tree-model';
import type { PageView } from '../ui/view';
import { loadDoc } from './data';

interface TocHeading {
  id: string;
  text: string;
  level: number;
}

function estimateReadingStats(raw: string): { chars: number; minutes: number } {
  const body = stripFrontmatter(raw).replace(/\s+/g, '');
  const chars = body.length;
  const minutes = Math.max(1, Math.round(chars / 450));
  return { chars, minutes };
}

function stripDuplicateTitle(article: HTMLElement, title: string): void {
  const first = article.firstElementChild;
  if (!first || first.tagName !== 'H1') return;
  const text = (first.textContent ?? '').replace(/#/g, '').trim();
  if (text === title.trim() || text === '') first.remove();
}

function enhanceHeadingAnchors(article: HTMLElement): void {
  for (const heading of article.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4')) {
    const id = heading.id;
    if (!id) continue;
    const anchor = heading.querySelector<HTMLAnchorElement>('.heading-anchor');
    if (!anchor) continue;
    const cleanText = (heading.textContent ?? '').replace('#', '').trim();
    anchor.setAttribute('aria-hidden', 'false');
    anchor.setAttribute('aria-label', `复制「${cleanText}」的链接`);
    anchor.title = '复制这一节的链接';
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      const url = `${location.origin}${location.pathname}#${encodeURIComponent(id)}`;
      try {
        history.replaceState({ ...(history.state ?? {}) }, '', `#${id}`);
      } catch {
        /* ignore */
      }
      void navigator.clipboard?.writeText(url).then(
        () => {
          anchor.classList.add('is-copied');
          toast('已复制章节链接', 'success');
          window.setTimeout(() => anchor.classList.remove('is-copied'), 1200);
        },
        () => undefined,
      );
      heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}

function enhanceCodeBlocks(article: HTMLElement): void {
  for (const pre of article.querySelectorAll<HTMLPreElement>('pre.code-block')) {
    if (pre.parentElement?.classList.contains('code-wrap')) continue;
    const code = pre.querySelector('code');
    const langClass = [...(code?.classList ?? [])].find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : 'text';

    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';

    const bar = document.createElement('div');
    bar.className = 'code-bar';

    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-copy-btn';
    copyBtn.textContent = '复制';
    copyBtn.setAttribute('aria-label', '复制代码');
    copyBtn.addEventListener('click', () => {
      const text = code?.textContent ?? pre.textContent ?? '';
      void navigator.clipboard?.writeText(text).then(
        () => {
          copyBtn.textContent = '✓ 已复制';
          copyBtn.classList.add('is-copied');
          window.setTimeout(() => {
            copyBtn.textContent = '复制';
            copyBtn.classList.remove('is-copied');
          }, 1500);
        },
        () => {
          toast('复制失败，请手动选中复制', 'error');
        },
      );
    });

    bar.append(label, copyBtn);
    pre.replaceWith(wrap);
    wrap.append(bar, pre);
  }
}

function enhanceScrollHints(article: HTMLElement): void {
  for (const wrap of article.querySelectorAll<HTMLElement>('.table-wrap')) {
    if (wrap.scrollWidth <= wrap.clientWidth + 4 || wrap.dataset.hinted === '1') continue;
    wrap.dataset.hinted = '1';
    wrap.classList.add('is-scrollable');
    const hint = document.createElement('div');
    hint.className = 'scroll-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '← 左右滑动查看完整表格 →';
    wrap.insertAdjacentElement('beforebegin', hint);
  }
  for (const pre of article.querySelectorAll<HTMLElement>('pre.code-block')) {
    if (pre.scrollWidth <= pre.clientWidth + 4) continue;
    pre.classList.add('is-scrollable');
  }
}

function markUnresolved(article: HTMLElement, links: LinkRef[]): void {
  const unresolved = new Set(links.filter((l) => !l.resolved).map((l) => l.target.trim().toLowerCase()));
  for (const anchor of article.querySelectorAll<HTMLAnchorElement>('.wikilink')) {
    const target = (anchor.getAttribute('data-target') ?? '').trim().toLowerCase();
    if (!target) continue;
    if (unresolved.has(target)) {
      anchor.classList.add('wikilink-broken');
      anchor.title = `目标笔记不存在：${anchor.getAttribute('data-target')}（点击可查看或创建）`;
    } else {
      anchor.classList.remove('wikilink-broken');
    }
  }
}

function extractHeadings(article: HTMLElement): TocHeading[] {
  return [...article.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4')]
    .filter((h) => h.id)
    .map((h) => ({
      id: h.id,
      text: (h.textContent ?? '').replace(/#/g, '').trim(),
      level: Number(h.tagName.slice(1)),
    }));
}

interface PanelState<T> {
  status: 'loading' | 'ready' | 'error';
  data?: T;
  error?: unknown;
}

function RenameDialog({
  open,
  onOpenChange,
  currentPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
}) {
  const [nextPath, setNextPath] = useState(currentPath);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNextPath(currentPath);
      setError(null);
    }
  }, [open, currentPath]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const cleaned = nextPath
      .trim()
      .replace(/\.md$/i, '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (!cleaned) {
      setError('路径不能为空');
      return;
    }
    if (cleaned === currentPath) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.rename(currentPath, cleaned);
      invalidateTree();
      onOpenChange(false);
      toast(
        res.rewritten > 0
          ? `已重命名为「${res.to}」，并自动更新了 ${res.rewritten} 篇引用笔记的双链`
          : `已重命名为「${res.to}」`,
        'success',
      );
      await navigate(docUrl(res.to), { replace: true });
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal" aria-describedby="rename-desc">
          <div className="modal-header">
            <Dialog.Title className="modal-title">重命名 / 移动笔记</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="btn-icon" aria-label="关闭">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description id="rename-desc" className="modal-desc">
            修改路径后，全库中引用了这篇笔记的 <code>[[双链]]</code> 会自动同步改写。
          </Dialog.Description>
          <form onSubmit={(e) => void handleSubmit(e)}>
            <label className="field-label">
              <span>新路径（不含 .md）</span>
              <input
                type="text"
                className="field-input"
                value={nextPath}
                onChange={(e) => {
                  setNextPath(e.target.value);
                  setError(null);
                }}
                autoFocus
                spellCheck={false}
              />
            </label>
            {error ? <p className="field-error" role="alert">{error}</p> : null}
            <div className="modal-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-ghost">
                  取消
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? '处理中…' : '确认移动'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DeleteDialog({
  open,
  onOpenChange,
  doc,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: Doc;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setConflictMsg(null);
      setError(null);
    }
  }, [open]);

  const handleDelete = async (force: boolean): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await api.deleteDoc(doc.path, force);
      invalidateTree();
      onOpenChange(false);
      toast(`已删除「${doc.title || doc.path}」`, 'success');
      await navigate('/', { replace: true });
    } catch (err) {
      if (!force && err instanceof ApiError && err.status === 409) {
        setConflictMsg(err.message || '还有其他笔记引用了这篇文档，强制删除会让这些引用变成断链。');
      } else {
        setError(humanizeError(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal" aria-describedby="delete-desc">
          <div className="modal-header">
            <Dialog.Title className="modal-title">删除这篇笔记？</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="btn-icon" aria-label="关闭">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description id="delete-desc" className="modal-desc">
            即将永久删除 <strong>{doc.title || doc.path}</strong>（<code>{doc.path}</code>），删除后无法撤销。
          </Dialog.Description>
          {conflictMsg ? (
            <div className="notice" role="alert">
              <strong>检测到入链引用：</strong>
              <span>{conflictMsg}</span>
            </div>
          ) : null}
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-ghost">
                取消
              </button>
            </Dialog.Close>
            {conflictMsg ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={submitting}
                onClick={() => void handleDelete(true)}
              >
                {submitting ? '删除中…' : '强制删除（保留断链）'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                disabled={submitting}
                onClick={() => void handleDelete(false)}
              >
                {submitting ? '删除中…' : '确认删除'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DocPageComponent({ doc }: { doc: Doc }) {
  const articleRef = useRef<HTMLElement | null>(null);
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [backlinksState, setBacklinksState] = useState<PanelState<Backlink[]>>({ status: 'loading' });
  const [linksState, setLinksState] = useState<PanelState<LinkRef[]>>({ status: 'loading' });
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [mobileTocOpen, setMobileTocOpen] = useState(false);

  const renderedHtml = useMemo(() => renderMarkdown(doc.raw), [doc.raw]);
  const stats = useMemo(() => estimateReadingStats(doc.raw), [doc.raw]);

  const loadBacklinks = useCallback(() => {
    setBacklinksState({ status: 'loading' });
    void api
      .backlinks(doc.path)
      .then((res) => setBacklinksState({ status: 'ready', data: res.backlinks ?? [] }))
      .catch((err) => setBacklinksState({ status: 'error', error: err }));
  }, [doc.path]);

  const loadLinks = useCallback(() => {
    setLinksState({ status: 'loading' });
    void api
      .links(doc.path)
      .then((res) => {
        const list = res.links ?? [];
        setLinksState({ status: 'ready', data: list });
        if (articleRef.current) markUnresolved(articleRef.current, list);
      })
      .catch((err) => setLinksState({ status: 'error', error: err }));
  }, [doc.path]);

  useEffect(() => {
    loadBacklinks();
    loadLinks();
    void loadTree()
      .then(setTreeEntries)
      .catch(() => undefined);
  }, [loadBacklinks, loadLinks]);

  // 同步填充正文 DOM 与增强交互（不随 React state 刷新而重建）
  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    article.innerHTML = renderedHtml;
    stripDuplicateTitle(article, doc.title);
    enhanceHeadingAnchors(article);
    enhanceCodeBlocks(article);
    setHeadings(extractHeadings(article));

    const timer = window.setTimeout(() => enhanceScrollHints(article), 0);

    const onArticleClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('.wikilink');
      if (!anchor) return;
      const name = anchor.getAttribute('data-target');
      if (!name) return;
      event.preventDefault();
      void navigate(`/d/${encodeURIComponent(name)}/`);
    };
    article.addEventListener('click', onArticleClick);

    return () => {
      window.clearTimeout(timer);
      article.removeEventListener('click', onArticleClick);
    };
  }, [renderedHtml, doc.title]);

  // 若 links 先于重渲染完成，确保断链标记同步
  useEffect(() => {
    if (linksState.status === 'ready' && linksState.data && articleRef.current) {
      markUnresolved(articleRef.current, linksState.data);
    }
  }, [linksState]);

  // 右侧悬浮 TOC 滚动高亮（IntersectionObserver）
  useEffect(() => {
    if (headings.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    setActiveId(elements[0]!.id);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: '-76px 0px -65% 0px', threshold: [0, 1] },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [headings]);

  // 快捷键 `e` 进入编辑
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'e') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"], .modal-overlay')) return;
      event.preventDefault();
      void navigate(editUrl(doc.path));
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [doc.path]);

  // 面包屑与上下篇
  const segments = useMemo(() => doc.path.split('/').filter(Boolean), [doc.path]);
  const entrySet = useMemo(() => new Set(treeEntries.map((e) => e.path)), [treeEntries]);
  const { prevDoc, nextDoc } = useMemo(() => {
    if (treeEntries.length === 0) return { prevDoc: null, nextDoc: null };
    const ordered = collectDocs(buildTree(treeEntries));
    const idx = ordered.findIndex((n) => n.path === doc.path);
    if (idx === -1) return { prevDoc: null, nextDoc: null };
    return {
      prevDoc: idx > 0 ? ordered[idx - 1]! : null,
      nextDoc: idx + 1 < ordered.length ? ordered[idx + 1]! : null,
    };
  }, [treeEntries, doc.path]);

  const jumpToHeading = (event: React.MouseEvent, id: string): void => {
    event.preventDefault();
    setActiveId(id);
    try {
      history.replaceState({ ...(history.state ?? {}) }, '', `#${encodeURIComponent(id)}`);
    } catch {
      /* ignore */
    }
    const target = document.getElementById(id);
    if (!target) return;
    const topbarH = document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect().height ?? 56;
    const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - topbarH - 18);
    window.scrollTo({ top, behavior: 'auto' });
  };

  const copyPath = (): void => {
    void navigator.clipboard?.writeText(doc.path).then(() => {
      setCopiedPath(true);
      toast('已复制笔记路径');
      window.setTimeout(() => setCopiedPath(false), 1400);
    });
  };

  const copyRawMarkdown = (): void => {
    void navigator.clipboard?.writeText(doc.raw).then(
      () => toast('已复制 Markdown 原文', 'success'),
      () => toast('复制失败', 'error'),
    );
  };

  const copyPageLink = (): void => {
    void navigator.clipboard?.writeText(location.href).then(
      () => toast('已复制页面链接', 'success'),
      () => toast('复制失败', 'error'),
    );
  };

  const backlinksCount = backlinksState.data?.length ?? 0;
  const linksCount = linksState.data?.length ?? 0;
  const dirForNew = parentPath(doc.path).replace(/\s*\/\s*/g, '/');

  return (
    <div className="doc-layout">
      <div className="doc-main">
        <div className="doc-toolbar">
          <a className="back-link" href="/">
            <ArrowLeft size={14} />
            <span>目录</span>
          </a>
          <nav className="doc-breadcrumbs" aria-label="笔记路径">
            {segments.slice(0, -1).map((seg, i) => {
              const segPath = segments.slice(0, i + 1).join('/');
              const hasDoc = entrySet.has(segPath);
              return (
                <span key={segPath} className="doc-crumb-item">
                  <ChevronRight size={13} className="doc-crumb-sep" aria-hidden="true" />
                  {hasDoc ? (
                    <a href={docUrl(segPath)} className="doc-crumb-link">
                      {seg}
                    </a>
                  ) : (
                    <span className="doc-crumb-text">{seg}</span>
                  )}
                </span>
              );
            })}
            <button
              type="button"
              className="doc-copy-path"
              title={`复制路径：${doc.path}`}
              onClick={copyPath}
            >
              {copiedPath ? <Check size={12} /> : <Copy size={12} />}
              <span>{doc.path}</span>
            </button>
          </nav>
        </div>

        <header className="doc-head">
          <div className="doc-head-top">
            <h1 className="doc-title">{doc.title || doc.path}</h1>
            <div className="doc-actions">
              <a className="btn btn-primary" href={editUrl(doc.path)} title="编辑笔记（快捷键 E）">
                <Edit3 size={15} />
                <span>编辑</span>
              </a>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setRenameOpen(true)}
                title="重命名或移动到其他目录"
              >
                <FolderInput size={15} />
                <span className="hide-xs">重命名</span>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="btn btn-ghost btn-icon-only" aria-label="更多文档操作">
                    <MoreHorizontal size={16} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={6}>
                    <DropdownMenu.Item
                      className="dropdown-item"
                      onSelect={() => openNewNoteDialog(dirForNew || undefined)}
                    >
                      <FilePlus2 size={14} />
                      <span>在当前目录新建笔记</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="dropdown-item" onSelect={copyRawMarkdown}>
                      <Copy size={14} />
                      <span>复制 Markdown 原文</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="dropdown-item" onSelect={copyPageLink}>
                      <Link2 size={14} />
                      <span>复制页面链接</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="dropdown-sep" />
                    <DropdownMenu.Item
                      className="dropdown-item dropdown-item-danger"
                      onSelect={() => setDeleteOpen(true)}
                    >
                      <Trash2 size={14} />
                      <span>删除这篇笔记…</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>

          <div className="doc-meta">
            <span className="doc-meta-chip">更新于 {formatDate(doc.updated) || '未知'}</span>
            <span className="doc-meta-chip">
              {stats.chars.toLocaleString()} 字 · 约 {stats.minutes} 分钟
            </span>
            <span className="doc-meta-chip doc-meta-mono" title={`完整版本哈希：${doc.hash}`}>
              v{doc.revision} · #{shortHash(doc.hash)}
            </span>
            {doc.tags?.length ? (
              <span className="tags">
                {doc.tags.map((tag) => (
                  <a key={tag} href={`/search?q=${encodeURIComponent(tag)}`} className="tag tag-link">
                    <Tag size={11} />
                    <span>{tag}</span>
                  </a>
                ))}
              </span>
            ) : null}
          </div>
        </header>

        {headings.length >= 2 ? (
          <div className="doc-toc-compact">
            <button
              type="button"
              className="doc-toc-compact-toggle"
              aria-expanded={mobileTocOpen}
              onClick={() => setMobileTocOpen((v) => !v)}
            >
              <span>本页大纲（{headings.length} 节）</span>
              <span className="muted">{mobileTocOpen ? '收起' : '展开'}</span>
            </button>
            {mobileTocOpen ? (
              <ul className="toc-list">
                {headings.map((h) => (
                  <li key={h.id} className={`toc-item toc-level-${h.level}`}>
                    <a
                      className={`toc-link${activeId === h.id ? ' is-active' : ''}`}
                      href={`#${h.id}`}
                      onClick={(e) => {
                        jumpToHeading(e, h.id);
                        setMobileTocOpen(false);
                      }}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <article ref={articleRef} className="markdown-body" />

        {prevDoc || nextDoc ? (
          <nav className="doc-pager" aria-label="上下篇笔记">
            {prevDoc ? (
              <a href={docUrl(prevDoc.path)} className="doc-pager-card">
                <span className="doc-pager-label">
                  <ArrowLeft size={13} /> 上一篇
                </span>
                <span className="doc-pager-title">{prevDoc.name}</span>
              </a>
            ) : (
              <div />
            )}
            {nextDoc ? (
              <a href={docUrl(nextDoc.path)} className="doc-pager-card doc-pager-next">
                <span className="doc-pager-label">
                  下一篇 <ArrowRight size={13} />
                </span>
                <span className="doc-pager-title">{nextDoc.name}</span>
              </a>
            ) : null}
          </nav>
        ) : null}
      </div>

      <aside className="doc-aside" aria-label="大纲与引用关系">
        <div className="doc-aside-sticky">
          {headings.length >= 2 ? (
            <section className="aside-card toc-aside" aria-label="本页大纲">
              <div className="aside-card-head">
                <Hash size={14} />
                <span>本页大纲</span>
                <span className="aside-count">{headings.length}</span>
              </div>
              <ul className="toc-aside-list">
                {headings.map((h) => (
                  <li key={h.id} className={`toc-aside-item toc-level-${h.level}`}>
                    <a
                      href={`#${h.id}`}
                      className={`toc-aside-link${activeId === h.id ? ' is-active' : ''}`}
                      onClick={(e) => jumpToHeading(e, h.id)}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="aside-card links-aside" aria-label="双链关系">
            <Tabs.Root defaultValue="backlinks" className="aside-tabs">
              <Tabs.List className="aside-tabs-list" aria-label="链接关系切换">
                <Tabs.Trigger value="backlinks" className="aside-tab-trigger">
                  <span>提及此篇</span>
                  <span className="aside-badge">{backlinksState.status === 'ready' ? backlinksCount : '…'}</span>
                </Tabs.Trigger>
                <Tabs.Trigger value="links" className="aside-tab-trigger">
                  <span>本文引用</span>
                  <span className="aside-badge">{linksState.status === 'ready' ? linksCount : '…'}</span>
                </Tabs.Trigger>
              </Tabs.List>

              <Tabs.Content value="backlinks" className="aside-tab-body">
                {backlinksState.status === 'loading' ? (
                  <p className="aside-hint">加载反链中…</p>
                ) : backlinksState.status === 'error' ? (
                  <div className="aside-error">
                    <p>{humanizeError(backlinksState.error)}</p>
                    <button type="button" className="btn btn-ghost btn-small" onClick={loadBacklinks}>
                      <RefreshCw size={12} /> 重试
                    </button>
                  </div>
                ) : backlinksCount === 0 ? (
                  <p className="aside-hint">还没有其他笔记提到这篇。</p>
                ) : (
                  <ul className="aside-link-list">
                    {backlinksState.data!.map((item) => (
                      <li key={item.path} className="aside-link-item">
                        <a href={docUrl(item.path)} className="aside-link-title">
                          <span>{item.title || item.path}</span>
                          <span className="aside-mention">{item.count}</span>
                        </a>
                        {parentPath(item.path) ? (
                          <span className="aside-link-path">{parentPath(item.path)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Tabs.Content>

              <Tabs.Content value="links" className="aside-tab-body">
                {linksState.status === 'loading' ? (
                  <p className="aside-hint">加载出链中…</p>
                ) : linksState.status === 'error' ? (
                  <div className="aside-error">
                    <p>{humanizeError(linksState.error)}</p>
                    <button type="button" className="btn btn-ghost btn-small" onClick={loadLinks}>
                      <RefreshCw size={12} /> 重试
                    </button>
                  </div>
                ) : linksCount === 0 ? (
                  <p className="aside-hint">这篇没有引用其他笔记。</p>
                ) : (
                  <ul className="aside-link-list">
                    {linksState.data!.map((link, idx) =>
                      link.resolved && link.dstPath ? (
                        <li key={`${link.dstPath}-${idx}`} className="aside-link-item">
                          <a href={docUrl(link.dstPath)} className="aside-link-title">
                            <span>{link.target}</span>
                            <ArrowUpRight size={13} />
                          </a>
                          {parentPath(link.dstPath) ? (
                            <span className="aside-link-path">{parentPath(link.dstPath)}</span>
                          ) : null}
                        </li>
                      ) : (
                        <li key={`broken-${link.target}-${idx}`} className="aside-link-item is-broken">
                          <div className="aside-broken-row">
                            <span className="link-broken">{link.target}</span>
                            <a
                              href={editUrl(link.target, true)}
                              className="aside-create-link"
                              title={`创建「${link.target}」`}
                            >
                              ＋ 创建
                            </a>
                          </div>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </aside>

      <RenameDialog open={renameOpen} onOpenChange={setRenameOpen} currentPath={doc.path} />
      <DeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} doc={doc} />
    </div>
  );
}

function SimilarDocsView({ inputPath }: { inputPath: string }) {
  const asked = inputPath.split('/').pop() ?? inputPath;
  const [suggestions, setSuggestions] = useState<Array<{ path: string; title: string }>>([]);

  useEffect(() => {
    void loadTree()
      .then((entries) => {
        const lower = asked.toLowerCase();
        const chars = [...new Set(lower.replace(/\s/g, ''))].filter((c) => /[\p{L}\p{N}]/u.test(c));
        const scored: Array<{ path: string; title: string; score: number }> = [];
        for (const entry of entries) {
          const hay = `${entry.title} ${entry.path}`.toLowerCase();
          let score = 0;
          if (hay.includes(lower)) score += 10;
          if (entry.title.toLowerCase().includes(lower)) score += 6;
          for (const c of chars) if (hay.includes(c)) score += 1;
          if (score >= Math.max(4, chars.length * 0.5)) {
            scored.push({ path: entry.path, title: entry.title || entry.path, score });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        setSuggestions(scored.slice(0, 5));
      })
      .catch(() => undefined);
  }, [asked]);

  return (
    <div className="doc-main">
      <div className="doc-toolbar">
        <a className="back-link" href="/">
          <ArrowLeft size={14} />
          <span>目录</span>
        </a>
      </div>
      <div className="notfound">
        <h1 className="doc-title">没有这篇笔记</h1>
        <p className="notfound-text">
          路径「<code>{inputPath}</code>」不存在，可能已被删除、移动，或者双链写错了名字。
        </p>
        <div className="notfound-actions">
          <a className="btn btn-primary" href={editUrl(inputPath, true)}>
            <FilePlus2 size={15} />
            <span>立即创建这篇笔记</span>
          </a>
          <a className="btn btn-ghost" href={`/search?q=${encodeURIComponent(asked)}`}>
            搜索这个标题
          </a>
          <a className="btn btn-ghost" href="/">
            回目录
          </a>
        </div>
        {suggestions.length > 0 ? (
          <div className="notfound-suggestions">
            <h2 className="panel-title">你可能想找</h2>
            <ul className="link-list">
              {suggestions.map((entry) => (
                <li key={entry.path} className="link-item">
                  <a className="link-title" href={docUrl(entry.path)}>
                    {entry.title}
                  </a>
                  {entry.path !== entry.title ? (
                    <span className="link-path muted">{parentPath(entry.path)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export async function renderDoc(inputPath: string): Promise<PageView> {
  const startedAtUrl = currentRouteUrl();
  let doc: Doc;
  try {
    doc = await loadDoc(inputPath);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return createReactPageView(<SimilarDocsView inputPath={inputPath} />, {
        className: 'doc-page',
        active: 'doc',
        title: '没有这篇笔记 · 私有知识库',
      });
    }
    return createReactPageView(
      <div className="state state-error">
        <h2>这篇笔记加载失败</h2>
        <p className="state-detail">{humanizeError(err)}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.dispatchEvent(new Event('kb:navigate'))}
        >
          重试
        </button>
      </div>,
      {
        className: 'doc-page',
        active: 'doc',
        title: '加载失败 · 私有知识库',
      },
    );
  }

  if (doc.path !== inputPath) {
    replaceUrl(docUrl(doc.path), startedAtUrl);
  }

  return createReactPageView(<DocPageComponent doc={doc} />, {
    className: 'doc-page doc-page-three-col',
    active: 'doc',
    title: `${doc.title || doc.path} · 私有知识库`,
    currentPath: doc.path,
  });
}
