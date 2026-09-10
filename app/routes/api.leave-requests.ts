import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { createLeaveRequest } from "../lib/organization.server";
import { requireAuth } from "../lib/session.server";

/** POST /api/leave-requests —— 成员申请退出组织（需管理者批准，D-32） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = createLeaveRequest(auth.user, body.message);
  return result.ok ? ok(result.data, 201) : result.response;
}
