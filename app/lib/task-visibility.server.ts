import type { UserRole } from "../../shared/types/domain";

type Actor = { id: string; role: UserRole; orgId: string | null };
type Target = { createdBy: string; ownerId: string | null; isPrivate: boolean };

/** 单条资源调用方先校验组织边界；列表、通知与去重共享同一 SQL 判据。 */
export function canViewTask(task: Target, user: Actor): boolean {
  if (user.role === "admin") return true;
  if (user.role === "member" || task.isPrivate) return task.createdBy === user.id || task.ownerId === user.id;
  return true;
}

export function taskVisibilityClauses(user: Actor): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (user.role !== "admin") {
    if (user.orgId) {
      clauses.push("t.org_id=?");
      params.push(user.orgId);
    } else clauses.push("1=0");
    clauses.push(user.role === "member" ? "(t.created_by=? OR t.owner_id=?)" : "(t.is_private=0 OR t.created_by=? OR t.owner_id=?)");
    params.push(user.id, user.id);
  }
  return { clauses, params };
}
