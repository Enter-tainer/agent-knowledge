import { docUrl } from '../router';
import { el } from './dom';
import { openNewNoteDialog } from './newNote';
import { ancestorsOf, countDocs, type TreeNode } from './tree-model';

export interface TreeRenderOptions {
  /** 当前文档路径：高亮 + 祖先目录自动展开。 */
  currentPath?: string;
  /** 已展开的目录路径（由调用方持有，切换/刷新后保留）。 */
  openPaths?: ReadonlySet<string>;
  /** 目录展开/收起时回调，调用方负责记住状态。 */
  onToggle?: (path: string, open: boolean) => void;
  /** 点击目录行快捷「+」按钮时回调（默认打开新建笔记弹窗并填入该目录）。 */
  onCreateInDir?: (dirPath: string) => void;
  /** 内部递归用：已解析的展开集合。 */
  resolvedOpenPaths?: ReadonlySet<string>;
}

interface RenderContext {
  currentPath?: string;
  openPaths: ReadonlySet<string>;
  onToggle?: (path: string, open: boolean) => void;
  onCreateInDir?: (dirPath: string) => void;
}

let renderSeq = 0;

/** 渲染整棵树（飞书 / Notion 风格：左侧统一折叠箭头 + 整行热区 + Hover 快捷新建）。 */
export function renderTree(nodes: TreeNode[], options: TreeRenderOptions = {}): HTMLElement {
  const root = el('ul', { class: 'tree-list' });
  const context: RenderContext = {
    currentPath: options.currentPath,
    openPaths: options.resolvedOpenPaths ?? options.openPaths ?? new Set(ancestorsOf(options.currentPath)),
    onToggle: options.onToggle,
    onCreateInDir: options.onCreateInDir,
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
      item.appendChild(docLink(node.path, node.name, context.currentPath, 'tree-doc', true));
    }

    parent.appendChild(item);
  }
}

function makeChevron(): HTMLElement {
  const span = el('span', { class: 'tree-caret', 'aria-hidden': 'true' });
  span.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  return span;
}

function makeIcon(kind: 'folder' | 'doc' | 'parentDoc'): HTMLElement {
  const span = el('span', { class: `tree-icon tree-icon-${kind}`, 'aria-hidden': 'true' });
  if (kind === 'folder') {
    span.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
  } else if (kind === 'parentDoc') {
    span.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';
  } else {
    span.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';
  }
  return span;
}

function makeAddButton(dirPath: string, label: string, onCreate?: (path: string) => void): HTMLButtonElement {
  const btn = el('button', {
    type: 'button',
    class: 'tree-dir-add',
    title: `在「${label}」下新建笔记`,
    'aria-label': `在「${label}」下新建笔记`,
    onclick: (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      (onCreate ?? openNewNoteDialog)(dirPath);
    },
  }) as HTMLButtonElement;
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
  return btn;
}

/** 纯目录：`<details>/<summary>`，左侧矢量箭头 + 图标 + 名称 + 右侧安静篇数与 hover `+` 新建。 */
function appendPlainDir(item: HTMLElement, node: TreeNode, count: number, context: ResolvedContext): void {
  const details = el('details', { class: 'tree-dir', 'data-dir-path': node.path });
  if (context.openPaths.has(node.path)) details.open = true;

  const meta = el(
    'span',
    { class: 'tree-meta' },
    el('span', { class: 'tree-count', title: `共 ${count} 篇笔记`, text: String(count) }),
    makeAddButton(node.path, node.name, context.onCreateInDir),
  );

  const summary = el(
    'summary',
    { class: 'tree-dir-label' },
    makeChevron(),
    makeIcon('folder'),
    el('span', { class: 'tree-name', text: node.name }),
    meta,
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
 * 「目录 + 同名笔记」父页面行（对标飞书知识库 / Notion 带子页面的文档行）：
 * - 左侧单一箭头按钮控制展开/收起（不再和右侧篇数拆成两个割裂按钮）；
 * - 中间点击标题直接打开笔记；若该篇已是当前正在看的页面，再点也会顺手切换展开/收起；
 * - 点击行右侧计数或空白区同样触发该行展开/收起；
 * - 悬停时右侧浮现 `+` 按钮，直接在该目录下新建子笔记。
 */
function appendMergedDir(item: HTMLElement, node: TreeNode, count: number, context: ResolvedContext): void {
  const open = context.openPaths.has(node.path);
  const listId = `tree-children-${context.seq}-${++idSeq}`;
  const childList = el('ul', { class: 'tree-list tree-list-child', id: listId });
  childList.hidden = !open;
  appendNodes(childList, node.children, context);

  const label = node.doc?.title || node.name;
  const ariaToggleLabel = (isOpen: boolean): string => `${isOpen ? '收起' : '展开'} ${label} 的子目录`;

  const toggleBtn = el(
    'button',
    {
      type: 'button',
      class: 'tree-dir-toggle',
      'aria-expanded': open ? 'true' : 'false',
      'aria-controls': listId,
      'aria-label': ariaToggleLabel(open),
      title: ariaToggleLabel(open),
    },
    makeChevron(),
  ) as HTMLButtonElement;

  const applyState = (nextOpen: boolean): void => {
    childList.hidden = !nextOpen;
    toggleBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    toggleBtn.setAttribute('aria-label', ariaToggleLabel(nextOpen));
    toggleBtn.title = ariaToggleLabel(nextOpen);
  };

  const toggle = (): void => {
    const nextOpen = childList.hidden;
    applyState(nextOpen);
    context.onToggle?.(node.path, nextOpen);
  };

  toggleBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  });

  const link = docLink(node.path, label, context.currentPath, 'tree-doc tree-doc-inline', false);
  link.addEventListener('click', (event) => {
    // 若用户点的就是当前高亮的父文档，再点一下顺手展开/收起子级，符合 Notion/飞书直觉
    if (link.getAttribute('aria-current') === 'page') {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }
  });

  const meta = el(
    'span',
    { class: 'tree-meta', title: `共 ${count} 篇笔记（点击展开/收起）` },
    el('span', { class: 'tree-count', text: String(count) }),
    makeAddButton(node.path, label, context.onCreateInDir),
  );

  const row = el(
    'div',
    { class: 'tree-dir-row', 'data-dir-path': node.path, 'data-merged': '1' },
    toggleBtn,
    link,
    meta,
  );

  row.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a.tree-doc, .tree-dir-add, .tree-dir-toggle')) return;
    event.preventDefault();
    toggle();
  });

  item.appendChild(row);
  item.appendChild(childList);
}

let idSeq = 0;

function docLink(
  path: string,
  label: string,
  currentPath: string | undefined,
  className: string,
  withLeafSpacer: boolean,
): HTMLElement {
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
    withLeafSpacer ? el('span', { class: 'tree-leaf-spacer', 'aria-hidden': 'true' }) : null,
    makeIcon(withLeafSpacer ? 'doc' : 'parentDoc'),
    el('span', { class: 'tree-doc-name', text: label }),
  );
}
