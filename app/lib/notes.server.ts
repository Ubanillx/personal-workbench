import { randomUUID } from "node:crypto";
import { db, now, rows, run } from "./db.server";
import { findNote } from "./records.server";

/**
 * 随手记写入与查询：页面 loader/action 与 /api/notes* 共用同一份实现。
 * 页面目前只需要列表、新建、删除（旧 UI 没有编辑入口），PATCH 仍留在 API 路由里。
 */
export function listNotes(): Record<string, unknown>[] {
  return rows(
    db(),
    "SELECT id,content,is_pinned AS isPinned,created_at AS createdAt,updated_at AS updatedAt FROM notes ORDER BY updated_at DESC",
  );
}

export function createNoteRecord(content: unknown): Record<string, unknown> | null {
  const trimmed = String(content ?? "").trim();
  if (!trimmed) return null;
  const stamp = now();
  const id = randomUUID();
  run(db(), "INSERT INTO notes(id,content,is_pinned,created_at,updated_at) VALUES(?,?,?,?,?)", id, trimmed, 0, stamp, stamp);
  return findNote(id);
}

export function deleteNoteRecord(id: string): void {
  run(db(), "DELETE FROM notes WHERE id=?", id);
}

export function updateNoteRecord(id: string, body: Record<string, unknown>): Record<string, unknown> | null {
  const current = findNote(id);
  if (!current) return null;
  run(
    db(),
    "UPDATE notes SET content=?,is_pinned=?,updated_at=? WHERE id=?",
    String(body.content ?? current.content),
    body.isPinned === undefined ? Number(current.isPinned) : body.isPinned ? 1 : 0,
    now(),
    id,
  );
  return findNote(id);
}
