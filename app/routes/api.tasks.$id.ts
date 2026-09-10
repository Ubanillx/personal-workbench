import { appConfig } from "../lib/context.server";
import { date, db, now, ownerIdOf, priority, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { event, findTask, notify, validateOwner } from "../lib/tasks.server";

type Params = { request: Request; params: { id?: string } };

/** PATCH /api/tasks/:id 与 DELETE /api/tasks/:id —— 都仅主人可用 */
export async function action({ request, params }: Params): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const id = String(params.id);
  const current = findTask(database, id);
  if (!current) return fail("NOT_FOUND", "任务不存在", 404);
  if (request.method === "DELETE") {
    if (!current.archivedAt) return fail("ARCHIVE_REQUIRED", "请先归档任务，再彻底删除", 400);
    run(database, "DELETE FROM tasks WHERE id=?", id);
    return ok(null);
  }

  if (current.archivedAt) return fail("ARCHIVED", "请先恢复归档任务", 400);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.progress !== undefined || body.status !== undefined) return fail("FIELD_FORBIDDEN", "请使用进度和验收接口变更任务状态", 400);
  const title = String(body.title ?? current.title).trim();
  if (!title) return fail("VALIDATION_ERROR", "任务标题不能为空", 400);
  const ownerId = Object.prototype.hasOwnProperty.call(body, "ownerId") ? ownerIdOf(body.ownerId, null) : current.ownerId;
  const owner = validateOwner(database, ownerId);
  if (!owner.valid) return fail("VALIDATION_ERROR", owner.message, 400);
  const isPrivate = body.isPrivate === undefined ? Number(current.isPrivate) : body.isPrivate ? 1 : 0;
  if (isPrivate && ownerId !== "owner") return fail("VALIDATION_ERROR", "私密任务只能由主人负责", 400);
  const stamp = now();
  run(
    database,
    "UPDATE tasks SET title=?,description=?,priority=?,due_date=?,owner_id=?,is_private=?,updated_at=? WHERE id=?",
    title.slice(0, 240),
    String(body.description ?? current.description),
    priority(body.priority ?? current.priority),
    body.dueDate === undefined ? current.dueDate : date(body.dueDate),
    ownerId,
    isPrivate,
    stamp,
    id,
  );
  if (ownerId !== current.ownerId) {
    event(database, id, user, "task_reassigned", `负责人从 ${current.ownerName ?? "未分配"} 改为 ${owner.user?.name ?? "未分配"}`);
    notify(
      database,
      [current.ownerId, ownerId].filter((x): x is string => Boolean(x)),
      user.id,
      id,
      "task_reassigned",
      "任务负责人已变更",
      `任务“${current.title}”已重新分配`,
    );
  }
  return ok(findTask(database, id));
}
