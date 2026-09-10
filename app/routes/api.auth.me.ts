import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { optionalUser } from "../lib/session.server";

/** GET /api/auth/me —— 未登录返回 401（与旧实现同码同文案） */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const user = optionalUser(request, appConfig().sessionCookieName);
  if (!user) return fail("UNAUTHENTICATED", "请先完成访问验证", 401);
  return ok({ user });
}
