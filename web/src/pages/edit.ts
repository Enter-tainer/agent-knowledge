import { api } from '../api';
import {
  ConflictError,
  NotFoundError,
  PreconditionRequiredError,
  humanizeError,
} from '../api/errors';
import type { Doc, UpdateResult } from '../api/types';
import { renderMarkdown } from '../markdown';
import { clearLeaveGuard, setLeaveGuard, type LeaveGuard } from '../navGuard';
import { docUrl, editUrl, navigate, replaceUrl } from '../router';
import { invalidateTree } from '../store';
import { el, shortHash } from '../ui/dom';
import { onPageTeardown } from '../ui/lifecycle';
import {
  choiceDialog,
  confirmDialog,
  apiErrorState,
  shell,
  toast,
} from '../ui/shell';
import { loadDoc } from './data';

/**
 * `/edit/<path>`：左源码 + 右实时预览（手机上换成「源码 / 预览」Tab）。
 *
 * 保存语义：已存在文档带当前 `If-Match: <hash>`；新建（`?new=1`）用 `If-Match: *`。
 * 有未保存改动时，所有站内跳转（返回阅读/取消/浏览器 back/顶栏链接）都会先弹确认。
 */
export async function renderEdit(inputPath: string, isNew = false): Promise<HTMLElement> {
  let doc: Doc | null = null;
  if (!isNew) {
    try {
      doc = await loadDoc(inputPath);
    } catch (err) {
      if (err instanceof NotFoundError) {
        // 直接输地址进来但文档不存在：引导新建或回目录
        return editMissingPage(inputPath);
      }
      return shell({
        active: 'edit',
        content: apiErrorState(err, '这篇笔记加载失败', () => window.dispatchEvent(new Event('kb:navigate'))),
      });
    }
    if (doc.path !== inputPath) replaceUrl(editUrl(doc.path));
  }

  const path = doc?.path ?? inputPath;
  let modeNew = isNew && !doc;
  let currentHash = doc?.hash ?? '*';
  let currentRevision = doc?.revision ?? 0;
  let dirty = false;
  let saving = false;
  let debounceTimer: number | undefined;

  const stem = path.split('/').pop() ?? path;
  const title = doc?.title || stem;
  document.title = `${modeNew ? '新建' : '编辑'}：${title} · 私有知识库`;

  const textarea = el('textarea', {
    class: 'edit-textarea',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Markdown 源文本',
  }) as HTMLTextAreaElement;
  textarea.value = doc?.raw ?? `# ${stem}\n\n`;

  const preview = el('div', { class: 'edit-preview markdown-body' });
  const status = el('span', { class: 'edit-status', role: 'status' });
  const metaBox = el('div', { class: 'edit-meta' });

  const saveBtn = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: '保存',
    title: '保存（Ctrl/Cmd+S）',
    onclick: () => void save(),
  }) as HTMLButtonElement;

  const bottomSaveBtn = el('button', {
    type: 'button',
    class: 'btn btn-primary btn-block',
    text: '保存',
    onclick: () => void save(),
  }) as HTMLButtonElement;

  const titleEl = el('h1', { class: 'edit-title', text: `${modeNew ? '新建' : '编辑'}：${title}` });
  const subtitleEl = el('div', { class: 'edit-sub muted', text: path });

  const panes = el('div', { class: 'edit-panes', 'data-pane': 'source' }, textarea, preview);

  const tabSource = el('button', {
    type: 'button',
    class: 'edit-tab edit-tab-active',
    text: '源码',
    onclick: () => setPane('source'),
  });
  const tabPreview = el('button', {
    type: 'button',
    class: 'edit-tab',
    text: '预览',
    onclick: () => setPane('preview'),
  });

  const isDesktop = !window.matchMedia('(max-width: 860px)').matches;

  const page = el(
    'main',
    { class: 'edit-page' },
    el(
      'header',
      { class: 'edit-head' },
      el(
        'div',
        { class: 'edit-head-row' },
        el('a', { class: 'back-link', href: docUrl(path), text: '← 返回阅读' }),
        el(
          'div',
          { class: 'edit-title-wrap' },
          titleEl,
          subtitleEl,
        ),
        el('div', { class: 'edit-actions' }, status, saveBtn),
      ),
      el(
        'details',
        { class: 'edit-more' },
        el('summary', { class: 'edit-more-summary', text: '详情' }),
        metaBox,
      ),
      el('div', { class: 'edit-tabs' }, tabSource, tabPreview),
    ),
    panes,
    el(
      'div',
      { class: 'edit-bottom-bar' },
      el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: '取消',
        onclick: () => void navigate(docUrl(path)),
      }),
      bottomSaveBtn,
    ),
  );

  /* ------------------------------ UI 状态 ------------------------------ */

  function setStatus(text: string, kind: 'idle' | 'dirty' | 'ok' | 'warn' | 'error' = 'idle'): void {
    status.textContent = text;
    status.className = `edit-status${kind === 'idle' ? '' : ` edit-status-${kind}`}`;
  }

  function setPane(pane: 'source' | 'preview'): void {
    panes.dataset.pane = pane;
    tabSource.classList.toggle('edit-tab-active', pane === 'source');
    tabPreview.classList.toggle('edit-tab-active', pane === 'preview');
    if (pane === 'source') textarea.focus();
  }

  function refreshMeta(): void {
    metaBox.replaceChildren(
      el('span', { class: 'muted', text: path }),
      el('span', { class: 'dot' }),
      el('span', { text: modeNew ? '新建（还没保存过）' : `版本 ${shortHash(currentHash)}` }),
      el('span', { class: 'dot' }),
      el('span', { text: modeNew ? '保存后才会出现在目录里' : `第 ${currentRevision} 次保存` }),
      el('span', { class: 'dot' }),
      el('span', {
        class: 'muted',
        text: isDesktop ? 'Ctrl/Cmd+S 保存' : '点下方「保存」按钮',
      }),
    );
  }

  function renderPreview(): void {
    preview.innerHTML = renderMarkdown(textarea.value);
  }

  function schedulePreview(): void {
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      renderPreview();
    }, 120);
  }

  textarea.addEventListener('input', () => {
    dirty = true;
    setStatus('● 未保存', 'dirty');
    schedulePreview();
  });

  function loadIntoEditor(fresh: Doc): void {
    currentHash = fresh.hash;
    currentRevision = fresh.revision;
    modeNew = false;
    textarea.value = fresh.raw;
    dirty = false;
    replaceUrl(editUrl(fresh.path));
    renderPreview();
    refreshMeta();
    setStatus('✓ 已重新加载最新版本', 'ok');
  }

  function applySaved(result: UpdateResult, created: boolean): void {
    currentHash = result.hash;
    currentRevision = result.revision;
    dirty = false;
    invalidateTree();
    if (modeNew) {
      modeNew = false;
      replaceUrl(editUrl(path));
      // 新建成功后立刻把标题从「新建：…」切成「编辑：…」，不用等刷新
      titleEl.textContent = `编辑：${stem}`;
      document.title = `编辑：${stem} · 私有知识库`;
      subtitleEl.textContent = path;
    }
    refreshMeta();
    setStatus(created ? '✓ 已创建 · 刚刚' : '✓ 已保存 · 刚刚', 'ok');
    toast(created ? '笔记已创建' : '已保存');
  }

  function failSave(err: unknown): void {
    const message = humanizeError(err);
    setStatus(`保存失败：${message}`, 'error');
    toast(`保存失败：${message}`, 'error');
  }

  async function reloadFromServer(): Promise<boolean> {
    try {
      setStatus('正在加载最新版本…');
      const fresh = await api.getDoc(path);
      loadIntoEditor(fresh);
      return true;
    } catch (err) {
      setStatus(`加载失败：${humanizeError(err)}`, 'error');
      return false;
    }
  }

  /** 412/428：人话 + 推荐「重新加载」；覆盖要二次确认。 */
  async function openConflictDialog(): Promise<void> {
    setStatus('这篇笔记在别处被改过', 'warn');
    const choice = await choiceDialog({
      title: '这篇笔记在别处被改过',
      body:
        '你打开之后，它在别的标签页或别的设备上被保存过。你现在的修改还在，没有丢。\n\n' +
        '推荐先「重新加载」：载入最新版本，再把你需要的改动补回去（更安全）。\n' +
        '「用我的版本覆盖」会用你当前的内容替换服务器上的最新版本，对方的修改会丢失。',
      actions: [
        { label: '重新加载（推荐）', value: 'reload', kind: 'primary' },
        { label: '用我的版本覆盖', value: 'overwrite', kind: 'ghost' },
        { label: '继续编辑', value: 'cancel', kind: 'ghost' },
      ],
    });
    if (choice === 'reload') {
      await reloadFromServer();
      return;
    }
    if (choice === 'overwrite') {
      const confirmed = await confirmDialog({
        title: '确定覆盖服务器上的版本？',
        body: '对方刚才的修改会永久丢失，无法撤销。',
        confirmLabel: '确定覆盖',
        danger: true,
      });
      if (confirmed) await forceOverwrite();
    }
  }

  /** 新建时路径被占用（428/412）：引导打开已有的那篇。 */
  async function openPathTakenDialog(): Promise<void> {
    setStatus('这个路径已经有笔记了', 'warn');
    const choice = await choiceDialog({
      title: '这个路径已经有笔记了',
      body: `创建时发现「${path}」已经存在（可能是别人刚建的）。你可以直接打开现有的那篇继续编辑。`,
      actions: [
        { label: '打开现有的', value: 'open', kind: 'primary' },
        { label: '继续编辑（换个路径再试）', value: 'cancel', kind: 'ghost' },
      ],
    });
    if (choice !== 'open') return;
    try {
      const fresh = await api.getDoc(path);
      loadIntoEditor(fresh);
      toast('已打开现有的笔记');
    } catch (err) {
      failSave(err);
    }
  }

  function setBusy(busy: boolean): void {
    saving = busy;
    saveBtn.disabled = busy;
    bottomSaveBtn.disabled = busy;
  }

  /** 返回 true 表示保存成功（离开守卫用它决定是否放行）。 */
  async function save(): Promise<boolean> {
    if (saving) return false;
    setBusy(true);
    setStatus(modeNew ? '正在创建…' : '正在保存…');
    try {
      const created = modeNew;
      const result = await api.putDoc(path, textarea.value, created ? '*' : currentHash);
      applySaved(result, created);
      return true;
    } catch (err) {
      // 冲突要让用户选，先把 busy 放开，否则「覆盖」分支会被 saving 拦掉
      if (modeNew && (err instanceof ConflictError || err instanceof PreconditionRequiredError)) {
        setBusy(false);
        await openPathTakenDialog();
        return false;
      }
      if (err instanceof ConflictError || err instanceof PreconditionRequiredError) {
        setBusy(false);
        await openConflictDialog();
        return false;
      }
      failSave(err);
      return false;
    } finally {
      if (saving) setBusy(false);
    }
  }

  /** 强制覆盖：严格语义下先取最新 hash，再用该 hash 写入。 */
  async function forceOverwrite(): Promise<void> {
    if (saving) return;
    setBusy(true);
    setStatus('正在覆盖…');
    try {
      if (modeNew) {
        await api.putDoc(path, textarea.value, '*');
        const fresh = await api.getDoc(path);
        applySaved({ path, hash: fresh.hash, revision: fresh.revision }, true);
        return;
      }
      const fresh = await api.getDoc(path);
      currentHash = fresh.hash;
      const result = await api.putDoc(path, textarea.value, fresh.hash);
      applySaved(result, false);
    } catch (err) {
      failSave(err);
    } finally {
      if (saving) setBusy(false);
    }
  }

  /* ------------------------- 离开守卫 / 键盘 ------------------------- */

  const guard: LeaveGuard = {
    isDirty: () => dirty,
    confirmLeave: async () => {
      const choice = await choiceDialog({
        title: '有未保存的修改',
        body: '离开这一页会丢掉你刚才的修改。可以先「保存并离开」，或者继续编辑。',
        actions: [
          { label: '保存并离开', value: 'save', kind: 'primary' },
          { label: '放弃修改', value: 'discard', kind: 'danger' },
          { label: '继续编辑', value: 'cancel', kind: 'ghost' },
        ],
      });
      if (choice === 'save') return save();
      if (choice === 'discard') return true;
      return false;
    },
    clearDirty: () => {
      dirty = false;
    },
  };
  setLeaveGuard(guard);

  function onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Escape') {
      // 弹层自己处理 Esc 时会 stopPropagation，这里只处理「没有弹层」的情况
      const hasModal = document.querySelector('.modal-overlay') !== null;
      if (!hasModal) {
        event.preventDefault();
        void navigate(docUrl(path));
      }
    }
  }

  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  }

  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);

  // 用实测的顶栏高度算编辑区高度：手机顶栏是两行，写死 var(--topbar-h) 会溢出
  function layoutHeight(): void {
    const topbar = document.querySelector<HTMLElement>('.topbar');
    const topbarH = topbar?.getBoundingClientRect().height ?? 56;
    const height = Math.max(420, window.innerHeight - topbarH);
    page.style.setProperty('--edit-h', `${height}px`);
  }
  window.addEventListener('resize', layoutHeight);
  window.setTimeout(layoutHeight, 0);

  onPageTeardown(() => {
    clearLeaveGuard(guard);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('resize', layoutHeight);
    if (debounceTimer) window.clearTimeout(debounceTimer);
  });

  renderPreview();
  refreshMeta();
  setStatus(modeNew ? '新笔记：写点内容再保存' : '✓ 已加载', modeNew ? 'idle' : 'ok');

  return shell({ active: 'edit', wide: true, content: page });
}

/** 直接访问不存在的 /edit/<path>：给「新建这篇」与「回目录」，不显示后端英文。 */
function editMissingPage(inputPath: string): HTMLElement {
  const stem = inputPath.split('/').pop() ?? inputPath;
  return shell({
    active: 'edit',
    content: el(
      'main',
      { class: 'doc-page' },
      el('div', { class: 'doc-toolbar' }, el('a', { class: 'back-link', href: '/', text: '← 目录' })),
      el(
        'div',
        { class: 'notfound' },
        el('h1', { class: 'doc-title', text: '没有这篇笔记' }),
        el('p', {
          class: 'notfound-text',
          text: `「${stem}」还没有被创建。可以新建一篇，或者回目录找找有没有名字相近的笔记。`,
        }),
        el(
          'div',
          { class: 'notfound-actions' },
          el('a', { class: 'btn btn-primary', href: editUrl(inputPath, true), text: '新建这篇笔记' }),
          el('a', { class: 'btn btn-ghost', href: '/', text: '回目录' }),
        ),
      ),
    ),
  });
}
