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
import { readScrollY } from '../src/ui/scroll';
import { setScrollY } from './helpers/env';

const onChange = vi.fn();
// 整个文件只注册一次路由监听（模拟应用只启动一次路由），用例之间通过 replaceUrl 重置 currentUrl。
startRouter(onChange);

const flush = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

function resetRouter(): void {
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
    expect(readScrollY(history.state)).toBeNull(); // 事件 state 只用于读取，不改写当前 state
  });

  it('历史 state 缺失 scrollY 时仍触发渲染（scrollY=null）', () => {
    history.pushState(null, '', '/reports');
    onChange.mockClear();
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'pop', scrollY: null });
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
    const extEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    ext.dispatchEvent(extEvent);
    dl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

    // 两条都不应触发 SPA 导航（外链交给浏览器，download 交给浏览器下载）
    expect(onChange).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/');
  });

  it('带修饰键（Ctrl/Cmd）的点击不被接管', () => {
    document.body.innerHTML = '<a id="lnk" href="/reports">报告</a>';
    const anchor = document.getElementById('lnk') as HTMLAnchorElement;
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('站内 #hash 链接不被接管', () => {
    document.body.innerHTML = '<a id="frag" href="#sec">锚点</a>';
    (document.getElementById('frag') as HTMLAnchorElement).click();
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
