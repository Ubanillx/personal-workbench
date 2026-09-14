import { db, one, type User } from "./db.server";
import { fail } from "./http.server";
import { forbidden, notFound, orgIsActive, orgScope } from "./session.server";

/**
 * 待办 / 随手记 / 重要文件的共享访问层：字段别名与旧实现逐字一致，`org_id` / `owner_id` 只在服务端使用。
 *
 * 归属与隔离（docs/harness/ACCOUNTS_AND_ORGS.md §14.2、D-54）只在这一个文件里落地，
 * 三个域**刻意分成两类**，不要把它们的可见范围混在一起：
 * - **本人数据**（`todos` / `notes`）：`personalClauses(user)` 产出 `owner_id = 本人` 条件，
 *   管理员也不例外；读单条用 `assertRecordAccess`（跨组织 404 / 同组织非本人 403）；
 * - **组织公共数据**（`important_files`）：`recordClauses(user)` 产出组织条件，组织内所有人可见；
 *   读单条用 `assertOrgAccess`（跨组织 404），「谁能删」由写侧 `assertFileDelete` 单独判；
 * - 写入：`resolveRecordOrg(user, requested)` 决定新行的 `org_id`（迁移 009 起是 NOT NULL），
 *   本人数据的 `owner_id` 一律等于当前账号。
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

/**
 * 三张表的列清单：`org_id`（与待办/随手记的 `owner_id`、文件的 `visibility`/`owner_id`）
 * 排在最后，仅供服务端判断归属与可见性，不进响应体。
 *
 * 归属字段的可见性差别（D-54 / D-55）：
 * - `todos` / `notes` 是**本人数据**（迁移 017 起有 `owner_id`），管理员也不能看别人的；
 * - `important_files` 由**每一行自己的 `visibility`** 决定：`org` = 组织内公开，
 *   `private` = 创建人 + 本组织管理员（D-55）。
 */
/**
 * 三张表的 FROM：服务端分页的 `COUNT(*)` 用它。
 *
 * 必须与列清单分开：`SELECT` 里可能有**自己的占位符**（文件的 `owned`），
 * COUNT 查询用不上它、更不能替它占位（见 app/lib/paging.server.ts 的 `ListSource.source`）。
 */
export const TODO_SOURCE = "FROM todos";
export const NOTE_SOURCE = "FROM notes";
export const FILE_SOURCE = "FROM important_files";

export const TODO_SELECT = `SELECT id,content,todo_date AS todoDate,is_completed AS isCompleted,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt,org_id AS orgId,owner_id AS ownerId ${TODO_SOURCE}`;
export const NOTE_SELECT = `SELECT id,content,is_pinned AS isPinned,created_at AS createdAt,updated_at AS updatedAt,org_id AS orgId,owner_id AS ownerId ${NOTE_SOURCE}`;
/**
 * 文件行：最后三列（`org_id` / `visibility` / `owner_id`）只给服务端判权；
 * 最前面的 `owned` 是「这条是不是当前账号登记的」，供页面显示「我登记的」标识。
 * ⚠️ `owned` 的占位符在最前，因此**查询参数必须以当前用户 id 打头**（见 `listFiles` / `locateFile`）；
 * 服务端分页时它走 `pageOf` 的 `selectParams`（只属于 SELECT、COUNT 不带）。
 */
export const FILE_SELECT = `SELECT id,name,file_path AS filePath,category,last_used_at AS lastUsedAt,created_at AS createdAt,updated_at AS updatedAt,(owner_id=? AND owner_id IS NOT NULL) AS owned,org_id AS orgId,visibility,owner_id AS ownerId ${FILE_SOURCE}`;

/* ------------------------------------------------------------------ 载荷 */

/**
 * 与旧实现的字段别名逐字一致（`org_id` / `owner_id` 丢掉，载荷里不出现归属字段）。
 * 归属只用于服务端判权：载荷里带上它，页面就能拿去当权限判断的输入，与「页面权限和接口权限一致」相抵触。
 *
 * **`visibility` 例外，它是刻意回传的**：它不是归属信息，而是用户自己选的可见范围，
 * 页面要拿它渲染「个人 / 组织」标识、并在编辑抽屉里回填当前值——不给的话页面只能猜。
 */
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
    // 可见范围是**用户自己选的**，必须回传：页面要拿它渲染「个人 / 组织」标识、编辑时回填。
    // 老数据（迁移 018 之前）与「没有可认领账号」的兜底行都按组织公开处理。
    visibility: row.visibility === "private" ? "private" : "org",
    // `owned` = 这条索引是不是当前账号登记的（创建人）。它是**用户自己就能看到的事实**，
    // 不是权限判据：页面拿它显示「我登记的」，真正的门槛始终在服务端（删除时重判）。
    owned: Number(row.owned) === 1,
  };
}

/* ------------------------------------------------------------------ 读：可见范围 */

/**
 * **组织公共数据**的可见范围（`important_files`，§14.2 / D-55）：组织条件 + 文件的可见范围。
 *
 * 组织条件：组织内所有人（含普通成员）都看得到，管理员不限组织（D-28 的合并视图 + 组织筛选器）。
 * ⚠️ 管理员与「尚未加入组织的账号」`orgScope` 都是 null，但语义相反：
 * 前者是「所有组织」，后者是「一个组织都看不到」，因此这里用 `1=0` 显式兜底。
 *
 * 可见范围（D-55）：`visibility='private'` 的个人文件只给**创建人**与**本组织的全局管理员**看。
 * 注意 `visibility IS NULL` 一律当 org 处理——那是「老数据且当时没有可认领账号」的兜底，
 * 不能因为多了一列就让存量文件凭空消失。
 */
export function recordClauses(user: User): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const scope = orgScope(user);
  if (scope) {
    clauses.push("org_id=?");
    params.push(scope);
    // 非管理员：组织内的公开文件 + 自己登记的个人文件
    if (user.role !== "admin") {
      clauses.push("(visibility IS NULL OR visibility<>'private' OR owner_id=?)");
      params.push(user.id);
    }
  } else if (user.role !== "admin") {
    clauses.push("1=0");
  }
  return { clauses, params };
}

/**
 * **本人数据**的可见范围（`todos` / `notes`，D-54）：只属于归属人，**任何角色都不例外**——
 * 管理员同样只看得到自己的待办与随手记（这是它与 `recordClauses` 的关键区别，
 * 也是「待办和随手记继续限制为本人数据」这条规则的唯一落点）。
 *
 * 组织条件仍然带上：`owner_id` 已经唯一确定归属人，组织条件只是让「换组织后看不到旧组织的记录」
 * 这类边界与其它域保持一致；`org_id` 为空的账号一个人都看不到。
 */
export function personalClauses(user: User): { clauses: string[]; params: string[] } {
  const clauses: string[] = ["owner_id=?"];
  const params: string[] = [user.id];
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

/* ------------------------------------------------------------------ 读：单条 + 归属边界 */

/**
 * 单条读取的结果：命中 / 有权但不存在 / 无权（`deny` 就是要直接回给客户端的响应）。
 * `access` 带上这一行的判权字段（归属人、可见范围），**不回给客户端**，只给域服务判「能不能删」用。
 */
export type LocatedRecord =
  { view: Record<string, unknown>; access: RowAccess; deny: null } | { view: null; access: null; deny: Response | null };

/** 个人文件（`visibility='private'`）的可见方：创建人本人 + 本组织的全局管理员 */
export const FILE_FORBIDDEN_MESSAGE = "只能访问自己的个人文件";

/**
 * 单条可见性判定，**返回响应**（不是布尔值），与 `assertOrgAccess` 同一形状。
 *
 * 语义差异刻意保留（D-35 / D-54）：
 * - 跨组织、或归属字段为空（迁移 017 之前遗留、且当时没有可认领账号的记录）→ **404「未找到该资源」**，
 *   与「这条记录压根不存在」完全一致，不泄露存在性；
 * - 同组织但不是本人 → **403**：对方本来就知道组织里有这条记录，藏着才奇怪
 *   （任务域「同组织无可见权返回 403」是同一条口径）。
 */
export function assertRecordAccess(user: User, resource: { orgId: string | null; ownerId: string | null }): Response | null {
  // 归属字段为空 = 没有归属人 = 谁都不属于 → 与「没见过这条记录」同一响应
  if (!resource.orgId || !resource.ownerId) return notFound();
  // 管理员跨组织仍可访问（orgScope 为 null），其余人跨组织一律 404
  if (resource.orgId !== orgScope(user) && user.role !== "admin") return notFound();
  return resource.ownerId === user.id ? null : forbidden("只能访问本人的记录");
}

/**
 * 单条**文件**的可见性（D-55）：先过组织边界，再看文件自己的可见范围。
 *
 * | 文件 | 谁能访问 |
 * | ---- | -------- |
 * | `visibility='org'`（或老数据的 NULL） | 本组织所有人；管理员跨组织 |
 * | `visibility='private'` | **创建人本人**，以及**同一组织的全局管理员** |
 *
 * 跨组织一律 404（不变式 1 不受 D-55 影响：管理员看别人的个人文件也只在**同组织**内）；
 * 同组织但看不到别人的个人文件 → 403「只能访问自己的个人文件」。
 */
export function assertFileAccess(
  user: User,
  file: { orgId: string | null; visibility: string | null; ownerId: string | null },
): Response | null {
  const inOrg = Boolean(file.orgId) && (user.role === "admin" || user.orgId === file.orgId);
  if (!inOrg) return notFound();
  if (file.visibility !== "private") return null;
  // 个人文件：创建人本人，或（同组织的）全局管理员
  if (file.ownerId && file.ownerId === user.id) return null;
  if (user.role === "admin") return null;
  return forbidden(FILE_FORBIDDEN_MESSAGE);
}

/** 服务端判权的失败结果：`status` 决定调用方回 403 还是 404，响应体与 session.notFound() 同一形状 */
export type RecordDenial = { status: 403 | 404; failure: RecordFailure };

/** 三种「同组织但看不到」各自的说法（403 文案按域区分，见 `denialFailure`） */
export const RECORD_FORBIDDEN_MESSAGE = "只能访问本人的记录";

/**
 * 判权响应 → 服务失败：**403 与 404 的映射只写在这一处**（各域服务都调它，不各自复制一份）。
 *
 * `message` 是 403 时给人看的那句话：三个域的措辞不同（待办/随手记「只能访问本人的记录」、
 * 个人文件「只能访问自己的个人文件」），但「403 用它、404 一律 NOT_FOUND」这条规则是共用的。
 */
export function denialFailure(deny: Response, message: string): RecordDenial {
  return deny.status === 403
    ? { status: 403, failure: { ok: false, code: "FORBIDDEN", message, status: 403 } }
    : { status: 404, failure: { ok: false, code: "NOT_FOUND", message: "未找到该资源", status: 404 } };
}

/** 行里的判权字段：归属于谁、可见范围是什么。只给服务端用，不进任何响应载荷 */
export type RowAccess = { orgId: string | null; ownerId: string | null; visibility: string | null };

/** 存在性 + 归属边界：不存在 / 跨组织 / 不是本人 → `view` 为 null，`deny` 给出该回的响应（null = 真不存在） */
function locatePersonalRow(user: User, select: string, id: string, toView: (row: Record<string, unknown>) => Record<string, unknown>) {
  const row = one<Record<string, unknown>>(db(), `${select} WHERE id=?`, id);
  if (!row) return { view: null, access: null, deny: null } as LocatedRecord;
  const deny = assertRecordAccess(user, rowAccess(row));
  return (deny ? { view: null, access: null, deny } : { view: toView(row), access: rowAccess(row), deny: null }) as LocatedRecord;
}

export function locateTodo(user: User, id: string): LocatedRecord {
  return locatePersonalRow(user, TODO_SELECT, id, toTodoView);
}

export function locateNote(user: User, id: string): LocatedRecord {
  return locatePersonalRow(user, NOTE_SELECT, id, toNoteView);
}

/**
 * 重要文件：组织边界 + 文件自己的可见范围（D-55）。
 * 不存在 / 跨组织 / 别人的个人文件（非管理员）一律 `null`，调用方按 `deny` 决定回 403 还是 404。
 */
export function locateFile(user: User, id: string): LocatedRecord {
  const row = one<Record<string, unknown>>(db(), `${FILE_SELECT} WHERE id=?`, user.id, id);
  if (!row) return { view: null, access: null, deny: null };
  const access = rowAccess(row);
  const deny = assertFileAccess(user, access);
  return deny ? { view: null, access: null, deny } : { view: toFileView(row), access, deny: null };
}

/**
 * 行里的判权字段（`*_SELECT` 刻意带出来，只给服务端判权用）：
 * `visibility` 对 `todos` / `notes` 恒为 null，只有 `important_files` 用得上。
 */
export function rowAccess(row: Record<string, unknown>): RowAccess {
  return {
    orgId: row.orgId == null ? null : String(row.orgId),
    ownerId: row.ownerId == null ? null : String(row.ownerId),
    visibility: row.visibility == null ? null : String(row.visibility),
  };
}
