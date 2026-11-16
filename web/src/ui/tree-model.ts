/** 目录树的纯数据层：不碰 DOM，方便单测（见 web/tests/tree-model.test.ts）。 */

import type { TreeEntry } from '../api/types';

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
  /** 文档节点本身的数据；目录节点在与同名笔记合并时也会带上它。 */
  doc?: TreeEntry;
  children: TreeNode[];
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/**
 * path 按 `/` 分层；同一层内目录在前、文档在后。
 *
 * **同名合并**：vault 里存在「`示例库.md` + `示例库/`」这种同名目录+笔记
 * （本库实测 4 处）。若按路径直接分类，侧边栏会出现两行同名节点，其中「能展开的
 * 那一行」点不开内容 —— 用户会以为设计坏了。这里把同名笔记挂到目录节点上（`node.doc`），
 * 渲染成一个「可点击打开 + 可展开」的行。总篇数不变。
 */
export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: DirNode = { name: '', path: '', docs: [], dirs: new Map() };

  // pass 1：先把所有目录建出来
  for (const entry of entries) {
    const segs = entry.path.split('/').filter(Boolean);
    if (segs.length < 2) continue;
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i]!;
      const path = segs.slice(0, i + 1).join('/');
      let next = dir.dirs.get(name);
      if (!next) {
        next = { name, path, docs: [], dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
  }

  // pass 2：把文档挂到对应目录（或根）；与目录同路径的文档合并进目录节点
  const dirsByPath = new Map<string, DirNode>();
  const indexDirs = (dir: DirNode): void => {
    for (const child of dir.dirs.values()) {
      dirsByPath.set(child.path, child);
      indexDirs(child);
    }
  };
  indexDirs(root);

  for (const entry of entries) {
    const segs = entry.path.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    const name = entry.title || segs[segs.length - 1]!;
    const node: TreeNode = { name, path: entry.path, kind: 'doc', doc: entry, children: [] };
    const merged = dirsByPath.get(entry.path);
    if (merged) {
      merged.docs.push(node);
      continue;
    }
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const next = dir.dirs.get(segs[i]!);
      if (!next) break;
      dir = next;
    }
    dir.docs.push(node);
  }

  return finalizeRoot(root);
}

function finalizeRoot(root: DirNode): TreeNode[] {
  const dirs = [...root.dirs.values()].map(finalizeDir).sort((a, b) => collator.compare(a.name, b.name));
  const docs = sortDocs(root.docs);
  return [...dirs, ...docs];
}

function finalizeDir(dir: DirNode): TreeNode {
  // 与本目录同路径的笔记：不单独出行，挂在目录节点上（可点击 + 可展开）
  const selfDoc = dir.docs.find((node) => node.path === dir.path);
  const restDocs = dir.docs.filter((node) => node !== selfDoc);
  const childDirs = [...dir.dirs.values()]
    .map(finalizeDir)
    .sort((a, b) => collator.compare(a.name, b.name));
  return {
    name: dir.name,
    path: dir.path,
    kind: 'dir',
    doc: selfDoc?.doc,
    children: [...childDirs, ...sortDocs(restDocs)],
  };
}

function sortDocs(docs: TreeNode[]): TreeNode[] {
  return docs.map((node) => ({ ...node, children: [] })).sort((a, b) => collator.compare(a.name, b.name));
}

/** 包含合并笔记在内的总篇数（合并不会重复计数）。 */
export function countDocs(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'doc') n += 1;
    else n += countDocs(node.children) + (node.doc ? 1 : 0);
  }
  return n;
}

/** 当前文档的所有祖先目录路径（不含文档自身）。 */
export function ancestorsOf(path: string | undefined): string[] {
  if (!path) return [];
  const parts = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** 树里存在的全部目录路径。 */
export function collectDirPaths(nodes: TreeNode[], out: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.kind !== 'dir') continue;
    out.add(node.path);
    collectDirPaths(node.children, out);
  }
  return out;
}

/** 全部文档节点（含与目录合并的那种目录节点）。 */
export function collectDocs(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    if (node.kind === 'doc') out.push(node);
    else {
      if (node.doc) out.push(node);
      collectDocs(node.children, out);
    }
  }
  return out;
}

/**
 * 树刷新后合并展开状态：
 * - 只保留仍然存在的目录（树可能变短）；
 * - 始终展开当前文档的祖先链。
 */
export function mergeOpenPaths(
  previous: ReadonlySet<string>,
  nodes: TreeNode[],
  currentPath?: string,
): Set<string> {
  const existing = collectDirPaths(nodes);
  const next = new Set<string>();
  for (const path of previous) if (existing.has(path)) next.add(path);
  for (const path of ancestorsOf(currentPath)) if (existing.has(path)) next.add(path);
  return next;
}

/** 找到某个文档对应的节点（普通文档或「目录+同名笔记」节点）。 */
export function findDoc(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.kind === 'doc') {
      if (node.path === path) return node;
    } else {
      if (node.doc && node.path === path) return node;
      const hit = findDoc(node.children, path);
      if (hit) return hit;
    }
  }
  return null;
}
