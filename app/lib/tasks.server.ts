import { randomUUID } from "node:crypto";
import type { TaskPriority, TaskStatus, UserRole } from "../../shared/types/domain";
import { now, one, rows, run, toUser, type Db, type User } from "./db.server";

/** 与旧 server/src/routes/workbench.ts 第 11 行逐字符一致 */
export const SELECT_TASK = `SELECT t.id,t.title,t.description,t.priority,t.status,t.progress,t.due_date AS dueDate,t.owner_id AS ownerId,t.created_by AS createdBy,t.source,t.is_private AS isPrivate,t.created_at AS createdAt,t.updated_at AS updatedAt,t.completed_at AS completedAt,t.archived_at AS archivedAt,u.name AS ownerName,u.role AS ownerRole FROM tasks t LEFT JOIN users u ON u.id=t.owner_id`;

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
    ownerName: row.ownerName == null ? undefined : String(row.ownerName),
    ownerRole: row.ownerRole == null ? undefined : (String(row.ownerRole) as UserRole),
  };
}

export function visible(database: Db, user: User, includeArchived: boolean, status?: string, assignee?: string): TaskView[] {
  const all = rows(database, `${SELECT_TASK}${includeArchived ? "" : " WHERE t.archived_at IS NULL"} ORDER BY t.updated_at DESC`).map(
    toTaskView,
  );
  return all.filter((t) => {
    if (!(
      user.role === "owner" ||
      (user.role === "assistant" && t.ownerId === user.id) ||
      (user.role === "viewer" && t.ownerRole === "assistant")
    ))
      return false;
    if (status && status !== "all" && t.status !== status) return false;
    if (assignee === "mine" && t.ownerId !== user.id) return false;
    if (assignee === "unassigned" && t.ownerId !== null) return false;
    if (
      assignee &&
      assignee !== "mine" &&
      assignee !== "unassigned" &&
      assignee !== "all" &&
      user.role === "owner" &&
      t.ownerId !== assignee
    )
      return false;
    return true;
  });
}

export function findTask(database: Db, id: string): TaskView | null {
  const row = one(database, `${SELECT_TASK} WHERE t.id=?`, id);
  return row ? toTaskView(row) : null;
}

export function canView(t: TaskView, user: User): boolean {
  return (
    user.role === "owner" || (user.role === "assistant" && t.ownerId === user.id) || (user.role === "viewer" && t.ownerRole === "assistant")
  );
}

export function validateOwner(database: Db, id: string | null): { valid: true; user?: User } | { valid: false; message: string } {
  if (id === null) return { valid: true };
  const row = one(database, "SELECT id,name,role,is_active AS isActive FROM users WHERE id=?", id);
  if (!row) return { valid: false, message: "负责人不存在" };
  const user = toUser(row);
  if (!user.isActive) return { valid: false, message: "负责人已停用" };
  if (user.role !== "owner" && user.role !== "assistant") return { valid: false, message: "任务只能分配给主人或助理" };
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
    run(
      database,
      "INSERT INTO notifications(id,recipient_id,actor_id,task_id,event_type,title,message,is_read,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)",
      randomUUID(),
      recipient,
      actor,
      taskId,
      type,
      title,
      message,
      0,
      now(),
    );
}

export function notifyParticipants(database: Db, t: TaskView | null, actor: string, type: string, title: string, message: string): void {
  if (!t) return;
  notify(
    database,
    [t.ownerId, "owner"].filter((x): x is string => Boolean(x)),
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
  type: "task_created" | "task_reassigned" | "task_submitted" | "task_approved" | "task_returned" | "task_archived" | "task_restored",
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

export function notifyOverdueTasks(database: Db): void {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = rows(
    database,
    `${SELECT_TASK} WHERE t.archived_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < ? AND t.status <> 'completed' AND t.overdue_notified_at IS NULL`,
    today,
  ).map(toTaskView) as TaskView[];
  for (const item of overdue) {
    const recipients = [item.ownerId, "owner"].filter((value): value is string => Boolean(value));
    for (const recipient of new Set(recipients))
      run(
        database,
        "INSERT INTO notifications(id,recipient_id,actor_id,task_id,event_type,title,message,is_read,created_at,read_at) VALUES(?,?,NULL,?,?,?, ?,0,?,NULL)",
        randomUUID(),
        recipient,
        item.id,
        "task_overdue",
        "任务已逾期",
        `任务“${item.title}”已超过截止日期`,
        now(),
      );
    run(database, "UPDATE tasks SET overdue_notified_at=? WHERE id=?", now(), item.id);
  }
}
