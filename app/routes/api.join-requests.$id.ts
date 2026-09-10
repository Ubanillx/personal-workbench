import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { cancelJoinRequest } from "../lib/organization.server";
import { requireAuth } from "../lib/session.server";

/** DELETE /api/join-requests/:id —— 撤回自己尚未被处理的申请 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = cancelJoinRequest(auth.user, params.id);
  return result.ok ? ok(result.data) : result.response;
}
