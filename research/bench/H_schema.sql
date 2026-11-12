-- scheme H: H F + raw-text post-filter
-- notes: F plus a top-50 verification pass on the original text: kills separator-folding false positives (access_token vs 'access token') for a few string comparisons.
--
-- DDL
CREATE VIRTUAL TABLE docs_h USING fts5(path UNINDEXED, body, raw UNINDEXED, tokenize='unicode61 remove_diacritics 2');

-- representative search
-- candidate list from FTS, then verify every query token against the stored original
SELECT path, raw, bm25(docs_h) FROM docs_h WHERE docs_h MATCH 'access_token*' ORDER BY 3 LIMIT 50;

-- index size: 2154496 B (x3.63 corpus)
-- build: 90.01 ms (transform 58.83 ms / insert 30.82 ms)

-- write-time transform lives in bench.py:
--   transform_bigram_ident
