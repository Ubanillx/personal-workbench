import { appConfig } from "../lib/context.server";
import { db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { event, findTask, notifyParticipants } from "../lib/tasks.server";

/** POST /api/tasks/:id/return —— 仅主人；退回到 in_progress 且进度压到 99 以内 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const id = String(params.id);
  const task = findTask(database, id);
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (task.archivedAt) return fail("ARCHIVED", "请先恢复归档任务", 400);
  if (task.status !== "pending_review") return fail("INVALID_STATE", "只有待验收任务可以退回", 400);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const p = Math.min(task.progress, 99);
  const note = String(body.note ?? "主人退回任务，请继续处理").trim() || "主人退回任务，请继续处理";
  run(database, "UPDATE tasks SET status='in_progress',progress=?,completed_at=NULL,updated_at=? WHERE id=?", p, now(), id);
  event(database, id, user, "task_returned", note);
  const updated = findTask(database, id);
  notifyParticipants(database, updated, user.id, "task_returned", "任务已退回", `任务“${updated.title}”已退回`);
  return ok(updated);
}
