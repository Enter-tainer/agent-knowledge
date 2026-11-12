import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { cloudflareAccess } from '@hono/cloudflare-access';
import type { Env } from './env';
import { errorJson, unavailable } from './env';

/**
 * Cloudflare Access 鉴权（官方推荐做法，用 @hono/cloudflare-access 中间件）：
 * - 非 loopback 请求必须带经 Access 签名的 JWT（header `Cf-Access-Jwt-Assertion`，
 *   浏览器场景中间件也接受 `CF_Authorization` cookie）；
 * - 中间件负责 RS256 验签、iss/aud/exp/nbf、kid 轮换重取，并在 1h 内缓存公钥；
 * - 本地 loopback（wrangler dev 只监听 127.0.0.1）没有 Access，直接放行。
 *
 * 中间件实例按 team|aud 缓存，保证公钥缓存在同一 isolate 内复用。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const middlewares = new Map<string, MiddlewareHandler>();

function getMiddleware(team: string, aud: string | undefined): MiddlewareHandler {
  const key = `${team}|${aud ?? ''}`;
  let mw = middlewares.get(key);
  if (!mw) {
    mw = cloudflareAccess(team, aud) as unknown as MiddlewareHandler;
    middlewares.set(key, mw);
  }
  return mw;
}

export function accessGuard(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (LOOPBACK_HOSTS.has(url.hostname)) return next();

    const team = c.env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
    const aud = c.env.ACCESS_AUD?.trim();
    if (!team) {
      console.error('非 loopback 请求，但未配置 ACCESS_TEAM_DOMAIN（Access 未接入）');
      return unavailable();
    }

    try {
      const mw = getMiddleware(team, aud);
      const shortCircuit = await mw(c as never, async () => {
        await next();
      });
      if (shortCircuit && !shortCircuit.ok) {
        const text = await shortCircuit.text().catch(() => '');
        const detail = text.replace(/^Authentication error:\s*/i, '').trim() || 'unauthorized';
        return errorJson(401, 'unauthorized', { hint: detail });
      }
    } catch (err) {
      // 中间件在 JWKS 不可用 / 组织不存在时会抛 HTTPException(500)：统一 503，不泄露细节
      if (err instanceof HTTPException) {
        console.error('access middleware error:', err.message);
        return unavailable();
      }
      // 畸形 token 等未预期异常：401（不能 500 泄露内部错误）
      console.error('access middleware threw:', err instanceof Error ? err.message : err);
      return errorJson(401, 'unauthorized');
    }
  };
}
