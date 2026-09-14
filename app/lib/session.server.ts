import { randomUUID } from "node:crypto";
import type { UserRole } from "../../shared/types/domain";
import { hashPassword, isLockedPasswordHash, validatePassword, verifyPassword } from "../../server/src/security/password";
import { db, hash, now, one, run, toUser, USER_AUTH_SELECT, USER_SELECT, type User } from "./db.server";
import { fail } from "./http.server";

/**
 * 认证：用户名 + 密码 → HttpOnly 会话 Cookie。
 *
 * 设计见 docs/harness/ACCOUNTS_AND_ORGS.md：
 * - 密码用 scrypt（参数与盐写在哈希串里），库里只有哈希；
 * - `must_change_password=1` 时除「看自己 / 改密 / 登出」外的请求一律 403 PASSWORD_CHANGE_REQUIRED；
 * - 角色：admin（全局）/ manager（本组织）/ member（本组织内的普通成员）；
 * - 跨组织访问一律 404（不返回 403，避免泄露资源是否存在）。
 */

const SESSION_MAX_AGE_SECONDS = 2592000;
const SESSION_TTL_MS = 2592000000;

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/u;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/* ------------------------------------------------------------------ Cookie */

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

/* ------------------------------------------------------------------ 会话 */

export function sessionUser(request: Request, cookieName: string): User | null {
  const raw = readCookie(request, cookieName);
  if (!raw) return null;
  const row = one<Record<string, unknown>>(
    db(),
    `${USER_SELECT} JOIN access_sessions s ON s.user_id = u.id
      WHERE s.session_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.is_active=1`,
    hash(raw),
    now(),
  );
  return row ? toUser(row) : null;
}

/** 新建会话并返回原始 session 值（仅用于写入 Cookie，落库只存 sha256） */
export function createSession(userId: string): string {
  const raw = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
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

/** 改密后撤销该用户的其他会话，保留当前这个 */
export function revokeOtherSessions(userId: string, keepRaw: string | null): number {
  const result = run(
    db(),
    "UPDATE access_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND session_hash<>?",
    now(),
    userId,
    keepRaw ? hash(keepRaw) : "",
  ) as { changes: number };
  return result.changes;
}

/* ------------------------------------------------------------------ 登录 / 注册 / 改密 */

export type RegisterInput = { username: unknown; email: unknown; password: unknown; name: unknown };
export type AuthFailure = { ok: false; code: string; message: string; status: number };
export type AuthSuccess = { ok: true; user: User };

function field(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 注册：开放注册（D-20），注册后**没有组织**（D-24），可以立即登录但只能看组织列表与申请页。
 */
export async function registerAccount(input: RegisterInput): Promise<AuthSuccess | AuthFailure> {
  const username = field(input.username);
  const email = field(input.email);
  const name = field(input.name) || username;
  const password = typeof input.password === "string" ? input.password : "";

  if (!USERNAME_PATTERN.test(username))
    return { ok: false, code: "VALIDATION_ERROR", message: "用户名需为 3-32 位字母、数字、下划线或短横线", status: 400 };
  if (!EMAIL_PATTERN.test(email)) return { ok: false, code: "VALIDATION_ERROR", message: "邮箱格式不正确", status: 400 };
  const weak = validatePassword(password);
  if (weak) return { ok: false, code: "VALIDATION_ERROR", message: weak, status: 400 };

  const taken = one<{ id: string }>(db(), "SELECT id FROM users WHERE username=? OR email=?", username, email);
  if (taken) return { ok: false, code: "ACCOUNT_EXISTS", message: "用户名或邮箱已被使用", status: 400 };

  const id = randomUUID();
  const stamp = now();
  run(
    db(),
    "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,0,1,?,?)",
    id,
    username,
    email,
    name,
    "member",
    await hashPassword(password),
    stamp,
    stamp,
  );
  const user = one<Record<string, unknown>>(db(), `${USER_SELECT} WHERE u.id=?`, id);
  if (!user) return { ok: false, code: "INTERNAL", message: "注册失败", status: 500 };
  return { ok: true, user: toUser(user) };
}

/** 登录：用户名 + 密码。失败一律同一条消息，避免枚举账号 */
export async function authenticate(username: unknown, password: unknown): Promise<User | null> {
  const name = field(username);
  const secret = typeof password === "string" ? password : "";
  if (!name || !secret) return null;
  // 单独查询：USER_SELECT 是给会话用的，**不含 password_hash**（不应把它带进内存里的会话对象）
  const row = one<Record<string, unknown>>(db(), `${USER_AUTH_SELECT} WHERE u.username=? AND u.is_active=1`, name);
  if (!row) return null;
  const stored = String(row.passwordHash ?? "");
  if (isLockedPasswordHash(stored)) return null;
  if (!(await verifyPassword(secret, stored))) return null;
  return toUser(row);
}

/** 本人改密：需要旧密码。成功后撤销其他会话 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: unknown,
  nextPassword: unknown,
  keepSessionRaw: string | null,
): Promise<{ ok: true; revokedSessions: number } | AuthFailure> {
  const row = one<{ passwordHash: string }>(db(), "SELECT password_hash AS passwordHash FROM users WHERE id=?", userId);
  if (!row) return { ok: false, code: "UNAUTHENTICATED", message: "请先完成访问验证", status: 401 };
  if (!(await verifyPassword(typeof currentPassword === "string" ? currentPassword : "", row.passwordHash))) {
    return { ok: false, code: "INVALID_PASSWORD", message: "当前密码不正确", status: 400 };
  }
  const weak = validatePassword(typeof nextPassword === "string" ? nextPassword : "");
  if (weak) return { ok: false, code: "VALIDATION_ERROR", message: weak, status: 400 };
  run(
    db(),
    "UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?",
    await hashPassword(String(nextPassword)),
    now(),
    userId,
  );
  return { ok: true, revokedSessions: revokeOtherSessions(userId, keepSessionRaw) };
}

/* ------------------------------------------------------------------ 鉴权助手 */

export type AuthResult = { ok: true; user: User } | { ok: false; response: Response };

/**
 * 需要登录。`skipPasswordGate` 只给「看自己 / 改密 / 登出」用：
 * 其余端点在被强制改密时一律 403，避免带着初始密码长期使用。
 */
export function requireAuth(request: Request, cookieName: string, options: { skipPasswordGate?: boolean } = {}): AuthResult {
  const user = sessionUser(request, cookieName);
  if (!user) return { ok: false, response: fail("UNAUTHENTICATED", "请先完成访问验证", 401) };
  if (user.mustChangePassword && !options.skipPasswordGate) {
    return { ok: false, response: fail("PASSWORD_CHANGE_REQUIRED", "请先修改初始密码", 403) };
  }
  return { ok: true, user };
}

/** 仅全局管理员 */
export function requireAdmin(request: Request, cookieName: string): AuthResult {
  const result = requireAuth(request, cookieName);
  if (!result.ok) return result;
  if (result.user.role !== "admin") return { ok: false, response: fail("FORBIDDEN", "只有管理员可以访问此功能", 403) };
  return result;
}

/** 管理员或组织管理者（具体是否管得着某个组织，由调用方用 assertOrgManage 判断） */
export function requireManager(request: Request, cookieName: string): AuthResult {
  const result = requireAuth(request, cookieName);
  if (!result.ok) return result;
  if (result.user.role !== "admin" && result.user.role !== "manager") {
    return { ok: false, response: fail("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403) };
  }
  return result;
}

/** 会话里的用户；用于无需区分 401/403 的场景 */
export function optionalUser(request: Request, cookieName: string): User | null {
  return sessionUser(request, cookieName);
}

/* ------------------------------------------------------------------ 组织边界 */

/**
 * 会话用户能看到的数据范围：
 * - 管理员：null 表示「所有组织」
 * - 其他人：自己的组织 id；**未入组时也是 null**（注册后还没审批通过就是这种状态）
 *
 * ⚠️ 正因为「管理员」和「未入组的普通用户」都返回 null，直接把 null 当成「不加条件」会**跨组织泄露**。
 * 读数据一律用下面的 `orgFilter()`，不要自己判断返回值。
 */
export function orgScope(user: User): string | null {
  return user.role === "admin" ? null : user.orgId;
}

/**
 * 组织过滤条件（读数据的唯一正确入口）：
 * - 管理员 → 空条件（D-28 的合并视图 + 组织筛选器）
 * - 已入组的普通用户/组织管理者 → `org_id=?`
 * - **未入组的普通用户 → `1=0`**（一条都看不到，而不是看到全部）
 *
 * 用法：
 * ```ts
 * const scope = orgFilter(user, "t.org_id");
 * const sql = `SELECT ... FROM tasks t WHERE 1=1 ${scope.clause ? `AND ${scope.clause}` : ""}`;
 * rows(db(), sql, ...scope.params);
 * ```
 */
export function orgFilter(user: User, column = "org_id"): { clause: string; params: string[] } {
  if (user.role === "admin") return { clause: "", params: [] };
  if (!user.orgId) return { clause: "1=0", params: [] };
  return { clause: `${column}=?`, params: [user.orgId] };
}

/**
 * 判断能否访问某组织的数据。返回 null 表示可以，否则返回应当直接回给客户端的响应。
 * 跨组织一律 404（D-28 的隔离语义），不泄露资源是否存在。
 */
export function assertOrgAccess(user: User, resourceOrgId: string | null | undefined): Response | null {
  if (user.role === "admin") return null;
  if (!resourceOrgId || user.orgId !== resourceOrgId) return notFound();
  return null;
}

/**
 * 同组织但资源不可见的统一响应（**403**，不是 404）与它的文案。
 *
 * 与 `assertOrgAccess` 的分工刻意分开（D-35 / D-54 / D-55）：
 * - 跨组织 → 404：连「有没有这条资源」都不该知道；
 * - 本组织但没权限（别人的私密任务、别人的待办、别人的个人文件）→ 403：对方本来就知道
 *   组织里有这条东西，藏成「不存在」会让「权限不足」与「记录被删了」变成同一种现象。
 *
 * 各业务域**共用这一个信封**，只是把人话动词传进来（「查看任务」/「访问记录」/「访问该文件」）。
 */
export function forbidden(message: string): Response {
  return fail("FORBIDDEN", message, 403);
}

/** 能否「管理」某组织（改信息、审批申请、管成员）：管理员任意，组织管理者仅本组织 */
export function assertOrgManage(user: User, orgId: string): Response | null {
  if (user.role === "admin") return null;
  if (user.role === "manager" && user.orgId === orgId) return null;
  return notFound();
}

export function notFound(): Response {
  return fail("NOT_FOUND", "未找到该资源", 404);
}

/** 组织是否处于可用状态（已解散的组织不能写入） */
export function orgIsActive(user: User, orgId: string | null): boolean {
  if (!orgId) return false;
  const row = one<{ status: string }>(db(), "SELECT status FROM organizations WHERE id=?", orgId);
  return row?.status === "active";
}

export function roleLabel(role: UserRole): string {
  return role === "admin" ? "管理员" : role === "manager" ? "组织管理者" : "普通用户";
}
