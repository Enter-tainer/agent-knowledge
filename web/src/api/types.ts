/** 后端 API 的 DTO 类型，严格按 docs/TECH-69-67-plan.md §6.1 的契约定义。 */

export interface HealthResponse {
  ok: boolean;
  tokenizerVersion: number;
  docs: number;
  /** 索引落后正文的文档数（正常 0；>0 时首页会给一条提示） */
  stale?: number;
}

/** `GET /api/tree` 的一项。`path` 不含 `.md`。 */
export interface TreeEntry {
  path: string;
  title: string;
  tags: string[];
  size: number;
  /** ISO 时间串（后端给什么就用什么，前端只做展示/排序） */
  updated: string;
}

export interface Doc {
  path: string;
  title: string;
  tags: string[];
  /** sha256(raw)，用于乐观锁 / If-None-Match */
  hash: string;
  revision: number;
  updated: string;
  /** 完整 md，含 frontmatter */
  raw: string;
}

export interface UpdateResult {
  path: string;
  hash: string;
  revision: number;
}

export interface RenameResult {
  from: string;
  to: string;
  rewritten: number;
}

export interface SearchHit {
  path: string;
  title: string;
  /** 命中块所属 heading（可能为空） */
  heading: string;
  score: number;
  snippet: string;
  /** 摘要里需要 <mark> 的词 */
  highlights: string[];
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
}

export interface Backlink {
  path: string;
  title: string;
  count: number;
}

export interface BacklinksResponse {
  path: string;
  backlinks: Backlink[];
}

export interface LinkRef {
  /** 原文里的目标文本（已去别名/锚点） */
  target: string;
  resolved: boolean;
  dstPath: string | null;
  line: number;
}

export interface LinksResponse {
  path: string;
  links: LinkRef[];
}

export interface UnresolvedLink {
  src: string;
  title: string;
  target: string;
  line: number;
}

export interface UnresolvedReport {
  unresolved: UnresolvedLink[];
  count: number;
}

/** `GET /api/reports/links`（不带 unresolved=1）的返回：全量链接明细。 */
export interface AllLinksEntry {
  src: string;
  title: string;
  target: string;
  line: number;
  resolved: boolean;
  dstPath: string | null;
}

export interface AllLinksReport {
  links: AllLinksEntry[];
  count: number;
}

export type LinksReport = UnresolvedReport | AllLinksReport;

export interface OrphansResponse {
  orphans: { path: string; title: string }[];
}
export interface ReindexResult {
  documents: number;
  chunks: number;
  stale: number;
  orphansRemoved: number;
}
