import { appConfig } from "../lib/context.server";
import { db, rows } from "../lib/db.server";
import { ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { notifyOverdueTasks } from "../lib/tasks.server";

/** GET /api/notifications —— 本人的通知，unread=1 只取未读；最多 100 条 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  notifyOverdueTasks(database);
  const unread = new URL(request.url).searchParams.get("unread") === "1";
  return ok(
    rows(
      database,
      `SELECT id,recipient_id AS recipientId,actor_id AS actorId,task_id AS taskId,report_id AS reportId,event_type AS eventType,title,message,is_read AS isRead,created_at AS createdAt,read_at AS readAt FROM notifications WHERE recipient_id=? ${unread ? "AND is_read=0" : ""} ORDER BY created_at DESC LIMIT 100`,
      user.id,
    ),
  );
}
