import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { db, now, rows, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { canView, findTask, notifyParticipants } from "../lib/tasks.server";

type Params = { request: Request; params: { id?: string } };

/** GET /api/tasks/:id/comments —— 需要可见权限 */
export async function loader({ request, params }: Params): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const task = findTask(database, String(params.id));
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (!canView(task, user)) return fail("FORBIDDEN", "无权查看该任务", 403);
  return ok(
    rows(
      database,
      "SELECT id,task_id AS taskId,author_id AS authorId,author_name AS authorName,author_role AS authorRole,content,created_at AS createdAt FROM task_comments WHERE task_id=? ORDER BY created_at",
      task.id,
    ),
  );
}

/** POST /api/tasks/:id/comments —— 需要可见权限；content 为空则 400 */
export async function action({ request, params }: Params): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const task = findTask(database, String(params.id));
  if (!task) return fail("NOT_FOUND", "任务不存在", 404);
  if (!canView(task, user)) return fail("FORBIDDEN", "无权评论该任务", 403);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const content = String(body.content ?? body.text ?? "").trim();
  if (!content) return fail("VALIDATION_ERROR", "评论内容不能为空", 400);
  const stamp = now();
  const comment = {
    id: randomUUID(),
    taskId: task.id,
    authorId: user.id,
    authorName: user.name,
    authorRole: user.role,
    content,
    createdAt: stamp,
  };
  run(
    database,
    "INSERT INTO task_comments(id,task_id,author_id,author_name,author_role,content,created_at) VALUES(?,?,?,?,?,?,?)",
    comment.id,
    task.id,
    user.id,
    user.name,
    user.role,
    content,
    stamp,
  );
  notifyParticipants(database, task, user.id, "task_commented", "任务有新评论", `${user.name} 评论了任务“${task.title}”`);
  return ok(comment, 201);
}
