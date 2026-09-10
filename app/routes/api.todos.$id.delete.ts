import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { deleteTodoRecord } from "../lib/todos.server";

/** DELETE /api/todos/:id —— 不存在也返回 200（与旧实现一致）；逻辑在 app/lib/todos.server.ts */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  deleteTodoRecord(params.id);
  return ok(null);
}
