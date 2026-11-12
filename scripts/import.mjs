// 导入 vault-src/ 并做对账（正文逐字节、双链解析数、每篇入链数）
// 用法：node scripts/import.mjs [--vault vault-src] [--base http://127.0.0.1:8787] [--no-verify]
// 语义：已存在且内容相同 → 跳过；已存在但内容不同 → 用 If-Match: <hash> 覆盖；不存在 → If-Match: *
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { api, apiJson, docUrl } from './_http.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const VAULT = path.resolve(flag('--vault', 'vault-src'));
const VERIFY = !args.includes('--no-verify');
const LINKS_CSV = path.resolve('research/corpus/links.csv');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.obsidian') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

async function main() {
  console.log(`import → ${BASE_LABEL()}  vault=${VAULT}`);
  const files = walk(VAULT);
  if (files.length === 0) throw new Error('vault 里没有 md 文件');

  const docs = files.map((file) => {
    const rel = path.relative(VAULT, file).split(path.sep).join('/');
    return { docPath: rel.replace(/\.md$/i, ''), raw: readFileSync(file, 'utf8') };
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const doc of docs) {
    const cur = await api(docUrl(doc.docPath));
    let ifMatch;
    if (cur.status === 200) {
      const body = await cur.json();
      if (body.raw === doc.raw) {
        skipped++;
        continue;
      }
      ifMatch = body.hash;
    } else if (cur.status === 404) {
      ifMatch = '*';
    } else {
      throw new Error(`GET ${doc.docPath} → ${cur.status} ${await cur.text()}`);
    }
    const res = await api(docUrl(doc.docPath), {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': ifMatch },
      body: doc.raw,
    });
    if (!res.ok) throw new Error(`PUT ${doc.docPath} → ${res.status} ${await res.text()}`);
    if (ifMatch === '*') created++;
    else updated++;
  }
  console.log(`写入完成：新建 ${created}，覆盖 ${updated}，跳过（内容未变）${skipped}`);

  const resolved = await apiJson('/api/admin/resolve-links', { method: 'POST' });
  console.log(`resolve-links: total=${resolved.body.total} unresolved=${resolved.body.unresolved}`);

  if (!VERIFY) return;

  // 1) 正文逐字节一致
  const exported = await apiJson('/api/export?format=json');
  const byPath = new Map(exported.body.documents.map((d) => [d.path, d.raw]));
  let byteMismatch = 0;
  for (const doc of docs) {
    if (!byPath.has(doc.docPath)) {
      console.error(`缺少文档：${doc.docPath}`);
      byteMismatch++;
      continue;
    }
    if (Buffer.from(byPath.get(doc.docPath), 'utf8').compare(Buffer.from(doc.raw, 'utf8')) !== 0) {
      console.error(`正文不一致：${doc.docPath}`);
      byteMismatch++;
    }
  }
  if (byteMismatch) throw new Error(`${byteMismatch} 篇正文不一致`);
  console.log(`正文对账通过：${docs.length} 篇逐字节一致`);

  // 2) 断链 0
  const report = await apiJson('/api/reports/links?unresolved=1');
  if (report.body.unresolved.length !== 0) {
    console.error(report.body.unresolved.slice(0, 5));
    throw new Error(`断链数 = ${report.body.unresolved.length}，期望 0`);
  }
  console.log('断链 0 通过');

  // 3) 双链总数与每篇入链数对照 links.csv
  const links = parseCsv(readFileSync(LINKS_CSV, 'utf8'));
  const internal = links.filter((l) => l.form === 'wikilink' && l.scope === 'body' && l.resolved === 'true');
  console.log(`links.csv 内部双链：${internal.length}（期望 163）`);
  if (internal.length !== 163) throw new Error(`内部双链数 ${internal.length} ≠ 163`);

  const expectedDst = new Map();
  const expectedSrc = new Map();
  for (const l of internal) {
    const dst = l.resolvedPath.replace(/\.md$/i, '');
    const src = l.from.replace(/\.md$/i, '');
    expectedDst.set(dst, (expectedDst.get(dst) ?? 0) + 1);
    expectedSrc.set(src, (expectedSrc.get(src) ?? 0) + 1);
  }

  let outgoingMismatch = 0;
  for (const [src, expected] of expectedSrc) {
    const res = await apiJson(`/api/docs/${encodeURIComponent(src)}/links`);
    if (res.body.links.length !== expected) {
      console.error(`出链数不一致 ${src}: api=${res.body.links.length} csv=${expected}`);
      outgoingMismatch++;
    }
  }
  if (outgoingMismatch) throw new Error(`${outgoingMismatch} 篇出链数不一致`);

  let backlinkMismatch = 0;
  for (const [dst, expected] of expectedDst) {
    const res = await apiJson(`/api/docs/${encodeURIComponent(dst)}/backlinks`);
    const mentions = res.body.backlinks.reduce((n, b) => n + b.count, 0);
    if (mentions !== expected) {
      console.error(`入链数不一致 ${dst}: api=${mentions} csv=${expected}`);
      backlinkMismatch++;
    }
  }
  if (backlinkMismatch) throw new Error(`${backlinkMismatch} 篇入链数不一致`);

  console.log(`双链/反链对账通过：${expectedSrc.size} 篇出链、${expectedDst.size} 个目标入链全部一致`);
  console.log('IMPORT OK');
}

function BASE_LABEL() {
  return process.env.KB_BASE ?? 'http://127.0.0.1:8787';
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
