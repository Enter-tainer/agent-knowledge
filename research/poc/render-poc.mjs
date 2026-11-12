// POC: 用真实 vault 语料对比 markdown-it 与 remark(unified) 的解析能力
// 目的：1) 表格分隔行是单横线 `|-|-|`，主流解析器是否吃；2) 耗时；3) wikilink/callout 是否需自写插件
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/mgt/Desktop/proj/agent-knowledge/vault-src';
const walk = (d, a = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') walk(p, a); } else if (/\.md$/i.test(e.name)) a.push(p);
  }
  return a;
};
const files = walk(ROOT);
const docs = files.map((f) => ({ f: path.relative(ROOT, f).replace(/\\/g, '/'), t: fs.readFileSync(f, 'utf8') }));

// ---- markdown-it ----
const MarkdownIt = (await import('markdown-it')).default;
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
const t0 = performance.now();
const mi = docs.map(({ f, t }) => {
  const html = md.render(t);
  return { f, tables: (html.match(/<table\b/g) || []).length, blockquotes: (html.match(/<blockquote\b/g) || []).length, len: html.length };
});
const miMs = performance.now() - t0;

// ---- remark / unified ----
const { unified } = await import('unified');
const remarkParse = (await import('remark-parse')).default;
const remarkGfm = (await import('remark-gfm')).default;
const remarkRehype = (await import('remark-rehype')).default;
const rehypeStringify = (await import('rehype-stringify')).default;
const proc = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify);
const t1 = performance.now();
const rm = [];
for (const { f, t } of docs) {
  const html = String(await proc.process(t));
  rm.push({ f, tables: (html.match(/<table\b/g) || []).length, blockquotes: (html.match(/<blockquote\b/g) || []).length, len: html.length });
}
const rmMs = performance.now() - t1;

const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
console.log('files', docs.length, 'bytes', sum(docs.map((d) => ({ n: d.t.length })), 'n'));
console.log('markdown-it : tables', sum(mi, 'tables'), 'blockquotes', sum(mi, 'blockquotes'), 'ms', miMs.toFixed(1));
console.log('remark+gfm  : tables', sum(rm, 'tables'), 'blockquotes', sum(rm, 'blockquotes'), 'ms', rmMs.toFixed(1));
const diffs = mi.filter((x, i) => x.tables !== rm[i].tables).map((x, i) => x.f);
console.log('table-count diffs:', diffs.length ? diffs.slice(0, 5) : 'none');

// 单个 wl/callout 语法探针
const probe = '> [!tip] 一句话结论\n\n见 [[示例库]] 与 `[[不是链接]]`\n\n| a | b |\n|-|-|\n| 1 | 2 |\n';
const p1 = md.render(probe);
console.log('--- markdown-it probe ---');
console.log(JSON.stringify(p1.slice(0, 260)));
const p2 = String(await proc.process(probe));
console.log('--- remark probe ---');
console.log(JSON.stringify(p2.slice(0, 260)));
