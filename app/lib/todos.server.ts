import { randomUUID } from "node:crypto";
import { date, db, now, rows, run, type User } from "./db.server";
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

export function listTodos(user: User, orgFilter?: string | null): Record<string, unknown>[] {
  const { clauses, params } = personalClauses(user);
  // 管理员的组织筛选器（D-28）。非管理员带上别人的组织也只会得到空列表，不会越权。
  if (orgFilter) {
    clauses.push("org_id=?");
    params.push(orgFilter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return rows(db(), `${TODO_SELECT} ${where} ORDER BY created_at DESC`, ...params).map(toTodoView);
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
