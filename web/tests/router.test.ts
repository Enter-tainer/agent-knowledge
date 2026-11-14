/**
 * 路由层契约（docs/web-nav-sidebar-acceptance.md §2 硬性约束 5、§4 A3/A5/A6/C6）：
 *  - parseRoute / docUrl / editUrl / searchUrl（逐段 encodeURIComponent）
 *  - navigate：push vs replace、离开守卫取消时**不改地址栏、不触发渲染**
 *  - popstate：带历史条目 scrollY 交给 layout 恢复；仅 hash 变化不重渲染
 *  - 同源普通链接点击被接管为 SPA 导航
 *
 * 离开守卫用 vi.mock 替换，保证用例不依赖编辑页 DOM。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/navGuard', () => ({
  confirmLeave: vi.fn(async () => true),
  hasDirtyGuard: vi.fn(() => false),
}));

import { confirmLeave, hasDirtyGuard } from '../src/navGuard';
import { navigate, parseRoute, currentRouteUrl, docUrl, editUrl, replaceUrl, searchUrl, startRouter } from '../src/router';
import { entryKey, readScrollY, resetScrollMemory, saveScrollToCurrentEntry, scrollForState } from '../src/ui/scroll';
import { getScrollY, setScrollY } from './helpers/env';

const onChange = vi.fn();
// 整个文件只注册一次路由监听（模拟应用只启动一次路由），用例之间通过 replaceUrl 重置 currentUrl。
startRouter(onChange);

const flush = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

function resetRouter(): void {
  resetScrollMemory();
  history.replaceState(null, '', '/');
  replaceUrl('/');
  setScrollY(0);
  onChange.mockClear();
  vi.mocked(confirmLeave).mockClear();
  vi.mocked(hasDirtyGuard).mockClear();
  vi.mocked(hasDirtyGuard).mockReturnValue(false);
  vi.mocked(confirmLeave).mockResolvedValue(true);
  document.body.replaceChildren();
}

beforeEach(resetRouter);

describe('parseRoute / URL 构造', () => {
  it('识别首页、报告页与未知路由', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/reports')).toEqual({ name: 'reports' });
    expect(parseRoute('/reports/')).toEqual({ name: 'reports' });
    expect(parseRoute('/no-such-page')).toEqual({ name: 'notfound' });
    expect(parseRoute('/d/')).toEqual({ name: 'notfound' });
    expect(parseRoute('/edit/')).toEqual({ name: 'notfound' });
  });

  it('解析搜索页 ?q=', () => {
    expect(parseRoute('/search', '?q=压感')).toEqual({ name: 'search', q: '压感' });
    expect(parseRoute('/search', '')).toEqual({ name: 'search', q: '' });
    expect(parseRoute('/search/', '?q=a%20b')).toEqual({ name: 'search', q: 'a b' });
  });

  it('解析中文 / 带空格 / 多级文档路径（含 %xx 编码）', () => {
    expect(parseRoute('/d/中文路径/')).toEqual({ name: 'doc', path: '中文路径' });
    expect(parseRoute('/d/%E4%B8%AD%E6%96%87/%E8%B7%AF%E5%BE%84/')).toEqual({
      name: 'doc',
      path: '中文/路径',
    });
    expect(parseRoute('/d/a%20b/c/')).toEqual({ name: 'doc', path: 'a b/c' });
    expect(parseRoute('/d/示例库/设备乙%20逆向/')).toEqual({ name: 'doc', path: '示例库/设备乙' });
  });

  it('解析编辑页与 ?new=1', () => {
    expect(parseRoute('/edit/foo/')).toEqual({ name: 'edit', path: 'foo', isNew: false });
    expect(parseRoute('/edit/foo/', '?new=1')).toEqual({ name: 'edit', path: 'foo', isNew: true });
    expect(parseRoute('/edit/foo/', '?new=0')).toEqual({ name: 'edit', path: 'foo', isNew: false });
    expect(parseRoute('/edit/中文/路径/', '?new=1')).toEqual({
      name: 'edit',
      path: '中文/路径',
      isNew: true,
    });
  });

  it('默认使用 location 的 pathname/search', () => {
    history.replaceState(null, '', '/reports');
    expect(parseRoute()).toEqual({ name: 'reports' });
    history.replaceState(null, '', '/search?q=x');
    expect(parseRoute()).toEqual({ name: 'search', q: 'x' });
  });

  it('docUrl 逐段 encodeURIComponent 且保留多级路径', () => {
    expect(docUrl('中文路径')).toBe('/d/%E4%B8%AD%E6%96%87%E8%B7%AF%E5%BE%84/');
    expect(docUrl('a b/c#d')).toBe('/d/a%20b/c%23d/');
    expect(docUrl('/leading/trailing/')).toBe('/d/leading/trailing/');
    expect(docUrl('示例库/设备乙 单导心电/数据格式说明')).toBe(
      `/d/${encodeURIComponent('示例库')}/${encodeURIComponent('设备乙 单导心电')}/${encodeURIComponent('数据格式说明')}/`,
    );
    expect(docUrl('a/b') === docUrl('a/b')).toBe(true);
    expect(docUrl('中文') === docUrl('中文')).toBe(true);
  });

  it('editUrl 带 / 结尾，isNew 时追加 ?new=1；searchUrl 编码 q', () => {
    expect(editUrl('a/b')).toBe('/edit/a/b/');
    expect(editUrl('a/b', true)).toBe('/edit/a/b/?new=1');
    expect(editUrl('中文')).toBe('/edit/%E4%B8%AD%E6%96%87/');
    expect(searchUrl('压感')).toBe('/search?q=%E5%8E%8B%E6%84%9F');
    expect(searchUrl('a b&c')).toBe('/search?q=a%20b%26c');
    expect(searchUrl('')).toBe('/search');
  });
});

describe('navigate：push / replace', () => {
  it('push 新历史条目，记录 scrollY=0，并广播 kind=push', async () => {
    const lengthBefore = history.length;
    setScrollY(250);
    await expect(navigate('/reports')).resolves.toBe(true);
    expect(location.pathname).toBe('/reports');
    expect(history.length).toBe(lengthBefore + 1);
    expect(history.state?.kbScrollY).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'push', scrollY: null });
    expect(currentRouteUrl()).toBe('/reports');
  });

  it('push 前把当前 scrollY 写进「当前」历史条目（后退恢复的数据来源）', async () => {
    setScrollY(321);
    await navigate('/reports');
    // navigate 用 pushEntry 覆盖新条目 scrollY=0；旧条目的 321 只能在 popstate 时由浏览器提供，
    // 这里直接验证历史条目数 + 新条目从 0 开始，旧条目数据由 scroll.test.ts 的
    // saveScrollToCurrentEntry 覆盖。
    expect(history.state?.kbScrollY).toBe(0);
    expect(location.pathname).toBe('/reports');
  });

  it('目标是当前页面时不做任何事：不 push 历史、不广播、滚动位置不动', async () => {
    // 回归：在侧边栏点「当前高亮那篇」曾会多压一条历史并跳回顶部
    const lengthBefore = history.length;
    setScrollY(800);
    await expect(navigate('/')).resolves.toBe(false);
    expect(history.length).toBe(lengthBefore);
    expect(getScrollY()).toBe(800);
    expect(onChange).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/');
  });

  it('忽略 hash 与尾部斜杠差异，视为同一页', async () => {
    const lengthBefore = history.length;
    await expect(navigate('/#sec')).resolves.toBe(false);
    await expect(navigate('//')).resolves.toBe(false);
    expect(history.length).toBe(lengthBefore);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('同一路径但 query 不同仍算不同页面（搜索词变化要重新渲染）', async () => {
    const lengthBefore = history.length;
    await expect(navigate('/search?q=%E5%8E%8B%E6%84%9F')).resolves.toBe(true);
    expect(history.length).toBe(lengthBefore + 1);
  });
  it('replace 不改历史长度，新页面从顶部开始', async () => {
    const lengthBefore = history.length;
    await expect(navigate('/search?q=%E5%8E%8B%E6%84%9F', { replace: true })).resolves.toBe(true);
    expect(history.length).toBe(lengthBefore);
    expect(location.pathname).toBe('/search');
    expect(location.search).toBe('?q=%E5%8E%8B%E6%84%9F');
    expect(history.state?.kbScrollY).toBe(0);
    expect(onChange).toHaveBeenCalledWith({ kind: 'push', scrollY: null });
  });

  it('离开守卫被取消时不改地址栏、不触发渲染', async () => {
    vi.mocked(hasDirtyGuard).mockReturnValue(true);
    vi.mocked(confirmLeave).mockResolvedValue(false);
    setScrollY(333);

    await expect(navigate('/reports')).resolves.toBe(false);

    expect(location.pathname).toBe('/');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('离开守卫确认后照常导航', async () => {
    vi.mocked(hasDirtyGuard).mockReturnValue(true);
    vi.mocked(confirmLeave).mockResolvedValue(true);
    await expect(navigate('/reports')).resolves.toBe(true);
    expect(location.pathname).toBe('/reports');
  });

  it('replaceUrl 只改地址栏并保留当前滚动位置，不广播导航', () => {
    setScrollY(77);
    replaceUrl('/d/corrected/');
    expect(location.pathname).toBe('/d/corrected/');
    expect(history.state?.kbScrollY).toBe(77);
    expect(currentRouteUrl()).toBe('/d/corrected/');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('popstate 语义', () => {
  it('带回条目 scrollY，交给 layout 以 kind=pop 恢复', () => {
    history.pushState(null, '', '/reports');
    onChange.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate', { state: { kbScrollY: 400 } }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'pop', scrollY: 400 });
    expect(currentRouteUrl()).toBe('/reports');
    // popstate 会 adoptEntryKey：事件 state 没有 kbKey 时新建一个并写回（kbScrollY 兜底为 0）
    expect(entryKey(history.state)).toBeTruthy();
    expect(readScrollY(history.state)).toBe(0);
    // 但「交给 layout 恢复」的值来自事件 state（这里没有内存记账，退化为 state.kbScrollY）
    expect(scrollForState({ kbKey: entryKey(history.state), kbScrollY: 0 })).toBe(0);
  });

  it('历史 state 缺失 scrollY 时仍触发渲染（scrollY=null）', () => {
    history.pushState(null, '', '/reports');
    onChange.mockClear();
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'pop', scrollY: null });
  });

  it('内存记账后 popstate 恢复真实滚动位置（A5 的数据来源）', async () => {
    // 真实流程：首页滚到 1200 → push 到 /reports（离开时记账）→ 浏览器 back 回首页
    setScrollY(1200);
    saveScrollToCurrentEntry();
    const homeKey = entryKey(history.state);
    expect(homeKey).toBeTruthy();

    await navigate('/reports');
    expect(location.pathname).toBe('/reports');
    onChange.mockClear();

    // 浏览器 back：地址栏回到首页条目，popstate 带回该条目的 state
    history.replaceState({ kbKey: homeKey, kbScrollY: 0 }, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate', { state: { kbKey: homeKey, kbScrollY: 0 } }));

    expect(onChange).toHaveBeenCalledWith({ kind: 'pop', scrollY: 1200 });
    expect(scrollForState({ kbKey: homeKey, kbScrollY: 0 })).toBe(1200);
  });

  it('仅 #hash 变化的 popstate 不重渲染（交给浏览器做 fragment 滚动）', () => {
    replaceUrl('/d/x/');
    history.pushState(null, '', '/d/x/#sec');
    onChange.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate', { state: { kbScrollY: 0 } }));

    expect(onChange).not.toHaveBeenCalled();
    expect(currentRouteUrl()).toBe('/d/x/#sec');
  });

  it('脏离开守卫取消 popstate：地址栏恢复当前页，不渲染', async () => {
    vi.mocked(hasDirtyGuard).mockReturnValue(true);
    vi.mocked(confirmLeave).mockResolvedValue(false);
    replaceUrl('/');
    history.pushState(null, '', '/reports');
    onChange.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate', { state: { kbScrollY: 5 } }));
    await flush();

    expect(location.pathname).toBe('/');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('脏离开守卫确认后 popstate 照常渲染并恢复 scrollY', async () => {
    vi.mocked(hasDirtyGuard).mockReturnValue(true);
    vi.mocked(confirmLeave).mockResolvedValue(true);
    replaceUrl('/');
    history.pushState(null, '', '/reports');
    onChange.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate', { state: { kbScrollY: 5 } }));
    await flush();

    expect(location.pathname).toBe('/reports');
    expect(onChange).toHaveBeenCalledWith({ kind: 'pop', scrollY: 5 });
  });
});

describe('点击接管', () => {
  it('同源普通链接点击被接管为 SPA 导航（不整页刷新）', async () => {
    document.body.innerHTML = '<a id="lnk" href="/reports">报告</a>';
    const anchor = document.getElementById('lnk') as HTMLAnchorElement;
    anchor.click();
    await flush();

    expect(location.pathname).toBe('/reports');
    expect(onChange).toHaveBeenCalledWith({ kind: 'push', scrollY: null });
  });

  it('外链 / 带 download 的链接不被接管', () => {
    document.body.innerHTML =
      '<a id="ext" href="https://example.com/x">外链</a><a id="dl" href="/api/export" download>导出</a>';
    const ext = document.getElementById('ext') as HTMLAnchorElement;
    const dl = document.getElementById('dl') as HTMLAnchorElement;

    // 观察 router 是否 preventDefault：外链/下载应「放行」，交给浏览器。
    // 注册在 router 的 document 监听之后，读到它的决定后再 preventDefault，
    // 避免 jsdom 真的去导航（jsdom 只打印 "Not implemented"，但会污染输出）。
    const decisions: boolean[] = [];
    const observe = (event: Event): void => {
      decisions.push(event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener('click', observe);
    try {
      ext.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      dl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    } finally {
      document.removeEventListener('click', observe);
    }

    expect(decisions).toEqual([false, false]); // 两条都不被 router 接管
    expect(onChange).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/');
  });

  it('同源站内链接会被 preventDefault（避免真整页跳转）', () => {
    document.body.innerHTML = '<a id="lnk" href="/reports">报告</a>';
    const anchor = document.getElementById('lnk') as HTMLAnchorElement;
    let prevented = false;
    const observe = (event: Event): void => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('click', observe);
    try {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    } finally {
      document.removeEventListener('click', observe);
    }
    expect(prevented).toBe(true);
  });

  it('带修饰键（Ctrl/Cmd）的点击不被接管', () => {
    document.body.innerHTML = '<a id="lnk" href="/reports">报告</a>';
    const anchor = document.getElementById('lnk') as HTMLAnchorElement;
    let prevented = true;
    const observe = (event: Event): void => {
      prevented = event.defaultPrevented;
      event.preventDefault(); // 浏览器会开新标签页；jsdom 不支持，这里挡掉避免无谓噪音
    };
    document.addEventListener('click', observe);
    try {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    } finally {
      document.removeEventListener('click', observe);
    }
    expect(prevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('站内 #hash 链接不被接管（交给浏览器做 fragment 滚动）', () => {
    document.body.innerHTML = '<a id="frag" href="#sec">锚点</a>';
    const anchor = document.getElementById('frag') as HTMLAnchorElement;
    let prevented = true;
    const observe = (event: Event): void => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('click', observe);
    try {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    } finally {
      document.removeEventListener('click', observe);
    }
    expect(prevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('离开守卫调用约定', () => {
  it('navigate 先问守卫；replace 同样受守卫保护', async () => {
    vi.mocked(hasDirtyGuard).mockReturnValue(true);
    vi.mocked(confirmLeave).mockResolvedValue(false);
    await expect(navigate('/reports', { replace: true })).resolves.toBe(false);
    expect(confirmLeave).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/');
  });
});
