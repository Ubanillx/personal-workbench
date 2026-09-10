import { randomUUID } from "node:crypto";
import type { UserRole } from "../../shared/types/domain";
import { db, hash, newToken, now, one, rows, run } from "./db.server";

/**
 * 成员管理共享逻辑：页面 loader/action 与 /api/users*、/api/access-info 共用。
 * 注意路由模块不得有额外导出，因此这些函数必须放在 *.server.ts 里。
 */

export function listUsers(): Record<string, unknown>[] {
  return rows(
    db(),
    "SELECT id,name,role,is_active AS isActive,created_at AS createdAt,updated_at AS updatedAt FROM users ORDER BY role,name",
  );
}

/** 供页面与 API 共用的"主人可见成员"列表（非主人返回空数组，与旧前端的降级行为一致） */
export function listUsersFor(role: UserRole): Record<string, unknown>[] {
  return role === "owner" ? listUsers() : [];
}

export function memberExists(id: string): boolean {
  return Boolean(one(db(), "SELECT id FROM users WHERE id=? AND id<>?", id, "owner"));
}

/** 新建成员并返回一次性令牌；字段非法时返回 null */
export function createUserRecord(name: string, role: unknown): { user: Record<string, unknown>; token: string } | null {
  const trimmed = name.trim();
  const resolvedRole = role === "assistant" || role === "viewer" ? role : null;
  if (!trimmed || !resolvedRole) return null;
  const stamp = now();
  const id = randomUUID();
  const token = newToken();
  run(
    db(),
    "INSERT INTO users(id,name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    id,
    trimmed,
    resolvedRole,
    1,
    stamp,
    stamp,
  );
  run(
    db(),
    "INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)",
    randomUUID(),
    id,
    hash(token),
    stamp,
  );
  return { user: { id, name: trimmed, role: resolvedRole, isActive: true, createdAt: stamp, updatedAt: stamp }, token };
}

/** 启用/停用成员；停用会同时撤销其会话与令牌。返回 false 表示成员不存在 */
export function setUserActive(id: string, active: boolean): boolean {
  const stamp = now();
  const result = run(db(), "UPDATE users SET is_active=?,updated_at=? WHERE id=?", active ? 1 : 0, stamp, id) as { changes: number };
  if (!result.changes) return false;
  if (!active) {
    run(db(), "UPDATE access_sessions SET revoked_at=? WHERE user_id=?", stamp, id);
    run(db(), "UPDATE access_tokens SET revoked_at=? WHERE user_id=?", stamp, id);
  }
  return true;
}

/** 重新签发成员令牌（旧令牌立即失效） */
export function rotateUserToken(id: string): string {
  const token = newToken();
  const stamp = now();
  run(db(), "UPDATE access_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", stamp, id);
  run(
    db(),
    "INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)",
    randomUUID(),
    id,
    hash(token),
    stamp,
  );
  return token;
}
