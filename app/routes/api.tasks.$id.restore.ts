import { appConfig } from "../lib/context.server";
import { db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { event, findTask } from "../lib/tasks.server";

/** POST /api/tasks/:id/restore —— 仅主人；未归档时幂等返回当前视图 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const id = String(params.id);
  const task = findTask(database, id);
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (task.archivedAt) {
    run(database, "UPDATE tasks SET archived_at=NULL,updated_at=? WHERE id=?", now(), id);
    event(database, id, user, "task_restored", "任务已恢复");
  }
  return ok(findTask(database, id));
}
