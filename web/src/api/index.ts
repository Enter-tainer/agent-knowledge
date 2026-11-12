import type { KbApi } from './contract';
import { httpApi } from './http';

/**
 * mock 判定（一处开关，别处不再判断）：
 *  - `VITE_MOCK=1` → 开；`VITE_MOCK=0` → 关（两处都优先）。
 *  - `pnpm dev`（DEV）+ 没配 `VITE_API_BASE`/`VITE_DEV_PROXY_TARGET` → 自动开 mock。
 *  - `pnpm build`（生产构建）→ 自动用真接口（同源 /api），mock 代码不进 bundle（动态 import + 被 tree-shake）。
 */
function resolveMock(): boolean {
  const flag = import.meta.env.VITE_MOCK;
  if (flag === '1') return true;
  if (flag === '0') return false;
  const hasRealTarget = Boolean(import.meta.env.VITE_API_BASE || import.meta.env.VITE_DEV_PROXY_TARGET);
  return import.meta.env.DEV && !hasRealTarget;
}

export const IS_MOCK = resolveMock();

let implPromise: Promise<KbApi> | null = null;

function impl(): Promise<KbApi> {
  if (!implPromise) {
    implPromise = IS_MOCK
      ? import('./mock').then((module) => module.mockApi)
      : Promise.resolve(httpApi);
  }
  return implPromise;
}

/**
 * 页面只依赖 `api`：mock 与真接口都实现了 KbApi。切后端只改 `VITE_API_BASE`
 * （或 dev 下的 `VITE_DEV_PROXY_TARGET`），本文件之外没有任何 URL 前缀。
 */
export const api: KbApi = {
  health: () => impl().then((a) => a.health()),
  tree: (params) => impl().then((a) => a.tree(params)),
  getDoc: (path, ifNoneMatch) => impl().then((a) => a.getDoc(path, ifNoneMatch)),
  putDoc: (path, raw, ifMatch) => impl().then((a) => a.putDoc(path, raw, ifMatch)),
  rename: (path, to) => impl().then((a) => a.rename(path, to)),
  search: (query, limit) => impl().then((a) => a.search(query, limit)),
  backlinks: (path) => impl().then((a) => a.backlinks(path)),
  links: (path) => impl().then((a) => a.links(path)),
  reportLinks: (unresolvedOnly) => impl().then((a) => a.reportLinks(unresolvedOnly)),
  orphans: () => impl().then((a) => a.orphans()),
  reindex: () => impl().then((a) => a.reindex()),
  exportZip: () => impl().then((a) => a.exportZip()),
};
