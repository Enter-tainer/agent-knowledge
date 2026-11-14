import { defineConfig } from 'vitest/config';

/**
 * 前端单元测试（jsdom）：路由 / 滚动恢复 / 持久布局契约。
 *
 * - 不依赖真实后端：layout 测试注入 fake SidebarHandle，页面工厂用假 PageView。
 * - `pnpm --dir web test` 跑这里；后端单测仍在仓库根的 vitest.config.ts。
 * - 覆盖验收条款见 docs/web-nav-sidebar-acceptance.md §4（A1-A6 / B1-B7 / C5）。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        // history.pushState 需要同源 URL；所有用例都相对这个 origin。
        url: 'http://localhost/',
      },
    },
    setupFiles: ['./tests/setup.ts'],
    // 测试之间保持隔离（DOM / history 状态由各文件自己重置），但不要 mock 掉模块。
    clearMocks: false,
    restoreMocks: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
