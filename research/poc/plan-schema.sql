-- 方案文档 §5 的 DDL 实测版（wrangler 本地 D1）
PRAGMA foreign_keys = ON;

CREATE TABLE documents (
  id                INTEGER PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  raw               TEXT NOT NULL,
  body_hash         TEXT NOT NULL,
  frontmatter_json  TEXT,
  tags_json         TEXT,
  size_bytes        INTEGER NOT NULL,
  mtime             TEXT NOT NULL,
  tokenizer_version INTEGER NOT NULL DEFAULT 1,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE doc_chunks (
  id          INTEGER PRIMARY KEY,
  doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  heading     TEXT,
  start_off   INTEGER NOT NULL,
  end_off     INTEGER NOT NULL,
  search_text TEXT NOT NULL
);
CREATE INDEX idx_chunks_doc ON doc_chunks(doc_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title_text,
  body_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE links (
  id          INTEGER PRIMARY KEY,
  src_doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  dst_doc_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  target_raw  TEXT NOT NULL,
  form        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  col         INTEGER NOT NULL,
  alias       TEXT
);
CREATE INDEX idx_links_dst ON links(dst_doc_id);
CREATE INDEX idx_links_src ON links(src_doc_id);

-- 一次写入的 batch 形状（示例：doc_id=1，2 个 chunk）
INSERT INTO documents(id,path,title,raw,body_hash,size_bytes,mtime,created_at,updated_at)
VALUES (1,'demo/设备逆向','设备逆向','# 示例\n\n8192 压感等级与 0x7000 ioctl，HALL 传感器。','h1',64,'2026-11-06T00:00:00Z','2026-11-12T00:00:00Z','2026-11-12T00:00:00Z');

INSERT INTO doc_chunks(id,doc_id,ord,heading,start_off,end_off,search_text) VALUES
 (1000,1,0,'压感',0,20,'压感 感等 等级 8192 7000 ioctl hall 传感 感器 笔输 输入 入通 通路'),
 (1001,1,1,'ioctl',20,64,'ioctl 7000 hall 传感 感器 压感 感真 真相');

INSERT INTO chunks_fts(rowid,title_text,body_text) VALUES
 (1000,'笔输 输入 入通 通路 压感 感真 真相 案例 例库','压感 感等 等级 8192 7000 ioctl hall 传感 感器'),
 (1001,'笔输 输入 入通 通路 压感 感真 真相 案例 例库','ioctl 7000 hall 传感 感器 压感 感真 真相');

-- 查询：2 字中文 phrase + 标题权重 + bm25 升序
SELECT c.doc_id, c.heading, bm25(chunks_fts, 4.0, 1.0) AS score
FROM chunks_fts f JOIN doc_chunks c ON c.id = f.rowid
WHERE chunks_fts MATCH '"压感"'
ORDER BY score ASC LIMIT 5;

-- 查询：标识符前缀
SELECT c.doc_id, c.heading FROM chunks_fts f JOIN doc_chunks c ON c.id = f.rowid
WHERE chunks_fts MATCH '(0x700* OR hall*)' LIMIT 5;

