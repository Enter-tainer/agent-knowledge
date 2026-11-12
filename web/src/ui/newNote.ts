import { api } from '../api';
import { NotFoundError, humanizeError } from '../api/errors';
import { editUrl, navigate } from '../router';
import { el } from './dom';

/** 新建笔记的路径输入弹层：先查重，再进编辑页（编辑页用 If-Match: * 新建）。 */
export function openNewNoteDialog(): void {
  const input = el('input', {
    type: 'text',
    class: 'field-input',
    value: defaultPath(),
    placeholder: '例如：示例库/我的新笔记',
    'aria-label': '新笔记路径',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;

  const error = el('p', { class: 'field-error', hidden: 'true' });
  const submitBtn = el('button', {
    type: 'submit',
    class: 'btn btn-primary',
    text: '创建',
  }) as HTMLButtonElement;

  const form = el(
    'form',
    {
      class: 'new-note-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void submit();
      },
    },
    el('label', { class: 'field-label' }, el('span', { text: '笔记路径' }), input),
    el('p', {
      class: 'field-hint',
      text: '可以带目录，例如「示例库/我的笔记」。路径不要带 .md；已存在的路径会提示换一个。',
    }),
    error,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: () => close() }), submitBtn),
  );

  let settled = false;
  const overlay = el('div', { class: 'modal-overlay', role: 'presentation' }, el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'new-note-title' },
    el('h2', { class: 'modal-title', id: 'new-note-title', text: '新建笔记' }),
    form,
  ));

  function close(): void {
    if (settled) return;
    settled = true;
    overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  function showError(message: string): void {
    error.textContent = message;
    error.hidden = false;
    input.focus();
  }

  async function submit(): Promise<void> {
    const path = normalizePath(input.value);
    if (!path) {
      showError('请输入一个路径，例如「示例库/我的笔记」。');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '检查中…';
    try {
      let exists = true;
      try {
        await api.getDoc(path);
      } catch (err) {
        if (err instanceof NotFoundError) exists = false;
        else throw err;
      }
      if (exists) {
        showError('这个路径已经有笔记了，换一个名字或路径吧。');
        return;
      }
      close();
      await navigate(editUrl(path, true));
    } catch (err) {
      showError(humanizeError(err));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '创建';
    }
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown, true);
  document.body.appendChild(overlay);
  window.setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function defaultPath(): string {
  const now = new Date();
  return `未命名-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** 规整用户输入的路径：去首尾斜杠与 .md、折叠重复斜杠、拒绝 .. 段。 */
function normalizePath(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!cleaned) return '';
  const parts = cleaned.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  return cleaned;
}
