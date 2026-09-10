import { randomUUID } from "node:crypto";
import type { ReportRecord } from "../../server/src/db/repositories/report-repository";
import { appConfig } from "../lib/context.server";
import { date, db, now } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import {
  extensionOf,
  handleUploadError,
  isAllowedExt,
  normalizeDocType,
  notifyReport,
  persistFile,
  readUpload,
  reportRepository,
  resolveOwnerId,
  sanitizeName,
  toView,
  validateAssistant,
  type Upload,
} from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/** GET /api/reports —— 主人看全部，助理只看自己的；查看者 403 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (user.role === "viewer") return fail("FORBIDDEN", "查看者不能访问周报", 403);
  const repo = reportRepository();
  const reports = user.role === "owner" ? repo.findAll() : repo.findByOwner(user.id);
  return ok(reports.map((report) => toView(report, repo)));
}

/** POST /api/reports —— multipart 建单（字段：periodStart/periodEnd/docType/note/ownerId + file） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (user.role === "viewer") return fail("FORBIDDEN", "查看者不能上传周报", 403);

  let upload: Upload;
  try {
    upload = await readUpload(request);
  } catch (error) {
    return handleUploadError(error);
  }
  const fields = upload.fields;
  const periodStart = date(fields.periodStart);
  const periodEnd = date(fields.periodEnd);
  if (!periodStart || !periodEnd) return fail("VALIDATION_ERROR", "请填写周期开始和结束日期", 400);
  if (periodStart > periodEnd) return fail("VALIDATION_ERROR", "周期开始日期不能晚于结束日期", 400);
  const docType = normalizeDocType(fields.docType);
  if (!docType) return fail("VALIDATION_ERROR", "请选择文档类型", 400);
  const ext = extensionOf(upload.file.filename);
  if (!isAllowedExt(ext)) return fail("VALIDATION_ERROR", "仅支持 .xlsx / .xls / .docx / .doc 文件", 400);

  const database = db();
  const ownerId = user.role === "assistant" ? user.id : resolveOwnerId(fields.ownerId);
  const owner = validateAssistant(database, ownerId);
  if (!owner.valid) return fail("VALIDATION_ERROR", owner.message, 400);

  const id = randomUUID();
  const stamp = now();
  const report: ReportRecord = {
    id,
    ownerId: owner.id,
    ownerName: owner.name,
    periodStart,
    periodEnd,
    docType,
    note: String(fields.note ?? "")
      .trim()
      .slice(0, 2000),
    status: "submitted",
    currentVersion: 1,
    uploadedBy: user.id,
    reviewNote: null,
    createdAt: stamp,
    updatedAt: stamp,
    submittedAt: stamp,
    reviewedAt: null,
    returnedAt: null,
  };
  const file = await persistFile(appConfig().uploadsDir, id, 1, upload, ext);
  const repo = reportRepository();
  repo.create(report);
  repo.addFile({
    id: randomUUID(),
    reportId: id,
    version: 1,
    originalName: sanitizeName(upload.file.filename),
    storedName: file.storedName,
    sizeBytes: file.size,
    ext,
    mimeType: upload.file.mimetype || null,
    uploadedBy: user.id,
    uploadedAt: stamp,
  });
  if (user.role === "assistant") {
    notifyReport(
      database,
      "owner",
      user.id,
      id,
      "report_submitted",
      "收到新周报",
      `${user.name} 提交了 ${periodStart}~${periodEnd} 的周报`,
    );
  }
  const created = repo.findById(id);
  if (!created) throw new Error("Report insertion failed");
  return ok(toView(created, repo), 201);
}
