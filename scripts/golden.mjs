// golden set 检索验收：用 research/bench/results.json 里的 55 条查询，对运行中的 API 打分
// 用法：node scripts/golden.mjs [--golden research/bench/results.json] [--base ...]
import { readFileSync } from 'node:fs';
import { apiJson } from './_http.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const GOLDEN = flag('--golden', 'research/bench/results.json');

const stripMd = (p) => p.replace(/\.md$/i, '');
const data = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const queries = data.queries ?? [];
if (queries.length === 0) throw new Error('results.json 里没有 queries');

const stats = {
  positives: 0,
  negatives: 0,
  hit1: 0,
  hit3: 0,
  hit5: 0,
  canonical1: 0,
  canonical3: 0,
  canonical5: 0,
  falsePositives: 0,
  shortCjkOk: 0,
  shortCjkTotal: 0,
  snippetOk: 0,
  snippetTotal: 0,
  misses: [],
};
const byCategory = new Map();

async function main() {
  for (const q of queries) {
    const isShortCjk = q.category === 'cjk_1char';
    const res = await apiJson(`/api/search?q=${encodeURIComponent(q.query)}&limit=20`);
    const body = res.body;
    const results = (body.results ?? []).map((r) => ({ ...r, path: stripMd(r.path) }));
    const gt = new Set((q.gt ?? []).map(stripMd));
    const canonical = q.canonical ? stripMd(q.canonical) : null;

    let cat = byCategory.get(q.category);
    if (!cat) {
      cat = { total: 0, hit1: 0, hit5: 0, canonical1: 0 };
      byCategory.set(q.category, cat);
    }
    cat.total++;

    if (isShortCjk) {
      stats.shortCjkTotal++;
      if (typeof body.note === 'string' && body.note.includes('至少输入 2 个字')) stats.shortCjkOk++;
      continue;
    }

    if (gt.size === 0) {
      stats.negatives++;
      if (results.length !== 0) {
        stats.falsePositives++;
        console.error(`误报：${q.query} → ${results.slice(0, 3).map((r) => r.path)}`);
      }
      continue;
    }

    stats.positives++;
    const hitAt = (k) => results.slice(0, k).some((r) => gt.has(r.path));
    const rankOf = (k) => results.slice(0, k).some((r) => r.path === canonical);

    const h1 = hitAt(1);
    const h3 = hitAt(3);
    const h5 = hitAt(5);
    if (h1) stats.hit1++;
    if (h3) stats.hit3++;
    if (h5) stats.hit5++;
    cat.hit1 += h1 ? 1 : 0;
    cat.hit5 += h5 ? 1 : 0;
    if (rankOf(1)) {
      stats.canonical1++;
      cat.canonical1++;
    }
    if (rankOf(3)) stats.canonical3++;
    if (rankOf(5)) stats.canonical5++;
    if (!h5) {
      stats.misses.push({ query: q.query, category: q.category, canonical, top: results.slice(0, 3).map((r) => r.path) });
    }
    if (canonical && !rankOf(1)) {
      const idx = results.findIndex((r) => r.path === canonical);
      if (idx >= 0 && q.category === 'cjk_4char') {
        // 记录但不算错
      }
    }

    // 摘要质量：top-1 的 snippet/highlights 至少要包含一个查询词
    if (results[0]) {
      stats.snippetTotal++;
      const top = results[0];
      const terms = q.query.split(/\s+/).filter(Boolean);
      const text = `${top.snippet ?? ''} ${(top.highlights ?? []).join(' ')}`.toLowerCase();
      if ((top.highlights ?? []).length > 0 || terms.some((t) => text.includes(t.toLowerCase()))) {
        stats.snippetOk++;
      } else {
        console.error(`摘要不含查询词：${q.query} → ${top.path}「${(top.snippet ?? '').slice(0, 60)}」`);
      }
    }
  }

  const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
  console.log('\n=== golden set 结果 ===');
  console.log(`正查询 ${stats.positives} / 负查询 ${stats.negatives}`);
  console.log(`hit@1 ${pct(stats.hit1, stats.positives)}  hit@3 ${pct(stats.hit3, stats.positives)}  hit@5 ${pct(stats.hit5, stats.positives)}`);
  console.log(
    `canonical@1 ${pct(stats.canonical1, stats.positives)}  canonical@3 ${pct(stats.canonical3, stats.positives)}  canonical@5 ${pct(stats.canonical5, stats.positives)}`,
  );
  console.log(`负查询误报：${stats.falsePositives}`);
  console.log(`1 字中文提示：${stats.shortCjkOk}/${stats.shortCjkTotal}`);
  console.log(`摘要含查询词：${pct(stats.snippetOk, stats.snippetTotal)}（${stats.snippetOk}/${stats.snippetTotal}）`);
  console.log('\n分类：');
  for (const [name, c] of byCategory) {
    console.log(`  ${name.padEnd(18)} n=${String(c.total).padStart(2)}  hit@1 ${pct(c.hit1, c.total)}  hit@5 ${pct(c.hit5, c.total)}  canonical@1 ${pct(c.canonical1, c.total)}`);
  }
  if (stats.misses.length) {
    console.log('\n未命中：');
    for (const m of stats.misses) console.log(`  ${m.query} [${m.category}] top=${m.top.join(' | ')}`);
  }

  const failures = [];
  const positivesWithoutShort = stats.positives; // 已排除 cjk_1char
  if (stats.hit5 !== positivesWithoutShort) failures.push(`hit@5 ${stats.hit5}/${positivesWithoutShort}，期望全中`);
  if (stats.falsePositives !== 0) failures.push(`负查询误报 ${stats.falsePositives}`);
  if (stats.shortCjkOk !== stats.shortCjkTotal) failures.push('1 字中文没有返回提示');
  const snippetRate = stats.snippetTotal ? stats.snippetOk / stats.snippetTotal : 1;
  if (snippetRate < 0.9) failures.push(`摘要含查询词 ${snippetRate.toFixed(3)} < 0.90`);
  const c1 = stats.positives ? stats.canonical1 / stats.positives : 0;
  const c3 = stats.positives ? stats.canonical3 / stats.positives : 0;
  if (c1 < 0.65) failures.push(`canonical@1 ${c1.toFixed(3)} < 0.65`);
  if (c3 < 0.9) failures.push(`canonical@3 ${c3.toFixed(3)} < 0.90`);

  if (failures.length) {
    console.error('\nGOLDEN FAIL:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nGOLDEN OK');
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
