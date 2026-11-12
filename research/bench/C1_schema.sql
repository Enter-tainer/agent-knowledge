-- scheme C1: C1 unigram+bigram
-- notes: Diagnostic: extra unigrams buy 1-char CJK lookup at a large index cost.
--
-- DDL
CREATE VIRTUAL TABLE docs_c1 USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');

-- representative search
SELECT path FROM docs_c1 WHERE docs_c1 MATCH '"压"' ORDER BY bm25(docs_c1) LIMIT 5;

-- index size: 2076672 B (x3.5 corpus)
-- build: 60.77 ms (transform 24.88 ms / insert 35.53 ms)

-- write-time transform lives in bench.py:
--   transform_unigram_bigram
