import type { KbApi } from './contract';
import {
  ConflictError,
  NotFoundError,
  NotModifiedError,
  PreconditionRequiredError,
} from './errors';

// 语料以 .md 原文放在 src/mock/notes/ 下，用 Vite 的 ?raw 导入（build 时内联成字符串）。
const NOTE_MODULES = import.meta.glob('../mock/notes/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function note(name: string): string {
  const key = `../mock/notes/${name}.md`;
  const raw = NOTE_MODULES[key];
  if (typeof raw !== 'string') {
    throw new Error(`mock 笔记缺失：${name}（期望 ${key}）`);
  }
  return raw;
}
import type {
  AllLinksEntry,
  BacklinksResponse,
  Doc,
  HealthResponse,
  LinkRef,
  LinksReport,
  LinksResponse,
  OrphansResponse,
  ReindexResult,
  RenameResult,
  SearchHit,
  SearchResponse,
  TreeEntry,
  UnresolvedLink,
  UpdateResult,
} from './types';

/**
 * 本地 mock：5 篇假笔记，实现与 httpApi 完全相同的契约。
 * 目的是「没有后端也能 pnpm dev 看 UI」；不是后端逻辑的复刻（分词、切片、rename 改写都做了简化）。
 */

interface Frontmatter {
  title: string;
  tags: string[];
  updated: string | null;
}

interface MockRecord {
  path: string;
  raw: string;
  hash: string;
  revision: number;
  updated: string;
  title: string;
  tags: string[];
}

function parseFrontmatter(raw: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { title: '', tags: [], updated: null };
  const yaml = m[1];

  const titleMatch = /^title:\s*(.*)$/m.exec(yaml);
  const title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : '';

  const tags: string[] = [];
  const inlineTags = /^tags:\s*\[(.*)\]\s*$/m.exec(yaml);
  if (inlineTags) {
    for (const part of inlineTags[1].split(',')) {
      const t = part.trim().replace(/^["']|["']$/g, '');
      if (t) tags.push(t);
    }
  } else {
    const block = /^tags:\s*\r?\n((?:[ \t]+-.*(?:\r?\n|$))*)/m.exec(yaml);
    if (block) {
      for (const line of block[1].split(/\r?\n/)) {
        const t = /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(line);
        if (t) tags.push(t[1].replace(/^["']|["']$/g, ''));
      }
    }
  }

  const updatedMatch = /^updated:\s*(.*)$/m.exec(yaml);
  const updated = updatedMatch ? updatedMatch[1].trim().replace(/^["']|["']$/g, '') : null;
  return { title, tags, updated };
}

function stripFrontmatter(raw: string): string {
  const s = raw.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

function firstHeading(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function deriveTitle(path: string, raw: string): string {
  const fm = parseFrontmatter(raw);
  return fm.title || firstHeading(stripFrontmatter(raw)) || lastSegment(path);
}

/** 两个 FNV-1a 拼成 16 位十六进制串；只用于 mock 的乐观锁标识，不追求抗碰撞。 */
function hashRaw(raw: string): string {
  const fnv = (seed: number, step: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, step) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(0x811c9dc5, 0x01000193);
  const b = fnv(0x01000193, 0x811c9dc5);
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

const SEED: Array<{ path: string; raw: string; updated: string }> = [
  { path: '示例索引', raw: note('index'), updated: '2026-11-12T09:00:00.000Z' },
  { path: '示例库/示例设备 A 逆向', raw: note('n10'), updated: '2026-11-10T13:20:00.000Z' },
  {
    path: '示例库/示例设备 A 逆向/压感与笔输入',
    raw: note('pen'),
    updated: '2026-11-09T08:10:00.000Z',
  },
  { path: '示例库/示例设备 B 逆向', raw: note('er1'), updated: '2026-11-11T17:45:00.000Z' },
  { path: '草稿/未归档的笔记', raw: note('draft'), updated: '2026-10-28T10:00:00.000Z' },
];

const records = new Map<string, MockRecord>();

for (const item of SEED) {
  const fm = parseFrontmatter(item.raw);
  records.set(item.path, {
    path: item.path,
    raw: item.raw,
    hash: hashRaw(item.raw),
    revision: 1,
    updated: item.updated,
    title: deriveTitle(item.path, item.raw),
    tags: fm.tags,
  });
}

/** 已知的 mock 使保存有个先后顺序，便于复现 412。 */
let revisionClock = SEED.length;

function toDoc(rec: MockRecord): Doc {
  return {
    path: rec.path,
    title: rec.title,
    tags: rec.tags,
    hash: rec.hash,
    revision: rec.revision,
    updated: rec.updated,
    raw: rec.raw,
  };
}

function getRecord(path: string): MockRecord {
  const rec = records.get(path);
  if (!rec) throw new NotFoundError(`文档不存在：${path}`);
  return rec;
}

const LINK_RE = /\[\[([^[\]|#]+)(?:#[^[\]]*)?(?:\|[^[\]]*)?\]\]/g;

interface ScannedLink {
  target: string;
  line: number;
}

function scanLinks(raw: string): ScannedLink[] {
  const out: ScannedLink[] = [];
  const lines = raw.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 与后端 §6.2 口径一致：行内代码里的 `[[…]]` 不算链接
    const scanText = line.replace(/`[^`]*`/g, '');
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(scanText)) !== null) {
      const target = m[1].trim();
      if (target) out.push({ target, line: i + 1 });
    }
  }
  return out;
}

function resolveTarget(target: string): string | null {
  const t = target.trim().toLowerCase();
  for (const rec of records.values()) {
    if (rec.path.toLowerCase() === t) return rec.path;
  }
  for (const rec of records.values()) {
    if (lastSegment(rec.path).toLowerCase() === t) return rec.path;
  }
  for (const rec of records.values()) {
    if (rec.title.toLowerCase() === t) return rec.path;
  }
  return null;
}

function allRecordsSorted(): MockRecord[] {
  return [...records.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
}

function treeEntries(): TreeEntry[] {
  return allRecordsSorted().map((rec) => ({
    path: rec.path,
    title: rec.title,
    tags: rec.tags.slice(),
    size: new TextEncoder().encode(rec.raw).length,
    updated: rec.updated,
  }));
}

function cleanLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^\[![^\]]+\]\s*/, '')
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .replace(/\|/g, ' · ')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\[\[([^[\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeSnippet(line: string, tokens: string[]): string {
  const text = cleanLine(line);
  if (!text) return '';
  let at = -1;
  const lower = text.toLowerCase();
  for (const t of tokens) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const width = 120;
  if (text.length <= width || at === -1) return text.length <= width ? text : `${text.slice(0, width)}…`;
  const start = Math.max(0, Math.min(at - 30, text.length - width));
  const prefix = start > 0 ? '…' : '';
  const suffix = start + width < text.length ? '…' : '';
  return `${prefix}${text.slice(start, start + width)}${suffix}`;
}

function searchDocs(query: string, limit: number): SearchResponse {
  const q = query.trim();
  if (!q) return { query: q, results: [] };
  const tokens = q.split(/\s+/).filter(Boolean);
  const results: SearchHit[] = [];

  for (const rec of allRecordsSorted()) {
    const body = stripFrontmatter(rec.raw);
    const lowerBody = body.toLowerCase();
    const lowerTitle = rec.title.toLowerCase();

    // AND 语义：每个 token 都要在标题/正文里出现
    if (!tokens.every((t) => lowerBody.includes(t.toLowerCase()) || lowerTitle.includes(t.toLowerCase()))) {
      continue;
    }

    const lines = body.split(/\r?\n/);
    let heading = '';
    let hitHeading = '';
    let snippet = '';
    let bodyHits = 0;

    for (const line of lines) {
      const h = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (h) {
        heading = h[1];
        continue;
      }
      const lower = line.toLowerCase();
      const token = tokens.find((t) => lower.includes(t.toLowerCase()));
      if (!token) continue;
      bodyHits += 1;
      if (!snippet) {
        snippet = makeSnippet(line, tokens);
        hitHeading = heading;
      }
    }

    let score = 0;
    if (tokens.some((t) => lowerTitle.includes(t.toLowerCase()))) score += 6;
    if (hitHeading && tokens.some((t) => hitHeading.toLowerCase().includes(t.toLowerCase()))) score += 2;
    score += Math.min(bodyHits, 12) * 0.25;
    if (!snippet) {
      // 标题命中时：优先取「第一个含关键词的正文行」，否则取第一段正文
      const bodyLineIdx = lines.findIndex(
        (l) => !/^#{1,6}\s+/.test(l) && l.toLowerCase().includes(tokens[0].toLowerCase()),
      );
      if (bodyLineIdx !== -1) {
        snippet = makeSnippet(lines[bodyLineIdx], tokens);
      } else {
        const firstText = lines.find((l) => {
          if (!l.trim() || /^#{1,6}\s+/.test(l) || /^\s*\|?[\s:|-]+\|?\s*$/.test(l)) return false;
          if (l.includes('[!')) return false;
          return cleanLine(l).length >= 6;
        });
        snippet = makeSnippet(firstText ?? '', tokens);
      }
    }

    const highlights = tokens.filter((t) => snippet.toLowerCase().includes(t.toLowerCase()));
    results.push({
      path: rec.path,
      title: rec.title,
      heading: hitHeading,
      score: Math.round(score * 100) / 100,
      snippet,
      highlights: highlights.length ? highlights : [q],
    });
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'zh-Hans-CN'));
  return { query: q, results: results.slice(0, Math.max(1, limit)) };
}

function backlinksOf(path: string): BacklinksResponse {
  const counts = new Map<string, number>();
  for (const rec of records.values()) {
    if (rec.path === path) continue;
    for (const link of scanLinks(rec.raw)) {
      if (resolveTarget(link.target) === path) {
        counts.set(rec.path, (counts.get(rec.path) ?? 0) + 1);
      }
    }
  }
  return {
    path,
    backlinks: [...counts.entries()]
      .map(([src, count]) => ({ path: src, title: records.get(src)?.title ?? lastSegment(src), count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, 'zh-Hans-CN')),
  };
}

function linksOf(path: string): LinksResponse {
  const rec = getRecord(path);
  const links: LinkRef[] = scanLinks(rec.raw).map((link) => {
    const dstPath = resolveTarget(link.target);
    return { target: link.target, resolved: dstPath !== null, dstPath, line: link.line };
  });
  return { path, links };
}

export const mockApi: KbApi = {
  async health(): Promise<HealthResponse> {
    return { ok: true, tokenizerVersion: 1, docs: records.size, stale: 0 };
  },

  async tree(params = {}): Promise<TreeEntry[]> {
    const prefix = params.prefix ?? '';
    const limit = params.limit ?? 500;
    const entries = treeEntries().filter((e) => (prefix ? e.path.startsWith(prefix) : true));
    return entries.slice(0, limit);
  },

  async getDoc(path, ifNoneMatch): Promise<Doc> {
    const rec = getRecord(path);
    if (ifNoneMatch && ifNoneMatch === rec.hash) throw new NotModifiedError(rec.hash);
    return toDoc(rec);
  },

  async putDoc(path, raw, ifMatch): Promise<UpdateResult> {
    const existing = records.get(path);
    // 与后端严格语义保持一致：已存在文档必须带当前 hash（`*` 只用于新建），缺失 → 428，不匹配 → 412。
    if (existing) {
      if (!ifMatch) {
        throw new PreconditionRequiredError('修改已存在文档必须带 If-Match: <hash>（先用 GET 拿 hash）');
      }
      if (ifMatch === '*') {
        throw new PreconditionRequiredError('If-Match: * 只用于新建；修改请带当前 hash');
      }
      if (ifMatch !== existing.hash) {
        throw new ConflictError('hash mismatch（文件已被修改，请先重新加载）');
      }
    } else if (ifMatch !== '*') {
      throw new PreconditionRequiredError('新建文档需要 If-Match: *');
    }

    const fm = parseFrontmatter(raw);
    const rec: MockRecord = {
      path,
      raw,
      hash: hashRaw(raw),
      revision: existing ? existing.revision + 1 : ++revisionClock,
      updated: new Date().toISOString(),
      title: deriveTitle(path, raw),
      tags: fm.tags,
    };
    records.set(path, rec);
    return { path: rec.path, hash: rec.hash, revision: rec.revision };
  },

  async rename(path, to): Promise<RenameResult> {
    const rec = getRecord(path);
    const oldStem = lastSegment(path);
    const newStem = lastSegment(to);
    let rewritten = 0;
    for (const other of records.values()) {
      if (other.path === path) continue;
      const updatedRaw = other.raw.replace(
        new RegExp(`\\[\\[${escapeRe(oldStem)}(\\|[^\\]]*)?\\]\\]`, 'g'),
        (_all, suffix?: string) => {
          rewritten += 1;
          return `[[${newStem}${suffix ?? ''}]]`;
        },
      );
      if (updatedRaw !== other.raw) {
        other.raw = updatedRaw;
        other.hash = hashRaw(updatedRaw);
        other.revision += 1;
      }
    }
    records.delete(path);
    rec.path = to;
    rec.hash = hashRaw(rec.raw);
    rec.revision += 1;
    records.set(to, rec);
    return { from: path, to, rewritten };
  },

  async search(query, limit = 10): Promise<SearchResponse> {
    return searchDocs(query, limit);
  },

  async backlinks(path): Promise<BacklinksResponse> {
    getRecord(path);
    return backlinksOf(path);
  },

  async links(path): Promise<LinksResponse> {
    return linksOf(path);
  },

  async reportLinks(unresolvedOnly = true): Promise<LinksReport> {
    const all: AllLinksEntry[] = [];
    for (const rec of allRecordsSorted()) {
      for (const link of scanLinks(rec.raw)) {
        const dstPath = resolveTarget(link.target);
        all.push({
          src: rec.path,
          title: rec.title,
          target: link.target,
          line: link.line,
          resolved: dstPath !== null,
          dstPath,
        });
      }
    }
    if (!unresolvedOnly) return { links: all, count: all.length };

    const unresolved: UnresolvedLink[] = all
      .filter((l) => !l.resolved)
      .map(({ src, title, target, line }) => ({ src, title, target, line }));
    return { unresolved, count: unresolved.length };
  },

  async reindex(): Promise<ReindexResult> {
    return { documents: records.size, chunks: records.size, stale: 0, orphansRemoved: 0 };
  },

  async orphans(): Promise<OrphansResponse> {
    const orphans = allRecordsSorted()
      .filter((rec) => backlinksOf(rec.path).backlinks.length === 0)
      .map((rec) => ({ path: rec.path, title: rec.title }));
    return { orphans };
  },

  async exportZip(): Promise<Blob> {
    // mock 不做真 zip：返回一个可下载的纯文本占位（README 已知限制里写明）。
    const parts = allRecordsSorted().map((rec) => `===== ${rec.path}.md =====\n${rec.raw}`);
    return new Blob([parts.join('\n\n')], { type: 'text/plain; charset=utf-8' });
  },
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
