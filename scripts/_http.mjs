// 共享 HTTP helper（供 scripts/*.mjs 使用）。Worker 不做鉴权：
// - 本地：wrangler dev 只监听 127.0.0.1，直接请求即可；
// - 远程：请求经过 Cloudflare Access，可用三种凭据之一：
//   1) Managed OAuth token（按标准数据目录存放，按 BASE 匹配；过期会自动调 agent-oauth 续期）
//   2) service token（KB_ACCESS_CLIENT_ID / KB_ACCESS_CLIENT_SECRET）
//   3) 显式 KB_OAUTH_TOKEN=<access_token>
//
// 用 node:https 而不是 fetch：本机到 Cloudflare 的 fetch 偶发连接超时；同时统一加了超时和重试。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = process.env.KB_BASE ?? argValue('--base') ?? 'http://127.0.0.1:8787';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * token 放标准「应用数据」目录，不是 cache：
 * token 需要人工重新登录才能重建，放 cache 会被系统当可清理数据删掉；也不放 Roaming 配置目录。
 * - Linux: $XDG_DATA_HOME/agent-knowledge（默认 ~/.local/share/agent-knowledge）
 * - macOS: ~/Library/Application Support/agent-knowledge
 * - Windows: %LOCALAPPDATA%\agent-knowledge
 */
function defaultTokenFile() {
  const env = process.env;
  let dir;
  if (process.platform === 'win32') dir = join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agent-knowledge');
  else if (process.platform === 'darwin') dir = join(homedir(), 'Library', 'Application Support', 'agent-knowledge');
  else dir = join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'agent-knowledge');
  return join(dir, 'oauth.json');
}

function tokenFileCandidates() {
  if (process.env.AGENT_OAUTH_FILE) return [resolve(process.env.AGENT_OAUTH_FILE)];
  return [
    defaultTokenFile(),
    join(homedir(), '.agent-knowledge', 'oauth.json'), // 旧版位置，自动兼容
    resolve('.auth/oauth.json'), // 仓库本地开发
  ];
}

const tokenFile = () => tokenFileCandidates().find(existsSync) ?? defaultTokenFile();
// 与 _http.mjs 同目录的 agent-oauth.mjs（仓库和独立安装的 skill 里都成立）
const OAUTH_SCRIPT = fileURLToPath(new URL('./agent-oauth.mjs', import.meta.url));

/** 读取 OAuth access token；过期则调用 agent-oauth.mjs 静默续期。 */
function oauthToken() {
  if (process.env.KB_OAUTH_TOKEN) return process.env.KB_OAUTH_TOKEN.trim();
  let store;
  try {
    store = JSON.parse(readFileSync(tokenFile(), 'utf8'));
  } catch {
    return null;
  }
  const entry = store.hosts?.[BASE];
  if (!entry?.accessToken) return null;
  if (typeof entry.expiresAt !== 'number' || entry.expiresAt > Date.now() + 60_000) return entry.accessToken;
  try {
    const fresh = execFileSync(process.execPath, [OAUTH_SCRIPT, 'token', BASE], { encoding: 'utf8' });
    return fresh.trim() || null;
  } catch {
    return entry.accessToken;
  }
}

export function headers(extra = {}) {
  const h = { ...extra };
  const id = process.env.KB_ACCESS_CLIENT_ID;
  const secret = process.env.KB_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    h['cf-access-client-id'] = id;
    h['cf-access-client-secret'] = secret;
  } else {
    const token = oauthToken();
    if (token) h.authorization = `Bearer ${token}`;
  }
  return h;
}

function makeResponse(status, statusText, rawHeaders, buf) {
  const headerMap = rawHeaders ?? {};
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => {
        const v = headerMap[String(name).toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : (v ?? null);
      },
    },
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function doRequest(url, init, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = mod(
      u,
      {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        family: 4,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolvePromise(makeResponse(res.statusCode ?? 0, res.statusMessage ?? '', res.headers, Buffer.concat(chunks))));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

async function requestWithRetry(path, init = {}, attempts = 3) {
  const url = new URL(path, BASE).toString();
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await doRequest(url, init, 90_000);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw new Error(`${url} 请求失败：${lastErr?.code ?? lastErr?.message}`);
}

export async function api(path, init = {}) {
  return requestWithRetry(path, { ...init, headers: headers(init.headers ?? {}) });
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
  if (cond) ok(message);
  else fail(message);
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
