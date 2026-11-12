-- scheme B2: B+ trigram with LIKE fallback
-- notes: Diagnostic variant: keeps trigram substring power but rescues <3-char tokens with LIKE (unindexed scan, no bm25 ordering when only LIKE terms remain).
--
-- DDL
CREATE VIRTUAL TABLE docs_b USING fts5(path UNINDEXED, body, tokenize='trigram');

-- representative search
-- long terms: docs_b MATCH ; short terms: body LIKE '%'||?||'%'
SELECT path FROM docs_b WHERE docs_b MATCH :expr AND body LIKE '%'||:short||'%' LIMIT 5;

-- index size: 2920448 B (x4.92 corpus)
-- build: 92.81 ms (transform 0.01 ms / insert 92.25 ms)
