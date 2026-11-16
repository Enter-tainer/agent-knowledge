/**
 * 目录树数据层 + 合并行的渲染契约测试。
 *
 * 对应验收条款：
 * - B8「同名目录 + 笔记合并为一行」：vault 里 `示例库.md` 与 `示例库/` 同名，
 *   侧边栏只能出现一行；点名称打开笔记、点右侧箭头展开子目录。
 * - B2 祖先目录自动展开、B7 总篇数不重复计数。
 */

import { describe, expect, it, vi } from 'vitest';

import type { TreeEntry } from '../src/api/types';
import { renderTree } from '../src/ui/tree';
import {
  ancestorsOf,
  buildTree,
  collectDocs,
  collectDirPaths,
  countDocs,
  findDoc,
  mergeOpenPaths,
  type TreeNode,
} from '../src/ui/tree-model';

function entry(path: string, title = path.split('/').pop() ?? path): TreeEntry {
  return { path, title, tags: [], size: 1, updated: '2026-11-14T00:00:00.000Z' };
}

/** 复刻真实语料的关键形状：同名目录+笔记、嵌套同名、纯目录、纯文档。 */
const ENTRIES: TreeEntry[] = [
  entry('示例库'),
  entry('示例库/设备甲逆向'),
  entry('示例库/设备甲逆向/协议与数据格式'),
  entry('示例库/设备甲逆向/固件与模块'),
  entry('示例库/手柄固件逆向'),
  entry('知识库总览'),
  entry('索引与约定'),
  entry('README'),
];

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

describe('buildTree：同名「目录 + 笔记」合并', () => {
  const tree = buildTree(ENTRIES);

  it('同名节点只出现一行，且该行是目录节点并带上笔记', () => {
    const all = flatten(tree);
    const named = all.filter((node) => node.path === '示例库');
    expect(named).toHaveLength(1);
    expect(named[0]!.kind).toBe('dir');
    expect(named[0]!.doc?.path).toBe('示例库');
    expect(named[0]!.children.length).toBeGreaterThan(0);
  });

  it('嵌套同名（示例库/设备甲逆向…）同样合并，且不会重复出现文档行', () => {
    const all = flatten(tree);
    const nested = all.filter((node) => node.path === '示例库/设备甲逆向');
    expect(nested).toHaveLength(1);
    expect(nested[0]!.kind).toBe('dir');
    expect(nested[0]!.doc?.path).toBe('示例库/设备甲逆向');
  });

  it('没有同名笔记的目录保持纯目录（doc 为空）', () => {
    const all = flatten(tree);
    // 纯目录由子路径推导；本 fixture 里每个目录都有同名笔记，这里用一个临时 fixture 验证
    const pure = buildTree([entry('A/B/C')]);
    const dirA = pure.find((node) => node.path === 'A');
    expect(dirA?.kind).toBe('dir');
    expect(dirA?.doc).toBeUndefined();
    expect(all.some((node) => node.kind === 'dir' && node.path === 'A')).toBe(false);
  });

  it('总篇数不因合并而重复计数', () => {
    expect(countDocs(tree)).toBe(ENTRIES.length);
  });

  it('合并的笔记仍可被 findDoc / collectDocs 找到', () => {
    expect(findDoc(tree, '示例库')?.kind).toBe('dir');
    expect(findDoc(tree, '示例库/设备甲逆向')?.doc?.path).toBe('示例库/设备甲逆向');
    const docs = collectDocs(tree).map((node) => node.path);
    expect(new Set(docs).size).toBe(docs.length);
    expect(docs).toContain('示例库');
    expect(docs).toContain('示例库/手柄固件逆向');
  });

  it('同一层内目录在前、文档在后', () => {
    const kinds = tree.map((node) => node.kind);
    const firstDoc = kinds.indexOf('doc');
    if (firstDoc !== -1) expect(kinds.slice(firstDoc).every((kind) => kind === 'doc')).toBe(true);
  });
});

describe('ancestorsOf / mergeOpenPaths / collectDirPaths', () => {
  const tree = buildTree(ENTRIES);

  it('ancestorsOf 返回祖先目录链', () => {
    expect(ancestorsOf('示例库/设备甲逆向/协议与数据格式')).toEqual([
      '示例库',
      '示例库/设备甲逆向',
    ]);
    expect(ancestorsOf('README')).toEqual([]);
    expect(ancestorsOf(undefined)).toEqual([]);
  });

  it('collectDirPaths 只收目录', () => {
    expect([...collectDirPaths(tree)].sort()).toEqual(
      ['示例库', '示例库/设备甲逆向'].sort(),
    );
  });

  it('mergeOpenPaths：保留仍存在的目录，丢掉已消失的，并强制展开当前文档祖先', () => {
    const previous = new Set(['示例库', '已经不存在的目录']);
    const merged = mergeOpenPaths(previous, tree, '示例库/设备甲逆向/协议与数据格式');
    expect(merged.has('示例库')).toBe(true);
    expect(merged.has('已经不存在的目录')).toBe(false);
    expect(merged.has('示例库/设备甲逆向')).toBe(true);
  });

  it('mergeOpenPaths：没有 currentPath 时不动用户展开状态', () => {
    const merged = mergeOpenPaths(new Set(['示例库/设备甲逆向']), tree);
    expect([...merged]).toEqual(['示例库/设备甲逆向']);
  });
});

describe('renderTree：合并行 DOM 契约（B8）', () => {
  const tree = buildTree(ENTRIES);

  function mergedRow(root: HTMLElement, path: string): HTMLElement {
    const row = [...root.querySelectorAll<HTMLElement>('.tree-dir-row')].find(
      (node) => node.dataset.dirPath === path,
    );
    if (!row) throw new Error(`merged row not found: ${path}`);
    return row;
  }

  it('同名路径只有一个文档链接（可点击打开），且箭头在行尾', () => {
    const root = renderTree(tree);
    const links = root.querySelectorAll<HTMLAnchorElement>('a.tree-doc[data-doc-path="示例库"]');
    expect(links).toHaveLength(1);
    const href = links[0]!.getAttribute('href');
    expect(href).toBe(`/d/${encodeURIComponent('示例库')}/`);

    const row = mergedRow(root, '示例库');
    const toggle = row.querySelector<HTMLButtonElement>('.tree-dir-toggle');
    expect(toggle).not.toBeNull();
    expect(row.lastElementChild).toBe(toggle);
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
  });

  it('箭头控制子列表显隐并回调 onToggle（不触发导航）', () => {
    const onToggle = vi.fn();
    const root = renderTree(tree, { onToggle });
    const row = mergedRow(root, '示例库');
    const toggle = row.querySelector<HTMLButtonElement>('.tree-dir-toggle')!;
    const list = root.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!;
    expect(list.hidden).toBe(true);

    toggle.click();
    expect(list.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(onToggle).toHaveBeenCalledWith('示例库', true);

    toggle.click();
    expect(list.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(onToggle).toHaveBeenLastCalledWith('示例库', false);
  });

  it('「N 篇」徽标也是展开/收起按钮，点击与箭头等价', () => {
    const onToggle = vi.fn();
    const root = renderTree(tree, { onToggle });
    const row = mergedRow(root, '示例库');
    const caret = row.querySelector<HTMLButtonElement>('.tree-dir-toggle')!;
    const badge = row.querySelector<HTMLButtonElement>('.tree-count-btn')!;
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.textContent).toMatch(/^\d+ 篇$/);
    expect(badge.className).toContain('tree-count');

    const listId = caret.getAttribute('aria-controls')!;
    // 两个按钮指向同一个受控区域，初始状态一致
    expect(badge.getAttribute('aria-controls')).toBe(listId);
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    const list = root.querySelector<HTMLElement>(`#${CSS.escape(listId)}`)!;
    expect(list.hidden).toBe(true);

    badge.click();
    expect(list.hidden).toBe(false);
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(onToggle).toHaveBeenCalledWith('示例库', true);

    // 再用箭头收起，徽标状态也要跟着回到 false
    caret.click();
    expect(list.hidden).toBe(true);
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    expect(onToggle).toHaveBeenLastCalledWith('示例库', false);
  });

  it('点「N 篇」徽标不会导航（徽标不是链接，也没有弹出新页面）', () => {
    const root = renderTree(tree);
    const badge = mergedRow(root, '示例库').querySelector<HTMLButtonElement>('.tree-count-btn')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    badge.dispatchEvent(click);
    // 徽标自己的 click 处理会 preventDefault；也未冒泡到行内的文档链接
    expect(click.defaultPrevented).toBe(true);
    expect(badge.closest('a')).toBeNull();
  });

  it('openPaths 命中时默认展开，并标记当前文档 aria-current', () => {
    const root = renderTree(tree, { openPaths: new Set(['示例库']), currentPath: '示例库' });
    const row = mergedRow(root, '示例库');
    const toggle = row.querySelector<HTMLButtonElement>('.tree-dir-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const link = row.querySelector<HTMLAnchorElement>('a.tree-doc')!;
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.classList.contains('tree-doc-active')).toBe(true);
  });

  it('纯目录仍然用 details/summary，并在 toggle 时回调 onToggle', () => {
    const pure = buildTree([entry('A/B/C'), entry('A/B/D')]);
    const onToggle = vi.fn();
    const root = renderTree(pure, { onToggle, openPaths: new Set<string>() });
    const details = root.querySelector<HTMLDetailsElement>('details.tree-dir[data-dir-path="A"]')!;
    expect(details.open).toBe(false);
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    expect(onToggle).toHaveBeenCalledWith('A', true);
  });
});
