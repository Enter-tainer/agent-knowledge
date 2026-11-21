import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ArrowLeft,
  Bold,
  Check,
  Code,
  Columns2,
  Eye,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Info,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  MessageSquareQuote,
  PenLine,
  Plus,
  Quote,
  Save,
  Search,
  Sigma,
  Table,
  Tag,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import {
  ConflictError,
  NotFoundError,
  PreconditionRequiredError,
  humanizeError,
} from '../api/errors';
import type { Doc, TreeEntry, UpdateResult } from '../api/types';
import { renderMarkdown } from '../markdown';
import { clearLeaveGuard, setLeaveGuard, type LeaveGuard } from '../navGuard';
import { currentRouteUrl, docUrl, editUrl, navigate, replaceUrl } from '../router';
import { invalidateTree, loadTree } from '../store';
import { openCommandPalette } from '../ui/commandPalette';
import { shortHash } from '../ui/dom';
import { layout } from '../ui/layout';
import { consumeNewNoteTemplate } from '../ui/newNote';
import { createReactPageView } from '../ui/react-view';
import { apiErrorState, choiceDialog, confirmDialog, toast } from '../ui/shell';
import type { PageView } from '../ui/view';
import { loadDoc } from './data';

type ViewMode = 'split' | 'source' | 'preview';
type StatusKind = 'idle' | 'dirty' | 'ok' | 'warn' | 'error';

interface CaretCoords {
  top?: number;
  bottom?: number;
  left: number;
}

const MIRROR_PROPS = [
  'boxSizing',
  'width',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderLeftWidth',
  'tabSize',
] as const;

function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number): CaretCoords {
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(textarea);
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  for (const prop of MIRROR_PROPS) {
    mirror.style[prop] = style[prop];
  }
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(position, position + 1) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const lineTop = marker.offsetTop - textarea.scrollTop;
  const downTop = lineTop + 26;
  const left = marker.offsetLeft - textarea.scrollLeft;
  mirror.remove();

  const clampedLeft = Math.max(12, Math.min(left, Math.max(12, textarea.clientWidth - 320)));
  const popupMaxH = 260;
  if (downTop + popupMaxH > textarea.clientHeight && lineTop > 120) {
    return {
      bottom: Math.max(12, textarea.clientHeight - lineTop + 6),
      left: clampedLeft,
    };
  }
  return {
    top: Math.max(24, Math.min(downTop, Math.max(24, textarea.clientHeight - popupMaxH))),
    left: clampedLeft,
  };
}

function parseYamlTags(raw: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return [];
  const yaml = m[1] ?? '';
  const inline = /^tags:\s*\[(.*)\]\s*$/m.exec(yaml);
  if (inline) {
    return inline[1]!
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  const block = /^tags:\s*\r?\n((?:[ \t]+-.*(?:\r?\n|$))*)/m.exec(yaml);
  if (!block) return [];
  const tags: string[] = [];
  for (const line of block[1]!.split(/\r?\n/)) {
    const item = /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(line);
    if (item) {
      const cleaned = item[1]!.replace(/^["']|["']$/g, '').trim();
      if (cleaned) tags.push(cleaned);
    }
  }
  return tags;
}

function updateYamlTags(raw: string, nextTags: string[], fallbackTitle: string): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const tagsBlock =
    nextTags.length === 0
      ? 'tags: []'
      : `tags:${eol}${nextTags.map((t) => `  - ${t}`).join(eol)}`;

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---([ \t]*(?:\r?\n|$))/.exec(raw);
  if (!fmMatch) {
    return `---${eol}title: "${fallbackTitle}"${eol}${tagsBlock}${eol}---${eol}${eol}${raw}`;
  }

  let yaml = fmMatch[1] ?? '';
  if (/^tags:\s*\[.*\]\s*$/m.test(yaml)) {
    yaml = yaml.replace(/^tags:\s*\[.*\]\s*$/m, tagsBlock);
  } else if (/^tags:\s*(?:\r?\n(?:[ \t]+-.*(?:\r?\n|$))*)?/m.test(yaml)) {
    yaml = yaml.replace(/^tags:\s*(?:\r?\n(?:[ \t]+-.*(?:\r?\n|$))*)?/m, `${tagsBlock}${eol}`).replace(/\n+$/, '');
  } else {
    yaml = `${yaml.replace(/\r?\n+$/, '')}${eol}${tagsBlock}`;
  }

  return `---${eol}${yaml}${eol}---${fmMatch[2]}${raw.slice(fmMatch[0].length)}`;
}

interface ToolbarBtnProps {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}

function ToolbarBtn({ label, shortcut, onClick, children }: ToolbarBtnProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="edit-tool-btn"
          aria-label={label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="bottom" sideOffset={6}>
          <span>{label}</span>
          {shortcut ? <kbd className="tooltip-kbd">{shortcut}</kbd> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

interface EditPageProps {
  initialDoc: Doc | null;
  initialPath: string;
  initialIsNew: boolean;
  initialContent: string;
}

function EditPageComponent({ initialDoc, initialPath, initialIsNew, initialContent }: EditPageProps) {
  const stem = initialPath.split('/').pop() ?? initialPath;
  const [docMeta, setDocMeta] = useState({
    path: initialDoc?.path ?? initialPath,
    hash: initialDoc?.hash ?? '*',
    revision: initialDoc?.revision ?? 0,
    isNew: initialIsNew && !initialDoc,
    title: initialDoc?.title || stem,
  });

  const [value, setValue] = useState(initialContent);
  const [previewSrc, setPreviewSrc] = useState(initialContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; kind: StatusKind }>({
    text: initialIsNew && !initialDoc ? '新笔记：写点内容再保存' : '✓ 已加载',
    kind: initialIsNew && !initialDoc ? 'idle' : 'ok',
  });
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [mobilePane, setMobilePane] = useState<'source' | 'preview'>('source');

  // 标签快速输入
  const [newTagText, setNewTagText] = useState('');
  const [addingTag, setAddingTag] = useState(false);

  // [[ 双链自动补全
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [wikiMenu, setWikiMenu] = useState<{
    open: boolean;
    query: string;
    startPos: number;
    endPos: number;
    coords: CaretCoords;
    selectedIndex: number;
  }>({
    open: false,
    query: '',
    startPos: 0,
    endPos: 0,
    coords: { top: 40, left: 24 },
    selectedIndex: 0,
  });

  const pageRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const scrollLockRef = useRef<'source' | 'preview' | null>(null);
  const scrollTimerRef = useRef<number | undefined>(undefined);

  // 使用 refs 让键盘快捷键和离开守卫始终读到最新状态
  const stateRef = useRef({ dirty, saving, value, docMeta });
  stateRef.current = { dirty, saving, value, docMeta };

  useEffect(() => {
    void loadTree()
      .then(setTreeEntries)
      .catch(() => undefined);
  }, []);

  // 120ms 防抖刷新预览
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewSrc(value);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [value]);

  const previewHtml = useMemo(() => renderMarkdown(previewSrc), [previewSrc]);

  const tags = useMemo(() => parseYamlTags(value), [value]);

  const stats = useMemo(() => {
    const lines = value.split('\n').length;
    const chars = value.replace(/\s+/g, '').length;
    return { lines, chars };
  }, [value]);

  const wikiCandidates = useMemo(() => {
    if (!wikiMenu.open) return [];
    const q = wikiMenu.query.trim().toLowerCase();
    const list = q
      ? treeEntries.filter(
          (e) =>
            (e.title || '').toLowerCase().includes(q) ||
            e.path.toLowerCase().includes(q),
        )
      : treeEntries;
    return list.slice(0, 8);
  }, [wikiMenu.open, wikiMenu.query, treeEntries]);

  useEffect(() => {
    if (wikiMenu.selectedIndex >= wikiCandidates.length) {
      setWikiMenu((prev) => ({ ...prev, selectedIndex: Math.max(0, wikiCandidates.length - 1) }));
    }
  }, [wikiCandidates.length, wikiMenu.selectedIndex]);

  // 动态计算编辑区高度
  useEffect(() => {
    const updateHeight = (): void => {
      const topbar = document.querySelector<HTMLElement>('.topbar');
      const topbarH = topbar?.getBoundingClientRect().height ?? 56;
      const height = Math.max(420, window.innerHeight - topbarH);
      pageRef.current?.style.setProperty('--edit-h', `${height}px`);
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    const t = window.setTimeout(updateHeight, 0);
    return () => {
      window.removeEventListener('resize', updateHeight);
      window.clearTimeout(t);
    };
  }, []);

  const applyValue = useCallback((nextVal: string, nextCursor?: { start: number; end: number }) => {
    setValue(nextVal);
    setDirty(true);
    setStatus({ text: '● 未保存', kind: 'dirty' });
    if (nextCursor) {
      window.requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(nextCursor.start, nextCursor.end);
      });
    }
  }, []);

  const detectWikilinkTrigger = useCallback((ta: HTMLTextAreaElement) => {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) {
      setWikiMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
      return;
    }
    const before = ta.value.slice(0, pos);
    const lineStart = before.lastIndexOf('\n') + 1;
    const linePrefix = before.slice(lineStart);
    const match = /\[\[([^[\]|#\n]*)$/.exec(linePrefix);
    if (!match) {
      setWikiMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
      return;
    }
    const startPos = lineStart + match.index;
    const coords = getCaretCoordinates(ta, pos);
    setWikiMenu({
      open: true,
      query: match[1] ?? '',
      startPos,
      endPos: pos,
      coords,
      selectedIndex: 0,
    });
  }, []);

  const insertWikilinkCandidate = useCallback(
    (entry: TreeEntry) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const after = ta.value.slice(wikiMenu.endPos);
      const hasClosing = after.startsWith(']]');
      const linkName = entry.title || entry.path.split('/').pop() || entry.path;
      const inserted = `[[${linkName}]]`;
      const nextVal =
        ta.value.slice(0, wikiMenu.startPos) +
        inserted +
        (hasClosing ? after.slice(2) : after);
      const caret = wikiMenu.startPos + inserted.length;
      setWikiMenu((prev) => ({ ...prev, open: false }));
      applyValue(nextVal, { start: caret, end: caret });
    },
    [wikiMenu.startPos, wikiMenu.endPos, applyValue],
  );

  // 保存 / 冲突恢复逻辑
  const loadIntoEditor = useCallback((fresh: Doc) => {
    setDocMeta({
      path: fresh.path,
      hash: fresh.hash,
      revision: fresh.revision,
      isNew: false,
      title: fresh.title || fresh.path.split('/').pop() || fresh.path,
    });
    setValue(fresh.raw);
    setPreviewSrc(fresh.raw);
    setDirty(false);
    replaceUrl(editUrl(fresh.path));
    setStatus({ text: '✓ 已重新加载最新版本', kind: 'ok' });
  }, []);

  const applySaved = useCallback((result: UpdateResult, created: boolean, savedRaw: string) => {
    const prevMeta = stateRef.current.docMeta;
    const nextStem = prevMeta.path.split('/').pop() ?? prevMeta.path;
    setDocMeta((prev) => ({
      ...prev,
      hash: result.hash,
      revision: result.revision,
      isNew: false,
    }));
    setDirty(false);
    setPreviewSrc(savedRaw);
    invalidateTree();
    if (prevMeta.isNew) {
      replaceUrl(editUrl(prevMeta.path));
      layout.setTitle(`编辑：${nextStem} · 私有知识库`);
    }
    setStatus({ text: created ? '✓ 已创建 · 刚刚' : '✓ 已保存 · 刚刚', kind: 'ok' });
    toast(created ? '笔记已创建' : '已保存', 'success');
  }, []);

  const reloadFromServer = useCallback(async (): Promise<boolean> => {
    const { docMeta: meta } = stateRef.current;
    try {
      setStatus({ text: '正在加载最新版本…', kind: 'idle' });
      const fresh = await api.getDoc(meta.path);
      loadIntoEditor(fresh);
      return true;
    } catch (err) {
      setStatus({ text: `加载失败：${humanizeError(err)}`, kind: 'error' });
      return false;
    }
  }, [loadIntoEditor]);

  const forceOverwrite = useCallback(async (): Promise<void> => {
    const { saving: busy, docMeta: meta, value: raw } = stateRef.current;
    if (busy) return;
    setSaving(true);
    setStatus({ text: '正在覆盖…', kind: 'idle' });
    try {
      if (meta.isNew) {
        await api.putDoc(meta.path, raw, '*');
        const fresh = await api.getDoc(meta.path);
        applySaved({ path: meta.path, hash: fresh.hash, revision: fresh.revision }, true, raw);
        return;
      }
      const fresh = await api.getDoc(meta.path);
      const result = await api.putDoc(meta.path, raw, fresh.hash);
      applySaved(result, false, raw);
    } catch (err) {
      const msg = humanizeError(err);
      setStatus({ text: `保存失败：${msg}`, kind: 'error' });
      toast(`保存失败：${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [applySaved]);

  const openConflictDialog = useCallback(async (): Promise<void> => {
    setStatus({ text: '这篇笔记在别处被改过', kind: 'warn' });
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
  }, [reloadFromServer, forceOverwrite]);

  const openPathTakenDialog = useCallback(async (): Promise<void> => {
    const { docMeta: meta } = stateRef.current;
    setStatus({ text: '这个路径已经有笔记了', kind: 'warn' });
    const choice = await choiceDialog({
      title: '这个路径已经有笔记了',
      body: `创建时发现「${meta.path}」已经存在（可能是别人刚建的）。你可以直接打开现有的那篇继续编辑。`,
      actions: [
        { label: '打开现有的', value: 'open', kind: 'primary' },
        { label: '继续编辑（换个路径再试）', value: 'cancel', kind: 'ghost' },
      ],
    });
    if (choice !== 'open') return;
    try {
      const fresh = await api.getDoc(meta.path);
      loadIntoEditor(fresh);
      toast('已打开现有的笔记');
    } catch (err) {
      const msg = humanizeError(err);
      setStatus({ text: `加载失败：${msg}`, kind: 'error' });
      toast(`加载失败：${msg}`, 'error');
    }
  }, [loadIntoEditor]);

  const save = useCallback(async (): Promise<boolean> => {
    const { saving: busy, docMeta: meta, value: raw } = stateRef.current;
    if (busy) return false;
    setSaving(true);
    setStatus({ text: meta.isNew ? '正在创建…' : '正在保存…', kind: 'idle' });
    try {
      const created = meta.isNew;
      const result = await api.putDoc(meta.path, raw, created ? '*' : meta.hash);
      applySaved(result, created, raw);
      return true;
    } catch (err) {
      setSaving(false);
      if (meta.isNew && (err instanceof ConflictError || err instanceof PreconditionRequiredError)) {
        await openPathTakenDialog();
        return false;
      }
      if (err instanceof ConflictError || err instanceof PreconditionRequiredError) {
        await openConflictDialog();
        return false;
      }
      const msg = humanizeError(err);
      setStatus({ text: `保存失败：${msg}`, kind: 'error' });
      toast(`保存失败：${msg}`, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [applySaved, openConflictDialog, openPathTakenDialog]);

  const saveAndRead = useCallback(async (): Promise<void> => {
    const ok = await save();
    if (ok) {
      void navigate(docUrl(stateRef.current.docMeta.path));
    }
  }, [save]);

  // 离开守卫与全局按键（Ctrl+S, Ctrl+Enter, Esc）
  useEffect(() => {
    const guard: LeaveGuard = {
      isDirty: () => stateRef.current.dirty,
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
        setDirty(false);
      },
    };
    setLeaveGuard(guard);

    const onKeydown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        if (document.querySelector('[role="dialog"], .modal-overlay')) return;
        event.preventDefault();
        void saveAndRead();
        return;
      }
      if (event.key === 'Escape') {
        const hasModal = document.querySelector('[role="dialog"], .modal-overlay') !== null;
        if (!hasModal) {
          event.preventDefault();
          void navigate(docUrl(stateRef.current.docMeta.path));
        }
      }
    };

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!stateRef.current.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };

    document.addEventListener('keydown', onKeydown);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      clearLeaveGuard(guard);
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [save, saveAndRead]);

  // 文本工具栏操作
  const wrapSelection = useCallback(
    (before: string, after: string, placeholder = '') => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = ta.value.slice(start, end) || placeholder;
      const next = ta.value.slice(0, start) + before + selected + after + ta.value.slice(end);
      applyValue(next, {
        start: start + before.length,
        end: start + before.length + selected.length,
      });
    },
    [applyValue],
  );

  const toggleLinePrefix = useCallback(
    (prefix: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = ta.value.indexOf('\n', start);
      const lineEnd = lineEndIdx === -1 ? ta.value.length : lineEndIdx;
      const line = ta.value.slice(lineStart, lineEnd);

      let nextLine: string;
      let delta: number;
      if (line.startsWith(prefix)) {
        nextLine = line.slice(prefix.length);
        delta = -prefix.length;
      } else {
        nextLine = prefix + line;
        delta = prefix.length;
      }
      const next = ta.value.slice(0, lineStart) + nextLine + ta.value.slice(lineEnd);
      const nextPos = Math.max(lineStart, start + delta);
      applyValue(next, { start: nextPos, end: nextPos });
    },
    [applyValue],
  );

  const insertBlock = useCallback(
    (block: string, cursorOffset?: number) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const needsLeadingNewline = pos > 0 && ta.value[pos - 1] !== '\n';
      const prefix = needsLeadingNewline ? '\n' : '';
      const next = ta.value.slice(0, pos) + prefix + block + ta.value.slice(ta.selectionEnd);
      const targetPos = pos + prefix.length + (cursorOffset ?? block.length);
      applyValue(next, { start: targetPos, end: targetPos });
    },
    [applyValue],
  );

  const triggerWikilinkInsert = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);
    const inserted = selected ? `[[${selected}]]` : '[[';
    const next = ta.value.slice(0, start) + inserted + ta.value.slice(end);
    const pos = start + inserted.length;
    applyValue(next, { start: pos, end: pos });
    if (!selected) {
      window.requestAnimationFrame(() => {
        if (textareaRef.current) detectWikilinkTrigger(textareaRef.current);
      });
    }
  }, [applyValue, detectWikilinkTrigger]);

  // 编辑器专用键盘增强（[[ 补全、Tab 缩进、列表续行、Ctrl+B/I/E）
  const onTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const ta = event.currentTarget;

    if (wikiMenu.open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setWikiMenu((prev) => ({
          ...prev,
          selectedIndex: wikiCandidates.length ? (prev.selectedIndex + 1) % wikiCandidates.length : 0,
        }));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setWikiMenu((prev) => ({
          ...prev,
          selectedIndex: wikiCandidates.length
            ? (prev.selectedIndex - 1 + wikiCandidates.length) % wikiCandidates.length
            : 0,
        }));
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && wikiCandidates[wikiMenu.selectedIndex]) {
        event.preventDefault();
        insertWikilinkCandidate(wikiCandidates[wikiMenu.selectedIndex]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setWikiMenu((prev) => ({ ...prev, open: false }));
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const k = event.key.toLowerCase();
      if (k === 'b') {
        event.preventDefault();
        wrapSelection('**', '**', '加粗文本');
        return;
      }
      if (k === 'i') {
        event.preventDefault();
        wrapSelection('*', '*', '斜体文本');
        return;
      }
      if (k === 'e') {
        event.preventDefault();
        wrapSelection('`', '`', 'code');
        return;
      }
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start === end && !event.shiftKey) {
        const next = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
        applyValue(next, { start: start + 2, end: start + 2 });
        return;
      }
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const block = ta.value.slice(lineStart, end);
      const lines = block.split('\n');
      const updated = lines.map((line) =>
        event.shiftKey ? line.replace(/^ {1,2}|\t/, '') : `  ${line}`,
      );
      const joined = updated.join('\n');
      const next = ta.value.slice(0, lineStart) + joined + ta.value.slice(end);
      applyValue(next, { start: lineStart, end: lineStart + joined.length });
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start !== end) return;
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const lineBefore = ta.value.slice(lineStart, start);
      const m = /^([ \t]*)([-*] \[[ x]\] |[-*] |\d+\. )(.*)$/.exec(lineBefore);
      if (!m) return;
      event.preventDefault();
      const [, indent, marker, content] = m;
      if (!content?.trim()) {
        // 空列表项按回车退出列表
        const next = ta.value.slice(0, lineStart) + '\n' + ta.value.slice(end);
        applyValue(next, { start: lineStart + 1, end: lineStart + 1 });
        return;
      }
      let nextMarker = marker!;
      const numMatch = /^(\d+)\. $/.exec(nextMarker);
      if (numMatch) nextMarker = `${Number(numMatch[1]) + 1}. `;
      else if (nextMarker.startsWith('- [x]')) nextMarker = '- [ ] ';
      const insertion = `\n${indent}${nextMarker}`;
      const next = ta.value.slice(0, start) + insertion + ta.value.slice(end);
      const pos = start + insertion.length;
      applyValue(next, { start: pos, end: pos });
    }
  };

  // 同步滚动
  const syncScroll = (source: 'source' | 'preview'): void => {
    if (scrollLockRef.current && scrollLockRef.current !== source) return;
    const ta = textareaRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;

    const from = source === 'source' ? ta : pv;
    const to = source === 'source' ? pv : ta;
    const maxFrom = from.scrollHeight - from.clientHeight;
    const maxTo = to.scrollHeight - to.clientHeight;
    if (maxFrom <= 0 || maxTo <= 0) return;

    scrollLockRef.current = source;
    to.scrollTop = (from.scrollTop / maxFrom) * maxTo;
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollLockRef.current = null;
    }, 60);
  };

  const handleAddTag = (rawTag: string): void => {
    const clean = rawTag.trim();
    setNewTagText('');
    setAddingTag(false);
    if (!clean || tags.includes(clean)) return;
    const nextRaw = updateYamlTags(value, [...tags, clean], docMeta.title);
    applyValue(nextRaw);
  };

  const handleRemoveTag = (tag: string): void => {
    const nextRaw = updateYamlTags(
      value,
      tags.filter((t) => t !== tag),
      docMeta.title,
    );
    applyValue(nextRaw);
  };

  return (
    <Tooltip.Provider delayDuration={250}>
      <div ref={pageRef} className="edit-shell">
        <header className="edit-head">
          <div className="edit-head-row">
            <a className="back-link" href={docUrl(docMeta.path)}>
              <ArrowLeft size={14} />
              <span>返回阅读</span>
            </a>

            <div className="edit-title-wrap">
              <h1 className="edit-title">
                {docMeta.isNew ? '新建' : '编辑'}：{docMeta.title}
              </h1>
              <div className="edit-sub muted">
                <span>{docMeta.path}</span>
                <span className="dot" />
                <span>
                  {stats.chars.toLocaleString()} 字 · {stats.lines} 行
                </span>
              </div>
            </div>

            <div className="edit-actions">
              <span className={`edit-status edit-status-${status.kind}`} role="status">
                {status.text}
              </span>

              <div className="edit-view-switch" role="group" aria-label="编辑视图模式">
                <button
                  type="button"
                  className={`edit-view-btn${viewMode === 'source' ? ' is-active' : ''}`}
                  onClick={() => setViewMode('source')}
                  title="专注编辑"
                >
                  <PenLine size={14} />
                  <span>编辑</span>
                </button>
                <button
                  type="button"
                  className={`edit-view-btn${viewMode === 'split' ? ' is-active' : ''}`}
                  onClick={() => setViewMode('split')}
                  title="左右分栏对照"
                >
                  <Columns2 size={14} />
                  <span>分栏</span>
                </button>
                <button
                  type="button"
                  className={`edit-view-btn${viewMode === 'preview' ? ' is-active' : ''}`}
                  onClick={() => setViewMode('preview')}
                  title="纯预览"
                >
                  <Eye size={14} />
                  <span>预览</span>
                </button>
              </div>

              <button
                type="button"
                className="btn btn-ghost edit-lookup-btn"
                onClick={() => openCommandPalette('')}
                title="快速查找其他笔记 (Ctrl/Cmd + K)"
              >
                <Search size={14} />
                <span className="hide-xs">查笔记</span>
              </button>

              <Popover.Root>
                <Popover.Trigger asChild>
                  <button type="button" className="btn btn-ghost btn-icon-only edit-info-btn" aria-label="文档与快捷键信息">
                    <Info size={15} />
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content className="popover-content" align="end" sideOffset={8}>
                    <div className="popover-title">版本与快捷键</div>
                    <div className="popover-meta">
                      <div>路径：<code>{docMeta.path}</code></div>
                      <div>
                        状态：{docMeta.isNew ? '未保存的新笔记' : `版本 ${shortHash(docMeta.hash)} · 第 ${docMeta.revision} 次保存`}
                      </div>
                    </div>
                    <div className="popover-shortcuts">
                      <div><kbd>Ctrl/Cmd + S</kbd> 保存</div>
                      <div><kbd>Ctrl/Cmd + Enter</kbd> 保存并返回阅读</div>
                      <div><kbd>[[</kbd> 触发双链笔记自动补全</div>
                      <div><kbd>Ctrl/Cmd + B / I / E</kbd> 加粗 / 斜体 / 代码</div>
                      <div><kbd>Tab / Shift+Tab</kbd> 缩进 / 反缩进</div>
                      <div><kbd>Esc</kbd> 返回阅读页</div>
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>

              <button
                type="button"
                className="btn btn-ghost"
                disabled={saving}
                title="保存 (Ctrl/Cmd + S)"
                onClick={() => void save()}
              >
                <Save size={14} />
                <span>保存</span>
              </button>

              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                title="保存并回到阅读页 (Ctrl/Cmd + Enter)"
                onClick={() => void saveAndRead()}
              >
                <Check size={14} />
                <span>保存并阅读</span>
              </button>
            </div>
          </div>

          <div className="edit-toolbar-row">
            <div className="edit-toolbar" role="toolbar" aria-label="Markdown 格式工具栏">
              <ToolbarBtn label="一级标题" onClick={() => toggleLinePrefix('# ')}>
                <Heading1 size={15} />
              </ToolbarBtn>
              <ToolbarBtn label="二级标题" onClick={() => toggleLinePrefix('## ')}>
                <Heading2 size={15} />
              </ToolbarBtn>
              <ToolbarBtn label="三级标题" onClick={() => toggleLinePrefix('### ')}>
                <Heading3 size={15} />
              </ToolbarBtn>
              <span className="edit-toolbar-sep" aria-hidden="true" />
              <ToolbarBtn label="粗体" shortcut="⌘B" onClick={() => wrapSelection('**', '**', '加粗文本')}>
                <Bold size={15} />
              </ToolbarBtn>
              <ToolbarBtn label="斜体" shortcut="⌘I" onClick={() => wrapSelection('*', '*', '斜体文本')}>
                <Italic size={15} />
              </ToolbarBtn>
              <ToolbarBtn label="行内代码" shortcut="⌘E" onClick={() => wrapSelection('`', '`', 'code')}>
                <Code size={15} />
              </ToolbarBtn>
              <ToolbarBtn
                label="代码块"
                onClick={() => insertBlock('```text\n\n```\n', 8)}
              >
                <FileCode2 size={15} />
              </ToolbarBtn>
              <ToolbarBtn
                label="数学公式块 (KaTeX)"
                onClick={() => insertBlock('$$\n\n$$\n', 3)}
              >
                <Sigma size={15} />
              </ToolbarBtn>
              <span className="edit-toolbar-sep" aria-hidden="true" />
              <ToolbarBtn label="无序列表" onClick={() => toggleLinePrefix('- ')}>
                <List size={15} />
              </ToolbarBtn>
              <ToolbarBtn label="有序列表" onClick={() => toggleLinePrefix('1. ')}>
                <ListOrdered size={15} />
              </ToolbarBtn>
              <ToolbarBtn label="任务清单" onClick={() => toggleLinePrefix('- [ ] ')}>
                <ListChecks size={15} />
              </ToolbarBtn>
              <ToolbarBtn label="引用" onClick={() => toggleLinePrefix('> ')}>
                <Quote size={15} />
              </ToolbarBtn>
              <ToolbarBtn
                label="提示卡片 (Callout)"
                onClick={() => insertBlock('> [!tip] 💡\n> \n', 14)}
              >
                <MessageSquareQuote size={15} />
              </ToolbarBtn>
              <ToolbarBtn
                label="表格模板"
                onClick={() => insertBlock('| 列 1 | 列 2 | 列 3 |\n|-|-|-|\n|  |  |  |\n', 2)}
              >
                <Table size={15} />
              </ToolbarBtn>
              <span className="edit-toolbar-sep" aria-hidden="true" />
              <ToolbarBtn label="插入双链笔记" shortcut="[[" onClick={triggerWikilinkInsert}>
                <Link2 size={15} />
                <span className="edit-tool-text">双链</span>
              </ToolbarBtn>
            </div>

            <div className="edit-tags-bar" aria-label="文档标签">
              <Tag size={13} className="muted" aria-hidden="true" />
              {tags.map((tag) => (
                <span key={tag} className="edit-tag-chip">
                  <span>{tag}</span>
                  <button
                    type="button"
                    aria-label={`移除标签 ${tag}`}
                    onClick={() => handleRemoveTag(tag)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              {addingTag ? (
                <input
                  type="text"
                  className="edit-tag-input"
                  placeholder="标签名，回车"
                  value={newTagText}
                  autoFocus
                  onChange={(e) => setNewTagText(e.target.value)}
                  onBlur={() => handleAddTag(newTagText)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag(newTagText);
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setNewTagText('');
                      setAddingTag(false);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="edit-tag-add"
                  onClick={() => setAddingTag(true)}
                >
                  <Plus size={12} />
                  <span>标签</span>
                </button>
              )}
            </div>
          </div>

          <div className="edit-tabs">
            <button
              type="button"
              className={`edit-tab${mobilePane === 'source' ? ' edit-tab-active' : ''}`}
              onClick={() => {
                setMobilePane('source');
                textareaRef.current?.focus();
              }}
            >
              源码
            </button>
            <button
              type="button"
              className={`edit-tab${mobilePane === 'preview' ? ' edit-tab-active' : ''}`}
              onClick={() => setMobilePane('preview')}
            >
              预览
            </button>
          </div>
        </header>

        <div className="edit-panes" data-pane={mobilePane} data-view={viewMode}>
          <div className="edit-source-wrap">
            <textarea
              ref={textareaRef}
              className="edit-textarea"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Markdown 源文本"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setDirty(true);
                setStatus({ text: '● 未保存', kind: 'dirty' });
                detectWikilinkTrigger(e.currentTarget);
              }}
              onClick={(e) => detectWikilinkTrigger(e.currentTarget)}
              onKeyUp={(e) => {
                if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
                  detectWikilinkTrigger(e.currentTarget);
                }
              }}
              onKeyDown={onTextareaKeyDown}
              onScroll={() => syncScroll('source')}
            />

            {wikiMenu.open ? (
              <div
                className="wikilink-autocomplete"
                style={{
                  ...(wikiMenu.coords.top !== undefined ? { top: `${wikiMenu.coords.top}px` } : {}),
                  ...(wikiMenu.coords.bottom !== undefined ? { bottom: `${wikiMenu.coords.bottom}px` } : {}),
                  left: `${wikiMenu.coords.left}px`,
                }}
                role="listbox"
                aria-label="双链笔记补全"
              >
                <div className="wikilink-ac-head">
                  <span>选择要链接的笔记</span>
                  <kbd>↑↓ / Enter</kbd>
                </div>
                {wikiCandidates.length === 0 ? (
                  <div className="wikilink-ac-empty">没有匹配「{wikiMenu.query}」的笔记</div>
                ) : (
                  wikiCandidates.map((entry, idx) => (
                    <button
                      key={entry.path}
                      type="button"
                      role="option"
                      aria-selected={idx === wikiMenu.selectedIndex}
                      className={`wikilink-ac-item${idx === wikiMenu.selectedIndex ? ' is-selected' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertWikilinkCandidate(entry);
                      }}
                    >
                      <span className="wikilink-ac-title">{entry.title || entry.path}</span>
                      <span className="wikilink-ac-path">{entry.path}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div
            ref={previewRef}
            className="edit-preview markdown-body"
            onScroll={() => syncScroll('preview')}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>

        <div className="edit-bottom-bar">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void navigate(docUrl(docMeta.path))}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Tooltip.Provider>
  );
}

function editMissingPage(inputPath: string): PageView {
  const stem = inputPath.split('/').pop() ?? inputPath;
  return createReactPageView(
    <div className="doc-main">
      <div className="doc-toolbar">
        <a className="back-link" href="/">
          <ArrowLeft size={14} />
          <span>目录</span>
        </a>
      </div>
      <div className="notfound">
        <h1 className="doc-title">没有这篇笔记</h1>
        <p className="notfound-text">
          「{stem}」还没有被创建。可以新建一篇，或者回目录找找有没有名字相近的笔记。
        </p>
        <div className="notfound-actions">
          <a className="btn btn-primary" href={editUrl(inputPath, true)}>
            新建这篇笔记
          </a>
          <a className="btn btn-ghost" href="/">
            回目录
          </a>
        </div>
      </div>
    </div>,
    {
      className: 'doc-page',
      active: 'edit',
      title: '没有这篇笔记 · 私有知识库',
      showSidebar: false,
    },
  );
}

export async function renderEdit(inputPath: string, isNew = false): Promise<PageView> {
  const startedAtUrl = currentRouteUrl();
  let doc: Doc | null = null;
  if (!isNew) {
    try {
      doc = await loadDoc(inputPath);
    } catch (err) {
      if (err instanceof NotFoundError) {
        return editMissingPage(inputPath);
      }
      return createReactPageView(
        (() => {
          const node = apiErrorState(err, '这篇笔记加载失败', () =>
            window.dispatchEvent(new Event('kb:navigate')),
          );
          return <div ref={(el) => { if (el) el.replaceChildren(node); }} />;
        })(),
        {
          className: 'doc-page',
          active: 'edit',
          title: '加载失败 · 私有知识库',
          showSidebar: false,
        },
      );
    }
    if (doc.path !== inputPath) replaceUrl(editUrl(doc.path), startedAtUrl);
  }

  const path = doc?.path ?? inputPath;
  const stem = path.split('/').pop() ?? path;
  const title = doc?.title || stem;
  const modeNew = isNew && !doc;
  const templateContent = modeNew ? consumeNewNoteTemplate(path) : null;
  const initialContent = doc?.raw ?? templateContent ?? `# ${stem}\n\n`;

  return createReactPageView(
    <EditPageComponent
      initialDoc={doc}
      initialPath={path}
      initialIsNew={modeNew}
      initialContent={initialContent}
    />,
    {
      className: 'edit-page',
      active: 'edit',
      title: `${modeNew ? '新建' : '编辑'}：${title} · 私有知识库`,
      wide: true,
      showSidebar: false,
    },
  );
}
