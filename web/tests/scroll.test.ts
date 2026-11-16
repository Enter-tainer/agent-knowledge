/**
 * 滚动恢复 helper（docs/web-nav-sidebar-acceptance.md §2 硬性约束 5、§4 A5）。
 *
 * 现行契约为「key + 内存记账」方案（见 web/src/ui/scroll.ts）：
 *  - 每个历史条目在 `history.state` 里带一个 `kbKey`（push/replace 时写入）；
 *  - 滚动位置记在内存 `positions`（key → y），`saveScrollToCurrentEntry()` **不写 history**；
 *  - popstate 时 `scrollForState()` 优先取内存、其次用 `state.kbScrollY` 兜底（跨整页刷新）；
 *  - push/replace 新条目从 0 开始；`replaceEntryKeepScroll` 保留当前位置；
 *  - `scrollToHash`：渲染后滚到 `#hash`（中文锚点要解码）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adoptEntryKey,
  currentEntryKey,
  ensureCurrentEntryKey,
  entryKey,
  installScrollRestoration,
  installScrollTracking,
  pushEntry,
  readScrollY,
  replaceEntry,
  replaceEntryKeepScroll,
  resetScrollMemory,
  restoreScroll,
  saveScrollToCurrentEntry,
  scrollForState,
  scrollToHash,
  scrollToTop,
} from '../src/ui/scroll';
import { getScrollY, scrollIntoView, scrollTo, setScrollY } from './helpers/env';

beforeEach(() => {
  resetScrollMemory();
  setScrollY(0);
  history.replaceState(null, '', '/');
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('readScrollY / entryKey（只读 history.state）', () => {
  it('readScrollY 只接受非负有限数字', () => {
    expect(readScrollY({ kbScrollY: 0 })).toBe(0);
    expect(readScrollY({ kbScrollY: 123.5 })).toBe(123.5);
    expect(readScrollY({ kbScrollY: -1 })).toBeNull();
    expect(readScrollY({ kbScrollY: '5' })).toBeNull();
    expect(readScrollY({ kbScrollY: Number.NaN })).toBeNull();
    expect(readScrollY({})).toBeNull();
    expect(readScrollY(null)).toBeNull();
    expect(readScrollY(undefined)).toBeNull();
  });

  it('entryKey 只接受非空字符串 kbKey', () => {
    expect(entryKey({ kbKey: 'kb-1' })).toBe('kb-1');
    expect(entryKey({ kbKey: '' })).toBeNull();
    expect(entryKey({ kbKey: 42 })).toBeNull();
    expect(entryKey({})).toBeNull();
    expect(entryKey(null)).toBeNull();
  });
});

describe('内存记账：saveScrollToCurrentEntry 不写 history', () => {
  it('把当前 scrollY 记进内存，history.state 仍保留 push 时的 0', () => {
    const lengthBefore = history.length;
    ensureCurrentEntryKey();
    const key = currentEntryKey();
    expect(key).toBeTruthy();

    setScrollY(250);
    saveScrollToCurrentEntry();

    expect(history.length).toBe(lengthBefore);
    expect(key && scrollForState(history.state)).toBe(250); // 内存记账生效
    expect(readScrollY(history.state)).toBe(0); // state 里的兜底值没被滚动改写

    setScrollY(999);
    saveScrollToCurrentEntry();
    expect(scrollForState(history.state)).toBe(999);
  });

  it('跨整页刷新兜底：内存表清空后仍能从 state.kbScrollY 取到值', () => {
    resetScrollMemory(); // 模拟新进程 / 整页刷新：内存记账表为空
    expect(scrollForState({ kbKey: 'kb-x', kbScrollY: 0 })).toBe(0);
    expect(scrollForState({ kbKey: 'kb-x', kbScrollY: 1200 })).toBe(1200);
    expect(scrollForState({ kbKey: 'kb-x' })).toBeNull();
    expect(scrollForState(null)).toBeNull();
  });

  it('内存记账优先于 state 兜底（同一 key 移动过位置）', () => {
    ensureCurrentEntryKey();
    const key = currentEntryKey()!;
    setScrollY(723);
    saveScrollToCurrentEntry();
    expect(scrollForState({ kbKey: key, kbScrollY: 0 })).toBe(723);
  });

  it('没有 key 时 saveScrollToCurrentEntry 是空操作', () => {
    resetScrollMemory();
    setScrollY(50);
    expect(() => saveScrollToCurrentEntry()).not.toThrow();
    expect(currentEntryKey()).toBeNull();
  });
});

describe('adoptEntryKey（popstate 后指向目标条目）', () => {
  it('事件里带 key 时直接采用，且不写回 history', () => {
    const before = history.state;
    adoptEntryKey({ kbKey: 'kb-target', kbScrollY: 10 });
    expect(currentEntryKey()).toBe('kb-target');
    expect(history.state).toBe(before);
  });

  it('事件里没有 key（老条目 / 手写事件）时新建 key 并写回 history.state', () => {
    adoptEntryKey({ kbScrollY: 10 });
    expect(currentEntryKey()).toBeTruthy();
    expect(entryKey(history.state)).toBe(currentEntryKey());
    expect(readScrollY(history.state)).toBe(0); // 兜底值，不是事件里的 10
  });

  it('ensureCurrentEntryKey 幂等：已有 key 时不变', () => {
    ensureCurrentEntryKey();
    const first = currentEntryKey();
    ensureCurrentEntryKey();
    expect(currentEntryKey()).toBe(first);
    expect(entryKey(history.state)).toBe(first);
  });
});

describe('历史条目状态', () => {
  it('installScrollRestoration 把浏览器恢复策略改为 manual（不支持时静默跳过）', () => {
    installScrollRestoration();
    if ('scrollRestoration' in history) expect(history.scrollRestoration).toBe('manual');
  });

  it('pushEntry：新增条目、带新 key、scrollY 从 0 开始', () => {
    ensureCurrentEntryKey();
    const previousKey = currentEntryKey();
    const lengthBefore = history.length;

    pushEntry('/reports');

    expect(location.pathname).toBe('/reports');
    expect(history.length).toBe(lengthBefore + 1);
    expect(readScrollY(history.state)).toBe(0);
    expect(entryKey(history.state)).toBe(currentEntryKey());
    expect(currentEntryKey()).not.toBe(previousKey);
    expect(scrollForState(history.state)).toBe(0);
  });

  it('replaceEntry：不新增条目，scrollY 归零', () => {
    setScrollY(400);
    ensureCurrentEntryKey();
    saveScrollToCurrentEntry();
    const lengthBefore = history.length;

    replaceEntry('/reports');

    expect(history.length).toBe(lengthBefore);
    expect(location.pathname).toBe('/reports');
    expect(readScrollY(history.state)).toBe(0);
    expect(scrollForState(history.state)).toBe(0);
  });

  it('replaceEntryKeepScroll：只改地址栏，保留当前 scrollY（短名纠正 / 保存后去 ?new=1）', () => {
    ensureCurrentEntryKey();
    setScrollY(77);
    replaceEntryKeepScroll('/d/real-path/');
    expect(location.pathname).toBe('/d/real-path/');
    expect(readScrollY(history.state)).toBe(77);
    expect(scrollForState(history.state)).toBe(77);
  });

  it('接受站内绝对 URL，地址栏按 URL 更新', () => {
    pushEntry('/d/%E4%B8%AD%E6%96%87/');
    expect(decodeURIComponent(location.pathname)).toBe('/d/中文/');
    replaceEntry('/search?q=%E5%8E%8B%E6%84%9F');
    expect(location.search).toBe('?q=%E5%8E%8B%E6%84%9F');
  });
});

describe('scrollToTop / restoreScroll', () => {
  it('scrollToTop 滚到 0', () => {
    setScrollY(500);
    scrollToTop();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(getScrollY()).toBe(0);
  });

  it('restoreScroll 恢复到记录的 scrollY；null/负数回顶部', () => {
    restoreScroll(321);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 321, behavior: 'auto' });
    expect(getScrollY()).toBe(321);

    restoreScroll(null);
    expect(getScrollY()).toBe(0);

    restoreScroll(-20);
    expect(getScrollY()).toBe(0);
  });
});

describe('scrollToHash（#hash 深链）', () => {
  function addAnchor(id: string): HTMLElement {
    const node = document.createElement('h2');
    node.id = id;
    document.body.appendChild(node);
    return node;
  }

  it('找到锚点后 scrollIntoView 并返回 true', () => {
    addAnchor('sec');
    expect(scrollToHash('#sec')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('解码百分号编码的中文锚点', () => {
    addAnchor('中文');
    expect(scrollToHash('#%E4%B8%AD%E6%96%87')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('空 hash / 只有 # / 找不到锚点 / 非法编码返回 false（调用方回顶部）', () => {
    expect(scrollToHash('')).toBe(false);
    expect(scrollToHash('#')).toBe(false);
    expect(scrollToHash('#missing')).toBe(false);
    expect(scrollToHash('#%E0%A4%A')).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('滚动节流定时器与条目切换的竞态（A5 回归）', () => {
  /**
   * 真实 bug：用户在长文里滚动 → 120ms 节流定时器挂起 → 立刻点链接导航。
   * 若换条目不取制定时器，定时器落地时 currentKey 已指向**新**条目、
   * window.scrollY 还是旧页面的值 → 旧位置被记到新条目上，后退回来就跳错位置。
   */
  it('pushEntry 取制挂起的滚动定时器：旧位置不会记到新条目上', () => {
    vi.useFakeTimers();
    try {
      ensureCurrentEntryKey();
      const oldKey = currentEntryKey()!;

      // 旧页面滚到 1200，滚动事件挂起一个未落地的定时器
      setScrollY(1200);
      installScrollTracking();
      window.dispatchEvent(new Event('scroll'));
      expect(scrollForState({ kbKey: oldKey, kbScrollY: 0 })).not.toBe(1200); // 还没落地

      // 立刻导航（新条目从 0 开始）
      pushEntry('/next');
      const newKey = currentEntryKey()!;
      expect(newKey).not.toBe(oldKey);

      // 让那个残留定时器有机会落地
      vi.advanceTimersByTime(200);

      expect(scrollForState({ kbKey: newKey, kbScrollY: 0 })).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adoptEntryKey（popstate）同样取制挂起定时器', () => {
    vi.useFakeTimers();
    try {
      ensureCurrentEntryKey();
      installScrollTracking();
      setScrollY(800);
      window.dispatchEvent(new Event('scroll'));

      adoptEntryKey({ kbKey: 'kb-popped', kbScrollY: 300 });
      vi.advanceTimersByTime(200);

      expect(scrollForState({ kbKey: 'kb-popped', kbScrollY: 300 })).toBe(300);
    } finally {
      vi.useRealTimers();
    }
  });
});