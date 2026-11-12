export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Cloudflare Access 验签参数（生产必需；本地 loopback 不需要） */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS_URL?: string;
}

export const MAX_DOC_BYTES = 1_500_000; // D1 行/字符串上限 2MB，留余量
export const MAX_JSON_BYTES = 64 * 1024; // rename/confirm 这类 JSON body 的上限

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

/** 不向未鉴权调用者泄露服务端配置细节。 */
export function unavailable(): Response {
  return json({ error: 'service unavailable' }, { status: 503 });
}

export function nowIso(): string {
  return new Date().toISOString();
}

const FORBIDDEN_CHARS = /["<>|?*:\\\u0000-\u001f\u007f\u2028\u2029\ufeff]/;

/** 规范化文档 path：只接受 vault 相对路径；拒绝绝对路径、..、隐藏目录、Windows/zip 非法字符。 */
export function normalizeDocPath(input: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    throw new ApiError(400, 'path 编码非法');
  }
  const unified = decoded.normalize('NFC').replace(/\\/g, '/');
  if (!unified) throw new ApiError(400, 'path 不能为空');
  if (unified !== unified.trim()) throw new ApiError(400, 'path 不能带首尾空白');
  if (unified.includes('\u00a0')) throw new ApiError(400, 'path 不能含 NBSP');
  if (FORBIDDEN_CHARS.test(unified)) throw new ApiError(400, 'path 含非法字符（" < > | ? * : \\ 或控制字符）');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new ApiError(400, 'path 必须是 vault 相对路径');
  }
  const cleaned = unified.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!cleaned) throw new ApiError(400, 'path 不能为空');
  const segments = cleaned.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s.length === 0)) {
    throw new ApiError(400, 'path 不能包含 . / .. 段');
  }
  if (segments.some((s) => s.startsWith('.'))) throw new ApiError(400, 'path 不能指向隐藏目录');
  if (cleaned.length > 512) throw new ApiError(400, 'path 过长');
  return cleaned.replace(/\.md$/i, '');
}
