import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { createUserRecord, listUsers } from "../lib/users.server";

/**
 * 路由模块只允许导出路由 API（loader/action/Component 等）。
 * 任何额外导出都会让该模块被视为客户端可达，从而拒绝它引入 *.server 模块
 * —— 因此成员查询等辅助函数放在 app/lib/users.server.ts。
 */

/** GET /api/users —— 仅主人；注意 isActive 返回原始行值（1/0），与会话路径的布尔不同 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(listUsers());
}

/** POST /api/users —— 逻辑在 app/lib/users.server.ts，与协作管理页共用 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = createUserRecord(String(body.name ?? ""), body.role);
  if (!created) return fail("VALIDATION_ERROR", "请填写成员名称并选择角色", 400);
  return ok(created, 201);
}
