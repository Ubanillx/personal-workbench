import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { changeOwnPassword, readCookie, requireAuth } from "../lib/session.server";

/**
 * POST /api/auth/password —— 本人改密（旧密码 + 新密码）。
 *
 * - 用 skipPasswordGate：被强制改密的账号必须能调到本端点，否则会死锁在 PASSWORD_CHANGE_REQUIRED；
 * - 成功后由 changeOwnPassword 撤销该用户的**其他**会话，保留当前会话（§5.3）。
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const cookieName = appConfig().sessionCookieName;
  const auth = requireAuth(request, cookieName, { skipPasswordGate: true });
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // currentPassword/newPassword 为准，同时兼容 oldPassword/nextPassword 的写法
  const currentPassword = body.currentPassword ?? body.oldPassword;
  const newPassword = body.newPassword ?? body.nextPassword;

  const result = await changeOwnPassword(auth.user.id, currentPassword, newPassword, readCookie(request, cookieName));
  if (!result.ok) return fail(result.code, result.message, result.status);
  return ok({ revokedSessions: result.revokedSessions });
}
