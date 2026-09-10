import { appConfig } from "../lib/context.server";
import { db } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { createTask } from "../lib/task-service.server";
import { notifyOverdueTasks, visible } from "../lib/tasks.server";

/** GET /api/tasks —— 按角色可见性过滤；只有主人能用 includeArchived=1 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  notifyOverdueTasks(database);
  const query = new URL(request.url).searchParams;
  const includeArchived = query.get("includeArchived");
  const status = query.get("status");
  const assignee = query.get("assignee");
  return ok(visible(database, user, user.role === "owner" && includeArchived === "1", status ?? undefined, assignee ?? undefined));
}

/** POST /api/tasks —— 业务逻辑在 app/lib/task-service.server.ts（与页面 action 共用） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = createTask(auth.user, body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
