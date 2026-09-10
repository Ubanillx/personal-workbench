import { appConfig } from "../lib/context.server";
import { db, isStatus, rows } from "../lib/db.server";
import { ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { SELECT_TASK, toTaskView } from "../lib/tasks.server";

/** GET /api/review —— 仅主人：按时间/负责人/状态筛选，附汇总统计 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const database = db();
  const query = new URL(request.url).searchParams;
  const cond = ["t.archived_at IS NULL"];
  const params: string[] = [];
  const from = query.get("from");
  if (from !== null) {
    cond.push("substr(t.updated_at,1,10)>=?");
    params.push(from);
  }
  const to = query.get("to");
  if (to !== null) {
    cond.push("substr(t.updated_at,1,10)<=?");
    params.push(to);
  }
  const ownerId = query.get("ownerId");
  if (ownerId !== null) {
    if (ownerId === "unassigned") cond.push("t.owner_id IS NULL");
    else {
      cond.push("t.owner_id=?");
      params.push(ownerId);
    }
  }
  const status = query.get("status");
  if (status !== null && isStatus(status)) {
    cond.push("t.status=?");
    params.push(status);
  }
  const tasks = rows(database, `${SELECT_TASK} WHERE ${cond.join(" AND ")} ORDER BY t.updated_at DESC`, ...params).map(toTaskView);
  const completed = tasks.filter((t: any) => t.status === "completed").length;
  const overdue = tasks.filter(
    (t: any) => t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10) && t.status !== "completed",
  ).length;
  return ok({
    tasks,
    summary: {
      total: tasks.length,
      completed,
      active: tasks.length - completed,
      overdue,
      completionRate: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
    },
  });
}
