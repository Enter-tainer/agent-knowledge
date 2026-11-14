/**
 * 持久应用外壳（shell）。
 *
 * 启动时挂载一次：顶栏 + 侧边栏 + 进度条 + 内容容器 `.page-content`。
 * 之后每次导航**只替换 `.page-content` 的子节点**——顶栏、侧边栏、搜索框状态
 * 都保持原样，因此不会再有「切换页面像整页刷新」的观感。
 *
 * 契约见 docs/web-nav-sidebar-acceptance.md §2；本文件同时负责：
 * 顶栏高亮 / 搜索框回填 / 标题 / 进度条 / 焦点 / 滚动（push 回顶、pop 恢复、深链锚点）。
 */

import { api, IS_MOCK } from '../api';
import { humanizeError } from '../api/errors';
import { clearLeaveGuardDirty, confirmLeave, hasDirtyGuard } from '../navGuard';
import { navigate, searchUrl } from '../router';
import { loadTree } from '../store';
import { el } from './dom';
import { openNewNoteDialog } from './newNote';
import { errorState, loadingState, toast } from './shell';
import { replaceEntryKeepScroll, restoreScroll, scrollToHash, scrollToTop } from './scroll';
import type { ActiveNav, NavInfo, PageView, SidebarHandle } from './view';

export interface LayoutMountOptions {
  sidebar: SidebarHandle;
}

const BRANDBAR_PROGRESS_DELAY_MS = 150;

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
  private navLinks = new Map<ActiveNav, HTMLAnchorElement>();
  private progressTimer: number | undefined;
  private busy = false;
  private prev: PageView | null = null;
  private lastActive: ActiveNav = 'home';

  /** 启动时调用一次；重复调用无副作用。 */
  mount(options: LayoutMountOptions): void {
    if (this.mounted) return;
    const app = document.getElementById('app');
    if (!app) throw new Error('#app not found');

    this.sidebar = options.sidebar;
    this.progress = el('div', {
      class: 'nav-progress',
      'aria-hidden': 'true',
      'data-active': 'false',
    });

    this.searchInput = el('input', {
      type: 'search',
      name: 'q',
      class: 'search-input',
      placeholder: '搜索笔记（至少 2 个字）',
      'aria-label': '搜索知识库',
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;

    const searchForm = el(
      'form',
      {
        class: 'search-form',
        role: 'search',
        onsubmit: (event: Event) => {
          event.preventDefault();
          const q = this.searchInput?.value.trim() ?? '';
          // force：用同一个词再按一次「搜索」应该重新搜（结果页刷新 / 错误态重试），
          // 不能因为 URL 没变就什么都不做。replace 保证不堆历史条目。
          if (q) void navigate(searchUrl(q), { replace: true, force: true });
        },
      },
      this.searchInput,
      el('button', { type: 'submit', class: 'btn btn-search', text: '搜索' }),
    );

    const newBtn = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '＋ 新建',
      title: '写一篇新笔记',
      onclick: () => void startNewNote(),
    });

    const exportBtn = el('button', {
      type: 'button',
      class: 'btn btn-ghost',
      text: '导出',
      title: '把全库笔记导出成 zip',
      onclick: () => void exportAll(exportBtn),
    });

    const treeBtn = el('button', {
      type: 'button',
      class: 'btn btn-ghost nav-tree-btn',
      text: '☰ 目录',
      title: '打开目录',
      'aria-label': '打开目录',
      onclick: () => this.sidebar?.openDrawer(),
    }) as HTMLButtonElement;
    this.treeBtn = treeBtn;

    const navItems: Array<[ActiveNav, string, string]> = [
      ['home', '/', '目录'],
      ['reports', '/reports', '报告'],
    ];
    const nav = el('nav', { class: 'nav', 'aria-label': '主导航' }, treeBtn);
    for (const [key, href, label] of navItems) {
      const link = el('a', { href, class: 'nav-link', text: label }) as HTMLAnchorElement;
      this.navLinks.set(key, link);
      nav.appendChild(link);
    }
    nav.append(newBtn, exportBtn);

    this.topbar = el(
      'header',
      { class: 'topbar' },
      el(
        'a',
        { class: 'brand', href: '/', 'aria-label': '回到首页' },
        el('span', { class: 'brand-dot' }),
        el('span', { class: 'brand-text', text: '私有知识库' }),
      ),
      IS_MOCK ? el('span', { class: 'badge-mock', title: '本地 mock 数据（未接后端）', text: 'MOCK' }) : null,
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
      { class: 'app-body', 'data-sidebar': 'on' },
      options.sidebar.element,
      this.content,
    );
    this.shellEl = el('div', { class: 'app-shell' }, this.progress, this.topbar, this.bodyEl);
    app.replaceChildren(this.shellEl);
    this.mounted = true;
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
    // 编辑页窄屏也不给抽屉入口（sidebar 关闭时按钮一并隐藏，避免"点了没东西"）
    if (this.treeBtn) this.treeBtn.style.display = showSidebar ? '' : 'none';
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

  /** 页面内部状态变化时更新标题（如新建保存成功后「新建：…」→「编辑：…」）。 */
  setTitle(title: string): void {
    document.title = title;
  }

  /** 只同步侧边栏高亮（页面内部切换文档时可用）。 */
  syncSidebar(path?: string): void {
    this.sidebar?.setCurrent(path);
  }

  /** 目录失效后重建侧边栏（保留展开状态与滚动位置）。 */
  refreshSidebar(): Promise<void> {
    return this.sidebar ? this.sidebar.refresh() : Promise.resolve();
  }

  /** 移动端目录抽屉。 */
  openDrawer(): void {
    this.sidebar?.openDrawer();
  }

  /** 测试用：当前内容容器。 */
  get contentElement(): HTMLElement | null {
    return this.content;
  }

  /** 测试用：顶栏节点（验证导航时 DOM 身份不变）。 */
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
        // retry：保持用户当前位置，不要跳回顶部
        return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 顶栏动作                                                            */
/* ------------------------------------------------------------------ */

async function startNewNote(): Promise<void> {
  // 编辑页有未保存改动时，先问「保存 / 放弃 / 取消」，用户确认后再开新建路径弹层
  if (hasDirtyGuard()) {
    const leave = await confirmLeave();
    if (!leave) return;
    clearLeaveGuardDirty();
  }
  openNewNoteDialog();
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

/** 单例：整个应用只有一个 shell。 */
export const layout = new Layout();

// `replaceEntryKeepScroll` 供短名纠正等场景复用（此处 re-export 方便 pages 引用）。
export { replaceEntryKeepScroll };
