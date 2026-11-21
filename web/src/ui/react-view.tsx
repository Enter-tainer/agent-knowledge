import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { PageView } from './view';

export interface ReactPageViewOptions extends Omit<PageView, 'node'> {
  tag?: 'main' | 'div';
  className: string;
}

/**
 * 将 React 组件同步挂载到 PageView.node，确保 layout.show() 插入 DOM 后
 * 可以立即同步完成标题聚焦（C5）与 #hash 锚点定位（A5）。
 */
export function createReactPageView(element: ReactElement, opts: ReactPageViewOptions): PageView {
  const { tag = 'main', className, onTeardown, ...rest } = opts;
  const node = document.createElement(tag);
  node.className = className;

  const root: Root = createRoot(node);
  flushSync(() => {
    root.render(element);
  });

  let unmounted = false;
  return {
    ...rest,
    node,
    onTeardown: () => {
      try {
        onTeardown?.();
      } finally {
        if (!unmounted) {
          unmounted = true;
          queueMicrotask(() => {
            root.unmount();
          });
        }
      }
    },
  };
}
