import { api, IS_MOCK } from '../api';
import { humanizeError } from '../api/errors';
import { clearLeaveGuardDirty, confirmLeave, hasDirtyGuard } from '../navGuard';
import { navigate } from '../router';
import { loadTree } from '../store';
import { el } from './dom';
import { openNewNoteDialog } from './newNote';

export type ActiveNav = 'home' | 'reports' | 'doc' | 'search' | 'edit';

export interface ShellOptions {
  active: ActiveNav;
  searchQuery?: string;
  content: HTMLElement;
  /** 内容区是否放宽（编辑器用） */
  wide?: boolean;
}

/** 顶部栏 + 内容区；所有页面都套这一层。 */
export function shell(opts: ShellOptions): HTMLElement {
  const searchInput = el('input', {
    type: 'search',
    name: 'q',
    class: 'search-input',
    placeholder: '搜索笔记（至少 2 个字）',
    'aria-label': '搜索知识库',
    value: opts.searchQuery ?? '',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const form = el(
    'form',
    {
      class: 'search-form',
      role: 'search',
      onsubmit: (event: Event) => {
        event.preventDefault();
        const q = searchInput.value.trim();
        if (q) void navigate(`/search?q=${encodeURIComponent(q)}`);
      },
    },
    searchInput,
    el('button', { type: 'submit', class: 'btn btn-search', text: '搜索' }),
  );

  const newBtn = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: '＋ 新建',
    title: '写一篇新笔记',
    onclick: () => void startNewNote(),
  });

  const exportBtn = el('button', {
    type: 'button',
    class: 'btn btn-ghost',
    text: '导出',
    title: '把全库笔记导出成 zip',
    onclick: () => void exportAll(exportBtn),
  });

  const topbar = el(
    'header',
    { class: 'topbar' },
    el(
      'a',
      { class: 'brand', href: '/', 'aria-label': '回到首页' },
      el('span', { class: 'brand-dot' }),
      el('span', { class: 'brand-text', text: '私有知识库' }),
    ),
    IS_MOCK ? el('span', { class: 'badge-mock', title: '本地 mock 数据（未接后端）', text: 'MOCK' }) : null,
    form,
    el(
      'nav',
      { class: 'nav' },
      el('a', { href: '/', class: navClass(opts.active === 'home'), text: '目录' }),
      el('a', { href: '/reports', class: navClass(opts.active === 'reports'), text: '报告' }),
      newBtn,
      exportBtn,
    ),
  );

  return el('div', { class: `app-shell${opts.wide ? ' app-shell-wide' : ''}` }, topbar, opts.content);
}

async function startNewNote(): Promise<void> {
  // 编辑页有未保存改动时，先问「保存 / 放弃 / 取消」，用户确认后再开新建路径弹层
  if (hasDirtyGuard()) {
    const leave = await confirmLeave();
    if (!leave) return;
    clearLeaveGuardDirty();
  }
  openNewNoteDialog();
}
function navClass(active: boolean): string {
  return active ? 'nav-link nav-link-active' : 'nav-link';
}

function fileName(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `knowledge-export-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.zip`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function exportAll(button: HTMLButtonElement): Promise<void> {
  const original = button.textContent ?? '导出';
  button.disabled = true;
  button.textContent = '导出中…';
  try {
    const [blob, tree] = await Promise.all([
      api.exportZip(),
      loadTree().catch(() => []),
    ]);
    downloadBlob(blob, fileName());
    const count = tree.length ? ` ${tree.length} 篇 ·` : '';
    toast(IS_MOCK ? '已下载（mock 占位文件，不是真 zip）' : `已导出${count}${formatSize(blob.size)}，在浏览器的「下载」里查看`);
  } catch (err) {
    toast(`导出失败：${humanizeError(err)}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

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
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
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
    retry
      ? el('button', { type: 'button', class: 'btn btn-primary', text: '重试', onclick: retry })
      : null,
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
