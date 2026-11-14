/** 手写路由（不引 router 库）：History API + location.pathname + 离开守卫。 */

import { confirmLeave, hasDirtyGuard } from './navGuard';
import type { NavInfo } from './ui/view';
import {
  adoptEntryKey,
  currentEntryKey,
  ensureCurrentEntryKey,
  installScrollRestoration,
  installScrollTracking,
  pushEntry,
  replaceEntryKeepScroll,
  replaceEntry,
  saveScrollToCurrentEntry,
  scrollForState,
  scrollToHash,
} from './ui/scroll';

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
 *
 * 「目标就是当前页面」时默认**不做任何事**：不 push 历史条目、不重渲染、不动滚动位置。
 * 否则在侧边栏点当前高亮项会跳回顶部、多压一条历史，手机抽屉里点当前文章则会
 * 「关掉抽屉 + 闪一次加载但内容没变」。
 *
 * 但有些调用方是「在同一 URL 上刷新数据」（如首页重建索引后要重拉 health），
 * 这时传 `force: true` 跳过同页判断 —— 仍然不压历史条目（走 replace）。
 */
export async function navigate(
  to: string,
  opts: { replace?: boolean; force?: boolean } = {},
): Promise<boolean> {
  const samePage = isSamePage(to, currentUrl);
  if (!opts.force && samePage) {
    // 同页但带新 hash（例如正文里指向本文某节的链接）：不重渲染，只滚到锚点。
    // 注意点击委托已经 preventDefault，浏览器原生 fragment 滚动被吃掉了，必须自己滚。
    const hash = to.includes('#') ? `#${to.split('#').slice(1).join('#')}` : '';
    if (hash && hash !== (currentUrl.includes('#') ? `#${currentUrl.split('#').slice(1).join('#')}` : '')) {
      currentUrl = to;
      if (scrollToHash(hash)) {
        try {
          history.replaceState({ ...(history.state ?? {}), kbHash: hash }, '', to);
        } catch {
          /* 某些环境不允许，忽略：滚动已经发生了 */
        }
      }
    }
    return false;
  }
  if (!(await confirmLeave())) return false;
  // 先把当前滚动位置记到「当前」历史条目，浏览器后退时才能恢复
  saveScrollToCurrentEntry();
  if (opts.replace) replaceEntry(to);
  else pushEntry(to);
  currentUrl = to;
  window.dispatchEvent(new CustomEvent('kb:navigate', { detail: { kind: 'push' } }));
  return true;
}

/** 两个站内 URL 是否指向同一页面（忽略 hash，但保留 query）。 */
function isSamePage(a: string, b: string): boolean {
  return stripUrl(a) === stripUrl(b);
}

/** 归一化到「页面标识」：去掉 hash、去掉尾部斜杠。 */
function stripUrl(url: string): string {
  return url.split('#')[0].replace(/\/+$/, '') || '/';
}

/**
 * 只改地址栏（如短名纠正为真实路径），不触发离开守卫、不丢滚动位置。
 *
 * `expectedUrl` 用来防「过期渲染改写地址栏」：页面工厂是异步的，用户在请求返回前
 * 已经导航走了，此时再改地址栏会把**新**页面的历史条目指向**旧**文档 URL，
 * 造成地址栏与正文错位、并且之后点那篇文档会被 isSamePage 判定为「已经在这一页」
 * 而无任何反应。传了 expectedUrl 就只在「地址栏仍是它认为的那一页」时才改。
 */
export function replaceUrl(to: string, expectedUrl?: string): void {
  if (expectedUrl !== undefined && !isSamePage(expectedUrl, currentUrl)) return;
  replaceEntryKeepScroll(to);
  currentUrl = to;
}

export function currentRouteUrl(): string {
  return currentUrl;
}

/** 路由变化时回调；同源普通链接点击自动接管为 SPA 跳转。 */
export function startRouter(onChange: (nav: NavInfo) => void): void {
  installScrollRestoration();
  installScrollTracking();
  ensureCurrentEntryKey();

  window.addEventListener('popstate', (event) => {
    const target = location.pathname + location.search + location.hash;
    const samePage = target.split('#')[0] === currentUrl.split('#')[0];
    // 只是锚点变化（TOC/标题链接）：不重渲染，交给浏览器做 fragment 滚动
    if (samePage) {
      currentUrl = target;
      return;
    }

    // 记下「离开的那一页」的位置与 key（此时 DOM/滚动仍是旧页面）
    const targetState = event.state;
    const targetScroll = scrollForState(targetState);
    const priorUrl = currentUrl;
    const priorKey = currentEntryKey();

    if (!hasDirtyGuard()) {
      saveScrollToCurrentEntry();
      adoptEntryKey(targetState);
      currentUrl = target;
      onChange({ kind: 'pop', scrollY: targetScroll });
      return;
    }

    // 有未保存改动：地址栏先切回旧页面（不渲染），弹确认；确认后才真正跳到目标。
    saveScrollToCurrentEntry();
    history.pushState({ kbKey: priorKey, kbScrollY: window.scrollY }, '', priorUrl);
    void (async () => {
      if (!(await confirmLeave())) {
        // 留在旧页面：地址栏已经是旧 URL，什么都不用做
        return;
      }
      history.replaceState(targetState ?? null, '', target);
      adoptEntryKey(targetState);
      currentUrl = target;
      onChange({ kind: 'pop', scrollY: targetScroll });
    })();
  });

  window.addEventListener('kb:navigate', (event) => {
    const detail = (event as CustomEvent<{ kind?: string }>).detail;
    onChange({ kind: detail?.kind === 'push' ? 'push' : 'retry', scrollY: null });
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
  onChange({ kind: 'initial', scrollY: null });
}
