-- scheme G: G F at paragraph level (supplementary)
-- notes: SUPPLEMENTARY experiment: same transform as F, but indexed per paragraph so bm25 sees local term density. Tests whether chunking fixes the ranking ceiling.
--
-- DDL
CREATE VIRTUAL TABLE docs_g USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');

-- representative search
-- one row per ~600-char heading/paragraph chunk; hits collapsed to files
SELECT path, bm25(docs_g) FROM docs_g WHERE docs_g MATCH '0x100b51cf*' ORDER BY 2 LIMIT 200;

-- index size: 1929216 B (x3.25 corpus)
-- build: 95.74 ms (transform 60.36 ms / insert 34.95 ms)

-- write-time transform lives in bench.py:
--   transform_bigram_ident
