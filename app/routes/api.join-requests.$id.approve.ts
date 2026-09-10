import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { decideJoinRequest } from "../lib/organization.server";
import { requireManager } from "../lib/session.server";

/** POST /api/join-requests/:id/approve —— 通过入组/退组申请：管理员或本组织管理者 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = decideJoinRequest(auth.user, params.id, true, body.note);
  return result.ok ? ok(result.data) : result.response;
}
