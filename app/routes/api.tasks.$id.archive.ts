import { appConfig } from "../lib/context.server";
import { db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { event, findTask } from "../lib/tasks.server";

/** POST /api/tasks/:id/archive —— 仅主人；已归档时幂等返回 ok(null) */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const id = String(params.id);
  const task = findTask(database, id);
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (!task.archivedAt) {
    const stamp = now();
    run(database, "UPDATE tasks SET archived_at=?,updated_at=? WHERE id=?", stamp, stamp, id);
    event(database, id, user, "task_archived", "任务已归档");
  }
  return ok(null);
}
