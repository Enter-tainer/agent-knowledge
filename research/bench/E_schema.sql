-- scheme E: E hybrid trigram + identifier table
-- notes: Keeps trigram substring recall, adds exact-token identifier ranking. bm25 only inside components.
--
-- DDL
CREATE VIRTUAL TABLE docs_b USING fts5(path UNINDEXED, body, tokenize='trigram');
CREATE VIRTUAL TABLE docs_e USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');

-- representative search
-- docs_e.body holds only ASCII identifier tokens, space separated
-- final ranking = reciprocal rank fusion of the two result lists
SELECT path FROM docs_b WHERE docs_b MATCH :expr ORDER BY bm25(docs_b) LIMIT 50;  -- + docs_e --

-- index size: 3346432 B (x5.63 corpus)
-- build: 88.72 ms (transform 0.01 ms / insert 88.08 ms)
