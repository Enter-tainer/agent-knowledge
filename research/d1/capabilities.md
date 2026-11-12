# D1 能不能做中文全文检索：能力、代价与硬限额

- 调研对象：Cloudflare D1（TECH-69：R2 存 md + D1 存索引，检索需「中文关键词 + 代码标识符命中 + 相关度排序」，尽量只用 D1）
- 调研日期：**2026-11-12**（所有 URL 均于该日访问；「最后更新」为页面自报日期）
- 证据标注：**【官方】** = Cloudflare 官方文档 / 官方代码仓库 / 官方 changelog；**【社区】** = 第三方实测、GitHub issue、个人博客
- 本文所有「支持 / 不支持」后面都紧跟出处；查不到的一律写「未证实，需账号实测」，**不把「D1 用 SQLite 所以应该支持 FTS5」当结论**

---

## 0. 一句话结论表

| 问题 | 一句话结论 | 证据强度 |
| --- | --- | --- |
| 生产 D1 能建 FTS5 虚表吗？ | **能。**官方文档明确把 FTS5 列为 D1 支持的 SQLite 扩展（含 `fts5vocab`）；社区有生产环境跑通的建表 + 触发器 + MATCH 代码 | 官方明文 + 社区实测（双向确认） |
| 有哪些 tokenizer？ | 默认 `unicode61`、`trigram` 已被实测跑通；`porter` / `ascii` 在 **D1** 上未证实（只在 DO SQLite 见到官方用法） | 半证实 |
| external content（`content='表名'`）+ trigger 维护？ | **能。**社区生产代码用 `content='myTable'` + INSERT/UPDATE/DELETE 三触发器；官方文档未写这一层 | 社区实测 |
| `bm25()` / `rank` 排序？ | **能。**workerd 官方源码把 `bm25`/`match`/`snippet`/`highlight` 列入允许函数；社区生产用 `bm25()` 排序 | 官方源码 + 社区 |
| `snippet()` / `highlight()` 在 D1 上？ | 函数在 workerd 白名单里，但**没有找到任何 D1 生产实测**，且 external-content 模式下 snippet 需要能回读原文 | 未证实 |
| 中文能直接命中吗？ | **默认不能。**`unicode61` 把连续汉字当一个 token；`trigram` 能子串匹配但**少于 3 个字符的查询不命中**（「知识」「检索」这类 2 字词失效）。必须写入时预分词或双索引 | 官方（FTS5/AI Search）+ 社区 |
| 代码标识符能命中吗？ | 需自己把标识符拆成 token（`_`/`.`/camelCase 拆分）或用 trigram（≥3 字符子串可命中，`getUserById` 能搜 `UserBy`） | 推断（FTS5 语义 + 社区 trigram 用法） |
| 有硬限额卡死这个场景吗？ | 有。**单行/单字符串 2 MB**、**SQL 语句 100 KB**、**绑定参数 100**、**查询结果 50 MB**、**LIKE/GLOB 模式 50 字节**、**free 每日 5M 读 / 100k 写**、**付费单库 10 GB 不可再提** | 官方明文 |
| FTS5 索引会怎么影响备份/导出？ | **有坑：**D1 的 export 明确不支持含虚表的库，必须先删虚表再导 | 官方明文 |
| 只靠 D1 够不够？ | 关键词 + 排序够用（FTS5 BM25）；**语义/同义/近义检索不够**，要补 Workers AI + Vectorize 或改用 AI Search | 结论性判断 |
| Agent 能直接调 D1 吗？ | 能。有官方 REST：`POST /accounts/{id}/d1/database/{db_id}/query`，用 API Token（`D1 Read`/`D1 Write`）鉴权；**Cloudflare Access service token 是另一套东西，用来保护你自己的域名/Worker**，不用于 api.cloudflare.com | 官方明文 |

> ⚠️ 一句话总纲：**D1 的 FTS5 是「真的能用」的，不是传说；但它不是「开箱即用的中文搜索」，中文和代码标识符都需要你在写入侧做分词设计，而且 2 MB 行 / 100 KB 语句 / 50 字节 LIKE 这几条限额会直接决定你的 schema 怎么切。**

---

## 1. D1 对 FTS5 的支持现状

### 1.1 结论

1. **生产 D1 支持 `CREATE VIRTUAL TABLE ... USING fts5(...)`**，并且官方把 FTS5 写进了「D1 支持的 SQLite 扩展」清单（含 `fts5vocab`）。
2. **不是「靠 SQLite 推断」**——官方文档有两处独立明文（扩展清单 + 导入导出限制说明），官方 workerd 源码还给了 FTS5 专用函数白名单；社区有 2024 与 2026 两次生产实测。
3. **官方文档只写到「支持 FTS5 模块」为止**：没有 tokenizer 清单、没有 external content 示例、没有 trigger 示例、没有 bm25/snippet 用法。这部分只能靠 FTS5 本身语义 + 社区实测补。

### 1.2 证据（按「官方向 / 社区向」分开）

**【官方｜扩展清单】**
> "D1 supports a subset of SQLite extensions for added functionality, including:
> - **FTS5 module** for full-text search (including `fts5vocab`).
> - JSON extension for JSON functions and operators.
> - Math functions."
>
> —— Cloudflare D1 docs, *SQL statements*，页面自报「Last updated Apr 21, 2026」
> URL: https://developers.cloudflare.com/d1/sql-api/sql-statements/ （访问 2026-11-12）

**【官方｜导出限制里的第二处明文】**
> "Export is not supported for virtual tables, including databases with virtual tables. **D1 supports virtual tables for full-text search using SQLite's FTS5 module.** As a workaround, delete any virtual tables, export, and then recreate virtual tables."
>
> —— Cloudflare D1 docs, *Import and export data → Known limitations*
> URL: https://developers.cloudflare.com/d1/best-practices/import-export-data/ （访问 2026-11-12）

这条同时是一个**运维硬约束**：库里有 FTS5 虚表时 `wrangler d1 export` 直接不可用（Time Travel 之外的逻辑备份路径被堵）。建库设计时就要接受「导出前先 DROP 虚表」。

**【官方｜workerd 源码，FTS5 辅助函数在允许列表里】**
> ```cpp
>   // https://www.sqlite.org/fts5.html
>   "match"_kj,
>   "highlight"_kj,
>   "bm25"_kj,
>   "snippet"_kj,
> ```
>
> —— cloudflare/workerd, `src/workerd/util/sqlite.c++`（`ALLOWED_SQLITE_FUNCTIONS`）
> URL: https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B （访问 2026-11-12）

说明：`bm25` / `snippet` / `highlight` / `match` 都是被官方运行时**显式允许**的，不是被过滤掉的。注意这是 workerd（本地 wrangler dev、Durable Objects、Workers 运行时）的白名单，「生产 D1 的服务端引擎」是否同源，官方没有明说——但下面社区实测证明 `bm25` 在生产 D1 可用。

**【社区｜生产环境建 FTS5 虚表 + trigram + external content + 三触发器（2024-04-14）】**

日本开发者把 FTS5 加到**生产** D1（`wrangler d1 execute myTable --file=.\db.sql`，不带 `--local`）的完整 DDL：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS myTableFTS USING fts5(
    title,
    memo,
    content='myTable',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS fts_insert AFTER INSERT ON myTable
BEGIN
    INSERT INTO myTableFTS (title, memo) VALUES (new.title, new.memo);
END;
```

并在 Worker 里直接 `MATCH` 查询（日文查询词 `'ほげほげ AND ふがふが'`）。

> 「期待した結果が得られたら本番環境に適用する。」（确认结果符合预期后再应用到生产环境）
> `wrangler d1 execute myTable --file=.\db.sql`

—— zenn.dev / Polonity, *cloudflare D1で fts5 モジュールを使って全文検索してみる*，2024-04-14
URL: https://zenn.dev/polonity/scraps/8c0d27775353b7 （访问 2026-11-12）

这一段同时回答了 4 个子问题：**虚表能建在远程/生产库**、**`tokenize='trigram'` 可用**、**`content='表名'` external content 可用**、**trigger 维护可用**。而且是 CJK（日文）实际查询。

**【社区｜2026 年生产数据：FTS5 默认开启、BM25 排序、external content 陷阱】**

> "**FTS5 is shipped enabled in D1, no opt-in required**, so the migration looked straightforward. It wasn't."
> "The `bm25()` relevance score in FTS5 returns a _negative_ float. Lower means more relevant. I ordered results `DESC` for three days…"
> "FTS5's default `unicode61` tokenizer splits on whitespace and punctuation."
> "`content='kw_master'` means FTS5 stores only the index, not the raw text — good for space, bad if you forget that inserts, updates, and deletes on `kw_master` don't automatically propagate. You need triggers, or the index silently drifts."
> "P50 latency at 390K rows after six weeks: **22ms**. P95: **under 45ms**."

—— dev.to / riversea（강해수）, *FTS5 on Cloudflare D1 cut my Korean keyword search from 220ms to 22ms*，2026-06-24
URL: https://dev.to/riversea/fts5-on-cloudflare-d1-cut-my-korean-keyword-search-from-220ms-to-22ms-heres-what-almost-broke-it-3l9p （访问 2026-11-12）

性能参照：**39 万关键词、约 12 个生产 Worker，P50 22 ms / P95 < 45 ms**（对比 `LIKE '%xx%'` 的 180–220 ms）。这是目前看到最具体的 D1 FTS5 生产延迟数据。

**【社区｜FTS5 索引被写坏的实战事故（触发器顺序错 → `SQLITE_CORRUPT_VTAB`）】**

> "`SQLITE_CORRUPT_VTAB` — FTS5 full-text search virtual table corruption on write operations"
> "Step 2 is the bug: the FTS5 `DELETE` triggers a read of the current row to update its index. By the time it runs, the `UPDATE` has already changed the row. … Over time, repeated saves desynchronize the FTS index from the main table until SQLite detects the inconsistency and raises `SQLITE_CORRUPT_VTAB`."
> 「修法：batch 内顺序必须是 DELETE FROM fts → UPDATE 主表 → INSERT INTO fts；并加了三级降级：FTS 查询 → 自动 rebuild → `LIKE` 兜底」

—— gkoreli/backlog-mcp, *ADR 0093 — D1 Production Hardening: FTS5 Resilience*，2026-04-03
URL: https://raw.githubusercontent.com/gkoreli/backlog-mcp/refs/heads/main/docs/adr/0093-d1-production-hardening.md （访问 2026-11-12）

这条对 TECH-69 直接可用：**trigger 维护 FTS5 时，同一批写入的顺序会决定索引是否腐坏**，而且腐坏是静默累积的。同时它给出「FTS 挂了用 LIKE 兜底」的工程模式。

**【社区｜反面材料，但要正确读：workers-sdk#7259】**

标题看起来像「D1 不支持 FTS5」，实际正文不是：

> 标题：`🐛 BUG: D1 attempting to create virtual fts5 table errors`
> 正文报错：`Could not route to /client/v4/accounts/<...>/d1/database/<...>/import, perhaps your object identifier is invalid? [code: 7003]`
> 正文自述：`It does work when running on local.`
> 状态：`state: closed`，`created_at: 2024-11-14T15:14:59Z`，`closed_at: 2024-11-14T17:35:38Z`，`comments: 0`

—— GitHub, cloudflare/workers-sdk **Issue #7259**
URL: https://github.com/cloudflare/workers-sdk/issues/7259 （访问 2026-11-12）

**判读：**失败点是 `--remote --file=...` 走 `/import` 端点时的路由/导入错误（code 7003），不是 FTS5 语法被拒；本地能过、远程在导入通道上失败，且当天关闭、无任何官方回复。**因此这条不能作为「D1 不支持 FTS5」的证据**，只能作为「2024-11 时用 `--file` 导入含虚表的 schema 曾踩到导入通道问题」的旁证。要复现/排除，见 §9 实测清单第 3 项。

### 1.3 逐项特性表（严格按证据分级）

| 特性 | 结论 | 依据 |
| --- | --- | --- |
| `CREATE VIRTUAL TABLE ... USING fts5` | 支持 | 【官方】docs 扩展清单；【社区】zenn 生产 + dev.to 生产 |
| `fts5vocab` | 支持（官方列举为 FTS5 的一部分） | 【官方】docs：「including `fts5vocab`」 |
| 默认 `unicode61` | 支持 | 【社区】dev.to 明确写 "default `unicode61` tokenizer"；FTS5 官方语义同 |
| `trigram` | 支持 | 【社区】zenn 直接 `tokenize='trigram'` 用于生产日文站 |
| `porter` | 在 **D1** 未证实 | 只见于 Cloudflare `agents` 仓库的 **DO SQLite** FTS5（§5.5）；D1 侧无实测 |
| `ascii` | 未证实 | 无任何 D1 侧材料 |
| `content='表名'`（external content） | 支持 | 【社区】zenn + dev.to 均用于生产 |
| `content=''`（contentless） | 未证实 | 无 D1 侧材料（只有 ADR 提到 `content=''` 概念但用的是普通表） |
| trigger 维护（INSERT/UPDATE/DELETE） | 支持，但有腐坏风险 | 【社区】zenn（三触发器）+ ADR 0093（顺序错→CORRUPT_VTAB） |
| `bm25()` / `rank` 排序 | 支持 | 【官方】workerd 白名单；【社区】dev.to 生产用 `bm25()` |
| `snippet()` | **未证实** | 函数在 workerd 白名单，但无 D1 生产实测；external content 下取原文需回表 |
| `highlight()` | **未证实** | 同上 |
| `MATCH` 在 Worker 里直接查 | 支持 | 【社区】zenn（Worker 内 `MATCH`）+ dev.to |
| 含虚表的库 `d1 export` | **不支持**，需先 DROP 虚表 | 【官方】docs 明文 |
| FTS5 写入是否额外计 `rows_written` | 未证实（见 §9 第 5 项） | 官方计费文档只讲表/索引，未提虚表 |

---

## 2. D1 的 SQLite 版本 与「不支持 / 受限」清单

### 2.1 结论

1. **D1 的 SQLite 版本号官方没有公布，也没有任何文档/博客给出。** 更关键的是：**你在 D1 里也查不到**——`sqlite_version()` / `sqlite_source_id()` / `sqlite_compileoption_get()` 被 workerd 显式注释掉、不注册。
2. **因此「用某个 SQLite 特性前先确认版本」这条路在 D1 上不通**，只能「拿目标语法直接试」，或用 §9 的实测脚本验。
3. PRAGMA 是**白名单制**：官方文档列了「Compatible PRAGMA statements」清单，workerd 源码里有一份 `ALLOWED_PRAGMAS`；清单外的 PRAGMA 不要指望。
4. 官方**没有**一份「D1 不支持清单」页面。能确认的「不支持」只有零散几处明文（虚表导出、`PRAGMA optimize(-1)`、REST 无 Sessions、无 ATTACH 文档），其余只能写「未证实」。

### 2.2 证据

**【官方｜版本号被故意藏起来】**
> ```cpp
>   // These functions query SQLite internals and build details in a way we'd prefer not to reveal.
>   // "sqlite_compileoption_get"_kj,
>   // "sqlite_compileoption_used"_kj,
>   // "sqlite_offset"_kj,
>   // "sqlite_source_id"_kj,
>   // "sqlite_version"_kj,
> ```
>
> —— cloudflare/workerd, `src/workerd/util/sqlite.c++`（`ALLOWED_SQLITE_FUNCTIONS`）
> URL: https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B （访问 2026-11-12）

也就是说：`SELECT sqlite_version()` 这类探测在 workerd 系运行时里是**被设计性地挡掉**的。生产 D1 是否同样挡，未证实；但官方既没公开版本、又（在运行时层）屏蔽探测函数，**「D1 的 SQLite 版本」应记为不可知项**。

**【官方｜PRAGMA 白名单】**
> 文档只列这些 PRAGMA 为 "Compatible PRAGMA statements"：`table_list`、`table_info`、`table_xinfo`、`index_list`、`index_info`、`index_xinfo`、`quick_check`、`foreign_key_check`、`foreign_key_list`、`case_sensitive_like`、`ignore_check_constraints`、`legacy_alter_table`、`recursive_triggers`、`reverse_unordered_selects`、`foreign_keys`、`defer_foreign_keys`、`optimize`
> 并注明：「Currently, D1 does not support `PRAGMA optimize(-1)`」「D1 PRAGMA statements only apply to the current transaction.」
>
> —— Cloudflare D1 docs, *SQL statements*，Last updated Apr 21, 2026
> URL: https://developers.cloudflare.com/d1/sql-api/sql-statements/ （访问 2026-11-12）

**【官方｜其它零星限制】**
- `wrangler d1 export`：含虚表不支持（§1.2 已引）。
- Sessions API（read replication）**只能走 Worker binding，REST 不可用**：
  > "Sessions API is only available via the D1 Worker Binding and not yet available via the REST API."
  > —— https://developers.cloudflare.com/d1/best-practices/read-replication/ （访问 2026-11-12）
- 导入时不能自带事务：
  > "If you receive a `"cannot start a transaction within a transaction"` error, make sure you have removed `BEGIN TRANSACTION` and `COMMIT` from your dumped SQL statements."
  > —— https://developers.cloudflare.com/d1/best-practices/import-export-data/ （访问 2026-11-12）
- 保留表 `_cf_KV`：
  > "The `_cf_KV` table is a reserved table used by D1's underlying storage system. It cannot be queried…"
  > —— 同上

**【未证实项｜ATTACH DATABASE】**
对整个 D1 文档集（`https://developers.cloudflare.com/d1/llms-full.txt`，Last updated Oct 30, 2026，当天抓取全文检索）搜 `ATTACH` **零命中**：官方既没说支持，也没说不支持。历史上社区普遍认为不支持，但**本次调研没有找到任何官方或可靠社区出处**，因此记为「未证实，需账号实测」，不做结论。

---

## 3. 硬限额（精确数字 + 计量口径）

来源：**Cloudflare D1 docs → Limits**，页面自报 `Last updated Oct 30, 2026`
URL: https://developers.cloudflare.com/d1/platform/limits/ （访问 2026-11-12）

### 3.1 结构性 / 尺寸限额

| Feature | Limit | 计量口径 |
| --- | --- | --- |
| 每账号数据库数 | Workers Paid **1,000,000**（前 100,000 含；超出 $0.10/库/月）；Free **10** | 每账号 |
| 单库最大体积 | **10 GB**（Paid）/ **500 MB**（Free）；原文「Note that the 10 GB limit of a D1 database cannot be further increased」 | 每库 |
| 每账号存储 | **1 TB**（Paid，可申请提升）/ **5 GB**（Free） | 每账号 |
| Time Travel（时间点恢复） | **30 天**（Paid）/ **7 天**（Free）；**10 次 restore / 10 分钟 / 库** | 每库 |
| 单表列数 | **100** | 每表 |
| 单表行数 | 不限（受库体积约束） | — |
| **单字符串 / `BLOB` / 单行大小** | **2,000,000 bytes（2 MB）** | 每行 |
| **SQL 语句长度** | **100,000 bytes（100 KB）** | 每条语句 |
| **绑定参数个数** | **100** | 每查询 |
| SQL 函数参数个数 | **32** | 每次调用 |
| **`LIKE` / `GLOB` 模式长度** | **50 bytes** | 每个 pattern |
| 每 Worker 脚本可绑定的 D1 数 | 约 **5,000**（脚本元数据 1 MB，每个 resource binding ≈150 B） | 每脚本 |
| **单次 SQL 查询时长** | **30 秒**；脚注：「Requests to Cloudflare API must resolve in 30 seconds. Therefore, this duration limit also applies to the entire batch call.」 | 每查询 / 每 batch |
| `d1 execute` 单文件导入 | **5 GB** | 每次导入 |
| **查询结果大小** | **50 MB**，且脚注「This limit takes effect on **2026-11-04**」（今天 2026-11-12，**已生效**） | 每查询 |
| 每 Worker invocation 的查询数 | **1000**（Paid）/ **50**（Free）；**`batch()` 整体算 1 次** | 每次调用 |
| 每 invocation 同时连接数 | **6** | 每次调用 |

**Batch 的语义（很关键，决定你能否用触发器保证 FTS 一致性）：**
> "Batched statements are **SQL transactions**. If a statement in the sequence fails, then an error is returned for that specific statement, and it **aborts or rolls back the entire sequence**."
> "The Queries per Worker invocation limit is an exception: a `db.batch()` call counts as a single query against it…"
>
> —— https://developers.cloudflare.com/d1/worker-api/d1-database/ （Last updated Jun 22, 2026，访问 2026-11-12）；及 limits 页 Batch limits 段

**并发模型（决定吞吐上限）：**
> "Each individual D1 database is inherently single-threaded, and processes queries one at a time."
> "If your average query takes 1 ms, you can run at most 1,000 queries per second. If your average query takes 100 ms, you can run at most 10 queries per second."
> —— limits 页 FAQ（同上）

### 3.2 计费 / 额度（rows read / rows written / storage）

来源：**Cloudflare D1 docs → Pricing**，`Last updated Oct 30, 2026`
URL: https://developers.cloudflare.com/d1/platform/pricing/ （访问 2026-11-12）

| 计费项 | Workers Free | Workers Paid | 计量口径 |
| --- | --- | --- | --- |
| Rows read | **5,000,000 / 天** | 前 **25,000,000,000 / 月**含，超出 **$0.001 / 百万行** | 每账号 |
| Rows written | **100,000 / 天** | 前 **50,000,000 / 月**含，超出 **$1.00 / 百万行** | 每账号 |
| Storage | **5 GB（总量）** | 前 5 GB 含，超出 **$0.75 / GB-月** | 每账号 |
| Databases | 10 | 前 100,000 含，超出 **$0.10 / 库/月** | 每账号 |

关键计费细节（同一页）：
> "**A row that is 1 KB and a row that is 100 KB both count as one row.**"（行大小不影响行数计费 → 大 JSON 行不额外贵，但会撞 2 MB 行上限）
> "**Indexes will add an additional written row** when writes include the indexed column, as there are two rows written: one to the table itself, and one to the index."（→ FTS5 虚表的额外写入计费方式未说明，见 §9 第 5 项）
> Free 每日额度「reset at 00:00 UTC」；免费额度自 **2025-02-10** 起强制生效（release notes 2025-01-13 条）。

### 3.3 Read replication（读扩展）

- 2025-04-10 进入 public beta；**副本自动创建、无额外费用**，按 `rows_read`/`rows_written` 照常计费。
- 一致性：Sessions API 提供 **sequential consistency**（并非强一致）；**REST 不支持 Sessions**（§2.2）。
- 源：https://developers.cloudflare.com/d1/best-practices/read-replication/ ；release notes https://developers.cloudflare.com/d1/platform/release-notes/ （访问 2026-11-12）

### 3.4 这些限额对本项目的直接含义（推导，非官方结论）

1. **2 MB/行** ⇒ md 正文**不要进 D1**（现状 R2 存原文是对的）；进 FTS5 的只是「可检索文本」，单条 chunk 建议 ≤ 数百 KB，且注意**同一行内多列合计也受 2 MB 限制**。
2. **100 KB/SQL 语句** ⇒ 批量灌数据时单条 `INSERT ... VALUES (...),(...)` 不能过大；导入大 dump 会撞 `Statement too long`（官方 troubleshooting 有专段）。
3. **100 个绑定参数** ⇒ 一次 `IN (?,?,...)` 最多 100 项；分页/批量要分批。
4. **`LIKE`/`GLOB` 模式 50 bytes** ⇒ 中文兜底 LIKE 只能拼约 16 个汉字；代码标识符兜底（长路径、长函数名）很容易超 50 B。**这条让「LIKE 兜底」在中文/长标识符场景非常不可靠。**
5. **50 MB/查询结果** ⇒ 检索接口必须 `LIMIT`，不要把整篇 md 塞进结果。
6. **30 s/查询 + 单库单线程** ⇒ FTS5 大索引上的 `ORDER BY bm25()` 是串行的；39 万词规模实测 P95 <45 ms（§1.2），可用；百万级要自己压测。
7. **Free 5M 读/天** ⇒ 按「一次检索扫 N 行 FTS 索引」估算，免费额度只够低频自用；生产建议直接 Workers Paid（$5/月起）。

---

## 4. 中文全文检索在 D1 上的可行路径

### 4.1 结论

1. **`unicode61`（默认）对中文是「整段连续汉字 = 1 个 token」。** 因为它的分隔符只有空格与标点，汉字属于「L*」类 → 是 token 字符。所以**不做处理时，搜「知识」命中不了「知识库检索系统」这句话中间的「知识」**（整句是一个 token）。
2. **`trigram` 能做中文子串匹配，但有硬底线：少于 3 个字符的查询不命中。** 中文双字词（「知识」「检索」「部署」）刚好踩死。
3. **因此「直接用 D1 FTS5 做中文关键词」不成立；可行的是「写入侧预分词 + unicode61」或「trigram + 限制最短词长 ≥3 字」。** 两者都要写代码，没有零成本方案。
4. 代码标识符（`getUserById`、`D1_DATABASE_ID`、`workers-sdk`）同理：unicode61 会把整串当一个 token，需自行拆分；trigram 可做 ≥3 字符子串命中。
5. **Cloudflare 自己在 AI Search 里对 CJK 的官方结论是「换 trigram，且 3 字以下不行」**——这既是最强旁证，也说明这是平台级共识而非 D1 特例。

### 4.2 证据

**【官方｜FTS5 的 unicode61 到底怎么切】**
> "The unicode tokenizer classifies all unicode characters as either "separator" or "token" characters. By default all space and punctuation characters, as defined by Unicode 6.1, are considered separators, and all other characters as token characters. More specifically, all unicode characters assigned to a general category beginning with "L" or "N" (letters and numbers, specifically) or to category "Co" ("other, private use") are considered tokens. All other characters are separators."
>
> —— SQLite, *FTS5 Extension* §4.3.1 Unicode61 Tokenizer
> URL: https://www.sqlite.org/fts5.html （访问 2026-11-12）

汉字属 `L*` → 是 token 字符、不是分隔符 ⇒ 连续汉字串 = 一个 token（除非你插入空格或依赖别的分隔符）。**这就是「中文整段一个 token」的原文依据。**

**【官方｜trigram 的能力边界】**
> "The trigram tokenizer extends FTS5 to support substring matching in general, instead of the usual token matching."
> "Substrings consisting of **fewer than 3 unicode characters do not match any rows** when used with a full-text query."
>
> —— SQLite, *FTS5 Extension* §4.3.4 The Trigram Tokenizer
> URL: https://www.sqlite.org/fts5.html （访问 2026-11-12）

**【官方｜AI Search 对 CJK 的结论（旁证：平台层同样承认 CJK 分词失败）】**
> "The `porter` tokenizer splits text on spaces and punctuation, so it does not work well for Japanese, Chinese, or Korean. Japanese and Chinese do not separate words with spaces, and Korean attaches particles to words. Keyword search with `porter` may return no results for queries in these languages."
> "If your content is in Japanese, Chinese, or Korean, use the `trigram` tokenizer. With `trigram`, keyword search matches these queries… **Words shorter than three characters cannot be matched on their own.**"
>
> —— Cloudflare AI Search docs, *Keyword search*（Last updated Oct 16, 2026）
> URL: https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/ （访问 2026-11-12）

同结论的官方 changelog：
> "AI Search keyword search with the `trigram` tokenizer now matches Japanese, Chinese, and Korean queries… Previously, a query without spaces was treated as a single exact phrase and usually returned no keyword results."
> —— https://developers.cloudflare.com/changelog/post/2026-10-16-cjk-keyword-search/ ，2026-10-16（访问 2026-11-12）

**【社区｜韩文实测：unicode61 的召回衰减】**
> "FTS5's default `unicode61` tokenizer splits on whitespace and punctuation. Korean doesn't use spaces between morphemes consistently… By week 3 at 180K rows I was measuring **88% recall** on a hand-verified 500-row golden set, down from **91% at 40K rows**."
> 缓解：「query-side：splitting user input and joining tokens with `OR` before passing to `MATCH`」
> ```js
> const ftsQuery = query.trim().split(/\s+/).join(' OR ');
> ```
>
> —— dev.to / riversea，2026-06-24（URL 见 §1.2）

日文（同样是 CJK、同样无空格分词）在 D1 上用 trigram 跑通的生产代码：见 §1.2 zenn 一文。

**【社区｜中文/混合检索的专项文章（只能引标题，正文未取到）】**
- *When Search Returns Only 10 Results: Fixing CJK Recall in Cloudflare D1 FTS5 Hybrid Search*，2026-08-26
  URL: https://quidproquo.cc/posts/tech/2026-08-26-d1-fts5-hybrid-search-cjk-recall-en/
- 中文版：*搜尋只回 10 筆的解法：Cloudflare D1 FTS5 與 Hybrid Search 中文召回實戰*
  URL: https://quidproquo.cc/posts/tech/2026-08-26-d1-fts5-hybrid-search-cjk-recall/

**说明：该站是客户端渲染，两次抓取都只拿到标题、拿不到正文。**因此只能作为「存在一篇中文 D1 FTS5 召回实践」的线索，**其具体数字/方案不采信、不引用**。已在 §9 列为待读项。

### 4.3 三条可选技术路线（含代价，均为本文推导）

| 路线 | 做法 | 中文 2 字词 | 代码标识符 | 代价 / 风险 |
| --- | --- | --- | --- | --- |
| **A. 写入侧预分词 + `unicode61`** | 写入前用分词器（中文用 jieba/结巴类；标识符按 `_ . / -` 与 camelCase 切）把文本变成「空格分隔的 token 串」再入 FTS5 | ✅（分词器切出「知识」「检索」即可命中） | ✅（切 `getUserById` → `get user by id`） | 分词器要在 Worker 里跑（CPU 10 ms free / 30 s 默认 paid）；分词结果与查询侧必须同一套规则，否则召回错位；索引体积变大 |
| **B. `trigram`** | `tokenize='trigram'`，原样索引 | ❌ 2 字词不命中（<3 字符） | ✅ ≥3 字符子串可命中（`UserBy`、`DATABASE`） | 索引明显更大；`LIKE`/`GLOB` 也可走索引但「少于 3 字符」同样受限 |
| **C. 双索引（A+B 或 A+向量）** | 两张 FTS5 表：`fts_word`（预分词）+ `fts_tri`（trigram）；查询按词长路由，或用 `bm25` 融合 | ✅ | ✅ | 两倍索引体积与写入成本；查询逻辑变复杂（这正是 quidproquo 那篇 hybrid 文章处理的问题） |

**推荐（对 TECH-69）：A 为主 + B 兜底。**理由：
- 「中文关键词」以 2–4 字词为主 → A（预分词）是唯一能保证 2 字词命中的；
- 「代码标识符」往往是未知边界的长串 → B（trigram）对 ≥3 字符子串天然友好，不需要猜切分规则；
- 排序用 `bm25()`/`rank` 即可满足「相关度排序」，注意 **bm25 是负数、越小越相关**（§9 第 6 项：小值升序 = 最相关在前）。

---

## 5. 替代 / 补充检索方案与成本

> 只覆盖与本场景（私有 md 知识库、中文 + 代码标识符）相关的部分。

### 5.1 Workers AI 文本嵌入

| 模型 | 维度 | 输入 tokens（AI Search 口径） | 价格 | 备注 |
| --- | --- | --- | --- | --- |
| `@cf/baai/bge-m3` | **1024** | 512（AI Search 表）/ 模型页写 context 60,000 | **$0.012 / 百万 input tokens**（= 1075 neurons/M） | 多语言（中英混合首选）；cosine |
| `@cf/qwen/qwen3-embedding-0.6b` | 1024 | 8,192 | $0.012 / 百万 input tokens | AI Search 的默认嵌入模型 |
| `@cf/baai/bge-reranker-base` | — | 512 | $0.003 / 百万 input tokens | 重排（rerank） |
| `@cf/baai/bge-small/base/large-en-v1.5` | 384/768/1024 | 512 | $0.020 / $0.067 / $0.204 每百万 tokens | **纯英文**，中文场景不选 |

证据：
> "| @cf/baai/bge-m3 | $0.012 per M input tokens | 1075 neurons per M input tokens |"
> —— Cloudflare Workers AI docs, *Pricing*（Last updated Oct 20, 2026）
> URL: https://developers.cloudflare.com/workers-ai/platform/pricing/ （访问 2026-11-12）

> "| **Workers AI** | `@cf/baai/bge-m3` | **1,024** | 512 | No | No | cosine |"
> —— Cloudflare AI Search docs, *Supported models*（Last updated Oct 1, 2026）
> URL: https://developers.cloudflare.com/ai-search/configuration/models/supported-models/ （访问 2026-11-12）

> 免费额度：「Our free allocation allows anyone to use a total of **10,000 Neurons per day** at no charge」；超出按 **$0.011 / 1,000 Neurons**。
> —— 同上 pricing 页

**成本量级估算（推导）：**一个 2,000 万 token 的私人 md 库全量嵌入一次 ≈ 20M × $0.012/M ≈ **$0.24**；每次查询嵌入 ≈ 几十 token，可忽略。**嵌入本身很便宜，贵的是向量存储与查询维度。**

### 5.2 Vectorize

| 项 | 限额 / 价格 | 来源 |
| --- | --- | --- |
| 每向量最大维度 | **1536 维，32 bit float** | limits 页 |
| 每索引最大向量数 | **20,000,000** | limits 页 |
| 每向量 metadata | **10 KiB** | limits 页 |
| 返回条数 `topK` | **50**（带 values/metadata）/ **100**（不带） | limits 页 |
| 单次 upsert 批量 | 1000（Workers）/ 5000（HTTP API） | limits 页 |
| 索引数 | Free **100**；Paid 前 **50,000** 含，超出 $0.10/月 | pricing 页 |
| Queried vector dims | Free **30M / 月**；Paid 前 **50M / 月**含，超出 **$0.01/百万** | pricing 页 |
| Stored vector dims | Free **5M**；Paid 前 **10M** 含，超出 **$0.05 / 亿** | pricing 页 |

证据：https://developers.cloudflare.com/vectorize/platform/limits/ （Last updated Oct 30, 2026）与 https://developers.cloudflare.com/vectorize/platform/pricing/ （Last updated Oct 30, 2026），访问 2026-11-12。

官方给的成本样例（同一 pricing 页）：「Production：768 维、5 万向量、20 万次查询/月 ≈ **$1.94/月**」。

**对本项目的量级（推导）：**5 万个 chunk × 1024 维 = 5,120 万 stored dims → 超出 Paid 含的 10M，按 $0.05/亿计 ≈ **$0.03/月**；查询维度是大头（每次查询 `(向量数 + 1) × 1024` 计入 queried dims），5 万向量下一次查询就 5,120 万 dims → **一次查询就超过 Paid 月度 50M 含额**。这是 Vectorize 计费最反直觉的地方，**私有小库也建议先按「向量数 × 1024 × 查询次数」估一遍**。

### 5.3 Cloudflare AI Search（原 AutoRAG）

**能直接吃 R2**，且原生支持 md：

> "| [R2 Bucket](https://developers.cloudflare.com/ai-search/configuration/data-source/r2/) | Connect a Cloudflare R2 bucket to index stored documents. |"
> 支持类型含：`Markdown | .markdown, .md, .mdx, .mdoc`
> —— Cloudflare AI Search docs, *Data source*（Last updated Oct 1, 2026）
> URL: https://developers.cloudflare.com/ai-search/configuration/data-source/ （访问 2026-11-12）

限额与价格（**Last updated Nov 2, 2026**，https://developers.cloudflare.com/ai-search/platform/limits-pricing/ ）：

| 项 | Free | Paid |
| --- | --- | --- |
| 实例数/账号 | 100 | 前 5,000 含，超出 $0.10/月 |
| 每实例文件数 | 100,000 | 1M（开 hybrid search 则 **500K**） |
| 单文件（纯文本/代码） | 10 MiB | 10 MiB |
| 每月含 | — | **5M ingestion tokens + 10 GB-月 + 1,000 semantic queries + 1,000 full-text queries** |
| 超出计价 | — | ingestion **$0.75 / 百万 tokens**；storage **$2.00 / GB-月**；semantic/vector/hybrid **$0.75 / 1,000 次**；full-text **$0.10 / 1,000 次** |

> 「AI Search billing begins on **December 1, 2026**.」（同页）
> 同步机制：「Jobs run automatically on a schedule, **every 24 hours by default**」，最小 15 分钟；可从 CI 触发（限 30 秒一次）。—— https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/ （Last updated Nov 2, 2026）

**对本项目的关键判断：**AI Search 现成的 `trigram` 关键词检索 + 向量混合，恰好覆盖「中文 + 标识符 + 相关性」；**但它索引的是自己解析后的 chunk（内置存储），不是你的 documents/links 表**，且 R2 源需要配 service API token。若接受「检索结果只回 chunk 文本 + 文件路径」，AI Search 是最省事的方案；若要「检索结果和你 D1 里的元数据/链接图强关联」，仍需自己写 FTS5 或把 AI Search 只当召回层。

### 5.4 R2 SQL

**不是文本检索引擎**，是面向 R2 Data Catalog 里 Apache Iceberg 表的分布式 SQL 分析引擎（open beta）：

> "R2 SQL is Cloudflare's serverless, distributed, **analytics query engine for querying Apache Iceberg tables** stored in R2 Data Catalog."
> "R2 SQL is in **open beta**… outside of standard R2 storage and operations, you will not be billed for your use of R2 SQL."
>
> —— Cloudflare R2 SQL docs, *R2 SQL* overview
> URL: https://raw.githubusercontent.com/cloudflare/cloudflare-docs/4955433c1695e05fe2c487e2e4bf2895de6777a2/src/content/docs/r2-sql/index.mdx （访问 2026-11-12；对应页面 https://developers.cloudflare.com/r2-sql/ ）

**结论：不适合。**它要求数据先在 Iceberg 表里（不是 md 文件），没有 FTS/BM25 语义，定位是 OLAP；把 md 塞进 Iceberg 再查询是绕远路。

### 5.5 Durable Objects 的 SQLite 是否支持 FTS5

**支持——而且是 Cloudflare 官方仓库自己在用。**

> "`AgentSearchProvider` is the built-in implementation using **Durable Object SQLite with FTS5 full-text search**."
> "**Searching** — the model calls `search_context("knowledge", { query: "deployment" })`… Uses **FTS5 with porter stemming** and implicit AND for multi-word queries."
> "Content is stored in two SQLite tables within the Durable Object:
> - `cf_agents_search_entries` — the actual content (label, key, content, timestamps)
> - `cf_agents_search_fts` — **FTS5 virtual table** for full-text search"
>
> —— cloudflare/agents（官方仓库），`experimental/session-search/README.md`
> URL: https://raw.githubusercontent.com/cloudflare/agents/f9c68e8d04184939714578e70cf1bfa739ae8840/experimental/session-search/README.md （访问 2026-11-12）

注意两点：①这是 **experimental**（README 自述「this API will break between releases」）；②它证明 `porter` 在 **DO SQLite** 可用，**不等于 D1 可用**（§1.3 的 `porter` 行仍记为未证实）。

DO SQLite 的限额（比 D1 宽松，是重要备选理由）：
> "Maximum string, `BLOB` or **table row size: 8 MB**"; "Maximum SQL statement length: 100 KB"; "Maximum bound parameters per query: 100"; "Storage per Durable Object: **10 GB**"
> —— Cloudflare Durable Objects docs, *Limits*（Last updated Nov 7, 2026）
> URL: https://developers.cloudflare.com/durable-objects/platform/limits/ （访问 2026-11-12）

**结论：DO SQLite 是「能跑 FTS5 且行上限 8 MB（D1 的 4 倍）」的备选**，代价是要自己设计分片（一个 DO = 一个单线程 SQLite），并且计费模型从「行数」变成 DO 的请求/时长/存储。若未来 md chunk 超过 2 MB 或想要 8 MB 空间，这是唯一「不离开 Cloudflare SQLite 生态」的升级路径。

---

## 6. Agent 访问方式

### 6.1 D1 的 HTTP API（REST）确实存在

**【官方】端点与鉴权：**
> `POST /accounts/{account_id}/d1/database/{database_id}/query`
> "Execute a SQL query against a D1 database and return results as objects."
> 鉴权：`Authorization: Bearer <API_TOKEN>`，可用权限 `D1 Read` / `D1 Write`
> Body：`{ "sql": "...", "params": ["...", "..."] }` 或 `{ "batch": [ {sql, params}, ... ] }`
> 响应含 `meta.rows_read` / `meta.rows_written` / `meta.duration` / `meta.served_by_region` 等
>
> —— Cloudflare API Reference, *Query D1 Database*
> URL: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/ （访问 2026-11-12）

示例（官方 curl）：
```sh
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DATABASE_ID/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -d '{"sql":"SELECT * FROM myTable WHERE field = ? OR field = ?;","params":["firstParam","secondParam"]}'
```

**一处需要注意的官方口径差异：**D1 文档的 *Query a database* 页说
> "REST API primarily interacts with the **control plane**, and allows you to create/manage your D1 database."
> —— https://developers.cloudflare.com/d1/best-practices/query-d1/ （Last updated Apr 21, 2026）

而 API Reference 明确记录了 `/query` 数据面端点并给出 curl。**以 API Reference 为准：数据面 REST 存在且可用**；那句「主要是控制面」是陈述侧重，不是「不支持查询」。

### 6.2 Agent 直接调用是否现实

**技术上现实，工程上不推荐把 D1 API Token 直接交给 agent。**理由（推导）：
- D1 的 API Token 是**账号级**权限（`D1 Read`/`D1 Write` 能覆盖账号下所有库），没有按库 scoped 的细粒度选项（API Reference 的权限模型只到 `D1 Read`/`D1 Write`）；
- REST 不能开 Sessions（§2.2），高并发读走不到 replica；
- 公开的 REST 端点意味着 token 泄露面 = 全库读写。

**推荐：Worker 作为唯一入口**（`/search`、`/doc/:id`），Worker 内部用 binding 访问 D1（`env.DB`），对外用 Cloudflare Access 保护。这样 agent 只拿到 Access service token，权限可撤销、可审计、可限流。

### 6.3 Cloudflare Access service token（给 Worker 做服务端鉴权的 header）

**【官方】两个 header：**
> "To authenticate to an Access application using your service token, add the following to the headers of any HTTP request:
> `CF-Access-Client-Id: <CLIENT_ID>`
> `CF-Access-Client-Secret: <CLIENT_SECRET>`"
>
> —— Cloudflare One docs, *Service tokens*（Last updated Nov 2, 2026）
> URL: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ （访问 2026-11-12）

其它要点（同页）：
- 策略动作必须是 **Service Auth**，否则 Access 会要求 IdP 登录：「Make sure to set the policy action to **Service Auth**; otherwise, Access will prompt for an identity provider login.」
- 可配**单 header** 模式（便于只能用 `Authorization` 的 SaaS）：
  > `read_service_tokens_from_header: "Authorization"`，然后
  > `curl -H "Authorization: {\"cf-access-client-id\": \"<CLIENT_ID>\", \"cf-access-client-secret\": \"<CLIENT_SECRET>\"}" https://app.example.com`
- **Strict service token authentication**：失败时返回 401/403 而不重定向登录页；**2026-10-05 之后新建的 Zero Trust 组织默认开启且不可关闭**。
- Client Secret 只在创建时显示一次；自 2026-08-26 起新 secret 格式为 `cfast_[40 位][8 位校验]`。
- 支持按 tag 授权（`service_token_tag`），可轮换（grace period 1 小时 ~ 30 天）。

**关键区分（避免误用）：**Cloudflare Access service token **不能**用来调 `api.cloudflare.com`（那是 Cloudflare API，用 API Token）；它是给「你自己挂在 Cloudflare 后面的域名/Worker」做机器身份认证的。→ 正确组合是：**agent →（`CF-Access-Client-Id`/`CF-Access-Client-Secret`）→ 你的 Worker →（D1 binding）→ D1**。

---

## 7. 不确定性（本节即「没查到 / 只有间接证据」的集中清单）

| # | 不确定项 | 目前掌握的最强旁证 | 影响 |
| --- | --- | --- | --- |
| U1 | **D1 生产库的 SQLite 版本号** | 官方不公布；workerd 把 `sqlite_version()` 等注释掉（§2.2）。只能按「特性是否可用」反推 | 无法预判新语法（如 `contentless_delete=1`、`locale=1`）是否可用 |
| U2 | **D1 上可用的 tokenizer 全集** | `unicode61`（dev.to 生产）、`trigram`（zenn 生产）；`porter`/`ascii` 在 **D1** 无任何实测 | 若想用 porter 做英文词干，需实测（DO 上可用，D1 未证） |
| U3 | **`snippet()` / `highlight()` 在 D1** | 函数在 workerd 白名单（官方源码），但无 D1 生产实例；external content 下 snippet 需回读原表 | 直接影响「返回高亮片段」这个体验；备选：自己按 offsets 截断 |
| U4 | **PRAGMA 白名单在生产 D1 是否与 workerd 一致** | 官方文档列了「Compatible PRAGMA」清单，但没给拒绝行为；workerd 的 `ALLOWED_PRAGMAS` 只是本地/DO | 依赖 `PRAGMA` 的迁移脚本可能在生产失败 |
| U5 | **`ATTACH DATABASE` 是否被支持** | 官方 d1 文档全文零命中「ATTACH」（§2.2），既无支持也无禁止声明 | 不能确认「一定不行」，但也不应依赖 |
| U6 | **batch 的最大语句条数** | 官方只给了「每条语句受单语句限额约束」「整批算 1 次查询」「整批共享 30 s」，**没有条数上限** | 大批量灌数据时要靠实测找边界 |
| U7 | **FTS5 虚表的写入是否额外计 `rows_written`** | 官方只说「建索引会多写 1 行」；虚表/触发器导致的写入如何计数未写 | 直接影响付费账单预估 |
| U8 | **FTS5 索引查询是否按 rows_read 计费、计多少** | 官方未写；FTS5 内部走 `%_idx`/`%_data` 影子表 | 同上 |
| U9 | **quidproquo 那篇中文 D1 FTS5 hybrid 文章的具体结论** | 只能拿到标题（站点客户端渲染） | 「中文召回到底怎么调」少一份参考答案 |
| U10 | **AI Search 的 `bge-m3` 输入上限** | 模型页写 context 60,000 tokens，AI Search 表写 512 input tokens（口径不同） | 影响 chunk 大小与入库策略 |
| U11 | **D1 单库并发连接上限（D1 侧）** | 官方只给「每 Worker invocation 6 个连接」和「单库单线程、查询排队」 | 高并发 agent 场景的排队/overloaded 阈值需实测 |

---

## 8. 需要付费账号实测清单（按优先级）

> 全部可在 **Workers Paid（$5/月）+ 一个 D1 库 + `wrangler`** 上完成；多数可直接 `wrangler d1 execute <db> --remote --command="..."` 验证。记录「语句 / 期望 / 通过标准」。

1. **FTS5 虚表能否在生产库建（最基础，先跑）**
   `CREATE VIRTUAL TABLE t_fts USING fts5(body);` → 通过标准：`--remote` 成功，`PRAGMA table_list` 出现 `type=virtual` 行。
   *顺带验证 workers-sdk#7259 那条导入通道问题是否还在：改用 `--command` 而非 `--file` 再试一次。*

2. **tokenizer 可用性矩阵**
   依次 `CREATE VIRTUAL TABLE ... USING fts5(body, tokenize='unicode61')` / `'trigram'` / `'porter'` / `'ascii'`；每个建完插 1 行查询。
   → 通过标准：建表 + `MATCH` 均无错。**重点确认 `porter`、`ascii`。**

3. **`bm25()` / `snippet()` / `highlight()` / `rank`**
   `SELECT bm25(t_fts), snippet(t_fts,0,'[',']','…',10), highlight(t_fts,0,'<b>','</b>') FROM t_fts WHERE t_fts MATCH ?;`
   → 通过标准：三个函数都返回值（snippet 在 `content=''`/external content 下要分别试）。

4. **中文行为基准（这条决定架构）**
   建 `tokenize='unicode61'` 与 `tokenize='trigram'` 两张表，各插 `'知识库检索系统需要中文分词'`，分别 `MATCH '知识'`、`MATCH '知识库'`、`MATCH '检索'`。
   → 期望：unicode61 表 0 命中；trigram 表 2 字词 0 命中、`'知识库'` 命中。**用来钉死「必须预分词」这个结论。**

5. **写路径：触发器 + batch 原子性 + 计费**
   建 `documents` + `documents_fts(content='documents')` + 三触发器；用 `db.batch([...])` 做一次 update（顺序：DELETE fts → UPDATE 主表 → INSERT fts），读 `meta.rows_written`。
   → 通过标准：①无 `SQLITE_CORRUPT_VTAB`；②`PRAGMA integrity-check` 通过（`INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')`）；③记下 `rows_written` 实际值以回答 U7/U8。

6. **排序方向确认**
   `ORDER BY bm25(t_fts)`（升序）vs `ORDER BY rank`，确认「越小越相关」。
   → 通过标准：最相关文档排第一。

7. **限额实战验证**
   ① 插一条 2,000,001 bytes 的字符串 → 期望失败（2 MB 行上限）；
   ② 构造 100,001 bytes 的 SQL 语句 → 期望 `Statement too long`；
   ③ 用 101 个 `?` 绑定 → 期望失败；
   ④ LIKE pattern 51 bytes 的中文 → 期望失败或行为异常；
   ⑤ 查回 >50 MB 结果 → 期望失败（2026-11-04 起生效）。
   → 通过标准：与 §3.1 表格完全一致；任一不符则更新本文。

8. **导出限制确认**
   库里有 FTS5 虚表时 `wrangler d1 export --remote` → 期望报错；`DROP` 虚表后再导 → 期望成功。
   → 通过标准：复现 §1.2 官方限制，确认备份流程需要「先删虚表」脚本。

9. **吞吐基线**
   灌 10 万 / 50 万条 chunk，测 P50/P95 检索延迟与 `meta.rows_read`。
   → 通过标准：对照社区数据（39 万词 P50 22 ms / P95 <45 ms）；确认 Free 5M 读/天 是否够用。

10. **`ATTACH` / 额外 PRAGMA**
    `ATTACH DATABASE '/tmp/x.db' AS x;`、`PRAGMA compile_options;`、`PRAGMA journal_mode;`
    → 只记录「成功 / 报什么错」，用于回答 U4/U5；**不把结果当稳定性承诺**。

11. **补读 quidproquo 中文 hybrid 文章**（非账号实测项）：用浏览器打开 https://quidproquo.cc/posts/tech/2026-08-26-d1-fts5-hybrid-search-cjk-recall/ 取正文，核对其中 recall 数字与 hybrid 方案是否与本文 §4.3 一致。
