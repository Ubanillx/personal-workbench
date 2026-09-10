import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { failureResponse } from "../lib/records.server";
import { requireAuth } from "../lib/session.server";
import { deleteTodoRecord, updateTodoRecord } from "../lib/todos.server";

/**
 * PATCH /api/todos/:id —— 更新
 * DELETE /api/todos/:id —— 删除
 * RR8 的 action 负责该路径的所有非 GET 方法，因此在这里按方法分派。
 *
 * 单条操作先在域里取出该行的 `org_id` 判定组织边界（§14.2）：不存在与跨组织都走 notFound()，
 * 响应完全一致，不泄露资源是否存在。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;

  if (request.method === "DELETE") {
    const removed = deleteTodoRecord(auth.user, id);
    if (!removed.ok) return failureResponse(removed);
    return ok(null);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = updateTodoRecord(auth.user, id, body);
  if (!updated.ok) return failureResponse(updated);
  return ok(updated.data);
}
