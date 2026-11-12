import type { Env } from './env';
import { ApiError, MAX_DOC_BYTES, nowIso } from './env';
import { asStringArray, deriveTitle, parseFrontmatter, sanitizeFrontmatter } from './lib/frontmatter';
import { chunkMarkdown } from './lib/chunk';
import { analyzeQuery, TOKENIZER_VERSION, transformText } from './lib/transform';
import { buildLinkIndex, dirOf, resolveWikilink, scanWikilinks, stemOf } from './lib/links';
import { sha256Hex } from './lib/hash';

/** 每篇文档最多 10 万个 chunk（1.5MB / 600 字 ≈ 2500，余量 40×）；id = docId*100000 + ord 保证跨文档不撞。 */
const MAX_CHUNKS_PER_DOC = 100_000;
const CHUNK_ID_FACTOR = 100_000;

export interface DocSummary {
  path: string;
  title: string;
  tags: string[];
  size: number;
  updated: string;
}

export interface DocFull extends DocSummary {
  hash: string;
  revision: number;
  raw: string;
  frontmatter: Record<string, string | string[]>;
  /** body_hash 与 indexed_hash 不一致（文件新、索引旧，可 /api/admin/reindex 自愈）。 */
  stale: boolean;
}

export interface PutResult {
  path: string;
  hash: string;
  revision: number;
  chunks: number;
  links: number;
  indexStale?: boolean;
  warning?: string;
}

interface DocRow {
  id: number;
  path: string;
  title: string;
  raw: string;
  body_hash: string;
  indexed_hash: string | null;
  frontmatter_json: string | null;
  tags_json: string | null;
  size_bytes: number;
  mtime: string;
  tokenizer_version: number;
  revision: number;
  updated_at: string;
}

const docSelect = `SELECT id, path, title, raw, body_hash, indexed_hash, frontmatter_json, tags_json, size_bytes,
  mtime, tokenizer_version, revision, updated_at FROM documents`;

function toSummary(row: DocRow): DocSummary {
  return {
    path: row.path,
    title: row.title,
    tags: parseTags(row.tags_json),
    size: row.size_bytes,
    updated: row.mtime,
  };
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(json: string | null): Record<string, string | string[]> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string | string[]>) : {};
  } catch {
    return {};
  }
}

export async function listDocuments(env: Env, prefix: string, limit = 500): Promise<DocSummary[]> {
  if (prefix) {
    // 前缀用范围扫描（走 path 唯一索引），不用 LIKE：D1 的 LIKE pattern 长度上限很紧
    const upper = `${prefix}\uffff`;
    const { results } = await env.DB.prepare(
      `${docSelect} WHERE path >= ? AND path < ? ORDER BY path LIMIT ?`,
    )
      .bind(prefix, upper, limit)
      .all<DocRow>();
    return results.map(toSummary);
  }
  const { results } = await env.DB.prepare(`${docSelect} ORDER BY path LIMIT ?`).bind(limit).all<DocRow>();
  return results.map(toSummary);
}

export async function getDocument(env: Env, path: string): Promise<DocFull> {
  const row = await env.DB.prepare(`${docSelect} WHERE path = ?`).bind(path).first<DocRow>();
  // 历史失败可能留下 raw/hash 为空的占位行：按不存在处理（PUT If-Match:* 可修复）
  if (!row || row.body_hash === '') throw new ApiError(404, `document not found: ${path}`);
  return {
    ...toSummary(row),
    hash: row.body_hash,
    revision: row.revision,
    raw: row.raw,
    frontmatter: parseJsonObject(row.frontmatter_json),
    stale: row.indexed_hash !== row.body_hash,
  };
}

export async function documentExists(env: Env, path: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS one FROM documents WHERE path = ?').bind(path).first<{ one: number }>();
  return row !== null;
}

interface PathIndex {
  idByPath: Map<string, number>;
  index: ReturnType<typeof buildLinkIndex>;
}

async function loadPathIndex(env: Env, extra?: { path: string; id: number }): Promise<PathIndex> {
  const { results } = await env.DB.prepare('SELECT id, path FROM documents').all<{ id: number; path: string }>();
  const idByPath = new Map<string, number>();
  const paths: string[] = [];
  for (const r of results) {
    idByPath.set(r.path, r.id);
    paths.push(r.path);
  }
  if (extra && !idByPath.has(extra.path)) {
    idByPath.set(extra.path, extra.id);
    paths.push(extra.path);
  }
  return { idByPath, index: buildLinkIndex(paths) };
}

interface IndexedDoc {
  chunks: ReturnType<typeof chunkMarkdown>;
  statements: D1PreparedStatement[];
}

/** 只生成「重建索引」语句（删旧 chunks/fts + 插新），不碰 documents 行本身。 */
function buildIndexStatements(
  env: Env,
  docId: number,
  path: string,
  raw: string,
  title: string,
  bodyOffset: number,
): IndexedDoc {
  const chunks = chunkMarkdown(raw.slice(bodyOffset)).map((c) => ({
    ...c,
    start: c.start + bodyOffset,
    end: c.end + bodyOffset,
  }));
  if (chunks.length >= MAX_CHUNKS_PER_DOC) {
    throw new ApiError(413, `文档块数 ${chunks.length} 超过上限 ${MAX_CHUNKS_PER_DOC}，请拆分文档`);
  }
  const titleBase = transformText(`${title} ${path}`);
  // 按 rowid 区间删 FTS：要能清掉「doc_chunks 已丢但 FTS 残留」的孤儿行（review-agent-ux 实测踩到）
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM chunks_fts WHERE rowid >= ? AND rowid < ?').bind(
      docId * CHUNK_ID_FACTOR,
      (docId + 1) * CHUNK_ID_FACTOR,
    ),
    env.DB.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').bind(docId),
  ];
  for (const c of chunks) {
    const chunkId = docId * CHUNK_ID_FACTOR + c.ord;
    const bodyText = transformText(c.text);
    // 标题只加「本 chunk 的 heading」，不要把全篇 heading 复制到每个 chunk：
    // 否则 bm25 长度归一化会把排序变成「最短 chunk 优先」（见 review-data-search P1）
    const titleText = c.heading ? `${titleBase} ${transformText(c.heading)}` : titleBase;
    statements.push(
      env.DB.prepare(
        'INSERT INTO doc_chunks(id, doc_id, ord, heading, start_off, end_off, search_text) VALUES (?,?,?,?,?,?,?)',
      ).bind(chunkId, docId, c.ord, c.heading, c.start, c.end, bodyText),
    );
    statements.push(
      env.DB.prepare('INSERT INTO chunks_fts(rowid, title_text, body_text) VALUES (?,?,?)').bind(
        chunkId,
        titleText,
        bodyText,
      ),
    );
  }
  return { chunks, statements };
}

interface PreparedDoc {
  title: string;
  cleanFm: Record<string, string | string[]>;
  tags: string[];
  updated: string;
  size: number;
  bodyOffset: number;
  indexed: IndexedDoc;
  linkStatements: D1PreparedStatement[];
}

/** 计算一篇文档的标题、frontmatter、切块、链接语句（不含 documents 行的写入）。 */
async function prepareDoc(
  env: Env,
  docId: number,
  path: string,
  raw: string,
  size: number,
): Promise<PreparedDoc> {
  const { frontmatter, bodyOffset } = parseFrontmatter(raw);
  const body = raw.slice(bodyOffset);
  const title = deriveTitle(frontmatter, body, stemOf(path));
  const cleanFm = sanitizeFrontmatter(frontmatter);
  const tags = asStringArray(cleanFm['tags']);
  const updated = typeof cleanFm['updated'] === 'string' && cleanFm['updated'] ? cleanFm['updated'] : nowIso();
  const indexed = buildIndexStatements(env, docId, path, raw, title, bodyOffset);

  const scanned = scanWikilinks(raw);
  const { idByPath, index } = await loadPathIndex(env, { path, id: docId });
  const linkStatements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM links WHERE src_doc_id = ?').bind(docId),
  ];
  for (const link of scanned) {
    const dstPath = resolveWikilink(path, link.target, index);
    const dstId = dstPath ? (idByPath.get(dstPath) ?? null) : null;
    linkStatements.push(
      env.DB.prepare(
        'INSERT INTO links(src_doc_id, dst_doc_id, target_raw, form, line, col, alias) VALUES (?,?,?,?,?,?,?)',
      ).bind(docId, dstId, link.target, 'wikilink', link.line, link.col, link.alias),
    );
  }

  return { title, cleanFm, tags, updated, size, bodyOffset, indexed, linkStatements };
}

/**
 * 写入一篇文档。
 * - 已存在：`If-Match: <hash>` 必填；body/raw 与 body_hash 在**同一条 UPDATE** 里 CAS 提交（changes=0 → 412，零副作用）。
 * - 不存在：`If-Match: *` 必填；用单条 INSERT…SELECT MAX(id)+1 原子分配 id（无并发撞号窗口）。
 * - 正文落库成功后再重建 chunks/fts/links；索引写失败返回 200 + indexStale（内容已保存，可 reindex 自愈）。
 */
export async function putDocument(
  env: Env,
  path: string,
  raw: string,
  ifMatch?: string | null,
): Promise<PutResult> {
  const size = new TextEncoder().encode(raw).length;
  if (size > MAX_DOC_BYTES) throw new ApiError(413, `文档过大：${size} bytes > ${MAX_DOC_BYTES}`);

  const existing = await env.DB.prepare('SELECT id, body_hash, revision FROM documents WHERE path = ?')
    .bind(path)
    .first<{ id: number; body_hash: string; revision: number }>();
  // 占位/幽灵行（历史失败残留：raw/hash 为空）按「不存在」处理，允许用 If-Match: * 修复
  const placeholder = existing !== null && existing.body_hash === '';

  const hash = await sha256Hex(raw);
  const now = nowIso();
  let docId: number;
  let created = false;

  if (existing && !placeholder) {
    if (!ifMatch) {
      throw new ApiError(428, '修改已存在文档必须带 If-Match: <hash>（先用 GET 拿 hash）');
    }
    if (ifMatch === '*') {
      throw new ApiError(428, 'If-Match: * 只用于新建；修改请带当前 hash');
    }
    if (ifMatch !== existing.body_hash) {
      throw new ApiError(412, 'hash mismatch（文件已被修改，请先重新加载）');
    }
    docId = existing.id;
    const prepared = await prepareDoc(env, docId, path, raw, size);
    const cas = await env.DB.prepare(
      `UPDATE documents SET title = ?, raw = ?, body_hash = ?, frontmatter_json = ?, tags_json = ?,
         size_bytes = ?, mtime = ?, tokenizer_version = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND body_hash = ?`,
    )
      .bind(
        prepared.title,
        raw,
        hash,
        JSON.stringify(prepared.cleanFm),
        JSON.stringify(prepared.tags),
        size,
        prepared.updated,
        TOKENIZER_VERSION,
        now,
        docId,
        existing.body_hash,
      )
      .run();
    if ((cas.meta?.changes ?? 0) !== 1) {
      throw new ApiError(412, 'hash mismatch（并发写入，请重新加载）');
    }
    const indexStale = await rebuildIndex(env, docId, hash, prepared);
    await resolveInboundLinks(env, path);
    const revisionRow = await env.DB.prepare('SELECT revision, body_hash FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ revision: number; body_hash: string }>();
    return {
      path,
      hash: revisionRow?.body_hash ?? hash,
      revision: revisionRow?.revision ?? existing.revision + 1,
      chunks: prepared.indexed.chunks.length,
      links: prepared.linkStatements.length - 1,
      ...(indexStale ? { indexStale: true, warning: '内容已保存，索引重建失败；请调用 /api/admin/reindex' } : {}),
    };
  }

  // 新建（含修复历史遗留的占位/幽灵行）
  if (!ifMatch) throw new ApiError(428, '新建文档必须带 If-Match: *');
  if (ifMatch !== '*') throw new ApiError(412, '文档不存在；新建请用 If-Match: *');

  if (placeholder && existing) {
    docId = existing.id;
  } else {
    // 单条语句原子分配 id：两个并发新建不会拿到同一个 MAX+1
    await env.DB.prepare(
      `INSERT INTO documents(id, path, title, raw, body_hash, indexed_hash, frontmatter_json, tags_json,
         size_bytes, mtime, tokenizer_version, revision, created_at, updated_at)
       SELECT COALESCE(MAX(id), 0) + 1, ?, '', '', '', NULL, NULL, NULL, 0, ?, ?, 1, ?, ?
       FROM documents`,
    )
      .bind(path, now, now, now, now)
      .run();
    created = true;
    const row = await env.DB.prepare('SELECT id FROM documents WHERE path = ?').bind(path).first<{ id: number }>();
    if (!row) throw new ApiError(500, 'internal error');
    docId = row.id;
  }

  try {
    const prepared = await prepareDoc(env, docId, path, raw, size);
    // 把占位行补成正式内容（单条语句，原子）。新建/修复占位行时 revision 归一为 1（与 GET 一致）
    const revisionExpr = created || placeholder ? 'revision = 1' : 'revision = revision + 1';
    await env.DB.prepare(
      `UPDATE documents SET title = ?, raw = ?, body_hash = ?, frontmatter_json = ?, tags_json = ?,
         size_bytes = ?, mtime = ?, tokenizer_version = ?, updated_at = ?, ${revisionExpr}
       WHERE id = ?`,
    )
      .bind(
        prepared.title,
        raw,
        hash,
        JSON.stringify(prepared.cleanFm),
        JSON.stringify(prepared.tags),
        size,
        prepared.updated,
        TOKENIZER_VERSION,
        now,
        docId,
      )
      .run();

    const indexStale = await rebuildIndex(env, docId, hash, prepared);
    await resolveInboundLinks(env, path);
    const written = await env.DB.prepare('SELECT body_hash FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ body_hash: string }>();
    return {
      path,
      hash: written?.body_hash ?? hash,
      revision: 1,
      chunks: prepared.indexed.chunks.length,
      links: prepared.linkStatements.length - 1,
      ...(indexStale ? { indexStale: true, warning: '内容已保存，索引重建失败；请调用 /api/admin/reindex' } : {}),
    };
  } catch (err) {
    // 任何一步失败都清理：新 id 删掉；占位行恢复成占位（下次可用 If-Match:* 重试）
    if (created) {
      await env.DB.prepare('DELETE FROM links WHERE src_doc_id = ?').bind(docId).run().catch(() => undefined);
      await env.DB.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM doc_chunks WHERE doc_id = ?)')
        .bind(docId)
        .run()
        .catch(() => undefined);
      await env.DB.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').bind(docId).run().catch(() => undefined);
      await env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(docId).run().catch(() => undefined);    } else {
      await env.DB.prepare(
        "UPDATE documents SET title = '', raw = '', body_hash = '', indexed_hash = NULL WHERE id = ?",
      )
        .bind(docId)
        .run()
        .catch(() => undefined);
    }
    throw err;
  }
}

/**
 * 新建/更新一篇文档后，把「此前指向它但还没解析成功」的入链补解析掉。
 * 只扫 dst 为空的链接，按 stem / 完整 path 匹配候选，避免全表重解析。
 */
async function resolveInboundLinks(env: Env, docPath: string): Promise<void> {
  const stem = stemOf(docPath);
  const { results: candidates } = await env.DB.prepare(
    `SELECT id, src_doc_id AS srcId, target_raw AS target FROM links
     WHERE dst_doc_id IS NULL AND (LOWER(target_raw) = ? OR LOWER(target_raw) = ? OR LOWER(target_raw) = ?)`,
  )
    .bind(stem.toLowerCase(), docPath.toLowerCase(), `${docPath.toLowerCase()}.md`)
    .all<{ id: number; srcId: number; target: string }>();
  if (candidates.length === 0) return;

  const { results: docs } = await env.DB.prepare('SELECT id, path FROM documents').all<{ id: number; path: string }>();
  const pathById = new Map(docs.map((d) => [d.id, d.path]));
  const { idByPath, index } = await loadPathIndex(env);
  const updates: D1PreparedStatement[] = [];
  for (const link of candidates) {
    const srcPath = pathById.get(link.srcId);
    if (!srcPath) continue;
    const dstPath = resolveWikilink(srcPath, link.target, index);
    if (!dstPath) continue;
    updates.push(env.DB.prepare('UPDATE links SET dst_doc_id = ? WHERE id = ?').bind(idByPath.get(dstPath) ?? null, link.id));
  }
  for (let i = 0; i < updates.length; i += 50) {
    await env.DB.batch(updates.slice(i, i + 50));
  }
}

async function rebuildIndex(env: Env, docId: number, hash: string, prepared: PreparedDoc): Promise<boolean> {
  try {
    await env.DB.batch([
      ...prepared.indexed.statements,
      ...prepared.linkStatements,
      env.DB.prepare('UPDATE documents SET indexed_hash = ? WHERE id = ?').bind(hash, docId),
    ]);
    return false;
  } catch (err) {
    console.error('index rebuild failed', { docId, err: err instanceof Error ? err.message : err });
    return true;
  }
}

export async function deleteDocument(env: Env, path: string, force = false): Promise<{ path: string }> {
  const row = await env.DB.prepare('SELECT id FROM documents WHERE path = ?').bind(path).first<{ id: number }>();
  if (!row) throw new ApiError(404, `document not found: ${path}`);
  const backlinks = await env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE dst_doc_id = ?')
    .bind(row.id)
    .first<{ n: number }>();
  const n = backlinks?.n ?? 0;
  if (n > 0 && !force) throw new ApiError(409, `还有 ${n} 条反链指向该文档；确认删除请加 ?force=1`);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM doc_chunks WHERE doc_id = ?)').bind(row.id),
    env.DB.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').bind(row.id),
    // 指向它的链接保留、变成断链（用户可再决定重命名回去或修链接）
    env.DB.prepare('UPDATE links SET dst_doc_id = NULL WHERE dst_doc_id = ?').bind(row.id),
    env.DB.prepare('DELETE FROM links WHERE src_doc_id = ?').bind(row.id),
    env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(row.id),
  ]);
  return { path };
}

export interface SearchResultItem {
  path: string;
  title: string;
  heading: string | null;
  /** bm25 原始分：负数，越小越相关（排序按升序）。 */
  score: number;
  /** 便于 agent 使用的正相关度 = -score（越大越相关）。 */
  relevance: number;
  snippet: string;
  highlights: string[];
}

interface HitRow {
  docId: number;
  ord: number;
  heading: string | null;
  startOff: number;
  endOff: number;
  score: number;
}

export async function searchDocuments(
  env: Env,
  query: string,
  limit = 10,
): Promise<{ query: string; results: SearchResultItem[]; note?: string }> {
  const { expr, terms, hasShortCjk } = analyzeQuery(query);
  const shortCjkNote = '中文至少输入 2 个字（1 字查询只能匹配独立单字，可能漏）';
  if (!expr) {
    return {
      query,
      results: [],
      note: hasShortCjk ? shortCjkNote : '请输入关键词',
    };
  }

  const { results: hits } = await env.DB.prepare(
    `SELECT c.doc_id AS docId, c.ord AS ord, c.heading AS heading,
            c.start_off AS startOff, c.end_off AS endOff,
            bm25(chunks_fts, 4.0, 1.0) AS score
     FROM chunks_fts JOIN doc_chunks c ON c.id = chunks_fts.rowid
     WHERE chunks_fts MATCH ?
     ORDER BY score ASC
     LIMIT ?`,
  )
    .bind(expr, Math.min(500, Math.max(limit * 20, 100)))
    .all<HitRow>();

  const best = new Map<number, HitRow>();
  for (const hit of hits) {
    const prev = best.get(hit.docId);
    if (!prev || hit.score < prev.score) best.set(hit.docId, hit);
  }
  const picked = [...best.values()].sort((a, b) => a.score - b.score).slice(0, limit);
  if (picked.length === 0) {
    return {
      query,
      results: [],
      note: hasShortCjk ? shortCjkNote : '没有匹配结果',
    };
  }

  const ids = picked.map((p) => p.docId);
  const placeholders = ids.map(() => '?').join(',');
  const { results: docs } = await env.DB.prepare(
    `SELECT id, path, title, raw FROM documents WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: number; path: string; title: string; raw: string }>();
  const docById = new Map(docs.map((d) => [d.id, d]));

  const results: SearchResultItem[] = [];
  for (const hit of picked) {
    const doc = docById.get(hit.docId);
    if (!doc) continue;
    const chunkText = doc.raw.slice(hit.startOff, hit.endOff);
    let { snippet, highlights } = makeSnippet(chunkText, terms);
    // 命中可能来自 title_text / heading（chunk 正文里没有查询词）：退回正文找摘要，
    // 但**必须跳过 frontmatter**（否则摘要会出现 YAML / 飞书链接，UX review P1）
    if (highlights.length === 0) {
      const { bodyOffset } = parseFrontmatter(doc.raw);
      const fallback = makeSnippet(doc.raw.slice(bodyOffset), terms);
      if (fallback.highlights.length > 0) {
        snippet = fallback.snippet;
        highlights = fallback.highlights;
      }
    }
    results.push({
      path: doc.path,
      title: doc.title,
      heading: hit.heading,
      score: Number(hit.score.toFixed(6)),
      relevance: Number((-hit.score).toFixed(6)),
      snippet,
      highlights,
    });
  }
  return { query, results, ...(hasShortCjk ? { note: shortCjkNote } : {}) };
}

function makeSnippet(text: string, terms: string[]): { snippet: string; highlights: string[] } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  let hit = -1;
  let matched = '';
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase());
    if (i >= 0) {
      hit = i;
      matched = term;
      break;
    }
  }
  if (hit < 0) {
    for (const term of terms) {
      const chars = [...term];
      for (let k = 0; k + 1 < chars.length; k++) {
        const bg = `${chars[k]}${chars[k + 1]}`;
        const i = lower.indexOf(bg.toLowerCase());
        if (i >= 0) {
          hit = i;
          matched = bg;
          break;
        }
      }
      if (hit >= 0) break;
    }
  }
  const width = 90;
  const start = hit < 0 ? 0 : Math.max(0, hit - width);
  const end =
    hit < 0 ? Math.min(normalized.length, width * 2) : Math.min(normalized.length, hit + matched.length + width);
  const raw = normalized.slice(start, end);
  const snippet = `${start > 0 ? '…' : ''}${raw}${end < normalized.length ? '…' : ''}`;

  const highlights: string[] = [];
  for (const term of terms) {
    if (snippet.toLowerCase().includes(term.toLowerCase())) highlights.push(term);
  }
  if (highlights.length === 0 && matched) highlights.push(matched);
  return { snippet, highlights };
}

export interface Backlink {
  path: string;
  title: string;
  count: number;
}

export async function backlinks(env: Env, path: string): Promise<Backlink[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.path AS path, d.title AS title, COUNT(*) AS count
     FROM links l
     JOIN documents d ON d.id = l.src_doc_id
     JOIN documents t ON t.id = l.dst_doc_id
     WHERE t.path = ?
     GROUP BY d.id
     ORDER BY count DESC, d.path`,
  )
    .bind(path)
    .all<Backlink>();
  return results;
}

export interface OutgoingLink {
  target: string;
  resolved: boolean;
  dstPath: string | null;
  line: number;
}

export async function outgoingLinks(env: Env, path: string): Promise<OutgoingLink[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.target_raw AS target, l.line AS line, d.path AS dstPath
     FROM links l
     JOIN documents s ON s.id = l.src_doc_id
     LEFT JOIN documents d ON d.id = l.dst_doc_id
     WHERE s.path = ?
     ORDER BY l.line, l.col`,
  )
    .bind(path)
    .all<{ target: string; line: number; dstPath: string | null }>();
  return results.map((r) => ({
    target: r.target,
    resolved: r.dstPath !== null,
    dstPath: r.dstPath,
    line: r.line,
  }));
}

export interface LinkRow {
  src: string;
  title: string;
  target: string;
  line: number;
  resolved: boolean;
  dstPath: string | null;
}

export async function allInternalLinks(env: Env): Promise<LinkRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.path AS src, s.title AS title, l.target_raw AS target, l.line AS line, d.path AS dstPath
     FROM links l JOIN documents s ON s.id = l.src_doc_id
     LEFT JOIN documents d ON d.id = l.dst_doc_id
     ORDER BY s.path, l.line`,
  ).all<{ src: string; title: string; target: string; line: number; dstPath: string | null }>();
  return results.map((r) => ({
    src: r.src,
    title: r.title,
    target: r.target,
    line: r.line,
    resolved: r.dstPath !== null,
    dstPath: r.dstPath,
  }));
}

export async function unresolvedLinks(env: Env): Promise<
  { src: string; title: string; target: string; line: number }[]
> {
  const { results } = await env.DB.prepare(
    `SELECT d.path AS src, d.title AS title, l.target_raw AS target, l.line AS line
     FROM links l JOIN documents d ON d.id = l.src_doc_id
     WHERE l.dst_doc_id IS NULL
     ORDER BY d.path, l.line`,
  ).all<{ src: string; title: string; target: string; line: number }>();
  return results;
}

export async function orphanDocuments(env: Env): Promise<{ path: string; title: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.path AS path, d.title AS title FROM documents d
     WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.dst_doc_id = d.id)
     ORDER BY d.path`,
  ).all<{ path: string; title: string }>();
  return results;
}

/** 重新解析全库链接（导入后、rename 后必须跑一次）。 */
export async function resolveAllLinks(env: Env): Promise<{ total: number; unresolved: number }> {
  const { results: docs } = await env.DB.prepare('SELECT id, path FROM documents').all<{
    id: number;
    path: string;
  }>();
  const pathById = new Map(docs.map((d) => [d.id, d.path]));
  const { idByPath, index } = await loadPathIndex(env);
  const { results: links } = await env.DB.prepare(
    'SELECT id, src_doc_id AS srcId, dst_doc_id AS dstId, target_raw AS target FROM links',
  ).all<{ id: number; srcId: number; dstId: number | null; target: string }>();

  const statements: D1PreparedStatement[] = [];
  let unresolved = 0;
  for (const link of links) {
    const srcPath = pathById.get(link.srcId);
    if (!srcPath) continue;
    const dstPath = resolveWikilink(srcPath, link.target, index);
    const resolvedId = dstPath ? (idByPath.get(dstPath) ?? null) : null;
    if (resolvedId === null) unresolved++;
    if (resolvedId !== link.dstId) {
      statements.push(env.DB.prepare('UPDATE links SET dst_doc_id = ? WHERE id = ?').bind(resolvedId, link.id));
    }
  }
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  return { total: links.length, unresolved };
}

/** 索引落后正文的文档（body_hash != indexed_hash）；可 POST /api/admin/reindex 自愈。 */
export async function staleDocuments(
  env: Env,
): Promise<{ path: string; title: string; updated: string; hash: string; indexedHash: string | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT path, title, mtime AS updated, body_hash AS hash, indexed_hash AS indexedHash
     FROM documents WHERE indexed_hash IS NULL OR indexed_hash != body_hash
     ORDER BY path`,
  ).all<{ path: string; title: string; updated: string; hash: string; indexedHash: string | null }>();
  return results;
}

/** 按当前 tokenizer 重建全库 chunks_fts（分词版本升级 / 索引写失败自愈时用）。 */
export async function reindexAll(env: Env): Promise<{ documents: number; chunks: number; stale: number; orphansRemoved: number }> {
  // 先清孤儿 FTS 行（doc_chunks 已无对应 id）：不依赖 join 删，避免历史残留把新建文档顶成 indexStale
  const orphans = await env.DB.prepare('DELETE FROM chunks_fts WHERE rowid NOT IN (SELECT id FROM doc_chunks)').run();
  const { results: docs } = await env.DB.prepare(
    'SELECT id, path, raw, title, body_hash, indexed_hash FROM documents ORDER BY id',
  ).all<{ id: number; path: string; raw: string; title: string; body_hash: string; indexed_hash: string | null }>();
  let chunks = 0;
  for (const doc of docs) {
    const size = new TextEncoder().encode(doc.raw).length;
    const prepared = await prepareDoc(env, doc.id, doc.path, doc.raw, size);
    await rebuildIndex(env, doc.id, doc.body_hash, prepared);
    chunks += prepared.indexed.chunks.length;
  }
  await resolveAllLinks(env);
  const staleRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM documents WHERE indexed_hash IS NULL OR indexed_hash != body_hash',
  ).first<{ n: number }>();
  return {
    documents: docs.length,
    chunks,
    stale: staleRow?.n ?? 0,
    orphansRemoved: orphans.meta?.changes ?? 0,
  };
}

export async function renameDocument(
  env: Env,
  fromPath: string,
  toPath: string,
): Promise<{ from: string; to: string; rewritten: number; unresolved: number; alreadyRenamed?: boolean }> {
  if (fromPath === toPath) return { from: fromPath, to: toPath, rewritten: 0, unresolved: 0 };

  const target = await env.DB.prepare('SELECT id, raw, body_hash FROM documents WHERE path = ?')
    .bind(fromPath)
    .first<{ id: number; raw: string; body_hash: string }>();
  if (!target) {
    // 幂等：上一次 rename 已把 path 改过去（可能后续步骤失败）→ 重解析并报告 unresolved
    const already = await env.DB.prepare('SELECT 1 AS one FROM documents WHERE path = ?')
      .bind(toPath)
      .first<{ one: number }>();
    if (already) {
      const { unresolved } = await resolveAllLinks(env);
      return { from: fromPath, to: toPath, rewritten: 0, unresolved, alreadyRenamed: true };
    }
    throw new ApiError(404, `document not found: ${fromPath}`);
  }
  const conflict = await env.DB.prepare('SELECT id FROM documents WHERE path = ?').bind(toPath).first<{ id: number }>();
  if (conflict) throw new ApiError(409, `目标路径已存在：${toPath}`);

  const fromStem = stemOf(fromPath);
  const toStem = stemOf(toPath);
  const { index: oldIndex } = await loadPathIndex(env);

  // 目标 stem 与既有文档重名 → 之后 [[stem]] 会歧义（Obsidian 同名解析为断链），直接拒绝
  if (toStem.toLowerCase() !== fromStem.toLowerCase()) {
    const clashes = (oldIndex.byStem.get(toStem.toLowerCase()) ?? []).filter((p) => p !== fromPath);
    if (clashes.length > 0) {
      throw new ApiError(409, `目标名 "${toStem}" 与既有文档重名（${clashes[0]}），链接会歧义；请换一个名字`);
    }
  }

  const { results: refRows } = await env.DB.prepare(
    `SELECT DISTINCT src_doc_id AS srcId FROM links WHERE dst_doc_id = ?`,
  )
    .bind(target.id)
    .all<{ srcId: number }>();

  // 含目标文档自己的自链接（[[自己]]）——它也要改写，否则移动后自链接断掉
  const targetRaw = rewriteWikilinks(target.raw, fromPath, fromPath, toPath, fromStem, toStem, oldIndex);

  const rewrittenDocs: { id: number; path: string; raw: string; hash: string }[] = [];
  for (const ref of refRows) {
    if (ref.srcId === target.id) continue; // 目标文档单独处理
    const doc = await env.DB.prepare('SELECT id, path, raw, body_hash FROM documents WHERE id = ?')
      .bind(ref.srcId)
      .first<{ id: number; path: string; raw: string; body_hash: string }>();
    if (!doc) continue;
    const nextRaw = rewriteWikilinks(doc.raw, doc.path, fromPath, toPath, fromStem, toStem, oldIndex);
    if (nextRaw !== doc.raw) rewrittenDocs.push({ id: doc.id, path: doc.path, raw: nextRaw, hash: doc.body_hash });
  }

  // 1) 目标文档换 path（单条语句）
  await env.DB.prepare('UPDATE documents SET path = ?, updated_at = ? WHERE id = ?')
    .bind(toPath, nowIso(), target.id)
    .run();

  const touched = [{ path: fromPath, raw: target.raw }, ...rewrittenDocs.map((d) => ({ path: d.path, raw: d.raw }))];
  try {
    // 2) 目标文档重新索引（含自链接改写）
    await putDocument(env, toPath, targetRaw, target.body_hash);
    // 3) 引用方改写正文并重新索引
    for (const doc of rewrittenDocs) {
      await putDocument(env, doc.path, doc.raw, doc.hash);
    }
    // 4) 全库重解析（同目录优先规则可能变化）
    const { unresolved } = await resolveAllLinks(env);
    return { from: fromPath, to: toPath, rewritten: rewrittenDocs.length, unresolved };
  } catch (err) {
    // 半途失败：尽力回滚（path 改回、touched 文档原文写回），再抛错
    await env.DB.prepare('UPDATE documents SET path = ? WHERE id = ?').bind(fromPath, target.id).run().catch(() => undefined);
    for (const doc of touched) {
      try {
        const cur = await env.DB.prepare('SELECT path, body_hash FROM documents WHERE path = ?')
          .bind(doc.path)
          .first<{ path: string; body_hash: string }>();
        if (!cur || cur.body_hash === '') {
          await putDocument(env, doc.path, doc.raw, '*');
        } else {
          await putDocument(env, doc.path, doc.raw, cur.body_hash);
        }
      } catch {
        /* best effort */
      }
    }
    await resolveAllLinks(env).catch(() => undefined);
    throw err;
  }
}

/**
 * 改写「指向目标文档」的 [[…]]：按解析结果判断（而不是只比较 stem），
 * 保留 ! 嵌入标记 / |别名 / #heading / #^block，按 line/col 精确 splice，并校验原文确实匹配。
 * 链接原来就带路径（dir/A）的，新目标写完整路径；否则写新 stem。
 */
function rewriteWikilinks(
  raw: string,
  srcPath: string,
  fromPath: string,
  toPath: string,
  fromStem: string,
  toStem: string,
  index: ReturnType<typeof buildLinkIndex>,
): string {
  void fromStem;
  const links = scanWikilinks(raw);
  const replacements: { start: number; length: number; text: string }[] = [];
  for (const link of links) {
    if (resolveWikilink(srcPath, link.target, index) !== fromPath) continue;
    const newTarget = link.target.includes('/') ? toPath : toStem;
    const suffixParts: string[] = [];
    if (link.alias) suffixParts.push(`|${link.alias}`);
    if (link.heading) suffixParts.push(`#${link.heading}`);
    if (link.block) suffixParts.push(`#^${link.block}`);
    const start = lineStartOffset(raw, link.line) + link.col - 1;
    const text = `${link.embed ? '!' : ''}[[${newTarget}${suffixParts.join('')}]]`;
    // 自校验：该位置确实是这条链接，否则拒绝改写（宁可报错也不写坏原文）
    if (raw.slice(start, start + link.raw.length) !== link.raw) {
      throw new ApiError(500, `rename 内部校验失败：${srcPath}:${link.line} 位置与原文不匹配`);
    }
    replacements.push({ start, length: link.raw.length, text });
  }
  if (replacements.length === 0) return raw;
  let out = raw;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.text + out.slice(r.start + r.length);
  }
  return out;
}

function lineStartOffset(raw: string, line: number): number {
  let idx = 0;
  for (let i = 1; i < line; i++) {
    const next = raw.indexOf('\n', idx);
    if (next < 0) return raw.length;
    idx = next + 1;
  }
  return idx;
}

/** 导出全库 md（zip 在 index.ts 层组；这里限制规模，避免内存爆掉）。 */
export async function exportAll(env: Env): Promise<{ path: string; raw: string }[]> {
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM documents').first<{ n: number }>();
  if ((count?.n ?? 0) > 20_000) throw new ApiError(413, '文档数过多，导出请改用 D1 备份流程');
  const { results } = await env.DB.prepare('SELECT path, raw FROM documents ORDER BY path').all<{
    path: string;
    raw: string;
  }>();
  return results;
}

export async function health(
  env: Env,
): Promise<{ ok: boolean; docs: number; tokenizerVersion: number; stale: number }> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM documents').first<{ n: number }>();
  const stale = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM documents WHERE indexed_hash IS NULL OR indexed_hash != body_hash',
  ).first<{ n: number }>();
  return { ok: true, docs: row?.n ?? 0, tokenizerVersion: TOKENIZER_VERSION, stale: stale?.n ?? 0 };
}

void dirOf;
