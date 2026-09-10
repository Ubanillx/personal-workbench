import { randomUUID } from "node:crypto";
import { db, hash, newToken, now, one, run, toUser, type User } from "./db.server";
import { fail } from "./http.server";

const SESSION_MAX_AGE_SECONDS = 2592000;
const SESSION_TTL_MS = 2592000000;

/** 从请求的 Cookie 头里取指定名字的值 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** 会话 Cookie 的序列化：与旧 @fastify/cookie 的属性保持一致 */
export function sessionCookie(name: string, value: string, secure: boolean): string {
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${SESSION_MAX_AGE_SECONDS}`, "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
export function clearedSessionCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function isSecureRequest(request: Request): boolean {
  if (request.headers.get("x-forwarded-proto") === "https") return true;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionUser(request: Request, cookieName: string): User | null {
  const raw = readCookie(request, cookieName);
  if (!raw) return null;
  const row = one(
    db(),
    "SELECT u.id,u.name,u.role,u.is_active AS isActive FROM access_sessions s JOIN users u ON u.id=s.user_id WHERE s.session_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.is_active=1",
    hash(raw),
    now(),
  );
  return row ? toUser(row) : null;
}

export function userByToken(token: string): User | null {
  const row = one(
    db(),
    "SELECT u.id,u.name,u.role,u.is_active AS isActive FROM access_tokens a JOIN users u ON u.id=a.user_id WHERE a.token_hash=? AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?) AND u.is_active=1",
    hash(token),
    now(),
  );
  return row ? toUser(row) : null;
}

/** 新建会话并返回原始 session 值（仅用于写入 Cookie，落库只存 sha256） */
export function createSession(userId: string): string {
  const raw = newToken();
  run(
    db(),
    "INSERT INTO access_sessions(id,user_id,session_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)",
    randomUUID(),
    userId,
    hash(raw),
    now(),
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  );
  return raw;
}

export function revokeSession(raw: string): void {
  run(db(), "UPDATE access_sessions SET revoked_at=? WHERE session_hash=?", now(), hash(raw));
}

export type AuthResult = { ok: true; user: User } | { ok: false; response: Response };

export function requireAuth(request: Request, cookieName: string): AuthResult {
  const user = sessionUser(request, cookieName);
  if (!user) return { ok: false, response: fail("UNAUTHENTICATED", "请先完成访问验证", 401) };
  return { ok: true, user };
}

export function requireOwner(request: Request, cookieName: string): AuthResult {
  const result = requireAuth(request, cookieName);
  if (!result.ok) return result;
  if (result.user.role !== "owner") return { ok: false, response: fail("FORBIDDEN", "只有主人可以访问此功能", 403) };
  return result;
}

/** 会话里的用户；用于无需区分 401/403 的场景 */
export function optionalUser(request: Request, cookieName: string): User | null {
  return sessionUser(request, cookieName);
}
