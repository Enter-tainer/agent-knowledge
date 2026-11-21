import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';
import './styles/app.css';

import { api, IS_MOCK } from './api';
import { humanizeError } from './api/errors';
import { renderDoc } from './pages/doc';
import { renderEdit } from './pages/edit';
import { renderHome } from './pages/home';
import { renderReports } from './pages/reports';
import { renderSearch } from './pages/search';
import { parseRoute, startRouter, type Route } from './router';
import { mountGlobalCommandPalette } from './ui/commandPalette';
import { el } from './ui/dom';
import { layout } from './ui/layout';
import { runPageTeardown } from './ui/lifecycle';
import { createSidebar } from './ui/sidebar';
import { initTheme } from './ui/theme';
import type { NavInfo, PageView } from './ui/view';

let renderSeq = 0;

function notFoundView(): PageView {
  return {
    active: 'home',
    title: '页面不存在 · 私有知识库',
    showSidebar: true,
    node: el(
      'main',
      { class: 'doc-page' },
      el(
        'div',
        { class: 'notfound' },
        el('h1', { class: 'doc-title', text: '页面不存在' }),
        el('p', {
          class: 'notfound-text',
          text: '这个地址没有对应的页面。可以用顶部搜索或 ⌘K 找笔记，或回目录。',
        }),
        el('div', { class: 'notfound-actions' }, el('a', { class: 'btn btn-primary', href: '/', text: '回目录' })),
      ),
    ),
  };
}

function viewFor(route: Route): Promise<PageView> | PageView {
  switch (route.name) {
    case 'home':
      return renderHome();
    case 'doc':
      return renderDoc(route.path);
    case 'edit':
      return renderEdit(route.path, route.isNew);
    case 'search':
      return renderSearch(route.q);
    case 'reports':
      return renderReports();
    default:
      return notFoundView();
  }
}

async function render(nav: NavInfo): Promise<void> {
  const seq = ++renderSeq;
  runPageTeardown();
  layout.setBusy(true);

  try {
    const view = await viewFor(parseRoute());
    if (seq !== renderSeq) return;
    layout.show(view, nav);
  } catch (err) {
    if (seq !== renderSeq) return;
    layout.showError('页面加载失败', humanizeError(err), () => {
      window.dispatchEvent(new Event('kb:navigate'));
    });
  } finally {
    if (seq === renderSeq) layout.setBusy(false);
  }
}

interface BootProbeWindow extends Window {
  __kbBootAt?: number;
}
(window as BootProbeWindow).__kbBootAt = Date.now();

initTheme();
const sidebar = createSidebar();
layout.mount({ sidebar });
mountGlobalCommandPalette();
layout.showBoot();
startRouter((nav) => void render(nav));

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__kb = { api, isMock: IS_MOCK };
}
