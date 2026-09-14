import { randomUUID } from "node:crypto";
import { date, db, now, rows, run, type User } from "./db.server";
import type { Paged, Paging, SortSpec } from "./paging";
import { likeTerm, orderOf, pageOf, type SortableColumns } from "./paging.server";
import {
  denialFailure,
  done,
  failed,
  locateTodo,
  notFoundResult,
  personalClauses,
  RECORD_FORBIDDEN_MESSAGE,
  resolveRecordOrg,
  TODO_SELECT,
  TODO_SOURCE,
  toTodoView,
  type LocatedRecord,
  type RecordResult,
} from "./records.server";

/**
 * 待办查询与写入：页面 loader/action 与 /api/todos* 共用同一份实现。
 * 这样页面表单（form-urlencoded）与 JSON 请求走的是同一份逻辑，不会出现两套行为。
 *
 * **归属见 app/lib/records.server.ts（D-54）**：待办是**本人数据**，列表按 `personalClauses(user)`
 * 过滤（`owner_id = 本人`，管理员也不例外），写入显式写 `owner_id`，按 id 的单条操作先判定归属边界
 * （跨组织 404 / 同组织但不是本人 403）。
 */

/** 无权（403）与不存在 / 跨组织（404）的映射只写在 records.server.ts，这里只做转手 */
function denied(located: LocatedRecord): RecordResult<never> | null {
  return located.deny ? denialFailure(located.deny, RECORD_FORBIDDEN_MESSAGE).failure : null;
}

/**
 * `/todos` 的列表筛选条件（与 URL 参数一一对应）。
 *
 * 关键词、完成状态、计划日期三个筛选原来都在浏览器里做（`useMemo` 里 filter），
 * 服务端分页之后必须落到 SQL：否则「每页 10 条」先被服务端切好、又被前端筛掉一半，
 * 页面上看起来就是「一页只有 3 条，但分页条说共 40 条」。
 */
export type TodoFilters = {
  orgFilter?: string | null | undefined;
  /** 关键词：待办内容（纯字面匹配，与原来的 `includes()` 一致） */
  keyword?: string | undefined;
  /** 全部 `all` / 未完成 `open` / 已完成 `done` */
  status?: string | undefined;
  /** 全部 `all` / 今天 `today` / 已逾期 `overdue` */
  date?: string | undefined;
  /** 服务端当天（`YYYY-MM-DD`）：`today` / `overdue` 两个口径都按它算，页面不再各自取一次 */
  today?: string | undefined;
};

/**
 * 筛选条件 → WHERE。`listTodos()`（`/api/todos` 要的全量）与 `todosPage()`（页面的一页）
 * **共用这一份**，接口与列表的筛选口径不可能不一致。
 */
function todoWhere(user: User, filters: TodoFilters): { where: string; params: string[] } {
  const { clauses, params } = personalClauses(user);
  // 管理员的组织筛选器（D-28）。非管理员带上别人的组织也只会得到空列表，不会越权。
  if (filters.orgFilter) {
    clauses.push("org_id=?");
    params.push(filters.orgFilter);
  }
  const keyword = (filters.keyword ?? "").trim();
  if (keyword) {
    clauses.push(`content LIKE ? ESCAPE '\\'`);
    params.push(likeTerm(keyword));
  }
  if (filters.status === "open") clauses.push("is_completed=0");
  if (filters.status === "done") clauses.push("is_completed=1");
  if (filters.today) {
    if (filters.date === "today") {
      clauses.push("todo_date=?");
      params.push(filters.today);
    }
    // 已逾期 = 未完成 + 有日期 + 日期在今天之前（没有日期的待办不算逾期）
    if (filters.date === "overdue") {
      clauses.push("is_completed=0 AND todo_date IS NOT NULL AND todo_date<?");
      params.push(filters.today);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listTodos(user: User, orgFilter?: string | null): Record<string, unknown>[] {
  const { where, params } = todoWhere(user, { orgFilter });
  return rows(db(), `${TODO_SELECT} ${where} ORDER BY created_at DESC`, ...params).map(toTodoView);
}

/**
 * 待办的排序白名单：列 key 与 `/todos` 列的 `key` 对应（`{dir}` 由方向替换，见 `orderOf`）。
 * `todoDate` 直接用列名排即可：SQLite 把 NULL 当最小值，与原来 `String(x ?? "")` 的次序完全一致。
 */
export const TODO_SORTABLE: SortableColumns = {
  content: { column: "content" },
  todoDate: { by: "todo_date {dir}" },
  updatedAt: { by: "updated_at {dir}" },
  // 默认序（创建时间倒序）没有对应的列，但必须在白名单里：它是 `orderOf` 的兜底方向
  createdAt: { by: "created_at {dir}" },
};

/** 默认排序：最近创建在前（与改动前列表的数据序一致） */
export const DEFAULT_TODO_SORT: SortSpec = { key: "createdAt", direction: "desc" };

/** 待办列表的一页（服务端筛选 + 排序 + 分页） */
export function todosPage(user: User, filters: TodoFilters, paging: Paging, sort: SortSpec): Paged<Record<string, unknown>> {
  const { where, params } = todoWhere(user, filters);
  return pageOf<Record<string, unknown>>({
    database: db(),
    select: TODO_SELECT,
    source: TODO_SOURCE,
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: TODO_SORTABLE, sort, tieBreak: "id", id: "id" }),
    map: toTodoView,
  });
}

/**
 * 新建待办；组织归属由 `resolveRecordOrg` 解析（成员/管理者写自己的组织，管理员取请求里的 orgId），
 * 归属人**恒为当前账号**——待办没有「替别人建」这回事，请求里的 ownerId 一律忽略。
 */
export function createTodoRecord(user: User, body: Record<string, unknown>): RecordResult<Record<string, unknown>> {
  const content = String(body.content ?? "").trim();
  if (!content) return failed("VALIDATION_ERROR", "待办内容不能为空", 400);
  const org = resolveRecordOrg(user, body.orgId);
  if (!org.ok) return org;
  const stamp = now();
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO todos(id,org_id,owner_id,content,todo_date,is_completed,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    org.orgId,
    user.id,
    content,
    date(body.todoDate),
    0,
    null,
    stamp,
    stamp,
  );
  const created = locateTodo(user, id);
  if (!created.view) return denied(created) ?? failed("INTERNAL", "创建待办失败", 500);
  return done(created.view, 201);
}

/** 更新待办：不存在 / 跨组织 404，同组织但不是本人 403（两种失败不共用同一个响应） */
export function updateTodoRecord(user: User, id: string, body: Record<string, unknown>): RecordResult<Record<string, unknown>> {
  const located = locateTodo(user, id);
  if (!located.view) return denied(located) ?? notFoundResult();
  const current = located.view;
  const completed = body.isCompleted === undefined ? Number(current.isCompleted) : body.isCompleted ? 1 : 0;
  const stamp = now();
  run(
    db(),
    "UPDATE todos SET content=?,todo_date=?,is_completed=?,completed_at=?,updated_at=? WHERE id=?",
    String(body.content ?? current.content),
    body.todoDate === undefined ? current.todoDate : date(body.todoDate),
    completed,
    completed ? (current.completedAt ?? stamp) : null,
    stamp,
    id,
  );
  const updated = locateTodo(user, id);
  if (!updated.view) return denied(updated) ?? notFoundResult();
  return done(updated.view);
}

/** 删除待办：不存在 / 跨组织 404，同组织但不是本人 403 */
export function deleteTodoRecord(user: User, id: string): RecordResult<null> {
  const located = locateTodo(user, id);
  if (!located.view) return denied(located) ?? notFoundResult();
  run(db(), "DELETE FROM todos WHERE id=?", id);
  return done(null);
}
