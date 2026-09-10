import { randomUUID } from "node:crypto";
import { db, now, rows, run } from "./db.server";
import { findFile } from "./records.server";

/** 重要文件域共享逻辑：页面 loader/action 与 /api/files* 资源路由共用（SQL 与旧实现逐字一致） */

export function listFiles(search: string, category: string): Record<string, unknown>[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (search) {
    conditions.push("(name LIKE ? OR file_path LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    conditions.push("category=?");
    params.push(category);
  }
  return rows(
    db(),
    `SELECT id,name,file_path AS filePath,category,last_used_at AS lastUsedAt,created_at AS createdAt,updated_at AS updatedAt FROM important_files ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY COALESCE(last_used_at,updated_at) DESC`,
    ...params,
  );
}

/** 返回 null 表示字段校验失败（调用方负责回 400 或表单错误） */
export function createFileRecord(input: { name: string; filePath: string; category: string }): Record<string, unknown> | null {
  const name = input.name.trim();
  const filePath = input.filePath.trim();
  if (!name || !filePath) return null;
  const stamp = now();
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO important_files(id,name,file_path,category,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id,
    name,
    filePath,
    input.category.trim(),
    null,
    stamp,
    stamp,
  );
  return findFile(id);
}

export function deleteFileRecord(id: string): void {
  run(db(), "DELETE FROM important_files WHERE id=?", id);
}

export function fileExists(id: string): boolean {
  return Boolean(findFile(id));
}

export function markFileUsedRecord(id: string): void {
  run(db(), "UPDATE important_files SET last_used_at=?,updated_at=? WHERE id=?", now(), now(), id);
}
