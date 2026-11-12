import { api } from '../api';
import type { SearchResponse } from '../api/types';
import { cleanSnippet, el, markHighlights, parentPath } from '../ui/dom';
import { apiErrorState, emptyState, shell } from '../ui/shell';
import { docUrl, navigate } from '../router';

const MIN_QUERY_LEN = 2;
const SAMPLE_QUERIES = ['压感', '双链', '固件', '内购'];

/** `/search?q=`：结果列表（标题 + 所在小节 + 摘要 <mark>），空结果 / 太短都有出路。 */
export async function renderSearch(query: string): Promise<HTMLElement> {
  const q = query.trim();

  if (q.length < MIN_QUERY_LEN) {
    document.title = '搜索 · 私有知识库';
    const actions: HTMLElement[] = [el('a', { class: 'btn btn-primary', href: '/', text: '回目录' })];
    if (q.length > 0) {
      actions.push(
        el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: '清空重搜',
          onclick: () => {
            const input = document.querySelector<HTMLInputElement>('.search-input');
            if (input) {
              input.value = '';
              input.focus();
            }
            void navigate('/search');
          },
        }),
      );
    }
    const content = el(
      'main',
      { class: 'search-page' },
      el('h1', { class: 'page-title', text: '搜索' }),
      emptyState(
        q.length === 0
          ? '输入关键词就能搜索全部笔记。中文至少输入 2 个字。'
          : `「${q}」太短了，再输入一个字试试。中文至少输入 2 个字才能搜到。`,
        actions,
      ),
      el(
        'div',
        { class: 'samples' },
        el('span', { class: 'muted', text: '试试这些：' }),
        ...SAMPLE_QUERIES.map((sample) =>
          el('a', { class: 'chip', href: `/search?q=${encodeURIComponent(sample)}`, text: sample }),
        ),
      ),
    );
    return shell({ active: 'search', searchQuery: query, content });
  }

  let data: SearchResponse;
  try {
    data = await api.search(q, 10);
  } catch (err) {
    return shell({
      active: 'search',
      searchQuery: query,
      content: apiErrorState(err, '搜索失败', () => {
        window.dispatchEvent(new Event('kb:navigate'));
      }),
    });
  }

  document.title = `搜索「${q}」 · 私有知识库`;
  const results = data.results ?? [];
  const content = el(
    'main',
    { class: 'search-page' },
    el('h1', { class: 'page-title', text: `搜索「${q}」` }),
    el('p', { class: 'page-subtitle muted', text: results.length ? `共 ${results.length} 条结果，按相关度排序` : '' }),
  );

  if (results.length === 0) {
    content.appendChild(
      emptyState(`没有找到包含「${q}」的笔记。换个更短或更常见的词试试。`, [
        el('a', { class: 'btn btn-primary', href: '/', text: '回目录' }),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost',
            text: '清空重搜',
            onclick: () => {
              const input = document.querySelector<HTMLInputElement>('.search-input');
              if (input) {
                input.value = '';
                input.focus();
              }
              void navigate('/search');
            },
          },
        ),
      ]),
    );
    return shell({ active: 'search', searchQuery: query, content });
  }

  const list = el('ul', { class: 'search-list' });
  for (const hit of results) {
    const cleaned = cleanSnippet(hit.snippet ?? '');
    // 摘要跟标题一样（后端把 frontmatter/标题切进了 chunk）就不重复显示
    const snippetHtml =
      cleaned.length >= 12 && cleaned !== (hit.title ?? '') ? markHighlights(cleaned, hit.highlights ?? []) : '';
    list.appendChild(
      el(
        'li',
        { class: 'search-hit' },
        el(
          'a',
          { class: 'search-hit-link', href: docUrl(hit.path) },
          el(
            'span',
            { class: 'search-hit-head' },
            el('span', { class: 'search-hit-title', text: hit.title || hit.path }),
            hit.heading
              ? el('span', { class: 'search-hit-heading muted', text: `· ${hit.heading}` })
              : null,
          ),
          snippetHtml
            ? el('span', { class: 'search-hit-snippet', html: snippetHtml })
            : el('span', {
                class: 'search-hit-snippet muted',
                text: `只在标题里出现了「${q}」 · ${parentPath(hit.path) || '根目录'}`,
              }),

        ),
      ),
    );
  }
  content.appendChild(list);

  return shell({ active: 'search', searchQuery: query, content });
}
