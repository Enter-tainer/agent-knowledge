import { defineConfig, loadEnv } from 'vite';

// 关键约定：
// - `pnpm dev` 默认跑 mock（不依赖后端）；`VITE_MOCK=0` 关掉 mock。
// - 接真后端：`VITE_API_BASE=http://127.0.0.1:8787 pnpm dev`（跨域需后端放行 CORS），
//   或者设置 `VITE_DEV_PROXY_TARGET=http://127.0.0.1:8787` 走 Vite 代理（同源，免 CORS）。
// - `pnpm build` 产物由 Worker 作为静态资源挂在同源根路径，因此默认 baseURL 为空串。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const proxyTarget = env.VITE_DEV_PROXY_TARGET;

  return {
    base: '/',
    server: {
      port: 5173,
      strictPort: false,
      proxy: proxyTarget
        ? {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
            },
          }
        : undefined,
    },
    build: {
      outDir: 'dist',
      target: 'es2020',
      assetsInlineLimit: 4096,
      chunkSizeWarningLimit: 700,
    },
  };
});
