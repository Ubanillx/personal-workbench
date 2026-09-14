import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { TaskPriority, TaskStatus, UserRole } from "../../shared/types/domain";
import { appDatabase } from "./context.server";

export type Db = DatabaseSync;

/** 会话里的当前用户（含组织上下文） */
export type User = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  orgId: string | null;
  orgName: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
};

/** 取共享的 SQLite 连接；数据库不可用时抛错（与旧实现"必需数据库"的路由一致） */
export function db(): Db {
  const database = appDatabase();
  if (!database) throw new Error("SQLite 数据库不可用");
  return database.getDatabase();
}

export function one<T = Record<string, unknown>>(database: Db, sql: string, ...params: unknown[]): T | null {
  return (database.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
}
export function rows<T = Record<string, unknown>>(database: Db, sql: string, ...params: unknown[]): T[] {
  return database.prepare(sql).all(...(params as SQLInputValue[])) as T[];
}
export function run(database: Db, sql: string, ...params: unknown[]): unknown {
  return database.prepare(sql).run(...(params as SQLInputValue[]));
}

export function now(): string {
  return new Date().toISOString();
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function newId(): string {
  return randomUUID();
}

/** 会话/成员路径的用户映射：isActive 与 mustChangePassword 统一转成布尔 */
export function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    username: String(row.username ?? ""),
    email: String(row.email ?? ""),
    name: String(row.name),
    role: String(row.role) as UserRole,
    orgId: row.orgId === null || row.orgId === undefined ? null : String(row.orgId),
    orgName: row.orgName === null || row.orgName === undefined ? null : String(row.orgName),
    isActive: Number(row.isActive ?? row.is_active) === 1,
    mustChangePassword: Number(row.mustChangePassword ?? row.must_change_password) === 1,
  };
}

/** 用户查询的列清单：会话与鉴权共用，保证 toUser 拿到 orgName 等字段 */
const USER_COLUMNS = `u.id AS id,
                       u.username AS username,
                       u.email AS email,
                       u.name AS name,
                       u.role AS role,
                       u.org_id AS orgId,
                       o.name AS orgName,
                       u.is_active AS isActive,
                       u.must_change_password AS mustChangePassword`;

const USER_FROM = `FROM users u LEFT JOIN organizations o ON o.id = u.org_id`;

export const USER_SELECT = `SELECT ${USER_COLUMNS} ${USER_FROM}`;

/**
 * 登录专用：多带一列 password_hash。
 * 刻意**不**把 password_hash 放进 USER_SELECT——会话对象不该在内存里带着密码哈希。
 */
export const USER_AUTH_SELECT = `SELECT ${USER_COLUMNS}, u.password_hash AS passwordHash ${USER_FROM}`;

export function priority(value: unknown): TaskPriority {
  return value === "P0" || value === "P2" ? value : "P1";
}
export function isStatus(value: string): value is TaskStatus {
  return value === "todo" || value === "in_progress" || value === "pending_review" || value === "completed";
}
export function clamp(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
}
export function date(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}
export function ownerIdOf(value: unknown, fallback: string | null): string | null {
  return value === undefined || value === null || value === "" || value === "unassigned"
    ? value === undefined
      ? fallback
      : null
    : typeof value === "string"
      ? value
      : fallback;
}

/**
 * 复选框类字段的统一解释：`true` / `1` / `"1"` / `"true"` / `"on"` 为真，其余为假。
 *
 * 页面 action 的两种提交方式给出的类型并不一样（`readPayload`：JSON 给 boolean、
 * 表单编码给 string），而 `Boolean("false")` 是 `true`——「取消私密」这类操作会被读反。
 * 凡是「勾选 = 开关」的字段都必须过这一道，别直接写 `body.x ? 1 : 0`。
 */
export function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}
export function inboxFingerprint(item: Record<string, unknown>, title: string): string {
  const supplied = typeof item.fingerprint === "string" ? item.fingerprint.trim() : "";
  return (
    supplied ||
    hash(`${String(item.sender ?? "").trim()}\n${title}\n${String(item.messageAt ?? item.createdAt ?? item.dueDate ?? "").trim()}`)
  );
}
