import type { KbApi } from './contract';
import {
  ApiError,
  ConflictError,
  NotFoundError,
  NotModifiedError,
  PreconditionRequiredError,
  UnauthorizedError,
} from './errors';
import type {
  BacklinksResponse,
  Doc,
  HealthResponse,
  LinksReport,
  LinksResponse,
  OrphansResponse,
  ReindexResult,
  RenameResult,
  SearchResponse,
  TreeEntry,
  UpdateResult,
} from './types';

/**
 * 唯一的 baseURL 开关：默认空串（同源，Worker 同时挂静态资源与 /api）。
 * 改 `VITE_API_BASE` / `VITE_DEV_PROXY_TARGET` 即可切后端，代码其他地方不再出现 URL 前缀。
 *
 * 鉴权：不存 token、不发 Authorization —— 线上由 Cloudflare Access 在边缘用 cookie 拦截；
 * 本地 wrangler dev 只监听 127.0.0.1，也不鉴权。401 仅表示 Access 未放行。
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/** 路径逐段编码：中文、空格、全角冒号都安全，保留 `/` 作为层级分隔。 */
export function encodeDocPath(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** 读一次 body 同时拿到 `{error, requestId}` 与可读文案（500 的 requestId 会挂到 ApiError 上）。 */
async function readError(res: Response): Promise<{ message: string; requestId: string | null; body: unknown }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  let body: unknown = null;
  let requestId: string | null = null;
  let message = '';
  if (text) {
    try {
      const data = JSON.parse(text) as { error?: unknown; message?: unknown; requestId?: unknown };
      body = data;
      const msg = data.error ?? data.message;
      if (typeof msg === 'string' && msg.trim()) message = msg.trim();
      if (typeof data.requestId === 'string' && data.requestId.trim()) requestId = data.requestId.trim();
    } catch {
      message = text.slice(0, 300);
    }
  }
  if (!message) message = `${res.status} ${res.statusText}`.trim();
  if (!requestId) {
    const headerId = res.headers.get('x-request-id') ?? res.headers.get('cf-ray');
    if (headerId) requestId = headerId;
  }
  return { message, requestId, body };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, headers });
  } catch (err) {
    throw new ApiError(0, `网络请求失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 304) {
    throw new NotModifiedError(res.headers.get('ETag') ?? '');
  }
  if (!res.ok) {
    const { message, requestId, body } = await readError(res);
    // 500 把响应/requestId 打到 console，方便对着后端日志排查（UI 只显示人话 + requestId）
    if (res.status >= 500) {
      console.error(`[api] ${init.method ?? 'GET'} ${path} -> ${res.status}`, { requestId, body });
    }
    if (res.status === 401) throw new UnauthorizedError(message);
    if (res.status === 404) throw new NotFoundError(message);
    if (res.status === 412) throw new ConflictError(message);
    if (res.status === 428) throw new PreconditionRequiredError(message);
    throw new ApiError(res.status, message, body, requestId);
  }
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
  return (await res.json()) as T;
}

function docPath(path: string): string {
  return `/api/docs/${encodeDocPath(path)}`;
}

export const httpApi: KbApi = {
  health: () => json<HealthResponse>('/api/health'),

  tree(params = {}) {
    const q = new URLSearchParams();
    if (params.prefix) q.set('prefix', params.prefix);
    if (params.limit != null) q.set('limit', String(params.limit));
    const qs = q.toString();
    return json<TreeEntry[]>(`/api/tree${qs ? `?${qs}` : ''}`);
  },

  async getDoc(path, ifNoneMatch) {
    const headers: Record<string, string> = {};
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const res = await request(docPath(path), { headers });
    return (await res.json()) as Doc;
  },

  putDoc(path, raw, ifMatch) {
    return json<UpdateResult>(docPath(path), {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'If-Match': ifMatch,
      },
      body: raw,
    });
  },

  rename(path, to) {
    return json<RenameResult>(`${docPath(path)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ to }),
    });
  },

  search(query, limit = 10) {
    const q = new URLSearchParams({ q: query, limit: String(limit) });
    return json<SearchResponse>(`/api/search?${q.toString()}`);
  },

  backlinks(path) {
    return json<BacklinksResponse>(`${docPath(path)}/backlinks`);
  },

  links(path) {
    return json<LinksResponse>(`${docPath(path)}/links`);
  },

  reportLinks(unresolvedOnly = true) {
    return json<LinksReport>(`/api/reports/links${unresolvedOnly ? '?unresolved=1' : ''}`);
  },

  orphans() {
    return json<OrphansResponse>('/api/reports/orphans');
  },

  reindex() {
    return json<ReindexResult>('/api/admin/reindex', { method: 'POST' });
  },

  async exportZip() {
    const res = await request('/api/export?format=zip');
    return res.blob();
  },
};
