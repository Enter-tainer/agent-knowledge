# TECH-69 / TECH-67 研究与实施方案

> 研究日期：2026-11-12（Asia/Shanghai）
> 对象：Plane `TECH-69`「自搓私有 md 知识库（Cloudflare R2 + D1）」、`TECH-67`「知识库平台选型」
> 本文目标：回答两个 ticket 怎么落地，重点把**还没想好的检索**拍成可施工的设计，并给出「D1 到底能不能撑住」的实测依据。
> 证据目录：`research/d1/`（D1 能力与限额）、`research/bench/`（检索方案实测）、`research/corpus/`（语料/环境盘点）、`research/poc/`（本地 D1 冒烟）

---

## 0. 一页纸结论（先看这 12 行）

| # | 问题 | 结论 |
|---|---|---|
| 1 | TECH-67 怎么办 | **关单（superseded）**。它在等「要不要浏览/手机入口、能不能自维护」；69 已经给出答案：自建 Web UI + Cloudflare 托管，单人使用。67 的「中文分词未实测」也已被本次 bench 实测回答。建议在 67 上留一条结论评论后关闭。 |
| 2 | TECH-69 的核心架构 | **一个 Worker（API + 静态 UI）+ D1（正文/链接/检索）**，**v1 不用 R2**（见 ADR-1）。Access 部署时再挂。不做 Durable Objects、不做向量。 |
| 3 | 检索用 D1 行不行 | **行，而且只靠 D1 就够**。D1 官方支持 FTS5（含 `fts5vocab`），`bm25()` 可用；中文不是开箱即用，**必须写入侧预分词**。 |
| 4 | 检索具体方案 | **F + G**：写入端把中文切成 bigram、把代码标识符拆子 token、按段落 ≈600 字切块入 FTS5（`unicode61`）；查询端同一变换 + 标识符前缀匹配；`bm25` 排序 + 标题权重；对含 `_ . - /` 的查询做原文后验。 |
| 5 | 实测效果（36 篇真实语料 / 48 条正查询） | 2/3/4 字中文 **全中**（trigram 2 字是 **0/5 静默失败**）；标识符 **全中**；7 条假词 **零误报**；排序 canonical@1 **0.54 → 0.71**（加段落切块后）。 |
| 6 | 代价 | 索引约为原文 1.2–1.4×，整库约原文 2.6–3.3×（36 篇 ≈ 3–4 MB）；写入多一次 O(文本) 变换（594KB 约 60ms Python，JS 更快）。远远低于 D1 免费 500MB / 付费 10GB 单库上限。 |
| 7 | 正文放哪 | **全部存 D1（`documents.raw`），v1 不用 R2**。2MB/行对最大 39KB 的笔记有 50 倍余量；写入一个 `batch()` 事务同时更新正文/链接/FTS；检索直接出摘要。备份走 `GET /api/export`（全库 md zip）+ 本机 git + D1 Time Travel。R2 等有附件/图片或单篇 >1.5MB 时再加（迁移路径已留）。**已拍板：不用 R2。** |
| 8 | 双链/反链 | 语料只有一种形态 `[[文件名]]`×163、**断链 0**；不需要支持别名/heading/block/嵌入。`links` 表存 `(src, dst, raw, form, line, col)`，反链就是 `WHERE dst=?`；rename 按位置改写 163 条，整库重算后断言断链 0。 |
| 9 | 渲染/编辑器 | `markdown-it@15` + 两个自写小插件（wikilink、callout），已用真实语料验证 **270 个表格块全渲染**（含单横线分隔行）；编辑器就是 textarea + 预览 + If-Match 乐观锁。remark 也可行但同样要自写插件且慢 5.5 倍，不选。 |
| 10 | 鉴权 | **`@hono/cloudflare-access` 验 Access JWT**（RS256/iss/aud/exp，支持公钥轮换）；本地 loopback 例外；`workers_dev=false`。Hono 做路由，无 `AUTH_MODE` 开关。 |
| 11 | 工作量 | 最小闭环（导入 + 链接 + 检索 + API）≈ **2.5 天**；Web UI +1.5 天；备份/运维/文档 +0.5 天。ticket 里「1 天最小闭环」偏乐观：检索按 F+G 实现并达到验收要有 golden set，至少多半天。 |
| 12 | 上云前必做 | ① 轮换 vault repo 的 GitHub token（已从本 workspace 的 clone 里删掉）；② 导入时丢弃 `source/node_token/obj_token`；③ 确认你能接受内容落在 Cloudflare（境外）。凭据类内容按你的决定**原样导入**，不做脱敏。 |

---

## 1. 两个 ticket 的处置

### 1.1 TECH-67（知识库平台选型）

原文结论是「三档：①不动现状 ②只读站点 ③自托管 wiki」，待拍板是「①是否需要手机/浏览器只读 ②可否定自维护 ③会不会有第二个人」。TECH-69 已经用行动回答了：

- 需要浏览器/手机入口 → 是（自建 Web UI）；
- 可接受自维护 → 是（Cloudflare 托管，运维≈0，见 §7）；
- 第二个人 → 无（单用户，Access 单账号）。

67 里的「未验证项：中文分词检索实际表现」本次已有硬数据（`research/bench/README.md`）：**默认 unicode61 不可用、trigram 对 2 字中文不可用、bigram 预分词可用**。结论方向与 67 的 P0 判据（中文全文检索可用）一致。

→ **建议：给 67 留一条「已被 TECH-69 覆盖，选型结论更新为 Cloudflare R2+D1 自建」的评论并关单。**

### 1.2 TECH-69（本方案）

按 ticket 的验收标准逐条落位：

| ticket 验收标准 | 本方案对应 | 验证方式 |
|---|---|---|
| 现有 34 篇一次性导入，双链/反链与 Obsidian 一致（抽 5 篇人工核对） | M1 导入器 + `links.csv` 作为 ground truth | 脚本自动对账：文档数 36、内部双链 163、无法解析 0、每篇入链数与盘点表逐项比对；再人工抽 5 篇 |
| 中文关键词（含代码标识符）能命中，相关度可接受 | F+G 检索（§4） | 55 条 golden query 进 CI：2/3/4 字中文 100%、标识符 100%、假词 0 误报、canonical@1 ≥0.65 |
| rename 一篇后所有引用自动改写，断链 0 | `POST /api/docs/{path}/rename`（§6.4） | 测试库 rename 一篇 → `unresolved == 0` 且 163 条链接解析数与基线一致 |
| agent 用 API 完成：列目录、读一篇、改一篇、按关键词检索、查反链 | REST 5 件套（§5） | `scripts/smoke.mjs` 用 service token 跑通 5 个动作 |
| 不匿名可访问：无 token 被 Access 拦 | Access + service token（§7） | `curl` 无凭据 → 302/401；带 service token → 200 |

**范围外（明确不做）**：块级引用（block id / embed）、附件与图片（语料 0 个非 md 文件）、多人协作/实时编辑、Durable Objects、移动端原生 App、语义检索（v2 再看，§4.6）。

---

## 2. 事实基础（都来自本次实测，不是估计）

### 2.1 语料（`research/corpus/inventory.md`）

| 项 | 值 |
|---|---|
| 规模 | **36 个 md**（不是 ticket 写的 34/38）、594,017 B、8,433 行、最大 39,566 B |
| 构成 | 32 篇案例正文（15 个一级 + 17 个子页）+ 4 篇结构页；2 层目录 |
| 双链 | **只有 `[[文件名]]` 一种，163 条，断链 0**；别名/heading/blockid/嵌入/`.md` 后缀/带路径全为 0；同名文件 0 组、大小写冲突 0 |
| 解析分布 | 153 条靠「全库唯一文件名」、10 条靠「同目录优先」、0 条靠路径 |
| 其他语法 | callout 110（只有 `tip`/`note`，无嵌套）、代码块 178、表格 270 块/2,237 行（分隔行是单横线 `\|-\|-\|`）、`==高亮==` 3 处、`$数学$` 1 处 |
| frontmatter | 7 个键；`aliases` 全空；`updated` 是裸日期（YAML 会转 Date，入库要转字符串）；`README.md` 无 frontmatter；另有一篇总览页缺 5 个键 |
| 坑 | 3 组「文件 stem = 同级目录名」（folder note）；单篇平均 9.5 个 H1（不能假设唯一 H1）；`powershell` 与 `pwsh` 并存 |
| 敏感 | 2 篇含凭据类片段；`.git/config` 里曾内嵌 GitHub token（本 workspace 的 clone 已删 `.git`，**原 repo 的 token 需要轮换**） |

### 2.2 本机环境（`research/corpus/inventory.md` B 节）

- wrangler **4.155.0** 已在 `proj/lepu/cf/worker` 项目内，Cloudflare **已登录**（OAuth token 存在，无 CI 用的 API Token）。
- `proj/lepu` = TECH-18 的 Cloudflare 云原生项目：Worker（`/api` + `/f` + assets）+ D1 + R2 + **CF Access JWT 自校验**，可复用 70% 云侧骨架（schema 模式、部署命令、auth.ts、smoke test 写法）。
- 已知坑：D1 单表 ≤100 列（lepu 踩过）；`[assets]` 目录必须存在；`workers.dev` 不受 Access 保护。
- 本机 Python 3.12.10 / SQLite 3.49.1（FTS5+trigram）、Node 24、pnpm 可用。**工具链统一用 pnpm**（用户指示）。

### 2.3 D1 能力与限额（`research/d1/capabilities.md`，含官方原文引用）

- **FTS5 官方支持**：D1 文档《SQL statements》把「FTS5 module (including `fts5vocab`)」列为支持的扩展；《Import and export》再次明文「D1 supports virtual tables for full-text search using SQLite's FTS5 module」。社区有 2024 日文站（trigram + external content + 三触发器，`--remote` 上生产）和 2026 韩文站（39 万词、P50 22ms）两次生产实测。
- **`bm25`/`match`/`snippet`/`highlight` 在 workerd 运行时白名单里**（官方源码 `workerd/src/workerd/util/sqlite.c++`）。
- **中文不是开箱即用**：`unicode61` 把连续汉字当一个 token（FTS5 文档原文：L* 类都是 token 字符）；`trigram` 少于 3 字符的查询**静默返回 0**（官方文档明文 + 本次实测 2 字中文 0/5）。
- **硬限额**：单行/单字符串 **2MB**；SQL 语句 **100KB**；绑定参数 **100**；`LIKE/GLOB` 模式 **50 字节**；查询结果 **50MB**（2026-11-04 起生效）；单查询 **30s**；Free 每日 **5M 读 / 100k 写**；付费单库 **10GB 不可再提**；**`batch()` 是事务（一条失败整批回滚）**；D1 单库单线程串行执行。
- **运维坑**：**库里有虚表时 `d1 export` 不可用**（要先 DROP 虚表）→ 备份不能只靠 `wrangler d1 export`，本方案自带 `/api/export`。
- **未证实**：D1 的 SQLite 版本号（官方不公布且 `sqlite_version()` 被屏蔽）、`porter`/`ascii` tokenizer、`snippet()`/`highlight()` 在 D1 的可用性、FTS5 的 `rows_read/written` 计费口径。

### 2.4 本地已跑通的冒烟证据（`research/poc/`）

用 `pnpm dlx wrangler@4.155.0 d1 execute --local`（workerd 本地 D1 模拟）实测：

- `CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='unicode61')` 与 `tokenize='trigram'` **建表成功**；
- 写入 bigram 化文本后，`MATCH '"电机"'`（2 字中文 phrase）**命中**、`MATCH '"电机 机校 校准"'`（4 字）**命中**；
- `MATCH '压*'`（1 字前缀）**命中**；
- `MATCH 'persist*'`（标识符前缀）**命中**；
- trigram 表：`'"电机"'` **0 行**（符合预期）、`'"电机校"'` 1 行、`'"UserBy"'` 1 行（标识符子串）；
- `bm25()` 返回负 float（-0.58），`ORDER BY bm25(fts)` 正常排序。

> 注意：本地 workerd 的 SQLite 版本不保证与生产 D1 一致；`research/d1/capabilities.md` §8 给了 11 条「付费账号实测清单」，上线前逐条跑一遍（重点：在生产库建 FTS5、`bm25`、中文 2 字行为、`d1 export` 限制）。

---

## 3. 架构与关键决策（ADR）

### ADR-1 内容主存：全部存 D1，v1 不用 R2（**已拍板**）

ticket 里的两个问题：「要不要用 R2？能不能全都存 D1？」——**答案是：能，而且这一版就该全存 D1，R2 先不用。**

理由（按重要性）：

1. **写入一致性是最大的工程收益**：一次 `PUT` = 一个 `db.batch()` 事务，正文 + links + FTS 同时成立。如果 R2 是真相，就得「先写 R2 再写 D1」，中间失败会留下「文件新、索引旧」，必须写 hash 对账/重扫任务；我们只有 36 篇、单用户，为一个几乎不会发生的失败模式背一套双写一致性不值得。
2. **检索体验**：命中后直接出摘要/高亮，不用每条结果再读一次 R2。
3. **限额完全够，且省钱**：最大笔记 39.5KB vs 2MB/行（50 倍余量）；36 篇正文 594KB + FTS 派生 ≈ 3–4MB vs 免费单库 500MB。少一个 R2 绑定 = 少一套权限/配置/成本。
4. **「文件即真相」不丢**：`GET /api/export` 一键导全库 md zip；本机 git 仓库定时拉取即得版本历史；D1 Time Travel 提供 7/30 天点恢复。换方案时导出直接进 Obsidian/git，不锁死。
5. **风险可控**：单篇 >1.5MB 在写入口直接拒绝（明确报错）；D1 故障时全站不可写——靠导出备份 + Time Travel 恢复，而不是靠 R2 镜像做「只读兜底」（36 篇规模下这个兜底价值接近 0）。

**迁移路径（留好门）**：`documents.raw` 就是完整 md，将来真要附件/图片或单篇 >1.5MB，再加 R2 桶（附件走 R2，正文仍可留 D1）或把 raw 挪 R2 存 key——接口不变，只动存储层。

**明确不做的**：R2 镜像、R2 版本控制、双写对账。

### ADR-2 检索：D1 FTS5 + 写入侧预分词（F）+ 段落级切片（G）

见 §4。一句话：**只依赖 FTS5 自带的 `unicode61`，不依赖 trigram，不引入向量**。这回答用户「检索能不能是 d1 啥的」：能，且不需要 D1 之外的检索服务。

### ADR-3 链接与反链：解析结果落表，rename 按位置改写

`links(src_doc_id, dst_doc_id NULL, target_raw, form, line, col)`；`dst_doc_id IS NULL` 即断链（当前语料 0 条，但 schema 必须允许）。反链 = `SELECT src WHERE dst=?` + 按源去重、显示提及次数（与 Obsidian 面板一致）。rename 只改写 `[[旧stem]]` 的**目标文本**（保留别名/锚点结构），按 `(line, col, raw)` 定位，禁止全文替换（正文里 `案例库` 这类词会误伤），改完整库重算解析并断言断链 0。

### ADR-4 写入：hash 乐观锁 + batch 事务 + 显式维护 FTS（不用触发器）

- `If-Match: <sha256(raw)>`，不匹配返回 412；`*` 表示新建/覆盖。
- FTS 用**独立表**（不用 `content=` external content，也**不用 trigger**）：`DELETE FROM chunks_fts WHERE rowid IN (...)` → `INSERT`，放在同一个 `db.batch()` 里。理由：触发器顺序错会静默腐坏索引（社区 ADR 0093 的 `SQLITE_CORRUPT_VTAB` 事故）；batch 是事务，显式顺序最可控。
- chunk id **确定性生成**：`id = doc_id * 1000 + ord`（ord < 1000），避免依赖 `last_insert_rowid`，让 delete/insert 可预测。

### ADR-5 鉴权：Hono + `@hono/cloudflare-access` 验 Access JWT（官方最佳实践）

- 用官方中间件 `cloudflareAccess(team, aud)`：验 RS256 签名、iss、aud、exp/nbf，支持 Access 公钥轮换（未知 kid 自动重取），公钥 1h 缓存；浏览器场景还接受 `CF_Authorization` cookie。
- **本地例外**：`wrangler dev` 只监听 `127.0.0.1`，前面没有 Access，loopback 请求直接放行（代码在 `src/access.ts`，没有 `AUTH_MODE` 开关、没有 dev token）。
- 中间件返回的 401/500 统一包装成 JSON（`{error:'unauthorized', hint}` / 503），不泄露 Access 组织名等细节；畸形 token 一律 401 而不是 500。
- `workers_dev = false`：即使忘了关，非法请求也会被代码层 401；Access 后台配错也有这道防线。
- 代价（唯一）：本地与线上行为在 loopback 上不同；这是 `wrangler dev` 无法前置 Access 的必然，已写进部署验收（`curl` 不带凭据必须 302/401）。
- agent 线上默认走 Managed OAuth（`scripts/agent-oauth.mjs`，浏览器 SSO 一次 + 静默 refresh）；完全无人值守再退到 Access service token。**不要给 agent D1 的 API Token**（账号级、全库）。

### ADR-6 渲染：markdown-it 15 + 两个小插件

本次用真实语料对比（`research/poc/render-poc.mjs`）：

| | markdown-it 15.0.3 | remark-gfm (unified) |
|---|---|---|
| 270 个表格块（单横线分隔行） | **270/270 渲染** | 270/270 渲染 |
| 115 个引用块 | 115 | 115 |
| `[[wikilink]]` | 原样输出（需自写插件） | 同 |
| 行内代码里的 `[[…]]` | 正确跳过（不会误转链接） | 同 |
| 全语料渲染耗时 | **80 ms** | 441 ms |
| 依赖量 | 1 个核心包 | unified + 4 包 |

→ 选 **markdown-it**，自写 ~30 行 wikilink inline 规则 + ~20 行 callout container 规则；`highlight.js` 做代码高亮（语言别名 `powershell`/`pwsh` 归一）。注意 2 个文件表格里有 `<br>`：开 `html: true` 时必须过 DOMPurify（或预处理把 `<br>` 换成空格再渲染）。`==高亮==` 可选插件。

### ADR-7 部署形态：单 Worker（Hono）+ Static Assets + D1（无 R2）

一个 Hono 应用同时提供 `/api/*` 与静态前端（`[assets] directory = ./web/dist`，非 API 路径走 `ASSETS.fetch`），同源免 CORS；`wrangler dev` 本地 D1 全模拟；`vitest` 跑单测（含 Access 中间件集成测试）。不做 Durable Objects。

### ADR-8 备份：导出为主，Time Travel 兜底

1. **`GET /api/export`**：从 D1 导全库 md 的 zip（不依赖 `d1 export`，不受虚表限制）——这是主备份路径；
2. **本机 git 仓库**：`scripts/pull-export.mjs` 定时把 export 落回本机 vault 目录并 `git commit`，版本历史交给 git（也保证随时能回 Obsidian）；
3. **D1 逻辑备份**：`scripts/backup.mjs` 先 `DROP` FTS 表 → `wrangler d1 export` → 重建 FTS（`/api/admin/reindex`）；
4. **Time Travel**：付费 30 天 / 免费 7 天点恢复兜底。

### ADR-9 导入策略（**已拍板：直接导，不脱敏**）

- 用户决定：内容只有自己看，**36 篇原样导入，不做脱敏、不排除**（含 `云 API 与凭据复现`、`iOS 客户端 2.6.55 逆向` 那两篇）。
- 导入时**不改 raw 原文**（保证逐字节 round-trip）；只在 API 的 `frontmatter` 字段里剔除失效键（`source/node_token/obj_token`），raw 中仍保留（与 ADR-9 一致：原样保存、只影响对外元数据）。
- 安全仍靠「私有入口 + Access」：等部署时挂 Access；在此之前本地/内网用 dev token。
- 仍建议轮换 `Enter-tainer/reverse-kb` 的 GitHub token（本次 clone 里已删 `.git`；这是仓库访问凭据问题，与内容是否脱敏无关）。

### ADR-10 明确不做

向量/语义检索（v2 评估）、trigram 主索引（§4.2 实测被 F 压制）、external content + trigger、Durable Objects、附件/图片、块级引用/嵌入、多人协作、公开访问。

---

## 4. 检索设计（本方案的核心）

### 4.0 三个术语先说清（解释 ticket 里的疑问）

**「段落切块（chunking）」是什么？是搜索的一部分吗？**
是搜索的一部分，但不是「把文章切开来存」。文章还是一篇完整的 md（`documents.raw` 一个字不动）；切块只发生在**搜索索引**里：把一篇 38KB 的笔记按标题/段落切成 ≈600 字的小块，每块单独进 FTS5。原因：只按整篇算分时，一篇长笔记里某个词出现 20 次，就会把「标题里就有这个词」的短笔记压下去——实测文件级排序 canonical@1 只有 0.54，切块后 0.71。搜索命中后仍按「文件」折叠展示，用户看到的还是「哪篇文章的第几段」。

**「C1」是什么？**
bench 里的一个方案代号，不是产品名：在 bigram 索引之外**额外把每个汉字也单独存进索引**（unigram），这样搜 1 个字（比如「压」）也能命中。代价是索引从 1.18× 涨到 1.46×（+40%）。因为 1 字查询噪音大（「压」会命中所有提到「压感/压缩/电压」的文章），**本方案不上 C1，产品层要求至少 2 个字**；将来真需要再加，schema 不用改。

**「F / G / H」是什么？**
都是 bench 的方案代号：F = bigram + 标识符子 token + 查询端前缀；G = F + 段落切块；H = F + 原文后验（清掉 `access_token` 命中 "access token" 这类误报）。本方案 = **F + G +（按需）H**。

### 4.1 为什么必须预分词：三组实测数据

用 36 篇真实语料、55 条查询（48 正 / 7 负）跑了 10 个方案，完整数据见 `research/bench/README.md`、`results.json`：

| 方案 | 2 字中文 | 4 字中文 | hit@5 | canonical@1 | 索引/总库膨胀 |
|---|---|---|---|---|---|
| A 裸 `unicode61` | 5/5（碰运气，语料短串多） | **0.30** | 0.77 | 0.46 | 0.80× / 1.86× |
| B `trigram` | **0/5（静默 0）** | 1.0 | 0.79 | 0.42 | 3.85× / 4.92× |
| C bigram | 5/5 | 1.0 | 0.94 | 0.52 | 1.04× / 2.49× |
| D bigram + 标识符子 token | 5/5 | 1.0 | 0.96 | 0.52 | 1.18× / 2.63× |
| **F = D + 标识符前缀** | **5/5** | **1.0** | **0.98** | 0.54 | **1.18× / 2.63×** |
| **G = F + ≈600 字段落切块** | **5/5** | **1.0** | **0.98** | **0.71** | 1.40× / 3.25× |
| E trigram+标识符双表 | 0/5 | 1.0 | 0.79 | 0.40 | 4.15× / 5.63× |

三条硬结论：

1. **`trigram` 不能当中文主索引**：任何 <3 字符查询**静默返回 0**（不报错、不告警），2 字中文 0/5；`BLE 协议` 这类中英混合也会整体落空。
2. **裸 `unicode61` 不能当主索引**：整段汉字一个 token，4 字中文命中率 0.30。
3. **bigram（不依赖词典、Worker 里可确定性实现）是唯一同时满足「2 字中文 + 代码标识符 + 低膨胀」的方案**；`trigram` 在标识符子串上确实更强，但被 F 的前缀查询拿走了大部分收益，不值得多 2.5 倍索引。

### 4.2 排序：文件级 bm25 的天花板很低，必须切块

`hit@1=hit@3=hit@5` 是语料小 + GT 子串定义导致的（有结果第一条就中），真正看排序的是 **canonical@1**：

- 文件级 F：canonical@1 = **0.542**；4 字中文 queries 的 canonical@1 = **0**（长笔记里某词出现 20 次，压过了标题就是答案的短笔记）。
- 段落级 G：canonical@1 = **0.708**、canonical@3 = **0.917**；4 字中文 canonical@1 从 0 → **0.70**；查询耗时反而更低（0.12ms）。
- 再加 **标题/路径列权重** `bm25(fts, 4.0, 1.0)` 预期还能涨（未单独测，实现时一起上）。

→ 所以 schema 里检索以 **chunk 为单位**，`search` 结果折叠回文件（同文件取最佳 chunk 分）。

### 4.3 写入端变换（必须与查询端共用同一模块）

```
scan(text):
  CJK 连续段（\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff）:
    len>=2 → 所有重叠 bigram，空格分隔（心率广播 → "心率 率广 广播"）
    len==1 → 输出该字
  非 CJK 段: 抽 [A-Za-z0-9][A-Za-z0-9_.\-/+:]* 形态的词:
    1) 先输出整词（必须，否则 phrase 邻接被破坏：2.6.55 / CVE-2026-98260 靠它）
    2) 再输出子 token: 去掉 0x 前缀；按 _ . - / + : 切段；camelCase 再切；长度<2 丢弃
```
查询端同样的函数，然后拼 FTS5 表达式：CJK 段 → 一个 phrase（`"心率 率广 广播"`）；ASCII 标识符 → 前缀 `token*`（仅 `[A-Za-z0-9_]+` 形态，`CVE-2026-…` 这类回退普通 phrase）；全部 AND。**永不把用户输入直接拼进 MATCH**（`-`/`*`/`OR` 会变成语法）。

### 4.4 查询端：1 字、分隔符误报、高亮

- **1 字中文**：bigram 索引没有 unigram，查 `压` 命中不了。产品决策建议：**要求 ≥2 字**（成本 0）。若必须支持：上 C1（索引 +40%，1.46×）；不要用 `LIKE` 兜底（D1 的 LIKE pattern 上限 50 字节，且全表扫）。
- **多词约束只能有一个 MATCH**：SQLite 不允许 `MATCH 'a' OR MATCH 'b'`（D1 上会报错，已实测），必须把用户输入拼成一个表达式串（`'"压感" AND ble*'`），所有变量走**绑定参数**而不是字符串拼接。
- **分隔符折叠误报**：`_ . - /` 在 tokenizer 里是分隔符，`access_token` 会命中只写 "access token" 的文档，`boot.img` 命中 "boot img"。处理：**只对含分隔符的查询**，对 top-50 候选用原文做一次大小写不敏感子串校验（H 方案），precision@5 从 0.985 → 1.0，代价 0.14ms → 0.35ms。
- **高亮/摘要不要用 `snippet()`**：FTS 里是 bigram 变形文本，snippet 出来是垃圾。用 `raw.slice(chunk.start_off, end_off)` + JS 子串定位，客户端 `<mark>`。

### 4.5 检索接口的 golden set（进 CI）

把 bench 的 55 条查询（48 正 / 7 负）固化成 `tests/search.golden.test.ts`，每次改变换算法/分词版本必须全绿：

- 2/3/4 字中文命中率 100%；标识符 100%；7 条假词 0 误报；
- `canonical@1 ≥ 0.65`、`canonical@3 ≥ 0.90`（按 G 的实测 0.71/0.92 留余量）；
- `tokenizer_version` 一改，全量重建 FTS（`/api/admin/reindex`），测试同样跑一遍。

代价：CI 里需要一份 594KB 的测试语料。**敏感内容不能进公开 CI** → 测试语料只放本地/私有 runner，CI 用「脱敏子集 + 合成中文样本」（保留机制性断言，命中率断言只在本地全量跑）。这一点要在 M2 写清楚。

### 4.6 v2 再考虑的语义/混合检索（不阻塞本方案）

- **Workers AI `@cf/baai/bge-m3`**（1024 维，$0.012/M input tokens；全库约 0.1–0.2M tokens ≈ $0.001–0.002，几乎免费）+ **Vectorize**。贵的是查询侧与存储，不是嵌入。
- 计费反直觉：**queried vector dims 随索引规模增长**，按官方样例量级，小库每次查询就可能吃掉月度含额的一大块（`research/d1/capabilities.md` §5.2 有推算，属推导非官方口径，需要实测）。
- 若 `trigram` 第二索引也留作 v2：将来若有「只知道标识符中间一段」的查询（`UserBy` in `getUserById`），加一张 trigram 表 + RRF 融合即可（E 方案已验证融合代码路径，只是当前被 F 压制）。

---

## 5. 数据模型（D1 DDL 草案）

```sql
-- 文档：工作副本（raw = 完整 md 原文，含 frontmatter）
CREATE TABLE documents (
  id                INTEGER PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,        -- vault 相对路径，不含 .md（例：示例目录/示例设备逆向/BLE 协议与 .dat 文件格式）
  title             TEXT NOT NULL,               -- frontmatter.title 或首个 H1 或 stem
  raw               TEXT NOT NULL,               -- md 原文（≤1.5MB 守卫）
  body_hash         TEXT NOT NULL,               -- sha256(raw)，乐观锁 + R2 镜像去重
  frontmatter_json  TEXT,                        -- 仅保留非敏感键（tags/updated/自定义）
  tags_json         TEXT,
  size_bytes        INTEGER NOT NULL,
  mtime             TEXT NOT NULL,               -- ISO8601（JSON 里保留原字符串）
  tokenizer_version INTEGER NOT NULL DEFAULT 1,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- 段落/块：检索粒度（≈600 字，按标题/段落边界切）；start/end 是 JS 字符串下标，用于从 raw 取摘要
CREATE TABLE doc_chunks (
  id          INTEGER PRIMARY KEY,               -- = doc_id * 1000 + ord
  doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  heading     TEXT,                              -- 所属 h2/h3（无则空）
  start_off   INTEGER NOT NULL,
  end_off     INTEGER NOT NULL,
  search_text TEXT NOT NULL                      -- 变换后的检索文本（写入端算好）
);
CREATE INDEX idx_chunks_doc ON doc_chunks(doc_id);

-- 独立 FTS5（不用 external content、不用 trigger；rowid = doc_chunks.id）
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title_text,                                    -- 标题 + path + heading 的变换文本
  body_text,                                     -- chunk 的变换文本
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 链接图（rename 需要 line/col 做位置改写）
CREATE TABLE links (
  id          INTEGER PRIMARY KEY,
  src_doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  dst_doc_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,  -- NULL = 断链/外部
  target_raw  TEXT NOT NULL,                     -- [[…]] 里的目标文本
  form        TEXT NOT NULL,                     -- wikilink | mdlink | url
  line        INTEGER NOT NULL,
  col         INTEGER NOT NULL,
  alias       TEXT                               -- [[x|别名]] 的别名（当前语料为 0，schema 先留）
);
CREATE INDEX idx_links_dst ON links(dst_doc_id);
CREATE INDEX idx_links_src ON links(src_doc_id);
```

写入一个文档（`PUT`）的 batch 顺序（原子）：

```
1. DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM doc_chunks WHERE doc_id = :id)
2. DELETE FROM doc_chunks WHERE doc_id = :id
3. DELETE FROM links WHERE src_doc_id = :id
4. INSERT INTO documents(...) ON CONFLICT(path) DO UPDATE ...   -- 先头部校验 hash
5. INSERT INTO doc_chunks(...) VALUES (...), ...                 -- id = doc_id*1000+ord
6. INSERT INTO chunks_fts(rowid, title_text, body_text) VALUES ...
7. INSERT INTO links(...) VALUES ...
```

单条 SQL 100KB：正文/派生文本一律走 **绑定参数**（100 个参数上限内；每篇 2–3 个参数），不把长文本拼进语句。chunk 数量约 18/篇 → 一条 INSERT 最多 18 行 × 5 列 = 90 参数，正好在 100 内；超出就拆成两条。

> 本 DDL 与两条查询已在本地 D1 实测（`research/poc/plan-schema.sql`，wrangler 4.155.0 `--local`）：建表、写入、`bm25(chunks_fts, 4.0, 1.0)` 升序、标识符前缀查询全部通过。
> **一个已踩到的坑**：SQLite/D1 不支持 `WHERE fts MATCH 'a' OR fts MATCH 'b'`（报 `unable to use function MATCH in the requested context`）。多词约束必须拼成**一个** MATCH 表达式（`MATCH 'a OR b'` 或 `MATCH '"a b" AND c*'`），这也正是 §4.3「自己拼表达式」的另一个理由。

---

## 6. API 与写入路径（agent 优先）

### 6.1 REST 一览（`/api`，JSON；鉴权见 §7）

> **实现里 `GET /api` 返回自描述 JSON（端点清单 + 约定 + 错误码）**，agent 优先读它，不必读本表。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api` | **自描述**：endpoints / conventions / error 格式 |
| GET | `/api/health` | `{ok, docs, stale, tokenizerVersion}`；`stale>0` 表示索引落后正文 |
| GET | `/api/tree?prefix=&limit=` | 列目录（path/title/tags/size/updated），limit 默认 500、上限 2000 |
| GET | `/api/docs/{path}` | 取一篇：`raw`/`frontmatter`/`hash`/`revision`/`stale`；带 `ETag: "<hash>"`；`If-None-Match` → 304 |
| PUT | `/api/docs/{path}` | 写一篇（body=完整 md）。新建必须 `If-Match: *`；修改必须 `If-Match: <hash>`（`"hash"`/`W/"hash"`/裸 hash 都接受）；缺失 → 428、过期 → 412 |
| DELETE | `/api/docs/{path}?force=1` | 删除；有反链 → 409；`force=1` 强删并把入链变断链 |
| POST | `/api/docs/{path}/rename` | `{"to":"新路径"}`；改 path + 全库改写引用；返回 `{rewritten, unresolved, alreadyRenamed?}` |
| GET | `/api/docs/{path}/links` | 出链（target/resolved/dstPath/line）；文档不存在 → 404 |
| GET | `/api/docs/{path}/backlinks` | 反链（按来源去重 + 提及次数）；文档不存在 → 404 |
| GET | `/api/search?q=&limit=` | 检索：`results[{path,title,heading,score,relevance,snippet,highlights}]`；`score` 是 bm25 负数（越小越相关），`relevance=-score`；limit 默认 10、上限 50；1 字中文返回 `note` |
| GET | `/api/reports/links?unresolved=1` | `unresolved=1/true/yes` → `{unresolved,count}`；不带参数 → `{links,count}`（全部内部链接）；非法取值 → 400 |
| GET | `/api/reports/orphans` | 无入链页面 |
| GET | `/api/reports/stale` | 索引落后正文的文档（可 `POST /api/admin/reindex` 修复） |
| GET | `/api/export?format=json\|zip` | 导全库 md；其它 format → 400 |
| POST | `/api/admin/resolve-links` | 全库重解析双链（导入后/手动修复） |
| POST | `/api/admin/reindex` | 重建 chunks_fts + 清孤儿 FTS 行；返回 `{documents,chunks,stale,orphansRemoved}`，`stale` 应 0 |

约定：未知 query 参数一律 400（不静默忽略）；错误体 `{error}`，500 额外带 `requestId`；集合路径方法不对返回 405 + `Allow`；`/api/docs` 本身 404。

`path` 用 URL 编码（中文/全角冒号/空格都有）；内部一律不写路径式链接（`[[文件名]]` 解析规则见 §6.3）。

### 6.2 写入路径细节

1. 校验：auth → body ≤1.5MB → frontmatter 可解析 → `If-Match` 对比 `documents.body_hash`。
2. 解析：title（frontmatter.title → 首个 H1 → stem）、tags、links（**先剔除围栏代码块与行内代码**再扫 `[[…]]`，避免代码里的 `[[`；本次语料 163 条 = 原始 `[[` 总数，说明当前无假阳性，但规则要写死）。
3. 变换：raw → chunks（标题/段落切 ≈600 字）→ 每块 `search_text`；`title_text` = 变换后的 title+path+heading。
4. batch 写入（§5 顺序）。没有 R2、没有第二步写入。

> 失败语义因此很简单：batch 成功 = 写入成功；batch 失败 = 什么都没变。不会出现「文件新、索引旧」。

### 6.3 链接解析规则（与 Obsidian 一致，也是本次盘点口径）

1. `[[` 与 `]]` 之间、去掉 `|别名`、去掉 `#标题`/`#^块` → 目标文本；
2. **同目录优先**（`当前目录/stem.md` 存在即命中）；
3. 否则**全库唯一文件名**（大小写不敏感）；
4. 再否则按相对路径 → vault 根；
5. 都失败 = 断链（`dst_doc_id NULL`）。

当前语料：153 条走 3、10 条走 2、0 条走 4/5。

### 6.4 rename 算法

```
1. 读目标文档 + 所有引用它的 links（src, line, col, raw）
2. 对每个 src：解析出 raw 里 [[旧stem]] 的位置（用 line/col 直接切片，不全文替换）
   → 目标文本旧名 → 新 stem；保留 |别名、#heading 等后缀
3. 计算所有受影响 src 的新 raw → 重新变换 + 重新解析 links
4. 一个 db.batch()：更新目标 path/title、更新每个 src 的 raw/chunks/fts/links
5. 整库重算解析，断言 unresolved == 0；否则回滚（batch 失败即回滚）
```
边界：folder note（`示例目录/示例设备逆向.md` ↔ 同名目录）rename 时**保持 `.md` 与目录成对**，否则路径式解析会歧义；rename 后 10 条「同目录」解析的链接要重新匹配（153 条「唯一文件名」不受影响）。

---

## 7. 鉴权、部署与成本

### 7.1 鉴权：Cloudflare Access JWT（Worker 内验签）

```
本地:   wrangler dev 只监听 127.0.0.1           → loopback 例外，免验
线上:   自定义域 + Cloudflare Access            → @hono/cloudflare-access 验 RS256/iss/aud/exp
        workers_dev = false                     → 没有绕过入口
```
- 中间件：`cloudflareAccess(ACCESS_TEAM_DOMAIN, ACCESS_AUD)`；401/500 被包装成 JSON，畸形 token → 401。
- Access 挂载步骤（部署时做）：自定义域 route → Access application → 邮箱白名单策略；并打开 **Managed OAuth**（Advanced settings，建议 Allow localhost/loopback clients、Access token 5–15m、Grant session 1–2 周）。
- **agent 登录三选一**（`scripts/agent-oauth.mjs` 实现第一种）：
  1. **Managed OAuth**（推荐，不用申请 token）：`node scripts/agent-oauth.mjs login <base>` → 浏览器 SSO/邮箱登录一次；之后 `token`/`curl` 自动 refresh。RFC 9728/8414/7591 + PKCE，token 是 opaque `oauth:…`，Access 边缘换成 `Cf-Access-Jwt-Assertion` 给 Worker（代码零改动）。
  2. `cloudflared access curl` / `cloudflared access login` 拿 `cf-access-token` 头（同样是你身份的短期 token）。
  3. Service Token（`CF-Access-Client-Id/Secret`）——只有**完全无人值守**（cron/CI）才需要；代价是 dashboard 建一次 + Service Auth 策略。
- 验收：`curl -i https://<域名>/api/health` 不带凭据必须 **401 带 `WWW-Authenticate`**（开了 Managed OAuth）或 302；开了 OAuth 后 `scripts/agent-oauth.mjs curl <base> /api/health` 应 200。
- 若 Access 参数还没配好，Worker 侧返回 **503 fail-closed**（不会是 200）。
- **不要给 agent D1 的 API Token**（账号级、全库）。

### 7.2 部署

```
pnpm i
cd web && pnpm i && pnpm build && cd ..      # 产出 web/dist（Worker 静态资源）
pnpm wrangler d1 create kb                    # 把输出里的 database_id 填进 wrangler.toml
pnpm wrangler d1 execute kb --remote --file=migrations/0001_init.sql
pnpm wrangler deploy --var ACCESS_TEAM_DOMAIN:<team> --var ACCESS_AUD:<aud>
```
本地开发：`pnpm dev`（wrangler dev，本地 D1 在 `.wrangler/state`，无需账号、无需 token）；测试：`pnpm test`；全链路验收：`pnpm verify`（需先 `pnpm dev`）。

### 7.3 成本（按规模推算）

| 项 | 用量 | 成本 |
|---|---|---|
| Workers Free | 36 篇、日读几千行 | $0（免费 5M 读/天、100k 写/天足够；但付费 $5/月更稳，且单库 10GB） |
| D1 | 3–4MB / 单库 | $0 |
| CF Access | 单用户 | Free 层 50 用户，$0（部署时再挂） |
| 域名 | 自定义域 | 现有域名或 ~$10/年 |
| R2 | **不用** | $0 |

→ 如果不上 Workers Paid、不引入 AI Search/Vectorize，**现金成本 = 域名**；运维成本 ≈ 0（无服务器）。这点和 ticket 的「近乎零成本」一致。

---

## 8. Web UI（最小但够用）

| 页面 | 功能 |
|---|---|
| `/` | 左树（path 层级）+ 右列表（最近更新/搜索框） |
| `/d/<path>` | 渲染正文（callout/tables/code 高亮/wikilink 可点）+ 底部反链面板（按源去重 + 次数）+ 编辑按钮 + hash 显示 |
| `/edit/<path>` | textarea（左）+ 实时预览（右，同一 markdown-it 实例）；保存带 `If-Match`，412 时提示「文件已被改」并给「重新加载/强制覆盖」 |
| `/search?q=` | 结果列表：标题 + 命中段落摘要（`<mark>`）+ 所属 heading + 分数；空结果给「≥2 字」提示 |
| `/reports` | 断链、无入链、无出链 |
| 可选 v2 | 图谱、标签页、导出按钮 |

不引入前端框架（3 个页面 + 少量状态），Vite + TS；`markdown-it` 与渲染插件在前端 bundle，Worker 只返回 `raw`。首屏 <100KB gzip 量级。

---

## 9. 实施计划（里程碑 / 估时 / 验收）

| 里程碑 | 内容 | 估时 | 验收 |
|---|---|---|---|
| **M0 骨架** | pnpm + wrangler.toml + `migrations/0001_init.sql` + 路由骨架 + vitest + 本地 D1 | 0.5d | `pnpm dev` 起来 `/api/health` 200；`pnpm test` 绿 |
| **M1 导入** | `scripts/import.mjs`（两阶段：先灌文档，再 `resolve-links` 重解析）+ 对账 | 0.5d | 36 篇导入；内部链接 163/163 解析、0 断链；每篇入链数与 `research/corpus/inventory.md` 一致；抽 5 篇人工核对与 Obsidian 一致 |
| **M2 检索** | `transform.ts` + `chunk.ts` + FTS 写入/重建 + `/api/search` + golden set | 1d | 23 条 micro check 全绿；55 条 golden set 达标（§4.5）；`/api/search` 中文 2/4 字、标识符、中英混合都有正确 top-1 |
| **M3 API/鉴权** | CRUD + rename + links/backlinks + reports + export；鉴权交给 Access（代码零鉴权）；smoke | 0.5d | agent 5 件套全通；本地免鉴权可用；rename 后断链 0；`/api/export` 导出的 md 与源 vault 逐字节一致 |
| **M4 Web UI** | 3 个页面 + 编辑器 + 搜索 + 反链 + 冲突处理 | 1.5d | 手机浏览器可读；编辑保存 412 流程正确；270 个表格块渲染抽检 20 个无误 |
| **M5 运维** | 备份脚本（export→本机 git）、`/api/admin/reindex`、README、部署文档 | 0.5d | 删库重建流程演练一次；tokenizer 版本升级演练一次 |
| 合计 | | **≈4.5d**（最小闭环 M0–M3 ≈2.5d） | |

依赖关系：M1 依赖 M0；M2 依赖 M0/M1（需要真实数据）；M3 依赖 M2；M4 依赖 M3；M5 随时可做。

---

## 10. 风险与未验证项

| # | 风险 | 处置 |
|---|---|---|
| 1 | **生产 D1 的 FTS5 未在本机生产环境验证**（只有官方文档 + 社区 + 本地 workerd 模拟） | 上线前跑 `research/d1/capabilities.md` §8 的 11 条实测清单，最优先 4 条：生产建 FTS5、`bm25`、中文 2 字行为、`d1 export` 限制 |
| 2 | D1 的 SQLite 版本未知，将来新语法（contentless_delete、locale）不可预判 | 不依赖新语法；只用 unicode61 + bm25；版本变更时靠 golden set 回归 |
| 3 | `d1 export` 不支持含虚表的库 | 自带 `/api/export`；逻辑备份前 DROP FTS；Time Travel 兜底 |
| 4 | FTS5 的 `rows_read/written` 计费口径未知 | 上线后读 `meta.rows_read/written`，按 36 篇规模估算余量（免费额度 5M/天） |
| 5 | 内容敏感性（逆向/破解 + 2 篇含凭据片段） | **已定：直接导入不脱敏**（只有自己看）；私有性靠 Access + `workers_dev=false` + 不公开域名；确认可接受内容存 Cloudflare（境外） |
| 6 | 单篇 >2MB 会撞 D1 行上限 | 写入口 ≤1.5MB 守卫 + 明确报错；将来真有大文档再分块存（chunk 已经是行级，但 raw 是一行） |
| 7 | folder note 与 rename 歧义 | rename 保持 `.md` 与同级目录成对；rename 后全库重算并断言断链 0 |
| 8 | 1 字中文查询不可用 | 产品层要求 ≥2 字（推荐）；需要时上 C1（+40% 索引） |
| 9 | 分隔符折叠误报（`access_token` → "access token"） | 含 `_ . - /` 的查询做原文后验（H） |
| 10 | 本机沙箱此前跑不了 wrangler（现策略已放开，本地 D1 已实测可用） | 本地 `pnpm dev`/`pnpm test` 可跑；**首次 `wrangler d1 create`/`deploy` 需要你的终端**（OAuth 登录态已在，但创建资源会写账号） |
| 11 | golden set 语料含敏感内容，不能进公开 CI | 全量 golden 只在私有 runner/本地跑；公开 CI 用脱敏子集 + 合成样本 |
| 12 | 渲染 `<br>` 与 `==高亮==` 等少量扩展 | `html:true` + DOMPurify（或把 `<br>` 预处理成空格）；`==` 用插件；抽检 270 个表块 |

---

## 11. 决策记录（本次已全部定完）

| 问题 | 决定 | 依据 |
|---|---|---|
| 要不要用 R2？能不能全存 D1？ | **全存 D1，v1 不用 R2** | 2MB/行的 50 倍余量；单事务写入；少一套绑定；导出+git+Time Travel 已够备份（ADR-1） |
| 段落切块是什么？ | 只切**搜索索引**、不切原文；按标题/段落 ≈600 字一块；命中后折叠回文件展示 | canonical@1 0.54 → 0.71（§4.0/§4.2） |
| C1 是什么？用不用？ | 是「额外索引单字」的方案代号；**不用**，产品层要求 ≥2 字；将来需要再加，schema 不变 | 1 字查询噪音大；索引 +40%（§4.0/§4.4） |
| 部署 / Access | **后续再说**：代码用 Hono 中间件验 Access JWT（本地 loopback 例外）；你部署时挂 Access 并确认 `workers_dev=false` | 不阻塞开发（ADR-5） |
| 能不能自己建 API Token | **不能**（需要你在 Cloudflare dashboard 用账号权限创建；我这边只有 wrangler OAuth 登录态，可 `deploy` 但建不了 token）。先不着急，等部署时给步骤 | 权限模型限制 |
| 两篇含凭据的笔记怎么处理 | **直接导入，不脱敏、不排除** | 你已拍板：只有自己看（ADR-9） |
| 检索方案 | **F + G +（按需）H**，只依赖 FTS5 自带 unicode61 | 实测（§4） |
| 双链/rename/UI/估时 | 按 §6、§8、§9 | — |

**仍未决但不阻塞**：正式域名、Access 策略细节、是否开 Workers Paid（免费额度当前够）、是否要 v2 语义检索。

---

## 12. 实现状态（2026-11-12 更新）

### 12.1 进度

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 骨架 | ✅ | Hono 路由 + D1 schema（含 `indexed_hash`）+ wrangler dev |
| M1 导入 | ✅ | `pnpm import`：36 篇、正文逐字节一致、163/163 双链、0 断链；出链/入链逐项与 `links.csv` 一致 |
| M2 检索 | ✅ | bigram+标识符变换、≈600 字段落切块、标题权重 bm25；golden set 达标（见 12.2） |
| M3 API | ✅ | CRUD/rename/links/backlinks/reports/export；If-Match 412/428、ETag/304、404 语义 |
| M4 Web UI | ✅（待 UX review） | 树/文档/编辑 412/搜索/反链/报告；Vite 构建到 `web/dist` |
| M5 运维/文档 | ✅ | README/方案已更新；`scripts/backup.mjs` 导出全库 md zip（实测 601KB / 36 篇，可直接解压回 Obsidian）；`/api/admin/reindex` 索引自愈 |

### 12.2 本地实测（可复现）

| 项 | 结果 | 命令 |
|---|---|---|
| 单测 | **63 项全绿**（含 12 项 Access 中间件集成：合法/篡改/过期/aud/iss/alg=none/JSON-null/JWKS 503/未知 kid） | `pnpm test` |
| 导入对账 | 36 篇逐字节一致；内部双链 163/163；每篇入链数全部一致 | `pnpm import` |
| golden 检索 | 46 条正查询 hit@1/3/5 = **100%**；canonical@1 **80.4%**、canonical@3 **95.7%**；7 条假词 0 误报；**摘要含查询词 46/46 = 100%** | `pnpm golden` |
| 对抗测试 | 路径穿越/注入/超大 body/并发写/畸形 md/rename/zip 全部通过 | `pnpm adversarial` |
| 正确性回归 | 1200 chunk 大文档、并发新建、CAS 无副作用、rename 全形态、入链自愈、CRLF、自链接 | `pnpm regression` |

### 12.3 对抗性 review 与修复

| review | 状态 | 结论 |
|---|---|---|
| 正确性/安全（`reviews/review-security-20261112.md`） | ✅ 已处理 P0/P1 | 2 个 P0 已修：①`chunk_id = docId*1000+ord` 跨文档撞主键（改 `*100000` + 上限守卫 + 回归）；②CAS 与正文写入分离导致 hash/正文分裂（改成单条原子 UPDATE + 索引失败降级为 `indexStale` + reindex 自愈）。P1 已修：500 不回 `err.message`、自研 JWT 改为官方 `@hono/cloudflare-access`、body 流式 cap、`/api/tree` prefix 改范围扫描、links/backlinks 404、ETag/304、If-Match 412/428 语义、rename 按解析结果改写 + emoji 掩码长度守恒 + `![[embed]]` 保留。单用户场景不做权限分级。 |
| 数据层/检索（`reviews/review-data-search-20261112.md`） | ✅ 已处理 P0/P1 | 修复：①检索召回坍缩——`title_text` 由「标题+全篇 heading」改为「标题+本 chunk heading」，候选 `LIMIT` 20→100/500，实测「BLE」2→**16** 篇、「协议」3→17、「逆向」8→31、「固件」4→23；②幽灵空文档——新建流程整体进 try/catch，失败删占位行，历史占位行按 404 处理且可用 `If-Match:*` 修复；③超长单行硬切 1200 字，避免 chunk 撞 D1 2MB 行；④CRLF frontmatter/heading（`split('\n')` 残留 `\r` 导致 `.*$` 不匹配）已修 + 单测；⑤代码块内 `#` 不再当标题；⑥只有标题的文档也产出 chunk；⑦PUT 后自动补解析入链（导入/先建链接后建目标不需要手动 admin resolve）；⑧rename 支持自链接、同 stem 换目录、半途失败回滚、`alreadyRenamed` 不再假装成功。 |
| UX（人，`reviews/ux-20261112.md`） | ✅ P0/P1 全部关闭（含复验） | P0 脏改动拦截（11 条离开路径）复验通过。P1：412 弹层（人话/推荐项/继续编辑/覆盖二次确认/焦点陷阱）、手机编辑 282→502px/16px、宽表格滑动提示、摘要剥 frontmatter、报告错误态+重试、404 人话、手机目录抽屉（点笔记/遮罩即关）、列表去重复、heading 锚点 + 可折叠 TOC（hash 深链接落点正确）、技术黑话折叠、触控目标 44/44 ≥44px、＋新建、桌面编辑 16px 全部通过。剩 P2（深色模式、代码 AA 对比度、反链侧栏、出链行级跳转等）记为已知限制。 |
| agent-UX（API，`reviews/agent-ux-20261112.md`） | ✅ 已处理 P0/P1 | 4 个 P0 已修：①`GET /api` 自描述端点清单+约定（此前返回 SPA HTML）；②`If-Match` 接受 `"hash"`/`W/"hash"`/裸 hash（此前标准 ETag 写法必 412）；③未知参数不再静默——`kind`/非法 `unresolved`/非法 `format` 一律 400；④`score` 负值语义文档化并新增 `relevance=-score`。P1 已修：PUT 新建 revision 返回 1 与 GET 一致、HEAD `/api/docs/*` 200、集合路由方法错 405、`/api/docs` 404、`/api/reports/stale` 新增、孤儿 FTS 行清理（reindex 内 `rowid NOT IN doc_chunks`）+ 按 rowid 区间删 FTS、smoke 失败不再打印 OK。剩余 P2（`updated` 混用 ISO/date-only、单 token 无分级等）记为已知限制。 |

### 12.4 需在你终端执行

1. `wrangler d1 create kb` → 填 `database_id`
2. `pnpm wrangler d1 execute kb --remote --file=migrations/0001_init.sql`
3. `cd web && pnpm build` → `pnpm wrangler deploy --var ACCESS_TEAM_DOMAIN:<team> --var ACCESS_AUD:<aud>`
4. Zero Trust 里给域名挂 Access（邮箱白名单 + agent Service Auth）
5. `curl -i https://<域名>/api/health`：不带凭据应 302/401；带 service token 应 200
6. 生产 D1 冒烟：建 FTS5、`bm25`、2 字中文、`d1 export` 限制（`research/d1/capabilities.md` §8 的清单）

---

## 附录 A：证据索引

| 文件 | 内容 |
|---|---|
| `research/d1/capabilities.md` | D1 FTS5/中文/限额/替代方案，585 行，每条带官方原文 URL |
| `research/d1/sources.md` | 25 条官方 + 6 条社区来源台账（含判为不可用的材料） |
| `research/bench/README.md` | 10 个检索方案的实测报告 + D1 实施注意点 + 验证清单 |
| `research/bench/bench.py` / `results.json` / `[A-H]_schema.sql` | 一键复现 + 全量数据 + 每方案 DDL |
| `research/corpus/inventory.md` | 语料结构/双链/frontmatter/callout/表格统计 + CF 环境盘点 + 隐私风险 |
| `research/corpus/links.csv` | 231 行链接明细（含 resolved/unresolved/kind） |
| `research/poc/` | 本地 wrangler D1 冒烟：FTS5 DDL + bigram phrase + bm25 实测 + 渲染对比脚本 |
| `vault-src/` | 语料只读副本（36 篇；`.git` 已删，勿提交到 git） |

## 附录 B：与 ticket 原文的差异清单

| ticket 原文 | 实测/结论 |
|---|---|
| 「现有 34 篇」 | **36 个 md**（34 = 导出正文，+2 个脚本生成的结构页） |
| 「R2 对象是唯一真相」 | 改为**全存 D1**（ADR-1，已拍板）；md 文本仍是真相单位，`/api/export` 可一键导回 |
| 「可选 FTS 虚表」 | FTS5 是必选（检索主路径），且**不能**用 `d1 export` 备份 |
| 「中文默认 unicode61 不切词，需 bigram 或写入时预分词」 | **bigram 预分词已验证可行**；trigram 因 2 字失效被排除；1 字中文另作产品决策 |
| 「一个 row 可以有 2MB」 | 2MB 是**行/字符串上限**，不是推荐容量；本库最大 39.5KB，余量 50× |
| 「最小闭环 1 天」 | 最小闭环（M0–M3）**≈2.5 天**；检索质量要 G + golden set，1 天不现实 |
| 「Web 编辑器 +2 天」 | 3 页面 + 编辑器 **≈1.5 天**（不引前端框架） |
| 「Durable Objects 先不上」 | 同意，本方案不需要 |
| D1 限额「500MB 免费」 | 正确（Free 单库 500MB、付费 10GB 不可再提） |

