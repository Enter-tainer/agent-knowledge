/**
 * agent-browser `--init-script` 注入的页面侧观测器。
 *
 * 在**新文档的最早时机**安装（早于应用脚本），因此能记录到首屏与每次导航：
 *  - console.error / window error / unhandledrejection（C4）
 *  - `.app-shell` / `.topbar` / `aside.sidebar` 的移除（A2）
 *  - 整页 spinner 的出现次数（.state-loading 出现在 .page-content 之外，A2）
 *  - `.page-content[aria-busy]` 的 true/false 次数（A4）
 *  - 导航进行中 `.page-content` 为空的采样次数（A4）
 *
 * 只读：不修改 DOM、不覆盖应用逻辑（console.error 只做透传记录）。
 * 结果挂在 `window.__e2e`，由 web/e2e/nav-check.mjs 读取。
 */
(() => {
  if (window.__e2e) return;

  const state = {
    consoleErrors: [],
    pageErrors: [],
    rejections: [],
    bootLoadingAdded: 0,
    shellRemovals: [],
    busyTrue: 0,
    busyFalse: 0,
    emptyContentSamples: 0,
    contentReplacements: 0,
  };
  window.__e2e = state;
  window.__e2eNavActive = false;

  const describe = (value) => {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const originalError = console.error;
  console.error = function patchedConsoleError(...args) {
    try {
      state.consoleErrors.push(args.map(describe).join(' '));
    } catch {
      /* 记录失败不能影响应用 */
    }
    return originalError.apply(this, args);
  };

  window.addEventListener('error', (event) => {
    try {
      state.pageErrors.push(String((event && (event.message || event.error)) || 'unknown error'));
    } catch {
      /* ignore */
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event && event.reason;
      state.rejections.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : describe(reason));
    } catch {
      /* ignore */
    }
  });

  const isEl = (node) => typeof Element !== 'undefined' && node instanceof Element;

  const recordRemoved = (node) => {
    if (!isEl(node)) return;
    for (const selector of ['.app-shell', '.topbar', 'aside.sidebar', '.page-content']) {
      if (node.matches(selector)) {
        state.shellRemovals.push(selector);
      } else if (typeof node.querySelector === 'function' && node.querySelector(selector)) {
        state.shellRemovals.push(`${selector} (subtree)`);
      }
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.removedNodes) recordRemoved(node);
        for (const node of record.addedNodes) {
          if (!isEl(node)) continue;
          // 「整页 spinner」的真实判据（旧版只看 `.boot-loading`，而应用代码里
          // 根本没有这个类名，所以计数恒为 0 —— 假绿）：
          //  1) 根容器 `.app-shell` 被直接塞进一个加载态（说明走了整页加载分支）；
          //  2) 加载态出现在 `.page-content` 之外（说明不是局部内容加载）。
          if (node.matches('.state-loading, .boot-loading')) {
            if (node.parentElement === document.getElementById('app')) state.bootLoadingAdded += 1;
            else if (!node.closest('.page-content')) state.bootLoadingAdded += 1;
          }
        }
        if (isEl(record.target) && record.target.classList.contains('page-content')) {
          state.contentReplacements += 1;
        }
      } else if (record.type === 'attributes' && record.attributeName === 'aria-busy') {
        const target = record.target;
        if (isEl(target) && target.classList.contains('page-content')) {
          if (target.getAttribute('aria-busy') === 'true') state.busyTrue += 1;
          else state.busyFalse += 1;
        }
      }
    }
    if (window.__e2eNavActive) {
      const content = document.querySelector('.page-content');
      if (content && content.childElementCount === 0) state.emptyContentSamples += 1;
    }
  });

  try {
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-busy'],
    });
  } catch {
    /* 极端环境（document 未就绪）忽略：断言会以「无数据」暴露 */
  }
})();
