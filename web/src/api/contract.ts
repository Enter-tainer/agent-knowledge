import type {
  BacklinksResponse,
  Doc,
  HealthResponse,
  LinksReport,
  ReindexResult,
  LinksResponse,
  OrphansResponse,
  RenameResult,
  SearchResponse,
  TreeEntry,
  UpdateResult,
} from './types';

/**
 * 前端对后端契约的唯一抽象。http.ts（真接口）与 mock.ts（本地假数据）都实现它，
 * 页面只依赖这个接口 —— 因此切真接口只需换 VITE_API_BASE，页面代码零改动。
 *
 * 鉴权：Worker 不做鉴权；线上由 Cloudflare Access 在边缘拦截（浏览器 cookie 自动带）。
 * 前端不存 token、不发 Authorization 头，401 只表示「Access 没放行」。
 */
export interface KbApi {
  health(): Promise<HealthResponse>;
  tree(params?: { prefix?: string; limit?: number }): Promise<TreeEntry[]>;
  /** 传 ifNoneMatch 时命中返回 304（实现抛 NotModifiedError）。 */
  getDoc(path: string, ifNoneMatch?: string): Promise<Doc>;
  /**
   * 写文档：
   * - 已存在文档必须带当前 `If-Match: <hash>`（缺失或 `*` → 428，hash 不匹配 → 412）；
   * - `If-Match: '*'` 只用于新建。
   */
  putDoc(path: string, raw: string, ifMatch: string): Promise<UpdateResult>;
  rename(path: string, to: string): Promise<RenameResult>;
  search(query: string, limit?: number): Promise<SearchResponse>;
  backlinks(path: string): Promise<BacklinksResponse>;
  links(path: string): Promise<LinksResponse>;
  /** 传 true → `?unresolved=1`（断链报告）；不传 → 全量链接明细。 */
  reportLinks(unresolvedOnly?: boolean): Promise<LinksReport>;
  orphans(): Promise<OrphansResponse>;
  /** POST /api/admin/reindex：重建检索索引，返回 stale（应 0）。 */
  reindex(): Promise<ReindexResult>;
  exportZip(): Promise<Blob>;
}
