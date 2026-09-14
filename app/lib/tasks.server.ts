import { randomUUID } from "node:crypto";
import type { TaskPriority, TaskStatus, UserRole } from "../../shared/types/domain";
import { now, one, rows, run, toUser, type Db, type User } from "./db.server";
import { createNotification } from "./notifications.server";
import { orgScope } from "./session.server";

/**
 * 任务读模型与可见性规则（组织隔离的收敛点）。
 *
 * 设计见 docs/harness/ACCOUNTS_AND_ORGS.md §14 与 §23（D-54）：
 * - `tasks` 有 `org_id`，所有查询都必须带组织条件，条件由 `visibilityClauses` 统一产出；
 * - 角色映射（§14.3 + D-54）：admin 看全部组织；manager 与 member 都是**本组织全部非私密任务**；
 * - 私密任务（`is_private=1`）只有三类人可见：**发布人（`created_by`）、负责人（`owner_id`）、全局管理员**，
 *   组织管理者不因管理员身份自动获得他人的私密任务；
 * - 按 id 取单条资源时先取 `org_id` 再用 `assertOrgAccess` 判定（见 app/lib/task-service.server.ts）。
 */

/**
 * 与旧 server/src/routes/workbench.ts 第 11 行一致，补 `t.org_id AS orgId` 与组织名
 * （D-28 的合并视图要能看出每行属于哪个组织；组织名走 JOIN，不在 toTaskView 里逐行查库）。
 */
export const SELECT_TASK = `SELECT t.id,t.title,t.description,t.priority,t.status,t.progress,t.due_date AS dueDate,t.owner_id AS ownerId,t.created_by AS createdBy,t.source,t.is_private AS isPrivate,t.created_at AS createdAt,t.updated_at AS updatedAt,t.completed_at AS completedAt,t.archived_at AS archivedAt,t.org_id AS orgId,o.name AS orgName,u.name AS ownerName,u.role AS ownerRole FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN organizations o ON o.id=t.org_id`;

/** 旧实现里 toTaskView 的返回类型就是 any（字段顺序与 undefined 行为都要保留），此处刻意保持 */
export type TaskView = ReturnType<typeof toTaskView>;

export function toTaskView(row: Record<string, unknown>): any {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ""),
    priority: String(row.priority) as TaskPriority,
    status: String(row.status) as TaskStatus,
    progress: Number(row.progress),
    dueDate: row.dueDate == null ? null : String(row.dueDate),
    ownerId: row.ownerId == null ? null : String(row.ownerId),
    createdBy: String(row.createdBy),
    source: String(row.source),
    isPrivate: Number(row.isPrivate) === 1,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    completedAt: row.completedAt == null ? null : String(row.completedAt),
    archivedAt: row.archivedAt == null ? null : String(row.archivedAt),
    // 组织归属：admin 的合并视图用它渲染组织标签；缺失（非 SELECT_TASK 来源的行）时为 null
    orgId: row.orgId == null ? null : String(row.orgId),
    orgName: row.orgName == null ? null : String(row.orgName),
    ownerName: row.ownerName == null ? undefined : String(row.ownerName),
    ownerRole: row.ownerRole == null ? undefined : (String(row.ownerRole) as UserRole),
  };
}

/** 任务管理权：改元信息 / 审批 / 退回 / 归档 / 恢复 / 删除（§4）。具体某个组织是否管得着由 assertOrgAccess 判定 */
export function canManageTasks(user: User): boolean {
  return user.role === "admin" || user.role === "manager";
}

/**
 * 可见性 SQL 条件（§14.3 + D-54）。调用方把 clauses 用 AND 拼进自己的 WHERE，参数按顺序拼进 params，
 * 这样"漏加组织过滤"只可能发生在这一处，而不是散落在每个查询里。
 * - admin：全部组织（私密任务也全部可见）；
 * - manager / member：**本组织全部非私密任务**（组织内协作对所有人可见），
 *   外加**自己发布或自己负责**的私密任务；
 * - 未加入组织的账号（orgId 为 NULL，D-24）：不落在任何组织范围内，一条都看不到。
 *
 * 私密任务的三个可见条件与 `canView` 逐条对应：改这里必须同步改 `canView`，
 * 否则会出现「列表里看得到、点进去 403」（或反过来）。
 */
export function visibilityClauses(user: User): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const scope = orgScope(user);
  if (scope) {
    clauses.push("t.org_id=?");
    params.push(scope);
  } else if (user.role !== "admin") {
    clauses.push("1=0");
  }
  if (user.role !== "admin") {
    clauses.push("(t.is_private=0 OR t.created_by=? OR t.owner_id=?)");
    params.push(user.id, user.id);
  }
  return { clauses, params };
}

export function visible(
  database: Db,
  user: User,
  includeArchived: boolean,
  status?: string,
  assignee?: string,
  orgFilter?: string | null,
): TaskView[] {
  const { clauses, params } = visibilityClauses(user);
  if (!includeArchived) clauses.push("t.archived_at IS NULL");
  if (status && status !== "all") {
    clauses.push("t.status=?");
    params.push(status);
  }
  if (assignee === "mine") {
    clauses.push("t.owner_id=?");
    params.push(user.id);
  } else if (assignee === "unassigned") {
    clauses.push("t.owner_id IS NULL");
  } else if (assignee && assignee !== "all") {
    clauses.push("t.owner_id=?");
    params.push(assignee);
  }
  // 管理员的组织筛选器（D-28）：合并视图下只看某个组织
  if (orgFilter) {
    clauses.push("t.org_id=?");
    params.push(orgFilter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return rows(database, `${SELECT_TASK} ${where} ORDER BY t.updated_at DESC`, ...params).map(toTaskView);
}

export function findTask(database: Db, id: string): TaskView | null {
  const row = one(database, `${SELECT_TASK} WHERE t.id=?`, id);
  return row ? toTaskView(row) : null;
}

/** 取任务及其所属组织：跨组织判定必须先拿到 `org_id`（§14.2） */
export function findTaskWithOrg(database: Db, id: string): { task: TaskView; orgId: string } | null {
  const row = one(database, `${SELECT_TASK} WHERE t.id=?`, id);
  if (!row) return null;
  return { task: toTaskView(row), orgId: String(row.orgId) };
}

/**
 * 单条任务对某人是否可见（组织边界由调用方先用 assertOrgAccess 判定，§14.2）。
 *
 * D-54 起私密任务只有三类人可见，**组织管理者身份不再自动带来看他人的私密任务的权限**：
 * 发布人（`createdBy`）、负责人（`ownerId`）、全局管理员。非私密任务是组织内公开的，
 * 组织边界已经由调用方判过，到这里就放行。
 */
export function canView(t: TaskView, user: User): boolean {
  if (user.role === "admin") return true;
  if (t.isPrivate) return t.createdBy === user.id || t.ownerId === user.id;
  return true;
}

/**
 * 校验负责人：账号必须启用；除全局管理员（不隶属组织，§3.2）外必须是**任务所属组织**的成员——
 * 否则负责人看不到自己的任务。member/manager/admin 都可以成为负责人（§14.3 指派规则）。
 * `options.orgId` 省略时不校验组织（企微导入等暂未接组织上下文的调用点沿用旧行为）。
 */
export function validateOwner(
  database: Db,
  id: string | null,
  options: { orgId?: string | null } = {},
): { valid: true; user?: User } | { valid: false; message: string } {
  if (id === null) return { valid: true };
  const row = one(
    database,
    "SELECT id,username,email,name,role,org_id AS orgId,is_active AS isActive,must_change_password AS mustChangePassword FROM users WHERE id=?",
    id,
  );
  if (!row) return { valid: false, message: "负责人不存在" };
  const user = toUser(row);
  if (!user.isActive) return { valid: false, message: "负责人已停用" };
  if (options.orgId && user.role !== "admin" && user.orgId !== options.orgId) {
    return { valid: false, message: "负责人必须属于该任务所在组织" };
  }
  return { valid: true, user };
}

export function notify(
  database: Db,
  recipients: string[],
  actor: string,
  taskId: string | null,
  type: string,
  title: string,
  message: string,
): void {
  for (const recipient of [...new Set(recipients)].filter((x) => x !== actor))
    createNotification(database, { recipientId: recipient, actorId: actor, taskId, eventType: type, title, message });
}

/** 任务所属组织的可用组织管理者（任务事件的通知对象，替代旧实现的全局「主人」） */
export function orgManagerIds(database: Db, taskId: string): string[] {
  const task = one<{ orgId: string | null }>(database, "SELECT org_id AS orgId FROM tasks WHERE id=?", taskId);
  if (!task?.orgId) return [];
  return rows<{ id: string }>(database, "SELECT id FROM users WHERE org_id=? AND role='manager' AND is_active=1", task.orgId).map(
    (row) => row.id,
  );
}

/**
 * 通知任务参与者：负责人 + 本组织的组织管理者（验收方）。
 * 私密任务只通知**可见的参与方**——负责人与发布人；其他组织管理者看不到这条任务，
 * 把标题发过去就是泄露（D-54 起负责人与发布人可以是两个人，因此这里要带上双方）。
 */
export function notifyParticipants(database: Db, t: TaskView | null, actor: string, type: string, title: string, message: string): void {
  if (!t) return;
  const recipients = t.isPrivate ? [t.ownerId, t.createdBy] : [t.ownerId, ...orgManagerIds(database, t.id)];
  notify(
    database,
    recipients.filter((x): x is string => Boolean(x)),
    actor,
    t.id,
    type,
    title,
    message,
  );
}

export function log(database: Db, taskId: string, user: User, content: string, progress: number | null): void {
  run(
    database,
    "INSERT INTO task_progress_logs(id,task_id,author_id,author_name,content,progress_snapshot,created_at) VALUES(?,?,?,?,?,?,?)",
    randomUUID(),
    taskId,
    user.id,
    user.name,
    content || "进度更新",
    progress,
    now(),
  );
}

export function event(
  database: Db,
  taskId: string,
  user: User,
  type:
    | "task_created"
    | "task_reassigned"
    | "task_submitted"
    | "task_approved"
    | "task_returned"
    | "task_archived"
    | "task_restored"
    // 换所属组织（迁移 013 放开的取值）：时间线要能看出任务换过组织
    | "task_moved",
  content: string,
): void {
  run(
    database,
    "INSERT INTO task_events(id,task_id,actor_id,actor_name,event_type,content,created_at) VALUES(?,?,?,?,?,?,?)",
    randomUUID(),
    taskId,
    user.id,
    user.name,
    type,
    content,
    now(),
  );
}

/** 逾期扫描：跨组织一次性完成（通知对象由任务自身决定，与触发者是谁无关） */
export function notifyOverdueTasks(database: Db): void {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = rows(
    database,
    `${SELECT_TASK} WHERE t.archived_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < ? AND t.status <> 'completed' AND t.overdue_notified_at IS NULL`,
    today,
  ).map(toTaskView) as TaskView[];
  for (const item of overdue) {
    // 与 notifyParticipants 同一收件人口径：私密任务只发负责人与发布人（其他人看不到它）
    const recipients = item.isPrivate ? [item.ownerId, item.createdBy] : [item.ownerId, ...orgManagerIds(database, item.id)];
    for (const recipient of new Set(recipients.filter((value): value is string => Boolean(value))))
      createNotification(database, {
        recipientId: recipient,
        taskId: item.id,
        eventType: "task_overdue",
        title: "任务已逾期",
        message: `任务“${item.title}”已超过截止日期`,
      });
    run(database, "UPDATE tasks SET overdue_notified_at=? WHERE id=?", now(), item.id);
  }
}
