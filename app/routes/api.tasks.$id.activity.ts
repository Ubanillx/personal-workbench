import { appConfig } from "../lib/context.server";
import { db, rows } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { canView, findTask } from "../lib/tasks.server";

/** GET /api/tasks/:id/activity —— 进度日志 + 评论 + 事件，按 createdAt 升序合并 */
export async function loader({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const task = findTask(database, String(params.id));
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (!canView(task, user)) return fail("FORBIDDEN", "无权查看该任务", 403);
  const logs = rows(
    database,
    "SELECT id,'progress' AS kind,author_id AS authorId,author_name AS authorName,content,progress_snapshot AS progress,created_at AS createdAt FROM task_progress_logs WHERE task_id=?",
    task.id,
  );
  const comments = rows(
    database,
    "SELECT id,'comment' AS kind,author_id AS authorId,author_name AS authorName,content,NULL AS progress,created_at AS createdAt FROM task_comments WHERE task_id=?",
    task.id,
  );
  const events = rows(
    database,
    "SELECT id,event_type AS kind,actor_id AS authorId,actor_name AS authorName,content,NULL AS progress,created_at AS createdAt FROM task_events WHERE task_id=?",
    task.id,
  );
  return ok([...logs, ...comments, ...events].toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
}
