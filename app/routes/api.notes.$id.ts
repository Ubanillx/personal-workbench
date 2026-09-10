import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { deleteNoteRecord, updateNoteRecord } from "../lib/notes.server";
import { requireOwner } from "../lib/session.server";

/**
 * PATCH /api/notes/:id —— 更新
 * DELETE /api/notes/:id —— 删除（不存在也返回 200）
 * RR8 的 action 负责该路径的所有非 GET 方法，因此在这里按方法分派。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;

  if (request.method === "DELETE") {
    deleteNoteRecord(id);
    return ok(null);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = updateNoteRecord(id, body);
  if (!updated) return fail("NOT_FOUND", "笔记不存在", 404);
  return ok(updated);
}
