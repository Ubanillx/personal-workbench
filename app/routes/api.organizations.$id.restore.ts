import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { restoreOrganization } from "../lib/organization.server";
import { requireAdmin } from "../lib/session.server";

/** POST /api/organizations/:id/restore —— 恢复已解散的组织：仅管理员 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAdmin(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = restoreOrganization(auth.user, params.id);
  return result.ok ? ok(result.data) : result.response;
}
