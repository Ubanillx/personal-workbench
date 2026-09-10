import { db, now, run } from "../lib/db.server";
import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";

/** PATCH /api/users/:id —— 启用/停用成员；停用会同时撤销其会话与令牌 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (id === "owner") return fail("VALIDATION_ERROR", "不能停用主人账户", 400);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.isActive !== "boolean") return fail("VALIDATION_ERROR", "isActive 必须是布尔值", 400);
  const active = body.isActive;
  const result = run(db(), "UPDATE users SET is_active=?,updated_at=? WHERE id=?", active ? 1 : 0, now(), id) as { changes: number };
  if (!result.changes) return fail("NOT_FOUND", "成员不存在", 404);
  if (!active) {
    run(db(), "UPDATE access_sessions SET revoked_at=? WHERE user_id=?", now(), id);
    run(db(), "UPDATE access_tokens SET revoked_at=? WHERE user_id=?", now(), id);
  }
  return ok(null);
}
