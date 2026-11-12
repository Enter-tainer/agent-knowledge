-- scheme A: A unicode61 (baseline)
-- notes: Contiguous CJK run collapses into ONE token, so a 2-char query can only match when the whole run is exactly 2 chars.
--
-- DDL
CREATE VIRTUAL TABLE docs_a USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');

-- representative search
SELECT path FROM docs_a WHERE docs_a MATCH :expr ORDER BY bm25(docs_a) LIMIT 5;

-- index size: 1105920 B (x1.86 corpus)
-- build: 21.69 ms (transform 0.01 ms / insert 21.31 ms)
