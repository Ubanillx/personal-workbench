import { randomUUID } from "node:crypto";
import { db, now, rows, run, type User } from "./db.server";
import {
  denialFailure,
  done,
  failed,
  FILE_FORBIDDEN_MESSAGE,
  FILE_SELECT,
  locateFile,
  notFoundResult,
  recordClauses,
  resolveRecordOrg,
  rowAccess,
  toFileView,
  type LocatedRecord,
  type RecordResult,
  type RowAccess,
} from "./records.server";

/**
 * 重要文件域共享逻辑：页面 loader/action 与 /api/files* 资源路由共用（字段别名与旧实现逐字一致）。
 *
 * 归属与权限见 app/lib/records.server.ts 与 docs/harness/ACCOUNTS_AND_ORGS.md §4 / §24（D-55）：
 * - **组织隔离**：列表按 `recordClauses(user)` 过滤（外加搜索与分类条件），写入显式带 `org_id`
 *   （迁移 009 起是 NOT NULL），按 id 的单条操作先判定组织边界（跨组织一律 404）；
 * - **可见范围（每行自己定）**：`visibility='org'`（默认）组织内所有人可见、可改、可下载；
 *   `visibility='private'`（个人文件）只有**创建人**与**本组织的全局管理员**看得见，可见即可改；
 * - **删除**：组织文件只给组织管理者与全局管理员；**个人文件额外允许创建人删自己的**
 *   （否则「自己建的私密文件自己删不掉」就成了死角）。
 */

/** 单条操作的失败 → 服务结果；403 与 404 的文案映射只写在 records.server.ts */
function denied(located: LocatedRecord): RecordResult<never> | null {
  if (located.deny) return denialFailure(located.deny, FILE_FORBIDDEN_MESSAGE).failure;
  return null;
}

/** 可见范围取值：只认这两个，其余（含 undefined）一律按 `org` —— 与迁移 018 的兜底口径一致 */
export type FileVisibility = "org" | "private";

export function readVisibility(value: unknown): FileVisibility {
  return value === "private" ? "private" : "org";
}

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
  // ⚠️ `FILE_SELECT` 的 `owned` 占位符在最前，所以当前用户 id 必须打头
  return rows(db(), `${FILE_SELECT} ${where} ORDER BY COALESCE(last_used_at,updated_at) DESC`, user.id, ...params).map(toFileView);
}

/**
 * 列表 + 每行的判权字段（页面专用）。
 *
 * 页面要按**逐条**规则渲染删除入口（D-55：创建人能删自己的个人文件），而 `listFiles()` 的载荷
 * 刻意不带 `owner_id`（那会变成页面可以拿来判权的输入）。这里把两者并一次返回，避免页面
 * 拿 `owned` 布尔值反推归属——那种写法只对「当前用户自己」成立，迟早被人复制到别处。
 */
export function listFilesWithAccess(
  user: User,
  search: string,
  category: string,
  orgFilter?: string | null,
): Array<{ view: Record<string, unknown>; access: RowAccess }> {
  const { clauses, params } = recordClauses(user);
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
  return rows<Record<string, unknown>>(
    db(),
    `${FILE_SELECT} ${where} ORDER BY COALESCE(last_used_at,updated_at) DESC`,
    user.id,
    ...params,
  ).map((row) => ({ view: toFileView(row), access: rowAccess(row) }));
}

/**
 * 新增文件索引；组织归属由 `resolveRecordOrg` 解析（成员/管理者写自己的组织，管理员取请求里的 orgId）。
 * **归属人恒为当前账号**：文件没有「替别人登记」这回事，请求里的 `ownerId` 一律忽略（D-55）。
 */
export function createFileRecord(
  user: User,
  input: { name: string; filePath: string; category: string; orgId?: unknown; visibility?: unknown },
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
    "INSERT INTO important_files(id,org_id,owner_id,visibility,name,file_path,category,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    org.orgId,
    user.id,
    readVisibility(input.visibility),
    name,
    filePath,
    input.category.trim(),
    null,
    stamp,
    stamp,
  );
  const created = locateFile(user, id);
  if (!created.view) return denied(created) ?? failed("INTERNAL", "新增文件索引失败", 500);
  return done(created.view, 201);
}

/**
 * 编辑文件索引（名称 / 路径 / 分类 / 可见范围）：不存在或跨组织 404，别人的个人文件 403。
 * **可见即可改**：能读到这条索引的人就能改它（与「能看见才改得动」同一口径）。
 * `visibility` 不带时保持原值——改名的请求不该顺手把可见范围改掉。
 */
export function updateFileRecord(
  user: User,
  id: string,
  input: { name?: unknown; filePath?: unknown; category?: unknown; visibility?: unknown },
): RecordResult<Record<string, unknown>> {
  const located = locateFile(user, id);
  if (!located.view) return denied(located) ?? notFoundResult();
  const current = located.view;
  const name = String(input.name ?? current.name).trim();
  const filePath = String(input.filePath ?? current.filePath).trim();
  if (!name || !filePath) return failed("VALIDATION_ERROR", "文件名称和路径不能为空", 400);
  run(
    db(),
    "UPDATE important_files SET name=?,file_path=?,category=?,visibility=?,updated_at=? WHERE id=?",
    name,
    filePath,
    String(input.category ?? current.category).trim(),
    input.visibility === undefined ? readVisibility(current.visibility) : readVisibility(input.visibility),
    now(),
    id,
  );
  const updated = locateFile(user, id);
  if (!updated.view) return denied(updated) ?? notFoundResult();
  return done(updated.view);
}

/**
 * 能否删除这条文件索引（D-54 + D-55）：全局管理员可删任意组织；
 * 组织管理者可删**本组织的公开文件**；**创建人可删自己的**（含自己的个人文件）；
 * 其余普通成员对**别人的公开文件**不可删。
 *
 * 「创建人可删自己的」是 D-55 顺带补上的死角：个人文件对别人不可见，
 * 若还要求组织管理者来删，用户就只能求人删掉自己的私密文件。
 */
export function canDeleteFile(user: User, file: { visibility: string | null; ownerId: string | null }): boolean {
  if (user.role === "admin") return true;
  if (file.ownerId && file.ownerId === user.id) return true;
  return user.role === "manager" && file.visibility !== "private";
}

/**
 * 删除文件索引：不存在 / 跨组织 404，无权 403。
 * 顺序是刻意的：先过组织边界与可见范围（跨组织连「能不能删」都不该知道），再判角色。
 */
export function deleteFileRecord(user: User, id: string): RecordResult<null> {
  const located = locateFile(user, id);
  if (!located.view) return denied(located) ?? notFoundResult();
  if (!canDeleteFile(user, located.access)) return failed("FORBIDDEN", "只有创建人、组织管理者或管理员可以删除重要文件", 403);
  run(db(), "DELETE FROM important_files WHERE id=?", id);
  return done(null);
}

/** 标记最近使用并返回最新行（不存在 / 跨组织 404，别人的个人文件 403） */
export function markFileUsedRecord(user: User, id: string): RecordResult<Record<string, unknown>> {
  const located = locateFile(user, id);
  if (!located.view) return denied(located) ?? notFoundResult();
  const stamp = now();
  run(db(), "UPDATE important_files SET last_used_at=?,updated_at=? WHERE id=?", stamp, stamp, id);
  const updated = locateFile(user, id);
  if (!updated.view) return denied(updated) ?? notFoundResult();
  return done(updated.view);
}
