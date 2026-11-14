/**
 * 页面 → 布局的契约（见 docs/web-nav-sidebar-acceptance.md §2）。
 *
 * 页面工厂不再自己拼顶栏/侧边栏：只产出一个「内容节点 + 元信息」，
 * 由 `ui/layout.ts` 负责挂载到持久 shell 里。这样导航只替换 `.page-content`，
 * 顶栏与侧边栏的 DOM 身份保持不变，不会再有「整页刷新」的观感。
 */

export type ActiveNav = 'home' | 'reports' | 'doc' | 'search' | 'edit';

export interface PageView {
  /** 挂到 `.page-content` 的根节点。 */
  node: HTMLElement;
  /** 顶栏导航高亮。 */
  active: ActiveNav;
  /** document.title */
  title: string;
  /** 顶栏搜索框回填（搜索页用）。 */
  searchQuery?: string;
  /** 宽版内容区（编辑器用）。 */
  wide?: boolean;
  /** 是否显示目录侧边栏；默认 true（编辑页传 false）。 */
  showSidebar?: boolean;
  /** 侧边栏高亮目标（文档页传 doc.path）。 */
  currentPath?: string;
  /** 内容已插入 DOM 后调用（滚动、focus 等）。 */
  onMount?: () => void;
  /** 下一次替换前调用（比全局 teardown 更精确）。 */
  onTeardown?: () => void;
}

/** 导航来源：决定滚动行为（push 回顶、pop 恢复、retry 原地）。 */
export type NavKind = 'initial' | 'push' | 'pop' | 'retry';

export interface NavInfo {
  kind: NavKind;
  /** popstate 时该历史条目记录的 scrollY；其它情况为 null。 */
  scrollY: number | null;
}

/**
 * 持久侧边栏句柄（`ui/sidebar.ts` 实现，`ui/layout.ts` 消费）。
 *
 * 关键约束：`setCurrent` 只能做增量更新（高亮 / 展开祖先 / 滚动可见），
 * 不许重建树 DOM —— 否则就退化成「切换页面时侧边栏闪一下」。
 */
export interface SidebarHandle {
  /** 挂到 `.app-body` 左侧的根节点（`<aside class="sidebar">`）。 */
  element: HTMLElement;
  /** 高亮当前文档并展开其祖先目录；传 undefined 表示清除高亮。 */
  setCurrent(path?: string): void;
  /** 重新拉取目录树，保留用户展开状态与滚动位置。 */
  refresh(): Promise<void>;
  /** 移动端抽屉（桌面调用无副作用）。 */
  openDrawer(): void;
  /**
   * 解绑全局监听（`kb:tree-invalidated`），让这个实例可以被丢弃。
   *
   * 应用里只有一个侧边栏、生命周期等于页面，所以生产代码不会调用；
   * 但测试要创建多个实例时必须能清理，否则旧实例会继续响应事件
   * （表现为「一次派发触发多次刷新」这种难以定位的串扰）。
   */
  destroy?(): void;
}
