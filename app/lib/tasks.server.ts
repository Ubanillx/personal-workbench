import { randomUUID } from "node:crypto";
import type { TaskPriority, TaskStatus, UserRole } from "../../shared/types/domain";
import { now, one, rows, run, toUser, type Db, type User } from "./db.server";
import { createNotification } from "./notifications.server";
import type { Paged, Paging, SortSpec } from "./paging";
import { likeTerm, orderOf, pageOf, type SortableColumns } from "./paging.server";
import { orgScope } from "./session.server";
import { canManageRole } from "./task-permissions";

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
 * 任务的 JOIN 来源（负责人姓名/角色 + 组织名，见 D-28 的合并视图）。
 *
 * 单独抽出来是服务端分页的需要：`COUNT(*)` 只能用 FROM/JOIN，不能带列清单
 * （`SELECT` 里可能有自己的占位符，见 app/lib/paging.server.ts 的 `ListSource.source`）。
 */
export const TASK_SOURCE = `FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN organizations o ON o.id=t.org_id`;

/**
 * 与旧 server/src/routes/workbench.ts 第 11 行一致，补 `t.org_id AS orgId` 与组织名
 * （D-28 的合并视图要能看出每行属于哪个组织；组织名走 JOIN，不在 toTaskView 里逐行查库）。
 */
export const SELECT_TASK = `SELECT t.id,t.title,t.description,t.priority,t.status,t.progress,t.due_date AS dueDate,t.owner_id AS ownerId,t.created_by AS createdBy,t.source,t.is_private AS isPrivate,t.created_at AS createdAt,t.updated_at AS updatedAt,t.completed_at AS completedAt,t.archived_at AS archivedAt,t.org_id AS orgId,o.name AS orgName,u.name AS ownerName,u.role AS ownerRole ${TASK_SOURCE}`;

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

/**
 * 任务管理权：改元信息 / 归档 / 恢复 / 删除（§4）。具体某个组织是否管得着由 `assertOrgAccess` 判定。
 *
 * ⚠️ **验收（`approve` / `return`）不在这条线上**：它还要求「是这条任务的发布人」，
 * 判据在 `task-permissions.ts` 的 `canReviewTask()`（前后端共用一份），别在这里放行。
 */
export function canManageTasks(user: User): boolean {
  return canManageRole(user.role);
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

/** `/tasks` 的列表筛选条件（与 URL 参数一一对应；服务端分页后筛选也必须在服务端） */
export type TaskFilters = {
  includeArchived: boolean;
  status?: string | undefined;
  assignee?: string | undefined;
  orgFilter?: string | null | undefined;
  /** 关键词：任务标题或负责人姓名（原来是浏览器里 filter，服务端分页后必须落到 SQL） */
  keyword?: string | undefined;
  /** 更新时间范围的两端（含当天）：原来也是在 loader 里内存过滤 */
  from?: string | undefined;
  to?: string | undefined;
};

/**
 * 筛选条件 → WHERE。`visible()`（接口与概览页要的全量）与 `visiblePage()`（页面的一页）**共用这一份**：
 * 分页之后「列表里看见的」和「统计里数出来的」必须是同一批数据，条件各写一份就必然对不上。
 */
function taskWhere(user: User, filters: TaskFilters): { where: string; params: string[] } {
  const { clauses, params } = visibilityClauses(user);
  if (!filters.includeArchived) clauses.push("t.archived_at IS NULL");
  if (filters.status && filters.status !== "all") {
    clauses.push("t.status=?");
    params.push(filters.status);
  }
  if (filters.assignee === "mine") {
    clauses.push("t.owner_id=?");
    params.push(user.id);
  } else if (filters.assignee === "unassigned") {
    clauses.push("t.owner_id IS NULL");
  } else if (filters.assignee && filters.assignee !== "all") {
    clauses.push("t.owner_id=?");
    params.push(filters.assignee);
  }
  // 管理员的组织筛选器（D-28）：合并视图下只看某个组织
  if (filters.orgFilter) {
    clauses.push("t.org_id=?");
    params.push(filters.orgFilter);
  }
  const keyword = (filters.keyword ?? "").trim();
  if (keyword) {
    // 口径与原浏览器 filter 一致（标题或负责人姓名，含即命中）；LIKE 的关键词要转义，否则 `%` 会变成通配符
    const like = likeTerm(keyword);
    clauses.push(`(t.title LIKE ? ESCAPE '\\' OR IFNULL(u.name,'') LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  // 更新时间范围：按「日期」比较（原实现是 updatedAt.slice(0,10) 的字符串比较，这里逐字对应）
  if (filters.from) {
    clauses.push("substr(t.updated_at,1,10)>=?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("substr(t.updated_at,1,10)<=?");
    params.push(filters.to);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function visible(
  database: Db,
  user: User,
  includeArchived: boolean,
  status?: string,
  assignee?: string,
  orgFilter?: string | null,
): TaskView[] {
  const { where, params } = taskWhere(user, { includeArchived, status, assignee, orgFilter });
  return rows(database, `${SELECT_TASK} ${where} ORDER BY t.updated_at DESC`, ...params).map(toTaskView);
}

/**
 * 任务列表的排序白名单：列 key 与 `/tasks` 列的 `key` 一一对应，`{dir}` 由方向替换
 * （翻译规则见 app/lib/paging.server.ts 的 `orderOf`）。
 *
 * `dueDate` 用 `IFNULL(...,'9999-99-99')` 是**刻意**的：原来的比较器把空值当 `"9999"`（最大值），
 * 于是升序时空值排最后、降序时排最前；SQLite 默认把 NULL 当最小值，两者正好相反，不能直接用列名排。
 */
export const TASK_SORTABLE: SortableColumns = {
  title: { column: "t.title" },
  progress: { by: "t.progress {dir}" },
  dueDate: { by: "IFNULL(t.due_date,'9999-99-99') {dir}" },
  updatedAt: { by: "t.updated_at {dir}" },
};

/** 默认排序：最近更新在前（与改动前表头的默认排序一致） */
export const DEFAULT_TASK_SORT: SortSpec = { key: "updatedAt", direction: "desc" };

/** 任务列表的一页（服务端筛选 + 排序 + 分页；页面只拿到当页的行） */
export function visiblePage(database: Db, user: User, filters: TaskFilters, paging: Paging, sort: SortSpec): Paged<TaskView> {
  const { where, params } = taskWhere(user, filters);
  return pageOf<TaskView>({
    database,
    select: SELECT_TASK,
    source: TASK_SOURCE,
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: TASK_SORTABLE, sort, tieBreak: "t.id", id: "t.id" }),
    map: toTaskView,
  });
}

/** 任务列表的统计（任务总数 / 已完成 / 待验收 / 已逾期） */
export type TaskStats = { total: number; completed: number; pendingReview: number; overdue: number };

/**
 * 列表统计必须由服务端算：服务端分页后页面手里只有一页，
 * 在浏览器里数 `rows.length` 会得到「这一页有几条」，而且随翻页变化。
 * 口径与列表**共用 `taskWhere()`**，所以统计的永远是当前筛选条件下的全量。
 */
export function taskStats(database: Db, user: User, filters: TaskFilters, today: string): TaskStats {
  const { where, params } = taskWhere(user, filters);
  const row = one<{ total: number; completed: number; pendingReview: number; overdue: number }>(
    database,
    `SELECT COUNT(*) AS total,
            IFNULL(SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END),0) AS completed,
            IFNULL(SUM(CASE WHEN t.status='pending_review' THEN 1 ELSE 0 END),0) AS pendingReview,
            IFNULL(SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date<? AND t.status<>'completed' AND t.archived_at IS NULL THEN 1 ELSE 0 END),0) AS overdue
     ${TASK_SOURCE} ${where}`,
    today,
    ...params,
  );
  return {
    total: Number(row?.total ?? 0),
    completed: Number(row?.completed ?? 0),
    pendingReview: Number(row?.pendingReview ?? 0),
    overdue: Number(row?.overdue ?? 0),
  };
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
 * 通知任务参与者：负责人 + **发布人** + 本组织的组织管理者。
 * 私密任务只通知**可见的参与方**——负责人与发布人；其他组织管理者看不到这条任务，
 * 把标题发过去就是泄露（D-54 起负责人与发布人可以是两个人，因此这里要带上双方）。
 *
 * 发布人也必须在收件人里（D-57）：**验收权归发布人**，而「待验收」通知发出去的时候，
 * 收件人多半就是唯一能动这条任务的人。管理员发布的组织任务是唯一的缺口——它不是该组织的
 * 管理者，只靠 `orgManagerIds` 会收到「看得见但动不了」的人，而真正该验收的人一条都没收到。
 */
export function notifyParticipants(database: Db, t: TaskView | null, actor: string, type: string, title: string, message: string): void {
  if (!t) return;
  const recipients = t.isPrivate ? [t.ownerId, t.createdBy] : [t.ownerId, t.createdBy, ...orgManagerIds(database, t.id)];
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
    // 与 notifyParticipants 同一收件人口径：私密任务只发负责人与发布人（其他人看不到它）；
    // 非私密任务 = 负责人 + 发布人 + 本组织管理者（发布人可能是不属于该组织的管理员，D-57）
    const recipients = item.isPrivate
      ? [item.ownerId, item.createdBy]
      : [item.ownerId, item.createdBy, ...orgManagerIds(database, item.id)];
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
