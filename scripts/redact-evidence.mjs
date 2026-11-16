#!/usr/bin/env node
/**
 * 把验收证据（`web/e2e/nav-check.mjs` 产出的 JSON）里的**真实笔记路径/标题**
 * 替换成 pseudonym（`dir-NN` / `doc-NN`），使证据可以进入公开仓库。
 *
 * 为什么需要：仓库是公开的，`vault-src/` 永不提交（见 `PUBLISHING.md`），
 * 而端到端证据天然携带 `fixture.tourDoc.path`、断言明细里的 DOM 文本等真实标题。
 * `scripts/check-private.mjs` 会拦下这些，所以证据提交前必须过一遍本脚本。
 *
 * 映射不做手工表：直接从本地 `vault-src/` 的目录结构生成（脚本本身不含任何真实标题），
 * 因此同一份 vault 上重复运行结果稳定，baseline / after 两份报告可继续逐条对比
 * （层级、同名冲突处数、断言数值都不变，只有路径字符串被换掉）。
 *
 * 用法：
 *   node scripts/redact-evidence.mjs --in raw.json --out docs/evidence/after-nav-check.json
 *   node scripts/redact-evidence.mjs --in raw.json --out out.json --vault ./vault-src
 *   node scripts/redact-evidence.mjs --in docs/evidence/x.json --check      # 只校验是否已干净（不改文件）
 *
 * `--check` 退出码：0 = 没有残留真实路径；1 = 仍能匹配到真实路径（或 vault 缺失）。
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

function parseArgs(argv) {
  const args = { vault: 'vault-src', check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--vault') args.vault = argv[++i];
    else if (a === '--check') args.check = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

/** 递归收集 vault 里的 `.md` 相对路径（不含扩展名，统一 `/`）。 */
function listDocs(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (name.toLowerCase().endsWith('.md')) {
        out.push(relative(root, abs).split(sep).join('/').replace(/\.md$/i, ''));
      }
    }
  };
  walk(root);
  return out.sort();
}

const utf8 = (p) => readFileSync(p, 'utf8');

/** 生成 [真实串, pseudonym] 替换表：越长越先替换，doc 优先于 dir。 */
function buildMap(docPaths) {
  const docSet = new Set(docPaths);
  const dirs = new Set();
  for (const p of docPaths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i += 1) dirs.add(segs.slice(0, i).join('/'));
  }

  const tokens = new Map();
  let d = 0;
  for (const p of [...dirs].filter((p) => !docSet.has(p)).sort()) {
    d += 1;
    tokens.set(p, `dir-${String(d).padStart(2, '0')}`);
  }
  let n = 0;
  for (const p of [...docSet].sort()) {
    n += 1;
    tokens.set(p, `doc-${String(n).padStart(2, '0')}`);
  }

  const pairs = [...tokens.entries()]
    .sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .flatMap(([real, token]) => {
      const forms = [[real, token]];
      const encoded = encodeURIComponent(real);
      if (encoded !== real) forms.push([encoded, token]);
      const encodedSeg = real
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/');
      if (encodedSeg !== real) forms.push([encodedSeg, token]);
      // 报告里的 `fixture.*.title`、`document.title`（「<标题> · 私有知识库」）只有
      // 文件名本身，没有目录前缀，所以 basename 也要有自己的替换项。
      const base = real.split('/').pop();
      if (base && base !== real) forms.push([base, token]);
      return forms;
    });
  return pairs.sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
}

function applyMap(text, pairs) {
  let out = text;
  for (const [real, token] of pairs) out = out.split(real).join(token);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.in || (!args.out && !args.check)) {
    console.log(
      [
        '用法：node scripts/redact-evidence.mjs --in <raw.json> --out <redacted.json> [--vault vault-src]',
        '      node scripts/redact-evidence.mjs --in <file> --check     # 校验是否已无真实路径',
      ].join('\n'),
    );
    process.exit(args.help ? 0 : 2);
  }

  const vaultRoot = resolve(args.vault);
  let docPaths;
  try {
    docPaths = listDocs(vaultRoot);
  } catch {
    console.error(`✖ 找不到 vault：${vaultRoot}（本脚本需要本地真实语料来推导映射，vault 不提交）`);
    process.exit(1);
  }
  if (docPaths.length === 0) {
    console.error(`✖ vault 里没有 .md：${vaultRoot}`);
    process.exit(1);
  }
  const pairs = buildMap(docPaths);

  const inputPath = resolve(args.in);
  const text = utf8(inputPath);

  if (args.check) {
    const leftovers = pairs
      .filter(([real]) => real.length >= 2)
      .map(([real]) => real)
      .filter((real, i, all) => all.indexOf(real) === i && text.includes(real));
    if (leftovers.length > 0) {
      console.error(`✖ ${args.in} 仍有 ${leftovers.length} 处真实路径/标题，例如：`);
      for (const s of leftovers.slice(0, 5)) console.error(`   ${s}`);
      process.exit(1);
    }
    console.log(`✓ ${args.in} 已 pseudonym 化（vault ${docPaths.length} 篇）`);
    return;
  }

  const redacted = applyMap(text, pairs);
  // 结构必须仍然是合法 JSON，且关键统计不变（只换字符串，不改判定）
  let before;
  let after;
  try {
    before = JSON.parse(text);
    after = JSON.parse(redacted);
  } catch (err) {
    console.error(`✖ 替换后不再是合法 JSON：${err.message}`);
    process.exit(1);
  }
  const summarize = (r) =>
    JSON.stringify({
      summary: r.summary,
      fatal: r.fatal,
      profiles: Object.fromEntries(
        Object.entries(r.profiles ?? {}).map(([k, v]) => [k, v.summary]),
      ),
    });
  if (summarize(before) !== summarize(after)) {
    console.error(`✖ 替换改变了判定结果：${summarize(before)} → ${summarize(after)}`);
    process.exit(1);
  }

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, redacted);
  const hits = pairs.filter(([real]) => redacted.includes(real)).length;
  if (hits > 0) {
    console.error(`✖ 输出仍残留 ${hits} 处真实路径，拒绝写入。`);
    process.exit(1);
  }
  console.log(`✓ ${args.out}（vault ${docPaths.length} 篇 → ${new Set(pairs.map((p) => p[1])).size} 个 pseudonym）`);
}

main();
