import 'highlight.js/styles/github.css';
import './styles/app.css';

import { api, IS_MOCK } from './api';
import { humanizeError } from './api/errors';
import { renderDoc } from './pages/doc';
import { renderEdit } from './pages/edit';
import { renderHome } from './pages/home';
import { renderReports } from './pages/reports';
import { renderSearch } from './pages/search';
import { parseRoute, startRouter, type Route } from './router';
import { el } from './ui/dom';
import { layout } from './ui/layout';
import { runPageTeardown } from './ui/lifecycle';
import { createSidebar } from './ui/sidebar';
import type { NavInfo, PageView } from './ui/view';

let renderSeq = 0;

/** 未知路由也套持久 shell（有搜索框与侧边栏），不要只有一个「回首页」。 */
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
          text: '这个地址没有对应的页面。可以用顶部搜索找笔记，或回目录。',
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

const sidebar = createSidebar();
layout.mount({ sidebar });
layout.showBoot();
startRouter((nav) => void render(nav));

// 仅 dev：暴露 API 客户端，方便在控制台模拟「别人改过文件」验证冲突流程；build 时这段会被剔除。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__kb = { api, isMock: IS_MOCK };
}
