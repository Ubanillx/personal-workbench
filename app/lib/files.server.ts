import { randomUUID } from "node:crypto";
import { db, now, rows, run, type User } from "./db.server";
import { compareZh, type Paged, type Paging, type SortSpec } from "./paging";
import { orderOf, pageOf, type SortableColumns } from "./paging.server";
import {
  denialFailure,
  done,
  failed,
  FILE_FORBIDDEN_MESSAGE,
  FILE_SELECT,
  FILE_SOURCE,
  locateFile,
  notFoundResult,
  recordClauses,
  resolveRecordOrg,
  rowAccess,
  toFileView,
  type LocatedRecord,
  type RecordResult,
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

/**
 * `/files` 的列表筛选条件（与 URL 参数一一对应）。
 *
 * `search` / `category` 原来就在服务端；`visibility` 原来是**列上的筛选下拉**（只作用于当前页），
 * 服务端分页后它必须落到 SQL，入口也搬到工具栏（同一字段只留一套说法）。
 */
export type FileFilters = {
  search?: string | undefined;
  category?: string | undefined;
  /** 可见范围：全部 `all` / 组织 `org` / 仅自己 `private` */
  visibility?: string | undefined;
  orgFilter?: string | null | undefined;
};

/**
 * 筛选条件 → WHERE。`listFiles()`（`/api/files` 要的全量）、`fileCategories()` 与 `filesPage()` 共用这一份。
 */
function fileWhere(user: User, filters: FileFilters): { where: string; params: string[] } {
  const { clauses, params } = recordClauses(user);
  // 管理员的组织筛选器（D-28）。非管理员带上别人的组织也只会得到空列表，不会越权。
  if (filters.orgFilter) {
    clauses.push("org_id=?");
    params.push(filters.orgFilter);
  }
  const search = (filters.search ?? "").trim();
  if (search) {
    clauses.push("(name LIKE ? OR file_path LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (filters.category) {
    clauses.push("category=?");
    params.push(filters.category);
  }
  if (filters.visibility === "org" || filters.visibility === "private") {
    // 老数据的 `visibility` 是 NULL，按 org 处理（与 recordClauses / toFileView 的兜底口径一致）
    clauses.push(filters.visibility === "private" ? "visibility='private'" : "(visibility IS NULL OR visibility<>'private')");
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listFiles(user: User, search: string, category: string, orgFilter?: string | null): Record<string, unknown>[] {
  const { where, params } = fileWhere(user, { search, category, orgFilter });
  // ⚠️ `FILE_SELECT` 的 `owned` 占位符在最前，所以当前用户 id 必须打头
  return rows(db(), `${FILE_SELECT} ${where} ORDER BY COALESCE(last_used_at,updated_at) DESC`, user.id, ...params).map(toFileView);
}

/**
 * 分类候选：**不过滤**搜索与分类条件的全量分类（否则选了「报价」之后，下拉里其余分类会一起消失）。
 *
 * 原来它是「拉全量列表再在内存里去重」，服务端分页后没必要把整张表读进来——用 `DISTINCT` 只取这一列。
 * 排序沿用原来的 `localeCompare(..., "zh-Hans-CN")`（拼音序）。
 */
export function fileCategories(user: User, orgFilter?: string | null): string[] {
  const { where, params } = fileWhere(user, { orgFilter });
  return rows<{ category: unknown }>(db(), `SELECT DISTINCT category FROM important_files ${where}`, ...params)
    .map((row) => String(row.category ?? ""))
    .filter(Boolean)
    .toSorted(compareZh);
}

/** 重要文件的排序白名单（列 key 与 `/files` 列对应，`{dir}` 由方向替换，见 `orderOf`） */
export const FILE_SORTABLE: SortableColumns = {
  name: { column: "name" },
  category: { by: "category {dir}" },
  // 与默认次序一致：没有 last_used_at 的老行退回 updated_at（原 ORDER BY 就是这么写的）
  lastUsedAt: { by: "COALESCE(last_used_at,updated_at) {dir}" },
};

/** 默认排序：最近使用/更新在前（与改动前列表的数据序一致） */
export const DEFAULT_FILE_SORT: SortSpec = { key: "lastUsedAt", direction: "desc" };

/**
 * 文件列表的一页 + **当页**的可删除行。
 *
 * 逐条判权仍旧只有 `canDeleteFile()` 一处：这里把每行的判权字段（`rowAccess`）喂给它，
 * 结论跟着当页一起回给页面（页面不自己判角色，也不拿 `owned` 反推归属）。
 * `deletableIds` 只覆盖当页，是因为勾选与批量删除本来就只作用于当页。
 */
export function filesPage(
  user: User,
  filters: FileFilters,
  paging: Paging,
  sort: SortSpec,
): { page: Paged<Record<string, unknown>>; deletableIds: string[] } {
  const { where, params } = fileWhere(user, filters);
  const deletableIds: string[] = [];
  const page = pageOf<Record<string, unknown>>({
    database: db(),
    select: FILE_SELECT,
    source: FILE_SOURCE,
    // `FILE_SELECT` 的 `owned` 占位符只属于列清单：COUNT 查询不带它
    selectParams: [user.id],
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: FILE_SORTABLE, sort, tieBreak: "id", id: "id" }),
    map: (row) => {
      if (canDeleteFile(user, rowAccess(row))) deletableIds.push(String(row.id));
      return toFileView(row);
    },
  });
  return { page, deletableIds };
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
