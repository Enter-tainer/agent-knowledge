// 冒烟：agent 的 5 件事 + 导出 + 乐观锁 + ETag
// 用法：node scripts/smoke.mjs [--base ...]
import { api, apiJson, cleanup, docUrl } from './_http.mjs';

const TMP = `_smoke/smoke-${Date.now()}`;
let failures = 0;

/** 冒烟里的断言要立刻失败（不能只设 exitCode 继续跑完还打印 OK）。 */
function assert(cond, message) {
  if (cond) {
    console.log(`ok  ${message}`);
  } else {
    failures++;
    console.error(`FAIL: ${message}`);
    throw new Error(message);
  }
}

async function main() {
  const health = await apiJson('/api/health');
  assert(health.body.ok === true && health.body.docs > 0, `health ok，docs=${health.body.docs}，stale=${health.body.stale}`);

  const tree = await apiJson('/api/tree?limit=500');
  assert(Array.isArray(tree.body) && tree.body.length > 0, `tree 列出 ${tree.body.length} 篇`);

  const first = tree.body[0];
  const doc = await apiJson(docUrl(first.path));
  assert(typeof doc.body.raw === 'string' && doc.body.raw.length > 0, `读 ${first.path}（${doc.body.raw.length} chars）`);
  const hash = doc.body.hash;

  // 条件 304（标准 ETag 形态：带引号）
  const res304 = await api(docUrl(first.path), { headers: { 'if-none-match': `"${hash}"` } });
  assert(res304.status === 304, 'If-None-Match: "<hash>" 返回 304');
  assert(res304.headers.get('etag') === `"${hash}"`, '304 带 ETag');

  // 新建：必须 If-Match: *
  const created = await apiJson(docUrl(TMP), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': '*' },
    body: '# smoke\n\n中文检索压感，标识符 LSPosed。\n',
  });
  assert(created.status === 200 && created.body.hash.length === 64, '新建文档返回 hash');

  // 重复新建同 path（带 *）应 428（* 只用于新建）
  const dup = await api(docUrl(TMP), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': '*' },
    body: '# dup\n',
  });
  assert(dup.status === 428, 'If-Match: * 对已存在文档返回 428');

  // 改已有：不带 If-Match → 428
  const noIfMatch = await api(docUrl(TMP), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
    body: '# no if-match\n',
  });
  assert(noIfMatch.status === 428, '缺 If-Match 返回 428');

  // 改已有：正确 hash
  const updated = await apiJson(docUrl(TMP), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': created.body.hash },
    body: '# smoke v2\n\n压感等级 LSPosed。\n',
  });
  assert(updated.status === 200, 'If-Match 正确时允许写入');

  // 过期 hash → 412，且内容不变
  const conflict = await api(docUrl(TMP), {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': created.body.hash },
    body: '# stale\n',
  });
  assert(conflict.status === 412, '过期 If-Match 返回 412');
  const afterConflict = await apiJson(docUrl(TMP));
  assert(afterConflict.body.raw.includes('smoke v2'), '412 后内容未被覆盖');

  // 检索
  const search = await apiJson('/api/search?q=' + encodeURIComponent('压感'));
  assert(search.body.results.length > 0, `检索「压感」命中 ${search.body.results.length} 篇`);
  const ident = await apiJson('/api/search?q=' + encodeURIComponent('LSPosed'));
  assert(ident.body.results.some((r) => r.path === TMP), '检索标识符 LSPosed 命中刚写的文档');

  // 反链（动态挑一篇有入链的文档，不依赖具体语料）
  const treeForBacklinks = await apiJson('/api/tree?limit=100');
  let backlinks = null;
  for (const doc of (treeForBacklinks.body ?? []).slice(0, 20)) {
    const r = await apiJson('/api/docs/' + encodeURIComponent(doc.path) + '/backlinks');
    if (r.status === 200 && (r.body.backlinks ?? []).length > 0) {
      backlinks = r;
      break;
    }
  }
  assert(Boolean(backlinks), `反链：找到一篇有入链的文档（${backlinks ? backlinks.body.backlinks.length + ' 个来源' : '无'}）`);

  // 导出
  const exported = await apiJson('/api/export?format=json');
  assert(exported.body.documents.length > 0, `导出 ${exported.body.documents.length} 篇`);

  // 清理
  await cleanup([TMP]);
  const gone = await api(docUrl(TMP));
  assert(gone.status === 404, '删除后 404');

  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err.message ?? err);
  process.exitCode = 1;
});
void failures;
