/**
 * jsdom 环境补丁（在 setupFiles 里调用一次）。
 *
 * jsdom 没有实现滚动：默认 `window.scrollTo()` 只打印 "Not implemented"，
 * `window.scrollY` 恒为 0，`Element.prototype.scrollIntoView` 不存在。
 * 这里用一个可读写的 scrollY 模拟真实滚动位置，让 `ui/scroll.ts` 与 layout 的
 * 滚动行为（push 回顶 / pop 恢复 / #hash 深链）可以被断言。
 */
import { vi } from 'vitest';

let scrollY = 0;

/** 记录 scrollTo 调用，同时更新模拟的滚动位置。 */
export const scrollTo = vi.fn((arg?: ScrollToOptions | number, y?: number) => {
  if (typeof arg === 'object' && arg !== null) scrollY = Number(arg.top ?? 0) || 0;
  else if (typeof arg === 'number') scrollY = Number(y ?? 0) || 0;
});

export const scrollIntoView = vi.fn();

export function setScrollY(value: number): void {
  scrollY = Number(value) || 0;
}

export function getScrollY(): number {
  return scrollY;
}

export function createMatchMedia(matches = false) {
  return (query: string): MediaQueryList => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const mql = {
      matches,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
    return mql;
  };
}

export function installTestEnv(): void {
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
    set: (value: number) => {
      scrollY = Number(value) || 0;
    },
  });
  Object.defineProperty(window, 'pageYOffset', {
    configurable: true,
    get: () => scrollY,
  });

  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  window.matchMedia = createMatchMedia(false) as unknown as typeof window.matchMedia;
}
