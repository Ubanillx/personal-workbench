import { randomUUID } from "node:crypto";
import { date, db, now, rows, run } from "./db.server";
import { findTodo } from "./records.server";

/**
 * 待办查询与写入：页面 loader/action 与 /api/todos* 共用同一份实现。
 * 这样页面表单（form-urlencoded）与 JSON API 走的是同一份逻辑，不会出现两套行为。
 */
export function listTodos(): Record<string, unknown>[] {
  return rows(
    db(),
    "SELECT id,content,todo_date AS todoDate,is_completed AS isCompleted,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM todos ORDER BY created_at DESC",
  );
}

export function createTodoRecord(content: string, todoDate: unknown): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const stamp = now();
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO todos(id,content,todo_date,is_completed,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id,
    trimmed,
    date(todoDate),
    0,
    null,
    stamp,
    stamp,
  );
  return findTodo(id);
}

/** 返回 null 表示待办不存在（API 转 404） */
export function updateTodoRecord(id: string, body: Record<string, unknown>): Record<string, unknown> | null {
  const current = findTodo(id);
  if (!current) return null;
  const completed = body.isCompleted === undefined ? Number(current.isCompleted) : body.isCompleted ? 1 : 0;
  const stamp = now();
  run(
    db(),
    "UPDATE todos SET content=?,todo_date=?,is_completed=?,completed_at=?,updated_at=? WHERE id=?",
    String(body.content ?? current.content),
    body.todoDate === undefined ? current.todoDate : date(body.todoDate),
    completed,
    completed ? (current.completedAt ?? stamp) : null,
    stamp,
    id,
  );
  return findTodo(id);
}

export function deleteTodoRecord(id: string): void {
  run(db(), "DELETE FROM todos WHERE id=?", id);
}
