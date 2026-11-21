/**
 * 持久目录侧边栏。
 *
 * 关键点（docs/web-nav-sidebar-acceptance.md B1-B8）：
 * - 桌面常驻（sticky、内部滚动），移动端由 CSS 隐藏、改走抽屉；
 * - `setCurrent()` 只做增量更新：高亮 / 展开祖先 / 必要时滚进可视区，**不重建树 DOM**；
 * - `refresh()`（保存笔记后）重建树但保留展开状态与滚动位置；
 * - 支持目录内实时筛选与全部展开/收起，筛选清空后无损恢复原有展开态；
 * - 树加载失败只在侧边栏内显示可重试错误，不影响正文。
 */

import { humanizeError } from '../api/errors';
import { loadTree } from '../store';
import { el, parentPath } from './dom';
import { closeDrawer, openDrawerUi, type DrawerController } from './drawer';
import { openNewNoteDialog } from './newNote';
import type { SidebarHandle } from './view';
import { renderTree } from './tree';
import {
  ancestorsOf,
  buildTree,
  collectDirPaths,
  countDocs,
  filterTree,
  mergeOpenPaths,
  type TreeNode,
} from './tree-model';
import '../styles/sidebar.css';

const MOBILE_QUERY = '(max-width: 860px)';

const ICON_COLLAPSE_ALL =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></svg>';
const ICON_EXPAND_ALL =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>';
const ICON_HOME =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_REPORTS =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>';
const ICON_DOWNLOAD =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
const ICON_PLUS =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

function iconEl(svg: string): HTMLElement {
  const span = el('span', { class: 'btn-svg-icon', 'aria-hidden': 'true' });
  span.innerHTML = svg;
  return span;
}

function syncExpandButton(button: HTMLButtonElement, allOpen: boolean): void {
  button.dataset.allOpen = allOpen ? 'true' : 'false';
  button.title = allOpen ? '全部收起目录' : '全部展开目录';
  button.setAttribute('aria-label', button.title);
  button.innerHTML = allOpen ? ICON_COLLAPSE_ALL : ICON_EXPAND_ALL;
}

export function createSidebar(): SidebarHandle {
  let nodes: TreeNode[] = [];
  let openPaths = new Set<string>();
  let currentPath: string | undefined;
  let filterText = '';
  let loading = false;
  let error: unknown = null;
  let initialized = false;
  let loadPromise: Promise<void> | null = null;

  const countEl = el('span', { class: 'sidebar-count muted', text: '' });

  const expandAllBtn = el('button', {
    type: 'button',
    class: 'sidebar-expand-btn',
    title: '全部收起 / 全部展开',
    'aria-label': '切换全部展开或收起',
    onclick: () => toggleAllDirs(),
  }) as HTMLButtonElement;

  const filterInput = el('input', {
    type: 'search',
    class: 'sidebar-filter-input',
    placeholder: '筛选目录笔记…',
    'aria-label': '筛选目录笔记',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;

  const clearFilterBtn = el('button', {
    type: 'button',
    class: 'sidebar-filter-clear',
    title: '清除筛选',
    'aria-label': '清除筛选',
    hidden: 'true',
    text: '×',
    onclick: () => {
      filterInput.value = '';
      setFilter('');
      filterInput.focus();
    },
  }) as HTMLButtonElement;

  filterInput.addEventListener('input', () => {
    setFilter(filterInput.value);
  });

  const tools = el(
    'div',
    { class: 'sidebar-tools' },
    el(
      'div',
      { class: 'sidebar-filter-wrap' },
      filterInput,
      clearFilterBtn,
    ),
  );

  const body = el('div', { class: 'sidebar-body' });
  const nav = el(
    'nav',
    { class: 'sidebar-nav', 'aria-label': '笔记目录' },
    el(
      'div',
      { class: 'sidebar-head' },
      el('span', { class: 'sidebar-head-title', text: '目录' }),
      el('div', { class: 'sidebar-head-actions' }, countEl, expandAllBtn),
    ),
    tools,
    body,
  );
  const aside = el('aside', { class: 'sidebar', 'aria-label': '目录' }, nav);

  function hasTree(): boolean {
    return nodes.length > 0;
  }

  function areAllDirsOpen(): boolean {
    const allDirs = collectDirPaths(nodes);
    return allDirs.size > 0 && [...allDirs].every((p) => openPaths.has(p));
  }

  function updateExpandAllButton(): void {
    syncExpandButton(expandAllBtn, areAllDirsOpen());
  }

  function toggleAllDirs(): void {
    if (!hasTree()) return;
    const allDirs = collectDirPaths(nodes);
    const allOpen = allDirs.size > 0 && [...allDirs].every((p) => openPaths.has(p));
    if (allOpen) {
      openPaths = new Set(ancestorsOf(currentPath));
    } else {
      openPaths = new Set(allDirs);
    }
    applyOpenState();
    updateExpandAllButton();
  }

  function setFilter(next: string): void {
    filterText = next;
    clearFilterBtn.hidden = next.trim().length === 0;
    renderBody();
  }

  function initialOpenPaths(): Set<string> {
    const mobile = typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches;
    const base = mobile ? new Set<string>() : collectDirPaths(nodes);
    for (const path of ancestorsOf(currentPath)) base.add(path);
    return base;
  }

  function renderBody(): void {
    if (!hasTree()) {
      body.replaceChildren(loading ? skeleton() : errorBox());
      return;
    }

    const trimmed = filterText.trim();
    const isFiltering = trimmed.length > 0;
    const displayNodes = isFiltering ? filterTree(nodes, trimmed) : nodes;
    const totalCount = countDocs(nodes);

    if (isFiltering) {
      const matchedCount = countDocs(displayNodes);
      countEl.textContent = `${matchedCount} / ${totalCount} 篇`;
    } else {
      countEl.textContent = `${totalCount} 篇`;
    }
    updateExpandAllButton();

    if (isFiltering && displayNodes.length === 0) {
      body.replaceChildren(
        el(
          'div',
          { class: 'sidebar-empty' },
          el('p', { class: 'muted', text: `没有找到匹配「${trimmed}」的笔记` }),
        ),
      );
      return;
    }

    const activeOpenPaths = isFiltering ? collectDirPaths(displayNodes) : openPaths;
    body.replaceChildren(
      renderTree(displayNodes, {
        currentPath,
        openPaths: activeOpenPaths,
        onToggle: (path, open) => {
          if (isFiltering) return;
          if (open) openPaths.add(path);
          else openPaths.delete(path);
          updateExpandAllButton();
        },
      }),
    );
    if (error) body.prepend(staleErrorBar());
  }

  function staleErrorBar(): HTMLElement {
    return el(
      'div',
      { class: 'sidebar-error sidebar-error-thin', role: 'status' },
      el('span', { class: 'sidebar-error-text', text: '目录可能不是最新的' }),
      el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-small',
        text: '重试',
        onclick: () => void load({ force: true }),
      }),
    );
  }

  function skeleton(): HTMLElement {
    const box = el('div', { class: 'sidebar-skeleton', 'aria-hidden': 'true' });
    for (let i = 0; i < 6; i++) box.appendChild(el('span', { class: 'sidebar-skeleton-row' }));
    return box;
  }

  function errorBox(): HTMLElement {
    return el(
      'div',
      { class: 'sidebar-error', role: 'status' },
      el('p', {
        class: 'sidebar-error-text',
        text: `目录加载失败：${error ? humanizeError(error) : '未知错误'}`,
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-small',
        text: '重试',
        onclick: () => void load({ force: true }),
      }),
    );
  }

  function findDirElement(path: string): Element | null {
    for (const item of aside.querySelectorAll<HTMLElement>('[data-dir-path]')) {
      if (item.dataset.dirPath === path) return item;
    }
    return null;
  }

  function setDirOpen(path: string, open: boolean): void {
    const host = findDirElement(path);
    if (!host) return;
    if (host instanceof HTMLDetailsElement) {
      if (host.open !== open) host.open = open;
      return;
    }
    const button = host.querySelector<HTMLButtonElement>('.tree-dir-toggle');
    if (!button) return;
    const isOpen = button.getAttribute('aria-expanded') === 'true';
    if (isOpen !== open) button.click();
  }

  function findDocLink(path: string): HTMLAnchorElement | null {
    for (const link of aside.querySelectorAll<HTMLAnchorElement>('a.tree-doc')) {
      if (link.dataset.docPath === path) return link;
    }
    return null;
  }

  function ensureVisible(link: HTMLElement): void {
    if (aside.clientHeight === 0) return;
    const linkRect = link.getBoundingClientRect();
    const boxRect = aside.getBoundingClientRect();
    const pad = 16;
    if (linkRect.top < boxRect.top + pad) {
      aside.scrollTop -= boxRect.top + pad - linkRect.top;
    } else if (linkRect.bottom > boxRect.bottom - pad) {
      aside.scrollTop += linkRect.bottom - (boxRect.bottom - pad);
    }
  }

  function setCurrent(path?: string, opts: { ensureVisible?: boolean } = {}): void {
    const nextPath = path ? path.replace(/\/+$/, '') : undefined;
    currentPath = nextPath;
    if (!hasTree()) return;

    const previous = aside.querySelector<HTMLAnchorElement>('.tree-doc-active');
    if (previous && previous.dataset.docPath !== nextPath) {
      previous.classList.remove('tree-doc-active');
      previous.removeAttribute('aria-current');
    }
    if (!nextPath) return;

    for (const dirPath of ancestorsOf(nextPath)) {
      openPaths.add(dirPath);
      setDirOpen(dirPath, true);
    }

    const link = findDocLink(nextPath);
    if (!link) return;
    link.classList.add('tree-doc-active');
    link.setAttribute('aria-current', 'page');
    if (opts.ensureVisible !== false) ensureVisible(link);
  }

  function applyOpenState(): void {
    for (const details of aside.querySelectorAll<HTMLDetailsElement>('details.tree-dir')) {
      const path = details.dataset.dirPath;
      if (!path) continue;
      const open = openPaths.has(path);
      if (details.open !== open) details.open = open;
    }
    for (const row of aside.querySelectorAll<HTMLElement>('.tree-dir-row[data-dir-path]')) {
      const path = row.dataset.dirPath;
      if (!path) continue;
      setDirOpen(path, openPaths.has(path));
    }
  }

  async function load(opts: { force?: boolean; preserveOpen?: Set<string> } = {}): Promise<void> {
    if (loadPromise && !opts.force) return loadPromise;
    loading = true;
    error = null;
    if (!hasTree()) renderBody();
    const started = (async () => {
      try {
        const entries = await loadTree(Boolean(opts.force));
        nodes = buildTree(entries);
        if (!initialized) {
          openPaths = initialOpenPaths();
          initialized = true;
        } else {
          openPaths = mergeOpenPaths(opts.preserveOpen ?? openPaths, nodes, currentPath);
        }
        renderBody();
        if (currentPath) setCurrent(currentPath);
      } catch (err) {
        error = err;
        renderBody();
      } finally {
        loading = false;
        renderBody();
      }
    })();
    loadPromise = started;
    try {
      await started;
    } finally {
      if (loadPromise === started) loadPromise = null;
    }
  }

  async function refresh(): Promise<void> {
    const scrollTop = aside.scrollTop;
    const previous = new Set(openPaths);
    await load({ force: true, preserveOpen: previous });
    aside.scrollTop = scrollTop;
  }

  function openDrawer(): void {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawerBody = el('div', { class: 'drawer-tree' });
    let controller: DrawerController | null = null;
    let drawerExpandBtn: HTMLButtonElement | null = null;

    if (hasTree()) {
      const totalCount = countDocs(nodes);
      const drawerFilter = el('input', {
        type: 'search',
        class: 'sidebar-filter-input',
        placeholder: '筛选目录笔记…',
        'aria-label': '筛选目录笔记',
        autocomplete: 'off',
        spellcheck: 'false',
      }) as HTMLInputElement;
      const drawerClearBtn = el('button', {
        type: 'button',
        class: 'sidebar-filter-clear',
        title: '清除筛选',
        'aria-label': '清除筛选',
        hidden: 'true',
        text: '×',
      }) as HTMLButtonElement;
      const drawerTreeBox = el('div', { class: 'drawer-tree-list' });

      const syncDrawerExpand = (): void => {
        if (drawerExpandBtn) syncExpandButton(drawerExpandBtn, areAllDirsOpen());
      };

      const renderDrawerTree = (q: string): void => {
        const trimmed = q.trim();
        const isFiltering = trimmed.length > 0;
        drawerClearBtn.hidden = !isFiltering;
        const filtered = isFiltering ? filterTree(nodes, trimmed) : nodes;
        if (controller) {
          controller.setCount(isFiltering ? `${countDocs(filtered)} / ${totalCount} 篇` : `${totalCount} 篇`);
        }
        if (isFiltering && filtered.length === 0) {
          drawerTreeBox.replaceChildren(
            el('div', { class: 'sidebar-empty' }, el('p', { class: 'muted', text: `没有找到匹配「${trimmed}」的笔记` })),
          );
          return;
        }
        drawerTreeBox.replaceChildren(
          renderTree(filtered, {
            currentPath,
            openPaths: isFiltering ? collectDirPaths(filtered) : new Set(openPaths),
            onToggle: (path, open) => {
              if (isFiltering) return;
              if (open) openPaths.add(path);
              else openPaths.delete(path);
              applyOpenState();
              updateExpandAllButton();
              syncDrawerExpand();
            },
            onCreateInDir: (dirPath) => {
              closeDrawer();
              openNewNoteDialog(dirPath);
            },
          }),
        );
      };

      drawerClearBtn.addEventListener('click', () => {
        drawerFilter.value = '';
        renderDrawerTree('');
        drawerFilter.focus();
      });
      drawerFilter.addEventListener('input', () => renderDrawerTree(drawerFilter.value));

      drawerExpandBtn = el('button', {
        type: 'button',
        class: 'sidebar-expand-btn tree-drawer-expand',
        title: '全部收起 / 全部展开',
        'aria-label': '切换全部展开或收起',
        onclick: () => {
          toggleAllDirs();
          renderDrawerTree(drawerFilter.value);
          syncDrawerExpand();
        },
      }) as HTMLButtonElement;
      syncDrawerExpand();

      renderDrawerTree('');
      drawerBody.append(
        el(
          'div',
          { class: 'sidebar-tools drawer-tools' },
          el('div', { class: 'sidebar-filter-wrap' }, drawerFilter, drawerClearBtn),
        ),
        drawerTreeBox,
      );
    } else if (loading) {
      drawerBody.appendChild(el('p', { class: 'panel-hint', text: '目录加载中…' }));
    } else {
      drawerBody.appendChild(errorBox());
    }

    const currentDir = currentPath ? parentPath(currentPath).replace(/\s*\/\s*/g, '/') : '';
    const footer = el(
      'div',
      { class: 'tree-drawer-foot' },
      el(
        'div',
        { class: 'tree-drawer-links' },
        el('a', { href: '/', class: 'tree-drawer-action' }, iconEl(ICON_HOME), el('span', { text: '首页' })),
        el('a', { href: '/reports', class: 'tree-drawer-action' }, iconEl(ICON_REPORTS), el('span', { text: '报告' })),
        el(
          'button',
          {
            type: 'button',
            class: 'tree-drawer-action',
            onclick: () => {
              closeDrawer();
              document.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();
            },
          },
          iconEl(ICON_DOWNLOAD),
          el('span', { text: '导出' }),
        ),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'tree-drawer-action tree-drawer-action-primary',
          onclick: () => {
            closeDrawer();
            openNewNoteDialog(currentDir || undefined);
          },
        },
        iconEl(ICON_PLUS),
        el('span', { text: '新建笔记' }),
      ),
    );

    controller = openDrawerUi({
      title: '目录',
      count: hasTree() ? `${countDocs(nodes)} 篇` : undefined,
      headerActions: drawerExpandBtn,
      body: drawerBody,
      footer,
      trigger,
    });
  }

  const onTreeInvalidated = (): void => {
    void refresh();
  };
  window.addEventListener('kb:tree-invalidated', onTreeInvalidated);

  void load();

  return {
    element: aside,
    setCurrent: (path?: string) => setCurrent(path),
    refresh,
    openDrawer,
    destroy: () => {
      window.removeEventListener('kb:tree-invalidated', onTreeInvalidated);
      closeDrawer();
    },
  };
}
