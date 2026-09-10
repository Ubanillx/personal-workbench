import { appConfig } from "../lib/context.server";
import { dashboardData } from "../lib/dashboard.server";
import { ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";

/** GET /api/dashboard —— 逻辑在 app/lib/dashboard.server.ts，与 UI 的 loader 共用 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(dashboardData(auth.user));
}
