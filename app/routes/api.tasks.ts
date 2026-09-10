import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { date, db, now, ownerIdOf, priority, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { event, findTask, notify, notifyOverdueTasks, validateOwner, visible } from "../lib/tasks.server";

/** GET /api/tasks —— 按角色可见性过滤；只有主人能用 includeArchived=1 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  notifyOverdueTasks(database);
  const query = new URL(request.url).searchParams;
  const includeArchived = query.get("includeArchived");
  const status = query.get("status");
  const assignee = query.get("assignee");
  return ok(visible(database, user, user.role === "owner" && includeArchived === "1", status ?? undefined, assignee ?? undefined));
}

/** POST /api/tasks —— 查看者 403；助理创建的负责人强制为自己 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (user.role === "viewer") return fail("FORBIDDEN", "查看者不能创建任务", 403);
  const database = db();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const title = String(body.title ?? "").trim();
  if (!title) return fail("VALIDATION_ERROR", "任务标题不能为空", 400);
  const ownerId = user.role === "assistant" ? user.id : ownerIdOf(body.ownerId, user.id);
  const owner = validateOwner(database, ownerId);
  if (!owner.valid) return fail("VALIDATION_ERROR", owner.message, 400);
  const id = randomUUID();
  const stamp = now();
  run(
    database,
    "INSERT INTO tasks(id,title,description,priority,status,progress,due_date,owner_id,created_by,source,is_private,created_at,updated_at,completed_at,archived_at,wecom_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    title.slice(0, 240),
    String(body.description ?? ""),
    priority(body.priority),
    "todo",
    0,
    date(body.dueDate),
    ownerId,
    user.id,
    user.role === "assistant" ? "assistant" : "manual",
    user.role === "owner" && body.isPrivate ? 1 : 0,
    stamp,
    stamp,
    null,
    null,
    null,
  );
  event(database, id, user, "task_created", owner.user && owner.user.id !== user.id ? `创建并分配给 ${owner.user.name}` : "创建任务");
  if (owner.user?.role === "assistant" && owner.user.id !== user.id)
    notify(database, [owner.user.id], user.id, id, "task_assigned", "收到新任务", `你收到来自 ${user.name} 的任务“${title}”`);
  return ok(findTask(database, id), 201);
}
