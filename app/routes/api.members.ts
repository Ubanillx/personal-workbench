import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { listAllAccounts, listMembers } from "../lib/organization.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/members —— 成员列表（原 GET /api/users 的替代）：
 * 管理员看全部账号（带所属组织），组织管理者看本组织成员，普通用户看空数组。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  if (auth.user.role === "admin") return ok(listAllAccounts());
  if (auth.user.role === "manager" && auth.user.orgId) return ok(listMembers(auth.user.orgId));
  return ok([]);
}
