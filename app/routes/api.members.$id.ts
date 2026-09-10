import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { removeMember, setMemberActive, setMemberRole } from "../lib/organization.server";
import { requireManager } from "../lib/session.server";

/**
 * PATCH /api/members/:id —— 启用/停用、改角色（manager/member）
 * DELETE /api/members/:id —— 移出组织（退回「未加入」）
 * 越权或目标不存在一律 404；「最后一名组织管理者」由 organization.server.ts 拒绝（400 LAST_MANAGER）。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;

  if (request.method === "DELETE") {
    const result = removeMember(auth.user, id);
    return result.ok ? ok(result.data) : result.response;
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.role !== undefined) {
    const result = setMemberRole(auth.user, id, body.role);
    return result.ok ? ok(result.data) : result.response;
  }
  if (typeof body.isActive !== "boolean") return fail("VALIDATION_ERROR", "isActive 必须是布尔值", 400);
  const result = setMemberActive(auth.user, id, body.isActive);
  return result.ok ? ok(result.data) : result.response;
}
