import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { findOrganization, updateOrganization } from "../lib/organization.server";
import { assertOrgManage, notFound, requireManager } from "../lib/session.server";

/** PATCH /api/organizations/:id —— 改组织名称/描述：管理员或本组织管理者 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (!findOrganization(id)) return notFound();
  const denied = assertOrgManage(auth.user, id);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = updateOrganization(auth.user, id, { name: body.name, description: body.description });
  return result.ok ? ok(result.data) : result.response;
}
