import { appConfig } from "../lib/context.server";
import { db, now, run } from "../lib/db.server";
import { ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";

/** POST /api/notifications/read —— 支持 all / taskId / ids[] 三种标记方式，均限本人 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const stamp = now();
  if (body.all) run(database, "UPDATE notifications SET is_read=1,read_at=? WHERE recipient_id=?", stamp, user.id);
  else if (typeof body.taskId === "string")
    run(database, "UPDATE notifications SET is_read=1,read_at=? WHERE recipient_id=? AND task_id=?", stamp, user.id, body.taskId);
  else if (Array.isArray(body.ids))
    for (const id of body.ids)
      if (typeof id === "string")
        run(database, "UPDATE notifications SET is_read=1,read_at=? WHERE recipient_id=? AND id=?", stamp, user.id, id);
  return ok(null);
}
