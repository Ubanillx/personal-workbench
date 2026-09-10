import { randomUUID } from "node:crypto";
import { date, db, now, rows, run, type User } from "./db.server";
import {
  done,
  failed,
  locateTodo,
  notFoundResult,
  recordClauses,
  resolveRecordOrg,
  TODO_SELECT,
  toTodoView,
  type RecordResult,
} from "./records.server";

/**
 * 待办查询与写入：页面 loader/action 与 /api/todos* 共用同一份实现。
 * 这样页面表单（form-urlencoded）与 JSON API 走的是同一份逻辑，不会出现两套行为。
 *
 * 组织隔离见 app/lib/records.server.ts：列表按 `recordClauses(user)` 过滤，
 * 写入显式带 `org_id`（迁移 009 起是 NOT NULL），按 id 的单条操作先判定组织边界。
 */
export function listTodos(user: User, orgFilter?: string | null): Record<string, unknown>[] {
  const { clauses, params } = recordClauses(user);
  // 管理员的组织筛选器（D-28）。非管理员带上别人的组织也只会得到空列表，不会越权。
  if (orgFilter) {
    clauses.push("org_id=?");
    params.push(orgFilter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return rows(db(), `${TODO_SELECT} ${where} ORDER BY created_at DESC`, ...params).map(toTodoView);
}

/** 新建待办；组织归属由 resolveRecordOrg 解析（成员/管理者写自己的组织，管理员取请求里的 orgId） */
export function createTodoRecord(user: User, body: Record<string, unknown>): RecordResult<Record<string, unknown>> {
  const content = String(body.content ?? "").trim();
  if (!content) return failed("VALIDATION_ERROR", "待办内容不能为空", 400);
  const org = resolveRecordOrg(user, body.orgId);
  if (!org.ok) return org;
  const stamp = now();
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO todos(id,org_id,content,todo_date,is_completed,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    id,
    org.orgId,
    content,
    date(body.todoDate),
    0,
    null,
    stamp,
    stamp,
  );
  const created = locateTodo(user, id);
  if (!created) return failed("INTERNAL", "创建待办失败", 500);
  return done(created, 201);
}

/** 更新待办：不存在或跨组织都返回 404（同一个响应，不泄露资源是否存在） */
export function updateTodoRecord(user: User, id: string, body: Record<string, unknown>): RecordResult<Record<string, unknown>> {
  const current = locateTodo(user, id);
  if (!current) return notFoundResult();
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
  if (!updated) return notFoundResult();
  return done(updated);
}

/** 删除待办：不存在或跨组织都返回 404（旧实现「不存在也回 200」会让跨组织请求与不存在可区分） */
export function deleteTodoRecord(user: User, id: string): RecordResult<null> {
  if (!locateTodo(user, id)) return notFoundResult();
  run(db(), "DELETE FROM todos WHERE id=?", id);
  return done(null);
}
