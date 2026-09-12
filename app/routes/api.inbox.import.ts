import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { date, db, inboxFingerprint, now, ownerIdOf, one, priority, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { orgIsActive, requireAuth } from "../lib/session.server";
import { event, findTask, notify, validateOwner, type TaskView } from "../lib/tasks.server";

/**
 * POST /api/inbox/import —— 批量导入企微任务（指纹去重，allowDuplicates 可覆盖）。
 *
 * 组织隔离（§14.2）：
 * - 建任务必须显式写 `org_id`（迁移 009 起是 NOT NULL）：成员/组织管理者写自己的组织，
 *   管理员写请求里指定的 `orgId`（全局角色不隶属组织）——与任务域 createTask 同一口径；
 * - 指纹算法一个字没改，但重复判定只看**目标组织**内的任务，不跨组织误判；
 * - 负责人规则与任务域一致（`validateOwner(..., { orgId })`）：member 只能建给自己的，
 *   manager/admin 可以指派本组织的人，跨组织的人会被拒；
 * - 未加入组织的账号没有目标组织，直接 403（D-34）。
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const database = db();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const orgId = user.role === "admin" ? String(body.orgId ?? "").trim() : (user.orgId ?? "");
  if (!orgId) {
    return user.role === "admin"
      ? fail("VALIDATION_ERROR", "管理员导入时必须指定目标组织", 400)
      : fail("FORBIDDEN", "你还没有加入组织，无法导入任务", 403);
  }
  if (!orgIsActive(user, orgId)) return fail("VALIDATION_ERROR", "组织不存在或已解散，不能导入任务", 400);

  const drafts = Array.isArray(body.drafts) ? (body.drafts as Record<string, unknown>[]) : [];
  const created: TaskView[] = [];
  const skipped: Array<{ title: string; reason: string }> = [];
  const stamp = now();

  for (const item of drafts.slice(0, 100)) {
    const title = String(item.title ?? "").trim();
    if (!title) continue;
    const fingerprint = inboxFingerprint(item, title);
    if (one(database, "SELECT id FROM tasks WHERE wecom_fingerprint=? AND org_id=?", fingerprint, orgId) && !body.allowDuplicates) {
      skipped.push({ title, reason: "疑似重复" });
      continue;
    }
    // 普通成员只能把任务建给自己；管理员与组织管理者可以指派本组织任何人（留空 = 未分配）
    const ownerId = user.role === "member" ? user.id : ownerIdOf(item.ownerId, null);
    const owner = validateOwner(database, ownerId, { orgId });
    if (!owner.valid) {
      skipped.push({ title, reason: owner.message });
      continue;
    }
    const id = randomUUID();
    run(
      database,
      "INSERT INTO tasks(id,org_id,title,description,priority,status,progress,due_date,owner_id,created_by,source,is_private,created_at,updated_at,completed_at,archived_at,wecom_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      orgId,
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
      owner.user && owner.user.id !== user.id ? `从企微导入并分配给 ${owner.user.name}` : "从企微导入任务",
    );
    const task = findTask(database, id);
    if (task) created.push(task);
    if (owner.user && owner.user.id !== user.id) {
      notify(database, [owner.user.id], user.id, id, "task_assigned", "收到企微任务", `你收到企微任务“${title}”`);
    }
  }
  return ok({ created, skipped }, 201);
}
