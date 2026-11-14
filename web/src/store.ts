import { api } from './api';
import type { TreeEntry } from './api/types';

/** 目录树缓存：36 篇量级，一次拉全量即可；保存/改名后主动失效。 */
let cache: TreeEntry[] | null = null;
let inflight: Promise<TreeEntry[]> | null = null;

/**
 * 只清缓存，**不**广播事件（内部用）。
 *
 * 必须和 `invalidateTree()` 分开：侧边栏收到 `kb:tree-invalidated` 后要
 * `refresh()` → `loadTree(true)`，如果 `loadTree(true)` 又广播事件，
 * 就会形成 `invalidated → refresh → loadTree(true) → invalidated → …`
 * 的自激环。之前它只靠浏览器「事件嵌套深度上限」才停下来
 * （实测 44 层嵌套、侧边栏被重建 88 次），换引擎/换版本就是 RangeError 风险。
 */
function clearTreeCache(): void {
  cache = null;
  inflight = null;
}

/** 目录数据失效：清缓存 + 通知关心它的视图（侧边栏）刷新。 */
export function invalidateTree(): void {
  clearTreeCache();
  // 持久侧边栏靠这个事件刷新目录（保存/改名后），页面自己不需要知道侧边栏存在。
  window.dispatchEvent(new Event('kb:tree-invalidated'));
}

export async function loadTree(force = false): Promise<TreeEntry[]> {
  // force 只清缓存，不再广播——广播是 invalidateTree() 的职责，
  // 否则侧边栏响应事件时又会触发自己。
  if (force) clearTreeCache();
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
