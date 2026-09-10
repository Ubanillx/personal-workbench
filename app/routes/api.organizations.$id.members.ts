import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { findOrganization, listMembers } from "../lib/organization.server";
import { assertOrgManage, notFound, requireManager } from "../lib/session.server";

/** GET /api/organizations/:id/members —— 成员列表：管理员或本组织管理者 */
export async function loader({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (!findOrganization(id)) return notFound();
  const denied = assertOrgManage(auth.user, id);
  if (denied) return denied;
  return ok(listMembers(id));
}
