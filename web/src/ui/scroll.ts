/**
 * 滚动位置的保存 / 恢复（SPA 前进后退的关键）。
 *
 * 浏览器原生 `history.scrollRestoration = 'auto'` 只对真正的文档加载有意义；
 * SPA 里它会让「后退」落回 0 或者乱跳，所以改成 manual，并自己记账：
 *
 * - 每个历史条目在 `history.state` 里带一个 `kbKey`；
 * - 滚动时把 `scrollY` 记进内存 Map（key → y），**不做** replaceState
 *   （Safari 对 history 写入有频率限制，滚动里写会把自己写死）；
 * - push 新条目从 0 开始；popstate 时按目标条目的 key 取回位置；
 * - 跨整页刷新时内存表为空，退回 `state.kbScrollY`（push 时写的 0）。
 *
 * 另外提供 `#hash` 深链滚动与 `scrollToTop`。
 */

interface EntryState {
  kbKey?: string;
  kbScrollY?: number;
  [key: string]: unknown;
}

/** 当前历史条目的 key（不是 URL：同一 URL 可以有多个历史条目）。 */
let currentKey: string | null = null;
let keySeq = 0;
let scrollTimer: number | undefined;

const positions = new Map<string, number>();

function newKey(): string {
  keySeq += 1;
  return `kb-${Date.now().toString(36)}-${keySeq}`;
}

function readState(raw: unknown): EntryState {
  return raw && typeof raw === 'object' ? ({ ...(raw as EntryState) } as EntryState) : {};
}

/** 从 history.state 里取条目 key（测试与 popstate 用）。 */
export function entryKey(state: unknown): string | null {
  const key = readState(state).kbKey;
  return typeof key === 'string' && key ? key : null;
}

/** 读 history.state 里记录的 scrollY（无效返回 null）；内存表没有时用它兜底。 */
export function readScrollY(state: unknown): number | null {
  const value = readState(state).kbScrollY;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** popstate 的目标滚动位置：优先内存记账，其次 state 兜底。 */
export function scrollForState(state: unknown): number | null {
  const key = entryKey(state);
  if (key) {
    const remembered = positions.get(key);
    if (remembered !== undefined) return remembered;
  }
  return readScrollY(state);
}

/** popstate 后把「当前条目」指向目标条目。 */
export function adoptEntryKey(state: unknown): void {
  cancelPendingScrollTimer();
  const key = entryKey(state);
  currentKey = key ?? newKey();
  if (!key) writeCurrentState(location.href);
}

/** 安装 manual 滚动恢复；浏览器不支持时静默跳过（如 jsdom）。 */
export function installScrollRestoration(): void {
  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch {
    /* 某些环境（jsdom / 老浏览器）不允许，忽略 */
  }
}

/** 启动时给「没有 key 的当前条目」补一个（直接打开 URL 的情况）。 */
export function ensureCurrentEntryKey(): void {
  if (currentKey) return;
  const existing = entryKey(history.state);
  currentKey = existing ?? newKey();
  if (!existing) writeCurrentState(location.href);
}

function writeCurrentState(url: string): void {
  const state = readState(history.state);
  state.kbKey = currentKey ?? newKey();
  if (state.kbScrollY === undefined) state.kbScrollY = 0;
  try {
    history.replaceState(state, '', url);
  } catch {
    /* ignore */
  }
}

/** 把当前滚动位置记进「当前」历史条目（不写 history，只更新内存）。 */
export function saveScrollToCurrentEntry(): void {
  if (!currentKey) return;
  positions.set(currentKey, window.scrollY);
}

/**
 * 取消尚未落地的滚动节流定时器。
 *
 * 换条目时必须调用：旧页面的滚动事件可能还挂着一个未触发的 120ms 定时器，
 * 等它落地时 `currentKey` 已经指向**新**条目、而 `window.scrollY` 可能还是旧值
 * （新页面首屏还在请求中、`scrollToTop()` 尚未执行）——那会把旧页面的滚动位置
 * 记到新条目上，之后后退回来就会跳到错误位置。
 */
function cancelPendingScrollTimer(): void {
  if (scrollTimer === undefined) return;
  window.clearTimeout(scrollTimer);
  scrollTimer = undefined;
}

/** 新历史条目：滚动位置从 0 开始。 */
export function pushEntry(url: string): void {
  cancelPendingScrollTimer();
  const key = newKey();
  positions.set(key, 0);
  currentKey = key;
  try {
    history.pushState({ kbKey: key, kbScrollY: 0 }, '', url);
  } catch {
    history.pushState(null, '', url);
  }
}

/** 替换当前条目（新页面同样从顶部开始）。 */
export function replaceEntry(url: string): void {
  cancelPendingScrollTimer();
  if (!currentKey) currentKey = entryKey(history.state) ?? newKey();
  positions.set(currentKey, 0);
  try {
    history.replaceState({ kbKey: currentKey, kbScrollY: 0 }, '', url);
  } catch {
    history.replaceState(null, '', url);
  }
}

/** 只改地址栏、保留当前滚动位置（短名纠正 / 保存后去掉 ?new=1）。 */
export function replaceEntryKeepScroll(url: string): void {
  if (!currentKey) currentKey = entryKey(history.state) ?? newKey();
  positions.set(currentKey, window.scrollY);
  try {
    history.replaceState({ kbKey: currentKey, kbScrollY: window.scrollY }, '', url);
  } catch {
    history.replaceState(null, '', url);
  }
}

/** 监听滚动，节流记录当前位置（不碰 history API）。 */
export function installScrollTracking(): void {
  window.addEventListener(
    'scroll',
    () => {
      if (scrollTimer !== undefined) return;
      scrollTimer = window.setTimeout(() => {
        scrollTimer = undefined;
        saveScrollToCurrentEntry();
      }, 120);
    },
    { passive: true },
  );
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

/** 测试用：清空内存记账（每个用例之间隔离）。 */
export function resetScrollMemory(): void {
  positions.clear();
  currentKey = null;
  keySeq = 0;
  if (scrollTimer !== undefined) {
    window.clearTimeout(scrollTimer);
    scrollTimer = undefined;
  }
}

/** 当前（尚未被 popstate 改写的）历史条目 key。 */
export function currentEntryKey(): string | null {
  return currentKey;
}
