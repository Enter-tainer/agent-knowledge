/**
 * 侧边栏 + 目录刷新链路（docs/web-nav-sidebar-acceptance.md §4 B3 / B7 / B8）。
 *
 * 这个文件补的是三轮对抗审查都点名的**最大测试盲区**：
 * 「保存笔记 → invalidateTree → kb:tree-invalidated → sidebar.refresh → /api/tree」
 * 这条链此前一条自动化用例都没有，而 P0 级 bug（事件自激环，曾递归 43 层）恰好藏在里面。
 *
 * 覆盖点：
 *  - refresh 只发一次 /api/tree（自激环回归）；
 *  - refresh 保留展开状态与 scrollTop；
 *  - 首次加载失败显示可重试错误；**刷新**失败时保留旧树但必须给出提示（不能静默）；
 *  - 合并行（目录 + 同名笔记）渲染契约；
 *  - setCurrent 的增量高亮（不重建 DOM、aria-current 唯一）。
 *
 * 隔离：每个用例用 `vi.resetModules()` + 动态 import 拿一份全新的 store/sidebar 模块，
 * 否则上一个用例里 createSidebar 注册的 `kb:tree-invalidated` 监听器会留下来，
 * 让后续用例多收到几次事件（这正是本文件一开始踩到的坑）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TreeEntry } from '../src/api/types';

/** 桩掉 api：只让 tree() 可被计数与控制。 */
let treeCalls: number[] = [];
let treeImpl: () => Promise<TreeEntry[]> = async () => [];

vi.mock('../src/api', () => {
  return {
    IS_MOCK: false,
    api: {
      tree: () => {
        treeCalls.push(Date.now());
        return treeImpl();
      },
    },
  };
});

type SidebarModule = { createSidebar: typeof import('../src/ui/sidebar').createSidebar };

/** 拿一份全新的 sidebar/store/drawer 模块（各自的模块级状态都是干净的）。 */
async function freshSidebar(): Promise<SidebarModule> {
  vi.resetModules();
  return (await import('../src/ui/sidebar')) as unknown as SidebarModule;
}

/** 「目录 + 同名笔记」冲突形状的**合成**语料（真实语料 4 处，这里取 3 处，路径已 pseudonym 化）。 */
function fixture(): TreeEntry[] {
  const doc = (path: string, title = path.split('/').pop() ?? path): TreeEntry =>
    ({ path, title, size: 100, updated: 0 }) as unknown as TreeEntry;
  return [
    doc('示例库'),
    doc('示例库/设备甲逆向'),
    doc('示例库/设备甲逆向/协议与数据格式'),
    doc('示例库/设备乙逆向'),
    doc('示例库/设备乙逆向/数据格式说明'),
    doc('索引与约定'),
    doc('知识库总览'),
  ];
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 挂载到 document（aria-controls 指向的 ul 要靠 getElementById 找到）。 */
async function mount(mod: SidebarModule, entries: TreeEntry[] = fixture()) {
  treeImpl = async () => entries;
  const sidebar = track(mod.createSidebar());
  document.body.replaceChildren(sidebar.element);
  await flush();
  return sidebar;
}

/**
 * 记录本文件创建过的侧边栏，afterEach 里 destroy 掉。
 *
 * 必须做：`vi.resetModules()` 只重置模块注册表，**不会**移除上个实例挂在
 * `window` 上的 `kb:tree-invalidated` 监听器。不清理的话，第 N 个用例派发一次事件，
 * 前面 N-1 个实例也会各自 refresh → 表现为「一次派发打了 N 次 /api/tree」。
 */
const created: Array<{ destroy?: () => void }> = [];

function track<T extends { destroy?: () => void }>(sidebar: T): T {
  created.push(sidebar);
  return sidebar;
}

beforeEach(() => {
  treeCalls = [];
  treeImpl = async () => fixture();
  document.body.replaceChildren();
});

afterEach(() => {
  while (created.length) {
    const sidebar = created.pop();
    sidebar?.destroy?.();
  }
  document.body.replaceChildren();
});

describe('目录加载与刷新', () => {
  it('首次挂载只请求一次 /api/tree', async () => {
    const mod = await freshSidebar();
    await mount(mod);
    expect(treeCalls.length).toBe(1);
  });

  it('kb:tree-invalidated 只派发一次、只请求一次 —— 事件自激环回归（曾递归 43 层）', async () => {
    // 只在单独文件上半部分运行也能复现，说明是本文件内的跨用例残留：
    // 每个用例都 vi.resetModules() + destroy()，所以这里的隔离断言本身也是被测内容。
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    expect(sidebar.element.querySelectorAll('a.tree-doc').length).toBe(7);
    treeCalls = [];

    // 统计本事件被派发的总次数：自激环会让它远超 1
    let dispatched = 0;
    const spy = (event: Event): void => {
      if (event.type === 'kb:tree-invalidated') dispatched += 1;
    };
    window.addEventListener('kb:tree-invalidated', spy);
    try {
      window.dispatchEvent(new Event('kb:tree-invalidated'));
      await flush();
    } finally {
      window.removeEventListener('kb:tree-invalidated', spy);
    }

    // 诊断：把两个数值一起报出来，便于定位是「事件被多次派发」还是「监听器残留」
    expect({ dispatched, treeCalls: treeCalls.length }).toEqual({ dispatched: 1, treeCalls: 1 });
  });

  it('refresh 保留展开状态与侧边栏 scrollTop', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;

    const toggle = aside.querySelector<HTMLButtonElement>(
      '.tree-dir-row[data-dir-path="示例库"] .tree-dir-toggle',
    )!;
    expect(toggle).toBeTruthy();
    toggle.click(); // 收起「示例库」
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    aside.scrollTop = 137;
    window.dispatchEvent(new Event('kb:tree-invalidated'));
    await flush();

    const toggleAfter = aside.querySelector<HTMLButtonElement>(
      '.tree-dir-row[data-dir-path="示例库"] .tree-dir-toggle',
    )!;
    expect(toggleAfter.getAttribute('aria-expanded')).toBe('false'); // 展开状态保留
    expect(aside.scrollTop).toBe(137); // 滚动位置保留
  });

  it('首次加载失败：显示可重试错误', async () => {
    const mod = await freshSidebar();
    treeImpl = async () => {
      throw new Error('boom');
    };
    const sidebar = track(mod.createSidebar());
    document.body.replaceChildren(sidebar.element);
    await flush();

    expect(sidebar.element.querySelector('.sidebar-error')).toBeTruthy();
    expect(sidebar.element.querySelector('.sidebar-error button')).toBeTruthy();
    expect(sidebar.element.querySelectorAll('a.tree-doc').length).toBe(0);
  });

  it('刷新失败：保留旧树，但必须给出「目录可能不是最新的」提示（不能静默）', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;
    expect(aside.querySelectorAll('a.tree-doc').length).toBe(7);

    treeImpl = async () => {
      throw new Error('network down');
    };
    window.dispatchEvent(new Event('kb:tree-invalidated'));
    await flush();

    // 旧树还在（比清空好）
    expect(aside.querySelectorAll('a.tree-doc').length).toBe(7);
    // 但必须有提示 + 重试入口，否则用户以为「保存没生效」
    const bar = aside.querySelector('.sidebar-error');
    expect(bar).toBeTruthy();
    expect(bar!.textContent).toContain('最新');
    expect(bar!.querySelector('button')).toBeTruthy();
  });

  it('刷新失败后点重试能恢复', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;

    treeImpl = async () => {
      throw new Error('network down');
    };
    window.dispatchEvent(new Event('kb:tree-invalidated'));
    await flush();
    expect(aside.querySelector('.sidebar-error')).toBeTruthy();

    treeImpl = async () => fixture();
    aside.querySelector<HTMLButtonElement>('.sidebar-error button')!.click();
    await flush();

    expect(aside.querySelector('.sidebar-error')).toBeFalsy();
    expect(aside.querySelectorAll('a.tree-doc').length).toBe(7);
  });
});

describe('合并行渲染（B8）', () => {
  it('同名目录 + 笔记只渲染一行，行内同时有链接与展开按钮', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;

    const rows = [...aside.querySelectorAll<HTMLElement>('.tree-dir-row[data-dir-path]')];
    // 示例库 / 示例库/设备甲逆向 / 示例库/设备乙逆向 —— 三处都有同名笔记
    expect(rows.length).toBe(3);

    for (const row of rows) {
      const path = row.dataset.dirPath!;
      // 同一路径在整棵树里只能出现一行
      const samePath = [...aside.querySelectorAll<HTMLElement>('.tree-dir-row[data-dir-path]')].filter(
        (item) => item.dataset.dirPath === path,
      );
      expect(samePath.length).toBe(1);

      const link = row.querySelector('a.tree-doc');
      const toggle = row.querySelector('button.tree-dir-toggle');
      expect(link, `${path} 应有可点击的笔记链接`).toBeTruthy();
      expect(toggle, `${path} 应有展开按钮`).toBeTruthy();
      // 链接指向该路径本身（点名称 → 打开同名笔记）
      expect(link!.getAttribute('href')).toBe(`/d/${path.split('/').map(encodeURIComponent).join('/')}/`);
      // 展开按钮的完整可访问性契约
      expect(toggle!.getAttribute('aria-controls')).toBeTruthy();
      expect(['true', 'false']).toContain(toggle!.getAttribute('aria-expanded'));
    }
  });

  it('点展开按钮只切换子列表显隐（不导航、不改高亮）', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;

    const toggle = aside.querySelector<HTMLButtonElement>(
      '.tree-dir-row[data-dir-path="示例库"] .tree-dir-toggle',
    )!;
    const listId = toggle.getAttribute('aria-controls')!;
    const list = document.getElementById(listId);
    expect(list, 'aria-controls 必须指向真实存在的子列表').toBeTruthy();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list!.hidden).toBe(false);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(list!.hidden).toBe(true);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list!.hidden).toBe(false);
  });

  it('总篇数不因合并而重复计数', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;

    const links = [...aside.querySelectorAll<HTMLElement>('a.tree-doc')];
    const uniquePaths = new Set(links.map((a) => a.dataset.docPath));
    expect(links.length).toBe(7); // 7 篇就是 7 个链接
    expect(uniquePaths.size).toBe(7); // 不重复
    expect(aside.querySelector('.sidebar-head')!.textContent).toContain('7 篇');
  });
});

describe('setCurrent（增量高亮，不重建 DOM）', () => {
  it('切到子文档：aria-current 唯一、祖先展开、非当前项节点不被替换', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;
    const deep = '示例库/设备乙逆向/数据格式说明';

    const before = aside.querySelector<HTMLElement>('a.tree-doc[data-doc-path="索引与约定"]');
    expect(before).toBeTruthy();

    sidebar.setCurrent(deep);

    const currents = aside.querySelectorAll<HTMLElement>('a.tree-doc[aria-current="page"]');
    expect(currents.length).toBe(1);
    expect(currents[0]!.dataset.docPath).toBe(deep);

    // 祖先链都展开
    for (const ancestor of ['示例库', '示例库/设备乙逆向']) {
      const toggle = aside.querySelector<HTMLButtonElement>(
        `.tree-dir-row[data-dir-path="${CSS.escape(ancestor)}"] .tree-dir-toggle`,
      );
      expect(toggle, `${ancestor} 应是合并行`).toBeTruthy();
      expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    }

    // 增量更新：非当前项仍是同一个 DOM 节点（没有被 replaceChildren 重建）
    const after = aside.querySelector<HTMLElement>('a.tree-doc[data-doc-path="索引与约定"]');
    expect(after).toBe(before);
  });

  it('反复切换高亮不会留下多个 aria-current', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;

    for (const path of ['索引与约定', '知识库总览', '示例库', '索引与约定']) {
      sidebar.setCurrent(path);
      const currents = aside.querySelectorAll<HTMLElement>('a.tree-doc[aria-current="page"]');
      expect(currents.length).toBe(1);
      expect(currents[0]!.dataset.docPath).toBe(path);
    }
  });

  it('setCurrent(undefined) 清掉所有高亮', async () => {
    const mod = await freshSidebar();
    const sidebar = await mount(mod);
    const aside = sidebar.element;

    sidebar.setCurrent('索引与约定');
    expect(aside.querySelectorAll('a.tree-doc[aria-current="page"]').length).toBe(1);

    sidebar.setCurrent(undefined);
    expect(aside.querySelectorAll('a.tree-doc[aria-current="page"]').length).toBe(0);
  });
});
