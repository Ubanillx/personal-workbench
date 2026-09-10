import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { archiveOrganization, findOrganization } from "../lib/organization.server";
import { assertOrgManage, notFound, requireManager } from "../lib/session.server";

/** POST /api/organizations/:id/archive —— 解散（归档）：管理员或本组织管理者；数据保留、成员退回未加入 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (!findOrganization(id)) return notFound();
  const denied = assertOrgManage(auth.user, id);
  if (denied) return denied;
  const result = archiveOrganization(auth.user, id);
  return result.ok ? ok(result.data) : result.response;
}
