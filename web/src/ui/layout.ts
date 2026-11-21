/**
 * 持久应用外壳（shell）。
 *
 * 启动时挂载一次：顶栏 + 侧边栏 + 进度条 + 内容容器 `.page-content`。
 * 之后每次导航**只替换 `.page-content` 的子节点**——顶栏、侧边栏、搜索框状态
 * 都保持原样，因此不会再有「切换页面像整页刷新」的观感。
 *
 * 契约见 docs/web-nav-sidebar-acceptance.md §2；本文件同时负责：
 * 顶栏高亮 / 搜索框回填 / 标题 / 进度条 / 焦点 / 滚动（push 回顶、pop 恢复、深链锚点）/
 * 桌面端侧边栏折叠 / 深浅色切换 / ⌘K 命令面板入口。
 */

import { api, IS_MOCK } from '../api';
import { humanizeError } from '../api/errors';
import { clearLeaveGuardDirty, confirmLeave, hasDirtyGuard } from '../navGuard';
import { navigate, searchUrl } from '../router';
import { loadTree } from '../store';
import { openCommandPalette } from './commandPalette';
import { el, parentPath } from './dom';
import { openNewNoteDialog } from './newNote';
import { replaceEntryKeepScroll, restoreScroll, scrollToHash, scrollToTop } from './scroll';
import { errorState, loadingState, toast } from './shell';
import { getTheme, initTheme, subscribeTheme, toggleTheme, type Theme } from './theme';
import type { ActiveNav, NavInfo, PageView, SidebarHandle } from './view';

export interface LayoutMountOptions {
  sidebar: SidebarHandle;
}

const BRANDBAR_PROGRESS_DELAY_MS = 150;
const SIDEBAR_COLLAPSED_KEY = 'kb-sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

const ICON_PANEL_LEFT =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';
const ICON_MENU =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>';
const ICON_SEARCH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_PLUS =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
const ICON_SUN =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const ICON_MOON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

function iconSpan(svg: string, cls = 'btn-svg-icon'): HTMLElement {
  const span = el('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = svg;
  return span;
}

class Layout {
  private mounted = false;
  private sidebar: SidebarHandle | null = null;
  private shellEl: HTMLElement | null = null;
  private topbar: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private progress: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private treeBtn: HTMLButtonElement | null = null;
  private collapseBtn: HTMLButtonElement | null = null;
  private themeBtn: HTMLButtonElement | null = null;
  private navLinks = new Map<ActiveNav, HTMLAnchorElement>();
  private progressTimer: number | undefined;
  private busy = false;
  private prev: PageView | null = null;
  private lastActive: ActiveNav = 'home';
  private sidebarCollapsed = false;

  /** 启动时调用一次；重复调用无副作用。 */
  mount(options: LayoutMountOptions): void {
    if (this.mounted) return;
    const app = document.getElementById('app');
    if (!app) throw new Error('#app not found');

    initTheme();
    this.sidebarCollapsed = readSidebarCollapsed();
    this.sidebar = options.sidebar;
    this.progress = el('div', {
      class: 'nav-progress',
      'aria-hidden': 'true',
      'data-active': 'false',
    });

    const collapseBtn = el('button', {
      type: 'button',
      class: 'btn-icon nav-collapse-btn',
      title: '收起/展开侧边栏 (Ctrl/Cmd + \\)',
      'aria-label': '切换左侧目录栏',
      'aria-pressed': this.sidebarCollapsed ? 'true' : 'false',
      onclick: () => this.toggleSidebarCollapsed(),
    }) as HTMLButtonElement;
    collapseBtn.innerHTML = ICON_PANEL_LEFT;
    this.collapseBtn = collapseBtn;

    this.searchInput = el('input', {
      type: 'search',
      name: 'q',
      class: 'search-input',
      placeholder: '搜索笔记（至少 2 个字）',
      'aria-label': '搜索知识库',
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;

    const kbdBtn = el('button', {
      type: 'button',
      class: 'search-kbd-btn',
      title: '打开命令面板与快速跳转 (Ctrl/Cmd + K)',
      'aria-label': '打开快速跳转面板',
      text: '⌘K',
      onclick: () => openCommandPalette(this.searchInput?.value ?? ''),
    });

    const searchForm = el(
      'form',
      {
        class: 'search-form',
        role: 'search',
        onsubmit: (event: Event) => {
          event.preventDefault();
          const q = this.searchInput?.value.trim() ?? '';
          if (q) void navigate(searchUrl(q), { replace: true, force: true });
        },
      },
      el('div', { class: 'search-box' }, iconSpan(ICON_SEARCH, 'search-box-icon'), this.searchInput, kbdBtn),
      el('button', { type: 'submit', class: 'btn btn-search', text: '搜索' }),
    );

    const newBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary nav-new-btn',
        title: '写一篇新笔记',
        onclick: () => void this.startNewNote(),
      },
      iconSpan(ICON_PLUS),
      el('span', { text: '新建' }),
    );

    const exportBtn = el('button', {
      type: 'button',
      class: 'btn btn-ghost nav-export-btn',
      text: '导出',
      'data-action': 'export',
      title: '把全库笔记导出成 zip',
      onclick: () => void exportAll(exportBtn),
    });

    const themeBtn = el('button', {
      type: 'button',
      class: 'btn-icon nav-theme-btn',
      title: '切换深色/浅色主题',
      'aria-label': '切换深色或浅色主题',
      onclick: () => toggleTheme(),
    }) as HTMLButtonElement;
    this.themeBtn = themeBtn;
    this.syncThemeBtn(getTheme());
    subscribeTheme((t) => this.syncThemeBtn(t));

    const treeBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost nav-tree-btn',
        title: '打开目录',
        'aria-label': '打开目录',
        onclick: () => this.sidebar?.openDrawer(),
      },
      iconSpan(ICON_MENU),
      el('span', { text: '目录' }),
    ) as HTMLButtonElement;
    this.treeBtn = treeBtn;

    const navItems: Array<[ActiveNav, string, string]> = [
      ['home', '/', '首页'],
      ['reports', '/reports', '报告'],
    ];
    const nav = el('nav', { class: 'nav', 'aria-label': '主导航' }, treeBtn);
    for (const [key, href, label] of navItems) {
      const link = el('a', { href, class: 'nav-link', text: label }) as HTMLAnchorElement;
      this.navLinks.set(key, link);
      nav.appendChild(link);
    }
    nav.append(themeBtn, newBtn, exportBtn);

    this.topbar = el(
      'header',
      { class: 'topbar' },
      el(
        'div',
        { class: 'topbar-left' },
        collapseBtn,
        el(
          'a',
          { class: 'brand', href: '/', 'aria-label': '回到首页' },
          el('span', { class: 'brand-dot' }),
          el('span', { class: 'brand-text', text: '私有知识库' }),
        ),
        IS_MOCK ? el('span', { class: 'badge-mock', title: '本地 mock 数据（未接后端）', text: 'MOCK' }) : null,
      ),
      searchForm,
      nav,
    );

    this.content = el('div', {
      class: 'page-content',
      id: 'main-content',
      tabindex: '-1',
    });
    this.bodyEl = el(
      'div',
      {
        class: 'app-body',
        'data-sidebar': 'on',
        'data-sidebar-collapsed': this.sidebarCollapsed ? 'true' : 'false',
      },
      options.sidebar.element,
      this.content,
    );
    this.shellEl = el('div', { class: 'app-shell' }, this.progress, this.topbar, this.bodyEl);
    app.replaceChildren(this.shellEl);

    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        if (this.bodyEl?.dataset.sidebar === 'on') {
          event.preventDefault();
          this.toggleSidebarCollapsed();
        }
      }
    });

    this.mounted = true;
  }

  private syncThemeBtn(theme: Theme): void {
    if (!this.themeBtn) return;
    const isDark = theme === 'dark';
    this.themeBtn.innerHTML = isDark ? ICON_SUN : ICON_MOON;
    this.themeBtn.title = isDark ? '切换到浅色模式' : '切换到深色模式';
    this.themeBtn.setAttribute('aria-label', this.themeBtn.title);
  }

  toggleSidebarCollapsed(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    saveSidebarCollapsed(this.sidebarCollapsed);
    if (this.bodyEl) {
      this.bodyEl.dataset.sidebarCollapsed = this.sidebarCollapsed ? 'true' : 'false';
    }
    if (this.collapseBtn) {
      this.collapseBtn.setAttribute('aria-pressed', this.sidebarCollapsed ? 'true' : 'false');
    }
  }

  private async startNewNote(): Promise<void> {
    if (hasDirtyGuard()) {
      const leave = await confirmLeave();
      if (!leave) return;
      clearLeaveGuardDirty();
    }
    const dir = this.prev?.currentPath ? parentPath(this.prev.currentPath).replace(/\s*\/\s*/g, '/') : undefined;
    openNewNoteDialog(dir || undefined);
  }

  /** 首屏骨架：只在内容区显示，顶栏与侧边栏已经是持久的。 */
  showBoot(): void {
    if (!this.mounted || !this.content) return;
    document.title = '私有知识库';
    this.content.replaceChildren(loadingState('加载中…'));
  }

  /** 把页面内容换进内容区（唯一替换点）。 */
  show(view: PageView, nav: NavInfo): void {
    if (!this.mounted || !this.content || !this.bodyEl) return;

    const previous = this.prev;
    if (previous?.onTeardown) {
      try {
        previous.onTeardown();
      } catch {
        /* 页面清理失败不应阻塞新页面 */
      }
    }
    this.prev = view;
    this.lastActive = view.active;

    this.syncNav(view.active);
    if (view.searchQuery !== undefined && this.searchInput) {
      this.searchInput.value = view.searchQuery;
    }
    document.title = view.title;

    const showSidebar = view.showSidebar !== false;
    this.bodyEl.dataset.sidebar = showSidebar ? 'on' : 'off';
    this.shellEl?.classList.toggle('app-shell-wide', Boolean(view.wide));
    if (this.treeBtn) this.treeBtn.style.display = showSidebar ? '' : 'none';
    if (this.collapseBtn) this.collapseBtn.style.display = showSidebar ? '' : 'none';
    if (this.sidebar) {
      this.sidebar.element.toggleAttribute('hidden', !showSidebar);
      this.sidebar.setCurrent(showSidebar ? view.currentPath : undefined);
    }

    // 唯一的 DOM 替换点：顶栏/侧边栏/搜索框都不动
    this.content.replaceChildren(view.node);

    if (nav.kind !== 'initial') this.focusContent(view.node);
    this.applyScroll(nav);
    view.onMount?.();
  }

  /** 页面级错误也留在 shell 里（保留顶栏与侧边栏，可重试）。 */
  showError(title: string, detail?: string, retry?: () => void): void {
    this.show(
      {
        node: errorState(title, detail, retry),
        active: this.lastActive,
        title: `${title} · 私有知识库`,
        showSidebar: true,
        currentPath: this.prev?.currentPath,
      },
      { kind: 'retry', scrollY: null },
    );
  }

  /** 顶部进度条：忙碌立即置 aria-busy，视觉进度条延迟 150ms 出现（避免闪烁）。 */
  setBusy(busy: boolean): void {
    if (!this.mounted || !this.content) return;
    if (busy === this.busy) return;
    this.busy = busy;
    if (busy) {
      this.content.setAttribute('aria-busy', 'true');
      if (this.progressTimer !== undefined) window.clearTimeout(this.progressTimer);
      this.progressTimer = window.setTimeout(() => {
        this.progressTimer = undefined;
        if (this.busy && this.progress) this.progress.dataset.active = 'true';
      }, BRANDBAR_PROGRESS_DELAY_MS);
      return;
    }
    if (this.progressTimer !== undefined) {
      window.clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    this.content.removeAttribute('aria-busy');
    if (this.progress) this.progress.dataset.active = 'false';
  }

  setTitle(title: string): void {
    document.title = title;
  }

  syncSidebar(path?: string): void {
    this.sidebar?.setCurrent(path);
  }

  refreshSidebar(): Promise<void> {
    return this.sidebar ? this.sidebar.refresh() : Promise.resolve();
  }

  openDrawer(): void {
    this.sidebar?.openDrawer();
  }

  get contentElement(): HTMLElement | null {
    return this.content;
  }

  get topbarElement(): HTMLElement | null {
    return this.topbar;
  }

  get shellElement(): HTMLElement | null {
    return this.shellEl;
  }

  private syncNav(active: ActiveNav): void {
    for (const [key, link] of this.navLinks) {
      const isActive = key === active;
      link.classList.toggle('nav-link-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  private focusContent(node: HTMLElement): void {
    const heading = node.querySelector<HTMLElement>('h1, .doc-title, h2');
    const target = heading ?? node;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  private applyScroll(nav: NavInfo): void {
    switch (nav.kind) {
      case 'push':
      case 'initial': {
        if (!scrollToHash(location.hash)) scrollToTop();
        return;
      }
      case 'pop': {
        if (!scrollToHash(location.hash)) restoreScroll(nav.scrollY);
        return;
      }
      default:
        return;
    }
  }
}

function fileName(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `knowledge-export-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.zip`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function exportAll(button: HTMLButtonElement): Promise<void> {
  const original = button.textContent ?? '导出';
  button.disabled = true;
  button.textContent = '导出中…';
  try {
    const [blob, tree] = await Promise.all([api.exportZip(), loadTree().catch(() => [])]);
    downloadBlob(blob, fileName());
    const count = tree.length ? ` ${tree.length} 篇 ·` : '';
    toast(
      IS_MOCK
        ? '已下载（mock 占位文件，不是真 zip）'
        : `已导出${count}${formatSize(blob.size)}，在浏览器的「下载」里查看`,
    );
  } catch (err) {
    toast(`导出失败：${humanizeError(err)}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

export const layout = new Layout();
export { replaceEntryKeepScroll };
