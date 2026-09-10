import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { createJoinRequest, listJoinRequests } from "../lib/organization.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/join-requests —— 申请列表：
 * 管理员看全部（可按 orgId/status 过滤），组织管理者看本组织 + 自己提出的，普通用户只看自己的。
 * POST /api/join-requests —— 无组织用户提交入组申请（同时只能有一个待审批，D-30）。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const orgId = url.searchParams.get("orgId") ?? "";
  return ok(listJoinRequests(auth.user, { status, orgId }));
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const orgId = typeof body.orgId === "string" ? body.orgId : "";
  const result = createJoinRequest(auth.user, orgId, body.message);
  return result.ok ? ok(result.data, 201) : result.response;
}
