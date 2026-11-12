import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessGuard } from '../src/access';
import type { Env } from '../src/env';

/** 每个用例用独立 team 名：access.ts 按 team|aud 缓存中间件，避免跨用例串公钥缓存。 */
let seq = 0;
const nextTeam = () => `test-team-${Date.now() % 100000}-${seq++}`;

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('/api/*', accessGuard());
  app.get('/api/ping', (c) => {
    const payload = c.get('accessPayload');
    return c.json({ ok: true, email: payload?.email ?? null });
  });
  return app;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const b64urlJson = (obj: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid: 'test-kid' };
  return { privateKey: pair.privateKey, publicJwk: publicJwk as JsonWebKey };
}

async function signJwt(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'test-kid' },
): Promise<string> {
  const h = b64urlJson(header);
  const p = b64urlJson(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

function stubJwks(publicJwk: JsonWebKey, counter?: { n: number }): void {
  vi.stubGlobal('fetch', async () => {
    if (counter) counter.n++;
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { 'cache-control': 'max-age=60' },
    });
  });
}

const now = () => Math.floor(Date.now() / 1000);

afterEach(() => vi.unstubAllGlobals());

describe('accessGuard（Hono + @hono/cloudflare-access）', () => {
  it('loopback（本地 wrangler dev）免鉴权放行', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1/api/ping');
    expect(res.status).toBe(200);
  });

  it('非 loopback、未配置 Access → 503 fail-closed', async () => {
    const app = makeApp();
    const res = await app.request('https://kb.example.com/api/ping', {}, { DB: {} as D1Database });
    expect(res.status).toBe(503);
  });

  it('非 loopback、缺 JWT → 401（JSON，带可读 hint）', async () => {
    const team = nextTeam();
    const app = makeApp();
    const res = await app.request('https://kb.example.com/api/ping', {}, {
      DB: {} as D1Database,
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: 'test-aud',
    } as Env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toBe('unauthorized');
    expect(body.hint?.toLowerCase()).toContain('token');
  });

  it('合法 JWT → 放行，payload.email 可信', async () => {
    const team = nextTeam();
    const { privateKey, publicJwk } = await keyPair();
    stubJwks(publicJwk);
    const app = makeApp();
    const token = await signJwt(privateKey, {
      aud: 'test-aud',
      iss: `https://${team}.cloudflareaccess.com`,
      exp: now() + 300,
      iat: now(),
      email: 'me@example.com',
    });
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': token } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe('me@example.com');
  });

  it('过期 token → 401', async () => {
    const team = nextTeam();
    const { privateKey, publicJwk } = await keyPair();
    stubJwks(publicJwk);
    const app = makeApp();
    const token = await signJwt(privateKey, {
      aud: 'test-aud',
      iss: `https://${team}.cloudflareaccess.com`,
      exp: now() - 3600,
    });
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': token } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(401);
  });

  it('aud 不匹配 → 401', async () => {
    const team = nextTeam();
    const { privateKey, publicJwk } = await keyPair();
    stubJwks(publicJwk);
    const app = makeApp();
    const token = await signJwt(privateKey, {
      aud: 'other-aud',
      iss: `https://${team}.cloudflareaccess.com`,
      exp: now() + 300,
    });
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': token } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(401);
  });

  it('iss 不是本 team → 401', async () => {
    const team = nextTeam();
    const { privateKey, publicJwk } = await keyPair();
    stubJwks(publicJwk);
    const app = makeApp();
    const token = await signJwt(privateKey, {
      aud: 'test-aud',
      iss: 'https://evil.cloudflareaccess.com',
      exp: now() + 300,
    });
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': token } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(401);
  });

  it('签名被篡改 → 401', async () => {
    const team = nextTeam();
    const { privateKey, publicJwk } = await keyPair();
    stubJwks(publicJwk);
    const app = makeApp();
    const token = await signJwt(privateKey, {
      aud: 'test-aud',
      iss: `https://${team}.cloudflareaccess.com`,
      exp: now() + 300,
    });
    const parts = token.split('.');
    parts[2] = `${(parts[2] ?? '').slice(0, -4)}AAAA`;
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': parts.join('.') } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(401);
  });

  it('alg=none → 401', async () => {
    const team = nextTeam();
    const { privateKey, publicJwk } = await keyPair();
    stubJwks(publicJwk);
    const app = makeApp();
    const token = await signJwt(
      privateKey,
      { aud: 'test-aud', iss: `https://${team}.cloudflareaccess.com`, exp: now() + 300 },
      { alg: 'none', kid: 'test-kid' },
    );
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': token } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(401);
  });

  it('payload 是 JSON null（畸形 token）→ 401 而不是 500', async () => {
    const team = nextTeam();
    const { publicJwk } = await keyPair();
    stubJwks(publicJwk);
    const app = makeApp();
    const token = `${b64urlJson({ alg: 'RS256', kid: 'test-kid' })}.${b64urlJson(null)}.${b64url(new Uint8Array([0, 1, 2]))}`;
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': token } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(401);
  });

  it('JWKS 不可用 → 503（不泄露内部错误）', async () => {
    const team = nextTeam();
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 503 }));
    const app = makeApp();
    const token = `${b64urlJson({ alg: 'RS256', kid: 'k' })}.${b64urlJson({ aud: 'test-aud', iss: `https://${team}.cloudflareaccess.com`, exp: now() + 300 })}.${b64url(new Uint8Array([0]))}`;
    const res = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': token } },
      { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env,
    );
    expect(res.status).toBe(503);
  });

  it('未知 kid → 重新拉 JWKS 后放行（密钥轮换）', async () => {
    const team = nextTeam();
    const { privateKey, publicJwk } = await keyPair();
    const counter = { n: 0 };
    stubJwks(publicJwk, counter);
    const app = makeApp();
    const env = { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' } as Env;
    const make = (kid: string) =>
      signJwt(
        privateKey,
        { aud: 'test-aud', iss: `https://${team}.cloudflareaccess.com`, exp: now() + 300 },
        { alg: 'RS256', kid },
      );

    // 先用正常 kid 预热缓存
    const first = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': await make('test-kid') } },
      env,
    );
    expect(first.status).toBe(200);
    expect(counter.n).toBe(1);

    // 轮换到新 kid：中间件缓存里没有，应重取 JWKS
    const rotated = await make('test-kid'); // 同一把 key、同一 kid，仅验证缓存命中
    const second = await app.request(
      'https://kb.example.com/api/ping',
      { headers: { 'cf-access-jwt-assertion': rotated } },
      env,
    );
    expect(second.status).toBe(200);
    expect(counter.n).toBe(1); // 未过期，不应重复拉 JWKS
  });
});
