import { db, isStatus, rows } from "./db.server";
import { SELECT_TASK, toTaskView } from "./tasks.server";

/** 回顾统计共享逻辑：页面 loader 与 /api/review 资源路由共用（筛选与统计口径与旧实现逐字一致） */

export type ReviewFilters = {
  from?: string | null;
  to?: string | null;
  ownerId?: string | null;
  status?: string | null;
};

export type ReviewSummary = { total: number; completed: number; active: number; overdue: number; completionRate: number };

export function reviewData(filters: ReviewFilters): { tasks: unknown[]; summary: ReviewSummary } {
  const database = db();
  const cond = ["t.archived_at IS NULL"];
  const params: string[] = [];
  const { from, to, ownerId, status } = filters;
  if (from !== undefined && from !== null) {
    cond.push("substr(t.updated_at,1,10)>=?");
    params.push(from);
  }
  if (to !== undefined && to !== null) {
    cond.push("substr(t.updated_at,1,10)<=?");
    params.push(to);
  }
  if (ownerId !== undefined && ownerId !== null) {
    if (ownerId === "unassigned") cond.push("t.owner_id IS NULL");
    else {
      cond.push("t.owner_id=?");
      params.push(ownerId);
    }
  }
  if (status !== undefined && status !== null && isStatus(status)) {
    cond.push("t.status=?");
    params.push(status);
  }
  const tasks = rows(database, `${SELECT_TASK} WHERE ${cond.join(" AND ")} ORDER BY t.updated_at DESC`, ...params).map(toTaskView);
  const completed = tasks.filter((task) => (task as { status?: string }).status === "completed").length;
  const overdue = tasks.filter((task) => {
    const item = task as { dueDate?: string | null; status?: string };
    return item.dueDate && item.dueDate < new Date().toISOString().slice(0, 10) && item.status !== "completed";
  }).length;
  return {
    tasks,
    summary: {
      total: tasks.length,
      completed,
      active: tasks.length - completed,
      overdue,
      completionRate: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
    },
  };
}
