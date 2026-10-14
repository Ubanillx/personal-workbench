import { appConfig } from "../lib/context.server";
import { db } from "../lib/db.server";
import { listNotifications } from "../lib/notifications.server";
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
  return ok(listNotifications(database, user, unread, 100));
}
