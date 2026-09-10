import { accessInfoPayload } from "../lib/access.server";
import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { requireAdmin } from "../lib/session.server";

/**
 * GET /api/access-info —— **仅管理员**（ACCOUNTS_AND_ORGS.md §7.2）：
 * 非 admin 一律 403 FORBIDDEN「只有管理员可以访问此功能」（由 requireAdmin 统一给出），
 * 不回 404——这里没有「跨组织资源」，只有「功能不对这个角色开放」。
 * 逻辑在 app/lib/access.server.ts，与管理页共用同一份返回体。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAdmin(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(accessInfoPayload());
}
