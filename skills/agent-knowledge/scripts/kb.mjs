#!/usr/bin/env node
// kb.mjs — agent-knowledge 读写命令行。复用 scripts/_http.mjs（重试 / token 续期 / service token）。
// 在仓库根目录运行：
//   node skills/agent-knowledge/scripts/kb.mjs health
//   KB_BASE=https://kb.example.com node skills/agent-knowledge/scripts/kb.mjs search '关键词'
import { readFileSync, writeFileSync } from 'node:fs';
import { api, apiJson, BASE, docUrl } from './http.mjs';

const [cmd, ...args] = process.argv.slice(2);

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v));
const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

/** 读 doc，返回 null 表示不存在。 */
async function readDoc(path) {
  try {
    return (await apiJson(docUrl(path))).body;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

const commands = {
  async health() {
    out((await apiJson('/api/health')).body);
  },

  async tree(prefix = '', limit = '500') {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (prefix) qs.set('prefix', prefix);
    out((await apiJson(`/api/tree?${qs}`)).body);
  },

  async get(path) {
    if (!path) die('用法: kb.mjs get <path>');
    out((await apiJson(docUrl(path))).body);
  },

  async search(q, limit = '10') {
    if (!q) die('用法: kb.mjs search <关键词> [limit]');
    const qs = new URLSearchParams({ q, limit: String(limit) });
    out((await apiJson(`/api/search?${qs}`)).body);
  },

  async backlinks(path) {
    if (!path) die('用法: kb.mjs backlinks <path>');
    out((await apiJson(`${docUrl(path)}/backlinks`)).body);
  },

  async links(path) {
    if (!path) die('用法: kb.mjs links <path>');
    out((await apiJson(`${docUrl(path)}/links`)).body);
  },

  /** put <path> <file>：不存在→If-Match: *，存在→If-Match: <hash> */
  async put(path, file) {
    if (!path || !file) die('用法: kb.mjs put <path> <file>');
    const body = readFileSync(file);
    const existing = await readDoc(path);
    const ifMatch = existing?.hash ? existing.hash : '*';
    const res = await apiJson(docUrl(path), {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown', 'if-match': ifMatch },
      body,
    });
    out(res.body);
  },

  async del(path) {
    if (!path) die('用法: kb.mjs del <path>');
    out((await apiJson(`${docUrl(path)}?force=1`, { method: 'DELETE' })).body);
  },

  async rename(path, to) {
    if (!path || !to) die('用法: kb.mjs rename <path> <新path>');
    const res = await apiJson(`${docUrl(path)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    out(res.body);
  },

  /** export [zip|json] [outfile] */
  async export(format = 'zip', file) {
    const res = await api(`/api/export?format=${encodeURIComponent(format)}`);
    if (!res.ok) die(`导出失败：HTTP ${res.status} ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const target = file ?? `kb-export.${format === 'json' ? 'json' : 'zip'}`;
    writeFileSync(target, buf);
    out(`已保存 ${target}（${buf.length} bytes）`);
  },

  async reindex() {
    out((await apiJson('/api/admin/reindex', { method: 'POST' })).body);
  },
};

const usage = `用法: node skills/agent-knowledge/scripts/kb.mjs <命令> [参数]

  health                        健康检查（docs / stale）
  tree [prefix] [limit]         列目录
  get <path>                    读一篇（raw / frontmatter / hash）
  search <关键词> [limit]        检索（中文 ≥2 字；score 为 bm25 负数）
  backlinks <path>              反链
  links <path>                  出链
  put <path> <file>             新建或覆盖（自动选 If-Match）
  del <path>                    删除（force=1）
  rename <path> <新path>         改路径并全库改写引用
  export [zip|json] [outfile]   导出全库
  reindex                       重建索引

path 是 vault 相对路径、不带 .md。
base URL：KB_BASE（缺省 http://127.0.0.1:8787，即本地 wrangler dev）。
凭据：.auth/oauth.json（Managed OAuth，自动续期）或 KB_ACCESS_CLIENT_ID / KB_ACCESS_CLIENT_SECRET，或 KB_OAUTH_TOKEN。
当前 base：${BASE}`;

const fn = commands[cmd];
if (!fn) {
  console.error(usage);
  process.exit(2);
}

try {
  await fn(...args);
} catch (err) {
  console.error(`✖ ${err.status ? `HTTP ${err.status} ` : ''}${err.message}`);
  process.exitCode = 1;
}
