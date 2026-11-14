/**
 * 持久目录侧边栏。
 *
 * 关键点（doc/web-nav-sidebar-acceptance.md B1-B7）：
 * - 桌面常驻（sticky、内部滚动），移动端由 CSS 隐藏、改走抽屉；
 * - `setCurrent()` 只做增量更新：高亮 / 展开祖先 / 必要时滚进可视区，**不重建树 DOM**；
 * - `refresh()`（保存笔记后）重建树但保留展开状态与滚动位置；
 * - 树加载失败只在侧边栏内显示可重试错误，不影响正文。
 */

import { humanizeError } from '../api/errors';
import { loadTree } from '../store';
import { el } from './dom';
import { openDrawerUi } from './drawer';
import type { SidebarHandle } from './view';
import { renderTree } from './tree';
import {
  ancestorsOf,
  buildTree,
  collectDirPaths,
  countDocs,
  mergeOpenPaths,
  type TreeNode,
} from './tree-model';
import '../styles/sidebar.css';

const MOBILE_QUERY = '(max-width: 860px)';

export function createSidebar(): SidebarHandle {
  let nodes: TreeNode[] = [];
  let openPaths = new Set<string>();
  let currentPath: string | undefined;
  let loading = false;
  let error: unknown = null;
  let initialized = false;
  let loadPromise: Promise<void> | null = null;

  const countEl = el('span', { class: 'muted', text: '' });
  const body = el('div', { class: 'sidebar-body' });
  const nav = el(
    'nav',
    { class: 'sidebar-nav', 'aria-label': '笔记目录' },
    el('div', { class: 'sidebar-head' }, el('span', { text: '目录' }), countEl),
    body,
  );
  const aside = el('aside', { class: 'sidebar', 'aria-label': '目录' }, nav);

  function hasTree(): boolean {
    return nodes.length > 0;
  }

  function initialOpenPaths(): Set<string> {
    // 桌面默认全展开（与旧首页一致）；移动端默认只展开当前文档祖先链，避免抽屉过长。
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
    countEl.textContent = `${countDocs(nodes)} 篇`;
    body.replaceChildren(
      renderTree(nodes, {
        currentPath,
        openPaths,
        onToggle: (path, open) => {
          if (open) openPaths.add(path);
          else openPaths.delete(path);
        },
      }),
    );
  }

  function skeleton(): HTMLElement {
    const box = el('div', { class: 'sidebar-skeleton', 'aria-hidden': 'true' });
    for (let i = 0; i < 5; i++) box.appendChild(el('span', { class: 'sidebar-skeleton-row' }));
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

  /** 打开/收起一个目录行：普通目录是 `<details>`，合并行是 button + 子列表。 */
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

  /** 目录项不在侧边栏可视区时才内部滚动（不滚动整页）。 */
  function ensureVisible(link: HTMLElement): void {
    if (aside.clientHeight === 0) return; // 移动端隐藏时不处理
    const linkRect = link.getBoundingClientRect();
    const boxRect = aside.getBoundingClientRect();
    const pad = 12;
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

    // 祖先目录逐级展开（增量，不重建 DOM）
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

    if (hasTree()) {
      drawerBody.appendChild(
        renderTree(nodes, {
          currentPath,
          openPaths: new Set(openPaths),
          onToggle: (path, open) => {
            if (open) openPaths.add(path);
            else openPaths.delete(path);
            applyOpenState();
          },
        }),
      );
    } else if (loading) {
      drawerBody.appendChild(el('p', { class: 'panel-hint', text: '目录加载中…' }));
    } else {
      drawerBody.appendChild(errorBox());
    }

    openDrawerUi({
      title: '目录',
      count: hasTree() ? `${countDocs(nodes)} 篇` : undefined,
      body: drawerBody,
      trigger,
    });
  }

  // 目录数据失效（保存/改名后）自动刷新，但保留展开状态与滚动位置。
  window.addEventListener('kb:tree-invalidated', () => {
    void refresh();
  });

  void load();

  return {
    element: aside,
    setCurrent: (path?: string) => setCurrent(path),
    refresh,
    openDrawer,
  };
}
