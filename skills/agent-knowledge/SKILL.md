---
name: agent-knowledge
description: "Use when reading or writing an agent-knowledge md KB (Cloudflare Access)."
version: 1.0.1
license: MIT
metadata:
  tags: [knowledge-base, cloudflare, d1, oauth]
---

# agent-knowledge — 给 agent 的接入 skill

这个仓库跑起来的是一个**私有 markdown 知识库**：Obsidian vault 上云，Worker + D1，
正文 / 双链 / FTS5 索引都在 D1；线上部署在 **Cloudflare Access** 后面，接口是 REST。

## When to Use

- 要在知识库里查东西（按关键词检索、读某篇、列目录、查反链/断链）
- 要往知识库写东西（新建一篇、改一篇、改文件名并全库改写引用、删除）
- 排查「agent 连不上知识库」这类问题（401 / 302 / 428 / 412）

## 0. 先探测，别猜

```bash
curl -sS -o /dev/null -D - -H 'accept: application/json' "$BASE/api/health"
```

| 结果 | 含义 | 下一步 |
|---|---|---|
| `200` | 已带凭据，或本地 loopback（`wrangler dev`） | 直接调 API |
| `401` + `www-authenticate` 里有 `resource_metadata="…"` | Managed OAuth 可用 | 走第 1 节登录 |
| `401` 但没有 `resource_metadata` | 应用没开 Managed OAuth | 让管理员在 Access 应用里打开 |
| `302` | 同上，被重定向到登录页 | 同上 |

`BASE` 形如 `https://<your-worker-domain>`（自建时换成自己的域名）。

## 安装位置（本 skill 自带脚本，可独立运行）

```bash
# 用 skills CLI 安装后（npx skills add Enter-tainer/agent-knowledge@agent-knowledge -g -y）：
SKILL_DIR="${AGENT_SKILLS_HOME:-$HOME/.agents/skills}/agent-knowledge"
ls "$SKILL_DIR/scripts"      # agent-oauth.mjs  http.mjs  kb.mjs

# 如果你在 agent-knowledge 仓库里（git clone），用仓库路径：
# SKILL_DIR="$PWD/skills/agent-knowledge"
```

token 默认存在 `~/.agent-knowledge/oauth.json`（0600）；用 `AGENT_OAUTH_FILE` 可改。
**token 不要写进代码、不要提交、不要贴进聊天记录或日志。**

## 1. 登录（一次性，拿 Bearer token）

```bash
node "$SKILL_DIR/scripts/agent-oauth.mjs" login "$BASE" --no-open --timeout 900
```

零依赖脚本，自己完成 RFC 9728/8414 发现 → 动态注册 public client → PKCE → 本地回调 → 存 token。
`--no-open` 会把授权 URL 打出来，**分两种用法**：

- **有人看着浏览器**：在本机浏览器打开那条 URL，用邮箱验证码 / GitHub / SSO 登录，回调打回
  `http://localhost:8400/callback` 即自动完成。
- **纯命令行环境 / 无浏览器会话**（headless、远程机、容器）：把 URL 发给能上网的人登录，
  他登录后浏览器会跳到 `http://localhost:8400/callback?code=…&state=…`（在他机器上打不开是正常的）。
  让他把**整条回调 URL** 贴回来，在跑着 login 的这台机器上：

  ```bash
  curl -sS '<那条回调 URL>'
  # → ✓ 登录成功  可以关闭这个页面，回到终端。
  ```

  这一步只是把 code 交给本地监听器换取 token，不涉及任何密码。

access token 默认 15 分钟，`token` / `curl` 子命令会自动用 refresh_token 续期；
refresh 彻底失效（grant session 过期）才需要重新 `login`。

```bash
node "$SKILL_DIR/scripts/agent-oauth.mjs" token  "$BASE"      # 打印 access_token（自动续期）
node "$SKILL_DIR/scripts/agent-oauth.mjs" status "$BASE"      # 看本地 token 与过期时间
node "$SKILL_DIR/scripts/agent-oauth.mjs" curl   "$BASE" /api # 带 Bearer 的 GET
```

## 2. 日常读写：`$SKILL_DIR/scripts/kb.mjs`

自带 `http.mjs`（`node:https` + 重试 + token 自动续期），**不依赖仓库其他文件**：

```bash
export KB_BASE=https://<your-worker-domain>     # 缺省 http://127.0.0.1:8787（本地 wrangler dev）
KB="node $SKILL_DIR/scripts/kb.mjs"

$KB health                       # {ok, docs, stale}
$KB tree [prefix] [limit]        # 列目录（path/title/tags/size/updated）
$KB get '<path>'                 # 读一篇：raw + frontmatter + hash
$KB search '关键词 两个以上'      # 检索，score 为 bm25 负数
$KB backlinks '<path>'           # 反链
$KB links '<path>'               # 出链
$KB put '<path>' <本地文件>       # 新建或覆盖（自动选 If-Match）
$KB del '<path>'                 # 删除（自动 force=1）
$KB rename '<path>' '<新path>'    # 改路径 + 全库改写引用
$KB export zip out.zip           # 导出全库备份
$KB reindex                      # 重建检索索引
```

鉴权优先级：`KB_OAUTH_TOKEN`（显式）→ `AGENT_OAUTH_FILE` / `~/.agent-knowledge/oauth.json`
（Managed OAuth，过期自动续期）→ `KB_ACCESS_CLIENT_ID` / `KB_ACCESS_CLIENT_SECRET`（service token）。
`path` 是 vault 相对路径、**不带 `.md`**，中文 / 空格 / 全角标点照原样传，脚本内部做 URL 编码。

## 3. API 约定（直接调 HTTP 时）

- 自描述入口：`GET /api`，端点清单与错误码以它为准，优先读它再动手
- 写：`PUT /api/docs/{path}`，**新建必须 `If-Match: *`**，改必须 `If-Match: <hash>`
  （`GET` 返回的 hash，裸 hash 或 `"hash"` 都行）；缺 → `428`，hash 过期 → `412`
- 读：`GET` 带 `ETag`，`If-None-Match` → `304`
- 删：有反链时 `409`，要 `?force=1`（入链会变断链）
- 改路径：`POST /api/docs/{path}/rename`，body `{"to":"新路径"}`，返回 `rewritten` / `unresolved`
- 未知 query 参数 → `400`（不会静默忽略）；错误体统一 `{ "error": string }`
- 检索：中文查询**至少 2 个字**（1 字静默 0 命中）；`relevance = -score`
- 索引落后：`GET /api/health` 的 `stale` 非 0 → `POST /api/admin/reindex`
- 断链 / 孤儿：`GET /api/reports/links?unresolved=1`、`GET /api/reports/orphans`

## 4. 坑（都踩过）

1. **到 Cloudflare edge 的连接会偶发 timeout / connection reset**（实测约 1/3）。
   单次失败**不代表** token 错或权限错——`http.mjs` 已内置重试，别急着重新登录。
2. **Node 原生 `fetch`（undici）可能直接挂死**（超时设了也不返回），
   `http.mjs` 与 `agent-oauth.mjs` 因此都用 `node:https` + `ipv4first`。自己写客户端时照做。
3. **Windows 打开授权 URL 别用 `cmd /c start`**：URL 里的 `&` 会被 cmd 截断，
   Cloudflare 会报 `invalid_target` / `Consent request is malformed`。脚本已用 `rundll32`。
4. `curl --http1.1` 到 Cloudflare 域名常超时，用默认 HTTP/2。
5. `path` 忘了 URL 编码 → 400/404；别忘了 **path 不带 `.md`**。
6. 不要对线上库跑仓库里的 `pnpm import` / `pnpm db:init`——那是本地 D1。

## 5. 验证连接是否真的通了

```bash
export KB_BASE=https://<your-worker-domain>
KB="node $SKILL_DIR/scripts/kb.mjs"

$KB health                                  # ok:true, stale:0
$KB search '两个字的词' 3                     # 有 results
printf -- '---\ntitle: "smoke"\n---\n\n# smoke\n' > /tmp/smoke.md
$KB put '_scratch/smoke' /tmp/smoke.md && $KB del '_scratch/smoke'
```

写完记得清理：`_scratch/` 下的自检文档应当删掉，别留在生产库里。
