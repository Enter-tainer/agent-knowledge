# 关键来源清单（research/d1/sources.md）

- 项目：TECH-69 检索方案调研（Cloudflare D1 / FTS5 / 中文）
- 全部 URL 访问日期：**2026-11-12**（同日抓取；「日期」栏为该页自报 published / last updated）
- 完整论证见 [capabilities.md](capabilities.md)；本文件只做「来源 → 摘了哪一句 → 用在哪一节」的台账
- 标注：**【官方】** = Cloudflare 官方文档 / 官方代码仓库 / 官方 changelog；**【社区】** = 第三方博客、GitHub issue、个人 ADR

---

## A. 官方来源（Cloudflare 文档 / 官方仓库）

### A1. D1 — SQL statements（D1 支持的 SQLite 扩展清单）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/sql-api/sql-statements/
- **日期**：Last updated **Apr 21, 2026**
- **摘录**：「D1 supports a subset of SQLite extensions for added functionality, including: — **FTS5 module** for full-text search (including `fts5vocab`). — JSON extension … — Math functions.」
- **摘录 2**：「Currently, D1 does not support `PRAGMA optimize(-1)`.」「D1 PRAGMA statements only apply to the current transaction.」
- **用在**：capabilities §1.2（核心支持证据）、§2.2（PRAGMA 白名单）

### A2. D1 — Import and export data → Known limitations
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/best-practices/import-export-data/
- **日期**：页面未单独标注（D1 文档集同期，检索日期 2026-11-12；同站点 llms-full 汇总页标注 Oct 30, 2026）
- **摘录**：「Export is not supported for virtual tables, including databases with virtual tables. **D1 supports virtual tables for full-text search using SQLite's FTS5 module.** As a workaround, delete any virtual tables, export, and then recreate virtual tables.」
- **摘录 2**：「If you receive a `"cannot start a transaction within a transaction"` error, make sure you have removed `BEGIN TRANSACTION` and `COMMIT` from your dumped SQL statements.」
- **用在**：capabilities §1.2（第二处官方明文 + 备份运维约束）、§2.2

### A3. D1 — Limits（全部硬限额数字的唯一出处）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/platform/limits/
- **日期**：Last updated **Oct 30, 2026**
- **摘录**：
  - 「Maximum string, `BLOB` or table row size — **2,000,000 bytes (2 MB)**」
  - 「Maximum SQL statement length — **100,000 bytes (100 KB)**」「Maximum bound parameters per query — **100**」
  - 「Maximum characters (bytes) in a `LIKE` or `GLOB` pattern — **50 bytes**」
  - 「Maximum database size — **10 GB** (Workers Paid) / **500 MB** (Free)」+「Note that the 10 GB limit of a D1 database cannot be further increased.」
  - 「Maximum storage per account — **1 TB** (Workers Paid) / **5 GB** (Free)」
  - 「Maximum SQL query duration — **30 seconds**」+ 脚注「this duration limit also applies to the entire batch call」
  - 「Maximum query result size — **50 MB**」+ 脚注「This limit takes effect on **2026-11-04**」
  - 「Databases per account — Workers Paid: **1,000,000** … Free: **10**」
  - 「Queries per Worker invocation — 1000 (Paid) / 50 (Free)」「a `db.batch()` call counts as a single query」
  - 「Each individual D1 database is inherently single-threaded, and processes queries one at a time.」
  - 「You can open up to **six connections** (to D1) simultaneously for each invocation」
- **用在**：capabilities §3.1、§3.4

### A4. D1 — Pricing（rows read / rows written / storage 计费）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/platform/pricing/
- **日期**：Last updated **Oct 30, 2026**
- **摘录**：
  - 「Rows read — 5 million / day (Free) | First 25 billion / month included + **$0.001 / million rows** (Paid)」
  - 「Rows written — 100,000 / day (Free) | First 50 million / month included + **$1.00 / million rows** (Paid)」
  - 「Storage (per GB stored) — 5 GB (total) (Free) | First 5 GB included + **$0.75 / GB-mo** (Paid)」
  - 「A row that is 1 KB and a row that is 100 KB both count as one row.」
  - 「Indexes will add an additional written row when writes include the indexed column」
- **用在**：capabilities §3.2、§3.4、§7（U7）

### A5. D1 — D1 Database（batch 的事务语义）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/worker-api/d1-database/
- **日期**：Last updated **Jun 22, 2026**
- **摘录**：「Batched statements are **SQL transactions**. If a statement in the sequence fails, then an error is returned for that specific statement, and it **aborts or rolls back the entire sequence**.」
- **用在**：capabilities §3.1（Batch 语义）、§8 第 5 项（触发器原子性实测）

### A6. D1 — Global read replication
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/best-practices/read-replication/
- **日期**：Last updated **Aug 10, 2026**
- **摘录**：「Sessions API is only available via the D1 Worker Binding and **not yet available via the REST API**.」
- **摘录 2**：「D1 read replication is built into D1, so you don't pay extra storage or compute costs for read replicas.」
- **用在**：capabilities §2.2、§3.3、§6.2

### A7. D1 — Release notes
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/platform/release-notes/
- **日期**：Last updated Apr 21, 2026（条目最新为 2025-11-05）
- **摘录**：「**2025-04-10** — D1 Read Replication Public Beta…」「**2025-01-13** — D1 will begin enforcing its free tier limits from the 10th of February 2025.」「**2024-04-01** — D1 is generally available… 10GB GB per-database limit」
- **用在**：capabilities §3.2、§3.3

### A8. D1 — Query a database
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/d1/best-practices/query-d1/
- **日期**：Last updated **Apr 21, 2026**
- **摘录**：「REST API primarily interacts with the control plane, and allows you to create/manage your D1 database.」
- **用在**：capabilities §6.1（与 API Reference 的口径差异，已注明以 API Reference 为准）

### A9. API Reference — Query D1 Database（数据面 REST 端点）
- **类型**：【官方】API 参考
- **URL**：https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- **日期**：无独立日期（API 参考随 API 版本）
- **摘录**：`POST /accounts/{account_id}/d1/database/{database_id}/query`；「Execute a SQL query against a D1 database and return results as objects.」；鉴权 `Authorization: Bearer …`；接受权限 `D1 Read` / `D1 Write`；body `{sql, params}` 或 `{batch:[{sql,params}]}`
- **用在**：capabilities §6.1（「REST 是否存在」的正面答案）

### A10. cloudflare/workerd — `src/workerd/util/sqlite.c++`（运行时白名单，官方源码）
- **类型**：【官方】开源代码
- **URL**：https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B
- **日期**：main 分支，抓取当日 commit 内容（无固定日期）
- **摘录 1（FTS5 辅助函数被显式允许）**：
  ```cpp
  // https://www.sqlite.org/fts5.html
  "match"_kj,
  "highlight"_kj,
  "bm25"_kj,
  "snippet"_kj,
  ```
- **摘录 2（版本号被故意屏蔽）**：
  ```cpp
  // These functions query SQLite internals and build details in a way we'd prefer not to reveal.
  // "sqlite_compileoption_get"_kj,
  // "sqlite_compileoption_used"_kj,
  // "sqlite_offset"_kj,
  // "sqlite_source_id"_kj,
  // "sqlite_version"_kj,
  ```
- **摘录 3**：`ALLOWED_PRAGMAS` 白名单（`case_sensitive_like`、`foreign_keys`、`optimize`、`quick_check` …）
- **用在**：capabilities §1.2、§2.2、§7（U1/U3/U4）

### A11. SQLite — FTS5 Extension（FTS5 语义的权威出处）
- **类型**：【官方】SQLite 文档（非 Cloudflare，但是 FTS5 的定义源）
- **URL**：https://www.sqlite.org/fts5.html
- **日期**：无固定日期（SQLite 官方文档，随版本更新）
- **摘录 1（unicode61 分词规则 → 中文整段一个 token）**：「The unicode tokenizer classifies all unicode characters as either "separator" or "token" characters. By default all space and punctuation characters … are considered separators… all unicode characters assigned to a general category beginning with "L" or "N" … are considered tokens.」
- **摘录 2（trigram 的 3 字符地板）**：「Substrings consisting of **fewer than 3 unicode characters do not match any rows** when used with a full-text query.」
- **摘录 3（bm25 方向）**：「The better the match, the numerically smaller the value returned.」「the FTS5 implementation of BM25 multiplies the result by -1」
- **摘录 4（external content 的责任）**：「it is the responsibility of the user to ensure that the contents of the full-text index are consistent with the named database object.」
- **用在**：capabilities §4.2（中文根因）、§1.3（bm25 方向、external content 风险）

### A12. Workers AI — Pricing
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/workers-ai/platform/pricing/
- **日期**：Last updated **Oct 20, 2026**
- **摘录**：「@cf/baai/bge-m3 | **$0.012 per M input tokens** | 1075 neurons per M input tokens」「@cf/qwen/qwen3-embedding-0.6b | $0.012 per M input tokens」「@cf/baai/bge-reranker-base | $0.003 per M input tokens」「free allocation … **10,000 Neurons per day**」「$0.011 / 1,000 Neurons」
- **用在**：capabilities §5.1

### A13. Workers AI — bge-m3 模型页
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/workers-ai/models/bge-m3/
- **日期**：页面无独立日期
- **摘录**：「Context Window — **60,000 tokens**」「Unit Pricing — $0.0118 per M input tokens」「Multi-Functionality, Multi-Linguality, and Multi-Granularity embeddings model」
- **用在**：capabilities §5.1、§7（U10，与 A14 的 512 input tokens 口径差异）

### A14. AI Search — Supported models（bge-m3 的维度）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/ai-search/configuration/models/supported-models/
- **日期**：Last updated **Oct 1, 2026**
- **摘录**：「| **Workers AI** | `@cf/baai/bge-m3` | **1,024** | **512** | No | No | cosine |」（列：Vector dims / Input tokens / Image support / Default / Metric）
- **用在**：capabilities §5.1（维度 1024 的唯一官方出处）、§7（U10）

### A15. AI Search — Keyword search（CJK 与 tokenizer）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/
- **日期**：Last updated **Oct 16, 2026**
- **摘录**：「The `porter` tokenizer splits text on spaces and punctuation, so it does not work well for Japanese, Chinese, or Korean… Keyword search with `porter` may return no results for queries in these languages.」
- **摘录 2**：「If your content is in Japanese, Chinese, or Korean, use the `trigram` tokenizer… **Words shorter than three characters cannot be matched on their own.**」
- **用在**：capabilities §4.2（CJK 官方结论 = 最强旁证）

### A16. Cloudflare Changelog — 2026-10-16「AI Search keyword search supports Japanese, Chinese, and Korean queries」
- **类型**：【官方】changelog
- **URL**：https://developers.cloudflare.com/changelog/post/2026-10-16-cjk-keyword-search/
- **日期**：**2026-10-16**
- **摘录**：「AI Search keyword search with the `trigram` tokenizer now matches Japanese, Chinese, and Korean queries, including full natural-language questions… Previously, a query without spaces was treated as a single exact phrase and usually returned no keyword results.」
- **用在**：capabilities §4.2

### A17. AI Search — Data source（能否吃 R2）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/ai-search/configuration/data-source/
- **日期**：Last updated **Oct 1, 2026**
- **摘录**：「| [R2 Bucket](…/r2/) | Connect a Cloudflare R2 bucket to index stored documents. |」；支持类型表含「Markdown | `.markdown`, `.md`, `.mdx`, `.mdoc`」
- **用在**：capabilities §5.3

### A18. AI Search — Limits & pricing
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/ai-search/platform/limits-pricing/
- **日期**：Last updated **Nov 2, 2026**
- **摘录**：「Files per instance — 100,000 (Free) / 1M or **500K for hybrid search** (Paid)」「Included semantic queries per month — 1,000」「Included full-text queries per month — 1,000」「**AI Search billing begins on December 1, 2026.**」「Base ingestion — **$0.75 per million tokens**」「Storage — **$2.00 per GB-month**」「Semantic, vector, and hybrid queries — **$0.75 per 1,000 queries**」「Full-text queries — **$0.10 per 1,000 queries**」
- **用在**：capabilities §5.3

### A19. AI Search — Syncing
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/
- **日期**：Last updated **Nov 2, 2026**
- **摘录**：「Jobs run automatically on a schedule, **every 24 hours by default**… The interval can be 15 minutes … 24 hours.」「Sync jobs can be triggered at most once every 30 seconds.」
- **用在**：capabilities §5.3

### A20. Vectorize — Limits
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/vectorize/platform/limits/
- **日期**：Last updated **Oct 30, 2026**
- **摘录**：「Maximum dimensions per vector — **1536 dimensions, 32 bits precision**」「Maximum vectors per index — **20,000,000**」「Metadata per vector — **10KiB**」「Maximum returned results (`topK`) with values or metadata — **50**」「Maximum upsert batch size — 1000 (Workers) / 5000 (HTTP API)」
- **用在**：capabilities §5.2

### A21. Vectorize — Pricing
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/vectorize/platform/pricing/
- **日期**：Last updated **Oct 30, 2026**
- **摘录**：「Total queried vector dimensions — 30 million / month (Free) | First 50 million / month included + **$0.01 per million** (Paid)」「Total stored vector dimensions — 5 million (Free) | First 10 million + **$0.05 per 100 million** (Paid)」「Indexes — 100 (Free) | First 50,000 included + $0.10 per additional (Paid)」
- **用在**：capabilities §5.2

### A22. Durable Objects — Limits
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/durable-objects/platform/limits/
- **日期**：Last updated **Nov 7, 2026**
- **摘录**：「Maximum string, `BLOB` or **table row size — 8 MB**」「Maximum SQL statement length — 100 KB」「Maximum bound parameters per query — 100」「Storage per Durable Object — **10 GB**（Paid）」
- **用在**：capabilities §5.5（DO SQLite 作为 8 MB 行上限的备选）

### A23. cloudflare/agents — `experimental/session-search/README.md`（官方仓库里 DO SQLite 用 FTS5）
- **类型**：【官方】开源仓库（experimental）
- **URL**：https://raw.githubusercontent.com/cloudflare/agents/f9c68e8d04184939714578e70cf1bfa739ae8840/experimental/session-search/README.md
- **日期**：commit `f9c68e8d04184939714578e70cf1bfa739ae8840`（2026 年抓取时点）
- **摘录**：「`AgentSearchProvider` is the built-in implementation using **Durable Object SQLite with FTS5 full-text search**.」「Uses **FTS5 with porter stemming** and implicit AND for multi-word queries.」「`cf_agents_search_fts` — **FTS5 virtual table** for full-text search」「⚠️ **Experimental** — this API will break between releases.」
- **用在**：capabilities §5.5、§1.3（`porter` 只在 DO 侧有官方用法）

### A24. R2 SQL — 概览（raw mdx）
- **类型**：【官方】产品文档（GitHub raw 源文件；对应页面 https://developers.cloudflare.com/r2-sql/ ）
- **URL**：https://raw.githubusercontent.com/cloudflare/cloudflare-docs/4955433c1695e05fe2c487e2e4bf2895de6777a2/src/content/docs/r2-sql/index.mdx
- **日期**：该 commit 内容；页面徽标为 Beta
- **摘录**：「R2 SQL is Cloudflare's serverless, distributed, **analytics query engine for querying Apache Iceberg tables** stored in R2 Data Catalog.」「R2 SQL is in **open beta**… outside of standard R2 storage and operations, you will not be billed for your use of R2 SQL.」
- **用在**：capabilities §5.4（判定「不适合本场景」）

### A25. Cloudflare One — Service tokens（Access 鉴权 header）
- **类型**：【官方】产品文档
- **URL**：https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- **日期**：Last updated **Nov 2, 2026**
- **摘录**：「To authenticate to an Access application using your service token, add the following to the headers of any HTTP request: `CF-Access-Client-Id: <CLIENT_ID>` / `CF-Access-Client-Secret: <CLIENT_SECRET>`」
- **摘录 2**：「Make sure to set the policy action to **Service Auth**; otherwise, Access will prompt for an identity provider login.」
- **摘录 3**：「Zero Trust organizations created on or after **2026-10-05** have strict service token authentication turned on by default and cannot turn it off.」
- **摘录 4**（单 header 模式）：「`read_service_tokens_from_header: "Authorization"`」→ `-H "Authorization: {\"cf-access-client-id\": …, \"cf-access-client-secret\": …}"`
- **用在**：capabilities §6.3

---

## B. 社区 / 第三方来源（实测、issue、事故复盘）

### B1. zenn.dev — D1 生产环境用 FTS5 + trigram + external content + 触发器（2024-04-14）
- **类型**：【社区】个人技术文（日文），含可执行 DDL
- **URL**：https://zenn.dev/polonity/scraps/8c0d27775353b7
- **日期**：**2024-04-14**（作者同日追加/更新）
- **摘录**：
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS myTableFTS USING fts5(
      title, memo, content='myTable', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS fts_insert AFTER INSERT ON myTable BEGIN
      INSERT INTO myTableFTS (title, memo) VALUES (new.title, new.memo);
  END;
  ```
  「期待した結果が得られたら本番環境に適用する。」→ `wrangler d1 execute myTable --file=.\db.sql`（**不带 `--local`，即生产库**）
  Worker 内：`SELECT … FROM myTableFTS JOIN myTable … WHERE myTableFTS MATCH 'ほげほげ AND ふがふが'`
- **用在**：capabilities §1.2、§1.3（trigram / external content / triggers / 生产可用性的最强社区证据）
- **可信度备注**：个人博客、无官方背书；但给出了完整 DDL 与生产执行命令，可复现

### B2. dev.to — FTS5 on Cloudflare D1：39 万行 P50 22ms（2026-06-24）
- **类型**：【社区】生产实测报告（韩文作者，英文文；12 个生产 Worker）
- **URL**：https://dev.to/riversea/fts5-on-cloudflare-d1-cut-my-korean-keyword-search-from-220ms-to-22ms-heres-what-almost-broke-it-3l9p
- **日期**：**2026-06-24**
- **摘录**：「**FTS5 is shipped enabled in D1, no opt-in required**」「The `bm25()` relevance score in FTS5 returns a _negative_ float. Lower means more relevant.」「FTS5's default `unicode61` tokenizer splits on whitespace and punctuation.」「`content='kw_master'` … inserts, updates, and deletes on `kw_master` don't automatically propagate. You need triggers」「P50 latency at 390K rows after six weeks: **22ms**. P95: **under 45ms**.」「88% recall … down from 91% at 40K rows」（韩文 golden set 500 条）
- **用在**：capabilities §1.2（性能与默认行为）、§4.2（CJK 召回衰减）、§8 第 9 项（吞吐基线对照）
- **可信度备注**：文末指向作者自己的长文（dailymanuallab.com）；本页为摘要，数字自洽但未经独立复现

### B3. donweb.news — 对 B2 的西语二手报道（2026-06-25 / 更新 2026-08-30）
- **类型**：【社区】二手转述（新闻站）
- **URL**：https://donweb.news/fts5-cloudflare-d1-busqueda-rapida/
- **日期**：25/06/2026（更新 30/08/2026）
- **摘录**：「FTS5 está habilitado en D1 sin configuración previa, no hay que prenderlo.」（FTS5 在 D1 无需配置即启用）「de 180-220ms a 22ms en un índice de ~400K keywords」「con tablas externas (`content=''`) el índice no se actualiza solo」
- **用在**：仅作 B2 的旁证，**不作为独立证据**（数字同源，且把 `content=''`（contentless）与 `content='表名'`（external content）混写了，属转述误差）

### B4. gkoreli/backlog-mcp — ADR 0093：D1 生产环境 FTS5 索引腐坏事故（2026-04-03）
- **类型**：【社区】工程决策记录（含事故根因）
- **URL**：https://raw.githubusercontent.com/gkoreli/backlog-mcp/refs/heads/main/docs/adr/0093-d1-production-hardening.md
- **日期**：**2026-04-03**（status: accepted）
- **摘录**：「**`SQLITE_CORRUPT_VTAB`** — FTS5 full-text search virtual table corruption on write operations」「Step 2 is the bug: the FTS5 `DELETE` triggers a read of the current row… By the time it runs, the `UPDATE` has already changed the row… until SQLite detects the inconsistency and raises `SQLITE_CORRUPT_VTAB`」「修法：DELETE FROM fts → UPDATE 主表 → INSERT INTO fts；三级降级 FTS → 自动 rebuild → `LIKE` 兜底」
- **用在**：capabilities §1.2（trigger 维护的真实风险）、§8 第 5 项（实测要通过 `integrity-check`）
- **可信度备注**：个人项目 ADR，但属于「已上生产后的事故复盘」，比教程更有参考价值

### B5. GitHub — cloudflare/workers-sdk Issue #7259（2024-11-14，反例材料）
- **类型**：【社区/官方仓库 issue】用户报 bug，无官方回复
- **URL**：https://github.com/cloudflare/workers-sdk/issues/7259
- **日期**：created **2024-11-14T15:14:59Z**，closed **2024-11-14T17:35:38Z**，`comments: 0`
- **摘录**：
  - 标题：「🐛 BUG: D1 attempting to create virtual fts5 table errors」
  - 报错正文：「Could not route to `/client/v4/accounts/<...>/d1/database/<...>/import`, perhaps your object identifier is invalid? [code: 7003]」
  - 「It does work when running on local.」
- **用在**：capabilities §1.2 —— **明确判读为「导入通道问题，不是 FTS5 被拒」**，防止被标题误导；同时列为 §8 第 1 项的复现点
- **可信度备注**：0 回复、当天关闭、无结论 ⇒ 单条不足以支撑任何方向性结论

### B6. quidproquo.cc — CJK 混合检索中文召回实践（2026-08-26）**（正文未取到，仅存目）**
- **类型**：【社区】技术文（英文 + 中文两版）
- **URL（EN）**：https://quidproquo.cc/posts/tech/2026-08-26-d1-fts5-hybrid-search-cjk-recall-en/
- **URL（ZH）**：https://quidproquo.cc/posts/tech/2026-08-26-d1-fts5-hybrid-search-cjk-recall/
- **日期**：**2026-08-26**
- **标题摘录**：EN「When Search Returns Only 10 Results: Fixing CJK Recall in Cloudflare D1 FTS5 Hybrid Search」；ZH「搜尋只回 10 筆的解法：Cloudflare D1 FTS5 與 Hybrid Search 中文召回實戰」
- **状态**：该站为客户端渲染，两次抓取（EN/ZH）均只返回标题，**正文与其中的数字一律未采信、未引用**
- **用在**：capabilities §4.2 末尾「线索」、§7 U9、§8 第 11 项（待用浏览器补读）

---

## C. 检索过程中被判为「不可用作证据」的材料（存档备查）

| 材料 | URL | 为什么不用 |
| --- | --- | --- |
| Claude 技能/参考文档合集的 D1 章节（如 jezweb/claude-skills、secondsky/claude-skills 里的 limits.md） | https://github.com/jezweb/claude-skills/blob/…/d1-specifics.md ；https://github.com/secondsky/claude-skills/blob/…/limits.md | 二手转述官方文档，无原始出处链；本调研直接取官方页面 |
| mastra 文档里的 Cloudflare D1 集成页 | https://github.com/mastra-ai/mastra/blob/…/cloudflare-d1.mdx | 讲 ORM 接法，与 FTS5/限额无关 |
| dev.to「Cloudflare D1: SQLite at the Edge After 6 Months in Production」 | https://dev.to/whoffagents/cloudflare-d1-sqlite-at-the-edge-after-6-months-in-production-551j | 只有泛化的运维体感，无 FTS5 与可核验数字 |
| 各类「D1 limits」第三方速查表 | 同上 | 数字必须回官方 A3/A4 核对，避免过期 |

---

## D. 复核本文件的方法

1. 官方数字类结论 → 全部回 **A3 / A4** 两页重读（它们是唯一权威口径，且带「Last updated」日期）。
2. FTS5 是否可用 → **A1 + A2** 两处明文（同一结论两处独立出现，是本调研最硬的支撑）。
3. 中文/分词行为 → **A11**（FTS5 语义定义）+ **A15**（Cloudflare 对 CJK 的官方结论）。
4. 社区实测 → **B1 / B2 / B4**（都有可复现代码或生产事故描述）；**B5 只能当反例读，B6 未取到正文不可引**。
5. 有争议或未证实项 → 一律落到 capabilities.md §7 与 §8，不在正文写死。
