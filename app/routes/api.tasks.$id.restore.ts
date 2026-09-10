import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireManager } from "../lib/session.server";
import { restoreTask } from "../lib/task-service.server";

/** POST /api/tasks/:id/restore —— 管理员或组织管理者恢复归档；逻辑在 app/lib/task-service.server.ts */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = restoreTask(auth.user, String(params.id));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
