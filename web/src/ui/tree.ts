import type { TreeEntry } from '../api/types';
import { docUrl } from '../router';
import { el } from './dom';

interface DirNode {
  name: string;
  path: string;
  docs: TreeNode[];
  dirs: Map<string, DirNode>;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'doc';
  doc?: TreeEntry;
  children: TreeNode[];
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** path 按 `/` 分层；同一层内目录在前、文档在后。 */
export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: DirNode = { name: '', path: '', docs: [], dirs: new Map() };

  for (const entry of entries) {
    const segs = entry.path.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i];
      const path = segs.slice(0, i + 1).join('/');
      let next = dir.dirs.get(name);
      if (!next) {
        next = { name, path, docs: [], dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    const name = entry.title || segs[segs.length - 1];
    dir.docs.push({ name, path: entry.path, kind: 'doc', doc: entry, children: [] });
  }

  return finalize(root);
}

function finalize(dir: DirNode): TreeNode[] {
  const dirs: TreeNode[] = [...dir.dirs.values()]
    .map((child) => ({
      name: child.name,
      path: child.path,
      kind: 'dir' as const,
      children: finalize(child),
    }))
    .sort((a, b) => collator.compare(a.name, b.name));

  const docs = dir.docs.slice().sort((a, b) => collator.compare(a.name, b.name));
  return [...dirs, ...docs];
}

export function countDocs(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'doc') n += 1;
    else n += countDocs(node.children);
  }
  return n;
}

export interface TreeRenderOptions {
  /** 目录默认收起（移动端抽屉用，避免一次展开 4500px）。 */
  startCollapsed?: boolean;
}

/** 当前文档的所有祖先目录（用于自动展开 + 保证当前项可见）。 */
function ancestorsOf(path: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!path) return out;
  const parts = path.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
  return out;
}

export function renderTree(
  nodes: TreeNode[],
  currentPath?: string,
  options: TreeRenderOptions = {},
): HTMLElement {
  const root = el('ul', { class: 'tree-list' });
  appendNodes(root, nodes, currentPath, options, ancestorsOf(currentPath));
  return root;
}

function appendNodes(
  parent: HTMLUListElement,
  nodes: TreeNode[],
  currentPath: string | undefined,
  options: TreeRenderOptions,
  openPaths: Set<string>,
): void {
  for (const node of nodes) {
    const item = el('li', { class: `tree-item tree-item-${node.kind}` });

    if (node.kind === 'dir') {
      const details = el('details', { class: 'tree-dir' });
      const count = countDocs(node.children);
      const shouldOpen = !options.startCollapsed || openPaths.has(node.path);
      if (shouldOpen) details.open = true;
      const summary = el(
        'summary',
        { class: 'tree-dir-label' },
        el('span', { class: 'tree-caret', 'aria-hidden': 'true' }),
        el('span', { class: 'tree-name', text: node.name }),
        el('span', { class: 'tree-count', text: `${count} 篇` }),
      );
      const childList = el('ul', { class: 'tree-list tree-list-child' });
      appendNodes(childList, node.children, currentPath, options, openPaths);
      details.append(summary, childList);
      item.appendChild(details);
    } else {
      const active = node.path === currentPath;
      item.appendChild(
        el(
          'a',
          {
            class: active ? 'tree-doc tree-doc-active' : 'tree-doc',
            href: docUrl(node.path),
            title: node.path,
            'aria-current': active ? 'page' : null,
          },
          el('span', { class: 'tree-doc-name', text: node.name }),
        ),
      );
    }

    parent.appendChild(item);
  }
}
