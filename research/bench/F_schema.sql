-- scheme F: F D + identifier prefix queries
-- notes: D's index + `token*` for ASCII identifiers: catches 0x100B51CF4 / accountIdV2 variants.
--
-- DDL
CREATE VIRTUAL TABLE docs_f USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');

-- representative search
-- same index as D; ASCII identifier tokens are searched as prefixes
SELECT path FROM docs_f WHERE docs_f MATCH '0x100b51cf*' ORDER BY bm25(docs_f) LIMIT 5;

-- index size: 1564672 B (x2.63 corpus)
-- build: 88.63 ms (transform 59.09 ms / insert 29.19 ms)

-- write-time transform lives in bench.py:
--   transform_bigram_ident
