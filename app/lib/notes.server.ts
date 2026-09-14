import { randomUUID } from "node:crypto";
import { db, now, rows, run, type User } from "./db.server";
import type { Paged, Paging, SortSpec } from "./paging";
import { likeTerm, orderOf, pageOf, type SortableColumns } from "./paging.server";
import {
  denialFailure,
  done,
  failed,
  locateNote,
  notFoundResult,
  personalClauses,
  RECORD_FORBIDDEN_MESSAGE,
  resolveRecordOrg,
  NOTE_SELECT,
  NOTE_SOURCE,
  toNoteView,
  type LocatedRecord,
  type RecordResult,
} from "./records.server";

/**
 * 随手记写入与查询：页面 loader/action 与 /api/notes* 共用同一份实现。
 * 页面目前只需要列表、新建、删除（旧 UI 没有编辑入口），PATCH 仍留在 API 路由里。
 *
 * **归属见 app/lib/records.server.ts（D-54）**：随手记是**本人数据**，列表按 `personalClauses(user)`
 * 过滤（`owner_id = 本人`，管理员也不例外），写入显式写 `owner_id`，按 id 的单条操作先判定归属边界
 * （跨组织 404 / 同组织但不是本人 403）。
 */

/** 无权（403）与不存在 / 跨组织（404）的映射只写在 records.server.ts，这里只做转手 */
function denied(located: LocatedRecord): RecordResult<never> | null {
  return located.deny ? denialFailure(located.deny, RECORD_FORBIDDEN_MESSAGE).failure : null;
}

/** `/notes` 的列表筛选条件（与 URL 参数一一对应） */
export type NoteFilters = {
  orgFilter?: string | null | undefined;
  /** 关键词：记录内容（纯字面匹配，与原来的 `includes()` 一致） */
  keyword?: string | undefined;
  /** 全部 `all` / 重点 `pinned` / 普通 `normal` */
  pin?: string | undefined;
};

/**
 * 筛选条件 → WHERE。`listNotes()`（`/api/notes` 要的全量）与 `notesPage()`（页面的一页）共用这一份。
 */
function noteWhere(user: User, filters: NoteFilters): { where: string; params: string[] } {
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
  if (filters.pin === "pinned") clauses.push("is_pinned=1");
  if (filters.pin === "normal") clauses.push("is_pinned=0");
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * 随手记列表（`/api/notes` 与概览页的「最近随手记」共用）。
 *
 * ⚠️ 这里的 `ORDER BY updated_at DESC` 是**接口冻结的次序**，契约 golden 盯着它：不要为了迁就页面
 * 的「置顶优先」（那是 `/notes` 页的默认排序，见 `notesPage()` 的 `NOTE_SORTABLE.pinned`）而改它。
 */
export function listNotes(user: User, orgFilter?: string | null): Record<string, unknown>[] {
  const { where, params } = noteWhere(user, { orgFilter });
  return rows(db(), `${NOTE_SELECT} ${where} ORDER BY updated_at DESC`, ...params).map(toNoteView);
}

/**
 * 随手记的排序白名单。
 *
 * `pinned` 不是某一列、而是**列表的默认次序**（重点置顶优先，其次最近更新）：
 * 原来它是页面上那次 `toSorted`，服务端分页后必须变成 SQL 的默认 ORDER BY，
 * 所以单独占一个 key 放进白名单——页面上没有这一列，也就永远不会亮出排序箭头。
 */
export const NOTE_SORTABLE: SortableColumns = {
  updatedAt: { by: "updated_at {dir}" },
  pinned: { by: "is_pinned {dir}, updated_at DESC" },
};

/** 默认排序：重点优先、其次最近更新（与改动前 `toSorted` 的次序一致） */
export const DEFAULT_NOTE_SORT: SortSpec = { key: "pinned", direction: "desc" };

/** 随手记列表的一页（服务端筛选 + 排序 + 分页） */
export function notesPage(user: User, filters: NoteFilters, paging: Paging, sort: SortSpec): Paged<Record<string, unknown>> {
  const { where, params } = noteWhere(user, filters);
  return pageOf<Record<string, unknown>>({
    database: db(),
    select: NOTE_SELECT,
    source: NOTE_SOURCE,
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: NOTE_SORTABLE, sort, tieBreak: "id", id: "id" }),
    map: toNoteView,
  });
}

/**
 * 新建随手记；组织归属由 `resolveRecordOrg` 解析（成员/管理者写自己的组织，管理员取请求里的 orgId），
 * 归属人**恒为当前账号**——随手记没有「替别人记」这回事，请求里的 ownerId 一律忽略。
 */
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
    "INSERT INTO notes(id,org_id,owner_id,content,is_pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id,
    org.orgId,
    user.id,
    content,
    0,
    stamp,
    stamp,
  );
  const created = locateNote(user, id);
  if (!created.view) return denied(created) ?? failed("INTERNAL", "创建随手记失败", 500);
  return done(created.view, 201);
}

/** 更新随手记：不存在 / 跨组织 404，同组织但不是本人 403 */
export function updateNoteRecord(user: User, id: string, body: Record<string, unknown>): RecordResult<Record<string, unknown>> {
  const located = locateNote(user, id);
  if (!located.view) return denied(located) ?? notFoundResult();
  const current = located.view;
  run(
    db(),
    "UPDATE notes SET content=?,is_pinned=?,updated_at=? WHERE id=?",
    String(body.content ?? current.content),
    body.isPinned === undefined ? Number(current.isPinned) : body.isPinned ? 1 : 0,
    now(),
    id,
  );
  const updated = locateNote(user, id);
  if (!updated.view) return denied(updated) ?? notFoundResult();
  return done(updated.view);
}

/** 删除随手记：不存在 / 跨组织 404，同组织但不是本人 403 */
export function deleteNoteRecord(user: User, id: string): RecordResult<null> {
  const located = locateNote(user, id);
  if (!located.view) return denied(located) ?? notFoundResult();
  run(db(), "DELETE FROM notes WHERE id=?", id);
  return done(null);
}
