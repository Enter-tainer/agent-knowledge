-- scheme B: B trigram
-- notes: Substring search, but any term shorter than 3 characters silently matches nothing.
--
-- DDL
CREATE VIRTUAL TABLE docs_b USING fts5(path UNINDEXED, body, tokenize='trigram');

-- representative search
SELECT path FROM docs_b WHERE docs_b MATCH :expr ORDER BY bm25(docs_b) LIMIT 5;

-- index size: 2920448 B (x4.92 corpus)
-- build: 102.06 ms (transform 0.01 ms / insert 101.73 ms)
