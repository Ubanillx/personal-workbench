import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { createOrganization, listOrganizations } from "../lib/organization.server";
import { requireAdmin, requireAuth } from "../lib/session.server";

/** GET /api/organizations —— 组织列表（管理员含已归档；普通成员只看 active） */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(listOrganizations(auth.user));
}

/** POST /api/organizations —— 仅管理员可以创建组织 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAdmin(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = createOrganization(auth.user, { name: body.name, description: body.description });
  return result.ok ? ok(result.data, 201) : result.response;
}
