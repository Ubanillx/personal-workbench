import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { archiveTask } from "../lib/task-service.server";

/** POST /api/tasks/:id/archive —— 逻辑在 app/lib/task-service.server.ts */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = archiveTask(auth.user, String(params.id));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
