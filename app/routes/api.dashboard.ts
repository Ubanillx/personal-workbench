import { appConfig } from "../lib/context.server";
import { db, rows } from "../lib/db.server";
import { ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { notifyOverdueTasks, visible } from "../lib/tasks.server";

/** GET /api/dashboard —— 概览：本人可见任务 + 主人可见的待办/随手记 + 统计 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  notifyOverdueTasks(database);
  const tasks = visible(database, user, false);
  const todos =
    user.role === "owner"
      ? rows(
          database,
          "SELECT id,content,todo_date AS todoDate,is_completed AS isCompleted,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM todos ORDER BY created_at DESC",
        )
      : [];
  const notes =
    user.role === "owner"
      ? rows(
          database,
          "SELECT id,content,is_pinned AS isPinned,created_at AS createdAt,updated_at AS updatedAt FROM notes ORDER BY updated_at DESC",
        )
      : [];
  return ok({
    user,
    tasks,
    todos,
    notes,
    stats: {
      tasks: tasks.length,
      activeTasks: tasks.filter((t: any) => t.status !== "completed").length,
      pendingTodos: todos.filter((t: any) => Number(t.isCompleted) === 0).length,
      notes: notes.length,
    },
  });
}
