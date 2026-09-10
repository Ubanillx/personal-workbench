import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { createTodoRecord, listTodos } from "../lib/todos.server";

/**
 * GET /api/todos —— 登录即可（待办按组织隔离，§14.2）；逻辑在 app/lib/todos.server.ts。
 * `?org=<组织id>` 是管理员（D-28）的筛选器接缝，其他角色一律忽略该参数（只看本组织）。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  // 组织筛选器只对管理员有意义（D-28），与 /api/tasks 的写法一致
  const orgFilter = auth.user.role === "admin" ? query.get("org") : null;
  return ok(listTodos(auth.user, orgFilter));
}

/** POST /api/todos —— 逻辑在 app/lib/todos.server.ts（与页面表单 action 共用） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = createTodoRecord(auth.user, body);
  if (!created.ok) return fail(created.code, created.message, created.status);
  return ok(created.data, created.status);
}
