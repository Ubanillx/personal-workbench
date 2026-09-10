import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { deleteNoteRecord, updateNoteRecord } from "../lib/notes.server";
import { failureResponse } from "../lib/records.server";
import { requireAuth } from "../lib/session.server";

/**
 * PATCH /api/notes/:id —— 更新
 * DELETE /api/notes/:id —— 删除
 * RR8 的 action 负责该路径的所有非 GET 方法，因此在这里按方法分派。
 *
 * 单条操作先在域里取出该行的 `org_id` 判定组织边界（§14.2）：不存在与跨组织都走 notFound()。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;

  if (request.method === "DELETE") {
    const removed = deleteNoteRecord(auth.user, id);
    if (!removed.ok) return failureResponse(removed);
    return ok(null);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = updateNoteRecord(auth.user, id, body);
  if (!updated.ok) return failureResponse(updated);
  return ok(updated.data);
}
