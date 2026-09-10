import { appConfig } from "../lib/context.server";
import { dashboardData } from "../lib/dashboard.server";
import { ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/dashboard —— 所有已登录角色都能看（admin / manager / member），
 * 数据范围由 dashboard.server.ts 内的 `orgScope(user)` 决定：
 * 管理员得到全部组织的合并视图，其他人的任务可见性与任务域一致、待办与随手记限本组织。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(dashboardData(auth.user));
}
