import { api } from './api';
import type { TreeEntry } from './api/types';

/** 目录树缓存：36 篇量级，一次拉全量即可；保存/改名后主动失效。 */
let cache: TreeEntry[] | null = null;
let inflight: Promise<TreeEntry[]> | null = null;

export function invalidateTree(): void {
  cache = null;
  inflight = null;
}

export async function loadTree(force = false): Promise<TreeEntry[]> {
  if (force) invalidateTree();
  if (cache) return cache;
  if (!inflight) {
    inflight = api
      .tree({ limit: 500 })
      .then((entries) => {
        cache = entries;
        return entries;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 把一个「可能是短名」的输入解析成真实路径（wikilink 跳转 / 后端 404 兜底）。 */
export function findPath(entries: TreeEntry[], input: string): string | null {
  const want = input.trim().replace(/\.md$/i, '');
  if (!want) return null;
  const lower = want.toLowerCase();

  const exact = entries.find((e) => e.path === want);
  if (exact) return exact.path;

  const exactCi = entries.find((e) => e.path.toLowerCase() === lower);
  if (exactCi) return exactCi.path;

  const stem = (path: string): string => path.split('/').pop() ?? path;
  const byStem = entries.find((e) => stem(e.path).toLowerCase() === lower);
  if (byStem) return byStem.path;

  const byTitle = entries.find((e) => (e.title || '').toLowerCase() === lower);
  if (byTitle) return byTitle.path;

  // 最后按「路径后缀」宽松匹配（例如只输 `示例设备 B 逆向`）
  const bySuffix = entries.find((e) => e.path.toLowerCase().endsWith(`/${lower}`));
  return bySuffix ? bySuffix.path : null;
}
