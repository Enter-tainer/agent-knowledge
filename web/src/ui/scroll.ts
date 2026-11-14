/**
 * 滚动位置的保存 / 恢复（SPA 前进后退的关键）。
 *
 * 浏览器原生的 `history.scrollRestoration = 'auto'` 只对真正的文档加载有意义；
 * SPA 里它会让「后退」落回 0 或者乱跳。这里改成 manual：
 *  - 离开一个历史条目时把 `window.scrollY` 写进该条目的 `history.state`；
 *  - push 新条目时 scrollY 记为 0（新页面从顶部开始）；
 *  - popstate 时读取目标条目记录的 scrollY，在内容渲染后恢复。
 */

const KEY = 'kbScrollY';

interface EntryState {
  kb?: true;
  scrollY?: number;
  [key: string]: unknown;
}

function currentState(): EntryState {
  const raw: unknown = history.state;
  return raw && typeof raw === 'object' ? ({ ...(raw as EntryState) } as EntryState) : {};
}

/** 读一个 history.state 里的 scrollY（无效返回 null）。 */
export function readScrollY(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as EntryState)[KEY];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 安装 manual 滚动恢复；浏览器不支持时静默跳过（如 jsdom）。 */
export function installScrollRestoration(): void {
  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch {
    /* 某些环境（jsdom / 老浏览器）不允许，忽略 */
  }
}

/** 把当前滚动位置写进「当前」历史条目（不改 URL、不触发导航）。 */
export function saveScrollToCurrentEntry(): void {
  const state = currentState();
  if (state[KEY] === window.scrollY) return;
  state[KEY] = window.scrollY;
  try {
    history.replaceState(state, '', location.href);
  } catch {
    /* ignore */
  }
}

/** 新历史条目：滚动位置从 0 开始。 */
export function pushEntry(url: string): void {
  try {
    history.pushState({ [KEY]: 0 }, '', url);
  } catch {
    history.pushState(null, '', url);
  }
}

/** 替换当前条目（新页面同样从顶部开始）。 */
export function replaceEntry(url: string): void {
  try {
    history.replaceState({ [KEY]: 0 }, '', url);
  } catch {
    history.replaceState(null, '', url);
  }
}

/** 只改地址栏、保留当前滚动位置（短名纠正 / 保存后去掉 ?new=1）。 */
export function replaceEntryKeepScroll(url: string): void {
  const state = currentState();
  state[KEY] = window.scrollY;
  try {
    history.replaceState(state, '', url);
  } catch {
    history.replaceState(null, '', url);
  }
}

export function scrollToTop(): void {
  try {
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch {
    /* jsdom 等环境没有实现 scrollTo */
  }
}

/** 恢复到指定滚动位置；null/非法值回到顶部。 */
export function restoreScroll(y: number | null): void {
  const top = y === null ? 0 : Math.max(0, y);
  try {
    window.scrollTo({ top, behavior: 'auto' });
  } catch {
    /* ignore */
  }
}

/**
 * 深链锚点：渲染后滚到 `#hash` 对应元素。
 * 返回 false 表示没有可用的锚点（调用方回顶部）。
 */
export function scrollToHash(hash: string): boolean {
  if (!hash || hash === '#') return false;
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* 保留原样 */
  }
  const target = id ? document.getElementById(id) : null;
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  return true;
}
