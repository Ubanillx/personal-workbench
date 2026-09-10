import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { createSession, isSecureRequest, registerAccount, sessionCookie } from "../lib/session.server";

/**
 * POST /api/auth/register —— 开放注册（D-20）：用户名 + 邮箱 + 密码 + 显示名。
 *
 * 校验（用户名 3-32 位、邮箱格式、密码 ≥8 位、用户名与邮箱唯一）全部在 registerAccount 里，
 * 这里只负责把 `{ code, message, status }` 原样转成响应信封；成功即建立会话（注册后可立即使用），
 * 新账号 role=member 且 org_id 为 NULL，因此前端会把它送到 /join（D-24 / D-34）。
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await registerAccount({
    username: body.username,
    email: body.email,
    password: body.password,
    name: body.name,
  });
  if (!result.ok) return fail(result.code, result.message, result.status);

  const cookieName = appConfig().sessionCookieName;
  const response = ok({ user: result.user }, 201);
  response.headers.append("set-cookie", sessionCookie(cookieName, createSession(result.user.id), isSecureRequest(request)));
  return response;
}
