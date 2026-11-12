import { api } from '../api';
import type { HealthResponse, TreeEntry } from '../api/types';
import { humanizeError } from '../api/errors';
import { loadTree } from '../store';
import { docUrl, navigate } from '../router';
import { el, formatDate, parentPath } from '../ui/dom';
import { apiErrorState, shell, toast } from '../ui/shell';
import { buildTree, countDocs, renderTree } from '../ui/tree';

/** `/`：左侧可折叠路径树 + 右侧最近更新（顺带显示索引是否落后）。 */
export async function renderHome(): Promise<HTMLElement> {
  const [treeResult, healthResult] = await Promise.allSettled([loadTree(), api.health()]);

  if (treeResult.status === 'rejected') {
    return shell({
      active: 'home',
      content: apiErrorState(treeResult.reason, '目录加载失败', () => location.reload()),
    });
  }

  const entries: TreeEntry[] = treeResult.value;
  const health: HealthResponse | null = healthResult.status === 'fulfilled' ? healthResult.value : null;
  const nodes = buildTree(entries);
  const total = countDocs(nodes);
  const isMobile = window.matchMedia('(max-width: 860px)').matches;

  const sidebar = el(
    'aside',
    { class: 'sidebar', 'aria-label': '目录' },
    el(
      'div',
      { class: 'sidebar-head' },
      el('span', { text: '目录' }),
      el('span', { class: 'muted', text: `${total} 篇` }),
    ),
    el('div', { class: 'sidebar-body' }, renderTree(nodes)),
  );

  const main = el('main', { class: 'main-column' });

  // 手机：目录改成抽屉，避免「一展开 4500px，收起入口滚出屏幕」
  if (isMobile) {
    main.appendChild(
      el('button', {
        type: 'button',
        class: 'tree-open-btn',
        onclick: () => openTreeDrawer(nodes, total),
      }, el('span', { class: 'tree-open-icon', 'aria-hidden': 'true', text: '☰' }), el('span', { text: `目录 · ${total} 篇` })),
    );
  }

  const recent = [...entries].sort((a, b) => timeOf(b.updated) - timeOf(a.updated));
  const list = el('ul', { class: 'recent-list' });
  for (const entry of recent) {
    list.appendChild(recentItem(entry));
  }

  main.appendChild(
    el(
      'section',
      { class: 'panel panel-recent' },
      el('h1', { class: 'panel-title', text: '最近更新' }),
      el('p', { class: 'panel-hint', text: '全部笔记按更新时间倒序。点标题阅读，顶部可搜索。' }),
      health?.stale ? staleNotice(health.stale) : null,
      list,
    ),
  );

  return shell({
    active: 'home',
    content: el('div', { class: 'home-grid' }, isMobile ? null : sidebar, main),
  });
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

function openTreeDrawer(nodes: ReturnType<typeof buildTree>, total: number): void {
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;

  const closeBtn = el('button', {
    type: 'button',
    class: 'btn btn-ghost',
    text: '关闭',
    'aria-label': '关闭目录',
    onclick: () => close(),
  });

  const tree = renderTree(nodes, undefined, { startCollapsed: true });
  const panel = el(
    'div',
    { class: 'tree-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '目录' },
    el(
      'div',
      { class: 'tree-drawer-head' },
      el('div', { class: 'tree-drawer-title' }, el('span', { text: '目录' }), el('span', { class: 'muted', text: `${total} 篇` })),
      closeBtn,
    ),
    el('div', { class: 'tree-drawer-body' }, tree),
  );
  const overlay = el('div', { class: 'tree-drawer-overlay', role: 'presentation' }, panel);

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('kb:navigate', close);
    document.documentElement.classList.remove('no-scroll');
    overlay.remove();
    previousFocus?.focus?.();
  }

  // 点笔记/目录链接后立即收起抽屉（导航交给 router，不阻止默认行为）；SPA 导航事件兜底
  panel.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('a[href]')) close();
  });
  // 点遮罩关闭
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('kb:navigate', close);

  document.documentElement.classList.add('no-scroll');
  document.addEventListener('keydown', onKeydown, true);
  document.body.appendChild(overlay);
  closeBtn.focus();
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
