import { redirect } from "react-router";
import { appConfig } from "../lib/context.server";
import { clearedSessionCookie, readCookie, revokeSession } from "../lib/session.server";

/** POST /logout —— 撤销会话、清 Cookie，并把人送回登录页（浏览器表单提交，不是 API） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const cookieName = appConfig().sessionCookieName;
  const raw = readCookie(request, cookieName);
  if (raw) revokeSession(raw);
  const response = redirect("/login");
  response.headers.append("set-cookie", clearedSessionCookie(cookieName));
  return response;
}
