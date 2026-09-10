import { randomUUID } from "node:crypto";
import { db, now, rows, run, type User } from "./db.server";
import {
  done,
  failed,
  FILE_SELECT,
  locateFile,
  notFoundResult,
  recordClauses,
  resolveRecordOrg,
  toFileView,
  type RecordResult,
} from "./records.server";

/**
 * 重要文件域共享逻辑：页面 loader/action 与 /api/files* 资源路由共用（字段别名与旧实现逐字一致）。
 *
 * 组织隔离见 app/lib/records.server.ts：列表按 `recordClauses(user)` 过滤（外加搜索与分类条件），
 * 写入显式带 `org_id`（迁移 009 起是 NOT NULL），按 id 的单条操作先判定组织边界。
 * 权限上「文件库」只对管理员与组织管理者开放（§4），角色门槛留在各自的入口（requireManager）。
 */
export function listFiles(user: User, search: string, category: string, orgFilter?: string | null): Record<string, unknown>[] {
  const { clauses, params } = recordClauses(user);
  // 管理员的组织筛选器（D-28）。非管理员带上别人的组织也只会得到空列表，不会越权。
  if (orgFilter) {
    clauses.push("org_id=?");
    params.push(orgFilter);
  }
  if (search) {
    clauses.push("(name LIKE ? OR file_path LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    clauses.push("category=?");
    params.push(category);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return rows(db(), `${FILE_SELECT} ${where} ORDER BY COALESCE(last_used_at,updated_at) DESC`, ...params).map(toFileView);
}

/** 新增文件索引；组织归属由 resolveRecordOrg 解析（成员/管理者写自己的组织，管理员取请求里的 orgId） */
export function createFileRecord(
  user: User,
  input: { name: string; filePath: string; category: string; orgId?: unknown },
): RecordResult<Record<string, unknown>> {
  const name = input.name.trim();
  const filePath = input.filePath.trim();
  if (!name || !filePath) return failed("VALIDATION_ERROR", "文件名称和路径不能为空", 400);
  const org = resolveRecordOrg(user, input.orgId);
  if (!org.ok) return org;
  const stamp = now();
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO important_files(id,org_id,name,file_path,category,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    id,
    org.orgId,
    name,
    filePath,
    input.category.trim(),
    null,
    stamp,
    stamp,
  );
  const created = locateFile(user, id);
  if (!created) return failed("INTERNAL", "新增文件索引失败", 500);
  return done(created, 201);
}

/** 编辑文件索引（名称 / 路径 / 分类）：不存在或跨组织都返回 404 */
export function updateFileRecord(
  user: User,
  id: string,
  input: { name?: unknown; filePath?: unknown; category?: unknown },
): RecordResult<Record<string, unknown>> {
  const current = locateFile(user, id);
  if (!current) return notFoundResult();
  const name = String(input.name ?? current.name).trim();
  const filePath = String(input.filePath ?? current.filePath).trim();
  if (!name || !filePath) return failed("VALIDATION_ERROR", "文件名称和路径不能为空", 400);
  run(
    db(),
    "UPDATE important_files SET name=?,file_path=?,category=?,updated_at=? WHERE id=?",
    name,
    filePath,
    String(input.category ?? current.category).trim(),
    now(),
    id,
  );
  const updated = locateFile(user, id);
  if (!updated) return notFoundResult();
  return done(updated);
}

/** 删除文件索引：不存在或跨组织都返回 404（旧实现「不存在也回 200」会让跨组织请求与不存在可区分） */
export function deleteFileRecord(user: User, id: string): RecordResult<null> {
  if (!locateFile(user, id)) return notFoundResult();
  run(db(), "DELETE FROM important_files WHERE id=?", id);
  return done(null);
}

/** 标记最近使用并返回最新行（不存在或跨组织都返回 404） */
export function markFileUsedRecord(user: User, id: string): RecordResult<Record<string, unknown>> {
  if (!locateFile(user, id)) return notFoundResult();
  const stamp = now();
  run(db(), "UPDATE important_files SET last_used_at=?,updated_at=? WHERE id=?", stamp, stamp, id);
  const updated = locateFile(user, id);
  if (!updated) return notFoundResult();
  return done(updated);
}
