CREATE TABLE documents(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, body TEXT);
CREATE VIRTUAL TABLE doc_fts USING fts5(search_text, tokenize='unicode61');
CREATE VIRTUAL TABLE doc_tri USING fts5(body, tokenize='trigram');
