import { api } from '../api';
import { NotFoundError } from '../api/errors';
import type { Doc } from '../api/types';
import { findPath, loadTree } from '../store';

/**
 * 取文档，并兜住「wikilink 用的是短名而不是完整 path」的情况：
 * 短名查不到时按目录树解析成真实路径（等价于后端 §6.3 的唯一文件名规则）。
 */
export async function loadDoc(input: string): Promise<Doc> {
  try {
    return await api.getDoc(input);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    const entries = await loadTree();
    const resolved = findPath(entries, input);
    if (!resolved) throw err;
    return await api.getDoc(resolved);
  }
}
