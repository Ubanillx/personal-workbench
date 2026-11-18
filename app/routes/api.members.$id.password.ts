import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { resetUserPassword } from "../lib/organization.server";
import { requireAdmin } from "../lib/session.server";

/**
 * POST /api/members/:id/password —— 管理员重置他人密码
 *
 * body：`{ generate: true }` 由服务端生成随机密码并返回一次；或 `{ password }` 手动指定。
 * 重置后该账号 must_change_password=1，且全部现有会话立即失效；不能重置自己。
 * 详见 docs/harness/ACCOUNTS_AND_ORGS.md §5.4。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAdmin(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await resetUserPassword(auth.user, params.id, { password: body.password, generate: body.generate });
  return result.ok ? ok(result.data) : result.response;
}
