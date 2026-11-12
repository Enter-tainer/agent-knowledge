import 'highlight.js/styles/github.css';
import './styles/app.css';

import { api, IS_MOCK } from './api';
import { humanizeError } from './api/errors';
import { renderDoc } from './pages/doc';
import { renderEdit } from './pages/edit';
import { renderHome } from './pages/home';
import { renderReports } from './pages/reports';
import { renderSearch } from './pages/search';
import { parseRoute, startRouter } from './router';
import { el } from './ui/dom';
import { runPageTeardown } from './ui/lifecycle';
import { errorState, shell } from './ui/shell';

const appRoot = document.getElementById('app');
if (!appRoot) throw new Error('#app not found');
const app: HTMLElement = appRoot;

let renderSeq = 0;

function bootLoading(): HTMLElement {
  return el(
    'div',
    { class: 'boot-loading' },
    el('span', { class: 'spinner' }),
    el('span', { text: '加载中…' }),
  );
}

/** 未知路由也套正常 shell（有搜索框与导航），不要只有一个「回首页」。 */
function notFoundPage(): HTMLElement {
  document.title = '页面不存在 · 私有知识库';
  return shell({
    active: 'home',
    content: el(
      'div',
      { class: 'doc-page' },
      el(
        'div',
        { class: 'notfound' },
        el('h1', { class: 'doc-title', text: '页面不存在' }),
        el('p', { class: 'notfound-text', text: '这个地址没有对应的页面。可以用顶部搜索找笔记，或回目录。' }),
        el(
          'div',
          { class: 'notfound-actions' },
          el('a', { class: 'btn btn-primary', href: '/', text: '回目录' }),
        ),
      ),
    ),
  });
}

async function render(): Promise<void> {
  const seq = ++renderSeq;
  runPageTeardown();

  const route = parseRoute();

  try {
    app.replaceChildren(bootLoading());
    document.title = '私有知识库';

    let page: HTMLElement;
    switch (route.name) {
      case 'home':
        page = await renderHome();
        break;
      case 'doc':
        page = await renderDoc(route.path);
        break;
      case 'edit':
        page = await renderEdit(route.path, route.isNew);
        break;
      case 'search':
        page = await renderSearch(route.q);
        break;
      case 'reports':
        page = await renderReports();
        break;
      default:
        page = notFoundPage();
        break;
    }

    if (seq !== renderSeq) return;
    app.replaceChildren(page);
    if (location.hash) {
      // 深链带锚点（/d/x/#某节）：渲染后滚到目标标题，而不是回顶部
      const id = decodeURIComponent(location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      target?.scrollIntoView({ block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    app.replaceChildren(errorState('页面加载失败', humanizeError(err), () => void render()));
  }
}

startRouter(() => void render());

// 仅 dev：暴露 API 客户端，方便在控制台模拟「别人改过文件」验证冲突流程；build 时这段会被剔除。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__kb = { api, isMock: IS_MOCK };
}
