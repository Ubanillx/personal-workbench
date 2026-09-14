import { randomUUID } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Report, ReportDocType, ReportFile, ReportStatus } from "../../shared/types/domain";
import { date, db, now, one, rows, run, USER_SELECT, toUser, type User } from "./db.server";
import { fail } from "./http.server";
import { createNotification } from "./notifications.server";
import {
  ReportStorageError,
  isRemoteStoredName,
  openReportDownload,
  reportStorageCode,
  reportStorageMessage,
  reportStorageStatus,
  uploadReportFile,
} from "./report-storage.server";
import { assertOrgAccess, assertOrgManage, orgScope } from "./session.server";
import type { Paged, Paging, SortSpec } from "./paging";
import { orderOf, pageOf, type SortableColumns } from "./paging.server";

/**
 * 周报域：列表 / 详情 / 建单 / 重传 / 审批 / 退回与文件下载的**唯一实现**，
 * API 资源路由与页面 loader 共用同一份（与任务域 app/lib/task-service.server.ts 同一结构）。
 * 状态码、错误码与中文文案沿用旧 server/src/routes/report.ts 的实现，不要"顺手优化"。
 *
 * 组织隔离（docs/harness/ACCOUNTS_AND_ORGS.md §4、§14.2）全部收敛在本文件：
 * - 读列表：`reportVisibilityClauses(user)` 产出组织条件，绝不散落在各个查询里；
 * - 读单条：`findReportWithOrg` 先取出周报与它的 `org_id`，再用 `assertOrgAccess` 判定，
 *   「不存在 / 跨组织」返回同样的 404（§4 不变式 1，不泄露资源是否存在）；
 * - **可见范围是「组织内全可见」**（D-54）：同一组织的成员互相看得到彼此交的周报，
 *   普通成员只是**不能改别人的**（重传与审批各自另有门槛）；
 * - 写入：`INSERT` 显式写 `weekly_reports.org_id`（迁移 009 起是 NOT NULL）；
 * - `report_files` 没有 `org_id`，一律经 `report_id` 先过周报的组织边界（§14.2 的间接表规则）。
 *
 * 存储与归属（D-46，见 docs/harness/REPORTS_WEBDAV.md）：
 * - **归属人恒为提交者本人**：`ownerId` 不再从表单读取，代传（管理者代本组织成员提交）已取消，
 *   管理员不参与提交（403）；正文落点由 `report-storage.server.ts` 按
 *   `<上传根目录>/<用户名>/<起止日期>/<文件名>` 写到 NAS；
 * - 本文件里**没有任何本地磁盘读写**了：老记录的本地读路径只在下载路由里保留一个兼容分支。
 */

/* ------------------------------------------------------------------ 结果与载荷 */

/** 与任务域 task-service.server.ts 的 ServiceResult 同形：路由用 ok/fail 直接落响应信封 */
export type ServiceResult<T> = { ok: true; data: T; status: number } | { ok: false; code: string; message: string; status: number };

const done = <T>(data: T, status = 200): ServiceResult<T> => ({ ok: true, data, status });
const failed = (code: string, message: string, status: number): ServiceResult<never> => ({ ok: false, code, message, status });

/** 与 session.notFound() 同一信封：跨组织与「不存在」必须给出完全一样的响应 */
const notFoundResult = (): ServiceResult<never> => failed("NOT_FOUND", "未找到该资源", 404);

/** 周报载荷：与旧 shared/types/domain.ts 的 Report 同形（`org_id` 不进载荷） */
export type ReportView = Report;

/** 周报 + 它所属的组织（组织只用于隔离判定，不对外暴露） */
export type ScopedReport = { report: ReportView; orgId: string };

/** 周报的 JOIN 来源：服务端分页的 `COUNT(*)` 用它（不能带列清单，见 app/lib/paging.server.ts） */
const REPORT_SOURCE = `FROM weekly_reports r LEFT JOIN users u ON u.id=r.owner_id`;

/** 旧 report-repository 的列清单，仅补 `r.org_id AS orgId`（排在最后，不进载荷） */
const SELECT_REPORT = `SELECT r.id,r.owner_id AS ownerId,u.name AS ownerName,r.period_start AS periodStart,r.period_end AS periodEnd,r.doc_type AS docType,r.note,r.status,r.current_version AS currentVersion,r.uploaded_by AS uploadedBy,r.review_note AS reviewNote,r.created_at AS createdAt,r.updated_at AS updatedAt,r.submitted_at AS submittedAt,r.reviewed_at AS reviewedAt,r.returned_at AS returnedAt,r.org_id AS orgId ${REPORT_SOURCE}`;

const SELECT_REPORT_FILE = `SELECT id,report_id AS reportId,version,original_name AS originalName,stored_name AS storedName,size_bytes AS sizeBytes,ext,mime_type AS mimeType,uploaded_by AS uploadedBy,uploaded_at AS uploadedAt FROM report_files`;

/** 旧实现的字段别名与 undefined/null 行为逐字保留 */
function toReportView(row: Record<string, unknown>): ReportView {
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    ownerName: row.ownerName == null ? null : String(row.ownerName),
    periodStart: String(row.periodStart),
    periodEnd: String(row.periodEnd),
    docType: String(row.docType) as ReportDocType,
    note: String(row.note ?? ""),
    status: String(row.status) as ReportStatus,
    currentVersion: Number(row.currentVersion),
    uploadedBy: String(row.uploadedBy),
    reviewNote: row.reviewNote == null ? null : String(row.reviewNote),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    submittedAt: String(row.submittedAt),
    reviewedAt: row.reviewedAt == null ? null : String(row.reviewedAt),
    returnedAt: row.returnedAt == null ? null : String(row.returnedAt),
    files: listReportFiles(String(row.id)),
  };
}

/** 某份周报的全部文件版本（按版本号升序，与旧实现一致） */
function listReportFiles(reportId: string): ReportFile[] {
  return rows<ReportFile>(db(), `${SELECT_REPORT_FILE} WHERE report_id=? ORDER BY version`, reportId);
}

function findReportFile(reportId: string, version: number): ReportFile | null {
  return one<ReportFile>(db(), `${SELECT_REPORT_FILE} WHERE report_id=? AND version=?`, reportId, version);
}

function addReportFile(input: ReportFile): void {
  run(
    db(),
    "INSERT INTO report_files(id,report_id,version,original_name,stored_name,size_bytes,ext,mime_type,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    input.id,
    input.reportId,
    input.version,
    input.originalName,
    input.storedName,
    input.sizeBytes,
    input.ext,
    input.mimeType,
    input.uploadedBy,
    input.uploadedAt,
  );
}

/* ------------------------------------------------------------------ 读：组织范围 */

/**
 * 可见性 SQL 条件（§14.3 + D-54）。调用方把 clauses 用 AND 拼进自己的 WHERE，参数按顺序拼进 params，
 * 这样"漏加组织过滤"只可能发生在这一处，而不是散落在每个查询里。
 * - admin：全部组织（D-28 的合并视图）；
 * - manager / member：**本组织全部**周报——周报是组织内的汇报材料，同一组织的人互相看得见；
 *   编辑入口另有限制：普通成员只能重新上传**自己的**那份（见 `reuploadTarget` 与周报页的 `canResubmit`）；
 * - 未加入组织的账号（orgId 为 NULL，D-24）：不落在任何组织范围内，一条都看不到。
 */
export function reportVisibilityClauses(user: User): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const scope = orgScope(user);
  if (scope) {
    clauses.push("r.org_id=?");
    params.push(scope);
  } else if (user.role !== "admin") {
    clauses.push("1=0");
  }
  return { clauses, params };
}

/**
 * `/reports` 的列表筛选条件（与 URL 参数一一对应）。
 *
 * 这三个筛选原来**完全在浏览器里做**（`useMemo` 里 filter）；周报列表改成服务端分页后，
 * 它们必须落到 SQL，否则「共 12 份」而每页只显示筛完的两三份。
 */
export type ReportFilters = {
  /** 全部 `all` / 具体文档类型 */
  docType?: string | undefined;
  /** 全部 `all` / 具体审核状态 */
  status?: string | undefined;
  /** 全部 `all` / 具体归属人 id */
  ownerId?: string | undefined;
};

/** 筛选条件 → WHERE：`listReportsFor()`（`/api/reports` 要的全量）与 `reportsPage()` 共用这一份 */
function reportWhere(user: User, filters: ReportFilters): { where: string; params: string[] } {
  const { clauses, params } = reportVisibilityClauses(user);
  if (filters.docType && filters.docType !== "all") {
    clauses.push("r.doc_type=?");
    params.push(filters.docType);
  }
  if (filters.status && filters.status !== "all") {
    clauses.push("r.status=?");
    params.push(filters.status);
  }
  if (filters.ownerId && filters.ownerId !== "all") {
    clauses.push("r.owner_id=?");
    params.push(filters.ownerId);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** 周报列表：页面 loader 与 GET /api/reports 共用 */
export function listReportsFor(user: User): ReportView[] {
  const { where, params } = reportWhere(user, {});
  return rows(db(), `${SELECT_REPORT} ${where} ORDER BY r.updated_at DESC`, ...params).map(toReportView);
}

/** 周报的排序白名单：列 key 与 `/reports` 列的 `key` 对应（`{dir}` 由方向替换，见 `orderOf`） */
export const REPORT_SORTABLE: SortableColumns = {
  ownerName: { column: "u.name" },
  period: { by: "r.period_start {dir}" },
  updatedAt: { by: "r.updated_at {dir}" },
};

/** 默认排序：最近更新在前（与改动前列表的数据序一致） */
export const DEFAULT_REPORT_SORT: SortSpec = { key: "updatedAt", direction: "desc" };

/** 周报列表的一页（服务端筛选 + 排序 + 分页） */
export function reportsPage(user: User, filters: ReportFilters, paging: Paging, sort: SortSpec): Paged<ReportView> {
  const { where, params } = reportWhere(user, filters);
  return pageOf<ReportView>({
    database: db(),
    select: SELECT_REPORT,
    source: REPORT_SOURCE,
    where,
    params,
    paging,
    sort,
    order: orderOf({ sortable: REPORT_SORTABLE, sort, tieBreak: "r.id", id: "r.id" }),
    map: toReportView,
  });
}

/** 取周报及其所属组织：跨组织判定必须先拿到 `org_id`（§14.2） */
export function findReportWithOrg(id: string): ScopedReport | null {
  const row = one<Record<string, unknown>>(db(), `${SELECT_REPORT} WHERE r.id=?`, id);
  if (!row) return null;
  return { report: toReportView(row), orgId: String(row.orgId) };
}

/**
 * 存在性 + 组织边界：不存在与跨组织都返回 null，调用方一律回 404（§14.2 / §4 不变式 1）。
 *
 * D-54 起**没有第四道「可见性」判断了**：周报是组织内的汇报材料，跨过组织边界的都是本组织的人，
 * 一律可见。刻意不再保留一个恒真的 `canViewReport`——那只会让下一个人以为这里还有一层权限。
 * 「能不能改」由各自的写入口判：重传走 `reuploadTarget`（本人或本组织管理者），
 * 审批走路由的 `requireManager`。
 */
function locateReport(user: User, id: string): ScopedReport | null {
  const found = findReportWithOrg(id);
  if (!found) return null;
  if (assertOrgAccess(user, found.orgId)) return null;
  return found;
}

/** GET /api/reports/:id：跨组织一律 404 */
export function getReport(user: User, id: string): ServiceResult<ReportView> {
  const found = locateReport(user, id);
  return found ? done(found.report) : notFoundResult();
}

/**
 * 下载前的定位（GET /api/reports/:id/file/:version）：先过周报的组织边界，再取指定版本。
 * `report_files` 没有 `org_id`，只能经 `report_id` 关联校验，不能只按 id 取。
 */
export function getReportFile(user: User, id: string, version: number): ServiceResult<ReportFile> {
  const found = locateReport(user, id);
  if (!found) return notFoundResult();
  const file = Number.isInteger(version) && version > 0 ? findReportFile(found.report.id, version) : null;
  if (!file) return failed("NOT_FOUND", "文件版本不存在", 404);
  return done(file);
}

/* ------------------------------------------------------------------ 写：归属人 */

export type OwnerCheck = { valid: true; id: string; name: string; orgId: string } | { valid: false; message: string };

/**
 * 校验周报归属人（与任务域 `validateOwner` 同一口径）：
 * 账号必须启用、必须已加入组织（周报的 `org_id` 由归属人决定），
 * 且非管理员指派时必须是**本组织**的人。
 *
 * D-46 之后调用方只剩一个：`createReport` 拿**提交者自己**的 id 过一遍，
 * 确认「启用 + 有组织」这两个前提仍然成立（代传与跨组织指派已取消，`options.orgId` 只作防御保留）。
 */
export function validateReportOwner(id: string | null, options: { orgId?: string | null } = {}): OwnerCheck {
  if (!id) return { valid: false, message: "请选择归属人" };
  const row = one<Record<string, unknown>>(db(), `${USER_SELECT} WHERE u.id=?`, id);
  if (!row) return { valid: false, message: "归属人不存在" };
  const owner = toUser(row);
  if (!owner.isActive) return { valid: false, message: "归属人已停用" };
  if (!owner.orgId) return { valid: false, message: "归属人必须属于某个组织" };
  if (options.orgId && owner.orgId !== options.orgId) return { valid: false, message: "归属人必须属于本组织" };
  return { valid: true, id: owner.id, name: owner.name, orgId: owner.orgId };
}

/**
 * 周报页「归属人」**筛选器**的数据源：范围内的启用成员（admin 为全部组织，manager 为本组织）。
 *
 * D-46 之后它不再服务于上传表单（归属人恒为提交者本人、代传已取消），只用来筛列表。
 */
export function listReportOwnersFor(user: User): Array<{ id: string; name: string; orgName: string | null }> {
  const scope = orgScope(user);
  if (!scope && user.role !== "admin") return [];
  return rows<{ id: string; name: string; orgName: string | null }>(
    db(),
    `SELECT u.id AS id,u.name AS name,o.name AS orgName
       FROM users u LEFT JOIN organizations o ON o.id = u.org_id
      WHERE u.is_active=1 AND u.org_id IS NOT NULL ${scope ? "AND u.org_id=?" : ""}
      ORDER BY o.name, u.name`,
    ...(scope ? [scope] : []),
  );
}

/* ------------------------------------------------------------------ 写：建单 / 重传 / 审批 / 退回 */

/**
 * 把存储层的异常收成周报域的服务结果（消息由 `report-storage.server.ts` 翻译成人话）。
 * 单独抽出来是因为建单与重传两条写入路径都要用，且都必须**在写库之前**失败。
 */
function storageFailure(error: unknown): ServiceResult<never> {
  if (error instanceof ReportStorageError) return failed(error.code, error.message, error.status);
  return failed(reportStorageCode(error), reportStorageMessage(error), reportStorageStatus(error));
}

/**
 * POST /api/reports：字段校验 → 归属人（**恒为提交者本人**）→ 写 NAS → 写库 → 通知本组织管理者。
 *
 * D-46 起这里的归属人不再来自表单：谁登录谁就是归属人，`org_id` 就是他自己的组织。
 * 管理员是全局角色（没有组织），**不参与提交**——周报本来就是成员交、管理者审，
 * 因此管理员在这里直接 403，页面上也不给上传入口。
 */
export async function createReport(user: User, upload: Upload): Promise<ServiceResult<ReportView>> {
  if (user.role === "admin") return failed("FORBIDDEN", "管理员不提交周报，请由成员本人提交", 403);

  const fields = upload.fields;
  const periodStart = date(fields.periodStart);
  const periodEnd = date(fields.periodEnd);
  if (!periodStart || !periodEnd) return failed("VALIDATION_ERROR", "请填写周期开始和结束日期", 400);
  if (periodStart > periodEnd) return failed("VALIDATION_ERROR", "周期开始日期不能晚于结束日期", 400);
  const docType = normalizeDocType(fields.docType);
  if (!docType) return failed("VALIDATION_ERROR", "请选择文档类型", 400);
  const ext = extensionOf(upload.file.filename);
  if (!isAllowedExt(ext)) return failed("VALIDATION_ERROR", "仅支持 .xlsx / .xls / .docx / .doc 文件", 400);

  // 未加入组织的账号（D-24）没有可写入的组织（管理员已在上面的分支里挡掉）
  const orgId = user.orgId;
  if (!orgId) return failed("FORBIDDEN", "你还没有加入组织，无法提交周报", 403);
  const owner = validateReportOwner(user.id, { orgId });
  if (!owner.valid) return failed("VALIDATION_ERROR", owner.message, 400);

  const id = randomUUID();
  const stamp = now();
  const note = String(fields.note ?? "")
    .trim()
    .slice(0, 2000);
  // 先写远端再写库：远端失败时库里不留半条记录（远端成功、写库失败会留一个孤儿文件，见设计文档 §11.5）
  let stored: { storedName: string; size: number };
  try {
    stored = await uploadReportFile({
      orgId: owner.orgId,
      username: user.username,
      periodStart,
      periodEnd,
      originalName: upload.file.filename,
      version: 1,
      buffer: upload.file.buffer,
      contentType: upload.file.mimetype,
    });
  } catch (error) {
    return storageFailure(error);
  }
  run(
    db(),
    `INSERT INTO weekly_reports(id,org_id,owner_id,period_start,period_end,doc_type,note,status,current_version,
                                uploaded_by,review_note,created_at,updated_at,submitted_at,reviewed_at,returned_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    owner.orgId,
    owner.id,
    periodStart,
    periodEnd,
    docType,
    note,
    "submitted",
    1,
    user.id,
    null,
    stamp,
    stamp,
    stamp,
    null,
    null,
  );
  addReportFile({
    id: randomUUID(),
    reportId: id,
    version: 1,
    originalName: sanitizeName(upload.file.filename),
    storedName: stored.storedName,
    sizeBytes: stored.size,
    ext,
    mimeType: upload.file.mimetype || null,
    uploadedBy: user.id,
    uploadedAt: stamp,
  });
  if (user.role === "member") {
    notifyOrgManagers(owner.orgId, user.id, id, "report_submitted", "收到新周报", `${user.name} 提交了 ${periodStart}~${periodEnd} 的周报`);
  }
  const created = findReportWithOrg(id);
  if (!created) return failed("INTERNAL", "创建周报失败", 500);
  return done(created.report, 201);
}

/**
 * POST /api/reports/:id/approve —— 管理员或**本组织**组织管理者，仅"已提交"状态。
 * 谁有权审批由路由的 requireManager 把门，组织边界与状态在这里判定。
 */
export function approveReport(user: User, id: string, body: Record<string, unknown>): ServiceResult<ReportView> {
  const found = locateReport(user, id);
  if (!found) return notFoundResult();
  const report = found.report;
  if (report.status !== "submitted") return failed("INVALID_STATE", "只有已提交的周报才能通过", 400);

  const note = String(body.note ?? "")
    .trim()
    .slice(0, 2000);
  const stamp = now();
  run(
    db(),
    "UPDATE weekly_reports SET status='approved',review_note=?,reviewed_at=?,updated_at=? WHERE id=?",
    note || null,
    stamp,
    stamp,
    report.id,
  );
  notifyReport(
    report.ownerId,
    user.id,
    report.id,
    "report_approved",
    "周报已通过",
    `你的周报（${report.periodStart}~${report.periodEnd}）已通过`,
  );
  const updated = findReportWithOrg(report.id);
  if (!updated) return failed("INTERNAL", "周报更新失败", 500);
  return done(updated.report);
}

/** POST /api/reports/:id/return —— 管理员或**本组织**组织管理者，仅"已提交"状态，必须填写原因 */
export function returnReport(user: User, id: string, body: Record<string, unknown>): ServiceResult<ReportView> {
  const found = locateReport(user, id);
  if (!found) return notFoundResult();
  const report = found.report;
  if (report.status !== "submitted") return failed("INVALID_STATE", "只有已提交的周报才能退回", 400);

  const note = String(body.note ?? "").trim();
  if (!note) return failed("VALIDATION_ERROR", "退回时请填写原因", 400);

  const stamp = now();
  run(
    db(),
    "UPDATE weekly_reports SET status='returned',review_note=?,returned_at=?,updated_at=? WHERE id=?",
    note.slice(0, 2000),
    stamp,
    stamp,
    report.id,
  );
  notifyReport(
    report.ownerId,
    user.id,
    report.id,
    "report_returned",
    "周报已退回",
    `你的周报（${report.periodStart}~${report.periodEnd}）已退回：${note.slice(0, 2000)}`,
  );
  const updated = findReportWithOrg(report.id);
  if (!updated) return failed("INTERNAL", "周报更新失败", 500);
  return done(updated.report);
}

/**
 * POST /api/reports/:id/file 的前置校验：组织边界 → 权限 → 状态。
 * 刻意与落盘分开：旧实现"状态不符时不解析 multipart"，所以这三步必须在读上传体之前跑完。
 * 上传新版本的权限是「管理员 / 本组织管理者 / 这份周报的归属人本人」（§4 权限矩阵）——
 * 普通成员看得到别人的周报，但**只能重传自己的**（D-54）。
 */
export function reuploadTarget(user: User, id: string): ServiceResult<ScopedReport> {
  const found = locateReport(user, id);
  if (!found) return notFoundResult();
  const manages = assertOrgManage(user, found.orgId) === null;
  if (!manages && found.report.ownerId !== user.id) return notFoundResult();
  if (found.report.status !== "returned") return failed("INVALID_STATE", "只有被退回的周报才能重新上传", 400);
  return done(found);
}

/**
 * POST /api/reports/:id/file 的落库部分：写 NAS → 记新版本（经 `report_id` 关联）→ 通知本组织管理者。
 * `target` 由 `reuploadTarget` 产出，已经过组织边界、权限与状态校验。
 *
 * 远端目录取**这份周报归属人**的用户名与周期（不是上传者的）：重传可能由管理者或管理员触发，
 * 但文件始终落在同一个人的同一个周期目录下，路径规则不因谁来操作而变化（D-46）。
 */
export async function reuploadReport(user: User, target: ScopedReport, upload: Upload): Promise<ServiceResult<ReportView>> {
  const report = target.report;
  const ext = extensionOf(upload.file.filename);
  if (!isAllowedExt(ext)) return failed("VALIDATION_ERROR", "仅支持 .xlsx / .xls / .docx / .doc 文件", 400);

  const version = report.currentVersion + 1;
  const stamp = now();
  let stored: { storedName: string; size: number };
  try {
    stored = await uploadReportFile({
      orgId: target.orgId,
      username: usernameOf(report.ownerId),
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      originalName: upload.file.filename,
      version,
      buffer: upload.file.buffer,
      contentType: upload.file.mimetype,
    });
  } catch (error) {
    return storageFailure(error);
  }
  run(
    db(),
    `UPDATE weekly_reports SET status='submitted',current_version=?,review_note=NULL,submitted_at=?,returned_at=NULL,reviewed_at=NULL,updated_at=?
      WHERE id=?`,
    version,
    stamp,
    stamp,
    report.id,
  );
  addReportFile({
    id: randomUUID(),
    reportId: report.id,
    version,
    originalName: sanitizeName(upload.file.filename),
    storedName: stored.storedName,
    sizeBytes: stored.size,
    ext,
    mimeType: upload.file.mimetype || null,
    uploadedBy: user.id,
    uploadedAt: stamp,
  });
  if (user.role === "member") {
    notifyOrgManagers(
      target.orgId,
      user.id,
      report.id,
      "report_submitted",
      "周报已重新提交",
      `${user.name} 重新提交了 ${report.periodStart}~${report.periodEnd} 的周报`,
    );
  }
  const updated = findReportWithOrg(report.id);
  if (!updated) return failed("INTERNAL", "周报更新失败", 500);
  return done(updated.report, 201);
}

/* ------------------------------------------------------------------ 通知 */

function notifyReport(recipientId: string, actorId: string, reportId: string, type: string, title: string, message: string): void {
  if (!recipientId || recipientId === actorId) return;
  createNotification(db(), { recipientId, actorId, reportId, eventType: type, title, message });
}

/**
 * 提交 / 重交后通知**本组织的组织管理者**（审批权在他们手里）。
 * 旧实现把收件人写死成 "owner" 这个并不存在的用户 id，等于没人收得到；
 * 角色改造后按「manager 审批本组织周报」的语义改为按周报组织查询启用中的 manager。
 */
function notifyOrgManagers(orgId: string, actorId: string, reportId: string, type: string, title: string, message: string): void {
  const managers = rows<{ id: string }>(db(), "SELECT id FROM users WHERE org_id=? AND role='manager' AND is_active=1", orgId);
  for (const manager of managers) {
    notifyReport(String(manager.id), actorId, reportId, type, title, message);
  }
}

/* ------------------------------------------------------------------ 上传与文件 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTS = new Set([".xlsx", ".xls", ".docx", ".doc"]);

export type Upload = { fields: Record<string, string>; file: { filename: string; mimetype: string; buffer: Buffer } };

/** 上传相关的可预期错误：携带旧实现映射出的状态码与错误码 */
export class UploadError extends Error {
  public constructor(
    message: string,
    private readonly status: number,
    private readonly code: string,
  ) {
    super(message);
  }

  public toResponse(): Response {
    return fail(this.code, this.message, this.status);
  }
}

/**
 * 旧实现由 @fastify/multipart 读流：只取第一个文件，其余读完丢弃；缺文件抛"缺少上传文件"。
 * 这里用 Web 标准 FormData 复刻同样的可观察行为。
 */
export async function readUpload(request: Request): Promise<Upload> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new UploadError("上传内容无法解析", 400, "BAD_REQUEST");
  }
  const fields: Record<string, string> = {};
  let file: Upload["file"] | undefined;
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      fields[name] = value;
      continue;
    }
    if (file) continue;
    const buffer = Buffer.from(await value.arrayBuffer());
    // 旧实现由 multipart 的 fileSize 限制抛 FST_REQ_FILE_TOO_LARGE → 413 FILE_TOO_LARGE
    if (buffer.length > MAX_FILE_BYTES) throw new UploadError("文件超过 20MB 大小限制", 413, "FILE_TOO_LARGE");
    // 无 Content-Type 的分片在旧实现里被报成 application/octet-stream，这里保持一致
    file = { filename: value.name, mimetype: value.type || "application/octet-stream", buffer };
  }
  if (!file) throw new UploadError("缺少上传文件", 400, "BAD_REQUEST");
  return { fields, file };
}

export function handleUploadError(error: unknown): Response {
  if (error instanceof UploadError) return error.toResponse();
  return fail("BAD_REQUEST", "上传内容无法解析", 400);
}

/**
 * 打开一份周报正文用于下载（D-46）。分成两条路径：
 *
 * - `webdav:` 前缀 = 新式记录 → 走 NAS 流式读取（`report-storage.server.ts`）；
 * - 无前缀 = 迁移脚本还没搬到的老记录 → 仍读本地 `data/uploads/reports/<reportId>/<storedName>`。
 *
 * 兼容分支保留到 CLI 跑完（`TODO-14` 负责删掉它）。返回 `null` 表示「文件确实没了」，
 * 调用方给 404「文件已丢失」；NAS 连不上等异常照旧抛出。
 */
export async function openReportFile(
  storedName: string,
  reportId: string,
  uploadsDir: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number | null } | null> {
  if (isRemoteStoredName(storedName)) {
    const remote = await openReportDownload(storedName);
    return remote ? { body: remote.body, size: remote.size } : null;
  }
  const legacyPath = path.join(uploadsDir, reportId, storedName);
  let size: number;
  try {
    size = (await fsp.stat(legacyPath)).size;
  } catch {
    return null;
  }
  // 老记录也用流读，不整份读进内存（`access`/`stat` 先失败成 404，避免错误在响应中途才炸）
  return { body: Readable.toWeb(createReadStream(legacyPath)) as ReadableStream<Uint8Array>, size };
}

function normalizeDocType(value: string | undefined): ReportDocType | null {
  return value === "weekly_report" || value === "summary" || value === "other" ? value : null;
}

/** 周报归属人的**登录用户名**：远端目录的第一层就是它（D-46）。 */
function usernameOf(userId: string): string {
  const row = one<{ username: string }>(db(), "SELECT username FROM users WHERE id=?", userId);
  // 账号被删时周报会级联删除，取不到只可能是数据被手工改过——给个兜底段名，不抛异常
  return row ? String(row.username) : "unnamed";
}

function isAllowedExt(ext: string): boolean {
  return ALLOWED_EXTS.has(ext);
}

function extensionOf(filename: string): string {
  const base = path.basename(filename ?? "");
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index).toLowerCase() : "";
}

// 文件名来自外部上传，必须剔除控制字符与路径分隔符，因此这里刻意匹配控制字符
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f/\\]/gu;
function sanitizeName(filename: string): string {
  return (
    path
      .basename(filename ?? "")
      .replace(CONTROL_CHARS, "")
      .slice(0, 200) || "未命名文件"
  );
}

export function extFromStoredName(storedName: string): string {
  return path.extname(storedName).toLowerCase();
}

export function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
  };
  return map[ext] ?? "application/octet-stream";
}
