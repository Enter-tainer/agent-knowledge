-- scheme C: C bigram pre-tokenised
-- notes: Write-time CJK bigrams; query side must apply the identical transform and use a phrase.
--
-- DDL
CREATE VIRTUAL TABLE docs_c USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');

-- representative search
-- body written as: CJK run 心率广播 -> '心率 率广 广播', ASCII kept as-is
SELECT path FROM docs_c WHERE docs_c MATCH '"心率 率广 广播"' ORDER BY bm25(docs_c) LIMIT 5;

-- index size: 1478656 B (x2.49 corpus)
-- build: 49.8 ms (transform 21.01 ms / insert 28.35 ms)

-- write-time transform lives in bench.py:
--   transform_bigram
