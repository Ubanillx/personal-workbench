import { randomUUID } from "node:crypto";
import { db, now, rows, run, type User } from "./db.server";
import {
  done,
  failed,
  locateNote,
  notFoundResult,
  recordClauses,
  resolveRecordOrg,
  NOTE_SELECT,
  toNoteView,
  type RecordResult,
} from "./records.server";

/**
 * 随手记写入与查询：页面 loader/action 与 /api/notes* 共用同一份实现。
 * 页面目前只需要列表、新建、删除（旧 UI 没有编辑入口），PATCH 仍留在 API 路由里。
 *
 * 组织隔离见 app/lib/records.server.ts：列表按 `recordClauses(user)` 过滤，
 * 写入显式带 `org_id`（迁移 009 起是 NOT NULL），按 id 的单条操作先判定组织边界。
 */
export function listNotes(user: User, orgFilter?: string | null): Record<string, unknown>[] {
  const { clauses, params } = recordClauses(user);
  // 管理员的组织筛选器（D-28）。非管理员带上别人的组织也只会得到空列表，不会越权。
  if (orgFilter) {
    clauses.push("org_id=?");
    params.push(orgFilter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return rows(db(), `${NOTE_SELECT} ${where} ORDER BY updated_at DESC`, ...params).map(toNoteView);
}

/** 新建随手记；组织归属由 resolveRecordOrg 解析（成员/管理者写自己的组织，管理员取请求里的 orgId） */
export function createNoteRecord(user: User, body: Record<string, unknown>): RecordResult<Record<string, unknown>> {
  const content = String(body.content ?? "").trim();
  if (!content) return failed("VALIDATION_ERROR", "笔记内容不能为空", 400);
  const org = resolveRecordOrg(user, body.orgId);
  if (!org.ok) return org;
  const stamp = now();
  const id = randomUUID();
  // 置顶只在 PATCH /api/notes/:id 里改（旧实现的 POST 同样忽略 isPinned，载荷保持不变）
  run(
    db(),
    "INSERT INTO notes(id,org_id,content,is_pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    id,
    org.orgId,
    content,
    0,
    stamp,
    stamp,
  );
  const created = locateNote(user, id);
  if (!created) return failed("INTERNAL", "创建随手记失败", 500);
  return done(created, 201);
}

/** 更新随手记：不存在或跨组织都返回 404（同一个响应，不泄露资源是否存在） */
export function updateNoteRecord(user: User, id: string, body: Record<string, unknown>): RecordResult<Record<string, unknown>> {
  const current = locateNote(user, id);
  if (!current) return notFoundResult();
  run(
    db(),
    "UPDATE notes SET content=?,is_pinned=?,updated_at=? WHERE id=?",
    String(body.content ?? current.content),
    body.isPinned === undefined ? Number(current.isPinned) : body.isPinned ? 1 : 0,
    now(),
    id,
  );
  const updated = locateNote(user, id);
  if (!updated) return notFoundResult();
  return done(updated);
}

/** 删除随手记：不存在或跨组织都返回 404（旧实现「不存在也回 200」会让跨组织请求与不存在可区分） */
export function deleteNoteRecord(user: User, id: string): RecordResult<null> {
  if (!locateNote(user, id)) return notFoundResult();
  run(db(), "DELETE FROM notes WHERE id=?", id);
  return done(null);
}
