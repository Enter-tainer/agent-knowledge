# AGENTS.md — 给 coding agent 的接入说明

这个仓库是一个 Cloudflare Worker + D1 的私有 md 知识库。线上入口有一个域名（下文 `<base>`），
**所有请求都在 Cloudflare Access 后面**。本地 `wrangler dev` 的 `127.0.0.1:8787` 不需要登录。

## 1. 先探测是否需要登录

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -H 'accept: application/json' <base>/api/health
```

- `200` → 直接调 API（本地 / 已带凭据）。
- `401` → 看响应头 `www-authenticate`：如果有 `resource_metadata="…"`，走第 2 步（Managed OAuth）。
- `302` → 该应用还没开 Managed OAuth；告诉用户去 Access 应用 **Advanced settings → Managed OAuth** 打开。

> 线上域名示例：`https://kb.mgt.moe`。Worker 的 `ACCESS_TEAM_DOMAIN` 写 `mgt` 或 `mgt.cloudflareaccess.com` 都可以。

## 2. 用仓库脚本登录（推荐）

脚本零依赖，会做 RFC 9728/8414 发现、动态注册、PKCE、本地回调、token 刷新：

```bash
node scripts/agent-oauth.mjs login <base>     # 需要用户在浏览器里完成一次邮箱/SSO 登录
node scripts/agent-oauth.mjs token <base>     # 打印 access_token（自动续期）
node scripts/agent-oauth.mjs curl  <base> /api/health
```

拿到 token 后，所有 API 请求带：

```bash
curl -H "Authorization: Bearer <access_token>" <base>/api/tree?limit=5
```

token 存在标准应用数据目录：Linux `~/.local/share/agent-knowledge/oauth.json`、macOS `~/Library/Application Support/agent-knowledge/oauth.json`、Windows `%LOCALAPPDATA%\agent-knowledge\oauth.json`（`AGENT_OAUTH_FILE` 可覆盖）。**不要把它提交、不要打进日志。**
access token 默认 15 分钟；脚本在 `token`/`curl` 时自动用 refresh_token 续期。
refresh 失败（grant session 过期）= 重新跑一次 `login`，再让用户点一下浏览器。

## 3. 备选

- 装了 `cloudflared`：`cloudflared access curl <base>/api/health`，或
  `CF_TOKEN=$(cloudflared access login <base>)` 然后发 `cf-access-token: $CF_TOKEN`。
- 完全无人值守（CI/cron）：向用户要 Service Token，发
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` 两个头（需要应用里配 Service Auth policy）。

## 4. API 约定（写错会很痛）

- 自描述入口：`GET <base>/api`（端点清单/约定/错误码），优先读它。
- 新建：`PUT /api/docs/{path}` + `If-Match: *`；修改：`If-Match: <hash>`（GET 返回的 hash，裸 hash 或 `"hash"` 都行）。
- 缺失 `If-Match` → 428，hash 过期 → 412；`GET` 带 `ETag`，`If-None-Match` → 304。
- 未知 query 参数 → 400（不会静默忽略）；错误体 `{error}`。
- 中文搜索至少 2 个字；`score` 是 bm25 负数（越小越相关），`relevance = -score`。
- 写坏了索引看 `GET /api/health` 的 `stale`，非 0 就 `POST /api/admin/reindex`。

## 5. 禁止

- 不要把 token/secret 写进代码、提交、或发到聊天里。
- 不要对线上库跑 `pnpm import`/`pnpm db:init` 这类本地脚本（会连本地 D1，不是线上）。
- 不要同时起两个 `wrangler dev`（Windows 上会抢 8787 导致所有请求 hang）。
