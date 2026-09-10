import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { clearedSessionCookie, readCookie, revokeSession } from "../lib/session.server";

/** POST /api/auth/logout —— 撤销当前会话并清 Cookie（无会话时同样返回 200） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const cookieName = appConfig().sessionCookieName;
  const raw = readCookie(request, cookieName);
  if (raw) revokeSession(raw);
  const response = ok(null);
  response.headers.append("set-cookie", clearedSessionCookie(cookieName));
  return response;
}
