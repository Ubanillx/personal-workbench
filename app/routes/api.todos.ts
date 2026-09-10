import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { date, db, now, rows, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { findTodo } from "../lib/records.server";
import { requireOwner } from "../lib/session.server";

/** GET /api/todos —— 仅主人 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(
    rows(
      db(),
      "SELECT id,content,todo_date AS todoDate,is_completed AS isCompleted,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM todos ORDER BY created_at DESC",
    ),
  );
}

/** POST /api/todos */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const content = String(body.content ?? "").trim();
  if (!content) return fail("VALIDATION_ERROR", "待办内容不能为空", 400);
  const stamp = now();
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO todos(id,content,todo_date,is_completed,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id,
    content,
    date(body.todoDate),
    0,
    null,
    stamp,
    stamp,
  );
  return ok(findTodo(id), 201);
}
