import { appConfig } from "../lib/context.server";
import { db, run } from "../lib/db.server";
import { ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";

/** DELETE /api/todos/:id —— 不存在也返回 200（与旧实现一致） */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  run(db(), "DELETE FROM todos WHERE id=?", params.id);
  return ok(null);
}
