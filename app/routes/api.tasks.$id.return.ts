import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireManager } from "../lib/session.server";
import { returnTask } from "../lib/task-service.server";

/** POST /api/tasks/:id/return —— 管理员或组织管理者退回；逻辑在 app/lib/task-service.server.ts */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = returnTask(auth.user, String(params.id), body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
