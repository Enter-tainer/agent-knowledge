/** 手写路由（不引 router 库）：History API + location.pathname + 离开守卫。 */

import { confirmLeave, hasDirtyGuard } from './navGuard';

export type Route =
  | { name: 'home' }
  | { name: 'doc'; path: string }
  | { name: 'edit'; path: string; isNew: boolean }
  | { name: 'search'; q: string }
  | { name: 'reports' }
  | { name: 'notfound' };

/** 当前已渲染页面的 URL，离开守卫恢复地址栏时要用。 */
let currentUrl = location.pathname + location.search + location.hash;

/** 文档路径 → URL。逐段 encodeURIComponent，最后加 `/`（dev server / 静态托管的 SPA fallback 更稳）。 */
export function docUrl(path: string): string {
  return `/d/${encodePath(path)}/`;
}

export function editUrl(path: string, isNew = false): string {
  const base = `/edit/${encodePath(path)}/`;
  return isNew ? `${base}?new=1` : base;
}

export function searchUrl(q: string): string {
  return q ? `/search?q=${encodeURIComponent(q)}` : '/search';
}

function encodePath(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseRoute(pathname: string = location.pathname, search: string = location.search): Route {
  const p = pathname.replace(/\/+$/, '') || '/';

  if (p === '/') return { name: 'home' };
  if (p === '/reports') return { name: 'reports' };
  if (p === '/search') {
    const q = new URLSearchParams(search).get('q') ?? '';
    return { name: 'search', q };
  }
  if (p.startsWith('/d/')) {
    const path = decodePath(p.slice(3));
    if (path) return { name: 'doc', path };
  }
  if (p.startsWith('/edit/')) {
    const path = decodePath(p.slice(6));
    if (path) return { name: 'edit', path, isNew: new URLSearchParams(search).get('new') === '1' };
  }
  return { name: 'notfound' };
}

/**
 * 站内跳转。有未保存改动的编辑页会先弹确认；返回 false 表示被用户取消/保存失败。
 * 调用方可以 fire-and-forget（不 await）。
 */
export async function navigate(to: string, opts: { replace?: boolean } = {}): Promise<boolean> {
  if (!(await confirmLeave())) return false;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  currentUrl = to;
  window.dispatchEvent(new Event('kb:navigate'));
  return true;
}

/** 只改地址栏（如短名纠正为真实路径），不触发离开守卫。 */
export function replaceUrl(to: string): void {
  history.replaceState(null, '', to);
  currentUrl = to;
}

export function currentRouteUrl(): string {
  return currentUrl;
}

/** 路由变化时回调；同源普通链接点击自动接管为 SPA 跳转。 */
export function startRouter(onChange: () => void): void {
  window.addEventListener('popstate', () => {
    const target = location.pathname + location.search + location.hash;
    const samePage = target.split('#')[0] === currentUrl.split('#')[0];
    // 只是锚点变化（TOC/标题链接）：不重渲染，交给浏览器做 fragment 滚动
    if (samePage) {
      currentUrl = target;
      return;
    }
    if (!hasDirtyGuard()) {
      currentUrl = target;
      onChange();
      return;
    }
    // 有未保存改动：先把地址栏恢复到当前页面，再弹确认；确认后才真正跳过去。
    history.pushState(null, '', currentUrl);
    void (async () => {
      if (!(await confirmLeave())) return;
      history.replaceState(null, '', target);
      currentUrl = target;
      onChange();
    })();
  });

  window.addEventListener('kb:navigate', () => {
    onChange();
  });

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || anchor.hasAttribute('download')) return;
    if (anchor.target && anchor.target !== '_self') return;

    let url: URL;
    try {
      url = new URL(anchor.href, location.origin);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    if (!url.pathname.startsWith('/')) return;
    event.preventDefault();
    void navigate(url.pathname + url.search + url.hash);
  });

  currentUrl = location.pathname + location.search + location.hash;
  onChange();
}
