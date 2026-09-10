import { appConfig } from "../lib/context.server";
import { db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { event, findTask, notifyParticipants } from "../lib/tasks.server";

/** POST /api/tasks/:id/submit-review —— 仅任务助理本人；待验收态幂等返回当前视图 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const id = String(params.id);
  const task = findTask(database, id);
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (task.archivedAt) return fail("ARCHIVED", "请先恢复归档任务", 400);
  if (user.role !== "assistant" || task.ownerId !== user.id) return fail("FORBIDDEN", "只有任务助理可以提交验收", 403);
  if (task.status === "pending_review") return ok(task);
  if (task.progress < 100) return fail("VALIDATION_ERROR", "进度达到100%后才能提交验收", 400);
  run(database, "UPDATE tasks SET status='pending_review',updated_at=? WHERE id=?", now(), id);
  event(
    database,
    id,
    user,
    "task_submitted",
    String(((await request.json().catch(() => ({}))) as Record<string, unknown>).note ?? "提交主人验收"),
  );
  const updated = findTask(database, id);
  notifyParticipants(database, updated, user.id, "task_submitted", "任务待验收", `任务“${updated.title}”等待主人验收`);
  return ok(updated);
}
