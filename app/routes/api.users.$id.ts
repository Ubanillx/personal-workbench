import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { setUserActive } from "../lib/users.server";

/** PATCH /api/users/:id —— 启用/停用成员；逻辑在 app/lib/users.server.ts */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (id === "owner") return fail("VALIDATION_ERROR", "不能停用主人账户", 400);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.isActive !== "boolean") return fail("VALIDATION_ERROR", "isActive 必须是布尔值", 400);
  if (!setUserActive(id, body.isActive)) return fail("NOT_FOUND", "成员不存在", 404);
  return ok(null);
}
