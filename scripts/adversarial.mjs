// 对抗性 HTTP 测试（鉴权/路径/注入/DoS/并发/畸形输入/rename/delete/zip）
// 用法：node scripts/adversarial.mjs [--base ...]
import { readFileSync } from 'node:fs';
import { api, apiJson, assert, BASE, docUrl, fail, headers, cleanup } from './_http.mjs';

const P = `_adv/adv-${Date.now()}`;
let failures = 0;

function expect(name, cond) {
  if (!cond) {
    failures++;
    fail(name);
  } else {
    console.log(`ok  ${name}`);
  }
}

async function expectStatus(name, res, status) {
  const body = await res.text().catch(() => '');
  expect(`${name} → ${status}（实际 ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}）`, res.status === status);
}

async function main() {
  // ---------- 1. 本地免鉴权（鉴权由 Cloudflare Access 负责，Worker 不做判断） ----------
  await expectStatus('本地 loopback 无需任何 token 即可访问', await api('/api/health'), 200);
  await expectStatus('/healthz 可用', await api('/healthz'), 200);

  // ---------- 1b. 契约/静默失败（agent-UX review P0） ----------
  await expectStatus('GET /api 自描述', await api('/api'), 200);
  await expectStatus('未知 query 参数 400', await api('/api/search?q=x&kind=title'), 400);
  await expectStatus('非法 unresolved 400', await api('/api/reports/links?unresolved=maybe'), 400);
  await expectStatus('非法 export format 400', await api('/api/export?format=Zip'), 400);
  await expectStatus('GET /api/docs 404', await api('/api/docs'), 404);
  await expectStatus('POST /api/health 405', await api('/api/health', { method: 'POST' }), 405);
  await expectStatus('HEAD /api/docs/{path} 200', await api(docUrl('README'), { method: 'HEAD' }), 200);
  await expectStatus('GET /api/reports/stale', await api('/api/reports/stale'), 200);

  // ---------- 2. 路径穿越 / 绝对路径 / 畸形 path ----------
  const pathCases = [
    ['..%2Fescape', 'PUT', 400],
    ['%2Fetc%2Fpasswd', 'PUT', 400],
    ['%2e%2e%2Fx', 'PUT', 400],
    ['C%3A%2FWindows%2Fwin.ini', 'PUT', 400],
    ['%2Eobsidian%2Fapp', 'PUT', 400],
    ['%20', 'PUT', 400],
    ['%00', 'PUT', 400],
    ['%E0%A4%A', 'PUT', 400],
  ];
  for (const [p, method, status] of pathCases) {
    await expectStatus(`path 拒绝 ${p}`, await api(`/api/docs/${p}`, { method, body: '# x', headers: { 'if-match': '*' } }), status);
  }

  // 合法子目录路径可读（动态取一篇，不依赖具体语料）
  const tree = await apiJson('/api/tree?limit=50');
  const sampleDoc = (tree.body ?? []).find((d) => typeof d.path === 'string' && d.path.includes('/'));
  if (!sampleDoc) throw new Error('vault 里没有子目录文档，无法测子路径');
  await expectStatus('子路径可读', await api('/api/docs/' + encodeURIComponent(sampleDoc.path)), 200);

  // ---------- 3. 方法/未知路由 ----------
  await expectStatus('未知路由 404', await api('/api/nope'), 404);
  await expectStatus('PATCH 405', await api('/api/docs/x', { method: 'PATCH' }), 405);

  // ---------- 4. FTS/SQL 注入与 DoS ----------
  const evilQueries = [
    '"',
    '""',
    'a" OR "b',
    'NEAR(a b)',
    '*',
    '(',
    ')',
    'a AND',
    '-',
    'OR',
    '压感" OR "电机',
    'aaa; DROP TABLE documents;--',
    "'; DELETE FROM chunks_fts; --",
    'x'.repeat(200),
    '压'.repeat(200),
  ];
  for (const q of evilQueries) {
    let status = 0;
    try {
      const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
      status = res.status;
    } catch (err) {
      status = -1;
      console.error(err);
    }
    expect(`恶意查询不崩：${JSON.stringify(q).slice(0, 40)}（${status}）`, status === 200 || status === 400);
  }
  await expectStatus('注入后 DB 仍健康', await api('/api/health'), 200);
  await expectStatus('超长查询 400', await api('/api/search?q=' + 'a'.repeat(600)), 400);
  await expectStatus(
    '超多词 400',
    await api('/api/search?q=' + encodeURIComponent(Array.from({ length: 60 }, (_, i) => `w${i}`).join(' '))),
    400,
  );

  // ---------- 5. 超大 payload ----------
  const huge = 'x'.repeat(1_600_000);
  await expectStatus(
    '1.6MB 文档被拒 413',
    await api(docUrl(`${P}/huge`), {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown', 'if-match': '*' },
      body: huge,
    }),
    413,
  );

  // ---------- 6. 并发写（同 If-Match 双写只允许一个成功） ----------
  const conc = await apiJson(docUrl(`${P}/conc`), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown', 'if-match': '*' },
    body: '# conc\n',
  });
  const staleHash = conc.body.hash;
  const [r1, r2] = await Promise.all([
    api(docUrl(`${P}/conc`), {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown', 'if-match': staleHash },
      body: '# conc v1\n',
    }),
    api(docUrl(`${P}/conc`), {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown', 'if-match': staleHash },
      body: '# conc v2\n',
    }),
  ]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  expect(`并发双写 = 一个 200 一个 412（实际 ${statuses.join(',')}）`, statuses[0] === 200 && statuses[1] === 412);

  // ---------- 7. 畸形 md / XSS ----------
  const nasty = [
    '# 畸形',
    '',
    '```text',
    '未闭合代码块 [[inside]]',
    '',
    '单行超长：' + 'A'.repeat(120_000),
    '',
    '[[a|b|c]] [[#self]] [[ ]] [[.]], [[..]]',
    '[[javascript:alert(1)]] [[<img src=x onerror=alert(1)>]]',
    '<script>alert(1)</script>',
  ].join('\n');
  const nastyPut = await api(docUrl(`${P}/nasty`), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown', 'if-match': '*' },
    body: nasty,
  });
  expect('畸形/XSS 内容可写入（作为纯文本）', nastyPut.status === 200);
  const nastyGet = await api(docUrl(`${P}/nasty`));
  const nastyBody = await nastyGet.json();
  expect('回读内容逐字节一致', nastyBody.raw === nasty);
  expect('API 返回 JSON content-type', (nastyGet.headers.get('content-type') ?? '').includes('application/json'));
  const nastySearch = await api('/api/search?q=' + encodeURIComponent('畸形'));
  expect('畸形文档可被检索且不崩', nastySearch.status === 200);

  // ---------- 8. rename ----------
  await apiJson(docUrl(`${P}/A`), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown', 'if-match': '*' },
    body: '# A\n',
  });
  // 两种链接写法都要覆盖：裸 stem（真实 vault 的写法）与带路径
  await apiJson(docUrl(`${P}/B`), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown', 'if-match': '*' },
    body: `# B\n\n见 [[A]] 与 [[${P}/A]]。\n`,
  });
  const rename = await apiJson(docUrl(`${P}/A`) + '/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: `${P}/A2` }),
  });
  expect('rename 返回 rewritten>=1', rename.status === 200 && rename.body.rewritten >= 1);
  const bAfter = await apiJson(docUrl(`${P}/B`));
  expect('rename 后裸 stem 链接被改写', bAfter.body.raw.includes('[[A2]]'));
  expect('rename 后路径式链接被改写', bAfter.body.raw.includes(`[[${P}/A2]]`));
  const linksB = await apiJson(docUrl(`${P}/B`) + '/links');
  expect('rename 后链接 resolved', linksB.body.links.every((l) => l.resolved));

  await expectStatus(
    'rename 到已存在路径 409',
    await api(docUrl(`${P}/A2`) + '/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: `${P}/B` }),
    }),
    409,
  );
  await expectStatus(
    'rename 不存在文档 404',
    await api(docUrl(`${P}/nope`) + '/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: `${P}/x` }),
    }),
    404,
  );
  await expectStatus(
    'rename 畸形 JSON 400',
    await api(docUrl(`${P}/A2`) + '/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
    400,
  );
  await expectStatus(
    'rename 空 to 400',
    await api(docUrl(`${P}/A2`) + '/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: '  ' }),
    }),
    400,
  );

  // ---------- 9. delete 与断链 ----------
  await expectStatus('删除被引用文档 409', await api(docUrl(`${P}/A2`), { method: 'DELETE' }), 409);
  await expectStatus('force 删除 200', await api(docUrl(`${P}/A2`) + '?force=1', { method: 'DELETE' }), 200);
  const linksAfterDelete = await apiJson(docUrl(`${P}/B`) + '/links');
  expect('删除后原链接变 unresolved', linksAfterDelete.body.links.some((l) => !l.resolved));

  // ---------- 10. zip 导出 ----------
  const zipRes = await api('/api/export?format=zip');
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  expect('zip 200 且以 PK\\x03\\x04 开头', zipRes.status === 200 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b);
  const eocd = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = eocd >= 0 ? zipBuf.readUInt16LE(eocd + 10) : 0;
  expect(`zip 条目数 ≥ 37（实际 ${count}）`, count >= 37);

  // ---------- 11. 清理 ----------
  await cleanup([`${P}/nasty`, `${P}/conc`, `${P}/B`, `${P}/A`, `${P}/A2`]);
  const report = await apiJson('/api/reports/links?unresolved=1');
  expect('清理后断链回到 0', report.body.unresolved.length === 0);

  console.log(failures === 0 ? '\nADVERSARIAL OK' : `\nADVERSARIAL FAIL: ${failures} 项`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('ADVERSARIAL CRASH:', err.message ?? err);
  process.exitCode = 1;
});
void readFileSync;
void headers;
