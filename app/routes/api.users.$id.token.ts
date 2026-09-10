import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { memberExists, rotateUserToken } from "../lib/users.server";

/** POST /api/users/:id/token —— 重新签发成员令牌（旧令牌立即失效） */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (!memberExists(id)) return fail("NOT_FOUND", "成员不存在", 404);
  return ok({ token: rotateUserToken(id) });
}
