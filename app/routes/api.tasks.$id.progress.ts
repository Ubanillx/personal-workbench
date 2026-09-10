import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { reportProgress } from "../lib/task-service.server";

/** POST /api/tasks/:id/progress —— 逻辑在 app/lib/task-service.server.ts */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = reportProgress(auth.user, String(params.id), body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
