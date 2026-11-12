# 本地冒烟证据（2026-11-12）

两个 POC，均在本机跑通；用来证明「D1 FTS5 + bigram 预分词 + bm25」在 wrangler 本地 D1（workerd）里可用，以及 markdown-it / remark 对真实语料的解析能力。

## 1. D1 FTS5 冒烟

环境：wrangler **4.155.0**（`pnpm dlx wrangler@4.155.0`），本地 D1（`--local`，workerd SQLite），不是生产 D1。

```powershell
cd research/poc
pnpm dlx wrangler@4.155.0 d1 execute kb-poc --local --file=d1-schema.sql
pnpm dlx wrangler@4.155.0 d1 execute kb-poc --local --file=d1-smoke.sql
```

已验证：

| 探针 | 结果 |
|---|---|
| `CREATE VIRTUAL TABLE ... fts5(..., tokenize='unicode61')` | 成功 |
| 同上 `tokenize='trigram'` | 成功 |
| bigram 表 `MATCH '"电机"'`（2 字中文 phrase） | 命中 |
| bigram 表 `MATCH '"电机 机校 校准"'`（4 字） | 命中 |
| bigram 表 `MATCH '压*'`（1 字前缀） | 命中 |
| bigram 表 `MATCH 'persist*'`（标识符前缀） | 命中 |
| trigram 表 `MATCH '"电机"'` | **0 行**（<3 字符静默不命中，符合预期） |
| trigram 表 `MATCH '"电机校"'` / `'"UserBy"'` | 1 行 / 1 行 |
| `bm25()` | 返回负 float，`ORDER BY bm25(fts)` 排序正常 |

> ⚠️ 本地 workerd 的 SQLite 版本不保证与生产 D1 一致；上线前按 `research/d1/capabilities.md` §8 的 11 条清单在生产库复测（最优先：生产建 FTS5、`bm25`、中文 2 字、`d1 export` 限制）。

## 2. 渲染对比

```powershell
cd research/poc
pnpm add markdown-it@15 unified remark-parse remark-gfm remark-rehype rehype-stringify
node render-poc.mjs
```

结果（36 篇真实语料）：

| | markdown-it 15.0.3 | remark-gfm |
|---|---|---|
| 表格渲染（270 个块，分隔行是单横线 `|-|-|`） | 270/270 | 270/270 |
| 引用块 | 115 | 115 |
| `[[wikilink]]` | 原样输出（需自写插件） | 同 |
| 行内代码里的 `[[…]]` | 正确跳过 | 同 |
| 全语料渲染耗时 | **80 ms** | 441 ms |

→ 结论见 `docs/TECH-69-67-plan.md` ADR-6：选 markdown-it + 两个自写插件。

## 3. 方案文档 §5 的 DDL 实测

`plan-schema.sql` 就是 `docs/TECH-69-67-plan.md` §5 的 DDL + 两条代表性查询（中文 2 字 phrase + 标题权重 bm25；标识符前缀）：

```powershell
pnpm dlx wrangler@4.155.0 d1 execute kb-poc --local --file=plan-schema.sql
```

结果：建表、写入、`bm25(chunks_fts, 4.0, 1.0)` 升序、`MATCH '"压感"'`、`MATCH '(0x700* OR hall*)'` 全部通过。

> 坑：`WHERE fts MATCH 'a' OR fts MATCH 'b'` 会报 `unable to use function MATCH in the requested context`（SQLite 限制）。多词必须拼成一个 MATCH 表达式。
