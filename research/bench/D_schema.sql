-- scheme D: D bigram + identifier sub-tokens
-- notes: C plus 0x7000->7000, ABS_PRESSURE->ABS/PRESSURE, accountId->account/Id.
--
-- DDL
CREATE VIRTUAL TABLE docs_d USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');

-- representative search
SELECT path FROM docs_d WHERE docs_d MATCH '"account"' ORDER BY bm25(docs_d) LIMIT 5;

-- index size: 1564672 B (x2.63 corpus)
-- build: 84.65 ms (transform 57.22 ms / insert 27.05 ms)

-- write-time transform lives in bench.py:
--   transform_bigram_ident
