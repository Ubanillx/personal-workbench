import type { DatabaseSync } from "node:sqlite";
import type { TaskPriority, TaskSource, TaskStatus } from "../../../../shared/types/domain";

export type TaskRecord = {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  progress: number;
  dueDate: string | null;
  ownerId: string | null;
  createdBy: string;
  source: TaskSource;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};
export type CreateTaskInput = TaskRecord;
export type UpdateTaskInput = Partial<Omit<TaskRecord, "id">>;

export class TaskRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public findById(id: string): TaskRecord | null {
    const row = this.database
      .prepare(
        "SELECT id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at FROM tasks WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? toTaskRecord(row) : null;
  }

  public findAll(): TaskRecord[] {
    return (
      this.database
        .prepare(
          "SELECT id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at FROM tasks ORDER BY created_at",
        )
        .all() as Array<Record<string, unknown>>
    ).map(toTaskRecord);
  }

  public create(input: CreateTaskInput): TaskRecord {
    this.database
      .prepare(
        "INSERT INTO tasks(id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.title,
        input.description,
        input.priority,
        input.status,
        input.progress,
        input.dueDate,
        input.ownerId,
        input.createdBy,
        input.source,
        Number(input.isPrivate),
        input.createdAt,
        input.updatedAt,
        input.completedAt,
      );
    const result = this.findById(input.id);
    if (!result) throw new Error("Task insertion failed");
    return result;
  }

  public update(id: string, input: UpdateTaskInput): TaskRecord {
    const current = this.findById(id);
    if (!current) throw new Error("Task not found");
    const next = { ...current, ...input, updatedAt: input.updatedAt ?? new Date().toISOString() };
    this.database
      .prepare(
        "UPDATE tasks SET title = ?, description = ?, priority = ?, status = ?, progress = ?, due_date = ?, owner_id = ?, created_by = ?, source = ?, is_private = ?, created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      )
      .run(
        next.title,
        next.description,
        next.priority,
        next.status,
        next.progress,
        next.dueDate,
        next.ownerId,
        next.createdBy,
        next.source,
        Number(next.isPrivate),
        next.createdAt,
        next.updatedAt,
        next.completedAt,
        id,
      );
    return next;
  }

  public delete(id: string): void {
    this.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
}

function toTaskRecord(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    priority: String(row.priority) as TaskPriority,
    status: String(row.status) as TaskStatus,
    progress: Number(row.progress),
    dueDate: row.due_date === null ? null : String(row.due_date),
    ownerId: row.owner_id === null ? null : String(row.owner_id),
    createdBy: String(row.created_by),
    source: String(row.source) as TaskSource,
    isPrivate: Number(row.is_private) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}
