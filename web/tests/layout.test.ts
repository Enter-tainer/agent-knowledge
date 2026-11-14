/**
 * 持久布局契约（docs/web-nav-sidebar-acceptance.md §2 布局 API、§4 A2/A4/A6/B1/B4/B6/C5）：
 *
 *  - mount 幂等：整场会话只有一个 .app-shell
 *  - 导航只替换 .page-content 的子节点，shell/topbar/sidebar/内容容器引用不变
 *  - aria-busy 立即生效；进度条 .nav-progress 延迟 150ms 才 data-active=true
 *  - title / searchQuery 回填 / 顶栏高亮 / wide / showSidebar=false
 *  - showError 留在 shell 内且可重试
 *  - onMount / onTeardown 调用顺序
 *  - push 回顶 / pop 恢复 scrollY / #hash 深链
 *
 * 侧边栏用 fake SidebarHandle 注入：本文件不依赖真实目录树与网络。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { layout } from '../src/ui/layout';
import type { PageView, SidebarHandle } from '../src/ui/view';
import { scrollIntoView, scrollTo, setScrollY } from './helpers/env';

interface FakeSidebar extends SidebarHandle {
  setCurrentSpy: ReturnType<typeof vi.fn>;
  refreshSpy: ReturnType<typeof vi.fn>;
  openDrawerSpy: ReturnType<typeof vi.fn>;
}

function createFakeSidebar(): FakeSidebar {
  const element = document.createElement('aside');
  element.className = 'sidebar';
  const setCurrentSpy = vi.fn();
  const refreshSpy = vi.fn(async () => undefined);
  const openDrawerSpy = vi.fn();
  return {
    element,
    setCurrent: setCurrentSpy as unknown as SidebarHandle['setCurrent'],
    refresh: refreshSpy as unknown as SidebarHandle['refresh'],
    openDrawer: openDrawerSpy as unknown as SidebarHandle['openDrawer'],
    setCurrentSpy,
    refreshSpy,
    openDrawerSpy,
  };
}

function createView(overrides: Partial<PageView> = {}): PageView {
  const node = overrides.node ?? document.createElement('main');
  node.classList.add('main-column');
  const heading = document.createElement('h1');
  heading.className = 'doc-title';
  heading.textContent = overrides.title ?? '内容标题';
  node.appendChild(heading);
  return {
    node,
    active: 'home',
    title: '测试页 · 私有知识库',
    ...overrides,
  };
}

let sidebar: FakeSidebar;

function shell(): HTMLElement {
  return layout.shellElement as HTMLElement;
}
function topbar(): HTMLElement {
  return layout.topbarElement as HTMLElement;
}
function content(): HTMLElement {
  return layout.contentElement as HTMLElement;
}
function searchInput(): HTMLInputElement {
  return shell().querySelector('.search-input') as HTMLInputElement;
}
function progressBar(): HTMLElement {
  return shell().querySelector('.nav-progress') as HTMLElement;
}
function navLink(href: string): HTMLAnchorElement {
  return shell().querySelector(`.nav a[href="${href}"]`) as HTMLAnchorElement;
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  sidebar = createFakeSidebar();
  layout.mount({ sidebar });
});

beforeEach(() => {
  vi.clearAllMocks();
  setScrollY(0);
  history.replaceState(null, '', '/');
  (document.activeElement as HTMLElement | null)?.blur?.();
  layout.setBusy(false);
  layout.show(createView({ title: '基线页' }), { kind: 'retry', scrollY: null });
  vi.clearAllMocks();
});

describe('mount：整场会话只挂载一次', () => {
  it('重复 mount 不重建 shell，只存在一个 .app-shell', () => {
    const shellBefore = shell();
    const topbarBefore = topbar();
    const contentBefore = content();

    layout.mount({ sidebar });
    layout.mount({ sidebar });

    expect(layout.shellElement).toBe(shellBefore);
    expect(layout.topbarElement).toBe(topbarBefore);
    expect(layout.contentElement).toBe(contentBefore);
    expect(document.querySelectorAll('.app-shell')).toHaveLength(1);
    expect(document.querySelectorAll('#app > .app-shell')).toHaveLength(1);
  });

  it('shell 结构：进度条 + topbar + app-body(aside.sidebar + .page-content)', () => {
    expect(shell().querySelector('.nav-progress')).not.toBeNull();
    expect(shell().querySelector('.topbar')).toBe(topbar());
    expect(shell().querySelector('aside.sidebar')).toBe(sidebar.element);
    expect(shell().querySelector('.app-body')).not.toBeNull();
    expect(content().id).toBe('main-content');
    expect(content().getAttribute('tabindex')).toBe('-1');
    expect(shell().querySelector('.app-body')?.getAttribute('data-sidebar')).toBe('on');
  });

  it('顶栏包含品牌、搜索框、导航与「目录」按钮', () => {
    expect(topbar().querySelector('.brand')).not.toBeNull();
    expect(searchInput()).not.toBeNull();
    expect(navLink('/')).not.toBeNull();
    expect(navLink('/reports')).not.toBeNull();
    expect(topbar().querySelector('.nav-tree-btn')).not.toBeNull();
  });
});

describe('内容替换：只换 .page-content 的子节点', () => {
  it('导航后 shell / topbar / sidebar / 内容容器引用不变，旧内容被替换', () => {
    const shellBefore = shell();
    const topbarBefore = topbar();
    const contentBefore = content();

    const first = createView({ title: '第一篇' });
    layout.show(first, { kind: 'push', scrollY: null });
    expect(content().contains(first.node)).toBe(true);
    expect(content().children).toHaveLength(1);

    const second = createView({ title: '第二篇' });
    layout.show(second, { kind: 'push', scrollY: null });

    expect(layout.shellElement).toBe(shellBefore);
    expect(layout.topbarElement).toBe(topbarBefore);
    expect(layout.contentElement).toBe(contentBefore);
    expect(content().contains(second.node)).toBe(true);
    expect(content().contains(first.node)).toBe(false);
    expect(content().children).toHaveLength(1);
    expect(shell().querySelector('aside.sidebar')).toBe(sidebar.element);
  });

  it('内容容器内不允许出现第二个并列页面节点', () => {
    layout.show(createView(), { kind: 'push', scrollY: null });
    layout.show(createView(), { kind: 'push', scrollY: null });
    layout.show(createView(), { kind: 'push', scrollY: null });
    expect(content().children).toHaveLength(1);
  });
});

describe('title / 搜索框 / 顶栏高亮', () => {
  it('title 随 PageView 更新', () => {
    layout.show(createView({ title: '文章 A · 私有知识库' }), { kind: 'push', scrollY: null });
    expect(document.title).toBe('文章 A · 私有知识库');
    layout.show(createView({ title: '报告 · 私有知识库' }), { kind: 'push', scrollY: null });
    expect(document.title).toBe('报告 · 私有知识库');
  });

  it('searchQuery 回填，未提供时保留用户已输入的值', () => {
    layout.show(createView({ searchQuery: '压感' }), { kind: 'push', scrollY: null });
    expect(searchInput().value).toBe('压感');

    layout.show(createView(), { kind: 'push', scrollY: null });
    expect(searchInput().value).toBe('压感');
  });

  it('顶栏导航高亮唯一且带 aria-current=page', () => {
    layout.show(createView({ active: 'reports' }), { kind: 'push', scrollY: null });
    expect(navLink('/reports').classList.contains('nav-link-active')).toBe(true);
    expect(navLink('/reports').getAttribute('aria-current')).toBe('page');
    expect(navLink('/').classList.contains('nav-link-active')).toBe(false);
    expect(navLink('/').hasAttribute('aria-current')).toBe(false);

    layout.show(createView({ active: 'home' }), { kind: 'push', scrollY: null });
    expect(navLink('/').classList.contains('nav-link-active')).toBe(true);
    expect(navLink('/').getAttribute('aria-current')).toBe('page');
    expect(navLink('/reports').classList.contains('nav-link-active')).toBe(false);
  });
});

describe('侧边栏显隐与宽版', () => {
  it('默认显示侧边栏并同步 currentPath', () => {
    layout.show(createView({ currentPath: '示例库/文档' }), { kind: 'push', scrollY: null });
    expect(sidebar.element.hasAttribute('hidden')).toBe(false);
    expect(shell().querySelector('.app-body')?.getAttribute('data-sidebar')).toBe('on');
    expect(sidebar.setCurrentSpy).toHaveBeenLastCalledWith('示例库/文档');
  });

  it('showSidebar=false（编辑页）：隐藏侧边栏、body sidebar=off、清除高亮', () => {
    layout.show(createView({ showSidebar: false, wide: true }), { kind: 'push', scrollY: null });
    expect(sidebar.element.hasAttribute('hidden')).toBe(true);
    expect(shell().querySelector('.app-body')?.getAttribute('data-sidebar')).toBe('off');
    expect(sidebar.setCurrentSpy).toHaveBeenLastCalledWith(undefined);
    expect(shell().classList.contains('app-shell-wide')).toBe(true);
  });

  it('wide 只在宽版页面生效，切回普通页面后移除', () => {
    layout.show(createView({ wide: true }), { kind: 'push', scrollY: null });
    expect(shell().classList.contains('app-shell-wide')).toBe(true);
    layout.show(createView(), { kind: 'push', scrollY: null });
    expect(shell().classList.contains('app-shell-wide')).toBe(false);
  });
});

describe('aria-busy 与 150ms 进度条', () => {
  it('忙碌立即 aria-busy=true；进度条 149ms 不出现、150ms 出现；完成后都撤销', () => {
    vi.useFakeTimers();
    try {
      layout.setBusy(true);
      expect(content().getAttribute('aria-busy')).toBe('true');
      expect(progressBar().dataset.active).toBe('false');

      vi.advanceTimersByTime(149);
      expect(progressBar().dataset.active).toBe('false');

      vi.advanceTimersByTime(1);
      expect(progressBar().dataset.active).toBe('true');

      layout.setBusy(false);
      expect(content().hasAttribute('aria-busy')).toBe(false);
      expect(progressBar().dataset.active).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('重复 setBusy(true) 不重复触发，重复 setBusy(false) 幂等', () => {
    vi.useFakeTimers();
    try {
      layout.setBusy(true);
      layout.setBusy(true);
      vi.advanceTimersByTime(150);
      expect(progressBar().dataset.active).toBe('true');
      layout.setBusy(false);
      layout.setBusy(false);
      expect(content().hasAttribute('aria-busy')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('showBoot 只改内容区：顶栏/侧边栏不动，标题回到「私有知识库」', () => {
    const topbarBefore = topbar();
    layout.showBoot();
    expect(topbar()).toBe(topbarBefore);
    expect(shell().querySelector('aside.sidebar')).toBe(sidebar.element);
    expect(document.title).toBe('私有知识库');
    expect(content().querySelector('.state-loading')).not.toBeNull();
  });
});

describe('showError：错误态留在 shell 内', () => {
  it('保留 topbar 与侧边栏，内容区显示错误并可重试', () => {
    const retry = vi.fn();
    layout.showError('页面加载失败', '网络错误', retry);

    expect(layout.shellElement?.isConnected).toBe(true);
    expect(topbar().isConnected).toBe(true);
    expect(sidebar.element.isConnected).toBe(true);
    expect(content().querySelector('.state-error')).not.toBeNull();
    expect(content().textContent).toContain('页面加载失败');
    expect(document.title).toContain('页面加载失败');

    (content().querySelector('.state-error .btn') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('onMount / onTeardown 调用顺序', () => {
  it('先 teardown 旧页面，再挂新页面', () => {
    const order: string[] = [];
    const first = createView({
      onMount: () => order.push('mount:first'),
      onTeardown: () => order.push('teardown:first'),
    });
    layout.show(first, { kind: 'push', scrollY: null });
    expect(order).toEqual(['mount:first']);

    const second = createView({ onMount: () => order.push('mount:second') });
    layout.show(second, { kind: 'push', scrollY: null });
    expect(order).toEqual(['mount:first', 'teardown:first', 'mount:second']);
  });

  it('onTeardown 抛错不阻塞新页面挂载', () => {
    const mounted: string[] = [];
    layout.show(createView({ onTeardown: () => { throw new Error('teardown boom'); } }), { kind: 'push', scrollY: null });
    layout.show(createView({ onMount: () => mounted.push('second') }), { kind: 'push', scrollY: null });
    expect(mounted).toEqual(['second']);
  });
});

describe('滚动：push 回顶 / pop 恢复 / retry 原地 / #hash', () => {
  it('push 滚到顶部，pop 恢复记录位置，retry 不动滚动', () => {
    layout.show(createView(), { kind: 'push', scrollY: null });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });

    layout.show(createView(), { kind: 'pop', scrollY: 321 });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 321, behavior: 'auto' });

    vi.clearAllMocks();
    layout.show(createView(), { kind: 'retry', scrollY: null });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('pop 且历史条目没有 scrollY 时回顶', () => {
    layout.show(createView(), { kind: 'pop', scrollY: null });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
  });

  it('#hash 深链：渲染后滚到锚点而不是回顶', () => {
    const view = createView();
    const target = document.createElement('h2');
    target.id = 'sec';
    view.node.appendChild(target);
    history.replaceState(null, '', '/d/x/#sec');

    layout.show(view, { kind: 'initial', scrollY: null });

    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('hash 找不到锚点时降级回顶', () => {
    history.replaceState(null, '', '/d/x/#missing');
    layout.show(createView(), { kind: 'initial', scrollY: null });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
  });
});

describe('焦点管理（C5）', () => {
  it('导航（非 initial）后焦点落在内容标题上，并补 tabindex=-1', () => {
    const view = createView({ title: '可聚焦标题' });
    layout.show(view, { kind: 'push', scrollY: null });
    const heading = content().querySelector('h1') as HTMLElement;
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('首屏 initial 不抢焦点', () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    layout.show(createView({ title: '首屏' }), { kind: 'initial', scrollY: null });
    const heading = content().querySelector('h1') as HTMLElement;
    expect(document.activeElement).not.toBe(heading);
  });
});

describe('侧边栏转发（syncSidebar / refreshSidebar / openDrawer）', () => {
  it('三个方法都转发给 SidebarHandle', async () => {
    layout.syncSidebar('a/b');
    expect(sidebar.setCurrentSpy).toHaveBeenLastCalledWith('a/b');

    await layout.refreshSidebar();
    expect(sidebar.refreshSpy).toHaveBeenCalledTimes(1);

    layout.openDrawer();
    expect(sidebar.openDrawerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('顶栏搜索表单', () => {
  it('提交表单导航到 /search?q=<encoded>，不走整页刷新', async () => {
    searchInput().value = '压感';
    const form = shell().querySelector('.search-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(location.pathname).toBe('/search');
    expect(location.search).toBe('?q=%E5%8E%8B%E6%84%9F');
  });

  it('空搜索不导航', async () => {
    searchInput().value = '   ';
    const form = shell().querySelector('.search-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(location.pathname).not.toBe('/search');
  });
});
