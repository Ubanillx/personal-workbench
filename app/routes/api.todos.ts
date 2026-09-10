import { appConfig } from "../lib/context.server";
import { db, rows } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { createTodoRecord } from "../lib/todos.server";

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

/** POST /api/todos —— 逻辑在 app/lib/todos.server.ts，与页面表单 action 共用 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = createTodoRecord(String(body.content ?? ""), body.todoDate);
  if (!created) return fail("VALIDATION_ERROR", "待办内容不能为空", 400);
  return ok(created, 201);
}
