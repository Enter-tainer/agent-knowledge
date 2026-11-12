/** API 错误类型。页面只按类型分流，不猜字符串。 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** 500 时后端会在 body 里给 requestId，用来对日志。 */
  readonly requestId: string | null;

  constructor(status: number, message: string, body?: unknown, requestId?: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.requestId = requestId ?? null;
  }
}

/**
 * 401：Worker 线上走 Cloudflare Access（非 loopback 才校验），本地 loopback 直接放行。
 * 前端不存 token、不发 Authorization，所以 401 只能是「Access 没放行」。
 */
export class UnauthorizedError extends ApiError {
  constructor(message = '没有访问权限（请确认已登录 Cloudflare Access，或联系管理员加入白名单）') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message = '文档不存在') {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(message = '文件已被改（hash 不匹配）') {
    super(412, message);
    this.name = 'ConflictError';
  }
}

/** 428：PUT 已存在文档时必须带当前 `If-Match: <hash>`（`*` 只能用于新建）。 */
export class PreconditionRequiredError extends ApiError {
  constructor(message = '缺少有效的 If-Match（页面可能过期，请重新加载后再保存）') {
    super(428, message);
    this.name = 'PreconditionRequiredError';
  }
}

/** 304：`If-None-Match` 命中，调用方应使用本地缓存。 */
export class NotModifiedError extends Error {
  readonly hash: string;

  constructor(hash: string) {
    super('Not Modified');
    this.name = 'NotModifiedError';
    this.hash = hash;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 给普通用户看的错误文案：不暴露英文后端原文/HTTP 码。 */
export function humanizeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return '网络连接失败，请检查网络后重试。';
    if (err.status === 401 || err.status === 403) return err.message;
    if (err.status === 404) return '没有找到这篇笔记，它可能已被删除或改名。';
    if (err.status === 412 || err.status === 428) return '这篇笔记在别处被改过了，请重新加载后再试。';
    if (err.status === 409) return '操作冲突，请刷新后重试。';
    if (err.status === 413) return '内容太大了，服务器拒绝保存。';
    if (err.status >= 500) {
      const rid = err.requestId ? `（请求 ID：${err.requestId}）` : '';
      return `服务暂时不可用，请稍后重试${rid}。`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function requestIdOf(err: unknown): string | null {
  return err instanceof ApiError ? err.requestId : null;
}
