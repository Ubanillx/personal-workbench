import { appConfig } from "../lib/context.server";
import { db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { findNote } from "../lib/records.server";
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
    run(db(), "DELETE FROM notes WHERE id=?", id);
    return ok(null);
  }

  const current = findNote(id);
  if (!current) return fail("NOT_FOUND", "笔记不存在", 404);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  run(
    db(),
    "UPDATE notes SET content=?,is_pinned=?,updated_at=? WHERE id=?",
    String(body.content ?? current.content),
    body.isPinned === undefined ? Number(current.isPinned) : body.isPinned ? 1 : 0,
    now(),
    id,
  );
  return ok(findNote(id));
}
