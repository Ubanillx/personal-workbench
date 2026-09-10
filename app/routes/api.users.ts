import { randomUUID } from "node:crypto";
import { db, hash, newToken, now, rows, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { appConfig } from "../lib/context.server";
import { requireOwner } from "../lib/session.server";

/**
 * 路由模块只允许导出路由 API（loader/action/Component 等）。
 * 任何额外导出都会让该模块被视为客户端可达，从而拒绝它引入 *.server 模块
 * —— 因此成员查询等辅助函数放在 app/lib/users.server.ts。
 */

/** GET /api/users —— 仅主人；注意 isActive 返回原始行值（1/0），与会话路径的布尔不同 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(
    rows(db(), "SELECT id,name,role,is_active AS isActive,created_at AS createdAt,updated_at AS updatedAt FROM users ORDER BY role,name"),
  );
}

/** POST /api/users —— 新建成员并返回一次性令牌 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  const role = body.role === "assistant" || body.role === "viewer" ? body.role : null;
  if (!name || !role) return fail("VALIDATION_ERROR", "请填写成员名称并选择角色", 400);
  const stamp = now();
  const id = randomUUID();
  const token = newToken();
  run(db(), "INSERT INTO users(id,name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, name, role, 1, stamp, stamp);
  run(
    db(),
    "INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)",
    randomUUID(),
    id,
    hash(token),
    stamp,
  );
  return ok({ user: { id, name, role, isActive: true, createdAt: stamp, updatedAt: stamp }, token }, 201);
}
