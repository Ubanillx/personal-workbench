import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { getReport } from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/reports/:id —— 管理员看全部组织，组织管理者看本组织，普通用户只看自己提交的。
 * 跨组织、未加入组织或本人看不到的周报一律 404（§4 不变式 1），逻辑在 app/lib/reports.server.ts。
 */
export async function loader({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = getReport(auth.user, String(params.id));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
