import { randomUUID } from "node:crypto";
import type { JoinRequest, JoinRequestKind, Organization } from "../../shared/types/domain";
import { db, one, rows, run, now, type User } from "./db.server";
import { fail } from "./http.server";
import { createNotification } from "./notifications.server";
import type { Paged, Paging, SortSpec } from "./paging";
import { likeTerm, orderOf, pageOf, type SortableColumns } from "./paging.server";
import { notFound } from "./session.server";

/**
 * 组织、成员与入组/退组申请的全部业务规则。
 *
 * 不变量（docs/harness/ACCOUNTS_AND_ORGS.md §4）都在这里兜底：
 * 1. 跨组织访问 → 404（不暴露资源是否存在）
 * 2. 组织管理者不能改自己的角色，也不能把别人提升为 admin
 * 3. 组织里最后一名 manager 不能被停用、退出或降级
 * 4. admin 不能把自己降级
 * 5. 归档组织不能写入；成员登录后处于「未加入」状态
 * 6. 停用账号立即失去会话（由 sessionUser 的 u.is_active=1 保证）
 */

export type OrgFailure = { ok: false; response: Response };
export type OrgSuccess<T> = { ok: true; data: T };

/**
 * 组织列清单与 FROM 分开写：服务端分页的 `COUNT(*)` 只能用 FROM
 * （见 app/lib/paging.server.ts 的 `ListSource.source`），两者共用同一份列清单不会漂移。
 */
const ORG_COLUMNS = `id, name, description, status, created_by AS createdBy, created_at AS createdAt,
                           updated_at AS updatedAt, archived_at AS archivedAt`;
const ORG_SOURCE = `FROM organizations`;
const ORG_SELECT = `SELECT ${ORG_COLUMNS} ${ORG_SOURCE}`;

/** 组织的成员数：列表页用它做「成员数」列与排序键（子查询一次算完，不再逐行 countMembers） */
const MEMBER_COUNT_SQL = `(SELECT COUNT(*) FROM users m WHERE m.org_id = organizations.id) AS memberCount`;
/** 组织总览页专用：多带一列 memberCount。接口与单条查询的 `ORG_SELECT` 保持原样（契约冻结） */
const ORG_PAGE_SELECT = `SELECT ${ORG_COLUMNS}, ${MEMBER_COUNT_SQL} ${ORG_SOURCE}`;

const REQUEST_SELECT = `SELECT r.id AS id, r.kind AS kind, r.user_id AS userId, u.name AS userName, u.username AS username,
                               r.org_id AS orgId, o.name AS orgName, r.status AS status, r.message AS message,
                               r.created_at AS createdAt, r.decided_at AS decidedAt, r.decided_by AS decidedBy,
                               d.name AS decidedByName, r.decision_note AS decisionNote
                          FROM organization_join_requests r
                     LEFT JOIN users u ON u.id = r.user_id
                     LEFT JOIN organizations o ON o.id = r.org_id
                     LEFT JOIN users d ON d.id = r.decided_by`;

const MEMBER_COLUMNS = `u.id AS id, u.username AS username, u.email AS email, u.name AS name, u.role AS role,
                              u.org_id AS orgId, o.name AS orgName, u.is_active AS isActive,
                              u.must_change_password AS mustChangePassword, u.created_at AS createdAt`;
const MEMBER_SOURCE = `FROM users u
                    LEFT JOIN organizations o ON o.id = u.org_id`;
const MEMBER_SELECT = `SELECT ${MEMBER_COLUMNS} ${MEMBER_SOURCE}`;

function badRequest(message: string, code = "VALIDATION_ERROR"): OrgFailure {
  return { ok: false, response: fail(code, message, 400) };
}
function forbidden(message: string): OrgFailure {
  return { ok: false, response: fail("FORBIDDEN", message, 403) };
}

function name(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function orgName(orgId: string): string | null {
  return one<{ name: string }>(db(), "SELECT name FROM organizations WHERE id=?", orgId)?.name ?? null;
}

/* --------------------------------------------------------------- 组织 */

/** 组织列表：admin 看全部（含已归档）；manager 看全部（已归档只读）；member 只看 active */
export function listOrganizations(user: User): Organization[] {
  const includeArchived = user.role === "admin" || user.role === "manager";
  const found = rows<Organization>(db(), `${ORG_SELECT} ${includeArchived ? "" : "WHERE status='active'"} ORDER BY status, created_at`);
  const result: Organization[] = [];
  for (const org of found) result.push({ ...org, memberCount: countMembers(org.id) });
  return result;
}

/** 组织总览的筛选条件（与 URL 参数一一对应）：状态筛选原来在列头的筛选下拉里（只作用于当前页） */
export type OrgFilters = { status?: string | undefined };

/** 组织的排序白名单（列 key 与「组织总览」列对应；`{dir}` 由方向替换，见 `orderOf`） */
export const ORG_SORTABLE: SortableColumns = {
  name: { column: "name" },
  memberCount: { by: "memberCount {dir}" },
  createdAt: { by: "created_at {dir}" },
  // 默认次序（正常在前、其次创建时间）不是某一列的排序，单独占一个 key
  status: { by: "status {dir}, created_at" },
};

/** 默认排序：正常组织在前、其次创建时间（与改动前列表的数据序一致） */
export const DEFAULT_ORG_SORT: SortSpec = { key: "status", direction: "asc" };

/**
 * 组织总览的一页（服务端筛选 + 排序 + 分页）。
 * 可见范围与 `listOrganizations()` 逐条一致：admin/manager 看全部（含已解散），member 只看 active。
 */
export function organizationsPage(user: User, filters: OrgFilters, paging: Paging, sort: SortSpec): Paged<Organization> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (!(user.role === "admin" || user.role === "manager")) clauses.push("status='active'");
  if (filters.status === "active" || filters.status === "archived") {
    clauses.push("status=?");
    params.push(filters.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return pageOf<Organization>({
    database: db(),
    select: ORG_PAGE_SELECT,
    source: ORG_SOURCE,
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: ORG_SORTABLE, sort, tieBreak: "id", id: "id" }),
    // 组织只有这一张表，行本身就是页面要的形状（`memberCount` 由子查询带出来）
    map: (row) => row as unknown as Organization,
  });
}

export function findOrganization(orgId: string): Organization | null {
  return one<Organization>(db(), `${ORG_SELECT} WHERE id=?`, orgId);
}

function countMembers(orgId: string): number {
  const row = one<{ n: number }>(db(), "SELECT COUNT(*) AS n FROM users WHERE org_id=?", orgId);
  return row?.n ?? 0;
}

export function createOrganization(user: User, input: { name: unknown; description: unknown }): OrgSuccess<Organization> | OrgFailure {
  const orgNameValue = name(input.name);
  if (orgNameValue.length < 2 || orgNameValue.length > 40) return badRequest("组织名称需为 2-40 个字符");
  if (one(db(), "SELECT id FROM organizations WHERE name=?", orgNameValue)) return badRequest("组织名称已存在", "ORG_EXISTS");
  const id = randomUUID();
  const stamp = now();
  run(
    db(),
    "INSERT INTO organizations(id,name,description,status,created_by,created_at,updated_at,archived_at) VALUES(?,?,?,'active',?,?,?,NULL)",
    id,
    orgNameValue,
    name(input.description),
    user.id,
    stamp,
    stamp,
  );
  const created = findOrganization(id);
  return created ? { ok: true, data: created } : { ok: false, response: fail("INTERNAL", "创建组织失败", 500) };
}

export function updateOrganization(
  user: User,
  orgId: string,
  input: { name: unknown; description: unknown },
): OrgSuccess<Organization> | OrgFailure {
  const org = findOrganization(orgId);
  if (!org) return { ok: false, response: notFound() };
  const nextName = input.name === undefined ? org.name : name(input.name);
  if (nextName.length < 2 || nextName.length > 40) return badRequest("组织名称需为 2-40 个字符");
  const duplicate = one<{ id: string }>(db(), "SELECT id FROM organizations WHERE name=? AND id<>?", nextName, orgId);
  if (duplicate) return badRequest("组织名称已存在", "ORG_EXISTS");
  run(
    db(),
    "UPDATE organizations SET name=?, description=?, updated_at=? WHERE id=?",
    nextName,
    input.description === undefined ? org.description : name(input.description),
    now(),
    orgId,
  );
  const updated = findOrganization(orgId);
  return updated ? { ok: true, data: updated } : { ok: false, response: notFound() };
}

/**
 * 解散 = 归档（D-33）：组织标记 archived，成员全部退回「未加入」，待审批申请置为 cancelled。
 * 数据保留，管理员可 restore。
 */
export function archiveOrganization(user: User, orgId: string): OrgSuccess<Organization> | OrgFailure {
  const org = findOrganization(orgId);
  if (!org) return { ok: false, response: notFound() };
  if (org.status === "archived") return badRequest("组织已经处于解散状态", "ORG_ARCHIVED");
  const stamp = now();
  run(db(), "UPDATE users SET org_id=NULL, role='member', updated_at=? WHERE org_id=?", stamp, orgId);
  run(
    db(),
    "UPDATE organization_join_requests SET status='cancelled', decided_at=?, decided_by=?, decision_note=? WHERE org_id=? AND status='pending'",
    stamp,
    user.id,
    "组织已解散",
    orgId,
  );
  run(db(), "UPDATE organizations SET status='archived', archived_at=?, updated_at=? WHERE id=?", stamp, stamp, orgId);
  notifyOrgMembers(orgId, user.id, "org_removed", "组织已解散", `组织「${org.name}」已被解散，你的账号已退回未加入状态`);
  const updated = findOrganization(orgId);
  return updated ? { ok: true, data: updated } : { ok: false, response: notFound() };
}

export function restoreOrganization(user: User, orgId: string): OrgSuccess<Organization> | OrgFailure {
  const org = findOrganization(orgId);
  if (!org) return { ok: false, response: notFound() };
  if (org.status === "active") return badRequest("组织未被解散", "ORG_ACTIVE");
  run(db(), "UPDATE organizations SET status='active', archived_at=NULL, updated_at=? WHERE id=?", now(), orgId);
  const updated = findOrganization(orgId);
  return updated ? { ok: true, data: updated } : { ok: false, response: notFound() };
}

/* --------------------------------------------------------------- 成员 */

export function listMembers(orgId: string): Record<string, unknown>[] {
  return rows(db(), `${MEMBER_SELECT} WHERE u.org_id=? ORDER BY CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, u.name`, orgId);
}

export function listAllAccounts(): Record<string, unknown>[] {
  return rows(db(), `${MEMBER_SELECT} ORDER BY u.org_id IS NOT NULL, o.name, u.name`);
}

/* -------------------------------- 成员 / 账号列表的分页（设置页的两个 Tab 共用一套筛选条件） */

/**
 * 成员表（某个组织）与账号总览（全局）共用的筛选条件，与 URL 参数一一对应。
 *
 * 关键词、角色、启用状态原来都是**组件里的本地 state**（在浏览器里 filter 当前页），
 * 服务端分页后必须落到 SQL：否则「共 40 个」而每页只剩筛完的两三个。
 */
export type AccountFilters = {
  /** 关键词：姓名 / 用户名 / 邮箱（原实现是把三者拼起来做 `includes`，这里等价地 LIKE 三列） */
  keyword?: string | undefined;
  /** 全部 `all` / `admin` / `manager` / `member` */
  role?: string | undefined;
  /** 全部 `all` / 启用 `active` / 停用 `inactive` */
  state?: string | undefined;
  /** 账号总览的范围：全部 `all` / 未加入任何组织 `none` / 某个组织 id（成员列表用 `orgId` 参数，不看它） */
  scope?: string | undefined;
};

/**
 * 筛选条件 → WHERE。`orgId` 是成员列表的固定范围（本组织）；账号总览不传，
 * 改由 `scope` 表达「全部 / 未加入 / 某个组织」。
 */
function accountWhere(filters: AccountFilters, orgId?: string): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (orgId) {
    clauses.push("u.org_id=?");
    params.push(orgId);
  } else if (filters.scope === "none") {
    // 「未加入任何组织」：`org_id IS NULL`——管理员也落在这一类里（与改动前的 `account.orgId === null` 一致）
    clauses.push("u.org_id IS NULL");
  } else if (filters.scope && filters.scope !== "all") {
    clauses.push("u.org_id=?");
    params.push(filters.scope);
  }
  const keyword = (filters.keyword ?? "").trim();
  if (keyword) {
    const like = likeTerm(keyword);
    clauses.push(`(u.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  if (filters.role === "admin" || filters.role === "manager" || filters.role === "member") {
    clauses.push("u.role=?");
    params.push(filters.role);
  }
  if (filters.state === "active") clauses.push("u.is_active=1");
  if (filters.state === "inactive") clauses.push("u.is_active=0");
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** 成员表的排序白名单（列 key 与「成员列表」列对应，`{dir}` 由方向替换，见 `orderOf`） */
export const MEMBER_SORTABLE: SortableColumns = {
  name: { column: "u.name" },
  // 默认次序（组织管理者在前、其次姓名）不是某一列的排序，单独占一个 key
  role: { by: "CASE u.role WHEN 'manager' THEN 0 ELSE 1 END {dir}, u.name" },
};

/** 默认排序：组织管理者在前、其次姓名（与改动前的 `ORDER BY CASE ... , u.name` 一致） */
export const DEFAULT_MEMBER_SORT: SortSpec = { key: "role", direction: "asc" };

/** 成员列表的一页（本组织成员 + 服务端筛选/排序/分页） */
export function membersPage(orgId: string, filters: AccountFilters, paging: Paging, sort: SortSpec): Paged<Record<string, unknown>> {
  const { where, params } = accountWhere(filters, orgId);
  return pageOf<Record<string, unknown>>({
    database: db(),
    select: MEMBER_SELECT,
    source: MEMBER_SOURCE,
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: MEMBER_SORTABLE, sort, tieBreak: "u.id", id: "u.id" }),
    map: (row) => row,
  });
}

/** 账号总览的排序白名单（列 key 与「账号总览」列对应） */
export const ACCOUNT_SORTABLE: SortableColumns = {
  name: { column: "u.name" },
  // 默认次序：先按「有没有组织」，再按组织名、姓名（与改动前的 ORDER BY 一致）
  orgName: { by: "u.org_id IS NOT NULL {dir}, o.name, u.name" },
  role: { by: "u.role {dir}, u.name" },
};

/** 默认排序：未加入组织的在前、其次组织名与姓名（与改动前一致） */
export const DEFAULT_ACCOUNT_SORT: SortSpec = { key: "orgName", direction: "asc" };

/** 账号总览的一页（全局账号 + 服务端筛选/排序/分页） */
export function accountsPage(filters: AccountFilters, paging: Paging, sort: SortSpec): Paged<Record<string, unknown>> {
  const { where, params } = accountWhere(filters);
  return pageOf<Record<string, unknown>>({
    database: db(),
    select: MEMBER_SELECT,
    source: MEMBER_SOURCE,
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: ACCOUNT_SORTABLE, sort, tieBreak: "u.id", id: "u.id" }),
    map: (row) => row,
  });
}

/**
 * 账号总览的两个计数：分页之后页面手里没有全量账号，不能再去数数组长度。
 * - `total`：「全部账号（n）」这个下拉项
 * - `unassigned`：「未加入任何组织（n）」，口径与改动前一致（**不含管理员**）
 */
export function accountCounts(): { total: number; unassigned: number } {
  const row = one<{ total: number; unassigned: number }>(
    db(),
    `SELECT COUNT(*) AS total,
            IFNULL(SUM(CASE WHEN u.org_id IS NULL AND u.role<>'admin' THEN 1 ELSE 0 END),0) AS unassigned
       FROM users u`,
  );
  return { total: Number(row?.total ?? 0), unassigned: Number(row?.unassigned ?? 0) };
}

/** 「添加成员」的候选：无组织、启用中、且不是管理员（管理员不隶属组织） */
export function listMemberCandidates(): Record<string, unknown>[] {
  return rows(db(), `${MEMBER_SELECT} WHERE u.org_id IS NULL AND u.role<>'admin' AND u.is_active=1 ORDER BY u.name`);
}

/** 本组织可用 manager 数量（用于「最后一名管理者」保护） */
function managerCount(orgId: string): number {
  const row = one<{ n: number }>(db(), "SELECT COUNT(*) AS n FROM users WHERE org_id=? AND role='manager' AND is_active=1", orgId);
  return row?.n ?? 0;
}

export function setMemberActive(user: User, memberId: string, active: boolean): OrgSuccess<Record<string, unknown>> | OrgFailure {
  const member = one<Record<string, unknown>>(db(), `${MEMBER_SELECT} WHERE u.id=?`, memberId);
  if (!member) return { ok: false, response: notFound() };
  if (!checkManageTarget(user, member)) return { ok: false, response: notFound() };
  if (!active && String(member.role) === "manager" && managerCount(String(member.orgId)) <= 1) {
    return badRequest("这是本组织最后一名组织管理者，请先指定继任者", "LAST_MANAGER");
  }
  run(db(), "UPDATE users SET is_active=?, updated_at=? WHERE id=?", active ? 1 : 0, now(), memberId);
  if (!active) {
    const stamp = now();
    run(db(), "UPDATE access_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", stamp, memberId);
  }
  return { ok: true, data: { id: memberId, isActive: active } };
}

export function setMemberRole(user: User, memberId: string, role: unknown): OrgSuccess<Record<string, unknown>> | OrgFailure {
  if (role !== "manager" && role !== "member") return badRequest("角色只能是 manager 或 member");
  const member = one<Record<string, unknown>>(db(), `${MEMBER_SELECT} WHERE u.id=?`, memberId);
  if (!member) return { ok: false, response: notFound() };
  if (!checkManageTarget(user, member)) return { ok: false, response: notFound() };
  if (memberId === user.id) return forbidden("不能修改自己的角色");
  if (String(member.role) === "admin") return forbidden("不能修改管理员的角色");
  if (role === "member" && String(member.role) === "manager" && managerCount(String(member.orgId)) <= 1) {
    return badRequest("这是本组织最后一名组织管理者，请先指定继任者", "LAST_MANAGER");
  }
  run(db(), "UPDATE users SET role=?, updated_at=? WHERE id=?", role, now(), memberId);
  return { ok: true, data: { id: memberId, role } };
}

/** 移出组织：退回「未加入」，并记一条已批准的 leave 台账 */
export function removeMember(user: User, memberId: string): OrgSuccess<Record<string, unknown>> | OrgFailure {
  const member = one<Record<string, unknown>>(db(), `${MEMBER_SELECT} WHERE u.id=?`, memberId);
  if (!member) return { ok: false, response: notFound() };
  if (!checkManageTarget(user, member)) return { ok: false, response: notFound() };
  const orgId = member.orgId === null || member.orgId === undefined ? null : String(member.orgId);
  if (!orgId) return badRequest("该账号当前不属于任何组织");
  if (String(member.role) === "manager" && managerCount(orgId) <= 1) {
    return badRequest("这是本组织最后一名组织管理者，请先指定继任者", "LAST_MANAGER");
  }
  const stamp = now();
  run(db(), "UPDATE users SET org_id=NULL, role='member', updated_at=? WHERE id=?", stamp, memberId);
  run(
    db(),
    "INSERT INTO organization_join_requests(id,kind,user_id,org_id,status,message,created_at,decided_at,decided_by,decision_note) VALUES(?,?,?,?,?,?,?,?,?,?)",
    randomUUID(),
    "leave",
    memberId,
    orgId,
    "approved",
    "",
    stamp,
    stamp,
    user.id,
    "被管理者移出组织",
  );
  notify(memberId, user.id, orgId, "org_removed", "你已被移出组织", `你已被移出组织「${orgName(orgId) ?? ""}」`);
  return { ok: true, data: { id: memberId, orgId: null } };
}

/** 目标成员是否归当前管理者管：admin 管所有人；manager 只管本组织成员 */
function checkManageTarget(user: User, member: Record<string, unknown>): boolean {
  if (user.role === "admin") return true;
  if (user.role !== "manager") return false;
  return member.orgId !== null && member.orgId !== undefined && String(member.orgId) === user.orgId;
}

/** 直接把一个尚无组织的账号拉进本组织（D-31），记一条已批准的 invite 台账并发通知 */
export function inviteMember(user: User, orgId: string, accountId: string): OrgSuccess<Record<string, unknown>> | OrgFailure {
  const org = findOrganization(orgId);
  if (!org) return { ok: false, response: notFound() };
  if (org.status !== "active") return badRequest("组织已解散，不能加入新成员", "ORG_ARCHIVED");
  const account = one<Record<string, unknown>>(db(), `${MEMBER_SELECT} WHERE u.id=?`, accountId);
  if (!account) return { ok: false, response: notFound() };
  if (account.orgId !== null && account.orgId !== undefined) return badRequest("该账号已经属于某个组织", "ALREADY_IN_ORG");
  if (String(account.role) === "admin") return badRequest("管理员不隶属组织", "ADMIN_NO_ORG");
  if (Number(account.isActive) !== 1) return badRequest("该账号已被停用", "ACCOUNT_DISABLED");
  const stamp = now();
  run(db(), "UPDATE users SET org_id=?, updated_at=? WHERE id=?", orgId, stamp, accountId);
  run(
    db(),
    "INSERT INTO organization_join_requests(id,kind,user_id,org_id,status,message,created_at,decided_at,decided_by,decision_note) VALUES(?,?,?,?,?,?,?,?,?,?)",
    randomUUID(),
    "invite",
    accountId,
    orgId,
    "approved",
    "",
    stamp,
    stamp,
    user.id,
    "由管理者直接加入",
  );
  notify(accountId, user.id, orgId, "org_invited", "你已加入组织", `你已被加入组织「${org.name}」`);
  return { ok: true, data: { id: accountId, orgId } };
}

/* --------------------------------------------------------------- 申请 */

export function listJoinRequests(user: User, options: { status?: string; orgId?: string } = {}): JoinRequest[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (user.role === "admin") {
    if (options.orgId) {
      clauses.push("r.org_id=?");
      params.push(options.orgId);
    }
  } else if (user.role === "manager") {
    // 管理者看本组织的申请，外加自己提出的申请
    clauses.push("(r.org_id=? OR r.user_id=?)");
    params.push(user.orgId ?? "", user.id);
  } else {
    clauses.push("r.user_id=?");
    params.push(user.id);
  }
  if (options.status) {
    clauses.push("r.status=?");
    params.push(options.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return rows<JoinRequest>(db(), `${REQUEST_SELECT} ${where} ORDER BY r.created_at DESC LIMIT 200`, ...params);
}

export function pendingRequestCount(user: User): number {
  const row = one<{ n: number }>(
    db(),
    "SELECT COUNT(*) AS n FROM organization_join_requests WHERE user_id=? AND status='pending'",
    user.id,
  );
  return row?.n ?? 0;
}

/** 提交入组申请：无组织用户；同时只能有一个待审批申请（D-30） */
export function createJoinRequest(user: User, orgId: string, message: unknown): OrgSuccess<JoinRequest> | OrgFailure {
  if (user.role === "admin") return badRequest("管理员不隶属组织", "ADMIN_NO_ORG");
  if (user.orgId) return badRequest("你已经属于某个组织", "ALREADY_IN_ORG");
  const org = findOrganization(orgId);
  if (!org) return { ok: false, response: notFound() };
  if (org.status !== "active") return badRequest("组织已解散，不能申请加入", "ORG_ARCHIVED");
  if (pendingRequestCount(user) > 0) return badRequest("你已经有一个待审批的申请，请先等待处理或撤回", "REQUEST_EXISTS");
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO organization_join_requests(id,kind,user_id,org_id,status,message,created_at,decided_at,decided_by,decision_note) VALUES(?,?,?,?,'pending',?,?,NULL,NULL,'')",
    id,
    "join",
    user.id,
    orgId,
    name(message),
    now(),
  );
  return { ok: true, data: one<JoinRequest>(db(), `${REQUEST_SELECT} WHERE r.id=?`, id) as JoinRequest };
}

/** 申请退出：需要管理者批准（D-32）；最后一名管理者必须先指定继任者 */
export function createLeaveRequest(user: User, message: unknown): OrgSuccess<JoinRequest> | OrgFailure {
  if (user.role === "admin") return badRequest("管理员不隶属组织", "ADMIN_NO_ORG");
  if (!user.orgId) return badRequest("你当前不属于任何组织", "NO_ORG");
  if (user.role === "manager" && managerCount(user.orgId) <= 1) {
    return badRequest("你是本组织最后一名组织管理者，请先指定继任者再申请退出", "LAST_MANAGER");
  }
  if (pendingRequestCount(user) > 0) return badRequest("你已经有一个待审批的申请，请先等待处理或撤回", "REQUEST_EXISTS");
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO organization_join_requests(id,kind,user_id,org_id,status,message,created_at,decided_at,decided_by,decision_note) VALUES(?,?,?,?,'pending',?,?,NULL,NULL,'')",
    id,
    "leave",
    user.id,
    user.orgId,
    name(message),
    now(),
  );
  return { ok: true, data: one<JoinRequest>(db(), `${REQUEST_SELECT} WHERE r.id=?`, id) as JoinRequest };
}

/** 撤回自己的待审批申请 */
export function cancelJoinRequest(user: User, requestId: string): OrgSuccess<Record<string, unknown>> | OrgFailure {
  const request = one<{ id: string; userId: string; status: string }>(
    db(),
    "SELECT id, user_id AS userId, status FROM organization_join_requests WHERE id=?",
    requestId,
  );
  if (!request || request.userId !== user.id) return { ok: false, response: notFound() };
  if (request.status !== "pending") return badRequest("只有待审批的申请可以撤回", "REQUEST_DECIDED");
  run(db(), "UPDATE organization_join_requests SET status='cancelled', decided_at=? WHERE id=?", now(), requestId);
  return { ok: true, data: { id: requestId, status: "cancelled" } };
}

/** 审批（通过与拒绝都走这里；kind 决定是入组还是退组） */
export function decideJoinRequest(user: User, requestId: string, approve: boolean, note: unknown): OrgSuccess<JoinRequest> | OrgFailure {
  const request = one<{ id: string; kind: JoinRequestKind; userId: string; orgId: string; status: string }>(
    db(),
    "SELECT id, kind, user_id AS userId, org_id AS orgId, status FROM organization_join_requests WHERE id=?",
    requestId,
  );
  if (!request) return { ok: false, response: notFound() };
  if (user.role !== "admin" && (user.role !== "manager" || user.orgId !== request.orgId)) {
    return { ok: false, response: notFound() };
  }
  if (request.status !== "pending") return badRequest("该申请已经处理过了", "REQUEST_DECIDED");

  const stamp = now();
  if (approve) {
    if (request.kind === "join") {
      const account = one<{ orgId: string | null; isActive: number }>(
        db(),
        "SELECT org_id AS orgId, is_active AS isActive FROM users WHERE id=?",
        request.userId,
      );
      if (!account) return { ok: false, response: notFound() };
      if (account.orgId) return badRequest("该账号已经属于某个组织", "ALREADY_IN_ORG");
      if (account.isActive !== 1) return badRequest("该账号已被停用", "ACCOUNT_DISABLED");
      run(db(), "UPDATE users SET org_id=?, updated_at=? WHERE id=?", request.orgId, stamp, request.userId);
    } else if (request.kind === "leave") {
      run(db(), "UPDATE users SET org_id=NULL, role='member', updated_at=? WHERE id=?", stamp, request.userId);
    }
  }
  run(
    db(),
    "UPDATE organization_join_requests SET status=?, decided_at=?, decided_by=?, decision_note=? WHERE id=?",
    approve ? "approved" : "rejected",
    stamp,
    user.id,
    name(note),
    requestId,
  );

  // 入组通过后自动把该用户其他待审批申请作废（一人只能进一个组织）
  if (approve && request.kind === "join") {
    run(
      db(),
      "UPDATE organization_join_requests SET status='cancelled', decided_at=?, decision_note=? WHERE user_id=? AND status='pending' AND id<>?",
      stamp,
      "已加入其他组织",
      request.userId,
      requestId,
    );
    notify(
      request.userId,
      user.id,
      request.orgId,
      "org_join_approved",
      "入组申请已通过",
      `你已加入组织「${orgName(request.orgId) ?? ""}」`,
    );
  } else if (!approve && request.kind === "join") {
    notify(request.userId, user.id, request.orgId, "org_join_rejected", "入组申请未通过", name(note) || "申请未通过，可重新选择组织申请");
  }

  return { ok: true, data: one<JoinRequest>(db(), `${REQUEST_SELECT} WHERE r.id=?`, requestId) as JoinRequest };
}

/* --------------------------------------------------------------- 通知 */

function notify(recipientId: string, actorId: string, orgId: string, eventType: string, title: string, message: string): void {
  createNotification(db(), { recipientId, actorId, eventType, title, message });
  void orgId;
}

function notifyOrgMembers(orgId: string, actorId: string, eventType: string, title: string, message: string): void {
  for (const member of rows<{ id: string }>(db(), "SELECT id FROM users WHERE org_id=?", orgId)) {
    notify(member.id, actorId, orgId, eventType, title, message);
  }
}
