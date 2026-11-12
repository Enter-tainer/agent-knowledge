-- agent-knowledge 初始 schema（TECH-69 / 全存 D1，不用 R2）
-- 写入顺序与不变量见 docs/TECH-69-67-plan.md §5

CREATE TABLE IF NOT EXISTS documents (
  id                INTEGER PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  raw               TEXT NOT NULL,
  body_hash         TEXT NOT NULL,
  -- 索引是否跟上正文：body_hash != indexed_hash 时说明「文件新、索引旧」，可用 /api/admin/reindex 自愈
  indexed_hash      TEXT,
  frontmatter_json  TEXT,
  tags_json         TEXT,
  size_bytes        INTEGER NOT NULL,
  mtime             TEXT NOT NULL,
  tokenizer_version INTEGER NOT NULL DEFAULT 1,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id          INTEGER PRIMARY KEY, -- 应用侧确定性 id = doc_id * 100000 + ord（跨文档不撞）
  doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  heading     TEXT,
  start_off   INTEGER NOT NULL,
  end_off     INTEGER NOT NULL,
  search_text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON doc_chunks(doc_id);

-- 独立 FTS5（不用 external content、不用 trigger；rowid = doc_chunks.id）
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title_text,
  body_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY,
  src_doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  dst_doc_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  target_raw  TEXT NOT NULL,
  form        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  col         INTEGER NOT NULL,
  alias       TEXT
);

CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_doc_id);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_doc_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR REPLACE INTO meta(key, value) VALUES
  ('schema_version', '2'),
  ('tokenizer_version', '1');
