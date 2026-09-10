import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { deleteTask, updateTask } from "../lib/task-service.server";

type Params = { request: Request; params: { id?: string } };

/** PATCH /api/tasks/:id 与 DELETE /api/tasks/:id —— 都仅主人可用；逻辑在 task-service.server.ts */
export async function action({ request, params }: Params): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = String(params.id);
  if (request.method === "DELETE") {
    const removed = deleteTask(auth.user, id);
    return removed.ok ? ok(removed.data, removed.status) : fail(removed.code, removed.message, removed.status);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = updateTask(auth.user, id, body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}
