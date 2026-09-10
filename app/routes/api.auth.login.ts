import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { authenticate, createSession, isSecureRequest, sessionCookie } from "../lib/session.server";

/**
 * POST /api/auth/login —— 用户名 + 密码换取会话 Cookie（令牌登录已在本次改造中整体退役）。
 *
 * 失败一律 401 UNAUTHENTICATED + 同一句文案：不区分「账号不存在」与「密码错误」，避免枚举账号。
 * 登录本身不做强制改密拦截（否则用户没有入口去改密），门禁由 requireAuth 在业务端点上执行。
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const user = await authenticate(body.username, body.password);
  if (!user) return fail("UNAUTHENTICATED", "用户名或密码不正确", 401);

  const cookieName = appConfig().sessionCookieName;
  const response = ok({ user });
  response.headers.append("set-cookie", sessionCookie(cookieName, createSession(user.id), isSecureRequest(request)));
  return response;
}
