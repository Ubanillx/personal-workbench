import type { DatabaseSync } from "node:sqlite";
import type { CurrentUser, UserRole } from "../../../../shared/types/domain";

export type UserRecord = CurrentUser & { isActive: boolean; createdAt: string; updatedAt: string };

export class UserRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public findById(id: string): UserRecord | null {
    const row = this.database.prepare("SELECT id, name, role, is_active, created_at, updated_at FROM users WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return row ? toUserRecord(row) : null;
  }

  public findAll(): UserRecord[] {
    return (
      this.database.prepare("SELECT id, name, role, is_active, created_at, updated_at FROM users ORDER BY created_at").all() as Array<
        Record<string, unknown>
      >
    ).map(toUserRecord);
  }
}

function toUserRecord(row: Record<string, unknown>): UserRecord {
  const role = String(row.role);
  if (role !== "owner" && role !== "assistant" && role !== "viewer") throw new Error("Invalid user role");
  return {
    id: String(row.id),
    name: String(row.name),
    role: role as UserRole,
    isActive: Number(row.is_active) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
