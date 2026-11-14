/**
 * 移动端目录抽屉（通用弹层）。
 *
 * 从 `pages/home.ts` 里抽出来，让「文章页 / 搜索 / 报告」也能用同一个目录入口。
 * 约束（验收 B5）：role=dialog + aria-modal、Esc / 遮罩 / 站内导航都关闭、
 * 关闭后恢复焦点、`no-scroll` 不残留、Tab 焦点陷阱。
 */

import { el } from './dom';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DrawerUiOptions {
  title: string;
  /** 标题右侧的计数，如「36 篇」。 */
  count?: string;
  body: HTMLElement;
  /** 打开抽屉的触发元素：关闭时把焦点还给它。 */
  trigger?: HTMLElement | null;
}

export interface DrawerController {
  readonly element: HTMLElement;
  close(): void;
}

let active: DrawerController | null = null;

/** 打开一个抽屉；同一时间只保留一个。 */
export function openDrawerUi(options: DrawerUiOptions): DrawerController {
  active?.close();

  const previousFocus =
    options.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  let closed = false;

  const closeBtn = el('button', {
    type: 'button',
    class: 'btn btn-ghost',
    text: '关闭',
    'aria-label': '关闭目录',
    onclick: () => close(),
  });

  const panel = el(
    'div',
    { class: 'tree-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
    el(
      'div',
      { class: 'tree-drawer-head' },
      el(
        'div',
        { class: 'tree-drawer-title' },
        el('span', { text: options.title }),
        options.count ? el('span', { class: 'muted', text: options.count }) : null,
      ),
      closeBtn,
    ),
    el('div', { class: 'tree-drawer-body' }, options.body),
  );
  const overlay = el('div', { class: 'tree-drawer-overlay', role: 'presentation' }, panel);

  function trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (node) => node.offsetParent !== null,
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    trapTab(event);
  }

  function onNavigate(): void {
    close();
  }

  /**
   * 浏览器前进/后退（真机安卓的返回手势就是这个）也要关抽屉。
   *
   * 不能靠 `kb:navigate`：那个事件只在 `navigate()` 里派发，popstate 走的是另一条路径。
   * 不关的话，抽屉会盖在已经渲染好的新页面上、当前项还高亮着刚离开的那篇，
   * 而且 `no-scroll` 还挂着 —— 整页滚不动，用户会以为返回没生效。
   */
  function onPopState(): void {
    close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('kb:navigate', onNavigate);
    window.removeEventListener('popstate', onPopState);
    document.documentElement.classList.remove('no-scroll');
    overlay.remove();
    if (active === controller) active = null;
    previousFocus?.focus?.();
  }

  // 点笔记/目录链接后立即收起（导航交给 router，不阻止默认行为）
  panel.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('a[href]')) close();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('kb:navigate', onNavigate);
  window.addEventListener('popstate', onPopState);
  document.addEventListener('keydown', onKeydown, true);

  document.documentElement.classList.add('no-scroll');
  document.body.appendChild(overlay);
  closeBtn.focus();

  const controller: DrawerController = { element: overlay, close };
  active = controller;
  return controller;
}

/** 关闭当前抽屉（没有则无副作用）。 */
export function closeDrawer(): void {
  active?.close();
}

/** 是否有抽屉打开（测试/调试用）。 */
export function isDrawerOpen(): boolean {
  return active !== null;
}
