import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './env';
import { ApiError, errorJson, json, MAX_DOC_BYTES, MAX_JSON_BYTES, normalizeDocPath } from './env';
import { accessGuard } from './access';
import {
  allInternalLinks,
  backlinks,
  deleteDocument,
  documentExists,
  exportAll,
  getDocument,
  health,
  listDocuments,
  orphanDocuments,
  outgoingLinks,
  putDocument,
  reindexAll,
  renameDocument,
  resolveAllLinks,
  searchDocuments,
  staleDocuments,
  unresolvedLinks,
} from './db';
import { zipStore } from './lib/zip';

type AppEnv = { Bindings: Env };
type C = Context<AppEnv>;

const MAX_QUERY_CHARS = 500;
const MAX_QUERY_TERMS = 50;
const MAX_PREFIX_CHARS = 200;
const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

const app = new Hono<AppEnv>();

app.get('/healthz', (c) => c.json({ ok: true }));

// 自描述入口：agent 只读一次就能拿到契约（避免去读 500 行 plan）
app.get('/api', (c) =>
  c.json({
    name: 'agent-knowledge',
    version: 1,
    auth: 'local loopback: none; deployed: Cloudflare Access JWT (verified in Worker)',
    conventions: {
      path: '文档 path 是 vault 相对路径，不带 .md；中文/空格/全角冒号需 URL 编码',
      error: '{ "error": string }（500 额外带 requestId）；400 参数/路径非法，404 不存在，405 方法不允许，409 冲突，412 If-Match 过期，413 过大，428 缺 If-Match',
      write: 'PUT 新建必须 If-Match: *；修改必须 If-Match: <hash>（引号/裸 hash 都接受）。GET 返回 ETag: "<hash>"',
      search: 'score 为 bm25 负数（越小越相关），relevance = -score（越大越相关）',
    },
    endpoints: [
      { method: 'GET', path: '/api/health', desc: '健康检查；返回 docs / stale / tokenizerVersion' },
      { method: 'GET', path: '/api/tree?prefix=&limit=', desc: '列目录（path/title/tags/size/updated），limit 默认 500 上限 2000' },
      { method: 'GET', path: '/api/docs/{path}', desc: '读一篇（raw/frontmatter/hash/revision/stale）；支持 If-None-Match → 304' },
      { method: 'PUT', path: '/api/docs/{path}', desc: '写一篇（body=完整 md）；If-Match: * 新建，If-Match: <hash> 修改' },
      { method: 'DELETE', path: '/api/docs/{path}?force=1', desc: '删除；有反链时 409，force=1 强删并把入链变断链' },
      { method: 'POST', path: '/api/docs/{path}/rename', desc: '{"to":"新路径"}；改 path + 全库改写引用；返回 rewritten/unresolved' },
      { method: 'GET', path: '/api/docs/{path}/links', desc: '出链（target/resolved/dstPath/line）' },
      { method: 'GET', path: '/api/docs/{path}/backlinks', desc: '反链（按来源去重 + 提及次数）' },
      { method: 'GET', path: '/api/search?q=&limit=', desc: '检索（中文 ≥2 字；标识符前缀）；limit 默认 10 上限 50' },
      { method: 'GET', path: '/api/reports/links?unresolved=1', desc: '断链清单；不带参数返回全部内部链接' },
      { method: 'GET', path: '/api/reports/orphans', desc: '无入链文档' },
      { method: 'GET', path: '/api/reports/stale', desc: '索引落后正文的文档（可 POST /api/admin/reindex 修复）' },
      { method: 'GET', path: '/api/export?format=json|zip', desc: '导出全库 md' },
      { method: 'POST', path: '/api/admin/resolve-links', desc: '全库重解析双链（导入后/手动修复）' },
      { method: 'POST', path: '/api/admin/reindex', desc: '重建检索索引 + 清孤儿行；返回 stale（应 0）' },
    ],
  }),
);

// 鉴权：非 loopback 走 Cloudflare Access JWT 校验（官方 @hono/cloudflare-access 中间件）
app.use('/api/*', accessGuard());

const get = (path: string, handler: (c: C) => Promise<Response> | Response): void => {
  app.on(['GET', 'HEAD'], path, async (c) => {
    const res = await handler(c);
    if (c.req.method !== 'HEAD') return res;
    return new Response(null, { status: res.status, headers: res.headers });
  });
};

get('/api/health', async (c) => json(await health(c.env)));

get('/api/tree', async (c) => {
  assertOnlyParams(c, ['prefix', 'limit']);
  const prefix = c.req.query('prefix') ?? '';
  if (prefix.length > MAX_PREFIX_CHARS) throw new ApiError(400, `prefix 过长（>${MAX_PREFIX_CHARS} 字符）`);
  if (/[\u0000-\u001f]/.test(prefix)) throw new ApiError(400, 'prefix 含控制字符');
  if (prefix.startsWith('/') || prefix.includes('..')) throw new ApiError(400, 'prefix 必须是 vault 相对前缀');
  const limit = clampInt(c.req.query('limit') ?? null, 1, 2000, 500);
  return json(await listDocuments(c.env, prefix, limit));
});

get('/api/search', async (c) => {
  assertOnlyParams(c, ['q', 'limit']);
  const q = c.req.query('q') ?? '';
  if (q.length > MAX_QUERY_CHARS) throw new ApiError(400, `查询过长（>${MAX_QUERY_CHARS} 字符）`);
  if (q.trim().split(/\s+/).filter(Boolean).length > MAX_QUERY_TERMS) {
    throw new ApiError(400, `查询词过多（>${MAX_QUERY_TERMS} 个）`);
  }
  const limit = clampInt(c.req.query('limit') ?? null, 1, 50, 10);
  return json(await searchDocuments(c.env, q, limit));
});

get('/api/reports/links', async (c) => {
  assertOnlyParams(c, ['unresolved']);
  const onlyUnresolved = parseBoolParam(c, 'unresolved');
  if (onlyUnresolved === true) {
    const unresolved = await unresolvedLinks(c.env);
    return json({ unresolved, count: unresolved.length });
  }
  const links = await allInternalLinks(c.env);
  return json({ links, count: links.length });
});

get('/api/reports/orphans', async (c) => json({ orphans: await orphanDocuments(c.env) }));

get('/api/reports/stale', async (c) => {
  const stale = await staleDocuments(c.env);
  return json({ stale, count: stale.length });
});

get('/api/export', async (c) => {
  assertOnlyParams(c, ['format']);
  const format = c.req.query('format') ?? 'json';
  if (format !== 'json' && format !== 'zip') {
    throw new ApiError(400, `format 只支持 json|zip，收到 "${format}"`);
  }
  const entries = await exportAll(c.env);
  if (format !== 'zip') return json({ documents: entries });

  const totalBytes = entries.reduce((n, e) => n + new TextEncoder().encode(e.raw).length, 0);
  if (entries.length > 50_000 || totalBytes > MAX_EXPORT_BYTES) {
    throw new ApiError(413, '导出规模过大，请改用 D1 备份流程');
  }
  const zip = zipStore(entries.map((e) => ({ name: `${e.path}.md`, data: new TextEncoder().encode(e.raw) })));
  return new Response(zip, {
    headers: {
      'content-type': 'application/zip',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="agent-knowledge-${new Date().toISOString().slice(0, 10)}.zip"`,
    },
  });
});

app.post('/api/admin/resolve-links', async (c) => json(await resolveAllLinks(c.env)));
app.post('/api/admin/reindex', async (c) => json(await reindexAll(c.env)));

// 文档路由：通配后自行解析（因为要支持 /docs/{path}/rename 这类后缀）
app.all('/api/docs/*', async (c) => {
  const rawPath = new URL(c.req.url).pathname.slice('/api/docs/'.length);
  const res = await handleDocs(c, rawPath);
  if (c.req.method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
});

// 集合路径：方法不对要 405 而不是 404
const COLLECTIONS = [
  '/api/health',
  '/api/tree',
  '/api/search',
  '/api/reports/links',
  '/api/reports/orphans',
  '/api/reports/stale',
  '/api/export',
];
for (const p of COLLECTIONS) {
  app.on(['POST', 'PUT', 'DELETE', 'PATCH'], p, (c) =>
    errorJson(405, `method not allowed: ${c.req.method} ${p}（该路径只支持 GET/HEAD）`, {
      allow: 'GET, HEAD',
    }),
  );
}
for (const p of ['/api/admin/resolve-links', '/api/admin/reindex']) {
  app.on(['GET', 'PUT', 'DELETE', 'PATCH'], p, (c) =>
    errorJson(405, `method not allowed: ${c.req.method} ${p}（该路径只支持 POST）`, { allow: 'POST' }),
  );
}
app.all('/api/docs', () => errorJson(404, 'unknown route: /api/docs（文档详情请用 /api/docs/{path}）'));

async function handleDocs(c: C, rawPath: string): Promise<Response> {
  const method = c.req.method.toUpperCase() === 'HEAD' ? 'GET' : c.req.method.toUpperCase();
  if (!rawPath) throw new ApiError(404, 'unknown route: /api/docs（文档详情请用 /api/docs/{path}）');

  if (method === 'POST' && rawPath.endsWith('/rename')) {
    const from = normalizeDocPath(rawPath.slice(0, -'/rename'.length));
    const body = await readJson<{ to?: unknown }>(c);
    if (!body || typeof body.to !== 'string' || !body.to.trim()) {
      throw new ApiError(400, 'body 需要 {"to": "新路径"}');
    }
    const to = normalizeDocPath(body.to);
    if (to === from) return json({ from, to, rewritten: 0, unresolved: 0 });
    return json(await renameDocument(c.env, from, to));
  }

  if (method === 'GET' && rawPath.endsWith('/links')) {
    const path = normalizeDocPath(rawPath.slice(0, -'/links'.length));
    if (!(await documentExists(c.env, path))) throw new ApiError(404, `document not found: ${path}`);
    return json({ path, links: await outgoingLinks(c.env, path) });
  }

  if (method === 'GET' && rawPath.endsWith('/backlinks')) {
    const path = normalizeDocPath(rawPath.slice(0, -'/backlinks'.length));
    if (!(await documentExists(c.env, path))) throw new ApiError(404, `document not found: ${path}`);
    return json({ path, backlinks: await backlinks(c.env, path) });
  }

  const path = normalizeDocPath(rawPath);

  if (method === 'GET') {
    const doc = await getDocument(c.env, path);
    const etag = `"${doc.hash}"`;
    const ifNoneMatch = normalizeEtag(c.req.header('if-none-match') ?? null);
    if (ifNoneMatch && ifNoneMatch === doc.hash) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return json(doc, { headers: { etag } });
  }

  if (method === 'PUT') {
    const raw = await readTextCapped(c.req.raw, MAX_DOC_BYTES);
    // If-Match 既接受裸 hash，也接受标准 ETag 形态（"hash" / W/"hash"）
    const ifMatch = normalizeEtag(c.req.header('if-match') ?? null);
    return json(await putDocument(c.env, path, raw, ifMatch));
  }

  if (method === 'DELETE') {
    const force = c.req.query('force') === '1';
    return json(await deleteDocument(c.env, path, force));
  }

  throw new ApiError(405, `method not allowed: ${c.req.method} /api/docs/{path}`);
}

app.options('*', () => new Response(null, { status: 204, headers: { allow: 'GET,HEAD,PUT,POST,DELETE,OPTIONS' } }));

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return errorJson(404, `unknown route: ${c.req.method} ${c.req.path}`);
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not Found', 404);
});

app.onError((err, c) => {
  if (err instanceof ApiError) return errorJson(err.status, err.message);
  const requestId = crypto.randomUUID();
  console.error('unhandled', requestId, c.req.path, err instanceof Error ? err.stack : err);
  return errorJson(500, 'internal error', { requestId });
});

function normalizeEtag(value: string | null): string | null {
  if (!value) return null;
  const stripped = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return stripped || null;
}

async function readTextCapped(request: Request, cap: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > cap) {
    throw new ApiError(413, `body 过大（content-length ${declared} > ${cap}）`);
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, `body 过大（>${cap} bytes）`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function readJson<T>(c: C): Promise<T | null> {
  const text = await readTextCapped(c.req.raw, MAX_JSON_BYTES);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'body 不是合法 JSON');
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
}

/** 拒绝未知 query 参数：静默忽略会让 agent 拿到「成功」的错答案。 */
function assertOnlyParams(c: C, allowed: string[]): void {
  for (const key of new URL(c.req.url).searchParams.keys()) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, `未知查询参数 "${key}"（允许：${allowed.join(', ')}）`);
    }
  }
}

/** unresolved=1/true/yes → true；0/false/no → false；缺省 → null；其它 → 400。 */
function parseBoolParam(c: C, name: string): boolean | null {
  const value = c.req.query(name);
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  throw new ApiError(400, `参数 ${name} 只支持 1/true/yes 或 0/false/no`);
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export default app;
