import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { returnReport } from "../lib/reports.server";
import { requireManager } from "../lib/session.server";

/**
 * POST /api/reports/:id/return —— 管理员或**本组织**组织管理者，仅"已提交"状态，必须填写原因。
 * 组织边界与状态判定在 app/lib/reports.server.ts（跨组织 404）。
 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = returnReport(auth.user, String(params.id), body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
