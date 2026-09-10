import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { TaskPriority, TaskStatus, UserRole } from "../../shared/types/domain";
import { appDatabase } from "./context.server";

export type Db = DatabaseSync;
export type User = { id: string; name: string; role: UserRole; isActive: boolean };

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
export function newToken(): string {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 与旧实现逐字段一致：isActive 在会话/令牌路径转成布尔，列表路径仍返回原始行 */
export function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role) as UserRole,
    isActive: Number(row.isActive ?? row.is_active) === 1,
  };
}

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
export function inboxFingerprint(item: Record<string, unknown>, title: string): string {
  const supplied = typeof item.fingerprint === "string" ? item.fingerprint.trim() : "";
  return (
    supplied ||
    hash(`${String(item.sender ?? "").trim()}\n${title}\n${String(item.messageAt ?? item.createdAt ?? item.dueDate ?? "").trim()}`)
  );
}
