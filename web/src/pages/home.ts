import { api } from '../api';
import type { HealthResponse, TreeEntry } from '../api/types';
import { humanizeError } from '../api/errors';
import { loadTree } from '../store';
import { docUrl, navigate } from '../router';
import { el, formatDate, parentPath } from '../ui/dom';
import { apiErrorState, toast } from '../ui/shell';
import type { PageView } from '../ui/view';

/**
 * `/`：最近更新（顺带显示索引是否落后）。
 *
 * 目录侧边栏、移动端「☰ 目录」按钮与抽屉都由 layout + sidebar 统一提供，这里不再自建
 * （见 docs/web-nav-sidebar-acceptance.md §2：侧边栏要在所有页面常驻且 DOM 身份不变）。
 */
export async function renderHome(): Promise<PageView> {
  const [treeResult, healthResult] = await Promise.allSettled([loadTree(), api.health()]);

  if (treeResult.status === 'rejected') {
    return {
      node: el(
        'main',
        { class: 'main-column' },
        apiErrorState(treeResult.reason, '目录加载失败', () => {
          // SPA 内重试：重新走一次渲染，不整页刷新
          window.dispatchEvent(new Event('kb:navigate'));
        }),
      ),
      active: 'home',
      title: '私有知识库',
    };
  }

  const entries: TreeEntry[] = treeResult.value;
  const health: HealthResponse | null = healthResult.status === 'fulfilled' ? healthResult.value : null;

  const recent = [...entries].sort((a, b) => timeOf(b.updated) - timeOf(a.updated));
  const list = el('ul', { class: 'recent-list' });
  for (const entry of recent) {
    list.appendChild(recentItem(entry));
  }

  const node = el(
    'main',
    { class: 'main-column' },
    el(
      'section',
      { class: 'panel panel-recent' },
      el('h1', { class: 'panel-title', text: '最近更新' }),
      el('p', { class: 'panel-hint', text: '全部笔记按更新时间倒序。点标题阅读，顶部可搜索。' }),
      health?.stale ? staleNotice(health.stale) : null,
      list,
    ),
  );

  return { node, active: 'home', title: '私有知识库' };
}

function staleNotice(stale: number): HTMLElement {
  const button = el('button', {
    type: 'button',
    class: 'btn btn-small btn-primary',
    text: '重建索引',
    onclick: async () => {
      button.disabled = true;
      button.textContent = '重建中…';
      try {
        const result = await api.reindex();
        toast(result.stale === 0 ? '搜索索引已重建完成' : `索引仍落后 ${result.stale} 篇，请稍后再试`, result.stale === 0 ? 'success' : 'error');
        await navigate('/', { replace: true });
      } catch (err) {
        toast(`重建失败：${humanizeError(err)}`, 'error');
        button.disabled = false;
        button.textContent = '重建索引';
      }
    },
  });

  return el(
    'div',
    { class: 'notice', role: 'status' },
    el(
      'div',
      { class: 'notice-text' },
      el('strong', { text: `有 ${stale} 篇笔记还没进搜索` }),
      el('span', { text: '。重建索引后就能搜到它们，只处理索引，不改笔记内容。' }),
    ),
    button,
  );
}

function timeOf(value: string): number {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function recentItem(entry: TreeEntry): HTMLElement {
  const parent = parentPath(entry.path);
  return el(
    'li',
    { class: 'recent-item' },
    el(
      'a',
      { class: 'recent-link', href: docUrl(entry.path) },
      el('span', { class: 'recent-title', text: entry.title || entry.path }),
      el(
        'span',
        { class: 'recent-meta' },
        el('span', { class: 'recent-date', text: formatDate(entry.updated) || '未标注时间' }),
        parent ? el('span', { class: 'recent-path muted', text: parent }) : null,
      ),
    ),
  );
}
