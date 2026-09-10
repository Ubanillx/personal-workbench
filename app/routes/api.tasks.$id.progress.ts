import type { TaskStatus } from "../../shared/types/domain";
import { appConfig } from "../lib/context.server";
import { clamp, db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { event, findTask, log, notifyParticipants } from "../lib/tasks.server";

/** POST /api/tasks/:id/progress —— 仅本人负责的任务；100% 时助理转待验收、主人直接完成 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const id = String(params.id);
  const current = findTask(database, id);
  if (!current) return fail("NOT_FOUND", "任务不存在", 404);
  if (current.archivedAt) return fail("ARCHIVED", "请先恢复归档任务", 400);
  if (user.role === "viewer" || current.ownerId !== user.id) return fail("FORBIDDEN", "只能更新自己负责的任务", 403);
  if (current.status === "pending_review") return fail("INVALID_STATE", "任务已提交验收，请等待主人处理", 400);
  if (current.status === "completed") return fail("INVALID_STATE", "已完成任务不能再更新进度", 400);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const p = clamp(body.progress);
  const status: TaskStatus =
    user.role === "assistant" && p >= 100 ? "pending_review" : p >= 100 ? "completed" : p > 0 ? "in_progress" : "todo";
  const stamp = now();
  run(
    database,
    "UPDATE tasks SET progress=?,status=?,updated_at=?,completed_at=? WHERE id=?",
    p,
    status,
    stamp,
    status === "completed" ? (current.completedAt ?? stamp) : null,
    id,
  );
  log(database, id, user, String(body.note ?? body.log ?? `进度更新为 ${p}%`).trim(), p);
  const updated = findTask(database, id);
  if (status === "pending_review") event(database, id, user, "task_submitted", "进度达到 100%，提交主人验收");
  notifyParticipants(
    database,
    updated,
    user.id,
    status === "pending_review" ? "task_submitted" : "task_progress",
    status === "pending_review" ? "任务待验收" : "任务进度更新",
    `${user.name} 更新了任务“${updated.title}”`,
  );
  return ok(updated);
}
