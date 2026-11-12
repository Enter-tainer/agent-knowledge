/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 根地址（默认同源，空串）。例：http://127.0.0.1:8787 */
  readonly VITE_API_BASE?: string;
  /** 强制开关 mock：'1' 开，'0' 关。dev 下不设时自动开，build 下自动关。 */
  readonly VITE_MOCK?: string;
  /** 仅 dev server：把 /api 代理到该地址（同源，免 CORS）。 */
  readonly VITE_DEV_PROXY_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
