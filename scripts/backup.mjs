// 备份：从 Worker 导出全库 md 的 zip 到本地（不依赖 d1 export，也不受 FTS 虚表限制）
// 用法：node scripts/backup.mjs [--out backups] [--base http://127.0.0.1:8787]
// 建议：定期跑 + 把 backups/ 交给本机 git（或先把 zip 解开成 vault 目录再 git commit）
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { api } from './_http.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = path.resolve(flag('--out', 'backups'));

async function main() {
  const res = await api('/api/export?format=zip');
  if (!res.ok) throw new Error(`export failed: ${res.status} ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('返回的不是 zip（PK 头缺失）');
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT, `kb-${stamp}.zip`);
  writeFileSync(file, buf);
  console.log(`backup ok: ${file} (${statSync(file).size} bytes)`);
  console.log('提示：zip 内每个 md 的路径就是 vault 相对路径，可直接解压回 Obsidian。');
}

main().catch((err) => {
  console.error('BACKUP FAIL:', err.message ?? err);
  process.exitCode = 1;
});
