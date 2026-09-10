import { randomUUID } from "node:crypto";
import { date, db, now, run } from "./db.server";
import { findTodo } from "./records.server";

/**
 * 待办写入逻辑：UI 的 action 与 POST /api/todos 共用。
 * 这样页面表单（form-urlencoded）与 JSON API 走的是同一份实现，不会出现两套行为。
 */
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
