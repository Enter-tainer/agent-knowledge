/**
 * 一次性工具：把某份**已有构建产物**（如 .reviews-tmp 里的 HEAD 快照）在本地静态托管，
 * 并把 `/api/*` 反向代理到正在跑的 wrangler dev，用于「修复前基线」取证。
 *
 * 不属于验收交付物，只在需要对比旧 dist 时临时用：
 *   node web/e2e/serve-dist.mjs --dist .reviews-tmp/ci-final/web/dist --port 8899 --api http://127.0.0.1:8787
 * 然后 `node web/e2e/nav-check.mjs --base http://127.0.0.1:8899 --out docs/evidence/baseline-nav-check.json`。
 *
 * 只读：不改 dist、不写 D1；SPA fallback 与 wrangler 的 single-page-application 行为一致。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const distRoot = resolve(arg('dist', 'web/dist'));
const port = Number(arg('port', '8899'));
const apiBase = String(arg('api', 'http://127.0.0.1:8787')).replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

if (!existsSync(join(distRoot, 'index.html'))) {
  console.error(`找不到 ${join(distRoot, 'index.html')}；用 --dist 指定构建产物目录`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      const target = `${apiBase}${url.pathname}${url.search}`;
      const upstream = await fetch(target, {
        method: req.method,
        headers: { accept: req.headers.accept || 'application/json' },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `proxy failed: ${String(error)}` }));
    }
    return;
  }

  const candidate = normalize(join(distRoot, decodeURIComponent(url.pathname)));
  if (candidate.startsWith(distRoot) && existsSync(candidate) && statSync(candidate).isFile()) {
    res.writeHead(200, { 'content-type': MIME[extname(candidate)] || 'application/octet-stream' });
    createReadStream(candidate).pipe(res);
    return;
  }

  // SPA fallback：和 wrangler 的 not_found_handling = "single-page-application" 一致
  res.writeHead(200, { 'content-type': MIME['.html'] });
  createReadStream(join(distRoot, 'index.html')).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${distRoot} on http://127.0.0.1:${port} (api → ${apiBase})`);
});
