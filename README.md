# agent-knowledge

私有 md 知识库（TECH-69）：Obsidian vault 上云，Cloudflare Worker + D1，agent 可读写、双链可维护。

**状态：v1 已实现并完成对抗性 review（正确性/数据 · agent-UX · UX），本地全链路验证通过。** 部署等你挂 Cloudflare Access。

## 技术栈

- **Worker**：Hono + Cloudflare Assets；路由/API 都在 `src/`
- **鉴权**：`@hono/cloudflare-access`（官方中间件）验 Access JWT；本地 loopback（`wrangler dev` 只监听 127.0.0.1）免验；`workers_dev = false`
- **存储**：全部在 D1（正文 + links + FTS5），**不用 R2**
- **检索**：写入侧 CJK bigram + 标识符子 token 预分词，段落级切块（≈600 字），`bm25` + 标题权重
- **前端**：Vite + markdown-it（自写 wikilink / callout 插件），无框架

## 本地跑

```powershell
pnpm i
pnpm db:init        # 建本地 D1 表（.wrangler/state）
pnpm dev            # 终端 A：wrangler dev，只监听 127.0.0.1:8787
```

终端 B（**无需任何 token**，本地 loopback 免鉴权）：

```powershell
pnpm import         # 导入 vault-src/ 36 篇 + 对账（正文逐字节 / 163 双链 / 每篇入链数）
pnpm smoke          # agent 5 件套 + 乐观锁 412/428 + ETag
pnpm golden         # 55 条检索 golden set（中文 2/3/4 字、标识符、假词）
pnpm adversarial    # 路径穿越 / 注入 / 超大 body / 并发写 / 畸形 md / rename / zip
pnpm regression     # 大文档 chunk id、并发新建、CAS 无副作用、rename 全形态
pnpm backup         # 导出全库 md 的 zip 到 backups/（601KB / 36 篇，可解压回 Obsidian）
# 或一次跑完：
pnpm verify
```

> 公开仓库里没有私有 vault。想快速试跑可以用合成示例：
> `node scripts/import.mjs --vault examples/vault`（3 篇，含双链/callout/表格/代码块）。
> `golden`/`adversarial`/`regression` 依赖真实语料，公开仓库只跑 `pnpm test` + 构建。

单测 / 类型检查：`pnpm test`、`pnpm typecheck`。

> ⚠️ 同一时间只能起**一个** `wrangler dev`（Windows 上两个实例抢 8787 会让所有请求 hang 住 6–10s 再超时）。出问题先 `Get-NetTCPConnection -LocalPort 8787` 确认只有一个 listener。

Web UI：

```powershell
cd web && pnpm i
pnpm build                        # 产出 web/dist（Worker 静态资源，同源 /api）
$env:VITE_DEV_PROXY_TARGET='http://127.0.0.1:8787'; pnpm dev   # 开发时接真后端
```

## 部署（需要你的终端）

### 方式 A：Workers Builds（连 GitHub repo，push 自动部署，推荐）

1. GitHub 建仓并 push（**先看 [`PUBLISHING.md`](PUBLISHING.md) 的脱敏清单**，别把 vault/reviews 截图推上去）
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Connect to Git** → 选这个 repo
3. 构建配置：
   - Root directory：`/`
   - Build command：`pnpm install --frozen-lockfile && pnpm --dir web install --frozen-lockfile && pnpm build`
   - Deploy command：`pnpm exec wrangler deploy`
   - 环境变量：`NODE_VERSION=22`；`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`（如果不想写进仓库变量）
4. D1 一次性初始化（本机终端做，不要放 CI）：
   `pnpm wrangler d1 create kb` → 把 `database_id` 填进 `wrangler.toml` 并提交（ID 不是 secret）→ `pnpm db:init:remote`
5. 首次 deploy 后绑定自定义域（或在 `wrangler.toml` 加 `routes = [{ pattern = "kb.example.com", custom_domain = true }]`），然后建 Access app（见下）
6. 验收：`curl -i https://<域名>/api/health` → 401（带 `WWW-Authenticate`）；浏览器能登录；agent 用 `scripts/agent-oauth.mjs` 能 200

> Workers Builds 免费版有月度构建分钟数；`workers_dev = false` 意味着部署后没有默认 `*.workers.dev` 域名，必须绑自定义域。

### 方式 B：GitHub Actions + wrangler-action（想先跑测试/迁移再部署时）

仓库已有 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 跑 typecheck/单测/构建；再加一个 deploy workflow，用 repo secrets：
`CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit + D1:Edit + 可选 Access: Apps and Policies:Edit）、`CLOUDFLARE_ACCOUNT_ID`。
适合想「CI 绿了才部署」或要在 CI 里跑 `wrangler d1 execute --remote` 的人。

### 方式 C：本地 `wrangler deploy`（最省事，单用户）

按下面手动步骤，改完本地 deploy；不需要 CI 配置。

### 手动步骤

1. `pnpm wrangler d1 create kb` → 把 `database_id` 填进 `wrangler.toml`
2. `pnpm build`
3. `pnpm wrangler d1 execute kb --remote --file=migrations/0001_init.sql`
4. `pnpm wrangler deploy --var ACCESS_TEAM_DOMAIN:<team> --var ACCESS_AUD:<aud>`
   （`<team>` 写 `mgt` 或完整 `mgt.cloudflareaccess.com` 都行，`src/access.ts` 会自动剥离后缀；推荐用 `wrangler secret put` 存，别写进公开仓库）
5. **在 Cloudflare Zero Trust 里给这个域名挂 Access application**（邮箱白名单），并确认 `workers_dev = false` 已生效
6. **给 agent 开 Managed OAuth**（推荐）：Access 应用 → **Advanced settings** → 打开 **Managed OAuth**；建议同时打开 *Allow localhost clients* / *Allow loopback clients*，Access token lifetime 设 5–15 分钟，Grant session duration 设 1–2 周
7. 验收：`curl -i https://<域名>/api/health` 不带凭据必须是 **401**（带 `WWW-Authenticate`）或 302；浏览器能登录、agent 用下面的脚本能 200

> 为什么还要 Worker 内验 JWT：Access 边缘校验之外，代码层再挡一次（`@hono/cloudflare-access` 验 RS256 签名 / iss / aud / exp，并支持 Access key 轮换）。这样即使 `workers.dev` 忘了关或 Access 规则配错，API 也不会裸奔。本地 loopback 例外，见 `src/access.ts`。

## Agent 登录（Managed OAuth / 无 token 申请）

推荐顺序：**Managed OAuth（浏览器 SSO 一次，之后静默续期）** → `cloudflared access curl` → Service Token（仅完全无人值守）。

```powershell
# 1) 浏览器里用邮箱 OTP / SSO 登录一次（脚本自动发现端点、动态注册客户端、PKCE）
node scripts/agent-oauth.mjs login https://kb.example.com
# 2) 拿 token / 直接带 Bearer 调 API（过期自动用 refresh_token 续期）
node scripts/agent-oauth.mjs token https://kb.example.com
node scripts/agent-oauth.mjs curl  https://kb.example.com /api/health
node scripts/agent-oauth.mjs status https://kb.example.com
```

- token 存在 `.auth/oauth.json`（已 gitignore，权限 600），`--token-file` 可改；**不要提交**。
- Access token 默认 15 分钟，脚本自动续期；refresh token（Grant session）过期后重跑一次 `login`。
- 如果应用还没开 Managed OAuth，脚本会提示（收到 302 而不是 401）。
- **OAuth 踩坑记录**（脚本已处理）：
  - Windows 打开授权 URL 不能用 `cmd /c start`（URL 里的 `&` 会被 cmd 截断，Cloudflare 报 `invalid_target: No resource parameter found` / `Consent request is malformed`）；脚本改用 `rundll32`。
  - 回调默认用 `http://localhost:8400/callback`（Cloudflare Managed OAuth 的推荐形态；`127.0.0.1` 需要单独开 *Allow loopback clients*）。端口占用会自动换。
  - 本机到 Cloudflare 用 Node `fetch` 偶发连接超时，脚本改用 `node:https` + IPv4 + 重试；`_http.mjs` 同样处理。
  - 浏览器一直转圈/无痕能开：先试 `--no-open`，复制完整授权 URL 到无痕窗口；或检查 Access 应用 Managed OAuth 里 *Allow localhost clients* / *Allow loopback clients* 是否都开着。
- 备选：`cloudflared access login https://kb.example.com` 拿 token 后发 `cf-access-token` 头；完全无人值守再建 Service Token（`CF-Access-Client-Id/Secret`）。
- 仓库根的 [`AGENTS.md`](AGENTS.md) 是给 coding agent 的自助说明，agent 读到 401 会按它走。

## API 速查（agent）

`curl -s http://127.0.0.1:8787/api` 返回自描述 JSON（端点/约定/错误码），优先读它。常用：

```powershell
curl -s http://127.0.0.1:8787/api/tree?limit=5
curl -s "http://127.0.0.1:8787/api/search?q=%E5%8E%8B%E6%84%9F&limit=3"
curl -s "http://127.0.0.1:8787/api/docs/%E6%A1%88%E4%BE%8B%E5%BA%93"          # 读；响应带 ETag: "<hash>"
# 改：If-Match 用 GET 的 hash（裸 hash 或 "hash" 都行）
curl -s -X PUT "http://127.0.0.1:8787/api/docs/_demo" -H "If-Match: *" -H "content-type: text/markdown" --data-binary "# hi"
curl -s -X POST "http://127.0.0.1:8787/api/admin/reindex"                     # 索引自愈
```

关键语义：新建 `If-Match: *`；修改 `If-Match: <hash>`（缺失 428 / 过期 412）；`GET /api/reports/stale` 看索引落后；未知 query 参数返回 400；`/api` 之外的非 API 路径走前端 SPA。

## 目录

| 路径 | 内容 |
|---|---|
| [`docs/TECH-69-67-plan.md`](docs/TECH-69-67-plan.md) | 方案：决策、检索设计、schema/API、里程碑、实现状态 |
| [`src/`](src/) | Hono 入口 `index.ts`、鉴权中间件 `access.ts`、D1 层 `db.ts`、检索/切块/双链库 `lib/` |
| [`migrations/`](migrations/) | D1 schema |
| [`scripts/`](scripts/) | 导入 / 冒烟 / golden / 对抗 / 回归 / 备份 / `agent-oauth.mjs`（Managed OAuth 登录） |
| [`web/`](web/) | Web UI（Vite → `web/dist`） |
| [`reviews/`](reviews/) | 独立对抗性 review 报告（正确性/安全、UX、agent-UX） |
| [`research/`](research/) | 研究证据：D1 能力、检索实测、语料盘点、POC |
| `vault-src/` | 语料只读副本（私有，**不提交**，见 .gitignore） |

## 已知限制

- 1 字中文查询不支持（bigram 索引无 unigram；接口会提示「至少 2 个字」）
- 跨标点连写查询（文档写「心率、广播」、查「心率广播」）可能漏召回
- 无附件/图片（语料本身没有）；正文单篇上限 1.5MB
- Web UI 暂未提供 rename/delete/reindex 按钮（API 已有）
- 单用户、单 token（Access）模型；无权限分级
