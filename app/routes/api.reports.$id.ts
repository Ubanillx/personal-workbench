import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { reportRepository, toView } from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/** GET /api/reports/:id —— 助理只能看自己的，查看者 403 */
export async function loader({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (user.role === "viewer") return fail("FORBIDDEN", "查看者不能访问周报", 403);
  const repo = reportRepository();
  const report = repo.findById(String(params.id));
  if (!report) return fail("NOT_FOUND", "周报不存在", 404);
  if (user.role === "assistant" && report.ownerId !== user.id) return fail("FORBIDDEN", "无权查看该周报", 403);
  return ok(toView(report, repo));
}
