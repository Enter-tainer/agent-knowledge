import {
  ArrowDownUp,
  BookOpen,
  FilePlus2,
  Folder,
  FolderOpen,
  Search,
  Sparkles,
  Tag,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { humanizeError } from '../api/errors';
import type { HealthResponse, TreeEntry } from '../api/types';
import { docUrl, editUrl, navigate } from '../router';
import { loadTree } from '../store';
import { openCommandPalette } from '../ui/commandPalette';
import { formatDate, parentPath } from '../ui/dom';
import { openNewNoteDialog } from '../ui/newNote';
import { createReactPageView } from '../ui/react-view';
import { apiErrorState, toast } from '../ui/shell';
import type { PageView } from '../ui/view';

type SortKey = 'updated' | 'title' | 'size';

function timeOf(value: string): number {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function StaleNotice({ stale }: { stale: number }) {
  const [busy, setBusy] = useState(false);

  const handleReindex = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.reindex();
      toast(
        result.stale === 0
          ? '搜索索引已重建完成'
          : `索引仍落后 ${result.stale} 篇，请稍后再试`,
        result.stale === 0 ? 'success' : 'error',
      );
      await navigate('/', { replace: true, force: true });
    } catch (err) {
      toast(`重建失败：${humanizeError(err)}`, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="notice" role="status">
      <div className="notice-text">
        <strong>有 {stale} 篇笔记还没进搜索</strong>
        <span>。重建索引后就能搜到它们，只处理索引，不改笔记内容。</span>
      </div>
      <button
        type="button"
        className="btn btn-small btn-primary"
        disabled={busy}
        onClick={() => void handleReindex()}
      >
        {busy ? '重建中…' : '重建索引'}
      </button>
    </div>
  );
}

function HomePageComponent({
  entries,
  health,
}: {
  entries: TreeEntry[];
  health: HealthResponse | null;
}) {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('updated');

  const { folders, allTags } = useMemo(() => {
    const folderCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    for (const entry of entries) {
      const parts = entry.path.split('/').filter(Boolean);
      const top = parts.length > 1 ? parts[0]! : '根目录';
      folderCounts.set(top, (folderCounts.get(top) ?? 0) + 1);
      for (const t of entry.tags ?? []) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }
    const sortedFolders = [...folderCounts.entries()].sort((a, b) => {
      if (a[0] === '根目录') return 1;
      if (b[0] === '根目录') return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN');
    });
    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    return { folders: sortedFolders, allTags: sortedTags };
  }, [entries]);

  const visibleEntries = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (selectedFolder) {
        const parts = entry.path.split('/').filter(Boolean);
        const top = parts.length > 1 ? parts[0]! : '根目录';
        if (top !== selectedFolder) return false;
      }
      if (selectedTag && !(entry.tags ?? []).includes(selectedTag)) {
        return false;
      }
      if (q) {
        const hay = `${entry.title} ${entry.path} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === 'title') {
        return (a.title || a.path).localeCompare(b.title || b.path, 'zh-Hans-CN');
      }
      if (sortBy === 'size') {
        return b.size - a.size;
      }
      return timeOf(b.updated) - timeOf(a.updated);
    });
  }, [entries, selectedFolder, selectedTag, filterQuery, sortBy]);

  return (
    <div className="home-wrap">
      <section className="home-hero panel">
        <div className="home-hero-top">
          <div>
            <h1 className="panel-title">知识库工作台</h1>
            <p className="panel-hint">
              共 <strong>{entries.length}</strong> 篇笔记 ·{' '}
              <strong>{folders.length}</strong> 个分类 ·{' '}
              <strong>{allTags.length}</strong> 个标签
            </p>
          </div>
          <div className="home-hero-actions">
            <button
              type="button"
              className="btn btn-ghost home-cmd-btn"
              onClick={() => openCommandPalette('')}
            >
              <Search size={15} />
              <span>快速跳转</span>
              <kbd className="cmd-kbd">⌘K</kbd>
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openNewNoteDialog(selectedFolder && selectedFolder !== '根目录' ? selectedFolder : undefined)}
            >
              <FilePlus2 size={15} />
              <span>新建笔记</span>
            </button>
          </div>
        </div>

        {health?.stale ? <StaleNotice stale={health.stale} /> : null}

        {folders.length > 1 ? (
          <div className="home-topics" aria-label="目录分类">
            {folders.map(([folder, count]) => {
              const active = selectedFolder === folder;
              return (
                <button
                  key={folder}
                  type="button"
                  className={`topic-card${active ? ' is-active' : ''}`}
                  onClick={() => setSelectedFolder(active ? null : folder)}
                >
                  <span className="topic-icon" aria-hidden="true">
                    {active ? <FolderOpen size={16} /> : <Folder size={16} />}
                  </span>
                  <span className="topic-name">{folder}</span>
                  <span className="topic-count">{count} 篇</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="panel panel-recent">
        <div className="recent-toolbar">
          <div className="recent-toolbar-head">
            <h2 className="panel-title">
              <BookOpen size={18} aria-hidden="true" />
              <span>{selectedFolder ? `${selectedFolder} · ` : ''}最近更新</span>
              <span className="badge">{visibleEntries.length}</span>
            </h2>
            <div className="recent-controls">
              <input
                type="search"
                className="recent-filter-input"
                placeholder="筛选标题或路径…"
                aria-label="筛选笔记列表"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() =>
                  setSortBy((prev) =>
                    prev === 'updated' ? 'title' : prev === 'title' ? 'size' : 'updated',
                  )
                }
                title="切换排序方式"
              >
                <ArrowDownUp size={13} />
                <span>
                  {sortBy === 'updated' ? '按更新时间' : sortBy === 'title' ? '按标题' : '按篇幅'}
                </span>
              </button>
            </div>
          </div>

          {allTags.length > 0 ? (
            <div className="home-tags" aria-label="按标签筛选">
              {allTags.slice(0, 14).map(([tag, count]) => {
                const active = selectedTag === tag;
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`home-tag-chip${active ? ' is-active' : ''}`}
                    onClick={() => setSelectedTag(active ? null : tag)}
                  >
                    <Tag size={11} />
                    <span>{tag}</span>
                    <span className="home-tag-count">{count}</span>
                  </button>
                );
              })}
              {selectedFolder || selectedTag || filterQuery ? (
                <button
                  type="button"
                  className="home-tag-clear"
                  onClick={() => {
                    setSelectedFolder(null);
                    setSelectedTag(null);
                    setFilterQuery('');
                  }}
                >
                  重置筛选
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {visibleEntries.length === 0 ? (
          <div className="state state-empty">
            <Sparkles size={18} />
            <p>当前筛选条件下没有匹配的笔记。</p>
            <div className="state-actions">
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => {
                  setSelectedFolder(null);
                  setSelectedTag(null);
                  setFilterQuery('');
                }}
              >
                显示全部笔记
              </button>
            </div>
          </div>
        ) : (
          <ul className="recent-list">
            {visibleEntries.map((entry) => {
              const parent = parentPath(entry.path);
              return (
                <li key={entry.path} className="recent-item">
                  <div className="recent-row">
                    <a className="recent-link" href={docUrl(entry.path)}>
                      <span className="recent-title">{entry.title || entry.path}</span>
                      <span className="recent-meta">
                        <span className="recent-date">
                          {formatDate(entry.updated) || '未标注时间'}
                        </span>
                        {parent ? <span className="recent-path muted">{parent}</span> : null}
                        <span className="recent-size muted">{formatSize(entry.size)}</span>
                        {(entry.tags ?? []).slice(0, 3).map((t) => (
                          <span key={t} className="recent-tag">
                            {t}
                          </span>
                        ))}
                      </span>
                    </a>
                    <a
                      className="recent-edit-btn"
                      href={editUrl(entry.path)}
                      title={`编辑「${entry.title || entry.path}」`}
                      aria-label={`编辑 ${entry.title || entry.path}`}
                    >
                      编辑
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export async function renderHome(): Promise<PageView> {
  const [treeResult, healthResult] = await Promise.allSettled([loadTree(), api.health()]);

  if (treeResult.status === 'rejected') {
    const errNode = apiErrorState(treeResult.reason, '目录加载失败', () => {
      window.dispatchEvent(new Event('kb:navigate'));
    });
    return {
      node: (() => {
        const main = document.createElement('main');
        main.className = 'main-column';
        main.appendChild(errNode);
        return main;
      })(),
      active: 'home',
      title: '私有知识库',
    };
  }

  const entries: TreeEntry[] = treeResult.value;
  const health: HealthResponse | null = healthResult.status === 'fulfilled' ? healthResult.value : null;

  return createReactPageView(<HomePageComponent entries={entries} health={health} />, {
    className: 'main-column',
    active: 'home',
    title: '私有知识库',
  });
}
