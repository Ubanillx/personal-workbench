import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { createNoteRecord, listNotes } from "../lib/notes.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/notes —— 登录即可（随手记按组织隔离，§14.2）；逻辑在 app/lib/notes.server.ts。
 * `?org=<组织id>` 是管理员（D-28）的筛选器接缝，其他角色一律忽略该参数（只看本组织）。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  // 组织筛选器只对管理员有意义（D-28），与 /api/tasks 的写法一致
  const orgFilter = auth.user.role === "admin" ? query.get("org") : null;
  return ok(listNotes(auth.user, orgFilter));
}

/** POST /api/notes —— 逻辑在 app/lib/notes.server.ts（与页面表单 action 共用） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = createNoteRecord(auth.user, body);
  if (!created.ok) return fail(created.code, created.message, created.status);
  return ok(created.data, created.status);
}
