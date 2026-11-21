import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../src/api/mock';
import { ApiError } from '../src/api/errors';
import { renderDoc } from '../src/pages/doc';
import { renderEdit } from '../src/pages/edit';
import { renderHome } from '../src/pages/home';
import { renderReports } from '../src/pages/reports';
import { renderSearch } from '../src/pages/search';
import { getTheme, initTheme, setTheme, toggleTheme } from '../src/ui/theme';
import { buildTree, filterTree } from '../src/ui/tree-model';
import type { TreeEntry } from '../src/api/types';

function makeEntry(path: string, title: string, tags: string[] = []): TreeEntry {
  return { path, title, tags, size: 120, updated: '2026-11-15T00:00:00.000Z' };
}

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  setTheme('light');
});

describe('filterTree：目录树实时筛选', () => {
  const tree = buildTree([
    makeEntry('示例库/设备 A 逆向', '设备 A 逆向', ['BLE']),
    makeEntry('示例库/压感分析', '压感分析', ['笔输入']),
    makeEntry('数学笔记/线性代数', '线性代数推导', ['math']),
  ]);

  it('按标题、路径或标签过滤并保留必要祖先目录', () => {
    const byTag = filterTree(tree, 'BLE');
    expect(byTag).toHaveLength(1);
    expect(byTag[0]!.path).toBe('示例库');
    expect(byTag[0]!.children).toHaveLength(1);
    expect(byTag[0]!.children[0]!.path).toBe('示例库/设备 A 逆向');

    const byTitle = filterTree(tree, '推导');
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]!.path).toBe('数学笔记');

    const empty = filterTree(tree, '不存在的关键词xyz');
    expect(empty).toHaveLength(0);
  });

  it('空白关键词返回完整原树', () => {
    expect(filterTree(tree, '   ')).toBe(tree);
  });
});

describe('theme：深浅色主题切换', () => {
  it('读写 localStorage 与 document.documentElement.dataset.theme', () => {
    initTheme();
    expect(getTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    toggleTheme();
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('kb-theme')).toBe('dark');

    toggleTheme();
    expect(getTheme()).toBe('light');
    expect(window.localStorage.getItem('kb-theme')).toBe('light');
  });
});

describe('mockApi：删除、重解析双链与 stale 报告', () => {
  it('deleteDoc 有反链时返回 409，force=true 时可强制删除', async () => {
    const tmpPath = '测试/临时被引用文档';
    const refPath = '测试/临时引用方';
    await mockApi.putDoc(tmpPath, '# 临时被引用文档\n\n内容', '*');
    await mockApi.putDoc(refPath, '# 临时引用方\n\n参考 [[临时被引用文档]]', '*');

    await expect(mockApi.deleteDoc(tmpPath, false)).rejects.toMatchObject({
      status: 409,
    } satisfies Partial<ApiError>);

    const res = await mockApi.deleteDoc(tmpPath, true);
    expect(res.path).toBe(tmpPath);

    await mockApi.deleteDoc(refPath, true);
  });

  it('resolveLinks 与 reportStale 返回契约结构', async () => {
    const linksRes = await mockApi.resolveLinks();
    expect(linksRes.total).toBeGreaterThanOrEqual(0);
    expect(linksRes.unresolved).toBeGreaterThanOrEqual(0);

    const staleRes = await mockApi.reportStale();
    expect(staleRes.count).toBe(0);
    expect(staleRes.stale).toEqual([]);
  });
});

describe('React PageViews：同步挂载与核心交互元素', () => {
  it('renderDoc 同步渲染正文、代码块复制顶栏、KaTeX 公式与右侧大纲', async () => {
    const mathDocPath = '测试/公式与代码';
    await mockApi.putDoc(
      mathDocPath,
      '---\ntitle: "公式与代码"\ntags: [math]\n---\n# 公式与代码\n\n## 第一节\n\n行内 $x^2 + y^2 = z^2$。\n\n$$\n\\sum_{i=1}^n i\n$$\n\n## 第二节\n\n```ts\nconst a = 1;\n```\n',
      '*',
    );

    const view = await renderDoc(mathDocPath);
    try {
      expect(view.active).toBe('doc');
      expect(view.currentPath).toBe(mathDocPath);
      expect(view.node.querySelector('.doc-title')?.textContent).toBe('公式与代码');
      expect(view.node.querySelector('.math-inline .katex')).not.toBeNull();
      expect(view.node.querySelector('.math-block .katex-display')).not.toBeNull();
      expect(view.node.querySelector('.code-wrap .code-copy-btn')).not.toBeNull();
      expect(view.node.querySelectorAll('.toc-aside-link').length).toBe(2);
    } finally {
      view.onTeardown?.();
      await mockApi.deleteDoc(mathDocPath, true);
    }
  });

  it('renderHome 渲染知识库概览、分类卡片与最近更新列表', async () => {
    const view = await renderHome();
    try {
      expect(view.active).toBe('home');
      expect(view.node.classList.contains('main-column')).toBe(true);
      expect(view.node.querySelectorAll('.recent-item').length).toBeGreaterThanOrEqual(5);
      expect(view.node.querySelector('.home-topics')).not.toBeNull();
    } finally {
      view.onTeardown?.();
    }
  });

  it('renderSearch 支持空提示与关键词检索', async () => {
    const emptyView = await renderSearch('');
    expect(emptyView.node.classList.contains('search-page')).toBe(true);
    expect(emptyView.node.querySelectorAll('.chip').length).toBeGreaterThan(0);
    emptyView.onTeardown?.();

    const hitView = await renderSearch('压感');
    expect(hitView.node.querySelectorAll('.search-hit').length).toBeGreaterThan(0);
    hitView.onTeardown?.();
  });

  it('renderReports 渲染 3 张健康指标卡与运维按钮', async () => {
    const view = await renderReports();
    try {
      expect(view.active).toBe('reports');
      expect(view.node.querySelectorAll('.metric-card').length).toBe(3);
      expect(view.node.querySelector('.reports-admin-actions')).not.toBeNull();
    } finally {
      view.onTeardown?.();
    }
  });

  it('renderEdit 保持宽版无侧边栏契约并包含工具栏与标签栏', async () => {
    const view = await renderEdit('示例索引', false);
    try {
      expect(view.active).toBe('edit');
      expect(view.showSidebar).toBe(false);
      expect(view.wide).toBe(true);
      expect(view.node.querySelector('.edit-toolbar')).not.toBeNull();
      expect(view.node.querySelector('.edit-tags-bar')).not.toBeNull();
      expect(view.node.querySelector('textarea.edit-textarea')).not.toBeNull();
      expect(view.node.querySelector('.edit-preview')).not.toBeNull();
    } finally {
      view.onTeardown?.();
      vi.clearAllTimers();
    }
  });
});
