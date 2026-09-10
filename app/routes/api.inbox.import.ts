import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { date, db, inboxFingerprint, now, ownerIdOf, one, priority, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { event, findTask, notify, validateOwner, type TaskView } from "../lib/tasks.server";

/** POST /api/inbox/import —— 批量导入企微任务（指纹去重，allowDuplicates 可覆盖） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (user.role === "viewer") return fail("FORBIDDEN", "查看者不能导入任务", 403);
  const database = db();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const drafts = Array.isArray(body.drafts) ? (body.drafts as Record<string, unknown>[]) : [];
  const created: TaskView[] = [];
  const skipped: Array<{ title: string; reason: string }> = [];
  const stamp = now();

  for (const item of drafts.slice(0, 100)) {
    const title = String(item.title ?? "").trim();
    if (!title) continue;
    const fingerprint = inboxFingerprint(item, title);
    if (one(database, "SELECT id FROM tasks WHERE wecom_fingerprint=?", fingerprint) && !body.allowDuplicates) {
      skipped.push({ title, reason: "疑似重复" });
      continue;
    }
    const ownerId = user.role === "assistant" ? user.id : ownerIdOf(item.ownerId, null);
    const owner = validateOwner(database, ownerId);
    if (!owner.valid) {
      skipped.push({ title, reason: owner.message });
      continue;
    }
    const id = randomUUID();
    run(
      database,
      "INSERT INTO tasks(id,title,description,priority,status,progress,due_date,owner_id,created_by,source,is_private,created_at,updated_at,completed_at,archived_at,wecom_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      title.slice(0, 240),
      String(item.description ?? (item.sender ? `来自：${String(item.sender)}` : "")),
      priority(item.priority),
      "todo",
      0,
      date(item.dueDate),
      ownerId,
      user.id,
      "wecom",
      0,
      stamp,
      stamp,
      null,
      null,
      fingerprint,
    );
    event(
      database,
      id,
      user,
      "task_created",
      owner.user && owner.user.id !== user.id ? `从企微导入并分配给 ${owner.user.name}` : "从企微收件箱导入",
    );
    const task = findTask(database, id);
    if (task) created.push(task);
    if (owner.user?.role === "assistant" && owner.user.id !== user.id) {
      notify(database, [owner.user.id], user.id, id, "task_assigned", "收到企微任务", `你收到企微任务“${title}”`);
    }
  }
  return ok({ created, skipped }, 201);
}
