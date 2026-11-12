// 正确性回归（安全 review 的 P0/P1 专项 + rename 边界）
// 用法：node scripts/regression.mjs [--base ...]
import { api, apiJson, assert, cleanup, docUrl } from './_http.mjs';

const P = `_reg/reg-${Date.now()}`;
let failures = 0;
const expect = (name, cond) => {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${name}`);
  } else console.log(`ok  ${name}`);
};

async function put(path, raw, ifMatch = '*') {
  return api(docUrl(path), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': ifMatch },
    body: raw,
  });
}

function bigDoc(chunkCount) {
  // 每个 heading 强制切一个新 chunk；再保证总字节数在 1.5MB 内
  const parts = ['# big\n'];
  for (let i = 0; i < chunkCount; i++) {
    parts.push(`## section ${i}\n\n${'内容'.repeat(20)}${i}\n`);
  }
  return parts.join('\n');
}

async function main() {
  // ---------- P0-1：>1000 chunk 的大文档不能撞后续文档的 chunk id ----------
  const big = bigDoc(1200);
  const resBig = await put(`${P}/big`, big);
  expect(`大文档（1200 chunk，${Math.round(big.length / 1024)}KB）写入 200`, resBig.status === 200);
  const bigBody = await resBig.json();
  expect(`大文档 chunks >= 1200（实际 ${bigBody.chunks}）`, bigBody.chunks >= 1200);

  const resAfter = await put(`${P}/after`, '# after\n\n普通文档。\n');
  expect('大文档之后新建普通文档 200（不再撞 doc_chunks.id）', resAfter.status === 200);

  // ---------- P0-2：并发新建不同 path 全部成功 ----------
  const creates = await Promise.all(
    Array.from({ length: 8 }, (_, i) => put(`${P}/conc-${i}`, `# conc ${i}\n\n内容 ${i}\n`)),
  );
  const okCount = creates.filter((r) => r.status === 200).length;
  expect(`8 个并发新建全部 200（实际 ${okCount}/8）`, okCount === 8);

  // ---------- P1：CAS 失败无副作用 ----------
  const doc = await apiJson(docUrl(`${P}/conc-0`));
  const goodHash = doc.body.hash;
  const stale = await put(`${P}/conc-0`, '# stale\n', goodHash.replace(/^./, '0'));
  expect('错误 hash → 412', stale.status === 412);
  const after412 = await apiJson(docUrl(`${P}/conc-0`));
  expect('412 后 hash/正文均未变', after412.body.hash === goodHash && !!after412.body.raw.includes('conc 0'));
  const okUpdate = await put(`${P}/conc-0`, '# conc 0 v2\n', goodHash);
  expect('正确 hash 更新 200', okUpdate.status === 200);
  // 标准 ETag 形态 If-Match: "<hash>"（agent-UX review P0：之前必 412）
  const quotedDoc = await apiJson(docUrl(`${P}/conc-0`));
  const quoted = await put(`${P}/conc-0`, '# conc 0 v3\n', `"${quotedDoc.body.hash}"`);
  expect('If-Match 带引号（标准 ETag 形态）200', quoted.status === 200);

  // ---------- rename 全形态（含 emoji 行内代码、嵌入） ----------
  await put(`${P}/T`, '# T\n\n目标。\n');
  const linksDoc = [
    '# links',
    '',
    `裸 stem：[[T]]`,
    `路径式：[[${P}/T]]`,
    `别名：[[T|友好名]]`,
    `锚点：[[T#小节]]`,
    `嵌入：![[T]]`,
    'emoji 行内代码：`😀` 见 [[T]]',
    '第三行：`𝕏` 与 `😀😀` 后 [[T]]',
    '',
  ].join('\n');
  await put(`${P}/links`, linksDoc);
  const renamed = await apiJson(docUrl(`${P}/T`) + '/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: `${P}/T2` }),
  });
  expect(`rename 200 且 rewritten>=1（${renamed.body.rewritten}）`, renamed.status === 200 && renamed.body.rewritten >= 1);
  expect(`rename 后 unresolved=${renamed.body.unresolved}`, renamed.body.unresolved === 0);

  const linksAfter = await apiJson(docUrl(`${P}/links`));
  const raw = linksAfter.body.raw;
  expect('裸 stem → [[T2]]', raw.includes('裸 stem：[[T2]]'));
  expect('路径式 → [[P/T2]]', raw.includes(`路径式：[[${P}/T2]]`));
  expect('别名保留 → [[T2|友好名]]', raw.includes('别名：[[T2|友好名]]'));
  expect('锚点保留 → [[T2#小节]]', raw.includes('锚点：[[T2#小节]]'));
  expect('嵌入保留 → ![[T2]]', raw.includes('嵌入：![[T2]]'));
  expect('emoji 行内代码未被改坏', raw.includes('emoji 行内代码：`😀` 见 [[T2]]'));
  expect('多 emoji 行内代码未被改坏', raw.includes('第三行：`𝕏` 与 `😀😀` 后 [[T2]]'));

  // ---------- 契约：不存在文档的 links/backlinks 应 404 ----------
  const noLinks = await api(`${docUrl(`${P}/nope`)}/links`);
  const noBack = await api(`${docUrl(`${P}/nope`)}/backlinks`);
  expect('不存在文档 /links → 404', noLinks.status === 404);
  expect('不存在文档 /backlinks → 404', noBack.status === 404);

  // ---------- tree prefix：长前缀不 500，通配符无注入 ----------
  const longPrefix = 'a'.repeat(60);
  const longRes = await api(`/api/tree?prefix=${encodeURIComponent(longPrefix)}`);
  expect(`prefix 60 字符 → 200（实际 ${longRes.status}）`, longRes.status === 200);
  const wildcard = await apiJson(`/api/tree?prefix=${encodeURIComponent('%')}`);
  expect(`prefix=% 不返回全部（${wildcard.body.length} 条）`, wildcard.body.length === 0);
  const allDocs = await apiJson('/api/tree?limit=200');
  const firstPath = (allDocs.body ?? [])[0]?.path ?? '';
  const samplePrefix = firstPath.includes('/') ? firstPath.slice(0, firstPath.indexOf('/') + 1) : '';
  const sub = await apiJson(`/api/tree?prefix=${encodeURIComponent(samplePrefix)}`);
  expect(`prefix=${samplePrefix || '(空)'} 命中 ${sub.body.length} 篇`, sub.body.length > 0);

  // ---------- 入链自愈：先建链接、后建目标，不需要 admin resolve ----------
  const linkFirst = `# link-first\n\n见 [[later-target]]。\n`;
  await put(`${P}/link-first`, linkFirst);
  const rep1 = await apiJson('/api/reports/links?unresolved=1');
  expect(`目标不存在时是断链（${rep1.body.count} 条）`, rep1.body.count >= 1);
  await put(`${P}/later-target`, '# later target\n\n内容。\n');
  const rep2 = await apiJson('/api/reports/links?unresolved=1');
  expect('创建目标后入链自动解析（不需要调 admin/reindex）', rep2.body.count === 0);

  // ---------- rename：自链接 + 同名 stem 换目录 ----------
  await put(`${P}/self`, '# self\n\n[[self]] 自引用。\n');
  const selfRename = await apiJson(docUrl(`${P}/self`) + '/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: `${P}/self2` }),
  });
  expect(`自链接文档 rename 成功（unresolved=${selfRename.body.unresolved}）`, selfRename.status === 200 && selfRename.body.unresolved === 0);
  const selfDoc = await apiJson(docUrl(`${P}/self2`));
  expect('自链接被改写为 [[self2]]', selfDoc.body.raw.includes('[[self2]]'));

  await put(`${P}/move-target-X`, '# X\n\n目标。\n');
  await put(`${P}/in-dir/ref`, '# ref\n\n[[move-target-X]]\n');
  const moveRename = await apiJson(docUrl(`${P}/move-target-X`) + '/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: `${P}/in-dir/move-target-X` }),
  });
  expect(`同名 stem 移动目录 rename 成功（unresolved=${moveRename.body.unresolved}）`, moveRename.status === 200 && moveRename.body.unresolved === 0);

  // rename 到与既有文档同 stem（不同目录）→ 409，避免 [[stem]] 歧义
  await put(`${P}/coll-a/Foo`, '# Foo\n');
  await put(`${P}/coll-b/Bar`, '# Bar\n');
  const stemClash = await api(docUrl(`${P}/coll-a/Foo`) + '/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: `${P}/coll-a/Bar` }),
  });
  expect(`rename 撞既有 stem → 409（实际 ${stemClash.status}）`, stemClash.status === 409);

  // ---------- CRLF 文档 ----------
  const crlf = '---\r\ntitle: "CRLF 文档"\r\ntags:\r\n  - t\r\n---\r\n# CRLF 标题\r\n\r\n压感内容\r\n';
  const crlfPut = await put(`${P}/crlf`, crlf);
  expect('CRLF 文档写入 200', crlfPut.status === 200);
  const crlfGet = await apiJson(docUrl(`${P}/crlf`));
  expect('CRLF 原文逐字节保留', crlfGet.body.raw === crlf);
  expect(`CRLF frontmatter 解析（title=${crlfGet.body.frontmatter.title}）`, crlfGet.body.frontmatter.title === 'CRLF 文档');
  const crlfSearch = await apiJson('/api/search?q=' + encodeURIComponent('CRLF 标题'));
  expect('CRLF 文档可被检索', crlfSearch.body.results.some((r) => r.path === `${P}/crlf`));

  // ---------- 摘要不暴露 frontmatter（UX review P1） ----------
  const fuzzy = await apiJson('/api/search?q=' + encodeURIComponent('CRLF 标题'));
  const firstSnippet = fuzzy.body.results?.[0]?.snippet ?? '';
  expect(
    `搜索摘要不含 YAML/frontmatter（「${firstSnippet.slice(0, 40)}…」）`,
    fuzzy.status === 200 && !/^---/.test(firstSnippet.trim()) && !/title:\s|source:\s|node_token:/.test(firstSnippet),
  );

  // ---------- 清理 ----------
  await cleanup([
    `${P}/big`,
    `${P}/after`,
    `${P}/links`,
    `${P}/T2`,
    `${P}/link-first`,
    `${P}/later-target`,
    `${P}/self2`,
    `${P}/in-dir/ref`,
    `${P}/in-dir/move-target-X`,
    `${P}/coll-a/Foo`,
    `${P}/coll-a/Bar`,
    `${P}/coll-b/Bar`,
    `${P}/crlf`,
    ...Array.from({ length: 8 }, (_, i) => `${P}/conc-${i}`),
  ]);
  const report = await apiJson('/api/reports/links?unresolved=1');
  expect(`清理后断链 0（${report.body.count}）`, report.body.count === 0);
  const health = await apiJson('/api/health');
  expect(`清理后 docs=36（${health.body.docs}）且 stale=0`, health.body.docs === 36 && health.body.stale === 0);

  console.log(failures === 0 ? '\nREGRESSION OK' : `\nREGRESSION FAIL: ${failures} 项`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('REGRESSION CRASH:', err.message ?? err);
  process.exitCode = 1;
});
