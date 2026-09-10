import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { createSession, isSecureRequest, sessionCookie, userByToken } from "../lib/session.server";

/** POST /api/auth/access —— 用访问令牌换取会话 Cookie */
export async function action({ request }: { request: Request }): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const token = String(body.token ?? "").trim();
  const user = token ? userByToken(token) : null;
  if (!user) return fail("INVALID_TOKEN", "访问令牌无效", 401);
  const raw = createSession(user.id);
  const response = ok({ user });
  response.headers.append("set-cookie", sessionCookie(appConfig().sessionCookieName, raw, isSecureRequest(request)));
  return response;
}
