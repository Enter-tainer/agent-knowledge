/**
 * 覆盖层与状态块：toast / choiceDialog / confirmDialog / 加载与错误占位。
 *
 * 顶栏与布局已移到 `ui/layout.ts`，这里不再构造整个页面 shell，
 * 只提供页面内部会复用的交互零件（弹层、提示、空/错状态）。
 */

import { humanizeError } from '../api/errors';
import { el } from './dom';

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer: number | undefined;
let toastNode: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  if (!toastNode) {
    toastNode = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastNode);
  }
  toastNode.className = `toast toast-${kind}`;
  toastNode.textContent = message;
  toastNode.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (toastNode) toastNode.hidden = true;
  }, 4000);
}

/* ------------------------------------------------------------------ */
/* 弹层：choiceDialog（带焦点陷阱与 Esc）                                */
/* ------------------------------------------------------------------ */

export interface ChoiceAction {
  label: string;
  value: string;
  kind?: 'primary' | 'danger' | 'ghost';
}

export interface ChoiceOptions {
  title: string;
  body: string | HTMLElement;
  actions: ChoiceAction[];
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusables = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
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

/**
 * 通用确认弹层，返回被点按钮的 value；要点遮罩/Esc 关闭返回 null。
 * 打开后焦点进入弹层，Tab 在弹层内循环（键盘用户不会丢焦点）。
 */
export function choiceDialog(opts: ChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve(value);
    };

    function onKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
        return;
      }
      trapTab(event, dialog);
    }

    const body = el('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') body.textContent = opts.body;
    else body.appendChild(opts.body);

    const actions = el('div', { class: 'modal-actions' });
    for (const action of opts.actions) {
      actions.appendChild(
        el('button', {
          type: 'button',
          class: `btn btn-${action.kind ?? 'ghost'}`,
          text: action.label,
          onclick: () => finish(action.value),
        }),
      );
    }

    const dialog = el(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
      el('h2', { class: 'modal-title', id: 'modal-title', text: opts.title }),
      body,
      actions,
    );

    const overlay = el('div', { class: 'modal-overlay', role: 'presentation' }, dialog);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(null);
    });

    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
    window.setTimeout(() => {
      const preferred =
        actions.querySelector<HTMLElement>('.btn-primary') ??
        actions.querySelector<HTMLElement>('.btn') ??
        dialog;
      preferred.focus();
    }, 0);
  });
}

/** 兼容旧用法的简单弹层（只有「知道了」）。 */
export function showModal(options: { title: string; body: string | HTMLElement }): void {
  void choiceDialog({
    title: options.title,
    body: options.body,
    actions: [{ label: '知道了', value: 'ok', kind: 'primary' }],
  });
}

/** 二次确认：返回 true 表示用户确认。 */
export async function confirmDialog(options: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  const choice = await choiceDialog({
    title: options.title,
    body: options.body,
    actions: [
      { label: '取消', value: 'cancel', kind: 'ghost' },
      {
        label: options.confirmLabel,
        value: 'confirm',
        kind: options.danger ? 'danger' : 'primary',
      },
    ],
  });
  return choice === 'confirm';
}

/* ------------------------------------------------------------------ */
/* 状态块                                                              */
/* ------------------------------------------------------------------ */

export function loadingState(text = '加载中…'): HTMLElement {
  return el('div', { class: 'state state-loading' }, el('span', { class: 'spinner' }), el('p', { text }));
}

/**
 * 错误态的统一入口：401 一定是 Cloudflare Access 没放行（Worker 不鉴权），
 * 其他错误用人话文案（不暴露英文后端原文），500 会带上 requestId。
 */
export function apiErrorState(err: unknown, fallbackTitle: string, retry?: () => void): HTMLElement {
  return errorState(fallbackTitle, humanizeError(err), retry);
}

export function errorState(title: string, detail?: string, retry?: () => void): HTMLElement {
  return el(
    'div',
    { class: 'state state-error' },
    el('h2', { text: title }),
    detail ? el('p', { class: 'state-detail', text: detail }) : null,
    retry ? el('button', { type: 'button', class: 'btn btn-primary', text: '重试', onclick: retry }) : null,
  );
}

export function emptyState(text: string, actions?: HTMLElement[]): HTMLElement {
  return el(
    'div',
    { class: 'state state-empty' },
    el('p', { text }),
    actions && actions.length ? el('div', { class: 'state-actions' }, ...actions) : null,
  );
}
