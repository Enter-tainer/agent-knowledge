import { docUrl } from '../router';
import { el } from './dom';
import { ancestorsOf, countDocs, type TreeNode } from './tree-model';

export interface TreeRenderOptions {
  /** 当前文档路径：高亮 + 祖先目录自动展开。 */
  currentPath?: string;
  /** 已展开的目录路径（由调用方持有，切换/刷新后保留）。 */
  openPaths?: ReadonlySet<string>;
  /** 目录展开/收起时回调，调用方负责记住状态。 */
  onToggle?: (path: string, open: boolean) => void;
  /** 内部递归用：已解析的展开集合。 */
  resolvedOpenPaths?: ReadonlySet<string>;
}

interface RenderContext {
  currentPath?: string;
  openPaths: ReadonlySet<string>;
  onToggle?: (path: string, open: boolean) => void;
}

let renderSeq = 0;

/** 渲染整棵树（纯展示；展开状态由调用方通过 openPaths 控制）。 */
export function renderTree(nodes: TreeNode[], options: TreeRenderOptions = {}): HTMLElement {
  const root = el('ul', { class: 'tree-list' });
  const context: RenderContext = {
    currentPath: options.currentPath,
    openPaths: options.resolvedOpenPaths ?? options.openPaths ?? new Set(ancestorsOf(options.currentPath)),
    onToggle: options.onToggle,
  };
  appendNodes(root, nodes, { ...context, seq: ++renderSeq });
  return root;
}

interface ResolvedContext extends RenderContext {
  seq: number;
}

function appendNodes(parent: HTMLUListElement, nodes: TreeNode[], context: ResolvedContext): void {
  for (const node of nodes) {
    const item = el('li', { class: `tree-item tree-item-${node.kind}` });

    if (node.kind === 'dir') {
      const count = countDocs(node.children) + (node.doc ? 1 : 0);
      if (node.doc) {
        appendMergedDir(item, node, count, context);
      } else {
        appendPlainDir(item, node, count, context);
      }
    } else {
      item.appendChild(docLink(node.path, node.name, context.currentPath, 'tree-doc'));
    }

    parent.appendChild(item);
  }
}

/** 普通目录：`<details>/<summary>`，点整行展开。 */
function appendPlainDir(item: HTMLElement, node: TreeNode, count: number, context: ResolvedContext): void {
  const details = el('details', { class: 'tree-dir', 'data-dir-path': node.path });
  if (context.openPaths.has(node.path)) details.open = true;
  const summary = el(
    'summary',
    { class: 'tree-dir-label' },
    el('span', { class: 'tree-caret', 'aria-hidden': 'true' }),
    el('span', { class: 'tree-name', text: node.name }),
    el('span', { class: 'tree-count', text: `${count} 篇` }),
  );
  const childList = el('ul', { class: 'tree-list tree-list-child' });
  appendNodes(childList, node.children, context);
  details.append(summary, childList);
  details.addEventListener('toggle', () => {
    context.onToggle?.(node.path, details.open);
  });
  item.appendChild(details);
}

/**
 * 「目录 + 同名笔记」合并行（`/root/test.md` + `/root/test/aaa.md` → 只有一行 `test`）：
 * - 点名称 → 打开那篇笔记（锚点，交给 router 的 SPA 接管）；
 * - 点右侧箭头 → 展开/收起子目录（button，`aria-expanded`）。
 *
 * 用「a + button」两个并列可交互元素，而不是把 a 塞进 summary，
 * 避免嵌套交互控件的可访问性问题与点击歧义。箭头放在右侧，与合并行的视觉预期一致。
 */
function appendMergedDir(item: HTMLElement, node: TreeNode, count: number, context: ResolvedContext): void {
  const open = context.openPaths.has(node.path);
  const listId = `tree-children-${context.seq}-${++idSeq}`;
  const childList = el('ul', { class: 'tree-list tree-list-child', id: listId });
  childList.hidden = !open;
  appendNodes(childList, node.children, context);

  const label = node.name;
  const toggle = el(
    'button',
    {
      type: 'button',
      class: 'tree-dir-toggle',
      'aria-expanded': open ? 'true' : 'false',
      'aria-controls': listId,
      'aria-label': `${open ? '收起' : '展开'} ${label} 的子目录`,
      onclick: (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextOpen = childList.hidden;
        childList.hidden = !nextOpen;
        toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        toggle.setAttribute('aria-label', `${nextOpen ? '收起' : '展开'} ${label} 的子目录`);
        context.onToggle?.(node.path, nextOpen);
      },
    },
    el('span', { class: 'tree-caret', 'aria-hidden': 'true' }),
  );

  const row = el(
    'div',
    { class: 'tree-dir-row', 'data-dir-path': node.path, 'data-merged': '1' },
    docLink(node.path, node.doc?.title || node.name, context.currentPath, 'tree-doc tree-doc-inline'),
    el('span', { class: 'tree-count', text: `${count} 篇` }),
    toggle,
  );

  item.appendChild(row);
  item.appendChild(childList);
}

let idSeq = 0;

function docLink(path: string, label: string, currentPath: string | undefined, className: string): HTMLElement {
  const active = path === currentPath;
  return el(
    'a',
    {
      class: active ? `${className} tree-doc-active` : className,
      href: docUrl(path),
      title: path,
      'data-doc-path': path,
      'aria-current': active ? 'page' : null,
    },
    el('span', { class: 'tree-doc-name', text: label }),
  );
}
