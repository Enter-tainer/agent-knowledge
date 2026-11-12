#!/usr/bin/env node
// Cloudflare Access **Managed OAuth** 的 agent 登录小工具（零依赖，Node 18+）。
//
// 流程（RFC 9728 / RFC 8414 / RFC 7591 + authorization code + PKCE）：
//   1. GET 一个受保护 URL → 401 + WWW-Authenticate: ... resource_metadata="…"
//   2. 拉资源元数据 → authorization_servers[0] → 拉 AS 元数据（授权/令牌/注册端点）
//   3. 动态注册一个 public client（localhost/127.0.0.1 回调）
//   4. 本地起回调服务器 + 打开浏览器 → 你用邮箱/SSO 登录一次 → 拿到 code
//   5. 换 access_token（默认 15 分钟）+ refresh_token（grant session，可到 1–2 周）
//   6. 之后 `token` 命令自动用 refresh_token 静默续期，`curl` 命令直接带 Bearer 请求
//
// 用法：
//   node scripts/agent-oauth.mjs login  https://kb.example.com
//   node scripts/agent-oauth.mjs token  https://kb.example.com        # 打印 access_token
//   node scripts/agent-oauth.mjs curl   https://kb.example.com /api/health
//   node scripts/agent-oauth.mjs status https://kb.example.com
//
// 前置（一次性，在 Access 应用里）：Advanced settings → 打开 Managed OAuth；
//   建议同时打开 "Allow localhost clients" / "Allow loopback clients"、
//   Access token lifetime 5–15m、Grant session duration 1–2 周。
// token 存在标准「应用数据」目录（不是 cache）：Linux ~/.local/share/agent-knowledge/oauth.json、
// macOS ~/Library/Application Support/agent-knowledge/oauth.json、Windows %LOCALAPPDATA%\agent-knowledge\oauth.json；
// 可用 --token-file 或 AGENT_OAUTH_FILE 覆盖。
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setDefaultResultOrder } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// 国内网络里 Cloudflare 域名的 AAAA 有时会黑洞：优先 IPv4，避免 Node fetch 卡 10s+ 超时
try {
  setDefaultResultOrder('ipv4first');
} catch {
  /* 老 Node 忽略 */
}

/** 用 node:https 而不是 fetch：本机到 Cloudflare 的 fetch 偶发连接超时，https+IPv4 稳定得多。 */
function rawRequest(url, init, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
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
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            headers: {
              get: (name) => {
                const v = res.headers[String(name).toLowerCase()];
                return Array.isArray(v) ? v.join(', ') : (v ?? null);
              },
            },
            text: async () => body,
            json: async () => JSON.parse(body),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (init.body != null) req.write(String(init.body));
    req.end();
  });
}

/** 请求 + 超时 + 重试 + 手动跳转（发现端点偶发连接超时）。 */
async function request(url, init = {}, label = '请求', attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      let current = url;
      let res = await rawRequest(current, init);
      if (init.redirect !== 'manual') {
        let hops = 0;
        while ([301, 302, 303, 307, 308].includes(res.status) && hops++ < 5) {
          const loc = res.headers.get('location');
          if (!loc) break;
          current = new URL(loc, current).toString();
          const method = init.method ?? 'GET';
          const nextMethod = res.status === 303 || ([301, 302].includes(res.status) && method === 'GET') ? 'GET' : method;
          res = await rawRequest(current, { ...init, method: nextMethod, body: nextMethod === 'GET' ? undefined : init.body });
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw Object.assign(new Error(`${label} 连接失败：${lastErr?.cause?.code ?? lastErr?.message}`), {
    cause: lastErr?.cause,
  });
}

const args = process.argv.slice(2);
const opts = parseOpts(args);

/** 标准「应用数据」目录：token 不能放 cache（会被当可清理数据），也不放 Roaming。 */
function dataDir() {
  const env = process.env;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agent-knowledge');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'agent-knowledge');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'agent-knowledge');
}

function resolveTokenFile() {
  const explicit = opts['token-file'] ?? process.env.AGENT_OAUTH_FILE;
  if (explicit) return resolve(explicit);
  const candidates = [
    join(dataDir(), 'oauth.json'),
    join(homedir(), '.agent-knowledge', 'oauth.json'), // 旧版位置，自动兼容
    resolve('.auth/oauth.json'), // 仓库本地开发
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

const tokenFile = resolveTokenFile();
const command = opts._[0];
const baseUrl = normalizeBase(opts._[1] ?? process.env.KB_BASE_URL ?? '');

const log = (...a) => console.error(...a);
const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

function parseOpts(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out['no-open'] = true;
    else if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

function normalizeBase(u) {
  if (!u) return '';
  const s = u.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) die(`base URL 必须以 http(s):// 开头：${u}`);
  return s;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const sha256 = (s) => createHash('sha256').update(s).digest();
const now = () => Date.now();

function loadStore() {
  if (!existsSync(tokenFile)) return { version: 1, hosts: {} };
  try {
    return JSON.parse(readFileSync(tokenFile, 'utf8'));
  } catch {
    die(`token 文件解析失败：${tokenFile}（删掉它重新 login 即可）`);
  }
}

function saveStore(store) {
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {
    /* Windows 上忽略 */
  }
}

async function jsonFetch(url, init, label) {
  let res;
  try {
    res = await request(url, init, label);
  } catch (err) {
    die(`${label} 请求失败：${err.cause?.code ?? err.message}\n  ${url}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    die(`${label} 失败（HTTP ${res.status}）\n  ${url}\n  ${text.slice(0, 400)}`);
  }
  return body;
}

/** 探测受保护资源，返回 { resourceMetadataUrl, resource, authorizationServer }。 */
async function discover(base) {
  // 默认探根路径（Access 对所有路径都会返回 401/302）；某些站点的 /api/health 走得慢
  const probePath = String(opts['probe-path'] ?? '/');
  const probeUrl = `${base}${probePath.startsWith('/') ? '' : '/'}${probePath}`;
  const probe = await request(probeUrl, { headers: { accept: 'application/json' }, redirect: 'manual' }, '探测受保护资源').catch((err) =>
    die(`无法连接 ${probeUrl}：${err.cause?.code ?? err.message}`),
  );

  if (probe.status === 200) {
    die(
      `${base} 返回 200（没有 Access 拦截）。\n` +
        `  · 本地 wrangler dev：本来就不需要登录，直接用即可。\n` +
        `  · 线上：确认这个域名确实挂着 Cloudflare Access。`,
    );
  }

  let resourceMetadataUrl = `${base}/.well-known/cloudflare-access-protected-resource/`;
  if (probe.status === 401) {
    const wwwAuth = probe.headers.get('www-authenticate') ?? '';
    const m = /resource_metadata="([^"]+)"/.exec(wwwAuth);
    if (m) resourceMetadataUrl = m[1];
    else log('⚠ 401 里没有 www-authenticate/resource_metadata，尝试默认 well-known 地址');
  } else if (probe.status >= 300 && probe.status < 400) {
    die(
      `拿到 ${probe.status} 重定向：这个 Access 应用还在走浏览器登录。\n` +
        `  去 Zero Trust → Access → Applications → 该应用 → Advanced settings → 打开 Managed OAuth，再重试。`,
    );
  } else {
    log(`⚠ 探测返回 HTTP ${probe.status}，继续尝试 OAuth 发现流程`);
  }

  const meta = await jsonFetch(resourceMetadataUrl, { headers: { accept: 'application/json' } }, '资源元数据');
  const as = Array.isArray(meta.authorization_servers) ? meta.authorization_servers[0] : undefined;
  if (!as) die(`资源元数据里没有 authorization_servers：${JSON.stringify(meta).slice(0, 300)}`);
  return { resourceMetadataUrl, resource: String(meta.resource ?? base), authorizationServer: String(as) };
}

/** RFC 8414：授权服务器元数据。 */
async function discoverAs(authorizationServer) {
  const url = `${authorizationServer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`;
  const meta = await jsonFetch(url, { headers: { accept: 'application/json' } }, 'OAuth AS 元数据');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (!meta[key]) {
      die(
        `AS 元数据缺 ${key}：可能没开 Managed OAuth，或没开 Dynamic Client Registration。\n  ${url}\n  ${JSON.stringify(meta).slice(0, 500)}`,
      );
    }
  }
  if (!(meta.code_challenge_methods_supported ?? []).includes('S256')) log('⚠ AS 没声明 S256，PKCE 可能失败');
  return meta;
}

async function registerClient(asMeta, redirectUri, resource) {
  // 官方文档的最小注册体是把 grant_types 只声明 authorization_code；有些实现会拒绝
  // 未声明的 refresh_token，所以先试完整声明，失败再退回官方最小体。
  const attempts = [
    {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'agent-knowledge CLI',
      resource,
    },
    {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'agent-knowledge CLI',
    },
  ];
  let lastError = '';
  for (const body of attempts) {
    const res = await request(asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let reg = null;
    try {
      reg = text ? JSON.parse(text) : null;
    } catch {
      reg = null;
    }
    if (res.ok && reg?.client_id) return reg.client_id;
    lastError = `HTTP ${res.status}：${text.slice(0, 300)}`;
  }
  die(`动态客户端注册失败（DCR 可能没开）：${lastError}\n  可在 Managed OAuth 设置里打开 Dynamic Client Registration，或改用 cloudflared access curl。`);
}

/** 在 127.0.0.1 上找一个可用端口，并返回 { server, port }。 */
function listenOnFreePort(preferred = 8400, tries = 10) {
  return new Promise((resolvePort, reject) => {
    let attempt = 0;
    const tryPort = (port) => {
      const server = createServer();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < tries) {
          attempt += 1;
          return tryPort(preferred + attempt);
        }
        reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolvePort({ server, port }));
    };
    tryPort(preferred);
  });
}

function waitForCode(server, expectedState, timeoutMs) {
  return new Promise((resolveCode, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`等待浏览器回调超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const params = url.searchParams;
      const code = params.get('code');
      const state = params.get('state');
      const error = params.get('error');
      const send = (status, html) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      };
      if (error) {
        send(200, `<h1>授权失败</h1><p>${escapeHtml(error)}: ${escapeHtml(params.get('error_description') ?? '')}</p>`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`${error}: ${params.get('error_description') ?? ''}`));
        return;
      }
      if (!code) {
        send(400, '<h1>缺少 code</h1>');
        return;
      }
      if (state && expectedState && state !== expectedState) {
        send(400, '<h1>state 不匹配</h1>');
        clearTimeout(timer);
        server.close();
        reject(new Error('state 不匹配（可能是 CSRF 或浏览器缓存了旧链接）'));
        return;
      }
      send(200, '<h1>✓ 登录成功</h1><p>可以关闭这个页面，回到终端。</p>');
      clearTimeout(timer);
      server.close();
      resolveCode(code);
    });
  });
}

function openBrowser(url) {
  // Windows 上不能用 `cmd /c start <url>`：URL 里的 `&` 会被 cmd 当成命令分隔符，
  // 授权参数（resource/state）会被截断 → Cloudflare 报 invalid_target: No resource parameter found。
  // rundll32 接收的是单独一个 argv，不经过 cmd 解析，安全。
  const cmd =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    execFile(cmd[0], cmd[1], { windowsHide: true }, () => undefined);
  } catch {
    /* 打不开就让用户手动点 */
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

async function exchangeCode(ctx, code, verifier) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: ctx.clientId,
    redirect_uri: ctx.redirectUri,
    code_verifier: verifier,
    resource: ctx.resource,
  });
  return jsonFetch(
    ctx.tokenEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form,
    },
    '换取 access_token',
  );
}

function entryFromTokenResponse(ctx, tokens) {
  return {
    base: ctx.base,
    clientId: ctx.clientId,
    redirectUri: ctx.redirectUri,
    resource: ctx.resource,
    authorizationServer: ctx.authorizationServer,
    tokenEndpoint: ctx.tokenEndpoint,
    accessToken: tokens.access_token,
    tokenType: tokens.token_type ?? 'bearer',
    expiresAt: now() + Math.max(0, Number(tokens.expires_in ?? 900) - 30) * 1000,
    refreshToken: tokens.refresh_token ?? null,
    updatedAt: new Date().toISOString(),
  };
}

async function login(base) {
  log(`→ 探测受保护资源：${base}`);
  const disc = await discover(base);
  log(`  authorization server: ${disc.authorizationServer}`);
  const asMeta = await discoverAs(disc.authorizationServer);

  const { server, port } = await listenOnFreePort(Number(opts.port ?? 8400));
  const redirectHost = String(opts['redirect-host'] ?? 'localhost');
  const redirectUri = `http://${redirectHost}:${port}/callback`;
  // RFC 8707：resource 一般用资源元数据里的 `resource`；个别实现要求带尾斜杠，可用 --resource 覆盖
  const resource = String(opts.resource ?? disc.resource);
  log(`→ 动态注册 public client（redirect: ${redirectUri}）`);
  const clientId = await registerClient(asMeta, redirectUri, resource);

  const verifier = b64url(randomBytes(48));
  let challenge = b64url(sha256(verifier));
  // 官方文档：challenge 必须以字母数字开头，否则 AS 的 URL 解析会出问题
  while (!/^[a-zA-Z0-9]/.test(challenge)) {
    challenge = b64url(sha256(b64url(randomBytes(48))));
  }
  const state = b64url(randomBytes(16));

  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', resource);
  authUrl.searchParams.set('state', state);

  const codePromise = waitForCode(server, state, Number(opts.timeout ?? 180) * 1000);
  log('\n→ 在浏览器里完成 Cloudflare Access 登录（邮箱验证码 / SSO）：');
  console.log(authUrl.toString());
  if (!opts['no-open']) openBrowser(authUrl.toString());

  const code = await codePromise;
  const tokens = await exchangeCode(
    {
      base,
      clientId,
      redirectUri,
      resource,
      authorizationServer: disc.authorizationServer,
      tokenEndpoint: asMeta.token_endpoint,
    },
    code,
    verifier,
  );
  const entry = entryFromTokenResponse(
    {
      base,
      clientId,
      redirectUri,
      resource,
      authorizationServer: disc.authorizationServer,
      tokenEndpoint: asMeta.token_endpoint,
    },
    tokens,
  );
  const store = loadStore();
  store.hosts[base] = entry;
  saveStore(store);

  console.log(`\n✓ 登录成功，token 已保存：${tokenFile}`);
  console.log(`  access_token: ${mask(entry.accessToken)}（${new Date(entry.expiresAt).toLocaleString()} 过期）`);
  console.log(`  refresh_token: ${entry.refreshToken ? '有（session 过期前可静默续期）' : '无'}`);
  console.log(`\n下一步：node scripts/agent-oauth.mjs curl ${base} /api/health`);
}

async function refresh(entry) {
  if (!entry.refreshToken) throw new Error('没有 refresh_token，请重新 login');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: entry.refreshToken,
    client_id: entry.clientId,
    resource: entry.resource,
  });
  const tokens = await jsonFetch(
    entry.tokenEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form,
    },
    '刷新 access_token',
  );
  const next = { ...entry, accessToken: tokens.access_token, tokenType: tokens.token_type ?? 'bearer' };
  next.expiresAt = now() + Math.max(0, Number(tokens.expires_in ?? 900) - 30) * 1000;
  if (tokens.refresh_token) next.refreshToken = tokens.refresh_token;
  next.updatedAt = new Date().toISOString();
  return next;
}

async function getAccessToken(base) {
  const store = loadStore();
  const entry = store.hosts[base];
  if (!entry) {
    die(
      `还没有 ${base} 的 token。先运行：\n  node scripts/agent-oauth.mjs login ${base}\n` +
        `（前提：Access 应用已打开 Managed OAuth）`,
    );
  }
  if (entry.accessToken && entry.expiresAt > now() + 60_000) return entry;
  log('→ access_token 快过期，用 refresh_token 续期……');
  let next;
  try {
    next = await refresh(entry);
  } catch (err) {
    die(`续期失败（grant session 可能已过期）：${err.message}\n  重新登录：node scripts/agent-oauth.mjs login ${base}`);
  }
  store.hosts[base] = next;
  saveStore(store);
  return next;
}

function mask(t) {
  if (!t) return '(空)';
  return t.length <= 16 ? t : `${t.slice(0, 10)}…${t.slice(-6)}`;
}

async function main() {
  if (!command || command === 'help' || opts.help) {
    console.log(`用法：
  node scripts/agent-oauth.mjs login  <baseUrl>   # 浏览器 SSO 登录（Managed OAuth）
  node scripts/agent-oauth.mjs token  <baseUrl>   # 打印 access_token（自动续期）
  node scripts/agent-oauth.mjs curl   <baseUrl> [path]  # 带 Bearer 请求（默认 /api/health）
  node scripts/agent-oauth.mjs status <baseUrl>   # 看本地 token 状态
选项：--token-file <path>（默认 .auth/oauth.json）、--port <8400>、--no-open、--timeout <秒>、--json
环境变量：KB_BASE_URL、AGENT_OAUTH_FILE`);
    return;
  }
  if (!baseUrl) die('缺少 baseUrl，例如：node scripts/agent-oauth.mjs login https://kb.example.com');

  if (command === 'login') return login(baseUrl);

  if (command === 'status') {
    const entry = loadStore().hosts[baseUrl];
    if (!entry) return console.log(`未登录：${baseUrl}`);
    return console.log(
      JSON.stringify(
        {
          base: entry.base,
          clientId: entry.clientId,
          resource: entry.resource,
          authorizationServer: entry.authorizationServer,
          accessToken: mask(entry.accessToken),
          expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
          expiresInSeconds: entry.expiresAt ? Math.round((entry.expiresAt - now()) / 1000) : null,
          hasRefreshToken: Boolean(entry.refreshToken),
          updatedAt: entry.updatedAt,
          tokenFile,
        },
        null,
        2,
      ),
    );
  }

  if (command === 'token') {
    const entry = await getAccessToken(baseUrl);
    if (opts.json) return console.log(JSON.stringify({ access_token: entry.accessToken, expires_at: new Date(entry.expiresAt).toISOString() }));
    return console.log(entry.accessToken);
  }

  if (command === 'curl') {
    const path = opts._[2] ?? '/api/health';
    const url = /^https?:\/\//i.test(path) ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const entry = await getAccessToken(baseUrl);
    const res = await request(
      url,
      { headers: { authorization: `Bearer ${entry.accessToken}`, accept: 'application/json' } },
      'API 请求',
    );
    const text = await res.text();
    log(`${res.status} ${res.statusText}  ${url}`);
    console.log(text);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  die(`未知命令：${command}（可用 login/token/curl/status）`);
}

main().catch((err) => {
  die(err?.message ?? String(err));
});
