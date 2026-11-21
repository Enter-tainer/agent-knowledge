import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  CornerDownLeft,
  Download,
  FilePlus2,
  FileText,
  Home,
  Moon,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../api';
import { humanizeError } from '../api/errors';
import type { SearchHit, TreeEntry } from '../api/types';
import { docUrl, editUrl, navigate, searchUrl } from '../router';
import { loadTree } from '../store';
import { cleanSnippet, parentPath } from './dom';
import { openNewNoteDialog } from './newNote';
import { toast } from './shell';
import { toggleTheme, useTheme } from './theme';

type PaletteListener = (open: boolean, initialQuery?: string) => void;

const paletteListeners = new Set<PaletteListener>();
let paletteMounted = false;
let paletteRoot: Root | null = null;
let paletteHost: HTMLElement | null = null;

export function openCommandPalette(initialQuery?: string): void {
  if (!paletteMounted) mountGlobalCommandPalette();
  for (const fn of paletteListeners) fn(true, initialQuery);
}

interface ScoredDoc {
  entry: TreeEntry;
  score: number;
}

function matchTreeDocs(entries: TreeEntry[], rawQuery: string): ScoredDoc[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    return [...entries]
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
      .slice(0, 8)
      .map((entry) => ({ entry, score: 1 }));
  }

  const terms = q.split(/\s+/).filter(Boolean);
  const scored: ScoredDoc[] = [];

  for (const entry of entries) {
    const title = (entry.title || '').toLowerCase();
    const path = entry.path.toLowerCase();
    const tags = entry.tags.join(' ').toLowerCase();
    const hay = `${title} ${path} ${tags}`;

    if (!terms.every((t) => hay.includes(t))) continue;

    let score = 0;
    if (title === q) score += 100;
    else if (title.startsWith(q)) score += 60;
    else if (title.includes(q)) score += 40;
    if (path.includes(q)) score += 20;
    if (tags.includes(q)) score += 15;
    score += terms.length * 4;
    scored.push({ entry, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      new Date(b.entry.updated).getTime() - new Date(a.entry.updated).getTime(),
  );
  return scored.slice(0, 10);
}

interface PaletteItem {
  id: string;
  group: '最近 / 匹配笔记' | '全文搜索命中' | '快捷操作';
  title: string;
  subtitle?: string;
  badge?: string;
  icon: 'doc' | 'search' | 'new' | 'theme' | 'reports' | 'home' | 'export' | 'reindex';
  docPath?: string;
  run: (editMode?: boolean) => void;
}

function isInputLike(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function CommandPaletteRoot() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [theme] = useTheme();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const listener: PaletteListener = (nextOpen, initialQuery) => {
      setOpen(nextOpen);
      if (nextOpen) {
        if (initialQuery !== undefined) setQuery(initialQuery);
        else setQuery('');
        setSelectedIndex(0);
        void loadTree()
          .then((entries) => setTree(entries))
          .catch(() => undefined);
      }
    };
    paletteListeners.add(listener);
    return () => {
      paletteListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const onGlobalKeydown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => {
          const next = !prev;
          if (next) {
            setSelectedIndex(0);
            void loadTree().then(setTree).catch(() => undefined);
          }
          return next;
        });
        return;
      }
      if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !open &&
        !isInputLike(event.target) &&
        !document.querySelector('.modal-overlay, [role="dialog"]')
      ) {
        event.preventDefault();
        openCommandPalette('');
      }
    };
    document.addEventListener('keydown', onGlobalKeydown);
    return () => document.removeEventListener('keydown', onGlobalKeydown);
  }, [open]);

  // 防抖全文检索（>= 2 字）
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .search(q, 8)
        .then((res) => {
          if (!cancelled) setHits(res.results ?? []);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const out: PaletteItem[] = [];
    const seenDocPaths = new Set<string>();

    const localMatches = matchTreeDocs(tree, q);
    for (const { entry } of localMatches) {
      seenDocPaths.add(entry.path);
      out.push({
        id: `doc:${entry.path}`,
        group: '最近 / 匹配笔记',
        title: entry.title || entry.path,
        subtitle: parentPath(entry.path) || '根目录',
        badge: entry.tags.slice(0, 2).join(' · ') || undefined,
        icon: 'doc',
        docPath: entry.path,
        run: (editMode) => {
          setOpen(false);
          void navigate(editMode ? editUrl(entry.path) : docUrl(entry.path));
        },
      });
    }

    for (const hit of hits) {
      if (seenDocPaths.has(hit.path) && !hit.heading && !hit.snippet) continue;
      const snippet = cleanSnippet(hit.snippet ?? '');
      out.push({
        id: `hit:${hit.path}:${hit.heading}`,
        group: '全文搜索命中',
        title: hit.title || hit.path,
        subtitle: [hit.heading ? `§ ${hit.heading}` : parentPath(hit.path), snippet.slice(0, 72)]
          .filter(Boolean)
          .join(' — '),
        icon: 'search',
        docPath: hit.path,
        run: (editMode) => {
          setOpen(false);
          void navigate(editMode ? editUrl(hit.path) : docUrl(hit.path));
        },
      });
    }

    const actions: PaletteItem[] = [];
    if (q) {
      actions.push({
        id: 'action:search-page',
        group: '快捷操作',
        title: `在搜索页查看「${q}」的全部结果`,
        subtitle: '打开完整搜索页',
        icon: 'search',
        run: () => {
          setOpen(false);
          void navigate(searchUrl(q), { force: true });
        },
      });
      const cleanName = q.replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '');
      if (cleanName && !tree.some((e) => e.path.toLowerCase() === cleanName.toLowerCase())) {
        actions.push({
          id: 'action:create-named',
          group: '快捷操作',
          title: `新建笔记「${cleanName}」`,
          subtitle: '直接创建并进入编辑器',
          icon: 'new',
          run: () => {
            setOpen(false);
            void navigate(editUrl(cleanName, true));
          },
        });
      }
    }

    actions.push(
      {
        id: 'action:new-note',
        group: '快捷操作',
        title: '新建笔记…',
        subtitle: '选择目录与模板创建',
        icon: 'new',
        run: () => {
          setOpen(false);
          openNewNoteDialog();
        },
      },
      {
        id: 'action:toggle-theme',
        group: '快捷操作',
        title: theme === 'dark' ? '切换到浅色模式' : '切换到深色模式',
        subtitle: '立即切换界面外观主题',
        icon: 'theme',
        run: () => {
          const next = toggleTheme();
          toast(next === 'dark' ? '已切换到深色模式' : '已切换到浅色模式');
          setOpen(false);
        },
      },
      {
        id: 'action:home',
        group: '快捷操作',
        title: '回到知识库首页',
        subtitle: '查看最近更新与目录总览',
        icon: 'home',
        run: () => {
          setOpen(false);
          void navigate('/');
        },
      },
      {
        id: 'action:reports',
        group: '快捷操作',
        title: '查看知识库健康报告',
        subtitle: '检查断链、无入链笔记与索引状态',
        icon: 'reports',
        run: () => {
          setOpen(false);
          void navigate('/reports');
        },
      },
      {
        id: 'action:reindex',
        group: '快捷操作',
        title: '重建全文搜索索引',
        subtitle: '修复滞后的 FTS5 搜索索引',
        icon: 'reindex',
        run: () => {
          setOpen(false);
          void api
            .reindex()
            .then((r) => toast(`索引重建完成：${r.documents} 篇 / ${r.chunks} 块`, 'success'))
            .catch((e) => toast(`重建失败：${humanizeError(e)}`, 'error'));
        },
      },
      {
        id: 'action:export',
        group: '快捷操作',
        title: '导出全库 Markdown (.zip)',
        subtitle: '打包下载全部笔记',
        icon: 'export',
        run: () => {
          setOpen(false);
          const exportBtn = document.querySelector<HTMLButtonElement>('.topbar button[data-action="export"]');
          if (exportBtn) exportBtn.click();
        },
      },
    );

    const filteredActions = q
      ? actions.filter(
          (a) =>
            a.id.startsWith('action:search-page') ||
            a.id.startsWith('action:create-named') ||
            a.title.toLowerCase().includes(q.toLowerCase()) ||
            (a.subtitle ?? '').toLowerCase().includes(q.toLowerCase()),
        )
      : actions;

    return [...out, ...filteredActions];
  }, [tree, hits, query, theme]);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, selectedIndex]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((idx) => (items.length ? (idx + 1) % items.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((idx) => (items.length ? (idx - 1 + items.length) % items.length : 0));
    } else if (event.key === 'Enter') {
      const target = items[selectedIndex];
      if (target) {
        event.preventDefault();
        target.run(event.metaKey || event.ctrlKey);
      }
    }
  };

  const renderIcon = (kind: PaletteItem['icon']) => {
    switch (kind) {
      case 'doc':
        return <FileText size={16} />;
      case 'search':
        return <Search size={16} />;
      case 'new':
        return <FilePlus2 size={16} />;
      case 'theme':
        return theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />;
      case 'reports':
        return <Activity size={16} />;
      case 'home':
        return <Home size={16} />;
      case 'export':
        return <Download size={16} />;
      case 'reindex':
        return <RefreshCw size={16} />;
    }
  };

  const grouped = useMemo(() => {
    const groups: Array<{ label: PaletteItem['group']; items: Array<{ item: PaletteItem; index: number }> }> = [];
    const byLabel = new Map<PaletteItem['group'], Array<{ item: PaletteItem; index: number }>>();
    items.forEach((item, index) => {
      let arr = byLabel.get(item.group);
      if (!arr) {
        arr = [];
        byLabel.set(item.group, arr);
        groups.push({ label: item.group, items: arr });
      }
      arr.push({ item, index });
    });
    return groups;
  }, [items]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="cmd-overlay" />
        <Dialog.Content
          className="cmd-dialog"
          aria-describedby="cmd-palette-desc"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <Dialog.Title className="sr-only">全局命令与快速搜索</Dialog.Title>
          <Dialog.Description id="cmd-palette-desc" className="sr-only">
            搜索笔记标题、全文内容或执行快捷操作
          </Dialog.Description>
          <div className="cmd-input-wrap">
            <Search size={18} className="cmd-search-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              className="cmd-input"
              placeholder="搜索笔记、标签、全文关键词，或输入命令…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
            {searching ? <span className="cmd-spinner" aria-label="搜索中" /> : null}
            {query ? (
              <button
                type="button"
                className="cmd-clear-btn"
                aria-label="清空搜索"
                onClick={() => {
                  setQuery('');
                  setSelectedIndex(0);
                  inputRef.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            ) : null}
            <kbd className="cmd-kbd">Esc</kbd>
          </div>

          <div className="cmd-list" ref={listRef} role="listbox" aria-label="搜索结果与命令">
            {grouped.length === 0 ? (
              <div className="cmd-empty">
                <Sparkles size={18} />
                <span>没有匹配的笔记或命令</span>
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.label} className="cmd-group">
                  <div className="cmd-group-label">{group.label}</div>
                  {group.items.map(({ item, index }) => {
                    const selected = index === selectedIndex;
                    return (
                      <div
                        key={item.id}
                        role="option"
                        aria-selected={selected}
                        data-selected={selected ? 'true' : 'false'}
                        className={`cmd-item${selected ? ' is-selected' : ''}`}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => item.run(false)}
                      >
                        <span className="cmd-item-icon" aria-hidden="true">
                          {renderIcon(item.icon)}
                        </span>
                        <span className="cmd-item-body">
                          <span className="cmd-item-title">{item.title}</span>
                          {item.subtitle ? <span className="cmd-item-sub">{item.subtitle}</span> : null}
                        </span>
                        {item.badge ? <span className="cmd-item-badge">{item.badge}</span> : null}
                        {item.docPath ? (
                          <button
                            type="button"
                            className="cmd-item-edit"
                            title="直接编辑 (Ctrl/Cmd + Enter)"
                            onClick={(e) => {
                              e.stopPropagation();
                              item.run(true);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="cmd-footer">
            <span>
              <kbd className="cmd-kbd">↑</kbd> <kbd className="cmd-kbd">↓</kbd> 选择
            </span>
            <span>
              <kbd className="cmd-kbd">
                <CornerDownLeft size={11} />
              </kbd>{' '}
              打开
            </span>
            <span>
              <kbd className="cmd-kbd">⌘/Ctrl</kbd> + <kbd className="cmd-kbd">Enter</kbd> 编辑
            </span>
            <span>
              <kbd className="cmd-kbd">/</kbd> 快速唤起
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function mountGlobalCommandPalette(): () => void {
  if (paletteMounted) {
    return () => unmountGlobalCommandPalette();
  }
  paletteMounted = true;
  paletteHost = document.createElement('div');
  paletteHost.id = 'kb-command-palette-host';
  document.body.appendChild(paletteHost);
  paletteRoot = createRoot(paletteHost);
  paletteRoot.render(<CommandPaletteRoot />);

  return () => unmountGlobalCommandPalette();
}

function unmountGlobalCommandPalette(): void {
  if (!paletteMounted) return;
  paletteMounted = false;
  const root = paletteRoot;
  const host = paletteHost;
  paletteRoot = null;
  paletteHost = null;
  queueMicrotask(() => {
    root?.unmount();
    host?.remove();
  });
}
