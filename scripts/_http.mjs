// 共享 HTTP helper（供 scripts/*.mjs 使用）。Worker 不做鉴权：
// - 本地：wrangler dev 只监听 127.0.0.1，直接请求即可；
// - 远程：请求经过 Cloudflare Access，脚本可用 service token（CF-Access-* 头）由边缘校验。
export const BASE = process.env.KB_BASE ?? argValue('--base') ?? 'http://127.0.0.1:8787';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function headers(extra = {}) {
  const h = { ...extra };
  const id = process.env.KB_ACCESS_CLIENT_ID;
  const secret = process.env.KB_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    h['cf-access-client-id'] = id;
    h['cf-access-client-secret'] = secret;
  }
  return h;
}

export async function api(path, init = {}) {
  return fetch(new URL(path, BASE), { ...init, headers: headers(init.headers ?? {}) });
}

export async function apiJson(path, init = {}) {
  const res = await api(path, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { status: res.status, body };
}

export const docUrl = (path) => `/api/docs/${encodeURIComponent(path)}`;

export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

export function ok(message) {
  console.log(`ok  ${message}`);
}

export function assert(cond, message) {
  if (!cond) fail(message);
  else ok(message);
  return cond;
}

export async function cleanup(paths) {
  for (const p of paths) {
    try {
      await api(`${docUrl(p)}?force=1`, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
  }
}
