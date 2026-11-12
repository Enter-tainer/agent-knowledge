#!/usr/bin/env node
// 开源前自检：扫描工作区里「会泄露私有语料」的痕迹。
// 用法：node scripts/check-private.mjs [--fix-hint]
// 退出码 1 = 有命中（不要直接 push）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'vault-src', '.wrangler', '.auth', '.reviews-tmp', '.scratch', 'dist', '.git', 'reviews', 'corpus']);
const SKIP_FILES = new Set(['scripts/check-private.mjs', 'PUBLISHING.md', 'pnpm-lock.yaml', 'research/bench/results.json']);
const TEXT_EXT = new Set(['.md', '.ts', '.mjs', '.js', '.json', '.toml', '.sql', '.yml', '.yaml', '.csv', '.txt', '.html', '.css']);

// 真实语料相关的特征（出现即视为「私有内容派生」）
const RULES = [
  { name: '本机绝对路径（用户名）', re: /[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]+/g },
  { name: '飞书 wiki token（真实链接）', re: /my\.feishu\.cn\/wiki\/[A-Za-z0-9]{10,}/g },
  { name: '个人 gist 外链', re: /gist\.github\.com\/[A-Za-z0-9_-]+/g },
  { name: '真实笔记路径（案例库/）', re: /案例库\//g },
  { name: '真实笔记标题片段', re: /(汉王 N10|乐普 ER1|作业帮|豆包输入法|ARKit 面部|逆向知识库)/g },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).split('\\').join('/');
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* walk(full);
    } else if (TEXT_EXT.has(name.slice(name.lastIndexOf('.'))) && !SKIP_FILES.has(rel)) {
      yield full;
    }
  }
}

let hits = 0;
const byRule = new Map();
for (const file of walk(ROOT)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const rel = relative(ROOT, file).split('\\').join('/');
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(lines[i]);
      if (!m) continue;
      hits++;
      const masked = m[0].length > 28 ? `${m[0].slice(0, 12)}…${m[0].slice(-6)}` : m[0];
      console.log(`✖ [${rule.name}] ${rel}:${i + 1}  ${masked}`);
      byRule.set(rule.name, (byRule.get(rule.name) ?? 0) + 1);
      break;
    }
  }
}

if (hits === 0) {
  console.log('✓ 没有发现私有语料痕迹，可以 push。');
  process.exit(0);
}

console.log(`\n共 ${hits} 处命中：`);
for (const [name, n] of byRule) console.log(`  - ${name}: ${n}`);
console.log(`
处理建议（见 PUBLISHING.md）：
  · research/corpus/、research/bench/results.json、reviews/ux-shots/ 默认已被 .gitignore 排除；
  · docs/TECH-69-67-plan.md 里的真实路径示例换成占位名；
  · 如果要公开 research/reviews 正文，先做 pseudonym 化（把笔记路径换成 doc-NN）。`);
process.exit(1);
