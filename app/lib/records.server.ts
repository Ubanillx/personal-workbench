import { db, one, type User } from "./db.server";
import { fail } from "./http.server";
import { assertOrgAccess, notFound, orgIsActive, orgScope } from "./session.server";

/**
 * 待办 / 随手记 / 重要文件的共享访问层：字段别名与旧实现逐字一致，`org_id` 只在服务端使用。
 *
 * 组织隔离（docs/harness/ACCOUNTS_AND_ORGS.md §14.2）只在这一个文件里落地：
 * - 读列表：`recordClauses(user)` 产出组织条件，调用方拼进自己的 WHERE；
 * - 读单条：`locateTodo/locateNote/locateFile` 先取出行与它的 `org_id`，再用 `assertOrgAccess` 判定，
 *   「不存在」与「跨组织」返回同样的 null，调用方一律转 404（不泄露资源是否存在）；
 * - 写入：`resolveRecordOrg(user, requested)` 决定新行的 `org_id`（迁移 009 起是 NOT NULL）。
 * 写法与任务域的 `tasks.server.ts`（`visibilityClauses`）/`task-service.server.ts`（`locate`）保持一致。
 */

export type RecordFailure = { ok: false; code: string; message: string; status: number };
export type RecordResult<T> = { ok: true; data: T; status: number } | RecordFailure;

export const done = <T>(data: T, status = 200): RecordResult<T> => ({ ok: true, data, status });
export const failed = (code: string, message: string, status: number): RecordResult<never> => ({
  ok: false,
  code,
  message,
  status,
});

/** 与 session.notFound() 同一信封：跨组织与「不存在」必须给出完全一样的响应 */
export const notFoundResult = (): RecordResult<never> => failed("NOT_FOUND", "未找到该资源", 404);

/** 域失败 → 响应：404 统一走 notFound()（跨组织不返回 403，避免泄露资源是否存在） */
export function failureResponse(failure: RecordFailure): Response {
  return failure.status === 404 ? notFound() : fail(failure.code, failure.message, failure.status);
}

/* ------------------------------------------------------------------ SQL 片段 */

/** 三张表的列清单：`org_id` 排在最后，仅供服务端判断归属，不进响应体 */
export const TODO_SELECT = `SELECT id,content,todo_date AS todoDate,is_completed AS isCompleted,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt,org_id AS orgId FROM todos`;
export const NOTE_SELECT = `SELECT id,content,is_pinned AS isPinned,created_at AS createdAt,updated_at AS updatedAt,org_id AS orgId FROM notes`;
export const FILE_SELECT = `SELECT id,name,file_path AS filePath,category,last_used_at AS lastUsedAt,created_at AS createdAt,updated_at AS updatedAt,org_id AS orgId FROM important_files`;

/* ------------------------------------------------------------------ 载荷 */

/** 与旧实现的字段别名逐字一致（`org_id` 丢掉，载荷里不出现组织字段） */
export function toTodoView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    content: String(row.content),
    todoDate: row.todoDate == null ? null : String(row.todoDate),
    isCompleted: Number(row.isCompleted),
    completedAt: row.completedAt == null ? null : String(row.completedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function toNoteView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    content: String(row.content),
    isPinned: Number(row.isPinned),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function toFileView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    name: String(row.name),
    filePath: String(row.filePath),
    category: String(row.category),
    lastUsedAt: row.lastUsedAt == null ? null : String(row.lastUsedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

/* ------------------------------------------------------------------ 读：组织范围 */

/**
 * 记录域的可见范围（§14.2 与 §14.3）：
 * - 管理员：`orgScope` 为 null，不限组织（D-28 的合并视图 + 组织筛选器）；
 * - 已加入组织的人：只看到本组织；
 * - 尚未加入组织的账号（刚注册、组织被解散后，D-24/D-34）：`orgScope` 同样是 null，
 *   但语义是「一个组织都看不到」，这里用 `1=0` 显式兜底——绝不能当成管理员的跨组织视图。
 */
export function recordClauses(user: User): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const scope = orgScope(user);
  if (scope) {
    clauses.push("org_id=?");
    params.push(scope);
  } else if (user.role !== "admin") {
    clauses.push("1=0");
  }
  return { clauses, params };
}

/* ------------------------------------------------------------------ 写：组织归属 */

export type RecordOrg = { ok: true; orgId: string } | RecordFailure;

/**
 * 写入时确定新行的 `org_id`（§14.2，迁移 009 起是 NOT NULL）：
 * - 普通成员 / 组织管理者：写自己的组织；请求里带的 `orgId` 一律忽略（写不了别人的组织）；
 * - 管理员：全局角色、不隶属组织（§3.2），必须由请求指定 `orgId`，否则 400；
 * 判定的口径与任务域 `createTask` 逐条一致，避免两个域对「谁写进哪个组织」给出不同答案。
 */
export function resolveRecordOrg(user: User, requested: unknown): RecordOrg {
  const orgId = user.role === "admin" ? (typeof requested === "string" ? requested.trim() : "") : (user.orgId ?? "");
  if (!orgId) {
    return user.role === "admin"
      ? { ok: false, code: "VALIDATION_ERROR", message: "管理员必须指定记录所属组织", status: 400 }
      : { ok: false, code: "FORBIDDEN", message: "你还没有加入组织，无法写入", status: 403 };
  }
  if (!orgIsActive(user, orgId)) {
    return { ok: false, code: "VALIDATION_ERROR", message: "组织不存在或已解散，不能写入", status: 400 };
  }
  return { ok: true, orgId };
}

/* ------------------------------------------------------------------ 读：单条 + 组织边界 */

/** 存在性 + 组织边界：不存在或跨组织都返回 null，调用方一律回 404（§14.2） */
export function locateTodo(user: User, id: string): Record<string, unknown> | null {
  const row = one<Record<string, unknown>>(db(), `${TODO_SELECT} WHERE id=?`, id);
  if (!row) return null;
  if (assertOrgAccess(user, row.orgId == null ? null : String(row.orgId))) return null;
  return toTodoView(row);
}

export function locateNote(user: User, id: string): Record<string, unknown> | null {
  const row = one<Record<string, unknown>>(db(), `${NOTE_SELECT} WHERE id=?`, id);
  if (!row) return null;
  if (assertOrgAccess(user, row.orgId == null ? null : String(row.orgId))) return null;
  return toNoteView(row);
}

export function locateFile(user: User, id: string): Record<string, unknown> | null {
  const row = one<Record<string, unknown>>(db(), `${FILE_SELECT} WHERE id=?`, id);
  if (!row) return null;
  if (assertOrgAccess(user, row.orgId == null ? null : String(row.orgId))) return null;
  return toFileView(row);
}
