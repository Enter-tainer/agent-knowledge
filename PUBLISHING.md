# 开源前检查清单（PUBLISHING）

结论先说：**仓库里没有可用的密钥/凭据**（无 token、无私钥、无邮箱、无 Cloudflare secret；`.dev.vars` 不存在）。
`vault-src/`（36 篇原文，其中 2 篇含凭据片段）、`.wrangler/`（本地 D1）、`.auth/`（agent token）**已经在 .gitignore 里**。

另外，**私有语料的派生数据已从可提交文件里清掉**（2026-11-12）：
`docs/TECH-69-67-plan.md` 的真实路径示例换成占位、`tests/` 与 `scripts/` 不再引用真实笔记、`web/src/mock/` 的 mock 数据改成合成标题、
`research/bench/README.md` 与 `research/poc/` 的示例也已去标识。
`node scripts/check-private.mjs` 现在退出码为 0。

## 1. 默认不提交（已在 .gitignore）

| 路径 | 内容 | 处理 |
|---|---|---|
| `vault-src/` | 真实 36 篇 md（2 篇含凭据片段） | 永不提交 |
| `reviews/` | review 报告 + 81 张截图（12.6MB，含笔记标题/正文/命令表） | 不提交（内部审计） |
| `research/corpus/` | 真实笔记路径、外链（含个人 gist、飞书 wiki token） | 不提交 |
| `research/bench/results.json` | 2185 处真实笔记路径 + 本机绝对路径 | 不提交（可本地重跑生成） |
| `.wrangler/`、`.auth/`、`web/dist/`、`web/.scratch/`、`.reviews-tmp/`、`backups/` | 本地状态/产物 | 不提交 |

> 这些文件仍在你本地，只是不会进 git。想公开 `research/` 或 `reviews/` 正文的话，先把路径/标题 pseudonym 化、外链替换成 `<external-url>`，再用合成数据重拍截图。

## 2. 推送前自检

```powershell
git init
git add -A
node scripts/check-private.mjs      # 必须退出码 0
git status --short                  # 确认没有 vault-src / .wrangler / .auth / reviews
```

`check-private.mjs` 会扫描本机绝对路径、真实飞书链接、gist 外链、`案例库/` 路径和已知笔记标题。

## 3. 公开仓库建议包含

`src/`、`web/`、`scripts/`、`tests/`、`migrations/`、`examples/vault/`、`wrangler.toml`（占位 database_id）、
`README.md`、`AGENTS.md`、`PUBLISHING.md`、`LICENSE`、`.node-version`、`.github/workflows/ci.yml`

合成示例 vault：`node scripts/import.mjs --vault examples/vault`（3 篇，含双链/callout/表格/代码块，已被验证可导入）。

## 4. 部署到 Cloudflare（Git 集成）

见 README「部署 / 方式 A：Workers Builds」。要点：

- Build command：`pnpm install --frozen-lockfile && pnpm --dir web install --frozen-lockfile && pnpm build`
- Deploy command：`pnpm exec wrangler deploy`
- D1：`wrangler d1 create kb` 后把真实 `database_id` 提交（不是 secret），并手动跑一次 `pnpm db:init:remote`
- Access：自定义域 → Access app（邮箱白名单）→ Advanced settings 打开 **Managed OAuth** → 设 Access token 5–15m / Grant session 1–2 周
- `workers_dev = false` 保持，验收 `curl /api/health` 返回 401 + `WWW-Authenticate`

## 5. 其它注意

- 仓库目前**还没有 `git init`**；公开前决定把 `docs/TECH-69-67-plan.md` 里的实测数字（36 篇/594KB 等）保留还是改成占位。
- 如果曾经把 vault 的 GitHub token 放进 URL，记得去原 repo 轮换（本 workspace 的 `.git` 已删）。
- 公开 repo 的 CI 只跑单测 + 构建（没有 vault，`golden`/`adversarial`/`regression` 需要私有语料）。
