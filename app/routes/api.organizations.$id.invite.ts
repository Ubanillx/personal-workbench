import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { findOrganization, inviteMember } from "../lib/organization.server";
import { assertOrgManage, notFound, requireManager } from "../lib/session.server";

/** POST /api/organizations/:id/invite —— 把一个尚无组织的账号直接拉进本组织（D-31） */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (!findOrganization(id)) return notFound();
  const denied = assertOrgManage(auth.user, id);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const accountId = typeof body.userId === "string" ? body.userId : "";
  const result = inviteMember(auth.user, id, accountId);
  return result.ok ? ok(result.data) : result.response;
}
