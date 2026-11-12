import { api } from '../api';
import type { LinksReport, OrphansResponse, UnresolvedReport } from '../api/types';
import { humanizeError } from '../api/errors';
import { docUrl } from '../router';
import { el, parentPath } from '../ui/dom';
import { shell } from '../ui/shell';

/** `/reports`：断链 + 无入链。两个区块各自可重试，不再整页一句 internal error。 */
export async function renderReports(): Promise<HTMLElement> {
  document.title = '报告 · 私有知识库';
  const main = el('main', { class: 'reports-page' }, el('h1', { class: 'page-title', text: '报告' }));
  const linksBox = el('section', { class: 'report-section' });
  const orphansBox = el('section', { class: 'report-section' });
  main.append(linksBox, orphansBox);

  async function loadLinks(): Promise<void> {
    linksBox.replaceChildren(loadingBlock('正在检查断链…'));
    try {
      const report = await api.reportLinks(true);
      linksBox.replaceChildren(unresolvedSection(asUnresolved(report)));
    } catch (err) {
      linksBox.replaceChildren(
        sectionError('断链检查失败', err, () => void loadLinks()),
      );
    }
  }

  async function loadOrphans(): Promise<void> {
    orphansBox.replaceChildren(loadingBlock('正在统计无入链笔记…'));
    try {
      const report: OrphansResponse = await api.orphans();
      orphansBox.replaceChildren(orphansSection(report));
    } catch (err) {
      orphansBox.replaceChildren(
        sectionError('无入链统计失败', err, () => void loadOrphans()),
      );
    }
  }

  await Promise.all([loadLinks(), loadOrphans()]);
  return shell({ active: 'reports', content: main });
}

function loadingBlock(text: string): HTMLElement {
  return el('div', { class: 'report-loading' }, el('span', { class: 'spinner' }), el('span', { text }));
}

function sectionError(title: string, err: unknown, retry: () => void): HTMLElement {
  return el(
    'div',
    { class: 'report-error', role: 'alert' },
    el('h2', { class: 'panel-title', text: title }),
    el('p', { class: 'report-error-text', text: humanizeError(err) }),
    el('button', { type: 'button', class: 'btn btn-primary', text: '重试', onclick: retry }),
  );
}

function asUnresolved(report: LinksReport): UnresolvedReport {
  return 'unresolved' in report ? report : { unresolved: [], count: 0 };
}

function unresolvedSection(data: UnresolvedReport): HTMLElement {
  const items = data.unresolved ?? [];
  const section = el(
    'div',
    { class: 'panel' },
    el(
      'h2',
      { class: 'panel-title' },
      '断链',
      el('span', { class: 'badge', text: String(items.length) }),
    ),
    el('p', {
      class: 'panel-hint',
      text: '这些笔记里指向的页面不存在了（可能被改名或删除）。',
    }),
  );

  if (items.length === 0) {
    section.appendChild(el('p', { class: 'panel-hint ok', text: '没有断链，所有链接都能打开。' }));
    return section;
  }

  const list = el('ul', { class: 'report-list' });
  for (const item of items) {
    list.appendChild(
      el(
        'li',
        { class: 'report-item' },
        el(
          'div',
          { class: 'report-main' },
          el('a', { class: 'link-title', href: docUrl(item.src), text: item.title || item.src }),
        ),
        el(
          'div',
          { class: 'report-detail' },
          el('span', { class: 'muted', text: '指向：' }),
          el('span', { class: 'link-broken', text: item.target }),
        ),
        el('div', { class: 'report-path muted', text: parentPath(item.src) }),
      ),
    );
  }
  section.appendChild(list);
  return section;
}

function orphansSection(data: OrphansResponse): HTMLElement {
  const items = data.orphans ?? [];
  const section = el(
    'div',
    { class: 'panel' },
    el(
      'h2',
      { class: 'panel-title' },
      '无入链',
      el('span', { class: 'badge', text: String(items.length) }),
    ),
    el('p', {
      class: 'panel-hint',
      text: '没有任何别的笔记链接到它们，通常意味着从目录里不容易被发现。',
    }),
  );

  if (items.length === 0) {
    section.appendChild(el('p', { class: 'panel-hint ok', text: '所有笔记都有别的笔记链接到。' }));
    return section;
  }

  const list = el('ul', { class: 'report-list' });
  for (const item of items) {
    list.appendChild(
      el(
        'li',
        { class: 'report-item' },
        el(
          'div',
          { class: 'report-main' },
          el('a', { class: 'link-title', href: docUrl(item.path), text: item.title || item.path }),
        ),
        el('div', { class: 'report-path muted', text: parentPath(item.path) }),
      ),
    );
  }
  section.appendChild(list);
  return section;
}

