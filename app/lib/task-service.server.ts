import { randomUUID } from "node:crypto";
import type { TaskStatus } from "../../shared/types/domain";
import { clamp, date, db, flag, now, one, ownerIdOf, priority, rows, run, type User } from "./db.server";
import { assertOrgAccess, orgIsActive } from "./session.server";
import { canReviewTask } from "./task-permissions";
import {
  canManageTasks,
  canView,
  event,
  findTask,
  findTaskWithOrg,
  log,
  notify,
  notifyParticipants,
  toTaskView,
  validateOwner,
  type TaskView,
} from "./tasks.server";

/**
 * 任务域服务：**API 资源路由与页面 action/loader 共用这一份实现**。
 *
 * 组织隔离（docs/harness/ACCOUNTS_AND_ORGS.md §14）在这里收敛：
 * - 读改单条任务先取出它的 `org_id`，用 `assertOrgAccess` 判定，跨组织一律 404（不返回 403，避免泄露资源是否存在）；
 * - 建任务显式写 `org_id`（迁移 009 是 NOT NULL）：普通用户/组织管理者写自己的组织，管理员写请求里指定的组织；
 * - `task_comments` / `task_progress_logs` / `task_events` 没有 `org_id`，一律经 `task_id` 关联校验后才读写。
 */
export type ServiceResult<T> = { ok: true; data: T; status: number } | { ok: false; code: string; message: string; status: number };

const done = <T>(data: T, status = 200): ServiceResult<T> => ({ ok: true, data, status });
const failed = (code: string, message: string, status: number): ServiceResult<never> => ({ ok: false, code, message, status });

/** 与 session.notFound() 同一信封：跨组织与「不存在」必须给出完全一样的响应 */
const notFoundResult = (): ServiceResult<never> => failed("NOT_FOUND", "未找到该资源", 404);

/**
 * 定位结果。刻意做成**判别联合**，且判别键是显式的 `ok` 而**不是** `task` 是否为空：
 * `TaskView` 的定义是 `ReturnType<typeof toTaskView>`（= `any`，"字段顺序与 undefined 行为都要保留"），
 * 于是 `if (!located.task)` 里那个 `any` 会让 TypeScript 收不窄 `failure`。
 * 用 `ok` 当判别键，`if (!located.ok) return located.failure;` 之后两件事同时成立：
 * `failure` 必定非空、`task` 与 `orgId` 必定有值，调用点不必写非空断言。
 */
type Located =
  { ok: true; task: TaskView; orgId: string; failure: null } | { ok: false; task: null; orgId: null; failure: ServiceResult<never> };

/** 存在性 + 组织边界：不存在或跨组织都返回 404 结果，调用方一律回 404（§14.2） */
function locate(user: User, id: string): Located {
  const found = findTaskWithOrg(db(), id);
  if (!found) return { ok: false, task: null, orgId: null, failure: notFoundResult() };
  if (assertOrgAccess(user, found.orgId)) return { ok: false, task: null, orgId: null, failure: notFoundResult() };
  return { ok: true, task: found.task, orgId: found.orgId, failure: null };
}

/**
 * 在「存在 + 组织边界」之上加**可见性**，供写操作与间接表（评论 / 时间线）使用。
 *
 * ⚠️ 写操作不能只判 `canManageTasks`：组织管理者对**别人的私密任务**没有可见权（D-54），
 * 若只判角色，他能直接 `PATCH /api/tasks/:id` 改一条自己看不见的任务——「列表看不见、接口改得动」
 * 是权限模型里最危险的一种裂缝。这里的语义因此与 `canView` 完全一致：
 * 本组织但看不见（私密任务的非发布人、非负责人、非管理员）→ 403，与读接口同一道门。
 *
 * `message` 默认「无权查看该任务」；「评论」这类动词有自己的说法，由调用方传入，
 * 免得同一条规则在两处各写一遍判断、只差一句文案。
 */
function viewable(user: User, id: string, message = "无权查看该任务"): Located {
  const located = locate(user, id);
  if (!located.ok) return located;
  if (!canView(located.task, user)) return { ok: false, task: null, orgId: null, failure: failed("FORBIDDEN", message, 403) };
  return located;
}

export function createTask(user: User, body: Record<string, unknown>): ServiceResult<TaskView> {
  const database = db();
  const title = String(body.title ?? "").trim();
  if (!title) return failed("VALIDATION_ERROR", "任务标题不能为空", 400);
  // 任务归属组织：管理员是全局角色（orgId 为 NULL），必须由请求指定目标组织；其他人写自己的组织
  const orgId = user.role === "admin" ? String(body.orgId ?? "").trim() : (user.orgId ?? "");
  if (!orgId) {
    return user.role === "admin"
      ? failed("VALIDATION_ERROR", "管理员创建任务时必须指定组织", 400)
      : failed("FORBIDDEN", "你还没有加入组织，无法创建任务", 403);
  }
  if (!orgIsActive(user, orgId)) return failed("VALIDATION_ERROR", "组织不存在或已解散，不能创建任务", 400);
  // 普通成员只能建给自己的任务；管理员与组织管理者可以指派给本组织任何人（§14.3）
  const ownerId = user.role === "member" ? user.id : ownerIdOf(body.ownerId, user.id);
  const owner = validateOwner(database, ownerId, { orgId });
  if (!owner.valid) return failed("VALIDATION_ERROR", owner.message, 400);
  /**
   * 私密任务（D-54）：只有全局管理员与组织管理者能建（member 传 `isPrivate` 会降级为普通任务），
   * 负责人可以是**发布人本人或本组织的其他人**——「发布人」与「负责人」是两个独立的可见方，
   * D-36 那条「负责人必须是创建者本人」的限制随之取消（否则「负责人可见」永远等于「发布人可见」）。
   */
  const isPrivate = canManageTasks(user) && flag(body.isPrivate) ? 1 : 0;
  const id = randomUUID();
  const stamp = now();
  run(
    database,
    "INSERT INTO tasks(id,org_id,title,description,priority,status,progress,due_date,owner_id,created_by,source,is_private,created_at,updated_at,completed_at,archived_at,wecom_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    orgId,
    title.slice(0, 240),
    String(body.description ?? ""),
    priority(body.priority),
    "todo",
    0,
    date(body.dueDate),
    ownerId,
    user.id,
    "manual",
    isPrivate,
    stamp,
    stamp,
    null,
    null,
    null,
  );
  event(database, id, user, "task_created", owner.user && owner.user.id !== user.id ? `创建并分配给 ${owner.user.name}` : "创建任务");
  if (owner.user && owner.user.id !== user.id) {
    notify(database, [owner.user.id], user.id, id, "task_assigned", "收到新任务", `你收到来自 ${user.name} 的任务“${title}”`);
  }
  return done(findTask(database, id) as TaskView, 201);
}

export function updateTask(user: User, id: string, body: Record<string, unknown>): ServiceResult<TaskView> {
  if (!canManageTasks(user)) return failed("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403);
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  const current = located.task;
  if (current.archivedAt) return failed("ARCHIVED", "请先恢复归档任务", 400);
  if (body.progress !== undefined || body.status !== undefined) return failed("FIELD_FORBIDDEN", "请使用进度和验收接口变更任务状态", 400);
  const title = String(body.title ?? current.title).trim();
  if (!title) return failed("VALIDATION_ERROR", "任务标题不能为空", 400);
  /**
   * 所属组织：请求里带 `orgId` 且与当前不同 = 换组织（§14.3、D-47）。
   * - 只有**全局管理员**能换：组织管理者只在本组织内有管理权，不能把任务搬到别的组织；
   * - 目标组织必须启用（已解散的组织不能再接收任务）；
   * - 负责人跟着按**目标组织**校验——换组织后负责人必须属于新组织，否则负责人看不到自己的任务。
   */
  const orgId = body.orgId === undefined ? located.orgId : String(body.orgId ?? "").trim();
  const movingOrg = orgId !== located.orgId;
  if (movingOrg) {
    if (user.role !== "admin") return failed("FORBIDDEN", "只有管理员可以修改任务所属组织", 403);
    if (!orgId) return failed("VALIDATION_ERROR", "任务必须属于某个组织", 400);
    if (!orgIsActive(user, orgId)) return failed("VALIDATION_ERROR", "组织不存在或已解散，不能改到该组织", 400);
  }
  const ownerId = Object.prototype.hasOwnProperty.call(body, "ownerId") ? ownerIdOf(body.ownerId, null) : current.ownerId;
  const owner = validateOwner(database, ownerId, { orgId });
  if (!owner.valid) return failed("VALIDATION_ERROR", owner.message, 400);
  /**
   * 私密开关与负责人是**同一条可见性规则的两个输入**（D-54）：谁能看到这条任务，由「发布人 + 负责人
   * + 全局管理员」决定。因此本组织管理者虽然能管理全部任务，却只能改**自己发布**的私密任务的这两项
   * ——否则他可以把别人的私密任务改成公开（泄露），或把负责人换成自己（凭空获得可见权）。
   * 其余字段（标题 / 说明 / 优先级 / 截止日期）不受此限：能看见就能管。
   */
  const touchesPrivacy = body.isPrivate !== undefined || ownerId !== current.ownerId;
  if (touchesPrivacy && current.isPrivate && user.role !== "admin" && current.createdBy !== user.id) {
    return failed("FORBIDDEN", "只有发布人或管理员可以修改私密任务的私密状态与负责人", 403);
  }
  const isPrivate = body.isPrivate === undefined ? Number(current.isPrivate) : flag(body.isPrivate) ? 1 : 0;
  const stamp = now();
  run(
    database,
    "UPDATE tasks SET title=?,description=?,priority=?,due_date=?,owner_id=?,is_private=?,org_id=?,updated_at=? WHERE id=?",
    title.slice(0, 240),
    String(body.description ?? current.description),
    priority(body.priority ?? current.priority),
    body.dueDate === undefined ? current.dueDate : date(body.dueDate),
    ownerId,
    isPrivate,
    orgId,
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
  if (movingOrg) {
    const targetName = one<{ name: string }>(database, "SELECT name FROM organizations WHERE id=?", orgId)?.name ?? "新组织";
    event(database, id, user, "task_moved", `所属组织从 ${current.orgName ?? "—"} 改为 ${targetName}`);
    // notifications.event_type 的 CHECK 里没有 task_moved（009），这里复用 task_reassigned 作为路由键，
    // 用户看到的是下面的标题与正文：负责人 + **新组织**的组织管理者（orgManagerIds 读的是更新后的 org_id）
    notifyParticipants(
      database,
      findTask(database, id) as TaskView,
      user.id,
      "task_reassigned",
      "任务已调整到本组织",
      `任务“${current.title}”已从「${current.orgName ?? "—"}」调整到「${targetName}」`,
    );
  }
  return done(findTask(database, id) as TaskView);
}

export function deleteTask(user: User, id: string): ServiceResult<null> {
  if (!canManageTasks(user)) return failed("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403);
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  if (!located.task.archivedAt) return failed("ARCHIVE_REQUIRED", "请先归档任务，再彻底删除", 400);
  run(database, "DELETE FROM tasks WHERE id=?", id);
  return done(null);
}

export function reportProgress(user: User, id: string, body: Record<string, unknown>): ServiceResult<TaskView> {
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  const current = located.task;
  if (current.archivedAt) return failed("ARCHIVED", "请先恢复归档任务", 400);
  if (current.ownerId !== user.id) return failed("FORBIDDEN", "只能更新自己负责的任务", 403);
  if (current.status === "pending_review") return failed("INVALID_STATE", "任务已提交验收，请等待任务发布人处理", 400);
  if (current.status === "completed") return failed("INVALID_STATE", "已完成任务不能再更新进度", 400);
  const p = clamp(body.progress);
  /**
   * 100% 之后走不走验收，看的是**「有没有第二方需要验收」**（D-57），不是执行者的角色：
   * - `created_by !== 我`：这条任务是别人发布给我的 → `pending_review`，等发布人验收；
   * - `created_by === 我`：自己发布给自己做的（成员只能建给自己的任务就是这样）→ 直接完成。
   *   旧口径按角色分成「member 进待验收 / 管理者直接完成」，结果是「谁执行」决定了「谁来验收」，
   *   而验收权已经收敛到发布人，这两种情况都没有第二个验收人，只能自己结掉。
   */
  const status: TaskStatus = p >= 100 ? (current.createdBy === user.id ? "completed" : "pending_review") : p > 0 ? "in_progress" : "todo";
  const stamp = now();
  run(
    database,
    "UPDATE tasks SET progress=?,status=?,updated_at=?,completed_at=? WHERE id=?",
    p,
    status,
    stamp,
    status === "completed" ? (current.completedAt ?? stamp) : null,
    id,
  );
  log(database, id, user, String(body.note ?? body.log ?? `进度更新为 ${p}%`).trim(), p);
  const updated = findTask(database, id) as TaskView;
  if (status === "pending_review") event(database, id, user, "task_submitted", "进度达到 100%，提交验收");
  notifyParticipants(
    database,
    updated,
    user.id,
    status === "pending_review" ? "task_submitted" : "task_progress",
    status === "pending_review" ? "任务待验收" : "任务进度更新",
    `${user.name} 更新了任务“${updated.title}”`,
  );
  return done(updated);
}

export function submitReview(user: User, id: string, note: string): ServiceResult<TaskView> {
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  const task = located.task;
  if (task.archivedAt) return failed("ARCHIVED", "请先恢复归档任务", 400);
  if (task.ownerId !== user.id) return failed("FORBIDDEN", "只有任务负责人可以提交验收", 403);
  if (task.status === "pending_review") return done(task);
  // 已完成的任务不能靠提交验收「复活」成待验收：100% 后由 `reportProgress` 定局的终态就是终态，
  // 否则负责人可以把一条已验收通过的任务拉回待验收，绕着状态机再走一遍（D-57）
  if (task.status === "completed") return failed("INVALID_STATE", "已完成任务不能再提交验收", 400);
  if (task.progress < 100) return failed("VALIDATION_ERROR", "进度达到100%后才能提交验收", 400);
  run(database, "UPDATE tasks SET status='pending_review',updated_at=? WHERE id=?", now(), id);
  event(database, id, user, "task_submitted", note);
  const updated = findTask(database, id) as TaskView;
  notifyParticipants(database, updated, user.id, "task_submitted", "任务待验收", `任务“${updated.title}”等待验收`);
  return done(updated);
}

export function approveTask(user: User, id: string, note: string): ServiceResult<TaskView> {
  if (!canManageTasks(user)) return failed("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403);
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  const task = located.task;
  // 验收权归**发布人**（D-57）：只判角色会让任务的负责人自己把任务验收通过，见 canReviewTask
  if (!canReviewTask(user, task)) return failed("FORBIDDEN", "只有任务发布人可以验收该任务", 403);
  if (task.archivedAt) return failed("ARCHIVED", "请先恢复归档任务", 400);
  if (task.status !== "pending_review") return failed("INVALID_STATE", "只有待验收任务可以通过", 400);
  const stamp = now();
  run(database, "UPDATE tasks SET status='completed',progress=100,completed_at=?,updated_at=? WHERE id=?", stamp, stamp, id);
  event(database, id, user, "task_approved", note);
  const updated = findTask(database, id) as TaskView;
  notifyParticipants(database, updated, user.id, "task_approved", "任务验收通过", `任务“${updated.title}”已通过验收`);
  return done(updated);
}

export function returnTask(user: User, id: string, body: Record<string, unknown>): ServiceResult<TaskView> {
  if (!canManageTasks(user)) return failed("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403);
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  const task = located.task;
  // 「退回」与「通过」是同一个验收动作的两面：同一条判据，不能一个收一个放（D-57）
  if (!canReviewTask(user, task)) return failed("FORBIDDEN", "只有任务发布人可以退回该任务", 403);
  if (task.archivedAt) return failed("ARCHIVED", "请先恢复归档任务", 400);
  if (task.status !== "pending_review") return failed("INVALID_STATE", "只有待验收任务可以退回", 400);
  const p = Math.min(task.progress, 99);
  const note = String(body.note ?? "任务被退回，请继续处理").trim() || "任务被退回，请继续处理";
  run(database, "UPDATE tasks SET status='in_progress',progress=?,completed_at=NULL,updated_at=? WHERE id=?", p, now(), id);
  event(database, id, user, "task_returned", note);
  const updated = findTask(database, id) as TaskView;
  notifyParticipants(database, updated, user.id, "task_returned", "任务已退回", `任务“${updated.title}”已退回`);
  return done(updated);
}

export function archiveTask(user: User, id: string): ServiceResult<null> {
  if (!canManageTasks(user)) return failed("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403);
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  if (!located.task.archivedAt) {
    const stamp = now();
    run(database, "UPDATE tasks SET archived_at=?,updated_at=? WHERE id=?", stamp, stamp, id);
    event(database, id, user, "task_archived", "任务已归档");
  }
  return done(null);
}

export function restoreTask(user: User, id: string): ServiceResult<TaskView> {
  if (!canManageTasks(user)) return failed("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403);
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  if (located.task.archivedAt) {
    run(database, "UPDATE tasks SET archived_at=NULL,updated_at=? WHERE id=?", now(), id);
    event(database, id, user, "task_restored", "任务已恢复");
  }
  return done(findTask(database, id) as TaskView);
}

/** 评论读取：`task_comments` 没有 org_id，先经 task_id 取任务并判定组织边界与可见性 */
export function listComments(user: User, id: string): ServiceResult<unknown[]> {
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  const task = located.task;
  return done(
    rows(
      database,
      "SELECT id,task_id AS taskId,author_id AS authorId,author_name AS authorName,author_role AS authorRole,content,created_at AS createdAt FROM task_comments WHERE task_id=? ORDER BY created_at",
      task.id,
    ),
  );
}

export function addComment(user: User, id: string, body: Record<string, unknown>): ServiceResult<Record<string, unknown>> {
  const database = db();
  // 评论有自己的说法，所以把文案交给门本身，而不是复制一遍判断
  const located = viewable(user, id, "无权评论该任务");
  if (!located.ok) return located.failure;
  const task = located.task;
  const content = String(body.content ?? body.text ?? "").trim();
  if (!content) return failed("VALIDATION_ERROR", "评论内容不能为空", 400);
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
  return done(comment, 201);
}

/** 时间线：三张间接表都经 task_id 关联，组织边界由上面那次 locate 兜住 */
export function listActivity(user: User, id: string): ServiceResult<unknown[]> {
  const database = db();
  const located = viewable(user, id);
  if (!located.ok) return located.failure;
  const task = located.task;
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
  return done([...logs, ...comments, ...events].toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
}

/** 打开任务时把该任务的通知标记为已读（旧 UI 在打开详情时调 markNotificationsRead({ taskId })） */
export function markTaskNotificationsRead(user: User, taskId: string): void {
  run(db(), "UPDATE notifications SET is_read=1,read_at=? WHERE recipient_id=? AND task_id=?", now(), user.id, taskId);
}

/** 任务行视图（供列表渲染：与 API 的 TaskView 同形） */
export function taskViewOf(row: Record<string, unknown>): TaskView {
  return toTaskView(row);
}
