import { appConfig } from "../lib/context.server";
import { db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { event, findTask, notifyParticipants } from "../lib/tasks.server";

/** POST /api/tasks/:id/approve —— 仅主人；仅待验收任务可通过 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const id = String(params.id);
  const task = findTask(database, id);
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (task.archivedAt) return fail("ARCHIVED", "请先恢复归档任务", 400);
  if (task.status !== "pending_review") return fail("INVALID_STATE", "只有待验收任务可以通过", 400);
  const note = String(((await request.json().catch(() => ({}))) as Record<string, unknown>).note ?? "主人验收通过");
  const stamp = now();
  run(database, "UPDATE tasks SET status='completed',progress=100,completed_at=?,updated_at=? WHERE id=?", stamp, stamp, id);
  event(database, id, user, "task_approved", note);
  const updated = findTask(database, id);
  notifyParticipants(database, updated, user.id, "task_approved", "任务验收通过", `任务“${updated.title}”已通过验收`);
  return ok(updated);
}
