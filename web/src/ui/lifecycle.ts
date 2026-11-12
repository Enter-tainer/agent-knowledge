/** 页面级清理：document/window 上的监听必须在下次渲染前解绑。 */

const cleanups = new Set<() => void>();

export function onPageTeardown(fn: () => void): void {
  cleanups.add(fn);
}

export function runPageTeardown(): void {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* 清理失败不影响渲染 */
    }
  }
  cleanups.clear();
}
