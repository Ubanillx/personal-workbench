import { one } from "./db.server";
import { db } from "./db.server";

/** 待办 / 随手记 / 重要文件的单条查询：字段别名与旧实现逐字一致 */

export function findTodo(id: string): Record<string, unknown> | null {
  return one(
    db(),
    "SELECT id,content,todo_date AS todoDate,is_completed AS isCompleted,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM todos WHERE id=?",
    id,
  );
}

export function findNote(id: string): Record<string, unknown> | null {
  return one(db(), "SELECT id,content,is_pinned AS isPinned,created_at AS createdAt,updated_at AS updatedAt FROM notes WHERE id=?", id);
}

export function findFile(id: string): Record<string, unknown> | null {
  return one(
    db(),
    "SELECT id,name,file_path AS filePath,category,last_used_at AS lastUsedAt,created_at AS createdAt,updated_at AS updatedAt FROM important_files WHERE id=?",
    id,
  );
}
