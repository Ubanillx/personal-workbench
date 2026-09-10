import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { deleteTodoRecord, updateTodoRecord } from "../lib/todos.server";

/**
 * PATCH /api/todos/:id —— 更新
 * DELETE /api/todos/:id —— 删除（不存在也返回 200，与旧实现一致）
 * RR8 的 action 负责该路径的所有非 GET 方法，因此在这里按方法分派。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;

  if (request.method === "DELETE") {
    deleteTodoRecord(id);
    return ok(null);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = updateTodoRecord(id, body);
  if (!updated) return fail("NOT_FOUND", "待办不存在", 404);
  return ok(updated);
}
