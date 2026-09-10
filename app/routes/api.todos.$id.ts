import { appConfig } from "../lib/context.server";
import { date, db, now, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { findTodo } from "../lib/records.server";
import { requireOwner } from "../lib/session.server";

/**
 * PATCH /api/todos/:id —— 更新
 * DELETE /api/todos/:id —— 删除（不存在也返回 200，与旧实现一致）
 * RR8 的 action 负责该路径的所有非 GET 方法，因此在这里按方法分派。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;

  if (request.method === "DELETE") {
    run(db(), "DELETE FROM todos WHERE id=?", id);
    return ok(null);
  }

  const current = findTodo(id);
  if (!current) return fail("NOT_FOUND", "待办不存在", 404);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const done = body.isCompleted === undefined ? Number(current.isCompleted) : body.isCompleted ? 1 : 0;
  const stamp = now();
  run(
    db(),
    "UPDATE todos SET content=?,todo_date=?,is_completed=?,completed_at=?,updated_at=? WHERE id=?",
    String(body.content ?? current.content),
    body.todoDate === undefined ? current.todoDate : date(body.todoDate),
    done,
    done ? (current.completedAt ?? stamp) : null,
    stamp,
    id,
  );
  return ok(findTodo(id));
}
