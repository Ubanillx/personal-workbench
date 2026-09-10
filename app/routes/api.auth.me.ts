import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/auth/me —— 当前登录账号。
 *
 * 返回的 user 来自 session.server 的统一 SELECT，因此天然带 `username`、`email`、`orgId`、
 * `orgName`、`mustChangePassword`（见 docs/harness/ACCOUNTS_AND_ORGS.md §7.3），这里不再另拼字段。
 * 用 skipPasswordGate：本端点就是「看自己」，被强制改密的账号必须仍能读到自己的身份与状态。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName, { skipPasswordGate: true });
  if (!auth.ok) return auth.response;
  return ok({ user: auth.user });
}
