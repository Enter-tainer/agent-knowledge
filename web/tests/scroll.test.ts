/**
 * 滚动恢复 helper（docs/web-nav-sidebar-acceptance.md §2 硬性约束 5、§4 A5）：
 *  - history.scrollRestoration='manual'
 *  - 离开历史条目时把 scrollY 写进 history.state
 *  - push/replace 新条目从 0 开始；replaceEntryKeepScroll 保留位置
 *  - scrollToHash 深链锚点：渲染后滚到 #hash
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installScrollRestoration,
  pushEntry,
  readScrollY,
  replaceEntry,
  replaceEntryKeepScroll,
  restoreScroll,
  saveScrollToCurrentEntry,
  scrollToHash,
  scrollToTop,
} from '../src/ui/scroll';
import { getScrollY, scrollIntoView, scrollTo, setScrollY } from './helpers/env';

beforeEach(() => {
  history.replaceState(null, '', '/');
  setScrollY(0);
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('readScrollY', () => {
  it('只接受非负有限数字', () => {
    expect(readScrollY({ kbScrollY: 0 })).toBe(0);
    expect(readScrollY({ kbScrollY: 123.5 })).toBe(123.5);
    expect(readScrollY({ kbScrollY: -1 })).toBeNull();
    expect(readScrollY({ kbScrollY: '5' })).toBeNull();
    expect(readScrollY({ kbScrollY: Number.NaN })).toBeNull();
    expect(readScrollY({})).toBeNull();
    expect(readScrollY(null)).toBeNull();
    expect(readScrollY(undefined)).toBeNull();
  });
});

describe('历史条目状态', () => {
  it('installScrollRestoration 把浏览器恢复策略改为 manual（不支持时静默跳过）', () => {
    installScrollRestoration();
    if ('scrollRestoration' in history) expect(history.scrollRestoration).toBe('manual');
  });

  it('saveScrollToCurrentEntry 把当前 scrollY 写进当前条目，不新增条目', () => {
    const lengthBefore = history.length;
    setScrollY(250);
    saveScrollToCurrentEntry();
    expect(history.length).toBe(lengthBefore);
    expect(history.state?.kbScrollY).toBe(250);

    setScrollY(999);
    saveScrollToCurrentEntry();
    expect(history.state?.kbScrollY).toBe(999);
  });

  it('pushEntry：新增条目且 scrollY 从 0 开始', () => {
    const lengthBefore = history.length;
    pushEntry('/reports');
    expect(location.pathname).toBe('/reports');
    expect(history.length).toBe(lengthBefore + 1);
    expect(history.state?.kbScrollY).toBe(0);
  });

  it('replaceEntry：不新增条目，scrollY 归零', () => {
    setScrollY(400);
    saveScrollToCurrentEntry();
    const lengthBefore = history.length;
    replaceEntry('/reports');
    expect(history.length).toBe(lengthBefore);
    expect(location.pathname).toBe('/reports');
    expect(history.state?.kbScrollY).toBe(0);
  });

  it('replaceEntryKeepScroll：只改地址栏，保留当前 scrollY（短名纠正 / 保存后去 ?new=1）', () => {
    setScrollY(77);
    replaceEntryKeepScroll('/d/real-path/');
    expect(location.pathname).toBe('/d/real-path/');
    expect(history.state?.kbScrollY).toBe(77);
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

  it('空 hash / 只有 # / 找不到锚点返回 false（调用方回顶部）', () => {
    expect(scrollToHash('')).toBe(false);
    expect(scrollToHash('#')).toBe(false);
    expect(scrollToHash('#missing')).toBe(false);
    expect(scrollToHash('#%E0%A4%A')).toBe(false); // 非法编码也应降级而不是抛异常
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
