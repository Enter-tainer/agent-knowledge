import { Edit3, Folder, Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { humanizeError } from '../api/errors';
import type { SearchHit } from '../api/types';
import { docUrl, editUrl, navigate, searchUrl } from '../router';
import { cleanSnippet, markHighlights, parentPath } from '../ui/dom';
import { createReactPageView } from '../ui/react-view';
import type { PageView } from '../ui/view';

const MIN_QUERY_LEN = 2;
const SAMPLE_QUERIES = ['压感', '双链', '固件', '内购'];

function SearchPageComponent({
  query,
  results,
  error,
}: {
  query: string;
  results: SearchHit[];
  error?: unknown;
}) {
  const q = query.trim();
  const [draft, setDraft] = useState(query);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);

  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of results) {
      const top = hit.path.includes('/') ? hit.path.split('/')[0]! : '根目录';
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [results]);

  const visibleResults = useMemo(() => {
    if (!folderFilter) return results;
    return results.filter((hit) => {
      const top = hit.path.includes('/') ? hit.path.split('/')[0]! : '根目录';
      return top === folderFilter;
    });
  }, [results, folderFilter]);

  const submitInPage = (event: React.FormEvent): void => {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return;
    void navigate(searchUrl(next), { replace: true, force: true });
  };

  if (error) {
    return (
      <div className="state state-error">
        <h2>搜索失败</h2>
        <p className="state-detail">{humanizeError(error)}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.dispatchEvent(new Event('kb:navigate'))}
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="search-wrap">
      <div className="search-header">
        <h1 className="page-title">{q ? `搜索「${q}」` : '搜索笔记'}</h1>
        <form className="search-inline-form" onSubmit={submitInPage}>
          <Search size={16} className="search-inline-icon" aria-hidden="true" />
          <input
            type="search"
            className="search-inline-input"
            placeholder="输入关键词全文搜索（至少 2 个字）…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-small">
            搜索
          </button>
        </form>
      </div>

      {q.length < MIN_QUERY_LEN ? (
        <div className="search-empty-wrap">
          <div className="state state-empty">
            <p>
              {q.length === 0
                ? '输入关键词就能全文搜索全部笔记（支持标题、正文与代码片段）。中文至少输入 2 个字。'
                : `「${q}」太短了，再输入一个字试试。中文至少输入 2 个字才能搜到。`}
            </p>
            <div className="state-actions">
              <a className="btn btn-primary" href="/">
                回目录
              </a>
              {q.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setDraft('');
                    const input = document.querySelector<HTMLInputElement>('.search-input');
                    if (input) input.value = '';
                    void navigate('/search');
                  }}
                >
                  清空重搜
                </button>
              ) : null}
            </div>
          </div>
          <div className="samples">
            <span className="muted">试试这些热门词：</span>
            {SAMPLE_QUERIES.map((sample) => (
              <a key={sample} className="chip" href={searchUrl(sample)}>
                {sample}
              </a>
            ))}
          </div>
        </div>
      ) : results.length === 0 ? (
        <div className="state state-empty">
          <Sparkles size={18} />
          <p>没有找到包含「{q}」的笔记。可以换个更短的词，或按 ⌘K 模糊匹配标题。</p>
          <div className="state-actions">
            <a className="btn btn-primary" href="/">
              回目录
            </a>
            <a className="btn btn-ghost" href={editUrl(q, true)}>
              新建「{q}」笔记
            </a>
          </div>
        </div>
      ) : (
        <>
          <div className="search-meta-bar">
            <p className="page-subtitle muted">
              共 {results.length} 条结果，按相关度排序
            </p>
            {folders.length > 1 ? (
              <div className="search-folder-pills">
                <button
                  type="button"
                  className={`dir-chip${folderFilter === null ? ' is-active' : ''}`}
                  onClick={() => setFolderFilter(null)}
                >
                  全部 ({results.length})
                </button>
                {folders.map(([folder, count]) => (
                  <button
                    key={folder}
                    type="button"
                    className={`dir-chip${folderFilter === folder ? ' is-active' : ''}`}
                    onClick={() => setFolderFilter(folderFilter === folder ? null : folder)}
                  >
                    <Folder size={12} />
                    <span>{folder} ({count})</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <ul className="search-list">
            {visibleResults.map((hit, idx) => {
              const cleaned = cleanSnippet(hit.snippet ?? '');
              const snippetHtml =
                cleaned.length >= 12 && cleaned !== (hit.title ?? '')
                  ? markHighlights(cleaned, hit.highlights ?? [])
                  : '';
              const parent = parentPath(hit.path);
              return (
                <li key={`${hit.path}-${idx}`} className="search-hit">
                  <div className="search-hit-card">
                    <a className="search-hit-link" href={docUrl(hit.path)}>
                      <span className="search-hit-head">
                        <span className="search-hit-title">{hit.title || hit.path}</span>
                        {hit.heading ? (
                          <span className="search-hit-heading muted">· § {hit.heading}</span>
                        ) : null}
                      </span>
                      {snippetHtml ? (
                        <span
                          className="search-hit-snippet"
                          dangerouslySetInnerHTML={{ __html: snippetHtml }}
                        />
                      ) : (
                        <span className="search-hit-snippet muted">
                          在标题中命中「{q}」{parent ? ` · ${parent}` : ''}
                        </span>
                      )}
                      {parent ? <span className="search-hit-path muted">{parent}</span> : null}
                    </a>
                    <a
                      className="search-hit-edit"
                      href={editUrl(hit.path)}
                      title={`编辑「${hit.title || hit.path}」`}
                      aria-label={`编辑 ${hit.title || hit.path}`}
                    >
                      <Edit3 size={14} />
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export async function renderSearch(query: string): Promise<PageView> {
  const q = query.trim();

  if (q.length < MIN_QUERY_LEN) {
    return createReactPageView(<SearchPageComponent query={query} results={[]} />, {
      className: 'search-page',
      active: 'search',
      title: '搜索 · 私有知识库',
      searchQuery: query,
    });
  }

  try {
    const data = await api.search(q, 20);
    return createReactPageView(
      <SearchPageComponent query={query} results={data.results ?? []} />,
      {
        className: 'search-page',
        active: 'search',
        title: `搜索「${q}」 · 私有知识库`,
        searchQuery: query,
      },
    );
  } catch (err) {
    return createReactPageView(<SearchPageComponent query={query} results={[]} error={err} />, {
      className: 'search-page',
      active: 'search',
      title: '搜索 · 私有知识库',
      searchQuery: query,
    });
  }
}
