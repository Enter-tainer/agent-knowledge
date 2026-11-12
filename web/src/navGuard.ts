/**
 * 站内离开守卫：编辑页有未保存改动时，拦截所有站内跳转（点链接、浏览器 back、程序化 navigate）。
 * 路由层只负责问「能不能走」，具体弹窗与保存由页面注册的 guard 决定。
 */
export interface LeaveGuard {
  /** 是否处于「有未保存改动」状态（同步判断，popstate 需要）。 */
  isDirty: () => boolean;
  /** 弹确认；返回 true = 可以离开（可能已保存），false = 留在当前页。 */
  confirmLeave: () => Promise<boolean>;
  /** 用户已明确「放弃修改并继续」后，把脏标记清掉（避免紧接着的弹层/导航再问一次）。 */
  clearDirty?: () => void;
}

let guard: LeaveGuard | null = null;

export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next;
}

/** 只清自己那份 guard，避免旧页面 teardown 把新页面的 guard 清掉。 */
export function clearLeaveGuard(current?: LeaveGuard): void {
  if (!current || guard === current) guard = null;
}

export function hasDirtyGuard(): boolean {
  try {
    return Boolean(guard?.isDirty());
  } catch {
    return false;
  }
}

export function clearLeaveGuardDirty(): void {
  guard?.clearDirty?.();
}

export async function confirmLeave(): Promise<boolean> {
  if (!guard) return true;
  let dirty = false;
  try {
    dirty = guard.isDirty();
  } catch {
    dirty = false;
  }
  if (!dirty) return true;
  return guard.confirmLeave();
}
