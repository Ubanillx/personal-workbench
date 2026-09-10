import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { listActivity } from "../lib/task-service.server";

/** GET /api/tasks/:id/activity —— 逻辑在 app/lib/task-service.server.ts */
export async function loader({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = listActivity(auth.user, String(params.id));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
