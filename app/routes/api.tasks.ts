import { appConfig } from "../lib/context.server";
import { db } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { createTask } from "../lib/task-service.server";
import { canManageTasks, notifyOverdueTasks, visible } from "../lib/tasks.server";

/** GET /api/tasks —— 按角色可见性过滤（admin 全部组织 / manager 本组织 / member 只看自己负责的） */
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
  // 归档任务只对管理员与组织管理者开放（member 只看在办任务）
  const showArchived = canManageTasks(user) && includeArchived === "1";
  // 组织筛选器只给管理员（D-28）：其他人的组织范围已由可见性条件锁死
  const orgFilter = user.role === "admin" ? query.get("org") : null;
  return ok(visible(database, user, showArchived, status ?? undefined, assignee ?? undefined, orgFilter));
}

/** POST /api/tasks —— 业务逻辑在 app/lib/task-service.server.ts（与页面 action 共用） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = createTask(auth.user, body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
