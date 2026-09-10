import type { DatabaseSync } from "node:sqlite";
import type { LegacyTodo } from "../../types/database";

export type TodoRecord = {
  id: string;
  content: string;
  todoDate: string | null;
  isCompleted: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CreateTodoInput = Omit<TodoRecord, "id"> & { id: string };
export type UpdateTodoInput = Partial<Pick<TodoRecord, "content" | "todoDate" | "isCompleted" | "completedAt" | "updatedAt">>;

export class TodoRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public findAll(): TodoRecord[] {
    return (
      this.database
        .prepare("SELECT id, content, todo_date, is_completed, completed_at, created_at, updated_at FROM todos ORDER BY created_at")
        .all() as Array<Record<string, unknown>>
    ).map(toTodoRecord);
  }

  public create(input: CreateTodoInput): TodoRecord {
    this.database
      .prepare("INSERT INTO todos(id, content, todo_date, is_completed, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.content, input.todoDate, Number(input.isCompleted), input.completedAt, input.createdAt, input.updatedAt);
    const result = this.findById(input.id);
    if (!result) throw new Error("Todo insertion failed");
    return result;
  }

  public update(id: string, input: UpdateTodoInput): TodoRecord {
    const current = this.findById(id);
    if (!current) throw new Error("Todo not found");
    const next: TodoRecord = { ...current, ...input, updatedAt: input.updatedAt ?? new Date().toISOString() };
    this.database
      .prepare("UPDATE todos SET content = ?, todo_date = ?, is_completed = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .run(next.content, next.todoDate, Number(next.isCompleted), next.completedAt, next.updatedAt, id);
    return next;
  }

  private findById(id: string): TodoRecord | null {
    const row = this.database
      .prepare("SELECT id, content, todo_date, is_completed, completed_at, created_at, updated_at FROM todos WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toTodoRecord(row) : null;
  }
}

function toTodoRecord(row: Record<string, unknown>): TodoRecord {
  return {
    id: String(row.id),
    content: String(row.content),
    todoDate: row.todo_date === null ? null : String(row.todo_date),
    isCompleted: Number(row.is_completed) === 1,
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function legacyTodoToInput(item: LegacyTodo, createdAt: string, completedAt: string | null): CreateTodoInput {
  return {
    id: item.id,
    content: item.text,
    todoDate: item.date ?? null,
    isCompleted: item.done,
    completedAt,
    createdAt,
    updatedAt: completedAt ?? createdAt,
  };
}
